/**
 * T1976 — canonical ownership survives destructive filesystem backup/reset.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox for the lifecycle
 * write, with one Effectual / Good-Communication assertion at the FS archive
 * boundary that a reset backup remains structurally complete.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  parseMilestoneItemArchive,
  readCanonicalOwnership,
  worksetMemberRefSet,
} from "../src/index.js";

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
    } finally {
      await store.dispose();
    }
  });
});
