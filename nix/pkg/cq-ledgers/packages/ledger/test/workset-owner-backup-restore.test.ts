/**
 * T1976 — canonical ownership survives destructive filesystem backup/reset.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox for the lifecycle
 * write, with one Effectual / Good-Communication assertion at the FS archive
 * boundary that a reset backup remains structurally complete.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  SqliteLedgerStore,
  TASKS_LEDGER,
  buildActiveStateFromLedgerStore,
  buildBackupDump,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  parseMilestoneItemArchive,
  readCanonicalOwnership,
  restoreDumpToXdg,
  serializeWorksetRootsDocument,
  worksetMemberRefSet,
} from "../src/index.js";
import { FsPersistence } from "../src/store/FsPersistence.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("workset owner backup/restore [T1976]", () => {
  it("FS reset copies owned archived items before clearing the live archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workset-owner-reset-"));
    roots.push(root);
    const authority = createTrustedWorksetManagementAuthority();
    const rawStore = new FsLedgerStore({
      root,
      now: () => "2026-08-13T18:00:00.000Z",
      worksetAuthority: authority,
    });
    const worksetStore = rawStore.createWorksetStore({
      isTargetAdmitted: (target, selectedRoots) => {
        if (selectedRoots.length === 0) return true;
        const graph = closeWorkset(selectedRoots, buildActiveStateFromLedgerStore(rawStore));
        return (
          worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target)
        );
      },
    });
    const store = createWorksetGuardedPlanLifecycleStore({
      rawStore,
      worksetStore,
      invocationAuthority: authority,
      runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      runPlanLifecycleTransaction: (goalId, mutate) =>
        rawStore.runAtomicWorksetPlanLifecycleMutation(goalId, mutate),
    });

    try {
      await store.init();
      await store.owned.createOwnerless({
        ledgerId: GOALS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "G1",
        status: "clarifying",
        fields: { title: "Deliver", description: "Deliver the workset" },
        author: "T1976",
        session: "owner-backup",
      });
      const claimed = await store.claimPlan({
        goalId: "G1",
        purpose: "initial",
        claimRequestId: "claim-1",
        ownerFenceToken: "aaaaaaaaaaaaaaaaaaaaaa",
        expectedGeneration: null,
        author: "T1976",
        session: "owner-backup",
      });
      if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
      const published = await store.publishPlanDraft({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "publish-1",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
        },
        author: "T1976",
        session: "owner-backup",
      });
      if (!published.ok) throw new Error(`publish failed: ${published.conflict.code}`);
      const milestoneId = published.acknowledgement.manifest.milestones[0]?.id;
      const taskId = published.acknowledgement.manifest.tasks[0]?.id;
      if (milestoneId === undefined || taskId === undefined) throw new Error("manifest incomplete");
      await store.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: "G1" },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "R1",
          status: "go-ahead",
          fields: {
            [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
              goalId: "G1",
              claimId: claimed.acknowledgement.claimId,
              generation: claimed.acknowledgement.generation,
              revision: published.acknowledgement.manifest.revision,
            }),
          },
          author: "T1976",
          session: "owner-backup",
        },
      });
      const finalized = await store.finalizePlan({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "finalize-1",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        reviewId: "R1",
        draftRevision: published.acknowledgement.manifest.revision,
        decision: { headline: "Proceed" },
        author: "T1976",
        session: "owner-backup",
      });
      if (!finalized.ok) throw new Error(`finalize failed: ${finalized.conflict.code}`);
      await store.mutations.updateItem(TASKS_LEDGER, taskId, { status: "done" });
      await store.mutations.updateItem(MILESTONES_LEDGER, milestoneId, { status: "done" });
      const pointer = await store.mutations.archiveMilestone(milestoneId, "completed delivery");
      const portableDump = await buildBackupDump(rawStore, null);

      const summary = await rawStore.reset();
      const backedArchivePath = path.join(summary.backupDir, pointer.path.replace(/^\.\//, ""));
      const archived = parseMilestoneItemArchive(await readFile(backedArchivePath, "utf8"));
      expect(readCanonicalOwnership(archived)).toEqual({
        ownerRef: "goals:G1",
        edgeKind: "finalized-manifest",
      });
      await expect(
        stat(path.join(root, ".cq", pointer.path.replace(/^\.\//, ""))),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const restoreDir = path.join(root, "restored");
      await mkdir(restoreDir, { recursive: true });
      const dbPath = path.join(restoreDir, "ledger.db");
      await restoreDumpToXdg({
        dbPath,
        logsDir: null,
        dump: portableDump,
        authority,
        overwriteAuthorized: false,
      });
      const restored = new SqliteLedgerStore({ dbPath });
      await restored.init();
      try {
        expect(readCanonicalOwnership(restored.fetchItem(REVIEWS_LEDGER, "R1"))).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "review",
        });
        const milestoneArchive = await restored.fetchArchive(MILESTONES_LEDGER, pointer.id);
        if (milestoneArchive.kind !== "item") throw new Error("milestone archive kind mismatch");
        expect(readCanonicalOwnership(milestoneArchive.item)).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "finalized-manifest",
        });
        const restoredTasks = await restored.fetchArchive(TASKS_LEDGER, pointer.id);
        if (restoredTasks.kind !== "group") throw new Error("task archive kind mismatch");
        const restoredTask = restoredTasks.milestone.items.find(({ id }) => id === taskId);
        if (restoredTask === undefined) throw new Error("restored archived task missing");
        expect(readCanonicalOwnership(restoredTask)).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "finalized-manifest",
        });
      } finally {
        await restored.dispose();
      }
    } finally {
      await store.dispose();
    }
  });

  async function persistenceFixture(prefix: string, timestamp: string) {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    const docsDir = path.join(root, ".cq");
    const archiveDir = path.join(docsDir, "archive");
    const archivePath = path.join(archiveDir, TASKS_LEDGER, "M1.md");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, "sealed archive bytes", "utf8");
    const backupDir = path.join(docsDir, ".backup", timestamp.replace(/:/g, "-"));
    return {
      root,
      docsDir,
      archiveDir,
      archivePath,
      backupDir,
      persistence: new FsPersistence({
        layout: {
          root,
          docsDir,
          archiveDir,
          registryPath: path.join(docsDir, "ledgers.yaml"),
        },
        now: () => timestamp,
      }),
    };
  }

  it("FS archive copy failure keeps the live payload recoverable for an exact retry", async () => {
    const fixture = await persistenceFixture(
      "workset-owner-copy-failure-",
      "2026-08-13T18:30:00.000Z",
    );
    await mkdir(fixture.backupDir, { recursive: true });
    const backupArchivePath = path.join(fixture.backupDir, "archive");
    await writeFile(backupArchivePath, "destination collision", "utf8");

    await expect(fixture.persistence.backupCanonicalState()).rejects.toThrow();
    expect(await readFile(fixture.archivePath, "utf8")).toBe("sealed archive bytes");

    await rm(backupArchivePath);
    await fixture.persistence.backupCanonicalState();
    expect(
      await readFile(path.join(fixture.backupDir, "archive", TASKS_LEDGER, "M1.md"), "utf8"),
    ).toBe("sealed archive bytes");
    await expect(stat(fixture.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("FS late backup failure retains both copied and live archive payloads until retry", async () => {
    const fixture = await persistenceFixture(
      "workset-owner-late-failure-",
      "2026-08-13T18:45:00.000Z",
    );
    const rootsDir = path.join(fixture.docsDir, "workset");
    const rootsPath = path.join(rootsDir, "roots.json");
    await mkdir(rootsDir, { recursive: true });
    await writeFile(
      rootsPath,
      JSON.stringify({ version: 1, roots: [42], epoch: 1, admitGeneration: 1 }),
      "utf8",
    );

    await expect(fixture.persistence.backupCanonicalState()).rejects.toThrow(
      /roots members must be non-empty strings/,
    );
    const backupArchive = path.join(
      fixture.backupDir,
      "archive",
      TASKS_LEDGER,
      "M1.md",
    );
    expect(await readFile(backupArchive, "utf8")).toBe("sealed archive bytes");
    expect(await readFile(fixture.archivePath, "utf8")).toBe("sealed archive bytes");

    await writeFile(
      rootsPath,
      serializeWorksetRootsDocument({ roots: ["goals:G1"], epoch: 1 }),
      "utf8",
    );
    await fixture.persistence.backupCanonicalState();
    expect(await readFile(backupArchive, "utf8")).toBe("sealed archive bytes");
    await expect(stat(fixture.archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
