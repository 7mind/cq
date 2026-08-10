/**
 * T1972 — filesystem leg of the guarded generic-mutation dual-test pair.
 *
 * Runs the shared Behavioral-Active Blackbox contract against
 * {@link createFsWorksetGuardedLedger}, plus focused Good-Communication cases
 * for restart, competing writers, in-graph updates, closure refs, exact-root
 * unarchive, and whole-milestone archive durability.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createFsWorksetGuardedLedger,
  assertNoPublicRawWriteEscape,
  WorksetGenericMutationError,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  LEDGER_STORAGE_DIRNAME,
  type CreateInMemoryWorksetGuardedLedgerOptions,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { runWorksetGenericMutationContract } from "./worksetGenericMutationContract.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-generic-mut-fs-"));
  dirs.push(dir);
  return dir;
}

async function buildFsLedger(
  options: CreateInMemoryWorksetGuardedLedgerOptions = {},
): Promise<WorksetGuardedLedger> {
  const root = await freshRoot();
  return createFsWorksetGuardedLedger({
    root,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });
}

runWorksetGenericMutationContract({
  name: "filesystem",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  build: (options) => buildFsLedger(options),
});

describe("workset generic-mutation filesystem focused [T1972]", () => {
  it("createFsWorksetGuardedLedger requires a non-empty root", () => {
    expect(() => createFsWorksetGuardedLedger({ root: "" })).toThrow(
      /createFsWorksetGuardedLedger: root is required/,
    );
  });

  it("public surface freezes the gateway and hides raw writes", async () => {
    const ledger = await buildFsLedger();
    await ledger.init();
    try {
      assertNoPublicRawWriteEscape(ledger);
      expect(Object.isFrozen(ledger.mutations)).toBe(true);
      expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
    } finally {
      await ledger.dispose();
    }
  });

  it("restart retains roots epoch and admitted mutation results", async () => {
    const root = await freshRoot();
    const first = createFsWorksetGuardedLedger({ root });
    await first.init();
    let taskId: string;
    let milestoneId: string;
    try {
      const m = await first.mutations.createMilestone({ title: "restart-m" });
      milestoneId = m.id;
      const t = await first.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "restart-t" },
      });
      taskId = t.id;
      await first.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      await first.mutations.updateItem(TASKS_LEDGER, t.id, {
        status: "wip",
        fields: { headline: "restart-t-updated" },
      });
      expect(await first.snapshotRoots()).toEqual({
        roots: [`${TASKS_LEDGER}:${t.id}`],
        epoch: 1,
      });
    } finally {
      await first.dispose();
    }

    const second = createFsWorksetGuardedLedger({ root });
    await second.init();
    try {
      expect(await second.snapshotRoots()).toEqual({
        roots: [`${TASKS_LEDGER}:${taskId}`],
        epoch: 1,
      });
      const item = second.fetchItem(TASKS_LEDGER, taskId);
      expect(item.status).toBe("wip");
      expect(item.fields.headline).toBe("restart-t-updated");
      expect(second.fetchItem(MILESTONES_LEDGER, milestoneId).id).toBe(milestoneId);

      // Restrictive roots still enforce after reopen.
      await expect(
        second.mutations.createItem(TASKS_LEDGER, milestoneId, {
          status: "planned",
          fields: { headline: "post-restart-denied" },
        }),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);
    } finally {
      await second.dispose();
    }
  });

  it("competing peer writers serialize exclusive root replacement", async () => {
    const root = await freshRoot();
    // Distinct selfPids simulate two OS processes; pid-only exclusive markers
    // treat same-pid instances as one holder (see createFsWorksetStore).
    const pidA = 9_100_001;
    const pidB = 9_100_002;
    const livePeers = new Set<number>([pidA, pidB]);
    const isPidAlive = (pid: number): boolean => {
      if (livePeers.has(pid)) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const a = createFsWorksetGuardedLedger({ root, selfPid: pidA, isPidAlive });
    const b = createFsWorksetGuardedLedger({ root, selfPid: pidB, isPidAlive });
    await a.init();
    await b.init();
    try {
      const m = await a.mutations.createMilestone({ title: "peer-m" });
      const t1 = await a.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "peer-1" },
      });
      // Peer must observe A's create via fresh read path / invalidate.
      b.invalidate(TASKS_LEDGER);
      b.invalidate(MILESTONES_LEDGER);
      const t2 = await b.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "peer-2" },
      });
      a.invalidate(TASKS_LEDGER);

      const results = await Promise.all([
        a.setRoots([`${TASKS_LEDGER}:${t1.id}`]),
        b.setRoots([`${TASKS_LEDGER}:${t2.id}`]),
      ]);
      const epochs = results.map((r) => r.epoch).sort((x, y) => x - y);
      expect(epochs).toEqual([1, 2]);

      const reader = createFsWorksetGuardedLedger({ root });
      await reader.init();
      try {
        const final = await reader.snapshotRoots();
        expect(final.epoch).toBe(2);
        expect(final.roots.length).toBe(1);
        expect(
          final.roots[0] === `${TASKS_LEDGER}:${t1.id}` ||
            final.roots[0] === `${TASKS_LEDGER}:${t2.id}`,
        ).toBe(true);
      } finally {
        await reader.dispose();
      }
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it("persists in-graph update and denies excluded target before durable change", async () => {
    const root = await freshRoot();
    const ledger = createFsWorksetGuardedLedger({ root });
    await ledger.init();
    try {
      const m = await ledger.mutations.createMilestone({ title: "upd-m" });
      const inside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "inside" },
      });
      const outside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "outside" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${inside.id}`]);

      await ledger.mutations.updateItem(TASKS_LEDGER, inside.id, {
        status: "wip",
        fields: { headline: "inside-updated" },
      });

      const beforeOut = ledger.fetchItem(TASKS_LEDGER, outside.id);
      const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
      const beforeDisk = await fs.readFile(tasksPath, "utf8");

      await expect(
        ledger.mutations.updateItem(TASKS_LEDGER, outside.id, { status: "wip" }),
      ).rejects.toMatchObject({ code: "target-excluded" });

      expect(ledger.fetchItem(TASKS_LEDGER, outside.id)).toEqual(beforeOut);
      expect(await fs.readFile(tasksPath, "utf8")).toBe(beforeDisk);
      expect(ledger.fetchItem(TASKS_LEDGER, inside.id).fields.headline).toBe(
        "inside-updated",
      );
    } finally {
      await ledger.dispose();
    }
  });

  it("rejects excluded introduced closure refs with zero durable mutation", async () => {
    const root = await freshRoot();
    const ledger = createFsWorksetGuardedLedger({ root });
    await ledger.init();
    try {
      const m = await ledger.mutations.createMilestone({ title: "dep-m" });
      const inside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "in" },
      });
      const outside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "out" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${inside.id}`]);
      const before = ledger.fetchItem(TASKS_LEDGER, inside.id);
      const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
      const beforeDisk = await fs.readFile(tasksPath, "utf8");

      await expect(
        ledger.mutations.updateItem(TASKS_LEDGER, inside.id, {
          fields: { dependsOn: [`${TASKS_LEDGER}:${outside.id}`] },
        }),
      ).rejects.toMatchObject({ code: "introduced-ref-excluded" });

      expect(ledger.fetchItem(TASKS_LEDGER, inside.id)).toEqual(before);
      expect(await fs.readFile(tasksPath, "utf8")).toBe(beforeDisk);
    } finally {
      await ledger.dispose();
    }
  });

  it("exact inactive-root unarchive survives reopen; non-root stays archived", async () => {
    const root = await freshRoot();
    const ledger = createFsWorksetGuardedLedger({ root });
    await ledger.init();
    let milestoneId: string;
    let keepId: string;
    let otherId: string;
    try {
      const m = await ledger.mutations.createMilestone({ title: "arch-fs" });
      milestoneId = m.id;
      const keep = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "keep-root" },
      });
      keepId = keep.id;
      const other = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "other" },
      });
      otherId = other.id;
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      await ledger.mutations.archiveMilestone(m.id, "seed");
      await ledger.setRoots([`${TASKS_LEDGER}:${keep.id}`]);
      const restored = await ledger.mutations.unarchiveItem(
        TASKS_LEDGER,
        m.id,
        keep.id,
      );
      expect(restored.id).toBe(keep.id);
      await expect(
        ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, other.id),
      ).rejects.toMatchObject({ code: "unarchive-not-exact-inactive-root" });
    } finally {
      await ledger.dispose();
    }

    const reopened = createFsWorksetGuardedLedger({ root });
    await reopened.init();
    try {
      expect(reopened.fetchItem(TASKS_LEDGER, keepId).id).toBe(keepId);
      expect(() => reopened.fetchItem(TASKS_LEDGER, otherId)).toThrow();
      // other remains only in the group archive
      const arch = await reopened.fetchArchive(TASKS_LEDGER, milestoneId);
      expect(arch.kind).toBe("group");
      if (arch.kind === "group") {
        expect(arch.milestone.items.some((it) => it.id === otherId)).toBe(true);
        expect(arch.milestone.items.some((it) => it.id === keepId)).toBe(false);
      }
    } finally {
      await reopened.dispose();
    }
  });

  it("full-sweep archive commits durably under explicit admitted roots", async () => {
    const root = await freshRoot();
    const ledger = createFsWorksetGuardedLedger({ root });
    await ledger.init();
    let milestoneId: string;
    let taskA: string;
    let taskB: string;
    try {
      const m = await ledger.mutations.createMilestone({ title: "sweep-fs" });
      milestoneId = m.id;
      const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "a" },
      });
      const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "b" },
      });
      taskA = a.id;
      taskB = b.id;
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${m.id}`,
        `${TASKS_LEDGER}:${a.id}`,
        `${TASKS_LEDGER}:${b.id}`,
      ]);
      const ptr = await ledger.mutations.archiveMilestone(m.id, "full-sweep");
      expect(ptr.id).toBe(m.id);
      expect(() => ledger.fetchItem(MILESTONES_LEDGER, m.id)).toThrow();
    } finally {
      await ledger.dispose();
    }

    const reader = createFsWorksetGuardedLedger({ root });
    await reader.init();
    try {
      expect(() => reader.fetchItem(MILESTONES_LEDGER, milestoneId)).toThrow();
      expect(() => reader.fetchItem(TASKS_LEDGER, taskA)).toThrow();
      expect(() => reader.fetchItem(TASKS_LEDGER, taskB)).toThrow();
      const arch = await reader.fetchArchive(MILESTONES_LEDGER, milestoneId);
      expect(arch.kind).toBe("item");
      if (arch.kind === "item") {
        expect(arch.item.id).toBe(milestoneId);
      }
    } finally {
      await reader.dispose();
    }
  });
});
