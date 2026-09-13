import { Database } from "bun:sqlite";
import { extname } from "node:path";
import type { LedgerSchema } from "../src/types.js";

export function injectSqliteSchemaDivergence(dbPath: string): void {
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    const row = db.query<{ schema_json: string }, []>(
      "SELECT schema_json FROM ledgers WHERE name = 'tasks'",
    ).get();
    if (row === null) throw new Error("fixture tasks ledger missing");
    const schema = JSON.parse(row.schema_json) as LedgerSchema;
    schema.statusValues = [...schema.statusValues, "divergent-status"];
    db.query("UPDATE ledgers SET schema_json = ? WHERE name = 'tasks'").run(JSON.stringify(schema));
  } finally {
    db.close();
  }
}

export function sqliteDivergenceBackupPath(dbPath: string, timestamp: string): string {
  const extension = extname(dbPath);
  const stem = extension.length === 0 ? dbPath : dbPath.slice(0, -extension.length);
  return `${stem}.backup-${timestamp.replaceAll(":", "-")}${extension}`;
}

export function readSqliteCanonicalRows(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.transaction(() => JSON.stringify({
      ledgers: db.query("SELECT * FROM ledgers ORDER BY name").all(),
      groups: db.query("SELECT * FROM groups ORDER BY ledger, id").all(),
      items: db.query("SELECT * FROM items ORDER BY ledger, id").all(),
    }))();
  } finally {
    db.close();
  }
}
