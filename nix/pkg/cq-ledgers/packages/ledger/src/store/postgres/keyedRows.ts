import type { Item } from "../../types.js";

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
