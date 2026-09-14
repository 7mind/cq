import type { LedgerSchema } from "../../types.js";
import type { AsyncGenericMutationDataSource } from "../asyncRowRepository.js";
import type { GenericMutationLedgerMetadata } from "../genericMutationDataSource.js";
import type { SqliteKeyedPredicate } from "../sqlite/operationObservability.js";
import { postgresRowToItem, type PostgresItemRow } from "./keyedRows.js";
import { PostgresOperationQueries, type PostgresStatement } from "./operationAccess.js";

interface LedgerRow {
  readonly name: string;
  readonly schema_json: string;
  readonly milestone_counter: number;
  readonly item_counter: number;
}

interface ReferenceRow {
  readonly source_ledger: string;
  readonly source_id: string;
  readonly field_name: string;
  readonly target_ledger: string;
  readonly target_id: string;
}

function splitRef(ref: string): readonly [string, string] {
  const colon = ref.indexOf(":");
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

export const POSTGRES_ACTIVE_TARGET_SQL = "SELECT * FROM items WHERE project_key = $1 AND ledger = $2 AND id = $3";
export const POSTGRES_ARCHIVED_TARGET_SQL = "SELECT * FROM archived_items WHERE project_key = $1 AND ledger = $2 AND id = $3 ORDER BY pointer_id LIMIT 1";
export const POSTGRES_MILESTONE_MEMBERS_SQL = "SELECT ledger, id FROM items WHERE project_key = $1 AND milestone_id = $2 ORDER BY ledger, id";
export const POSTGRES_LEDGER_STATUS_SQL = "SELECT ledger, id FROM items WHERE project_key = $1 AND ledger = $2 AND status = ANY($3::text[]) ORDER BY id";
export const POSTGRES_REFERENCE_SOURCE_SQL = `SELECT source_ledger, source_id, field_name, target_ledger, target_id
  FROM item_references WHERE project_key = $1 AND source_ledger = $2 AND source_id = $3 AND field_name = ANY($4::text[])
  ORDER BY field_name, target_ledger, target_id`;
export const POSTGRES_REFERENCE_TARGET_SQL = `SELECT source_ledger, source_id, field_name, target_ledger, target_id
  FROM item_references WHERE project_key = $1 AND target_ledger = $2 AND target_id = $3 AND field_name = ANY($4::text[])
  ORDER BY field_name, source_ledger, source_id`;

export function createPostgresGenericMutationDataSource(queries: PostgresOperationQueries): AsyncGenericMutationDataSource {
  const projectKey = queries.projectKey;
  let metadata: readonly GenericMutationLedgerMetadata[] | undefined;
  const read = <Row>(table: string, predicate: SqliteKeyedPredicate, statement: PostgresStatement, keyOf: (row: Row) => string) =>
    queries.execute({ table, phase: "transaction", mode: "read", predicate, lockMode: "none" }, statement, keyOf);
  const referenceKey = (row: ReferenceRow) => `${row.source_ledger}:${row.source_id}:${row.field_name}:${row.target_ledger}:${row.target_id}`;
  const itemKey = (row: Pick<PostgresItemRow, "ledger" | "id">) => `${row.ledger}:${row.id}`;
  const itemTarget = (row: Pick<PostgresItemRow, "ledger" | "id">) => queries.recordReadTarget({ table: "items", ledgerId: row.ledger, id: row.id });
  const referenceTarget = (row: ReferenceRow) => queries.recordReadTarget({ table: "item_references",
    sourceLedger: row.source_ledger, sourceId: row.source_id, fieldName: row.field_name, targetLedger: row.target_ledger, targetId: row.target_id });
  return {
    async listLedgers() {
      if (metadata !== undefined) return metadata;
      const rows = await read<LedgerRow>("ledgers", { kind: "keys", keys: ["registered-ledger-metadata"] }, {
        sql: "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE project_key = $1 ORDER BY name", parameters: [projectKey],
      }, ({ name }) => name);
      metadata = rows.map((row) => ({ id: row.name, schema: JSON.parse(row.schema_json) as LedgerSchema,
        counters: { milestone: row.milestone_counter, item: row.item_counter } }));
      return metadata;
    },
    async fetchActiveItem(ref) {
      const [ledgerId, id] = splitRef(ref);
      queries.recordReadTarget({ table: "items", ledgerId, id });
      const rows = await read<PostgresItemRow>("items", { kind: "primary-key", keys: [ref] },
        { sql: POSTGRES_ACTIVE_TARGET_SQL, parameters: [projectKey, ...splitRef(ref)] }, itemKey);
      return rows[0] === undefined ? undefined : postgresRowToItem(rows[0]);
    },
    async fetchArchivedItem(ref) {
      const rows = await read<PostgresItemRow & { readonly pointer_id: string }>("archived_items", { kind: "primary-key", keys: [ref] },
        { sql: POSTGRES_ARCHIVED_TARGET_SQL, parameters: [projectKey, ...splitRef(ref)] }, itemKey);
      const row = rows[0];
      if (row !== undefined) queries.recordReadTarget({ table: "archived_items", ledgerId: row.ledger, pointerId: row.pointer_id, id: row.id });
      return row === undefined ? undefined : { ledgerId: row.ledger, pointerId: row.pointer_id, item: postgresRowToItem(row) };
    },
    async referenceTargets(ref, fields) {
      if (fields.length === 0) return [];
      const rows = await read<ReferenceRow>("item_references", { kind: "reference-source", keys: [ref] },
        { sql: POSTGRES_REFERENCE_SOURCE_SQL, parameters: [projectKey, ...splitRef(ref), fields] }, referenceKey);
      for (const row of rows) referenceTarget(row);
      return rows.map(({ target_ledger, target_id }) => `${target_ledger}:${target_id}`);
    },
    async referenceSources(ref, fields) {
      if (fields.length === 0) return [];
      const rows = await read<ReferenceRow>("item_references", { kind: "reference-target", keys: [ref] },
        { sql: POSTGRES_REFERENCE_TARGET_SQL, parameters: [projectKey, ...splitRef(ref), fields] }, referenceKey);
      for (const row of rows) referenceTarget(row);
      return rows.map(({ source_ledger, source_id }) => `${source_ledger}:${source_id}`);
    },
    async itemRefsByMilestone(milestoneId) {
      const rows = await read<Pick<PostgresItemRow, "ledger" | "id">>("items", { kind: "milestone-members", keys: [milestoneId] },
        { sql: POSTGRES_MILESTONE_MEMBERS_SQL, parameters: [projectKey, milestoneId] }, itemKey);
      for (const row of rows) itemTarget(row);
      return rows.map(itemKey);
    },
    async itemRefsByLedgerStatuses(ledgerId, statuses) {
      if (statuses.length === 0) return [];
      const rows = await read<Pick<PostgresItemRow, "ledger" | "id">>("items",
        { kind: "selected-ledger-status", keys: statuses.map((status) => `${ledgerId}:${status}`) },
        { sql: POSTGRES_LEDGER_STATUS_SQL, parameters: [projectKey, ledgerId, statuses] }, itemKey);
      for (const row of rows) itemTarget(row);
      return rows.map(itemKey);
    },
    async liveTaskRefsByMilestone(milestoneId) {
      const rows = await read<Pick<PostgresItemRow, "ledger" | "id">>("items", { kind: "milestone-members", keys: [milestoneId] }, {
        sql: `SELECT ledger, id FROM items WHERE project_key = $1 AND ledger = 'tasks' AND milestone_id = $2
          AND status IN ('planned', 'wip', 'blocked') ORDER BY id`, parameters: [projectKey, milestoneId],
      }, itemKey);
      for (const row of rows) itemTarget(row);
      return rows.map(itemKey);
    },
  };
}
