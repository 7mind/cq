import { LedgerError, type ArchivePointer, type Item, type LedgerSchema } from "../../types.js";
import type { SearchProjectionChange } from "../../search/SearchProjection.js";
import type { PostgresCoherenceEntry } from "./coherenceVector.js";
import { POSTGRES_GROUP_CONTROL_PREFIX, POSTGRES_POINTER_CONTROL_PREFIX } from "./coherenceChanges.js";
import { postgresRowToItem, type PostgresItemRow } from "./keyedRows.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { SQL } from "bun";
import type { SearchProjectionBucket } from "../../search/SearchProjection.js";

export interface PostgresProjectionLedger {
  readonly ledgerId: string;
  readonly schema: LedgerSchema;
  readonly counters: { readonly milestone: number; readonly item: number };
}
export interface PostgresProjectionGroup {
  readonly ledgerId: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sequence: number;
}
export interface PostgresProjectionPointer {
  readonly ledgerId: string;
  readonly pointer: ArchivePointer;
  readonly sequence: number;
}
export interface PostgresProjectionItem {
  readonly ledgerId: string;
  readonly item: Item;
  readonly sequence: number;
}
export interface PostgresProjectionArchiveItem extends PostgresProjectionItem {
  readonly pointerId: string;
}
export interface PostgresProjectionRows {
  readonly ledgers: readonly PostgresProjectionLedger[];
  readonly ledgerDeletes: readonly string[];
  readonly groups: readonly PostgresProjectionGroup[];
  readonly groupDeletes: readonly { ledgerId: string; id: string }[];
  readonly pointers: readonly PostgresProjectionPointer[];
  readonly pointerDeletes: readonly { ledgerId: string; id: string }[];
  readonly active: readonly PostgresProjectionItem[];
  readonly activeDeletes: readonly { ledgerId: string; itemId: string }[];
  readonly archived: readonly PostgresProjectionArchiveItem[];
  readonly archivedDeletes: readonly { ledgerId: string; pointerId: string; itemId: string }[];
  readonly changes: readonly SearchProjectionChange[];
}

/** The caller owns the repeatable-read snapshot and its coherence high-water mark. */
export async function loadPostgresProjectionSnapshot(sql: SQL, projectKey: string): Promise<{
  rows: PostgresProjectionRows; buckets: SearchProjectionBucket[];
}> {
  const metadata = await sql<{ name: string; schema_json: string; milestone_counter: number; item_counter: number }[]>`
    SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`;
  const groupRows = await sql<{ ledger: string; id: string; title: string; description: string; seq: bigint }[]>`
    SELECT ledger, id, title, description, seq FROM groups WHERE project_key = ${projectKey} ORDER BY ledger, seq`;
  const pointerRows = await sql<{ ledger: string; id: string; title: string; summary: string; status: string; seq: bigint }[]>`
    SELECT ledger, id, title, summary, status, seq FROM archive_pointers WHERE project_key = ${projectKey} ORDER BY ledger, seq`;
  const activeRows = await sql<(PostgresItemRow & { seq: bigint })[]>`
    SELECT * FROM items WHERE project_key = ${projectKey} ORDER BY ledger, seq`;
  const archiveRows = await sql<(PostgresItemRow & { pointer_id: string; seq: bigint })[]>`
    SELECT * FROM archived_items WHERE project_key = ${projectKey} ORDER BY ledger, seq`;
  const groups = groupRows.map(({ ledger, seq, ...row }) => ({ ...row, ledgerId: ledger, sequence: checkedSequence(seq) }));
  const pointers = pointerRows.map(({ ledger, seq, ...pointer }) => ({ ledgerId: ledger, sequence: checkedSequence(seq),
    pointer: { ...pointer, path: `./archive/${ledger}/${pointer.id}.md` } }));
  const groupKeys = new Set(groups.map((row) => JSON.stringify([row.ledgerId, row.id])));
  const pointerKeys = new Set(pointers.map((row) => JSON.stringify([row.ledgerId, row.pointer.id])));
  const active = activeRows.map((row) => {
    if (!groupKeys.has(JSON.stringify([row.ledger, row.milestone_id]))) throw new LedgerError(`ledger ${row.ledger}: item ${row.id} references a milestone-group with no groups row`);
    return { ledgerId: row.ledger, item: postgresRowToItem(row), sequence: checkedSequence(row.seq) };
  });
  const archived = archiveRows.map((row) => {
    if (!pointerKeys.has(JSON.stringify([row.ledger, row.pointer_id]))) throw new LedgerError(`archived row ${row.ledger}:${row.id} has no archive pointer`);
    return { ledgerId: row.ledger, pointerId: row.pointer_id, item: postgresRowToItem(row), sequence: checkedSequence(row.seq) };
  });
  const buckets = new Map<string, SearchProjectionBucket>();
  for (const row of metadata) for (const archived of [false, true]) buckets.set(JSON.stringify([row.name, archived]), { ledgerId: row.name, archived, items: [] });
  for (const [rows, isArchived] of [[active, false], [archived, true]] as const) for (const row of rows) {
    const bucket = buckets.get(JSON.stringify([row.ledgerId, isArchived]));
    if (bucket === undefined) throw new LedgerError(`projection row has no ledger ${row.ledgerId}`);
    (bucket.items as Item[]).push(row.item);
  }
  return { rows: {
    ledgers: metadata.map((row) => ({ ledgerId: row.name, schema: JSON.parse(row.schema_json) as LedgerSchema,
      counters: { milestone: row.milestone_counter, item: row.item_counter } })), ledgerDeletes: [],
    groups, groupDeletes: [], pointers, pointerDeletes: [], active, activeDeletes: [], archived, archivedDeletes: [], changes: [],
  }, buckets: [...buckets.values()] };
}

function checkedSequence(value: bigint): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new LedgerError("PostgreSQL row sequence exceeds the supported integer domain");
  return sequence;
}

export async function loadPostgresProjectionRows(queries: PostgresOperationQueries, entries: readonly PostgresCoherenceEntry[], known: {
  hasLedger(ledgerId: string): boolean; hasGroup(ledgerId: string, groupId: string): boolean;
}): Promise<PostgresProjectionRows> {
  const ledgers = new Map<string, PostgresProjectionLedger>();
  const ledgerDeletes: string[] = [];
  const groups = new Map<string, PostgresProjectionGroup>();
  const groupDeletes: { ledgerId: string; id: string }[] = [];
  const pointers = new Map<string, PostgresProjectionPointer>();
  const pointerDeletes: { ledgerId: string; id: string }[] = [];
  const active: PostgresProjectionItem[] = [];
  const activeDeletes: { ledgerId: string; itemId: string }[] = [];
  const archived: PostgresProjectionArchiveItem[] = [];
  const archivedDeletes: { ledgerId: string; pointerId: string; itemId: string }[] = [];
  const changes: SearchProjectionChange[] = [];
  const read = <Row>(table: string, key: string, sql: string, values: readonly string[]) => queries.execute<Row>({
    table, phase: "projection", mode: "read", predicate: { kind: "primary-key", keys: [key] }, lockMode: "none",
  }, { sql, parameters: [queries.projectKey, ...values] }, () => key);
  const loadLedger = async (ledgerId: string): Promise<void> => {
    if (ledgers.has(ledgerId) || ledgerDeletes.includes(ledgerId)) return;
    const rows = await read<{ schema_json: string; milestone_counter: number; item_counter: number }>("ledgers", ledgerId,
      "SELECT schema_json, milestone_counter, item_counter FROM ledgers WHERE project_key = $1 AND name = $2", [ledgerId]);
    const row = rows[0];
    if (row === undefined) { ledgerDeletes.push(ledgerId); changes.push({ kind: "remove-ledger", ledgerId }); }
    else ledgers.set(ledgerId, { ledgerId, schema: JSON.parse(row.schema_json) as LedgerSchema, counters: { milestone: row.milestone_counter, item: row.item_counter } });
  };
  const loadGroup = async (ledgerId: string, id: string): Promise<void> => {
    const key = `${ledgerId}:${id}`;
    if (groups.has(key) || groupDeletes.some((entry) => entry.ledgerId === ledgerId && entry.id === id)) return;
    const rows = await read<{ title: string; description: string; seq: bigint }>("groups", key,
      "SELECT title, description, seq FROM groups WHERE project_key = $1 AND ledger = $2 AND id = $3", [ledgerId, id]);
    const row = rows[0];
    if (row === undefined) groupDeletes.push({ ledgerId, id });
    else groups.set(key, { ledgerId, id, title: row.title, description: row.description, sequence: checkedSequence(row.seq) });
  };
  const loadPointer = async (ledgerId: string, id: string): Promise<void> => {
    const key = `${ledgerId}:${id}`;
    if (pointers.has(key) || pointerDeletes.some((entry) => entry.ledgerId === ledgerId && entry.id === id)) return;
    const rows = await read<{ summary: string; title: string; status: string; seq: bigint }>("archive_pointers", key,
      "SELECT summary, title, status, seq FROM archive_pointers WHERE project_key = $1 AND ledger = $2 AND id = $3", [ledgerId, id]);
    const row = rows[0];
    if (row === undefined) pointerDeletes.push({ ledgerId, id });
    else pointers.set(key, { ledgerId, sequence: checkedSequence(row.seq), pointer: { id, summary: row.summary, title: row.title, status: row.status, path: `./archive/${ledgerId}/${id}.md` } });
  };
  for (const entry of entries) {
    const ledgerId = entry.ledger;
    if (entry.scope === "control" && (entry.documentId.startsWith("plan_claims:") || entry.documentId.startsWith("plan_operations:"))) continue;
    if (entry.scope === "registry" || !known.hasLedger(ledgerId)) await loadLedger(ledgerId);
    if (entry.scope === "registry") continue;
    if (entry.scope === "control") {
      if (entry.documentId.startsWith(POSTGRES_GROUP_CONTROL_PREFIX)) await loadGroup(ledgerId, entry.documentId.slice(POSTGRES_GROUP_CONTROL_PREFIX.length));
      else if (entry.documentId.startsWith(POSTGRES_POINTER_CONTROL_PREFIX)) await loadPointer(ledgerId, entry.documentId.slice(POSTGRES_POINTER_CONTROL_PREFIX.length));
      else throw new LedgerError(`unknown PostgreSQL coherence control key ${entry.documentId}`);
      continue;
    }
    if (entry.scope === "active") {
      const rows = await read<PostgresItemRow & { seq: bigint }>("items", `${ledgerId}:${entry.documentId}`,
        "SELECT * FROM items WHERE project_key = $1 AND ledger = $2 AND id = $3", [ledgerId, entry.documentId]);
      const row = rows[0];
      if (row === undefined) {
        activeDeletes.push({ ledgerId, itemId: entry.documentId });
        changes.push({ kind: "remove", ledgerId, itemId: entry.documentId, archived: false });
      } else {
        const item = postgresRowToItem(row);
        if (!known.hasGroup(ledgerId, item.milestoneId)) await loadGroup(ledgerId, item.milestoneId);
        if (!groups.has(`${ledgerId}:${item.milestoneId}`) && !known.hasGroup(ledgerId, item.milestoneId)) throw new LedgerError(`coherent active row has no group: ${ledgerId}:${item.id}`);
        active.push({ ledgerId, item, sequence: checkedSequence(row.seq) });
        changes.push({ kind: "upsert", ledgerId, item, archived: false });
      }
    } else {
      const coordinate: unknown = JSON.parse(entry.documentId);
      if (!Array.isArray(coordinate) || coordinate.length !== 2 || typeof coordinate[0] !== "string" || typeof coordinate[1] !== "string") {
        throw new LedgerError("malformed PostgreSQL archived coherence coordinate");
      }
      const [pointerId, itemId] = coordinate as [string, string];
      const rows = await read<PostgresItemRow & { seq: bigint }>("archived_items", `${ledgerId}:${pointerId}:${itemId}`,
        "SELECT * FROM archived_items WHERE project_key = $1 AND ledger = $2 AND pointer_id = $3 AND id = $4", [ledgerId, pointerId, itemId]);
      const row = rows[0];
      await loadPointer(ledgerId, pointerId);
      if (row === undefined) {
        archivedDeletes.push({ ledgerId, pointerId, itemId });
        changes.push({ kind: "remove", ledgerId, itemId, archived: true });
      } else {
        const item = postgresRowToItem(row);
        if (!pointers.has(`${ledgerId}:${pointerId}`)) throw new LedgerError(`coherent archived row has no pointer: ${ledgerId}:${pointerId}:${itemId}`);
        archived.push({ ledgerId, pointerId, item, sequence: checkedSequence(row.seq) });
        changes.push({ kind: "upsert", ledgerId, item, archived: true });
      }
    }
  }
  return { ledgers: [...ledgers.values()], ledgerDeletes, groups: [...groups.values()], groupDeletes, pointers: [...pointers.values()], pointerDeletes,
    active, activeDeletes, archived, archivedDeletes, changes };
}
