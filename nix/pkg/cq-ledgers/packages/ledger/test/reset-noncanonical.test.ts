/** D21 / T131 — destructive reinitialization removes custom rows, registry entries, and search hits. */
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  CANONICAL_LEDGERS,
  createTrustedWorksetManagementAuthority,
  type LedgerSchema,
} from "../src/index.js";
import { injectSqliteSchemaDivergence, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";

const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
const TIMESTAMP = "2026-06-03T10:00:00.000Z";
afterAll(async () => {
  for (const store of stores) await store.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const OPS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
};

async function fixture(headline: string) {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-reset-nc-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  stores.push(store);
  await store.init();
  await store.createLedger("ops", OPS_SCHEMA);
  const milestone = await store.createMilestone({ title: "ops milestone" });
  await store.createItem("ops", milestone.id, { status: "open", fields: { headline } });
  return { store, dbPath };
}

async function reinitialize(store: SqliteLedgerStore, dbPath: string) {
  await store.dispose();
  injectSqliteSchemaDivergence(dbPath);
  const restarted = new SqliteLedgerStore({
    dbPath,
    now: () => TIMESTAMP,
    onSchemaDivergence: "backup-reinit",
    allowDestructiveReinitOfPopulatedStore: true,
    worksetAuthority: createTrustedWorksetManagementAuthority(),
  });
  stores.push(restarted);
  await restarted.init();
  return restarted;
}

function customRows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      ledgers: db.query("SELECT name, schema_json FROM ledgers WHERE name = 'ops'").all(),
      groups: db.query("SELECT id FROM groups WHERE ledger = 'ops'").all(),
      items: db.query("SELECT id, fields_json FROM items WHERE ledger = 'ops'").all(),
    };
  } finally {
    db.close();
  }
}

describe("SQLite reinitialization with non-canonical ledger", () => {
  it("leaves no orphan custom rows, registry entry, or FTS hits", async () => {
    const { store, dbPath } = await fixture("ops-item-one");
    expect((await store.ftsSearch("ops-item-one")).length).toBeGreaterThan(0);
    expect(customRows(dbPath).items).toHaveLength(1);
    expect(store.enumerate()).toContain("ops");

    const restarted = await reinitialize(store, dbPath);
    expect(customRows(dbPath)).toEqual({ ledgers: [], groups: [], items: [] });
    expect(restarted.enumerate()).not.toContain("ops");
    expect(restarted.enumerate().sort()).toEqual(CANONICAL_LEDGERS.map(({ name }) => name).sort());
    expect(await restarted.ftsSearch("ops-item-one")).toHaveLength(0);
  });

  it("preserves the custom schema, group, and item in the backup", async () => {
    const { store, dbPath } = await fixture("ops-backup-check");
    const before = customRows(dbPath);
    expect(before.ledgers).toHaveLength(1);
    expect(before.groups).toHaveLength(1);
    expect(before.items).toHaveLength(1);
    await reinitialize(store, dbPath);
    expect(customRows(sqliteDivergenceBackupPath(dbPath, TIMESTAMP))).toEqual(before);
  });
});
