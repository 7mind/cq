import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { BootstrapViolationError } from "../src/types.js";

function injectDivergence(dbPath: string): void {
  const db = new Database(dbPath);
  const row = db
    .query<{ schema_json: string }, []>("SELECT schema_json FROM ledgers WHERE name = 'tasks'")
    .get();
  if (row === null) throw new Error("fixture: tasks ledger missing");
  const schema = JSON.parse(row.schema_json) as { statusValues?: string[] };
  schema.statusValues = [...(schema.statusValues ?? []), "divergent-status"];
  db.query("UPDATE ledgers SET schema_json = ? WHERE name = 'tasks'").run(JSON.stringify(schema));
  db.close();
}

function readRoots(dbPath: string): { roots: string[]; epoch: number } {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .query<{ roots_json: string; epoch: number }, []>(
      "SELECT roots_json, epoch FROM workset_state WHERE id = 1",
    )
    .get();
  db.close();
  if (row === null) throw new Error("fixture: workset state missing");
  return { roots: JSON.parse(row.roots_json) as string[], epoch: row.epoch };
}

describe("workset roots across SQLite schema divergence [T1960]", () => {
  it("treats root-only state as substantive and refuses destructive reinitialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cq-t1960-sqlite-divergence-"));
    const dbPath = join(dir, "ledger.db");
    const roots = ["tasks:T-preserve", "goals:G-preserve"];

    const seed = new SqliteLedgerStore({ dbPath });
    await seed.init();
    await seed.worksetStore().setRoots(roots);
    await seed.worksetStore().setRoots(roots);
    await seed.dispose();
    expect(readRoots(dbPath)).toEqual({ roots, epoch: 2 });
    injectDivergence(dbPath);

    const reopened = new SqliteLedgerStore({
      dbPath,
      onSchemaDivergence: "backup-reinit",
    });
    const attemptedReinit = reopened.init();
    await expect(attemptedReinit).rejects.toBeInstanceOf(BootstrapViolationError);
    await expect(attemptedReinit).rejects.toThrow(/POPULATED|workset root/u);
    expect(readRoots(dbPath)).toEqual({ roots, epoch: 2 });
    expect(readdirSync(dir).filter((name) => name.startsWith("ledger.backup-"))).toEqual([]);
  });
});
