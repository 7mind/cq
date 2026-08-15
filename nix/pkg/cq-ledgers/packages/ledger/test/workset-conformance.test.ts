import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
  readCanonicalOwnership,
} from "../src/index.js";

const LEDGER_TEST_ROOT = import.meta.dir;
const PROCESS_TEST_ROOT = join(import.meta.dir, "..", "..", "process-control", "test");

describe("T1988 workset conformance acceptance inventory [Contract-Active Whitebox-Atomic]", () => {
  test("publishes every bounded conformance leg named by the task", async () => {
    const paths = [
      join(LEDGER_TEST_ROOT, "workset-command-conformance.test.ts"),
      join(LEDGER_TEST_ROOT, "workset-authority-conformance.test.ts"),
      join(LEDGER_TEST_ROOT, "workset-plan-lifecycle-conformance.test.ts"),
      join(LEDGER_TEST_ROOT, "workset-generic-mutation-conformance.test.ts"),
      join(LEDGER_TEST_ROOT, "workset-revocation-conformance.test.ts"),
      join(PROCESS_TEST_ROOT, "worksetEffectConformance.test.ts"),
    ];
    const missing: string[] = [];
    for (const path of paths) {
      try {
        await access(path);
      } catch {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  test("documents authority closure and the I25/G159 visual exclusion", async () => {
    const readme = await readFile(
      join(import.meta.dir, "..", "..", "..", "..", "..", "..", "README.md"),
      "utf8",
    );
    expect(readme.replace(/\s+/g, " ")).toContain(
      "UI visibility never expands workset authority. In the workset manager, `ideas:I25` and `goals:G159` remain visually excluded unless the configured roots close over them.",
    );
  });
});

const OWNER_FENCE = "t1988-owner-fence-0001";
const PROVENANCE = { author: "T1988", session: "T1988-conformance" } as const;

describe("T1988 bounded two-branch domain scenario [Behavioral-Active Blackbox-Atomic]", () => {
  test("retains only the selected branch's current finalized manifest and owned effects", async () => {
    const store = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    });
    await store.init();
    try {
      const selectedIdea = await store.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "selected branch" },
        ...PROVENANCE,
      });
      const siblingIdea = await store.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "sibling branch" },
        ...PROVENANCE,
      });
      const selected = await store.bundles.bootstrapIdeaToGoal({
        ideaId: selectedIdea.id,
        goal: { title: "selected goal", description: "selected" },
        consumeIdea: false,
      });
      const sibling = await store.bundles.bootstrapIdeaToGoal({
        ideaId: siblingIdea.id,
        goal: { title: "sibling goal", description: "sibling" },
        consumeIdea: false,
      });

      const siblingClaim = await store.claimPlan({
        goalId: sibling.goal.id,
        purpose: "initial",
        claimRequestId: "sibling-claim",
        ownerFenceToken: OWNER_FENCE,
        expectedGeneration: null,
        ...PROVENANCE,
      });
      if (!siblingClaim.ok) throw new Error("sibling claim failed");
      const siblingDraft = await store.publishPlanDraft({
        goalId: sibling.goal.id,
        claimId: siblingClaim.acknowledgement.claimId,
        generation: siblingClaim.acknowledgement.generation,
        operationId: "sibling-draft",
        ownerFenceToken: OWNER_FENCE,
        manifest: {
          milestones: [{ key: "sibling", title: "sibling milestone" }],
          tasks: [{ key: "sibling-task", milestoneKey: "sibling", headline: "sibling task" }],
        },
        ...PROVENANCE,
      });
      if (!siblingDraft.ok) throw new Error("sibling draft failed");

      await store.setRoots([`${IDEAS_LEDGER}:${selectedIdea.id}`]);
      const selectedClaim = await store.claimPlan({
        goalId: selected.goal.id,
        purpose: "initial",
        claimRequestId: "selected-claim",
        ownerFenceToken: OWNER_FENCE,
        expectedGeneration: null,
        ...PROVENANCE,
      });
      if (!selectedClaim.ok) throw new Error("selected claim failed");
      const firstDraft = await store.publishPlanDraft({
        goalId: selected.goal.id,
        claimId: selectedClaim.acknowledgement.claimId,
        generation: selectedClaim.acknowledgement.generation,
        operationId: "selected-draft-1",
        ownerFenceToken: OWNER_FENCE,
        manifest: {
          milestones: [{ key: "delivery", title: "first milestone" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "first task" }],
        },
        ...PROVENANCE,
      });
      if (!firstDraft.ok) throw new Error("first selected draft failed");
      await store.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: selected.goal.id },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "R1988",
          status: "revise",
          fields: {
            [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
              goalId: selected.goal.id,
              claimId: selectedClaim.acknowledgement.claimId,
              generation: selectedClaim.acknowledgement.generation,
              revision: firstDraft.acknowledgement.manifest.revision,
            }),
          },
          ...PROVENANCE,
        },
      });
      const secondDraft = await store.publishPlanDraft({
        goalId: selected.goal.id,
        claimId: selectedClaim.acknowledgement.claimId,
        generation: selectedClaim.acknowledgement.generation,
        operationId: "selected-draft-2",
        ownerFenceToken: OWNER_FENCE,
        manifest: {
          milestones: [{ key: "delivery", title: "current milestone" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "current task" }],
        },
        ...PROVENANCE,
      });
      if (!secondDraft.ok) throw new Error("second selected draft failed");
      await store.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: selected.goal.id },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "R1989",
          status: "go-ahead",
          fields: {
            [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
              goalId: selected.goal.id,
              claimId: selectedClaim.acknowledgement.claimId,
              generation: selectedClaim.acknowledgement.generation,
              revision: secondDraft.acknowledgement.manifest.revision,
            }),
          },
          ...PROVENANCE,
        },
      });
      const finalized = await store.finalizePlan({
        goalId: selected.goal.id,
        claimId: selectedClaim.acknowledgement.claimId,
        generation: selectedClaim.acknowledgement.generation,
        operationId: "selected-finalize",
        ownerFenceToken: OWNER_FENCE,
        reviewId: "R1989",
        draftRevision: secondDraft.acknowledgement.manifest.revision,
        decision: { headline: "ship selected branch" },
        reviewDefects: {
          reviewId: "R1989",
          defects: [{ key: "boundary", headline: "retain boundary proof", severity: "low" }],
        },
        ...PROVENANCE,
      });
      if (!finalized.ok) throw new Error("selected finalize failed");
      const selectedTask = finalized.acknowledgement.manifest.tasks[0];
      const siblingTask = siblingDraft.acknowledgement.manifest.tasks[0];
      const staleTask = firstDraft.acknowledgement.manifest.tasks[0];
      const reviewDefect = finalized.acknowledgement.reviewDefects[0];
      if (
        selectedTask === undefined ||
        siblingTask === undefined ||
        staleTask === undefined ||
        reviewDefect === undefined
      ) {
        throw new Error("bounded scenario allocation missing");
      }
      await store.mutations.updateItem(TASKS_LEDGER, selectedTask.id, { status: "wip" });
      await store.mutations.updateItem(TASKS_LEDGER, selectedTask.id, {
        status: "done",
        fields: { resultCommit: "0123456789abcdef0123456789abcdef01234567" },
      });

      const graph = closeWorkset(
        [`${IDEAS_LEDGER}:${selectedIdea.id}`],
        buildActiveStateFromLedgerStore(store),
      );
      const refs = new Set(graph.nodes.map(({ ref }) => ref));
      expect(refs.has(`${GOALS_LEDGER}:${selected.goal.id}`)).toBe(true);
      expect(refs.has(`${TASKS_LEDGER}:${selectedTask.id}`)).toBe(true);
      expect(refs.has(`${DEFECTS_LEDGER}:${reviewDefect.id}`)).toBe(true);
      expect(refs.has(`${GOALS_LEDGER}:${sibling.goal.id}`)).toBe(false);
      expect(refs.has(`${TASKS_LEDGER}:${siblingTask.id}`)).toBe(false);
      expect(refs.has(`${TASKS_LEDGER}:${staleTask.id}`)).toBe(false);
      expect(refs.has("ideas:I25")).toBe(false);
      expect(refs.has("goals:G159")).toBe(false);
      expect(readCanonicalOwnership(store.fetchItem(TASKS_LEDGER, selectedTask.id))).toEqual({
        ownerRef: `${GOALS_LEDGER}:${selected.goal.id}`,
        edgeKind: "finalized-manifest",
      });
      expect(finalized.acknowledgement.manifest).toEqual(
        secondDraft.acknowledgement.manifest,
      );
      expect(store.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});
