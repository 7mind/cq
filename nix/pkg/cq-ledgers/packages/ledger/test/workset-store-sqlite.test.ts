/**
 * T1957 — SqliteLedgerStore WorksetStore leg.
 *
 * Runs the shared Behavioral-Active Blackbox contract unchanged against the
 * real SQLite adapter, plus focused Good-Communication assertions for restart
 * durability, peer coherence via data_version, and schema seed state.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  readWorksetRootsEpoch,
  SqliteLedgerStore,
  WorksetAdmissionError,
  type WorksetStore,
} from "../src/index.js";
import { dataVersion, openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";
import {
  runWorksetStoreContract,
  type WorksetStoreContractFactory,
} from "./worksetStoreContract.js";

const dirs: string[] = [];
const liveLedgers: SqliteLedgerStore[] = [];

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workset-sqlite-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

async function buildLedger(
  options?: Parameters<WorksetStoreContractFactory["build"]>[0],
): Promise<{ ledger: SqliteLedgerStore; store: WorksetStore; dbPath: string }> {
  const dbPath = await freshDbPath();
  const ledger = new SqliteLedgerStore({
    dbPath,
    ...(options !== undefined ? { workset: options } : {}),
  });
  await ledger.init();
  liveLedgers.push(ledger);
  return { ledger, store: ledger.worksetStore(), dbPath };
}

afterEach(async () => {
  while (liveLedgers.length > 0) {
    const ledger = liveLedgers.pop();
    if (ledger !== undefined) await ledger.dispose();
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const sqliteWorksetStoreFactory: WorksetStoreContractFactory = {
  name: "SqliteLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const { store } = await buildLedger(options);
    return store;
  },
};

runWorksetStoreContract(sqliteWorksetStoreFactory);

describe("workset store sqlite [T1957]", () => {
  it("ensureSchema seeds workset_state at epoch 0 with empty roots", async () => {
    const db = openLedgerDb(await freshDbPath());
    try {
      ensureSchema(db);
      const row = db
        .query(
          "SELECT epoch, roots_json, admit_generation FROM workset_state WHERE id = 1",
        )
        .get() as { epoch: number; roots_json: string; admit_generation: number };
      expect(row).toEqual({ epoch: 0, roots_json: "[]", admit_generation: 0 });
      const meta = db
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: number };
      expect(Number(meta.value)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(4);
    } finally {
      db.close();
    }
  });

  it("restart reloads exact root order and epoch from durable rows", async () => {
    const dbPath = await freshDbPath();
    const first = new SqliteLedgerStore({ dbPath });
    await first.init();
    const committed = await first
      .worksetStore()
      .setRoots(["goals:G-restart", "tasks:T-restart", "ideas:I-restart"]);
    expect(committed).toEqual({
      roots: ["goals:G-restart", "tasks:T-restart", "ideas:I-restart"],
      epoch: 1,
    });
    await first.dispose();

    const second = new SqliteLedgerStore({ dbPath });
    await second.init();
    liveLedgers.push(second);
    expect(await readWorksetRootsEpoch(second.worksetStore())).toEqual(committed);
  });

  it("peer connection observes complete root/epoch pairs after commit (data_version)", async () => {
    const dbPath = await freshDbPath();
    const writer = new SqliteLedgerStore({ dbPath });
    await writer.init();
    liveLedgers.push(writer);
    const reader = new SqliteLedgerStore({ dbPath });
    await reader.init();
    liveLedgers.push(reader);

    const probe = openLedgerDb(dbPath);
    try {
      const versionBefore = dataVersion(probe);

      const snap = await writer.worksetStore().setRoots(["milestones:M-peer"]);
      const versionAfter = dataVersion(probe);
      expect(versionAfter).not.toBe(versionBefore);

      expect(await readWorksetRootsEpoch(reader.worksetStore())).toEqual(snap);
      expect(snap).toEqual({ roots: ["milestones:M-peer"], epoch: 1 });
    } finally {
      probe.close();
    }
  });

  it("invalid replacement leaves durable state unchanged across reopen", async () => {
    const { ledger, store, dbPath } = await buildLedger({
      validateReplacement: (roots) => {
        if (roots.includes("bad:ROOT")) {
          throw new WorksetAdmissionError("invalid-replacement", "synthetic");
        }
      },
    });
    await store.setRoots(["goals:G-keep"]);
    await expect(store.setRoots(["bad:ROOT"])).rejects.toMatchObject({
      code: "invalid-replacement",
    });
    expect(await readWorksetRootsEpoch(store)).toEqual({
      roots: ["goals:G-keep"],
      epoch: 1,
    });
    await ledger.dispose();
    const idx = liveLedgers.indexOf(ledger);
    if (idx >= 0) liveLedgers.splice(idx, 1);

    const reopened = new SqliteLedgerStore({ dbPath });
    await reopened.init();
    liveLedgers.push(reopened);
    expect(await readWorksetRootsEpoch(reopened.worksetStore())).toEqual({
      roots: ["goals:G-keep"],
      epoch: 1,
    });
  });
});
