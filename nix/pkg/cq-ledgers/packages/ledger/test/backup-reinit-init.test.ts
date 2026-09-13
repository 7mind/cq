/**
 * T96 — SQLite initialization distinguishes explicit destructive reinitialization,
 * default abort, compatible restart, and first bootstrap.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore, CANONICAL_LEDGERS, GOALS_LEDGER, GOALS_SCHEMA,
  MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_AMBIENT_ID,
  BootstrapViolationError, createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { readSqliteCanonicalRows, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";

const TIMESTAMP = "2026-06-02T10:00:00.000Z";
const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
afterAll(async () => {
  for (const store of stores) await store.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fresh() {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-bri-"));
  dirs.push(root);
  return { root, dbPath: path.join(root, "ledger.db") };
}

function ordinary(dbPath: string): SqliteLedgerStore {
  const store = new SqliteLedgerStore({ dbPath });
  stores.push(store);
  return store;
}

function reinitializing(dbPath: string): SqliteLedgerStore {
  const store = new SqliteLedgerStore({
    dbPath, now: () => TIMESTAMP, onSchemaDivergence: "backup-reinit",
    allowDestructiveReinitOfPopulatedStore: true,
    worksetAuthority: createTrustedWorksetManagementAuthority(),
  });
  stores.push(store);
  return store;
}

async function divergent() {
  const fixture = await fresh();
  const seed = ordinary(fixture.dbPath);
  await seed.init();
  await seed.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "G1", status: "clarifying",
    fields: { title: "a prior goal", description: "preserve prior goal bytes" },
  });
  await seed.dispose();
  const db = new Database(fixture.dbPath, { readwrite: true, create: false });
  try {
    const schema = { ...GOALS_SCHEMA, statusValues: [...GOALS_SCHEMA.statusValues, "extra-status"] };
    db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(JSON.stringify(schema), GOALS_LEDGER);
  } finally {
    db.close();
  }
  return { ...fixture, backupPath: sqliteDivergenceBackupPath(fixture.dbPath, TIMESTAMP) };
}

function registryRows(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify(db.query("SELECT * FROM ledgers ORDER BY name").all());
  } finally {
    db.close();
  }
}

function goalRows(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify(db.query("SELECT * FROM items WHERE ledger = ? ORDER BY id").all(GOALS_LEDGER));
  } finally {
    db.close();
  }
}

async function expectNoBackup(root: string): Promise<void> {
  expect((await readdir(root)).filter((name) => name.startsWith("ledger.backup-"))).toEqual([]);
}

function expectBootstrap(store: SqliteLedgerStore): void {
  const active = store.fetch(MILESTONES_LEDGER).milestones.find(({ id }) => id === MILESTONES_ACTIVE_GROUP_ID);
  expect(active).toBeDefined();
  if (active === undefined) throw new Error("active milestone group missing");
  expect(active.items.map(({ id }) => id)).toContain(MILESTONES_AMBIENT_ID);
}

describe("SQLite init divergence → backup/reinit (explicit opt-in)", () => {
  it("initialization resolves without throwing", async () => {
    const { dbPath } = await divergent();
    await expect(reinitializing(dbPath).init()).resolves.toBeUndefined();
  });
  it("creates a snapshot with the sanitized timestamp", async () => {
    const { dbPath, backupPath } = await divergent();
    await reinitializing(dbPath).init();
    expect((await stat(backupPath)).isFile()).toBe(true);
  });
  it("backup contains byte-for-byte prior registry rows", async () => {
    const { dbPath, backupPath } = await divergent();
    const before = registryRows(dbPath);
    await reinitializing(dbPath).init();
    expect(registryRows(backupPath)).toBe(before);
  });
  it("backup contains byte-for-byte prior divergent-ledger item rows", async () => {
    const { dbPath, backupPath } = await divergent();
    const before = goalRows(dbPath);
    expect(before).toContain("a prior goal");
    await reinitializing(dbPath).init();
    expect(goalRows(backupPath)).toBe(before);
  });
  it("live persisted goal rows contain no prior items", async () => {
    const { dbPath } = await divergent();
    await reinitializing(dbPath).init();
    expect(goalRows(dbPath)).toBe("[]");
  });
  it("live persisted registry is canonical without the divergent status", async () => {
    const { dbPath } = await divergent();
    await reinitializing(dbPath).init();
    const after = registryRows(dbPath);
    expect(after).not.toContain("extra-status");
    for (const canonical of CANONICAL_LEDGERS) expect(after).toContain(canonical.name);
  });
  it("the public goals schema has canonical status values", async () => {
    const { dbPath } = await divergent();
    const store = reinitializing(dbPath);
    await store.init();
    expect(store.fetch(GOALS_LEDGER).schema.statusValues).toEqual(GOALS_SCHEMA.statusValues);
    expect(store.fetch(GOALS_LEDGER).schema.statusValues).not.toContain("extra-status");
  });
  it("the public goals ledger has no prior items", async () => {
    const { dbPath } = await divergent();
    const store = reinitializing(dbPath);
    await store.init();
    expect(store.fetch(GOALS_LEDGER).milestones.flatMap(({ items }) => items)).toHaveLength(0);
  });
  it("the milestone ledger has the bootstrap group and ambient item", async () => {
    const { dbPath } = await divergent();
    const store = reinitializing(dbPath);
    await store.init();
    expectBootstrap(store);
  });
  it("emits exactly one WARNING naming the backup path", async () => {
    const { dbPath, backupPath } = await divergent();
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
      await reinitializing(dbPath).init();
    } finally {
      process.stderr.write = original;
    }
    const stderr = chunks.join("");
    expect(stderr).toContain(backupPath);
    expect(stderr.match(/WARNING/g)).toHaveLength(1);
  });
});

describe("SQLite init divergence aborts by default", () => {
  it("rejects with BootstrapViolationError", async () => {
    const { dbPath } = await divergent();
    await expect(ordinary(dbPath).init()).rejects.toThrow(BootstrapViolationError);
  });
  it("reports the different canonical schema", async () => {
    const { dbPath } = await divergent();
    await expect(ordinary(dbPath).init()).rejects.toThrow(/different schema/);
  });
  it("creates no backup on abort", async () => {
    const { dbPath, root } = await divergent();
    await expect(ordinary(dbPath).init()).rejects.toThrow(BootstrapViolationError);
    await expectNoBackup(root);
  });
  it("leaves persisted registry rows untouched on abort", async () => {
    const { dbPath } = await divergent();
    const before = registryRows(dbPath);
    await expect(ordinary(dbPath).init()).rejects.toThrow(BootstrapViolationError);
    expect(registryRows(dbPath)).toBe(before);
  });
  it("leaves persisted goal rows untouched on abort", async () => {
    const { dbPath } = await divergent();
    const before = goalRows(dbPath);
    await expect(ordinary(dbPath).init()).rejects.toThrow(BootstrapViolationError);
    expect(goalRows(dbPath)).toBe(before);
  });
});

describe("SQLite init regression — no divergence", () => {
  it("leaves canonical rows unchanged when schemas match", async () => {
    const { dbPath } = await fresh();
    const first = ordinary(dbPath);
    await first.init();
    await first.dispose();
    const before = readSqliteCanonicalRows(dbPath);
    const second = ordinary(dbPath);
    await second.init();
    await second.dispose();
    expect(readSqliteCanonicalRows(dbPath)).toBe(before);
  });
  it("creates no backup when schemas match", async () => {
    const { dbPath, root } = await fresh();
    const first = ordinary(dbPath);
    await first.init();
    await first.dispose();
    await ordinary(dbPath).init();
    await expectNoBackup(root);
  });
});

describe("SQLite init regression — empty directory", () => {
  it("creates every canonical ledger and schema from scratch", async () => {
    const { dbPath } = await fresh();
    const store = ordinary(dbPath);
    await store.init();
    expect(store.enumerate().sort()).toEqual(CANONICAL_LEDGERS.map(({ name }) => name).sort());
    for (const canonical of CANONICAL_LEDGERS) expect(store.fetch(canonical.name).schema).toEqual(canonical.schema);
  });
  it("creates the bootstrap group and ambient milestone", async () => {
    const { dbPath } = await fresh();
    const store = ordinary(dbPath);
    await store.init();
    expectBootstrap(store);
  });
  it("creates no backup for an empty directory", async () => {
    const { dbPath, root } = await fresh();
    await ordinary(dbPath).init();
    await expectNoBackup(root);
  });
});
