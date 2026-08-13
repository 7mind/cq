/**
 * T1974 — SQLite durable leg of the guarded generic-mutation dual-test pair.
 *
 * Runs the shared Behavioral-Active Blackbox contract unchanged against
 * {@link createSqliteWorksetManagementLedger}, plus focused Good-Communication
 * cases for status/reference updates, exact-root unarchive, and archive sweeps
 * on real temporary databases.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createSqliteWorksetManagementLedger,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  WorksetGenericMutationError,
  type WorksetGuardedLedger,
} from "../src/index.js";
import {
  runWorksetGenericMutationContract,
  type WorksetGenericMutationContractBuildOptions,
} from "./worksetGenericMutationContract.js";

const dirs: string[] = [];
const liveLedgers: WorksetGuardedLedger[] = [];

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "workset-gm-sqlite-"));
  dirs.push(dir);
  return path.join(dir, "ledger.db");
}

async function buildSqliteGuarded(
  options?: WorksetGenericMutationContractBuildOptions,
): Promise<WorksetGuardedLedger> {
  const dbPath = await freshDbPath();
  const ledger = createSqliteWorksetManagementLedger({
    dbPath,
    ...(options?.now !== undefined ? { now: options.now } : {}),
    ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options?.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });
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

runWorksetGenericMutationContract({
  name: "sqlite-durable",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  build: (options) => buildSqliteGuarded(options),
});

describe("workset generic-mutation sqlite focused [T1974]", () => {
  it("rejects a target whose closure membership a peer revokes before BEGIN IMMEDIATE", async () => {
    const dbPath = await freshDbPath();
    const admitted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let pause = false;
    const writer = createSqliteWorksetManagementLedger({
      dbPath,
      afterGenericAdmit: async () => {
        if (!pause) return;
        admitted.resolve();
        await resume.promise;
      },
    });
    const peer = createSqliteWorksetManagementLedger({ dbPath });
    await writer.init();
    await peer.init();
    try {
      const milestone = await writer.mutations.createMilestone({ title: "revocation" });
      const root = await writer.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "root" },
      });
      const dependent = await writer.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "dependent" },
      });
      await writer.mutations.updateItem(TASKS_LEDGER, root.id, {
        fields: { dependsOn: [`${TASKS_LEDGER}:${dependent.id}`] },
      });
      await writer.setRoots([`${TASKS_LEDGER}:${root.id}`]);

      pause = true;
      const contested = writer.mutations.updateItem(TASKS_LEDGER, dependent.id, {
        status: "wip",
      });
      await admitted.promise;
      await peer.mutations.updateItem(TASKS_LEDGER, root.id, {
        fields: { dependsOn: [] },
      });
      resume.resolve();

      await expect(contested).rejects.toMatchObject({ code: "mixed-or-excluded-targets" });
      await writer.invalidate(TASKS_LEDGER);
      expect(writer.fetchItem(TASKS_LEDGER, dependent.id).status).toBe("planned");
    } finally {
      resume.resolve();
      await writer.dispose();
      await peer.dispose();
    }
  });

  it("status and dependsOn updates persist under restrictive roots", async () => {
    const ledger = await buildSqliteGuarded();
    await ledger.init();
    const m = await ledger.mutations.createMilestone({ title: "status-m" });
    const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "a" },
    });
    const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "b", dependsOn: [`${TASKS_LEDGER}:${a.id}`] },
    });
    await ledger.setRoots([`${TASKS_LEDGER}:${b.id}`]);

    const statused = await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
      status: "wip",
    });
    expect(statused.status).toBe("wip");
    expect(ledger.fetchItem(TASKS_LEDGER, b.id).status).toBe("wip");

    const referenced = await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
      fields: {
        dependsOn: [`${TASKS_LEDGER}:${a.id}`],
        blockedBy: [],
        headline: "b-ref",
      },
    });
    expect(referenced.fields.dependsOn).toEqual([`${TASKS_LEDGER}:${a.id}`]);
    expect(referenced.fields.headline).toBe("b-ref");
    expect(ledger.fetchItem(TASKS_LEDGER, b.id).fields.headline).toBe("b-ref");
  });

  it("exact-root unarchive restores only the configured inactive root", async () => {
    const ledger = await buildSqliteGuarded();
    await ledger.init();
    const m = await ledger.mutations.createMilestone({ title: "unarch-m" });
    const keep = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "keep" },
    });
    const other = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "other" },
    });
    await ledger.mutations.updateMilestone(m.id, { status: "done" });
    await ledger.mutations.archiveMilestone(m.id, "archive-for-unarchive");

    await ledger.setRoots([`${TASKS_LEDGER}:${keep.id}`]);
    const restored = await ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, keep.id);
    expect(restored.id).toBe(keep.id);
    expect(ledger.fetchItem(TASKS_LEDGER, keep.id).fields.headline).toBe("keep");

    try {
      await ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, other.id);
      throw new Error("expected unarchive denial");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetGenericMutationError);
      expect((error as WorksetGenericMutationError).code).toBe(
        "unarchive-not-exact-inactive-root",
      );
    }
    // other remains archived (fetchItem throws ItemNotFoundError for active path).
    expect(() => ledger.fetchItem(TASKS_LEDGER, other.id)).toThrow();
  });

  it("archive sweep under full roots removes every active member", async () => {
    const ledger = await buildSqliteGuarded();
    await ledger.init();
    const m = await ledger.mutations.createMilestone({ title: "sweep-m" });
    const t1 = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "t1" },
    });
    const t2 = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "t2" },
    });
    await ledger.mutations.updateMilestone(m.id, { status: "done" });
    await ledger.setRoots([
      `${MILESTONES_LEDGER}:${m.id}`,
      `${TASKS_LEDGER}:${t1.id}`,
      `${TASKS_LEDGER}:${t2.id}`,
    ]);
    const ptr = await ledger.mutations.archiveMilestone(m.id, "full-sweep");
    expect(ptr.id).toBe(m.id);
    expect(() => ledger.fetchItem(MILESTONES_LEDGER, m.id)).toThrow();
    expect(() => ledger.fetchItem(TASKS_LEDGER, t1.id)).toThrow();
    expect(() => ledger.fetchItem(TASKS_LEDGER, t2.id)).toThrow();
  });
});
