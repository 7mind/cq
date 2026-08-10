/**
 * T1972 — filesystem fault / race focused suite for guarded generic mutations.
 *
 * Effectual Good-Communication cases outside the shared Blackbox contract:
 * injected ledger write/rename failures, workset roots write failures under
 * replacement races, and proof that excluded targets fail before I/O.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createFsWorksetGuardedLedger,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  LEDGER_STORAGE_DIRNAME,
  WorksetGenericMutationError,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-generic-mut-fs-fault-"));
  dirs.push(dir);
  return dir;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function seedTwoTasks(
  ledger: WorksetGuardedLedger,
): Promise<{ milestoneId: string; inside: string; outside: string }> {
  const m = await ledger.mutations.createMilestone({ title: "fault-m" });
  const inside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
    status: "planned",
    fields: { headline: "inside" },
  });
  const outside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
    status: "planned",
    fields: { headline: "outside" },
  });
  return { milestoneId: m.id, inside: inside.id, outside: outside.id };
}

describe("workset generic-mutation filesystem faults [T1972]", () => {
  it("injected ledger write failure preserves prior item state and drains admission", async () => {
    const root = await freshRoot();
    let failNextTasksWrite = false;
    const ledger = createFsWorksetGuardedLedger({
      root,
      ledgerAtomicWrite: async (filePath, text) => {
        if (failNextTasksWrite && filePath.endsWith(`${TASKS_LEDGER}.md`)) {
          failNextTasksWrite = false;
          throw new Error("injected ledger write failure");
        }
        await atomicWrite(filePath, text);
      },
    });
    await ledger.init();
    try {
      const { inside } = await seedTwoTasks(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${inside}`]);
      const before = ledger.fetchItem(TASKS_LEDGER, inside);
      const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
      const beforeDisk = await fs.readFile(tasksPath, "utf8");

      failNextTasksWrite = true;
      await expect(
        ledger.mutations.updateItem(TASKS_LEDGER, inside, {
          status: "wip",
          fields: { headline: "should-not-land" },
        }),
      ).rejects.toThrow(/injected ledger write failure/);

      expect(ledger.fetchItem(TASKS_LEDGER, inside)).toEqual(before);
      expect(await fs.readFile(tasksPath, "utf8")).toBe(beforeDisk);
      expect(ledger.activeAdmissionCount()).toBe(0);

      // Recovery: subsequent admitted write succeeds.
      const updated = await ledger.mutations.updateItem(TASKS_LEDGER, inside, {
        status: "wip",
        fields: { headline: "recovered" },
      });
      expect(updated.fields.headline).toBe("recovered");
      expect(ledger.fetchItem(TASKS_LEDGER, inside).fields.headline).toBe("recovered");
    } finally {
      await ledger.dispose();
    }
  });

  it("injected ledger rename failure leaves prior durable content intact", async () => {
    const root = await freshRoot();
    let failRename = false;
    const ledger = createFsWorksetGuardedLedger({
      root,
      ledgerAtomicWrite: async (filePath, text) => {
        if (failRename && filePath.endsWith(`${TASKS_LEDGER}.md`)) {
          failRename = false;
          // Simulate tmp written but rename failing: do nothing to dest.
          throw Object.assign(new Error("injected rename EXDEV"), { code: "EXDEV" });
        }
        await atomicWrite(filePath, text);
      },
    });
    await ledger.init();
    try {
      const { inside } = await seedTwoTasks(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${inside}`]);
      const before = ledger.fetchItem(TASKS_LEDGER, inside);
      const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
      const beforeDisk = await fs.readFile(tasksPath, "utf8");

      failRename = true;
      await expect(
        ledger.mutations.updateItem(TASKS_LEDGER, inside, {
          fields: { headline: "rename-should-not-land" },
        }),
      ).rejects.toThrow(/injected rename/);

      expect(ledger.fetchItem(TASKS_LEDGER, inside)).toEqual(before);
      expect(await fs.readFile(tasksPath, "utf8")).toBe(beforeDisk);

      const peer = createFsWorksetGuardedLedger({ root });
      await peer.init();
      try {
        expect(peer.fetchItem(TASKS_LEDGER, inside)).toEqual(before);
      } finally {
        await peer.dispose();
      }
    } finally {
      await ledger.dispose();
    }
  });

  it("injected roots write failure preserves prior epoch during replacement", async () => {
    const root = await freshRoot();
    let failNextRoots = false;
    const ledger = createFsWorksetGuardedLedger({
      root,
      worksetAtomicWrite: async (filePath, text) => {
        if (failNextRoots && filePath.endsWith("roots.json")) {
          failNextRoots = false;
          throw new Error("injected roots write failure");
        }
        await atomicWrite(filePath, text);
      },
    });
    await ledger.init();
    try {
      const { inside, outside } = await seedTwoTasks(ledger);
      const first = await ledger.setRoots([`${TASKS_LEDGER}:${inside}`]);
      expect(first).toEqual({ roots: [`${TASKS_LEDGER}:${inside}`], epoch: 1 });

      failNextRoots = true;
      await expect(
        ledger.setRoots([`${TASKS_LEDGER}:${outside}`]),
      ).rejects.toThrow(/injected roots write failure/);

      expect(await ledger.snapshotRoots()).toEqual(first);
      const peer = createFsWorksetGuardedLedger({ root });
      await peer.init();
      try {
        expect(await peer.snapshotRoots()).toEqual(first);
      } finally {
        await peer.dispose();
      }

      const recovered = await ledger.setRoots([`${TASKS_LEDGER}:${outside}`]);
      expect(recovered).toEqual({
        roots: [`${TASKS_LEDGER}:${outside}`],
        epoch: 2,
      });
    } finally {
      await ledger.dispose();
    }
  });

  it("setRoots waits behind an in-flight generic mutation; then replacement commits", async () => {
    const root = await freshRoot();
    const admitted = deferred();
    const releaseHold = deferred();
    let holdEnabled = false;
    const ledger = createFsWorksetGuardedLedger({
      root,
      afterGenericAdmit: async () => {
        if (!holdEnabled) return;
        admitted.resolve();
        await releaseHold.promise;
      },
    });
    await ledger.init();
    try {
      const { inside, outside } = await seedTwoTasks(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${inside}`]);

      holdEnabled = true;
      const mutPromise = ledger.mutations.updateItem(TASKS_LEDGER, inside, {
        fields: { headline: "held" },
      });
      await admitted.promise;
      expect(ledger.activeAdmissionCount()).toBeGreaterThan(0);

      let setDone = false;
      const setPromise = ledger
        .setRoots([`${TASKS_LEDGER}:${outside}`])
        .then((snap) => {
          setDone = true;
          return snap;
        });
      await new Promise((r) => setTimeout(r, 30));
      expect(setDone).toBe(false);

      releaseHold.resolve();
      await mutPromise;
      const setSnap = await setPromise;
      expect(setDone).toBe(true);
      expect(setSnap.roots).toEqual([`${TASKS_LEDGER}:${outside}`]);
      expect(ledger.activeAdmissionCount()).toBe(0);
      expect(ledger.fetchItem(TASKS_LEDGER, inside).fields.headline).toBe("held");
    } finally {
      await ledger.dispose();
    }
  });

  it("excluded target fails before ledger I/O (disk bytes unchanged)", async () => {
    const root = await freshRoot();
    let ledgerWriteCount = 0;
    const ledger = createFsWorksetGuardedLedger({
      root,
      ledgerAtomicWrite: async (filePath, text) => {
        if (filePath.endsWith(`${TASKS_LEDGER}.md`)) {
          ledgerWriteCount += 1;
        }
        await atomicWrite(filePath, text);
      },
    });
    await ledger.init();
    try {
      const { inside, outside } = await seedTwoTasks(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${inside}`]);
      const writesAfterSeed = ledgerWriteCount;
      const tasksPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${TASKS_LEDGER}.md`);
      const beforeDisk = await fs.readFile(tasksPath, "utf8");
      const beforeOut = ledger.fetchItem(TASKS_LEDGER, outside);

      await expect(
        ledger.mutations.updateItem(TASKS_LEDGER, outside, { status: "wip" }),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);

      expect(ledgerWriteCount).toBe(writesAfterSeed);
      expect(await fs.readFile(tasksPath, "utf8")).toBe(beforeDisk);
      expect(ledger.fetchItem(TASKS_LEDGER, outside)).toEqual(beforeOut);
    } finally {
      await ledger.dispose();
    }
  });

  it("archive-sweep denial leaves milestone files and on-disk archive absent", async () => {
    const root = await freshRoot();
    const ledger = createFsWorksetGuardedLedger({ root });
    await ledger.init();
    try {
      const m = await ledger.mutations.createMilestone({ title: "sweep-deny" });
      const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "a" },
      });
      const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "b" },
      });
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      await ledger.setRoots([`${TASKS_LEDGER}:${a.id}`]);

      const msPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${MILESTONES_LEDGER}.md`);
      const beforeMs = await fs.readFile(msPath, "utf8");
      const archivePath = path.join(
        root,
        LEDGER_STORAGE_DIRNAME,
        "archive",
        MILESTONES_LEDGER,
        `${m.id}.md`,
      );

      await expect(
        ledger.mutations.archiveMilestone(m.id, "should-fail"),
      ).rejects.toMatchObject({ code: "archive-sweep-incomplete" });

      expect(await fs.readFile(msPath, "utf8")).toBe(beforeMs);
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(ledger.fetchItem(MILESTONES_LEDGER, m.id).id).toBe(m.id);
      expect(ledger.fetchItem(TASKS_LEDGER, b.id).id).toBe(b.id);
    } finally {
      await ledger.dispose();
    }
  });
});
