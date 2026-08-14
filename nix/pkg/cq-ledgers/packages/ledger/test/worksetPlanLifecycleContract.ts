import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  readCanonicalOwnership,
  type PlanClaimAcknowledgement,
  type PlanClaimInput,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanPublishedManifest,
  type PlanReleaseInput,
  type PlanReleaseResult,
  type PlanClaimResult,
  type WorksetGuardedPlanLifecycleStore,
  type WorksetOwnerEdgeKind,
} from "../src/index.js";

const OWNER = "aaaaaaaaaaaaaaaaaaaaaa";
const PROVENANCE = { author: "T1967", session: "T1967-contract" } as const;

export interface WorksetPlanLifecycleContractFactory {
  readonly name: string;
  build(options?: {
    readonly afterPlanAdmit?: () => Promise<void> | void;
    readonly hooks?: {
      readonly beforeAdmissionGrant?: () => Promise<void> | void;
    };
    readonly now?: () => string;
  }): Promise<WorksetGuardedPlanLifecycleStore>;
}

async function seedGoal(
  store: WorksetGuardedPlanLifecycleStore,
  goalId: string,
): Promise<void> {
  await store.owned.createOwnerless({
    ledgerId: GOALS_LEDGER,
    milestoneId: MILESTONES_AMBIENT_ID,
    id: goalId,
    status: "clarifying",
    fields: { title: goalId, description: `goal ${goalId}` },
    ...PROVENANCE,
  });
}

async function claim(
  store: WorksetGuardedPlanLifecycleStore,
  goalId: string,
  requestId: string,
  expectedGeneration: number | null,
): Promise<PlanClaimAcknowledgement> {
  const result = await store.claimPlan({
    goalId,
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: OWNER,
    expectedGeneration,
    ...PROVENANCE,
  });
  if (!result.ok) throw new Error(`claim failed: ${result.conflict.code}`);
  return result.acknowledgement;
}

async function publish(
  store: WorksetGuardedPlanLifecycleStore,
  goalId: string,
  activeClaim: PlanClaimAcknowledgement,
  operationId: string,
  taskHeadline = "Implement",
): Promise<PlanPublishedManifest> {
  const result = await store.publishPlanDraft({
    goalId,
    claimId: activeClaim.claimId,
    generation: activeClaim.generation,
    operationId,
    ownerFenceToken: activeClaim.ownerFenceToken,
    ...PROVENANCE,
    manifest: {
      milestones: [{ key: "delivery", title: `Delivery ${operationId}` }],
      tasks: [{ key: "task", milestoneKey: "delivery", headline: taskHeadline }],
    },
  });
  if (!result.ok) throw new Error(`publish failed: ${result.conflict.code}`);
  return result.acknowledgement.manifest;
}

async function bytes(store: WorksetGuardedPlanLifecycleStore): Promise<string> {
  const roots = await store.snapshotRoots();
  const ledgers = store.enumerate().sort().map((ledgerId) => store.fetch(ledgerId));
  return JSON.stringify({ roots, ledgers });
}

function expectOwnership(
  store: WorksetGuardedPlanLifecycleStore,
  ledgerId: string,
  itemId: string,
  goalId: string,
  edgeKind: WorksetOwnerEdgeKind,
): void {
  expect(readCanonicalOwnership(store.fetchItem(ledgerId, itemId))).toEqual({
    ownerRef: `${GOALS_LEDGER}:${goalId}`,
    edgeKind,
  });
}

type ContractOperation = "claim-plan" | "publish-plan-draft" | "release-plan-claim" | "finalize-plan";

interface PreparedOperation<Result> {
  readonly operation: ContractOperation;
  readonly invoke: () => Promise<Result>;
}

async function prepareOperation(
  store: WorksetGuardedPlanLifecycleStore,
  operation: ContractOperation,
): Promise<PreparedOperation<PlanClaimResult | PlanPublishDraftResult | PlanReleaseResult | PlanFinalizeResult>> {
  await store.init();
  await seedGoal(store, "G1");
  const claimInput: PlanClaimInput = {
    goalId: "G1",
    purpose: "initial",
    claimRequestId: `race-${operation}`,
    ownerFenceToken: OWNER,
    expectedGeneration: null,
    ...PROVENANCE,
  };
  if (operation === "claim-plan") {
    return { operation, invoke: () => store.claimPlan(claimInput) };
  }
  const activeClaim = await claim(store, "G1", `setup-${operation}`, null);
  if (operation === "publish-plan-draft") {
    const input: PlanPublishDraftInput = {
      goalId: "G1",
      claimId: activeClaim.claimId,
      generation: activeClaim.generation,
      operationId: `race-${operation}`,
      ownerFenceToken: activeClaim.ownerFenceToken,
      ...PROVENANCE,
      manifest: {
        milestones: [{ key: "delivery", title: "Delivery" }],
        tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
      },
    };
    return { operation, invoke: () => store.publishPlanDraft(input) };
  }
  if (operation === "release-plan-claim") {
    const input: PlanReleaseInput = {
      kind: "pause",
      goalId: "G1",
      claimId: activeClaim.claimId,
      generation: activeClaim.generation,
      operationId: `race-${operation}`,
      ownerFenceToken: activeClaim.ownerFenceToken,
      effect: { kind: "questions", questions: [{ key: "scope", question: "Scope?" }] },
      ...PROVENANCE,
    };
    return { operation, invoke: () => store.releasePlanClaim(input) };
  }
  const manifest = await publish(store, "G1", activeClaim, "setup-finalize-publish");
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
          claimId: activeClaim.claimId,
          generation: activeClaim.generation,
          revision: manifest.revision,
        }),
      },
      ...PROVENANCE,
    },
  });
  const input: PlanFinalizeInput = {
    goalId: "G1",
    claimId: activeClaim.claimId,
    generation: activeClaim.generation,
    operationId: `race-${operation}`,
    ownerFenceToken: activeClaim.ownerFenceToken,
    reviewId: "R1",
    draftRevision: manifest.revision,
    decision: { headline: "Proceed" },
    ...PROVENANCE,
  };
  return { operation, invoke: () => store.finalizePlan(input) };
}

export function registerWorksetPlanLifecycleContract(
  factory: WorksetPlanLifecycleContractFactory,
): void {
  describe(`${factory.name} workset-guarded plan lifecycle [BA]`, () => {
    for (const operation of [
      "claim-plan",
      "publish-plan-draft",
      "release-plan-claim",
      "finalize-plan",
    ] as const) {
      it(`${operation}: empty roots preserve raw result and state bytes`, async () => {
        const now = () => "2026-08-13T16:00:00.000Z";
        const guarded = await factory.build({ now });
        const raw = new InMemoryLedgerStore({ now });
        await guarded.init();
        await raw.init();
        await seedGoal(guarded, "G1");
        await raw.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
          id: "G1",
          status: "clarifying",
          fields: { title: "G1", description: "goal G1" },
          ...PROVENANCE,
        });
        const claimInput: PlanClaimInput = {
          goalId: "G1",
          purpose: "initial",
          claimRequestId: `empty-${operation}`,
          ownerFenceToken: OWNER,
          expectedGeneration: null,
          ...PROVENANCE,
        };
        if (operation === "claim-plan") {
          expect(await guarded.claimPlan(claimInput)).toEqual(await raw.claimPlan(claimInput));
        } else {
          const guardedClaim = await guarded.claimPlan(claimInput);
          const rawClaim = await raw.claimPlan(claimInput);
          if (!guardedClaim.ok || !rawClaim.ok) throw new Error("setup claim failed");
          if (operation === "publish-plan-draft") {
            const input: PlanPublishDraftInput = {
              goalId: "G1",
              claimId: guardedClaim.acknowledgement.claimId,
              generation: guardedClaim.acknowledgement.generation,
              operationId: "empty-publish",
              ownerFenceToken: OWNER,
              ...PROVENANCE,
              manifest: {
                milestones: [{ key: "delivery", title: "Delivery" }],
                tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
              },
            };
            expect(await guarded.publishPlanDraft(input)).toEqual(await raw.publishPlanDraft(input));
          } else if (operation === "release-plan-claim") {
            const input: PlanReleaseInput = {
              kind: "pause",
              goalId: "G1",
              claimId: guardedClaim.acknowledgement.claimId,
              generation: guardedClaim.acknowledgement.generation,
              operationId: "empty-release",
              ownerFenceToken: OWNER,
              effect: {
                kind: "researches",
                researches: [{ key: "probe", question: "Probe?" }],
              },
              ...PROVENANCE,
            };
            expect(await guarded.releasePlanClaim(input)).toEqual(await raw.releasePlanClaim(input));
          } else {
            const publishInput: PlanPublishDraftInput = {
              goalId: "G1",
              claimId: guardedClaim.acknowledgement.claimId,
              generation: guardedClaim.acknowledgement.generation,
              operationId: "empty-finalize-publish",
              ownerFenceToken: OWNER,
              ...PROVENANCE,
              manifest: {
                milestones: [{ key: "delivery", title: "Delivery" }],
                tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
              },
            };
            const guardedPublished = await guarded.publishPlanDraft(publishInput);
            const rawPublished = await raw.publishPlanDraft(publishInput);
            if (!guardedPublished.ok || !rawPublished.ok) throw new Error("setup publish failed");
            const draftBinding = JSON.stringify({
              goalId: "G1",
              claimId: guardedClaim.acknowledgement.claimId,
              generation: guardedClaim.acknowledgement.generation,
              revision: guardedPublished.acknowledgement.manifest.revision,
            });
            await guarded.mutations.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
              id: "R1",
              status: "go-ahead",
              fields: { [PLAN_REVIEW_DRAFT_FIELD]: draftBinding },
              ...PROVENANCE,
            });
            await raw.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
              id: "R1",
              status: "go-ahead",
              fields: { [PLAN_REVIEW_DRAFT_FIELD]: draftBinding },
              ...PROVENANCE,
            });
            const input: PlanFinalizeInput = {
              goalId: "G1",
              claimId: guardedClaim.acknowledgement.claimId,
              generation: guardedClaim.acknowledgement.generation,
              operationId: "empty-finalize",
              ownerFenceToken: OWNER,
              reviewId: "R1",
              draftRevision: guardedPublished.acknowledgement.manifest.revision,
              decision: { headline: "Proceed" },
              ...PROVENANCE,
            };
            expect(await guarded.finalizePlan(input)).toEqual(await raw.finalizePlan(input));
          }
        }
        expect(
          guarded.enumerate().sort().map((ledgerId) => guarded.fetch(ledgerId)),
        ).toEqual(raw.enumerate().sort().map((ledgerId) => raw.fetch(ledgerId)));
      });
    }

    it("runs claim and release under restrictive roots with canonical effects", async () => {
      const releaseStore = await factory.build();
      await releaseStore.init();
      await seedGoal(releaseStore, "G1");
      await releaseStore.setRoots(["goals:G1"]);
      const firstClaim = await claim(releaseStore, "G1", "claim-g1-1", null);
      const questionRelease = await releaseStore.releasePlanClaim({
        kind: "pause",
        goalId: "G1",
        claimId: firstClaim.claimId,
        generation: firstClaim.generation,
        operationId: "question-release",
        ownerFenceToken: firstClaim.ownerFenceToken,
        effect: {
          kind: "questions",
          questions: [{ key: "scope", question: "Which scope?" }],
        },
        reviewDefects: {
          reviewId: "R999",
          defects: [{ key: "missing", headline: "Missing review remains optional", severity: "low" }],
        },
        ...PROVENANCE,
      });
      expect(questionRelease.ok).toBe(true);
      if (!questionRelease.ok) throw new Error("question release failed");
      const questionId = questionRelease.acknowledgement.questions[0]?.id;
      if (questionId === undefined) throw new Error("question id missing");
      expectOwnership(releaseStore, "questions", questionId, "G1", "exact-gate-question");
      const releaseDefectId = questionRelease.acknowledgement.reviewDefects[0]?.id;
      if (releaseDefectId === undefined) throw new Error("release defect id missing");
      expectOwnership(
        releaseStore,
        "defects",
        releaseDefectId,
        "G1",
        "review-filed-defect",
      );

      const secondClaim = await claim(releaseStore, "G1", "claim-g1-2", 1);
      const researchRelease = await releaseStore.releasePlanClaim({
        kind: "pause",
        goalId: "G1",
        claimId: secondClaim.claimId,
        generation: secondClaim.generation,
        operationId: "research-release",
        ownerFenceToken: secondClaim.ownerFenceToken,
        effect: {
          kind: "researches",
          researches: [{ key: "probe", question: "Does it hold?" }],
        },
        ...PROVENANCE,
      });
      expect(researchRelease.ok).toBe(true);
      if (!researchRelease.ok) throw new Error("research release failed");
      const researchId = researchRelease.acknowledgement.researches[0]?.id;
      if (researchId === undefined) throw new Error("research id missing");
      expectOwnership(releaseStore, "researches", researchId, "G1", "research");
      expect(releaseStore.activeAdmissionCount()).toBe(0);
    });

    it("runs claim, publish, and finalize under restrictive roots with canonical effects", async () => {
      const finalizeStore = await factory.build();
      await finalizeStore.init();
      await seedGoal(finalizeStore, "G2");
      await finalizeStore.setRoots(["goals:G2"]);
      const finalizeClaim = await claim(finalizeStore, "G2", "claim-g2", null);
      const manifest = await publish(
        finalizeStore,
        "G2",
        finalizeClaim,
        "publish-g2",
      );
      for (const { id } of manifest.milestones) {
        expectOwnership(finalizeStore, "milestones", id, "G2", "active-current-draft");
      }
      for (const { id } of manifest.tasks) {
        expectOwnership(finalizeStore, TASKS_LEDGER, id, "G2", "active-current-draft");
      }
      await finalizeStore.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: "G2" },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "R1",
          status: "go-ahead",
          fields: {
            [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
              goalId: "G2",
              claimId: finalizeClaim.claimId,
              generation: finalizeClaim.generation,
              revision: manifest.revision,
            }),
          },
          ...PROVENANCE,
        },
      });
      const finalized = await finalizeStore.finalizePlan({
        goalId: "G2",
        claimId: finalizeClaim.claimId,
        generation: finalizeClaim.generation,
        operationId: "finalize-g2",
        ownerFenceToken: finalizeClaim.ownerFenceToken,
        reviewId: "R1",
        draftRevision: manifest.revision,
        decision: { headline: "Proceed" },
        reviewDefects: {
          reviewId: "R1",
          defects: [{ key: "guard", headline: "Guard the boundary", severity: "high" }],
        },
        ...PROVENANCE,
      });
      expect(finalized.ok).toBe(true);
      if (!finalized.ok) throw new Error("finalize failed");
      expectOwnership(
        finalizeStore,
        "decisions",
        finalized.acknowledgement.decisionId,
        "G2",
        "decision",
      );
      for (const { id } of finalized.acknowledgement.manifest.milestones) {
        expectOwnership(finalizeStore, "milestones", id, "G2", "finalized-manifest");
      }
      for (const { id } of finalized.acknowledgement.manifest.tasks) {
        expectOwnership(finalizeStore, TASKS_LEDGER, id, "G2", "finalized-manifest");
      }
      const defectId = finalized.acknowledgement.reviewDefects[0]?.id;
      if (defectId === undefined) throw new Error("review defect id missing");
      expectOwnership(finalizeStore, "defects", defectId, "G2", "review-filed-defect");
      const publishReplay = await finalizeStore.publishPlanDraft({
        goalId: "G2",
        claimId: finalizeClaim.claimId,
        generation: finalizeClaim.generation,
        operationId: "publish-g2",
        ownerFenceToken: finalizeClaim.ownerFenceToken,
        ...PROVENANCE,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery publish-g2" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
        },
      });
      expect(publishReplay).toMatchObject({ ok: true, replayed: true });
      expect(finalizeStore.activeAdmissionCount()).toBe(0);
    });

    it("rejects a mixed task pause and restores the exact pre-operation state", async () => {
      const store = await factory.build();
      await store.init();
      await seedGoal(store, "G1");
      await seedGoal(store, "G2");
      const otherClaim = await claim(store, "G2", "other-claim", null);
      const otherManifest = await publish(store, "G2", otherClaim, "other-publish");
      const otherTaskId = otherManifest.tasks[0]?.id;
      if (otherTaskId === undefined) throw new Error("other task missing");
      const selectedClaim = await claim(store, "G1", "selected-claim", null);
      await store.setRoots(["goals:G1"]);
      const before = await bytes(store);
      const mixedInput: PlanReleaseInput = {
          kind: "pause",
          goalId: "G1",
          claimId: selectedClaim.claimId,
          generation: selectedClaim.generation,
          operationId: "mixed-release",
          ownerFenceToken: selectedClaim.ownerFenceToken,
          effect: { kind: "tasks", tasks: [otherTaskId] },
          ...PROVENANCE,
        };
      const mixed = await store.releasePlanClaim(mixedInput);
      expect(mixed).toMatchObject({
        ok: false,
        conflict: { code: "workset-conflict", reason: "target-excluded" },
      });
      expect(await bytes(store)).toBe(before);
      expect(store.activeAdmissionCount()).toBe(0);
      await store.setRoots([]);
      expect((await store.releasePlanClaim(mixedInput)).ok).toBe(true);
    });

    it("rolls back replacement cleanup when it would mutate an external referrer", async () => {
      const store = await factory.build();
      await store.init();
      await seedGoal(store, "G1");
      await seedGoal(store, "G2");
      const firstClaim = await claim(store, "G1", "first-claim", null);
      const firstManifest = await publish(store, "G1", firstClaim, "first-publish");
      const firstTaskId = firstManifest.tasks[0]?.id;
      if (firstTaskId === undefined) throw new Error("first task missing");
      const otherClaim = await claim(store, "G2", "other-claim", null);
      const otherManifest = await publish(store, "G2", otherClaim, "other-publish");
      const otherTaskId = otherManifest.tasks[0]?.id;
      if (otherTaskId === undefined) throw new Error("other task missing");
      await store.mutations.updateItem(TASKS_LEDGER, otherTaskId, {
        fields: { dependsOn: [`tasks:${firstTaskId}`] },
      });
      await store.setRoots(["goals:G1"]);
      const before = await bytes(store);
      const replacementInput: PlanPublishDraftInput = {
        goalId: "G1",
        claimId: firstClaim.claimId,
        generation: firstClaim.generation,
        operationId: "replacement-publish",
        ownerFenceToken: firstClaim.ownerFenceToken,
        ...PROVENANCE,
        manifest: {
          milestones: [{ key: "delivery", title: "Replacement" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "Replacement" }],
        },
      };
      const replacement = await store.publishPlanDraft(replacementInput);
      expect(replacement).toMatchObject({
        ok: false,
        conflict: { code: "workset-conflict", reason: "target-excluded" },
      });
      expect(await bytes(store)).toBe(before);
      expect(store.activeAdmissionCount()).toBe(0);
      await store.setRoots([]);
      expect((await store.publishPlanDraft(replacementInput)).ok).toBe(true);
    });

    it("rejects finalize with an excluded review and creates no decision or final marker", async () => {
      const store = await factory.build();
      await store.init();
      await seedGoal(store, "G1");
      await seedGoal(store, "G2");
      const activeClaim = await claim(store, "G1", "finalize-claim", null);
      const manifest = await publish(store, "G1", activeClaim, "finalize-publish");
      await store.owned.createOwnerless({
        ledgerId: REVIEWS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "R1",
        status: "go-ahead",
        fields: {
          [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
            goalId: "G1",
            claimId: activeClaim.claimId,
            generation: activeClaim.generation,
            revision: manifest.revision,
          }),
        },
        ...PROVENANCE,
      });
      await store.setRoots(["goals:G1"]);
      const before = await bytes(store);
      const finalizeInput: PlanFinalizeInput = {
        goalId: "G1",
        claimId: activeClaim.claimId,
        generation: activeClaim.generation,
        operationId: "excluded-review-finalize",
        ownerFenceToken: activeClaim.ownerFenceToken,
        reviewId: "R1",
        draftRevision: manifest.revision,
        decision: { headline: "Do not persist" },
        ...PROVENANCE,
      };
      const result = await store.finalizePlan(finalizeInput);
      expect(result).toMatchObject({
        ok: false,
        conflict: {
          code: "workset-conflict",
          reason: "target-excluded",
          refs: ["reviews:R1"],
        },
      });
      expect(await bytes(store)).toBe(before);
      expect(store.activeAdmissionCount()).toBe(0);
      await store.setRoots([]);
      expect((await store.finalizePlan(finalizeInput)).ok).toBe(true);
    });

    for (const operation of [
      "claim-plan",
      "publish-plan-draft",
      "release-plan-claim",
      "finalize-plan",
    ] as const) {
      it(`${operation}: admitted lifecycle blocks setRoots through acknowledgement`, async () => {
        let entered!: () => void;
        let release!: () => void;
        const admitted = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const continueLifecycle = new Promise<void>((resolve) => {
          release = resolve;
        });
        let block = false;
        const store = await factory.build({
          afterPlanAdmit: async () => {
            if (!block) return;
            entered();
            await continueLifecycle;
          },
        });
        const prepared = await prepareOperation(store, operation);
        await seedGoal(store, "G2");
        await store.setRoots(["goals:G1"]);
        block = true;
        const lifecycle = prepared.invoke();
        await admitted;
        let replacementSettled = false;
        const replacement = store.setRoots(["goals:G2"]).then((value) => {
          replacementSettled = true;
          return value;
        });
        await Promise.resolve();
        expect(replacementSettled).toBe(false);
        expect(store.activeAdmissionCount()).toBe(1);
        release();
        expect((await lifecycle).ok).toBe(true);
        expect((await replacement).roots).toEqual(["goals:G2"]);
        expect(store.activeAdmissionCount()).toBe(0);
      });

      it(`${operation}: setRoots revokes an admission waiting before grant`, async () => {
        let entered!: () => void;
        let release!: () => void;
        const beforeGrant = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const continueAdmission = new Promise<void>((resolve) => {
          release = resolve;
        });
        let block = false;
        const store = await factory.build({
          hooks: {
            beforeAdmissionGrant: async () => {
              if (!block) return;
              entered();
              await continueAdmission;
            },
          },
        });
        const prepared = await prepareOperation(store, operation);
        await seedGoal(store, "G2");
        await store.setRoots(["goals:G1"]);
        const beforeLedgers = JSON.stringify(
          store.enumerate().sort().map((ledgerId) => store.fetch(ledgerId)),
        );
        block = true;
        const lifecycle = prepared.invoke();
        await beforeGrant;
        const replacement = store.setRoots(["goals:G2"]);
        release();
        const [result, roots] = await Promise.all([lifecycle, replacement]);
        expect(result).toMatchObject({
          ok: false,
          conflict: {
            code: "workset-conflict",
            operation,
            reason: "revoked",
          },
        });
        expect(roots.roots).toEqual(["goals:G2"]);
        expect(
          JSON.stringify(store.enumerate().sort().map((ledgerId) => store.fetch(ledgerId))),
        ).toBe(beforeLedgers);
        expect(store.activeAdmissionCount()).toBe(0);
      });
    }
  });
}
