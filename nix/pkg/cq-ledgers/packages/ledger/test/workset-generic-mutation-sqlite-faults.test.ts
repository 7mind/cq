/**
 * T1974 — SQLite fault / race / restart Good-Communication cases for the
 * guarded generic-mutation gateway.
 *
 * Covers statement rollback, busy contention with a held write lock, setRoots
 * replacement races against an admitted mutation, process restart durability,
 * and peer observation of only complete post-commit states. Excluded targets
 * fail before any item SQL write.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createSqliteWorksetManagementLedger,
  TASKS_LEDGER,
  WorksetGenericMutationError,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { dataVersion, openLedgerDb } from "../src/store/sqlite/connection.js";

const dirs: string[] = [];
const liveLedgers: WorksetGuardedLedger[] = [];

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workset-gm-sqlite-fault-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

function openGuarded(dbPath: string): WorksetGuardedLedger {
  const ledger = createSqliteWorksetManagementLedger({ dbPath });
  liveLedgers.push(ledger);
  return ledger;
}

afterEach(async () => {
  while (liveLedgers.length > 0) {
    const ledger = liveLedgers.pop();
    if (ledger !== undefined) await ledger.dispose();
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seedPair(ledger: WorksetGuardedLedger): Promise<{
  milestoneId: string;
  taskIn: string;
  taskOut: string;
}> {
  await ledger.init();
  const m = await ledger.mutations.createMilestone({ title: "fault-seed" });
  const taskIn = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
    status: "planned",
    fields: { headline: "in" },
  });
  const taskOut = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
    status: "planned",
    fields: { headline: "out" },
  });
  return { milestoneId: m.id, taskIn: taskIn.id, taskOut: taskOut.id };
}

describe("workset generic-mutation sqlite faults [T1974]", () => {
  it("domain failure rolls back every row change (invalid status)", async () => {
    const dbPath = await freshDbPath();
    const ledger = openGuarded(dbPath);
    const { taskIn } = await seedPair(ledger);
    const before = ledger.fetchItem(TASKS_LEDGER, taskIn);
    const probe = openLedgerDb(dbPath);

    await expect(
      ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
        status: "not-a-real-status",
      }),
    ).rejects.toThrow();

    // Item payload must be unchanged (mutation txn rolled back). Admission
    // grant/release may still touch workset_* tables.
    expect(ledger.fetchItem(TASKS_LEDGER, taskIn)).toEqual(before);
    const row = probe
      .query("SELECT status, fields_json FROM items WHERE ledger = ? AND id = ?")
      .get(TASKS_LEDGER, taskIn) as { status: string; fields_json: string };
    expect(row.status).toBe(before.status);
    expect(JSON.parse(row.fields_json)).toEqual(before.fields);
    probe.close();
  });

  it("excluded target fails before any item SQL write", async () => {
    const dbPath = await freshDbPath();
    const ledger = openGuarded(dbPath);
    const { taskIn, taskOut } = await seedPair(ledger);
    await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

    const probe = openLedgerDb(dbPath);
    const beforeOut = ledger.fetchItem(TASKS_LEDGER, taskOut);
    const versionBefore = dataVersion(probe);
    const itemCountBefore = (
      probe.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }
    ).n;

    try {
      await ledger.mutations.updateItem(TASKS_LEDGER, taskOut, {
        status: "wip",
        fields: { headline: "should-not-land" },
      });
      throw new Error("expected target-excluded");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetGenericMutationError);
      expect((error as WorksetGenericMutationError).code).toBe("target-excluded");
    }

    expect(ledger.fetchItem(TASKS_LEDGER, taskOut)).toEqual(beforeOut);
    expect(
      (probe.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
    ).toBe(itemCountBefore);
    // Admission grant/release may touch workset tables; item rows must not move
    // and the item's fields_json must remain the pre-attempt snapshot.
    const row = probe
      .query("SELECT status, fields_json FROM items WHERE ledger = ? AND id = ?")
      .get(TASKS_LEDGER, taskOut) as { status: string; fields_json: string };
    expect(row.status).toBe(beforeOut.status);
    expect(JSON.parse(row.fields_json)).toEqual(beforeOut.fields);
    // data_version may advance from admission row churn; item payload is the
    // coherence surface under test.
    expect(dataVersion(probe)).toBeGreaterThanOrEqual(versionBefore);
    probe.close();
  });

  it("setRoots cannot commit through an admitted generic mutation", async () => {
    const dbPath = await freshDbPath();
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let admitted!: () => void;
    const admittedP = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let holdEnabled = false;

    const holder = createSqliteWorksetManagementLedger({
      dbPath,
      afterGenericAdmit: async () => {
        if (!holdEnabled) return;
        admitted();
        await hold;
      },
    });
    liveLedgers.push(holder);
    const { taskIn } = await seedPair(holder);
    await holder.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

    const setter = openGuarded(dbPath);
    await setter.init();

    holdEnabled = true;
    const mutP = holder.mutations.updateItem(TASKS_LEDGER, taskIn, {
      fields: { headline: "held" },
    });
    await admittedP;
    expect(holder.activeAdmissionCount()).toBeGreaterThan(0);

    let setDone = false;
    const setP = setter.setRoots([]).then((snap) => {
      setDone = true;
      return snap;
    });
    await Bun.sleep(40);
    expect(setDone).toBe(false);
    expect(setter.activeAdmissionCount() + holder.activeAdmissionCount()).toBeGreaterThan(0);

    releaseHold();
    await mutP;
    const snap = await setP;
    expect(snap.roots).toEqual([]);
    expect(await holder.snapshotRoots()).toEqual(snap);
    expect(await setter.snapshotRoots()).toEqual(snap);
    expect(holder.activeAdmissionCount()).toBe(0);
  });

  it("replacement race: mutation after set sees new roots; stale target denied", async () => {
    const ledger = openGuarded(await freshDbPath());
    const { taskIn, taskOut } = await seedPair(ledger);
    await ledger.setRoots([
      `${TASKS_LEDGER}:${taskIn}`,
      `${TASKS_LEDGER}:${taskOut}`,
    ]);
    expect(
      (await ledger.mutations.updateItem(TASKS_LEDGER, taskOut, { status: "wip" })).status,
    ).toBe("wip");

    const replaced = await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
    expect(replaced.roots).toEqual([`${TASKS_LEDGER}:${taskIn}`]);

    await ledger.mutations.updateItem(TASKS_LEDGER, taskIn, { status: "done" });
    const beforeOut = ledger.fetchItem(TASKS_LEDGER, taskOut);
    try {
      await ledger.mutations.updateItem(TASKS_LEDGER, taskOut, { status: "done" });
      throw new Error("expected target-excluded after replacement");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetGenericMutationError);
      expect((error as WorksetGenericMutationError).code).toBe("target-excluded");
    }
    expect(ledger.fetchItem(TASKS_LEDGER, taskOut)).toEqual(beforeOut);
  });

  it("restart reloads roots and committed mutation payload", async () => {
    const dbPath = await freshDbPath();
    const first = openGuarded(dbPath);
    const { taskIn } = await seedPair(first);
    await first.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
    await first.mutations.updateItem(TASKS_LEDGER, taskIn, {
      status: "wip",
      fields: { headline: "persisted" },
    });
    const roots = await first.snapshotRoots();
    await first.dispose();
    const idx = liveLedgers.indexOf(first);
    if (idx >= 0) liveLedgers.splice(idx, 1);

    const second = openGuarded(dbPath);
    await second.init();
    expect(await second.snapshotRoots()).toEqual(roots);
    const item = second.fetchItem(TASKS_LEDGER, taskIn);
    expect(item.status).toBe("wip");
    expect(item.fields.headline).toBe("persisted");
  });

  it("peer observes only complete post-commit item state (no torn fields)", async () => {
    const dbPath = await freshDbPath();
    const writer = openGuarded(dbPath);
    const { taskIn } = await seedPair(writer);
    await writer.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

    const reader = openGuarded(dbPath);
    await reader.init();

    const probe = openLedgerDb(dbPath);
    const versionBefore = dataVersion(probe);

    const updated = await writer.mutations.updateItem(TASKS_LEDGER, taskIn, {
      status: "wip",
      fields: { headline: "peer-visible" },
    });
    expect(updated.status).toBe("wip");

    // Peer connection must see the full committed pair, not a half-write.
    const peerView = reader.fetchItem(TASKS_LEDGER, taskIn);
    expect(peerView.status).toBe("wip");
    expect(peerView.fields.headline).toBe("peer-visible");
    expect(dataVersion(probe)).toBeGreaterThan(versionBefore);
    probe.close();
  });

  it("concurrent peer mutations serialize to one complete final state", async () => {
    const dbPath = await freshDbPath();
    const a = openGuarded(dbPath);
    const { taskIn } = await seedPair(a);
    await a.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

    const b = openGuarded(dbPath);
    await b.init();

    // Two connections race ordinary guarded updates. SQLite serializes the
    // BEGIN IMMEDIATE writers; the final durable payload must be one complete
    // write (never a torn mix of fields from both).
    const [fromA, fromB] = await Promise.all([
      a.mutations.updateItem(TASKS_LEDGER, taskIn, {
        fields: { headline: "from-a" },
      }),
      b.mutations.updateItem(TASKS_LEDGER, taskIn, {
        fields: { headline: "from-b" },
      }),
    ]);
    expect(fromA.fields.headline === "from-a" || fromA.fields.headline === "from-b").toBe(true);
    expect(fromB.fields.headline === "from-a" || fromB.fields.headline === "from-b").toBe(true);

    const finalA = a.fetchItem(TASKS_LEDGER, taskIn);
    const finalB = b.fetchItem(TASKS_LEDGER, taskIn);
    expect(finalA).toEqual(finalB);
    expect(finalA.fields.headline === "from-a" || finalA.fields.headline === "from-b").toBe(true);
    expect(finalA.status).toBe("planned");
  });
});
