import { LedgerError, type Item, type Ledger } from "../../types.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import { persistPostgresActiveItem } from "./keyedRows.js";

export interface PostgresPlanRowChanges {
  readonly items: readonly { readonly ledgerId: string; readonly item: Item }[];
  readonly ledgers: readonly string[];
}

export interface PostgresPublicRowPlan {
  readonly beforeLedgers: ReadonlyMap<string, Ledger>;
  readonly state: { readonly ledgers: ReadonlyMap<string, Ledger> };
}

export async function persistPostgresPlanRows(queries: PostgresOperationQueries, plan: PostgresPublicRowPlan,
  dirtyLedgers: readonly string[]): Promise<PostgresPlanRowChanges> {
  const changedItems: { ledgerId: string; item: Item }[] = [];
  const changedLedgers = new Set<string>();
  const itemMap = (ledger: Ledger) => new Map(ledger.milestones.flatMap(({ items }) => items.map((item) => [item.id, item] as const)));
  const write = async (table: string, key: string, sql: string, values: readonly (string | number | null)[]) => {
    const rows = await queries.execute<{ id: string }>({ table, phase: "transaction", mode: "write",
      predicate: { kind: "primary-key", keys: [key] }, lockMode: "update" }, { sql, parameters: [queries.projectKey, ...values] }, () => key);
    return rows.length;
  };
  for (const ledgerId of new Set(dirtyLedgers)) {
    const before = plan.beforeLedgers.get(ledgerId);
    const after = plan.state.ledgers.get(ledgerId);
    if (before === undefined || after === undefined) throw new LedgerError(`plan operation did not load registered ledger ${ledgerId}`);
    if (JSON.stringify(before.schema) !== JSON.stringify(after.schema)) throw new LedgerError("a plan operation changed a ledger schema");
    if (before.counters.item !== after.counters.item || before.counters.milestone !== after.counters.milestone) {
      const count = await write("ledgers", ledgerId, `UPDATE ledgers SET item_counter = $3, milestone_counter = $4
        WHERE project_key = $1 AND name = $2 AND item_counter = $5 AND milestone_counter = $6 RETURNING name AS id`,
      [ledgerId, after.counters.item, after.counters.milestone, before.counters.item, before.counters.milestone]);
      if (count !== 1) throw new LedgerError(`plan allocation lost its locked counter for ${ledgerId}`);
      changedLedgers.add(ledgerId);
    }
    const groups = new Map(before.milestones.map((group) => [group.id, group]));
    for (const group of after.milestones) {
      const prior = groups.get(group.id);
      if (prior !== undefined && prior.title === group.title && prior.description === group.description) continue;
      const count = await write("groups", `${ledgerId}:${group.id}`, `INSERT INTO groups (project_key, ledger, id, title, description)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_key, ledger, id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
        WHERE groups.title IS DISTINCT FROM EXCLUDED.title OR groups.description IS DISTINCT FROM EXCLUDED.description RETURNING id`,
      [ledgerId, group.id, group.title, group.description]);
      if (count > 0) changedLedgers.add(ledgerId);
    }
    const beforeItems = itemMap(before);
    const afterItems = itemMap(after);
    if ([...beforeItems.keys()].some((id) => !afterItems.has(id))) throw new LedgerError("a plan operation removed an active row");
    for (const [id, item] of afterItems) {
      const prior = beforeItems.get(id);
      if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(item)) continue;
      await persistPostgresActiveItem(queries, ledgerId, item, prior === undefined ? "insert" : "update");
      changedItems.push({ ledgerId, item: structuredClone(item) });
      changedLedgers.add(ledgerId);
    }
  }
  return { items: changedItems, ledgers: [...changedLedgers] };
}
