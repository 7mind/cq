/**
 * T1962 — parameterized Behavioral-Active Blackbox contract for coordination
 * bundles (atomic multi-item owner-scoped bootstraps).
 *
 * Scope:
 * - idea→goal and defect→fix-goal bootstraps seal ownership atomically
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
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedLifecycleErrorCode,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
} from "../src/index.js";

export type WorksetCoordinationBundleContractClassification =
  "Behavioral-Active Blackbox-Atomic" | "Behavioral-Active Blackbox-GoodCommunication";

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

function memberRefsForRoot(ledger: WorksetOwnedGuardedLedger, root: string): ReadonlySet<string> {
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
      const input = {
        defectId: defect.id,
        goal: { title: "fix", description: "address the defect" },
      } as const;
      const result = await ledger.bundles.bootstrapDefectToFixGoal(input);
      const replay = await ledger.bundles.bootstrapDefectToFixGoal(input);
      const ownership = readCanonicalOwnership(result.goal);
      expect(ownership).not.toBeNull();
      expect(ownership!.ownerRef).toBe(`${DEFECTS_LEDGER}:${defect.id}`);
      expect(ownership!.edgeKind).toBe("fix-goal");
      const members = memberRefsForRoot(ledger, `${DEFECTS_LEDGER}:${defect.id}`);
      expect(members.has(`${GOALS_LEDGER}:${result.goal.id}`)).toBe(true);
      expect(replay.goal).toEqual(result.goal);
      expect(replay.defect).toEqual(result.defect);
    });

    it("concurrent defect repair bootstraps return one correction lineage", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const defect = await ledger.owned.createOwnerless({
        ledgerId: DEFECTS_LEDGER,
        status: "root-caused",
        fields: {
          headline: "implementation infrastructure blocker",
          severity: "high",
          rootCause: "the active implementation cannot repair its own bootstrap",
        },
      });
      const input = {
        defectId: defect.id,
        goal: { title: "bootstrap repair", description: "correct the infrastructure defect" },
      } as const;

      const claims = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) =>
            await ledger.bundles.bootstrapDefectToFixGoal({
              ...input,
              goal: {
                title: `${input.goal.title} ${String(index)}`,
                description: `${input.goal.description} claim ${String(index)}`,
              },
            }),
        ),
      );
      expect(new Set(claims.map(({ goal }) => goal.id)).size).toBe(1);
      expect(claims.every(({ defect: observed }) => observed.id === defect.id)).toBe(true);
      expect(readCanonicalOwnership(claims[0]!.goal)).toMatchObject({
        ownerRef: `${DEFECTS_LEDGER}:${defect.id}`,
        edgeKind: "fix-goal",
      });
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
      await ledger.bundles.bootstrapIdeaToGoal({
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
      expect(ledger.activeAdmissionCount()).toBe(0);
    });
  });
}
