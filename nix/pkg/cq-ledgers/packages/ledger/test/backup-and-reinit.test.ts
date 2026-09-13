/** T94 — public SQLite reinitialization snapshots prior rows before reseeding canon. */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore, CANONICAL_LEDGERS, MILESTONES_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID, MILESTONES_AMBIENT_ID, createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import {
  injectSqliteSchemaDivergence, readSqliteCanonicalRows, sqliteDivergenceBackupPath,
} from "./sqliteSchemaFixture.js";

const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
const TIMESTAMP = "2026-06-01T12:34:56.000Z";
afterAll(async () => {
  for (const store of stores) await store.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-backup-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");
  const seed = new SqliteLedgerStore({ dbPath });
  await seed.init();
  await seed.dispose();
  injectSqliteSchemaDivergence(dbPath);
  const store = new SqliteLedgerStore({
    dbPath, now: () => TIMESTAMP, onSchemaDivergence: "backup-reinit",
    worksetAuthority: createTrustedWorksetManagementAuthority(),
  });
  stores.push(store);
  return { store, dbPath, backupPath: sqliteDivergenceBackupPath(dbPath, TIMESTAMP) };
}

describe("SQLite backup and reinitialization [Effectual-GoodCommunication]", () => {
  it("creates a sibling snapshot with a sanitized timestamp", async () => {
    const { store, backupPath } = await fixture();
    await store.init();
    expect((await stat(backupPath)).isFile()).toBe(true);
    expect(path.basename(backupPath)).toBe("ledger.backup-2026-06-01T12-34-56.000Z.db");
  });

  it("preserves the prior registry, groups, and items byte-for-byte as SQL rows", async () => {
    const { store, dbPath, backupPath } = await fixture();
    const before = readSqliteCanonicalRows(dbPath);
    await store.init();
    expect(readSqliteCanonicalRows(backupPath)).toBe(before);
  });

  it("reinitializes when a canonical ledger has not yet been provisioned", async () => {
    const { store, dbPath, backupPath } = await fixture();
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      db.exec("DELETE FROM ledgers WHERE name = 'upstream'");
    } finally {
      db.close();
    }
    const before = readSqliteCanonicalRows(dbPath);
    await expect(store.init()).resolves.toBeUndefined();
    expect(readSqliteCanonicalRows(backupPath)).toBe(before);
    expect(store.enumerate()).toContain("upstream");
  });

  it("writes fresh canonical registry metadata after backup", async () => {
    const { store } = await fixture();
    await store.init();
    expect(store.enumerate().sort()).toEqual(CANONICAL_LEDGERS.map(({ name }) => name).sort());
    for (const canonical of CANONICAL_LEDGERS) {
      expect(store.fetch(canonical.name).schema).toEqual(canonical.schema);
    }
  });

  it("seeds the active milestone group and immortal ambient milestone", async () => {
    const { store } = await fixture();
    await store.init();
    const active = store.fetch(MILESTONES_LEDGER).milestones.find(({ id }) => id === MILESTONES_ACTIVE_GROUP_ID);
    expect(active).toBeDefined();
    if (active === undefined) throw new Error("active milestone group missing");
    expect(active.items.map(({ id }) => id)).toContain(MILESTONES_AMBIENT_ID);
  });

  it("makes every canonical ledger readable after reinitialization", async () => {
    const { store } = await fixture();
    await store.init();
    for (const canonical of CANONICAL_LEDGERS) {
      expect(store.fetch(canonical.name).schema).toEqual(canonical.schema);
    }
  });

  it("emits a WARNING to stderr naming the snapshot path", async () => {
    const { store, backupPath } = await fixture();
    const chunks: string[] = [];
    const original = process.stderr.write;
    const write = original.bind(process.stderr);
    process.stderr.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return typeof encodingOrCallback === "function"
        ? write(chunk, encodingOrCallback)
        : write(chunk, encodingOrCallback, callback);
    };
    try {
      await store.init();
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join("")).toContain("WARNING");
    expect(chunks.join("")).toContain(backupPath);
  });
});
