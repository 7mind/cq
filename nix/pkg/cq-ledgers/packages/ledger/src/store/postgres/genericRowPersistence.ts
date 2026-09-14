import { LedgerError, type Item, type Ledger } from "../../types.js";
import type { GenericMutationTransaction } from "../genericMutationTransaction.js";
import type { PostgresGenericRowPlan } from "./genericRowOperation.js";
import { persistPostgresActiveItem } from "./keyedRows.js";
import type { PostgresOperationQueries } from "./operationAccess.js";

export interface PostgresGenericRowChanges {
  readonly ledgers: readonly string[];
  readonly activeDeletes: readonly { ledgerId: string; itemId: string; groupId: string }[];
  readonly groupDeletes: readonly { ledgerId: string; groupId: string }[];
  readonly archivedUpserts: readonly { ledgerId: string; pointerId: string; item: Item }[];
  readonly archivedDeletes: readonly { ledgerId: string; pointerId: string; itemId: string }[];
}

export async function persistPostgresGenericRows(queries: PostgresOperationQueries, plan: PostgresGenericRowPlan,
  transaction: Pick<GenericMutationTransaction, "dirtyLedgers" | "dirtyArchives">, now: () => string): Promise<PostgresGenericRowChanges> {
  const changed = new Set<string>();
  const activeDeletes: { ledgerId: string; itemId: string; groupId: string }[] = [];
  const groupDeletes: { ledgerId: string; groupId: string }[] = [];
  const archivedUpserts: { ledgerId: string; pointerId: string; item: Item }[] = [];
  const archivedDeletes: { ledgerId: string; pointerId: string; itemId: string }[] = [];
  const write = async (table: string, key: string, sql: string, values: readonly (string | number | null)[]) => {
    const rows = await queries.execute<{ id: string }>({ table, phase: "transaction", mode: "write",
      predicate: { kind: "primary-key", keys: [key] }, lockMode: "update" }, {
      sql, parameters: [queries.projectKey, ...values],
    }, () => key);
    return rows.length;
  };
  const itemsOf = (ledger: Ledger) => new Map(ledger.milestones.flatMap(({ items }) => items.map((item) => [item.id, item] as const)));
  for (const ledgerId of transaction.dirtyLedgers) {
    const before = plan.beforeLedgers.get(ledgerId);
    const after = plan.ledgers.get(ledgerId);
    if (after === undefined) throw new LedgerError(`generic operation lost ledger ${ledgerId}`);
    if (before === undefined) {
      await write("ledgers", ledgerId, `INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES ($1, $2, $3, $4, $5) RETURNING name AS id`, [ledgerId, JSON.stringify(after.schema), after.counters.milestone, after.counters.item]);
      changed.add(ledgerId);
    } else if (JSON.stringify(before.schema) !== JSON.stringify(after.schema) ||
      before.counters.item !== after.counters.item || before.counters.milestone !== after.counters.milestone) {
      const count = await write("ledgers", ledgerId, `UPDATE ledgers SET schema_json = $3, milestone_counter = $4, item_counter = $5
        WHERE project_key = $1 AND name = $2 AND milestone_counter = $6 AND item_counter = $7 RETURNING name AS id`,
      [ledgerId, JSON.stringify(after.schema), after.counters.milestone, after.counters.item, before.counters.milestone, before.counters.item]);
      if (count !== 1) throw new LedgerError(`generic allocation lost its locked counter for ${ledgerId}`);
      changed.add(ledgerId);
    }
    const beforeGroups = new Map((before === undefined ? [] : before.milestones).map((group) => [group.id, group]));
    for (const group of after.milestones) {
      const prior = beforeGroups.get(group.id);
      if (prior !== undefined && prior.title === group.title && prior.description === group.description) continue;
      const count = await write("groups", `${ledgerId}:${group.id}`, `INSERT INTO groups (project_key, ledger, id, title, description)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_key, ledger, id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
        WHERE groups.title IS DISTINCT FROM EXCLUDED.title OR groups.description IS DISTINCT FROM EXCLUDED.description RETURNING id`,
      [ledgerId, group.id, group.title, group.description]);
      if (count > 0) changed.add(ledgerId);
    }
    const beforeItems = before === undefined ? new Map<string, Item>() : itemsOf(before);
    const afterItems = itemsOf(after);
    for (const [id, item] of beforeItems) {
      if (afterItems.has(id)) continue;
      const count = await write("items", `${ledgerId}:${id}`, "DELETE FROM items WHERE project_key = $1 AND ledger = $2 AND id = $3 RETURNING id", [ledgerId, id]);
      if (count !== 1) throw new LedgerError(`generic deletion lost its locked row ${ledgerId}:${id}`);
      activeDeletes.push({ ledgerId, itemId: id, groupId: item.milestoneId });
      changed.add(ledgerId);
    }
    for (const [id, item] of afterItems) {
      const prior = beforeItems.get(id);
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(item)) continue;
      await persistPostgresActiveItem(queries, ledgerId, item, prior === undefined ? "insert" : "update");
      changed.add(ledgerId);
    }
    const afterGroups = new Set(after.milestones.map(({ id }) => id));
    for (const id of beforeGroups.keys()) {
      if (afterGroups.has(id)) continue;
      const count = await write("groups", `${ledgerId}:${id}`, `DELETE FROM groups WHERE project_key = $1 AND ledger = $2 AND id = $3
        AND NOT EXISTS (SELECT 1 FROM items WHERE project_key = $1 AND ledger = $2 AND milestone_id = $3 LIMIT 1) RETURNING id`, [ledgerId, id]);
      if (count > 0) { groupDeletes.push({ ledgerId, groupId: id }); changed.add(ledgerId); }
    }
  }
  for (const key of transaction.dirtyArchives) {
    const slash = key.indexOf("/");
    const ledgerId = key.slice(0, slash);
    const pointerId = key.slice(slash + 1);
    const before = plan.beforeArchives.get(key);
    const after = plan.archives.get(key);
    const beforeItems = new Map((before === undefined ? [] : before.items).map((item) => [item.id, item]));
    const afterItems = new Map((after === undefined ? [] : after.items).map((item) => [item.id, item]));
    for (const id of beforeItems.keys()) {
      if (afterItems.has(id)) continue;
      const count = await write("archived_items", `${ledgerId}:${pointerId}:${id}`,
        "DELETE FROM archived_items WHERE project_key = $1 AND ledger = $2 AND pointer_id = $3 AND id = $4 RETURNING id", [ledgerId, pointerId, id]);
      if (count !== 1) throw new LedgerError(`generic deletion lost its archived row ${ledgerId}:${pointerId}:${id}`);
      archivedDeletes.push({ ledgerId, pointerId, itemId: id });
      changed.add(ledgerId);
    }
    if (after === undefined) {
      const count = await write("archive_pointers", key, "DELETE FROM archive_pointers WHERE project_key = $1 AND ledger = $2 AND id = $3 RETURNING id", [ledgerId, pointerId]);
      if (count > 0) changed.add(ledgerId);
      continue;
    }
    const pointer = plan.ledgers.get(ledgerId)?.archivePointers.find(({ id }) => id === pointerId);
    if (pointer === undefined) throw new LedgerError(`generic operation lost archive pointer ${key}`);
    const prior = plan.beforeLedgers.get(ledgerId)?.archivePointers.find(({ id }) => id === pointerId);
    if (prior === undefined || prior.summary !== pointer.summary || prior.title !== pointer.title || prior.status !== pointer.status) {
      await write("archive_pointers", key, `INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (project_key, ledger, id) DO UPDATE SET
        summary = EXCLUDED.summary, title = EXCLUDED.title, status = EXCLUDED.status RETURNING id`,
      [ledgerId, pointerId, pointer.summary, pointer.title, pointer.status, now()]);
      changed.add(ledgerId);
    }
    for (const [id, item] of afterItems) {
      const priorItem = beforeItems.get(id);
      if (priorItem !== undefined && JSON.stringify(priorItem) === JSON.stringify(item)) continue;
      await write("archived_items", `${ledgerId}:${pointerId}:${id}`, `INSERT INTO archived_items
        (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (project_key, ledger, pointer_id, id) DO UPDATE SET
        milestone_id = EXCLUDED.milestone_id, status = EXCLUDED.status, fields_json = EXCLUDED.fields_json,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, author = EXCLUDED.author, session = EXCLUDED.session RETURNING id`,
      [ledgerId, pointerId, id, item.milestoneId, item.status, JSON.stringify(item.fields), item.createdAt, item.updatedAt, item.author ?? null, item.session ?? null]);
      archivedUpserts.push({ ledgerId, pointerId, item: structuredClone(item) });
      changed.add(ledgerId);
    }
  }
  return { ledgers: [...changed], activeDeletes, groupDeletes, archivedUpserts, archivedDeletes };
}
