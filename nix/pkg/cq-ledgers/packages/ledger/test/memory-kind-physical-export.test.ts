/**
 * G192/T6627 — physical export keeps a legacy memory's absent `kind`.
 *
 * A pre-`kind` SQLite store (schema metadata and row both lack `kind`) must
 * open through the benign added-optional-field widening without writing the
 * row, serve semantic `fact`, export the absence through
 * `exportPhysicalLedgerState` and the backup dump files, and restore it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MEMORIES_SCHEMA,
  MILESTONES_AMBIENT_ID,
  SqliteLedgerStore,
  buildBackupDump,
  createTrustedWorksetManagementAuthority,
  exportBackupInTree,
  parseBackupDump,
  readDumpInTree,
  restoreDumpToXdg,
  type FieldValue,
  type LedgerSchema,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function preKindSchema(): LedgerSchema {
  const schema = structuredClone(MEMORIES_SCHEMA);
  delete schema.fields["kind"];
  return schema;
}

function rawMemoryFields(dbPath: string, itemId: string): Record<string, FieldValue> {
  const db = openLedgerDb(dbPath);
  try {
    const row = db
      .query<{ fields_json: string }, [string, string]>(
        "SELECT fields_json FROM items WHERE ledger = ? AND id = ?",
      )
      .get(MEMORIES_LEDGER, itemId);
    if (row === null) throw new Error(`memory row ${itemId} missing`);
    return JSON.parse(row.fields_json) as Record<string, FieldValue>;
  } finally {
    db.close();
  }
}

/** A store written by a pre-`kind` build: schema metadata and row lack the field. */
async function seedPreKindStore(): Promise<{ dbPath: string; itemId: string; updatedAt: string }> {
  const dbPath = path.join(await tempDir("memory-kind-physical-"), "ledger.db");
  const seed = new SqliteLedgerStore({ dbPath });
  await seed.init();
  const created = await seed.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
    status: "active",
    fields: { title: "pre-kind memory", content: "written before kinds existed" },
  });
  await seed.dispose();

  const db = openLedgerDb(dbPath);
  try {
    const legacyFields = { ...created.fields };
    delete legacyFields["kind"];
    db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
      JSON.stringify(preKindSchema()),
      MEMORIES_LEDGER,
    );
    db.query("UPDATE items SET fields_json = ? WHERE ledger = ? AND id = ?").run(
      JSON.stringify(legacyFields),
      MEMORIES_LEDGER,
      created.id,
    );
  } finally {
    db.close();
  }
  return { dbPath, itemId: created.id, updatedAt: created.updatedAt };
}

describe("memory-kind physical export (SQLite)", () => {
  it("opens a pre-kind store through schema widening without writing the row", async () => {
    const { dbPath, itemId, updatedAt } = await seedPreKindStore();
    expect(rawMemoryFields(dbPath, itemId)["kind"]).toBeUndefined();

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      expect(store.fetch(MEMORIES_LEDGER).schema).toEqual(MEMORIES_SCHEMA);
      const item = store.fetchItem(MEMORIES_LEDGER, itemId);
      expect(item.fields["kind"]).toBe("fact");
      expect(item.updatedAt).toBe(updatedAt);
      expect(rawMemoryFields(dbPath, itemId)["kind"]).toBeUndefined();

      const physical = await store.exportPhysicalLedgerState();
      const memories = physical.ledgers.find(({ ledger }) => ledger.id === MEMORIES_LEDGER);
      const exported = memories?.ledger.milestones
        .flatMap((group) => group.items)
        .find((candidate) => candidate.id === itemId);
      expect(exported?.fields).toEqual(rawMemoryFields(dbPath, itemId));
    } finally {
      await store.dispose();
    }
    expect(rawMemoryFields(dbPath, itemId)["kind"]).toBeUndefined();
  });

  it("round-trips the absence through in-tree backup files and restore", async () => {
    const { dbPath, itemId } = await seedPreKindStore();
    const source = new SqliteLedgerStore({ dbPath });
    await source.init();
    const root = await tempDir("memory-kind-backup-");
    try {
      await exportBackupInTree(root, await buildBackupDump(source, null));
    } finally {
      await source.dispose();
    }

    const dump = await readDumpInTree(root);
    const memoriesFile = dump.find(({ path: relPath }) => relPath === `${MEMORIES_LEDGER}.md`);
    expect(memoriesFile?.content).toContain("pre-kind memory");
    const parsed = parseBackupDump(dump);
    const dumpedItem = parsed.ledgers
      .get(MEMORIES_LEDGER)
      ?.milestones.flatMap((group) => group.items)
      .find((candidate) => candidate.id === itemId);
    expect(dumpedItem?.fields["kind"]).toBeUndefined();

    const restoredDb = path.join(await tempDir("memory-kind-restored-"), "ledger.db");
    await restoreDumpToXdg({
      dbPath: restoredDb,
      logsDir: null,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });
    expect(rawMemoryFields(restoredDb, itemId)["kind"]).toBeUndefined();
    const restored = new SqliteLedgerStore({ dbPath: restoredDb });
    await restored.init();
    try {
      expect(restored.fetchItem(MEMORIES_LEDGER, itemId).fields["kind"]).toBe("fact");
    } finally {
      await restored.dispose();
    }
    expect(rawMemoryFields(restoredDb, itemId)["kind"]).toBeUndefined();
  });
});

describe("memory-kind physical export (InMemory)", () => {
  it("returns a detached copy that cannot alter the store", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const created = await store.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "active",
        fields: { title: "detached", content: "export must not alias", kind: "rule" },
      });
      const physical = await store.exportPhysicalLedgerState();
      const exported = physical.ledgers
        .find(({ ledger }) => ledger.id === MEMORIES_LEDGER)
        ?.ledger.milestones.flatMap((group) => group.items)
        .find((candidate) => candidate.id === created.id);
      if (exported === undefined) throw new Error("exported memory missing");
      exported.fields["kind"] = "environment";
      expect(store.fetchItem(MEMORIES_LEDGER, created.id).fields["kind"]).toBe("rule");
    } finally {
      await store.dispose();
    }
  });
});
