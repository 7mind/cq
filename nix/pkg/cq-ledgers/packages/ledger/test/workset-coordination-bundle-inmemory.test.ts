/**
 * T1962 — in-memory focused leg for coordination bundles.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryWorksetOwnedGuardedLedger,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
  WorksetOwnedLifecycleError,
  readCanonicalOwnership,
  IDEAS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
} from "../src/index.js";

describe("workset coordination-bundle in-memory focused [T1962]", () => {
  it("consumeIdea:false leaves the idea open", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "keep-open" },
    });
    const result = await ledger.bundles.bootstrapIdeaToGoal({
      ideaId: idea.id,
      goal: { title: "g", description: "d" },
      consumeIdea: false,
    });
    expect(result.idea.status).toBe("open");
    expect(readCanonicalOwnership(result.goal)?.edgeKind).toBe("idea-to-goal");
  });

  it("defect fix-goal + subsequent research under defect owner", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const defect = await ledger.owned.createOwnerless({
      ledgerId: DEFECTS_LEDGER,
      status: "open",
      fields: { headline: "bug", severity: "low" },
    });
    const boot = await ledger.bundles.bootstrapDefectToFixGoal({
      defectId: defect.id,
      goal: { title: "fix-it", description: "plan" },
    });
    expect(readCanonicalOwnership(boot.goal)?.ownerRef).toBe(
      `${DEFECTS_LEDGER}:${defect.id}`,
    );
    const research = await ledger.owned.createOwned({
      owner: { ledgerId: DEFECTS_LEDGER, itemId: defect.id },
      creationKind: "research",
      child: {
        ledgerId: "researches",
        status: "open",
        fields: { question: "why?" },
      },
    });
    expect(readCanonicalOwnership(research.child)?.edgeKind).toBe("research");
  });

  it("missing owner for bundle is owner-not-found", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const before = ledger.fetch(GOALS_LEDGER).counters.item;
    try {
      await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: "I99999",
        goal: { title: "x", description: "y" },
      });
      throw new Error("expected owner-not-found");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetOwnedLifecycleError);
      expect((error as WorksetOwnedLifecycleError).code).toBe("owner-not-found");
    }
    expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
  });

  it("guarded draft lifecycle under restrictive goal root succeeds", async () => {
    const ledger = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    });
    await ledger.init();
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "root-idea" },
    });
    const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
      ideaId: idea.id,
      goal: { title: "root-goal", description: "x" },
    });
    await ledger.setRoots([`${GOALS_LEDGER}:${goal.id}`]);
    const claim = await ledger.claimPlan({
      goalId: goal.id,
      purpose: "initial",
      claimRequestId: "t2096-rooted-claim",
      ownerFenceToken: "aaaaaaaaaaaaaaaaaaaaaa",
      expectedGeneration: null,
      author: "T2096",
      session: "T2096-rooted-lifecycle",
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.conflict.code}`);
    const draft = await ledger.publishPlanDraft({
      goalId: goal.id,
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "t2096-rooted-publish",
      ownerFenceToken: claim.acknowledgement.ownerFenceToken,
      author: "T2096",
      session: "T2096-rooted-lifecycle",
      manifest: {
        milestones: [{ key: "rooted", title: "rooted-ms" }],
        tasks: [{ key: "rooted-task", milestoneKey: "rooted", headline: "rooted-task" }],
      },
    });
    if (!draft.ok) throw new Error(`publish failed: ${draft.conflict.code}`);
    const milestoneId = draft.acknowledgement.manifest.milestones[0]!.id;
    const taskId = draft.acknowledgement.manifest.tasks[0]!.id;
    expect(ledger.fetchItem(TASKS_LEDGER, taskId).milestoneId).toBe(
      milestoneId,
    );
    expect(ledger.fetchItem(MILESTONES_LEDGER, milestoneId).fields.title).toBe(
      "rooted-ms",
    );
  });
});
