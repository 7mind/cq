import { LedgerError, type Item } from "../../types.js";
import type { PostgresOperationQueries } from "./operationAccess.js";

export interface PostgresItemRow {
  readonly ledger: string;
  readonly id: string;
  readonly milestone_id: string;
  readonly status: string;
  readonly fields_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly author: string | null;
  readonly session: string | null;
}

export function postgresRowToItem(row: PostgresItemRow): Item {
  const item: Item = { id: row.id, milestoneId: row.milestone_id, status: row.status,
    fields: JSON.parse(row.fields_json) as Item["fields"], createdAt: row.created_at, updatedAt: row.updated_at };
  if (row.author !== null) item.author = row.author;
  if (row.session !== null) item.session = row.session;
  return item;
}

export async function persistPostgresActiveItem(queries: PostgresOperationQueries, ledgerId: string, item: Item,
  mode: "insert" | "update"): Promise<void> {
  const sql = mode === "insert"
    ? `INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`
    : `UPDATE items SET milestone_id = $4, status = $5, fields_json = $6, created_at = $7, updated_at = $8, author = $9, session = $10
      WHERE project_key = $1 AND ledger = $2 AND id = $3 RETURNING id`;
  const key = `${ledgerId}:${item.id}`;
  const rows = await queries.execute<{ id: string }>({ table: "items", phase: "transaction", mode: "write",
    predicate: { kind: "primary-key", keys: [key] }, lockMode: "update" }, {
    sql, parameters: [queries.projectKey, ledgerId, item.id, item.milestoneId, item.status, JSON.stringify(item.fields),
      item.createdAt, item.updatedAt, item.author ?? null, item.session ?? null],
  }, () => key);
  if (rows.length !== 1) throw new LedgerError(`keyed write lost its row ${key}`);
}
