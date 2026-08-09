/**
 * T1957 — focused SQLite effect-admission Good-Communication tests.
 *
 * Cross-process durable admissions, exclusive replacement ordering, crash
 * cleanup (stale holder reclaim), and set-versus-admission linearization on
 * real temporary databases. The shared Blackbox contract covers in-process
 * races; this file covers multi-connection / multi-process durability.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readWorksetRootsEpoch,
  SqliteLedgerStore,
  WorksetAdmissionError,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const dirs: string[] = [];
const liveLedgers: SqliteLedgerStore[] = [];

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workset-admit-sqlite-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

async function openStore(dbPath: string): Promise<SqliteLedgerStore> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  liveLedgers.push(store);
  return store;
}

afterEach(async () => {
  while (liveLedgers.length > 0) {
    const ledger = liveLedgers.pop();
    if (ledger !== undefined) await ledger.dispose();
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("workset effect admission sqlite [T1957]", () => {
  it("broker admission rows are durable and visible to a peer connection", async () => {
    const dbPath = await freshDbPath();
    const a = await openStore(dbPath);
    const b = await openStore(dbPath);

    const admission = await a.worksetStore().admitExternalEffect({
      kind: "child-dispatch",
      targetRef: "tasks:T-cross",
    });
    expect(a.worksetStore().activeAdmissionCount()).toBe(1);
    // Peer observes the durable row without sharing in-process maps.
    expect(b.worksetStore().activeAdmissionCount()).toBe(1);

    const probe = openLedgerDb(dbPath);
    try {
      const row = probe
        .query(
          "SELECT id, form, target_ref, process_group_registered, settled FROM workset_admissions WHERE id = ?",
        )
        .get(admission.id) as {
        id: string;
        form: string;
        target_ref: string;
        process_group_registered: number;
        settled: number;
      };
      expect(row).toEqual({
        id: admission.id,
        form: "external-effect",
        target_ref: "tasks:T-cross",
        process_group_registered: 0,
        settled: 0,
      });
    } finally {
      probe.close();
    }

    admission.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
    admission.markSettled();
    await admission.releaseAfterSettlement();
    expect(a.worksetStore().activeAdmissionCount()).toBe(0);
    expect(b.worksetStore().activeAdmissionCount()).toBe(0);
  });

  it("setRoots on a peer waits for a live durable admission then commits", async () => {
    const dbPath = await freshDbPath();
    const holder = await openStore(dbPath);
    const setter = await openStore(dbPath);

    const admission = await holder.worksetStore().admitLedgerMutation({
      kind: "generic-write",
      targets: ["tasks:T-hold"],
    });
    expect(holder.worksetStore().activeAdmissionCount()).toBe(1);

    let setDone = false;
    const setPromise = setter
      .worksetStore()
      .setRoots(["goals:G-after"])
      .then((snap) => {
        setDone = true;
        return snap;
      });

    // Give the setter time to claim exclusive and block on the admission.
    await Bun.sleep(30);
    expect(setDone).toBe(false);
    expect(setter.worksetStore().exclusiveHeld()).toBe(true);

    await admission.acknowledge();
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G-after"], epoch: 1 });
    expect(await readWorksetRootsEpoch(holder.worksetStore())).toEqual(snap);
    expect(holder.worksetStore().activeAdmissionCount()).toBe(0);
  });

  it("reclaims a stale ledger-mutation admission when the holder pid is dead", async () => {
    const dbPath = await freshDbPath();
    const store = await openStore(dbPath);
    // Insert a durable admission row pretending to belong to a dead pid.
    const db = openLedgerDb(dbPath);
    try {
      db.query(
        `INSERT INTO workset_admissions (
           id, form, kind, epoch, roots_json, targets_json, target_ref,
           host, pid, started_at, pgid, leader_pid, settled, process_group_registered
         ) VALUES (?, 'ledger-mutation', 'generic-write', 0, '[]', '[]', NULL,
                   ?, ?, ?, NULL, NULL, 1, 0)`,
      ).run("lm-stale-dead", os.hostname(), 2_147_483_646, Date.now());
    } finally {
      db.close();
    }

    // activeAdmissionCount reclaims stale same-host dead-pid rows.
    expect(store.worksetStore().activeAdmissionCount()).toBe(0);

    const snap = await store.worksetStore().setRoots(["goals:G-reclaim"]);
    expect(snap.epoch).toBe(1);
  });

  it("does not reclaim an unsettled external admission whose process group leader still lives", async () => {
    const dbPath = await freshDbPath();
    const store = await openStore(dbPath);
    const db = openLedgerDb(dbPath);
    const livePid = process.pid;
    try {
      db.query(
        `INSERT INTO workset_admissions (
           id, form, kind, epoch, roots_json, targets_json, target_ref,
           host, pid, started_at, pgid, leader_pid, settled, process_group_registered
         ) VALUES (?, 'external-effect', 'merge', 0, '[]', ?, ?,
                   ?, ?, ?, ?, ?, 0, 1)`,
      ).run(
        "ee-orphan-group",
        JSON.stringify(["tasks:T-live"]),
        "tasks:T-live",
        os.hostname(),
        2_147_483_645, // dead holder
        Date.now(),
        livePid, // registered group leader still this process
        livePid,
      );
    } finally {
      db.close();
    }

    expect(store.worksetStore().activeAdmissionCount()).toBe(1);

    // setRoots must not commit through the unsettled registered group.
    let committed = false;
    const setP = store
      .worksetStore()
      .setRoots(["goals:G-blocked"])
      .then((s) => {
        committed = true;
        return s;
      });
    await Bun.sleep(40);
    expect(committed).toBe(false);

    // Settle the row as a crash-cleanup would after process-group death proof.
    const fix = openLedgerDb(dbPath);
    try {
      fix
        .query("UPDATE workset_admissions SET settled = 1 WHERE id = ?")
        .run("ee-orphan-group");
    } finally {
      fix.close();
    }
    const snap = await setP;
    expect(snap).toEqual({ roots: ["goals:G-blocked"], epoch: 1 });
  });

  it("cross-process child: holder admits, parent set waits, child release unblocks", async () => {
    const dbPath = await freshDbPath();
    // Seed schema via parent store.
    const parent = await openStore(dbPath);
    await parent.dispose();
    const pidx = liveLedgers.indexOf(parent);
    if (pidx >= 0) liveLedgers.splice(pidx, 1);

    const childScript = fileURLToPath(
      new URL("./worksetAdmissionSqliteChild.ts", import.meta.url),
    );
    const child = Bun.spawn({
      cmd: ["bun", childScript, dbPath],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    const decoder = new TextDecoder();
    let stdout = "";
    const reader = child.stdout.getReader();
    // Wait for ADMITTED line.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (stdout.includes("ADMITTED\n")) break;
    }
    expect(stdout).toContain("ADMITTED\n");

    const setter = await openStore(dbPath);
    let setDone = false;
    const setPromise = setter
      .worksetStore()
      .setRoots(["ideas:I-child"])
      .then((s) => {
        setDone = true;
        return s;
      });
    await Bun.sleep(40);
    expect(setDone).toBe(false);

    // Tell child to release.
    child.stdin.write("RELEASE\n");
    await child.stdin.end();
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["ideas:I-child"], epoch: 1 });
    const exit = await child.exited;
    expect(exit).toBe(0);
  });

  it("rejects target outside restrictive roots with durable epoch unchanged", async () => {
    const store = (await openStore(await freshDbPath())).worksetStore();
    await store.setRoots(["goals:G-only"]);
    try {
      await store.admitExternalEffect({
        kind: "rebase",
        targetRef: "tasks:T-out",
      });
      throw new Error("expected target-excluded");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetAdmissionError);
      expect((error as WorksetAdmissionError).code).toBe("target-excluded");
    }
    expect(await readWorksetRootsEpoch(store)).toEqual({
      roots: ["goals:G-only"],
      epoch: 1,
    });
    expect(store.activeAdmissionCount()).toBe(0);
  });
});
