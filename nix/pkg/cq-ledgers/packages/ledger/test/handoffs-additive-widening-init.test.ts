/**
 * T247 — a widened canonical handoff schema must survive initialization without
 * destructive reinitialization or loss of handoff history.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore, HANDOFFS_LEDGER, HANDOFFS_SCHEMA } from "../src/index.js";

const dirs: string[] = [];
const WIDENED_STATUS = "user-action-required";
const SUMMARY = "pre-existing handoff that must survive additive schema widening";
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function seedWidenedHandoffsStore() {
  expect(HANDOFFS_SCHEMA.statusValues).toContain(WIDENED_STATUS);
  const root = await mkdtemp(path.join(tmpdir(), "ledger-ho-additive-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "seed handoffs milestone" });
    const created = await store.createItem(HANDOFFS_LEDGER, milestone.id, {
      status: "drained",
      fields: { summary: SUMMARY, flow: "implement", handoffReasons: [] },
    });
    return { root, dbPath, handoffId: created.id };
  } finally {
    await store.dispose();
  }
}

function persistedHandoff(dbPath: string, handoffId: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query<{ id: string; fields_json: string }, [string, string]>(
      "SELECT id, fields_json FROM items WHERE ledger = ? AND id = ?",
    ).get(HANDOFFS_LEDGER, handoffId);
    if (row === null) throw new Error(`persisted handoff ${handoffId} missing`);
    return row;
  } finally {
    db.close();
  }
}

describe("handoffs additive widening — fixture carries the widened persisted schema", () => {
  it("the seeded SQLite registry includes user-action-required", async () => {
    const { dbPath } = await seedWidenedHandoffsStore();
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{ name: string; schema_json: string }, [string]>(
        "SELECT name, schema_json FROM ledgers WHERE name = ?",
      ).get(HANDOFFS_LEDGER);
      if (row === null) throw new Error("persisted handoff schema missing");
      expect(row.name).toBe(HANDOFFS_LEDGER);
      expect(row.schema_json).toContain(WIDENED_STATUS);
    } finally {
      db.close();
    }
  });

  it("the seeded HO1 record is persisted before reinitialization", async () => {
    const { dbPath, handoffId } = await seedWidenedHandoffsStore();
    expect(handoffId).toBe("HO1");
    const row = persistedHandoff(dbPath, handoffId);
    expect(row.id).toBe(handoffId);
    expect(row.fields_json).toContain(SUMMARY);
  });
});

describe("handoffs additive widening — init preserves live history", () => {
  it("does not create a divergence snapshot for the additive shape", async () => {
    const { root, dbPath } = await seedWidenedHandoffsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();
    expect((await readdir(root)).filter((name) => name.startsWith("ledger.backup-"))).toEqual([]);
  });

  it("does not reset the persisted handoff ledger to empty", async () => {
    const { dbPath, handoffId } = await seedWidenedHandoffsStore();
    const before = persistedHandoff(dbPath, handoffId);
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();
    expect(persistedHandoff(dbPath, handoffId)).toEqual(before);
    expect(before.fields_json).toContain(SUMMARY);
  });

  it("the pre-seeded handoff and widened schema are readable after initialization", async () => {
    const { dbPath, handoffId } = await seedWidenedHandoffsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const fetched = store.fetchItem(HANDOFFS_LEDGER, handoffId);
      expect(fetched.id).toBe(handoffId);
      expect(fetched.status).toBe("drained");
      expect(fetched.fields["summary"]).toBe(SUMMARY);
      expect(store.fetch(HANDOFFS_LEDGER).schema.statusValues).toEqual(HANDOFFS_SCHEMA.statusValues);
      expect(store.fetch(HANDOFFS_LEDGER).schema.statusValues).toContain(WIDENED_STATUS);
    } finally {
      await store.dispose();
    }
  });
});
