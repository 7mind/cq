import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ARCHIVE_COMMIT_PENDING_FILENAME,
  FsLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "fs-archive-atomicity-"));
  dirs.push(root);
  return root;
}

async function seedTerminalMilestone(
  store: FsLedgerStore,
): Promise<{ milestoneId: string; taskId: string }> {
  const milestone = await store.createMilestone({ title: "archive atomicity" });
  const task = await store.createItem(TASKS_LEDGER, milestone.id, {
    status: "done",
    fields: { headline: "terminal task" },
  });
  await store.updateMilestone(milestone.id, { status: "done" });
  return { milestoneId: milestone.id, taskId: task.id };
}

describe("filesystem archive commit atomicity [D302]", () => {
  it("rejects a pending marker whose ledger name escapes the storage boundary", async () => {
    const root = await freshRoot();
    const storageDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const escapedName = `${path.basename(root)}-outside`;
    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, ARCHIVE_COMMIT_PENDING_FILENAME),
      JSON.stringify({
        version: 1,
        archives: {},
        ledgers: { [`../../${escapedName}`]: "must not be written" },
      }),
    );

    const store = new FsLedgerStore({ root });
    await expect(store.init()).rejects.toThrow(/invalid pending archive commit/);
    await expect(
      fs.stat(path.join(root, "..", `${escapedName}.md`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await store.dispose();
  });

  it("restores the complete pre-state after a late archive write fails", async () => {
    const root = await freshRoot();
    let failNextMilestonesWrite = false;
    const store = new FsLedgerStore({
      root,
      atomicWrite: async (filePath, text) => {
        if (
          failNextMilestonesWrite &&
          filePath.endsWith(`${MILESTONES_LEDGER}.md`)
        ) {
          failNextMilestonesWrite = false;
          throw new Error("injected late archive-sweep failure");
        }
        await atomicWrite(filePath, text);
      },
    });
    await store.init();
    try {
      const seeded = await seedTerminalMilestone(store);
      failNextMilestonesWrite = true;
      await expect(
        store.archiveMilestone(seeded.milestoneId, "must roll back"),
      ).rejects.toThrow(/injected late archive-sweep failure/);

      const peer = new FsLedgerStore({ root });
      await peer.init();
      try {
        expect(peer.fetchItem(MILESTONES_LEDGER, seeded.milestoneId).id).toBe(
          seeded.milestoneId,
        );
        expect(peer.fetchItem(TASKS_LEDGER, seeded.taskId).id).toBe(seeded.taskId);
      } finally {
        await peer.dispose();
      }

      for (const ledgerId of [TASKS_LEDGER, MILESTONES_LEDGER]) {
        const archivePath = path.join(
          root,
          LEDGER_STORAGE_DIRNAME,
          "archive",
          ledgerId,
          `${seeded.milestoneId}.md`,
        );
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await store.dispose();
    }
  });

  it("restart finishes an interrupted rollback before exposing ledger state", async () => {
    const root = await freshRoot();
    let injectFailure = false;
    let rollingBack = false;
    const store = new FsLedgerStore({
      root,
      atomicWrite: async (filePath, text) => {
        if (
          injectFailure &&
          !rollingBack &&
          filePath.endsWith(`${MILESTONES_LEDGER}.md`)
        ) {
          rollingBack = true;
          throw new Error("injected archive commit interruption");
        }
        if (rollingBack && filePath.endsWith(`${TASKS_LEDGER}.md`)) {
          rollingBack = false;
          throw new Error("injected rollback interruption");
        }
        await atomicWrite(filePath, text);
      },
    });
    await store.init();
    const seeded = await seedTerminalMilestone(store);
    injectFailure = true;
    await expect(
      store.archiveMilestone(seeded.milestoneId, "must recover"),
    ).rejects.toThrow(/archive commit failed.*rollback did not complete/);
    expect(() => store.fetchItem(TASKS_LEDGER, seeded.taskId)).toThrow(
      /requires restart to recover an interrupted archive commit/,
    );
    await store.dispose();

    const recovered = new FsLedgerStore({ root });
    await recovered.init();
    try {
      expect(recovered.fetchItem(MILESTONES_LEDGER, seeded.milestoneId).id).toBe(
        seeded.milestoneId,
      );
      expect(recovered.fetchItem(TASKS_LEDGER, seeded.taskId).id).toBe(seeded.taskId);
      await expect(
        fs.stat(path.join(root, LEDGER_STORAGE_DIRNAME, "archive-commit.pending.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await recovered.dispose();
    }
  });

  it("restores the archived item when the active-ledger unarchive write fails", async () => {
    const root = await freshRoot();
    let failNextTasksWrite = false;
    const store = new FsLedgerStore({
      root,
      atomicWrite: async (filePath, text) => {
        if (failNextTasksWrite && filePath.endsWith(`${TASKS_LEDGER}.md`)) {
          failNextTasksWrite = false;
          throw new Error("injected unarchive ledger failure");
        }
        await atomicWrite(filePath, text);
      },
    });
    await store.init();
    try {
      const seeded = await seedTerminalMilestone(store);
      await store.archiveMilestone(seeded.milestoneId, "seed archive");

      failNextTasksWrite = true;
      await expect(
        store.unarchiveItem(TASKS_LEDGER, seeded.milestoneId, seeded.taskId),
      ).rejects.toThrow(/injected unarchive ledger failure/);

      const peer = new FsLedgerStore({ root });
      await peer.init();
      try {
        expect(() => peer.fetchItem(TASKS_LEDGER, seeded.taskId)).toThrow();
        const archived = await peer.fetchArchive(TASKS_LEDGER, seeded.milestoneId);
        expect(archived.kind).toBe("group");
        if (archived.kind === "group") {
          expect(archived.milestone.items.map((item) => item.id)).toContain(
            seeded.taskId,
          );
        }
      } finally {
        await peer.dispose();
      }
    } finally {
      await store.dispose();
    }
  });
});
