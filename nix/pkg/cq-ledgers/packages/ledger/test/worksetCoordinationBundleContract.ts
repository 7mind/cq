/**
 * T1962 — parameterized Behavioral-Active Blackbox contract for coordination
 * bundles (atomic multi-item owner-scoped bootstraps).
 *
 * Scope:
 * - idea→goal and defect→fix-goal bootstraps seal ownership atomically
 * - draft/manifest bundles create milestone + tasks under one admission
 * - partial failure rolls back every item (zero partial state)
 * - excluded owner / policy denial produce zero mutation
 * - one owned-write admission held through commit
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetOwnedLifecycleError,
  readCanonicalOwnership,
  closeWorkset,
  buildActiveStateFromLedgerStore,
  worksetMemberRefSet,
  IDEAS_LEDGER,
  GOALS_LEDGER,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedLifecycleErrorCode,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
} from "../src/index.js";

export type WorksetCoordinationBundleContractClassification =
  | "Behavioral-Active Blackbox-Atomic"
  | "Behavioral-Active Blackbox-GoodCommunication";

export type WorksetCoordinationBundleContractBuildOptions =
  CreateInMemoryWorksetOwnedGuardedLedgerOptions;

export interface WorksetCoordinationBundleContractFactory {
  readonly name: string;
  readonly classification: WorksetCoordinationBundleContractClassification;
  build(
    options?: WorksetCoordinationBundleContractBuildOptions,
  ): WorksetOwnedGuardedLedger | Promise<WorksetOwnedGuardedLedger>;
}

async function expectOwnedRejection(
  promise: Promise<unknown>,
  code: WorksetOwnedLifecycleErrorCode,
): Promise<WorksetOwnedLifecycleError> {
  try {
    await promise;
    throw new Error(`expected WorksetOwnedLifecycleError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetOwnedLifecycleError);
    const ownedError = error as WorksetOwnedLifecycleError;
    expect(ownedError.code).toBe(code);
    return ownedError;
  }
}

function memberRefsForRoot(
  ledger: WorksetOwnedGuardedLedger,
  root: string,
): ReadonlySet<string> {
  const state = buildActiveStateFromLedgerStore(ledger);
  const graph = closeWorkset([root], state);
  return worksetMemberRefSet(graph);
}

export function runWorksetCoordinationBundleContract(
  factory: WorksetCoordinationBundleContractFactory,
): void {
  describe(`workset coordination-bundle contract [T1962] — ${factory.name} (${factory.classification})`, () => {
    it("bootstrapIdeaToGoal seals ownership and preserves the default live branch", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "bundle-idea" },
      });
      // Closure check while idea remains live (open).
      const openBoot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "boot-goal-open", description: "from idea bundle" },
        consumeIdea: false,
      });
      expect(openBoot.idea.status).toBe("open");
      const ownership = readCanonicalOwnership(openBoot.goal);
      expect(ownership).not.toBeNull();
      expect(ownership!.ownerRef).toBe(`${IDEAS_LEDGER}:${idea.id}`);
      expect(ownership!.edgeKind).toBe("idea-to-goal");
      const members = memberRefsForRoot(ledger, `${IDEAS_LEDGER}:${idea.id}`);
      expect(members.has(`${GOALS_LEDGER}:${openBoot.goal.id}`)).toBe(true);

      // Default behavior preserves the live owner branch in the workset.
      const idea2 = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "bundle-idea-2" },
      });
      const consumed = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea2.id,
        goal: { title: "boot-goal-consumed", description: "consume" },
      });
      expect(consumed.idea.status).toBe("open");
      expect(readCanonicalOwnership(consumed.goal)?.edgeKind).toBe("idea-to-goal");
      const defaultMembers = memberRefsForRoot(ledger, `${IDEAS_LEDGER}:${idea2.id}`);
      expect(defaultMembers.has(`${GOALS_LEDGER}:${consumed.goal.id}`)).toBe(true);
    });

    it("bootstrapDefectToFixGoal seals fix-goal ownership", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const defect = await ledger.owned.createOwnerless({
        ledgerId: DEFECTS_LEDGER,
        status: "open",
        fields: { headline: "root cause me", severity: "high" },
      });
      const result = await ledger.bundles.bootstrapDefectToFixGoal({
        defectId: defect.id,
        goal: { title: "fix", description: "address the defect" },
      });
      const ownership = readCanonicalOwnership(result.goal);
      expect(ownership).not.toBeNull();
      expect(ownership!.ownerRef).toBe(`${DEFECTS_LEDGER}:${defect.id}`);
      expect(ownership!.edgeKind).toBe("fix-goal");
      const members = memberRefsForRoot(ledger, `${DEFECTS_LEDGER}:${defect.id}`);
      expect(members.has(`${GOALS_LEDGER}:${result.goal.id}`)).toBe(true);
    });

    it("publishOwnedDraft creates milestone + tasks under one sealed edge", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "draft-idea" },
      });
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "draft-goal", description: "planning" },
      });
      const draft = await ledger.bundles.publishOwnedDraft({
        goalId: goal.id,
        creationKind: "active-current-draft",
        milestone: { title: "M-draft" },
        tasks: [{ headline: "T-a" }, { headline: "T-b" }],
      });
      expect(draft.tasks.length).toBe(2);
      const mOwn = readCanonicalOwnership(draft.milestone);
      expect(mOwn?.ownerRef).toBe(`${GOALS_LEDGER}:${goal.id}`);
      expect(mOwn?.edgeKind).toBe("active-current-draft");
      for (const task of draft.tasks) {
        const tOwn = readCanonicalOwnership(task);
        expect(tOwn?.ownerRef).toBe(`${GOALS_LEDGER}:${goal.id}`);
        expect(tOwn?.edgeKind).toBe("active-current-draft");
        expect(task.milestoneId).toBe(draft.milestone.id);
      }
      const members = memberRefsForRoot(ledger, `${GOALS_LEDGER}:${goal.id}`);
      expect(members.has(`${MILESTONES_LEDGER}:${draft.milestone.id}`)).toBe(true);
      expect(members.has(`${TASKS_LEDGER}:${draft.tasks[0]!.id}`)).toBe(true);
      expect(members.has(`${TASKS_LEDGER}:${draft.tasks[1]!.id}`)).toBe(true);
    });

    it("finalized-manifest draft requires planned/building goal phase", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "phase-idea" },
      });
      // Default clarifying goal — finalized-manifest denied.
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "phase-goal", description: "still clarifying" },
      });
      const beforeMs = ledger.fetch(MILESTONES_LEDGER).counters.item;
      const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.bundles.publishOwnedDraft({
          goalId: goal.id,
          creationKind: "finalized-manifest",
          milestone: { title: "too-early" },
          tasks: [{ headline: "nope" }],
        }),
        "owner-policy-denied",
      );
      expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMs);
      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);

      // Planned goal accepts finalized-manifest.
      const plannedIdea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "planned-idea" },
      });
      const planned = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: plannedIdea.id,
        goal: {
          title: "planned-goal",
          description: "ready",
          status: "planned",
        },
      });
      const ok = await ledger.bundles.publishOwnedDraft({
        goalId: planned.goal.id,
        creationKind: "finalized-manifest",
        milestone: { title: "final-ms" },
        tasks: [{ headline: "final-task" }],
      });
      expect(readCanonicalOwnership(ok.milestone)?.edgeKind).toBe("finalized-manifest");
    });

    it("empty task list is bundle-incomplete (zero mutation)", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "empty-tasks-idea" },
      });
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "empty-tasks-goal", description: "x" },
      });
      const beforeMs = ledger.fetch(MILESTONES_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.bundles.publishOwnedDraft({
          goalId: goal.id,
          creationKind: "active-current-draft",
          milestone: { title: "no-tasks" },
          tasks: [],
        }),
        "bundle-incomplete",
      );
      expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMs);
    });

    it("excluded owner under restrictive roots produces zero bundle mutation", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const inIdea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "in" },
      });
      const outIdea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "out" },
      });
      await ledger.setRoots([`${IDEAS_LEDGER}:${inIdea.id}`]);
      const before = ledger.fetch(GOALS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.bundles.bootstrapIdeaToGoal({
          ideaId: outIdea.id,
          goal: { title: "excluded", description: "x" },
        }),
        "owner-excluded",
      );
      expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
      // Idea must remain open (not consumed).
      expect(ledger.fetchItem(IDEAS_LEDGER, outIdea.id).status).toBe("open");
    });

    it("forged ownership in bundle goal fields is rejected", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "forge-idea" },
      });
      const before = ledger.fetch(GOALS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.bundles.bootstrapIdeaToGoal({
          ideaId: idea.id,
          goal: {
            title: "forged",
            description: "x",
            fields: { worksetOwnerRef: "ideas:I1" },
          },
        }),
        "forged-ownership",
      );
      expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
    });

    it("partial bundle failure rolls back every item (atomic)", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "atomic-idea" },
      });
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "atomic-goal", description: "x" },
      });
      const beforeMs = ledger.fetch(MILESTONES_LEDGER).counters.item;
      const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;
      // Hard failure mid-bundle: invalid status on second task after milestone + first task.
      try {
        await ledger.bundles.publishOwnedDraft({
          goalId: goal.id,
          creationKind: "active-current-draft",
          milestone: { title: "partial-ms-2" },
          tasks: [
            { headline: "ok-task" },
            { headline: "bad-status", status: "not-a-real-status" },
          ],
        });
        throw new Error("expected status validation failure");
      } catch (error) {
        expect(error).toBeTruthy();
        expect((error as Error).message).not.toBe("expected status validation failure");
      }
      expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMs);
      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
      // No stray milestone titled partial-ms-2
      const msLedger = ledger.fetch(MILESTONES_LEDGER);
      for (const group of msLedger.milestones) {
        for (const item of group.items) {
          expect(item.fields.title).not.toBe("partial-ms-2");
        }
      }
    });

    it("each coordination bundle holds exactly one owned-write admission", async () => {
      const subject: { ledger: WorksetOwnedGuardedLedger | null } = { ledger: null };
      const observedAdmissions: number[] = [];
      const ledger = await factory.build({
        afterOwnedAdmit: () => {
          expect(subject.ledger).not.toBeNull();
          observedAdmissions.push(subject.ledger!.activeAdmissionCount());
        },
      });
      subject.ledger = ledger;
      await ledger.init();

      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "admission-idea" },
      });
      observedAdmissions.length = 0;
      const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "admission-goal", description: "one admission" },
      });
      expect(observedAdmissions).toEqual([1]);

      const defect = await ledger.owned.createOwnerless({
        ledgerId: DEFECTS_LEDGER,
        status: "open",
        fields: { headline: "admission-defect", severity: "low" },
      });
      observedAdmissions.length = 0;
      await ledger.bundles.bootstrapDefectToFixGoal({
        defectId: defect.id,
        goal: { title: "admission-fix", description: "one admission" },
      });
      expect(observedAdmissions).toEqual([1]);

      observedAdmissions.length = 0;
      await ledger.bundles.publishOwnedDraft({
        goalId: goal.id,
        creationKind: "active-current-draft",
        milestone: { title: "admission-draft" },
        tasks: [{ headline: "admission-task" }],
      });
      expect(observedAdmissions).toEqual([1]);
      expect(ledger.activeAdmissionCount()).toBe(0);
    });
  });
}
