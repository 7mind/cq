import { describe, expect, it } from "bun:test";
import type {
  PlanClaimAcknowledgement,
  PlanClaimInput,
  PlanDraftIdentity,
  PlanDraftManifest,
  PlanFinalizeInput,
  PlanPublishDraftInput,
  PlanReleaseInput,
} from "../src/index.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
  ReferencePublicGoalState,
} from "./planLifecycleReferenceAdapter.js";
import { OneShotSerializationBoundary } from "./planLifecycleSerializationBoundary.js";

const GOAL_ID = "G1";
const OTHER_GOAL_ID = "G2";
const OWNER_TOKEN_A = "A".repeat(22);
const OWNER_TOKEN_B = "B".repeat(22);
const PROVENANCE_A = {
  author: "planner-a",
  session: "session-a",
} as const;
const PROVENANCE_B = {
  author: "planner-b",
  session: "session-b",
} as const;

const COMPLETE_MANIFEST = {
  milestones: [
    {
      key: "delivery",
      title: "Deliver guarded planning",
    },
  ],
  tasks: [
    {
      key: "contract",
      milestoneKey: "delivery",
      headline: "Publish the contract",
    },
    {
      key: "implementation",
      milestoneKey: "delivery",
      headline: "Implement the contract",
      dependsOn: [{ kind: "draft-task", key: "contract" }],
    },
  ],
} as const satisfies PlanDraftManifest;

const RICH_MANIFEST = {
  milestones: [
    {
      key: "design",
      title: "Design guarded planning",
      description: "Preserve every milestone field",
      dependsOn: [{ kind: "ledger", ref: "researches:RS8" }],
      blockedBy: [{ kind: "draft-milestone", key: "delivery" }],
    },
    {
      key: "delivery",
      title: "Deliver guarded planning",
      description: "Own the implementation tasks",
      dependsOn: [{ kind: "draft-milestone", key: "design" }],
      blockedBy: [{ kind: "ledger", ref: "questions:Q1" }],
    },
  ],
  tasks: [
    {
      key: "contract",
      milestoneKey: "design",
      headline: "Publish the lifecycle contract",
      description: "Retain the task description",
      acceptance: "The contract remains unchanged across adapters",
      suggestedModel: "frontier",
      ledgerRefs: ["goals:G1", "defects:D264", "defects:D264"],
      sourceRefs: ["nix/pkg/cq-ledgers/packages/ledger/src/planLifecycle.ts"],
      tags: ["contract", "guarded"],
      dependsOn: [
        { kind: "draft-milestone", key: "design" },
        { kind: "ledger", ref: "researches:RS8" },
      ],
      blockedBy: [{ kind: "draft-task", key: "implementation" }],
    },
    {
      key: "implementation",
      milestoneKey: "delivery",
      headline: "Implement the lifecycle contract",
      description: "Retain implementation metadata",
      acceptance: "Only the finalized current draft becomes executable",
      suggestedModel: "frontier",
      ledgerRefs: ["defects:D264"],
      sourceRefs: ["tasks:T846"],
      tags: ["implementation"],
      dependsOn: [{ kind: "draft-task", key: "contract" }],
      blockedBy: [{ kind: "ledger", ref: "questions:Q2" }],
    },
  ],
} as const satisfies PlanDraftManifest;

function claimInput(
  purpose: "initial" | "follow-up",
  claimRequestId: string,
  ownerFenceToken: string,
  expectedGeneration: number | null,
  provenance: typeof PROVENANCE_A | typeof PROVENANCE_B,
): PlanClaimInput {
  return {
    goalId: GOAL_ID,
    purpose,
    claimRequestId,
    ownerFenceToken,
    expectedGeneration,
    ...provenance,
  };
}

function requireClaimWinner(
  result: Awaited<ReturnType<PlanLifecycleContractFixture["lifecycle"]["claimPlan"]>>,
): PlanClaimAcknowledgement {
  if (!result.ok) {
    throw new Error(`expected claim success, received ${result.conflict.code}`);
  }
  return result.acknowledgement;
}

function publishInput(
  claim: PlanClaimAcknowledgement,
  operationId: string,
  manifest: PlanDraftManifest = COMPLETE_MANIFEST,
): PlanPublishDraftInput {
  return {
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE_A,
    manifest,
  };
}

function jsonHasAuthorityMaterial(
  state: ReferencePublicGoalState,
  tokens: readonly string[],
): boolean {
  const json = JSON.stringify(state);
  return tokens.some((token) => json.includes(token)) || /ownerFenceToken|Verifier/.test(json);
}

async function buildGoal(
  factory: PlanLifecycleContractFactory,
  phase: "clarifying" | "planning" | "planned" | "building",
  generation: number | null,
): Promise<PlanLifecycleContractFixture> {
  const fixture = await factory.build();
  await fixture.seedGoal({ goalId: GOAL_ID, phase, generation });
  return fixture;
}

describe("one-shot plan-lifecycle serialization boundary", () => {
  it("rejects unarmed, wrong, and duplicate arrivals", async () => {
    const unarmed = new OneShotSerializationBoundary();
    await expect(unarmed.arrive("task-start")).rejects.toThrow(/not armed.*task-start/);

    const wrong = new OneShotSerializationBoundary();
    await expect(
      wrong.race(
        "task-start",
        () => wrong.arrive("follow-up-claim"),
        async () => undefined,
        100,
      ),
    ).rejects.toThrow(/expected task-start, received follow-up-claim/);

    const duplicate = new OneShotSerializationBoundary();
    await expect(
      duplicate.race(
        "task-block",
        async () => {
          await Promise.all([duplicate.arrive("task-block"), duplicate.arrive("task-block")]);
        },
        async () => undefined,
        100,
      ),
    ).rejects.toThrow(/duplicate.*task-block/);
  });

  it("fails within its bound when no matching boundary arrives", async () => {
    const boundary = new OneShotSerializationBoundary();
    await expect(
      boundary.race(
        "follow-up-claim",
        () => new Promise<void>(() => {}),
        async () => undefined,
        20,
      ),
    ).rejects.toThrow(/timed out after 20ms.*follow-up-claim/);
  });
});

export function runPlanLifecycleStoreContract(factory: PlanLifecycleContractFactory): void {
  const contractDescribe = factory.progression || factory.skip === true ? describe.skip : describe;
  const timeout = factory.progression ? 5_000 : 10_000;

  contractDescribe(
    `PlanLifecycleStore contract — ${factory.name} (${factory.classification})`,
    () => {
      it(
        "returns every boundary conflict omitted from the initial conformance pass",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          await fixture.seedGoal({ goalId: "G2", phase: "done", generation: 4 });
          await fixture.seedGoal({ goalId: "G3", phase: "building", generation: 2 });
          await fixture.seedGoal({ goalId: "G4", phase: "planning", generation: 2 });
          await fixture.seedGoal({ goalId: "G5", phase: "planning", generation: 1 });

          expect(
            await fixture.lifecycle.claimPlan({
              ...claimInput("initial", "missing-goal", OWNER_TOKEN_A, null, PROVENANCE_A),
              goalId: "G404",
            }),
          ).toEqual({
            ok: false,
            conflict: { code: "goal-not-found", goalId: "G404" },
          });
          expect(
            await fixture.lifecycle.claimPlan({
              ...claimInput("initial", "terminal-goal", OWNER_TOKEN_A, 4, PROVENANCE_A),
              goalId: "G2",
            }),
          ).toEqual({
            ok: false,
            conflict: { code: "goal-terminal", goalId: "G2", status: "done" },
          });
          expect(
            await fixture.lifecycle.claimPlan({
              ...claimInput("initial", "wrong-phase", OWNER_TOKEN_A, 2, PROVENANCE_A),
              goalId: "G3",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "goal-phase-conflict",
              goalId: "G3",
              status: "building",
              allowed: ["clarifying", "planning"],
            },
          });
          expect(
            await fixture.lifecycle.claimPlan({
              ...claimInput("initial", "stale-generation", OWNER_TOKEN_A, 1, PROVENANCE_A),
              goalId: "G4",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "stale-generation",
              goalId: "G4",
              expectedGeneration: 1,
              currentGeneration: 2,
            },
          });
          expect(
            await fixture.lifecycle.publishPlanDraft({
              goalId: "G5",
              claimId: "inactive_claim",
              generation: 1,
              operationId: "inactive-publish",
              ownerFenceToken: OWNER_TOKEN_A,
              ...PROVENANCE_A,
              manifest: COMPLETE_MANIFEST,
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "claim-not-active",
              goalId: "G5",
              claimId: "inactive_claim",
              generation: 1,
            },
          });

          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "finalize-conflicts", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const baseFinalize = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            draftRevision: 1,
            decision: { headline: "Must not commit a rejected finalize" },
          } as const;
          expect(
            await fixture.lifecycle.finalizePlan({
              ...baseFinalize,
              operationId: "draft-missing",
              reviewId: "R404",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "draft-not-found",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
            },
          });

          const published = await fixture.lifecycle.publishPlanDraft(
            publishInput(claim, "publish-for-review-conflicts"),
          );
          if (!published.ok) throw new Error("conflict fixture draft publication failed");
          const draft = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            revision: published.acknowledgement.manifest.revision,
          };
          expect(
            await fixture.lifecycle.finalizePlan({
              ...baseFinalize,
              operationId: "review-missing",
              reviewId: "R404",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "review-not-found",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              reviewId: "R404",
            },
          });
          await fixture.seedReview({
            reviewId: "R6",
            goalId: GOAL_ID,
            status: "revise",
            draft,
            provenance: PROVENANCE_B,
          });
          expect(
            await fixture.lifecycle.finalizePlan({
              ...baseFinalize,
              operationId: "review-not-approved",
              reviewId: "R6",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "review-not-approved",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              reviewId: "R6",
              status: "revise",
            },
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "serializes simultaneous fresh claims and exposes only the winning public fence",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const results = await Promise.all([
            fixture.lifecycle.claimPlan(
              claimInput("initial", "fresh-a", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
            fixture.lifecycle.claimPlan(
              claimInput("initial", "fresh-b", OWNER_TOKEN_B, null, PROVENANCE_B),
            ),
          ]);
          const winners = results.filter((result) => result.ok);
          const losers = results.filter((result) => !result.ok);
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          if (winners[0] === undefined || !winners[0].ok) {
            throw new Error("fresh claim winner missing");
          }
          if (losers[0] === undefined || losers[0].ok) {
            throw new Error("fresh claim loser missing");
          }
          expect(losers[0].conflict.code).toBe("claim-active");
          expect(winners[0].acknowledgement).toMatchObject({
            generation: 1,
            previousGoalPhase: "clarifying",
            goalPhase: "planning",
          });

          const state = await fixture.observe(GOAL_ID);
          expect(state.phase).toBe("planning");
          expect(state.generation).toBe(1);
          expect(state.activeClaim).toEqual({
            goalId: GOAL_ID,
            claimId: winners[0].acknowledgement.claimId,
            generation: 1,
            purpose: "initial",
          });
            expect(jsonHasAuthorityMaterial(state, [OWNER_TOKEN_A, OWNER_TOKEN_B])).toBe(false);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "replays a lost claim response after restart from verifier-only durable state",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
            const input = claimInput("initial", "lost-claim", OWNER_TOKEN_A, null, PROVENANCE_A);
          const first = await fixture.lifecycle.claimPlan(input);
          if (!first.ok) throw new Error("initial claim unexpectedly conflicted");

          const restarted = await fixture.restart();
            expect(await restarted.observe(GOAL_ID)).toEqual(await fixture.observe(GOAL_ID));
          await fixture.seedGoal({
            goalId: OTHER_GOAL_ID,
            phase: "clarifying",
            generation: null,
          });
            await expect(restarted.observe(OTHER_GOAL_ID)).rejects.toThrow(/goal not found/);
          const replay = await restarted.lifecycle.claimPlan(input);
          expect(replay).toEqual({ ...first, replayed: true });
          expect(
            await restarted.lifecycle.claimPlan({
              ...input,
              author: "changed-author",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "claim-request-reused",
              goalId: GOAL_ID,
              claimId: first.acknowledgement.claimId,
              generation: 1,
              claimRequestId: "lost-claim",
            },
          });
          expect(
            await restarted.lifecycle.claimPlan({
              ...input,
              ownerFenceToken: OWNER_TOKEN_B,
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "owner-fence-mismatch",
              goalId: GOAL_ID,
              claimId: first.acknowledgement.claimId,
              generation: 1,
            },
          });
          expect(
            jsonHasAuthorityMaterial(await restarted.observe(GOAL_ID), [
              OWNER_TOKEN_A,
              OWNER_TOKEN_B,
            ]),
          ).toBe(false);
          const released = await restarted.lifecycle.releasePlanClaim({
            kind: "abandon",
            goalId: GOAL_ID,
            claimId: first.acknowledgement.claimId,
            generation: first.acknowledgement.generation,
            operationId: "restart-isolation-release",
            reason: "prove the restarted handle owns deserialized state",
            ...PROVENANCE_B,
          });
          expect(released.ok).toBe(true);
          expect((await restarted.observe(GOAL_ID)).activeClaim).toBeNull();
          expect((await fixture.observe(GOAL_ID)).activeClaim?.claimId).toBe(
            first.acknowledgement.claimId,
          );
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "adopts declared legacy work, but fences simultaneous follow-up replacement",
        async () => {
        const legacy = await buildGoal(factory, "clarifying", null);
        try {
          await legacy.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 0,
            legacy: true,
          });
          const result = await legacy.lifecycle.claimPlan(
            claimInput("initial", "legacy", OWNER_TOKEN_A, null, PROVENANCE_A),
          );
          const acknowledgement = requireClaimWinner(result);
          const before = await legacy.observe(GOAL_ID);
          expect(acknowledgement.legacyAdopted).toBe(true);
          expect(acknowledgement.adoptedManifest).toEqual({
            milestoneIds: before.milestones.map(({ id }) => id),
            taskIds: before.tasks.map(({ id }) => id),
          });
          expect(before.tasks[0]?.status).toBe("planned");
        } finally {
          await legacy.dispose();
        }

        const followUp = await buildGoal(factory, "planned", 1);
        try {
          await followUp.seedWork(GOAL_ID, {
            taskStatuses: ["planned", "done"],
            openQuestionCount: 1,
            legacy: false,
          });
          const results = await Promise.all([
            followUp.lifecycle.claimPlan(
              claimInput("follow-up", "follow-a", OWNER_TOKEN_A, 1, PROVENANCE_A),
            ),
            followUp.lifecycle.claimPlan(
              claimInput("follow-up", "follow-b", OWNER_TOKEN_B, 1, PROVENANCE_B),
            ),
          ]);
          expect(results.filter(({ ok }) => ok)).toHaveLength(1);
          expect(
            results
              .filter((result) => !result.ok)
              .map((result) => (result.ok ? "" : result.conflict.code)),
          ).toEqual(["claim-active"]);

          const state = await followUp.observe(GOAL_ID);
          expect(state.phase).toBe("planning");
          expect(state.generation).toBe(2);
          expect(state.milestoneIds).toEqual([]);
          expect(state.finalizedManifest).toBeNull();
            expect(state.tasks.map(({ status }) => status)).toEqual(["abandoned", "done"]);
          expect(state.tasks[1]?.dependsOn).toEqual([]);
            expect(state.milestones.map(({ status }) => status)).toEqual(["postponed"]);
          expect(state.questions.map(({ status }) => status)).toEqual(["withdrawn"]);
        } finally {
          await followUp.dispose();
        }
        },
        timeout,
      );

      // regression: D198 — building remains a follow-up entry phase after
      // implementation has drained, with the same replacement fence as planned.
      it(
        "advances one building follow-up and preserves terminal work plus history",
        async () => {
        const fixture = await buildGoal(factory, "building", 5);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned", "done", "abandoned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const seeded = await fixture.observe(GOAL_ID);
          if (seeded.currentDraft === null) throw new Error("seeded draft missing");
          await fixture.seedReview({
            reviewId: "R20",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft: seeded.currentDraft,
            provenance: PROVENANCE_B,
          });
          await fixture.seedDecision({
            decisionId: "K20",
            goalId: GOAL_ID,
            reviewId: "R20",
            headline: "Preserve the prior planning decision",
            provenance: PROVENANCE_B,
          });
          const before = await fixture.observe(GOAL_ID);

          const results = await Promise.all([
            fixture.lifecycle.claimPlan(
              claimInput("follow-up", "building-a", OWNER_TOKEN_A, 5, PROVENANCE_A),
            ),
            fixture.lifecycle.claimPlan(
              claimInput("follow-up", "building-b", OWNER_TOKEN_B, 5, PROVENANCE_B),
            ),
          ]);
          const winners = results.filter((result) => result.ok);
          const losers = results.filter((result) => !result.ok);
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          if (winners[0] === undefined || !winners[0].ok) {
            throw new Error("building follow-up winner missing");
          }
          if (losers[0] === undefined || losers[0].ok) {
            throw new Error("building follow-up loser missing");
          }
          expect(winners[0].acknowledgement).toMatchObject({
            generation: 6,
            previousGoalPhase: "building",
            goalPhase: "planning",
          });
          expect(losers[0].conflict.code).toBe("claim-active");

          const after = await fixture.observe(GOAL_ID);
          expect(after.generation).toBe(6);
          expect(after.phase).toBe("planning");
          expect(after.tasks.map(({ status }) => status)).toEqual([
            "abandoned",
            "done",
            "abandoned",
          ]);
          expect(after.milestones.map(({ status }) => status)).toEqual(["postponed"]);
          expect(after.questions.map(({ status }) => status)).toEqual(["withdrawn"]);
          expect(after.reviews).toEqual(before.reviews);
          expect(after.decisions).toEqual(before.decisions);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      // regression: D198 — each rejected building follow-up must leave the
      // complete public state byte-identical.
      it(
        "rejects terminal, stale, and implementation-active building follow-ups without mutation",
        async () => {
        const terminal = await factory.build();
        try {
          await terminal.seedGoal({ goalId: GOAL_ID, phase: "done", generation: 5 });
          const before = await terminal.observe(GOAL_ID);
          expect(
            await terminal.lifecycle.claimPlan(
              claimInput("follow-up", "building-terminal", OWNER_TOKEN_A, 5, PROVENANCE_A),
            ),
          ).toEqual({
            ok: false,
            conflict: { code: "goal-terminal", goalId: GOAL_ID, status: "done" },
          });
          expect(await terminal.observe(GOAL_ID)).toEqual(before);
        } finally {
          await terminal.dispose();
        }

        const abandoned = await factory.build();
        try {
          await abandoned.seedGoal({
            goalId: GOAL_ID,
            phase: "abandoned",
            generation: 5,
          });
          const before = await abandoned.observe(GOAL_ID);
          expect(
            await abandoned.lifecycle.claimPlan(
                claimInput("follow-up", "building-abandoned", OWNER_TOKEN_A, 5, PROVENANCE_A),
            ),
          ).toEqual({
            ok: false,
            conflict: {
              code: "goal-terminal",
              goalId: GOAL_ID,
              status: "abandoned",
            },
          });
          expect(await abandoned.observe(GOAL_ID)).toEqual(before);
        } finally {
          await abandoned.dispose();
        }

        const stale = await buildGoal(factory, "building", 5);
        try {
          await stale.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const before = await stale.observe(GOAL_ID);
          expect(
            await stale.lifecycle.claimPlan(
              claimInput("follow-up", "building-stale", OWNER_TOKEN_A, 4, PROVENANCE_A),
            ),
          ).toEqual({
            ok: false,
            conflict: {
              code: "stale-generation",
              goalId: GOAL_ID,
              expectedGeneration: 4,
              currentGeneration: 5,
            },
          });
          expect(await stale.observe(GOAL_ID)).toEqual(before);
        } finally {
          await stale.dispose();
        }

        const active = await buildGoal(factory, "building", 5);
        try {
          await active.seedWork(GOAL_ID, {
            taskStatuses: ["wip", "blocked"],
            openQuestionCount: 1,
            legacy: false,
          });
          const before = await active.observe(GOAL_ID);
          expect(
            await active.lifecycle.claimPlan(
              claimInput("follow-up", "building-active", OWNER_TOKEN_A, 5, PROVENANCE_A),
            ),
          ).toEqual({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: GOAL_ID,
              tasks: [
                { taskId: before.tasks[0]!.id, status: "wip" },
                { taskId: before.tasks[1]!.id, status: "blocked" },
              ],
            },
          });
          expect(await active.observe(GOAL_ID)).toEqual(before);
        } finally {
          await active.dispose();
        }
        },
        timeout,
      );

      it(
        "publishes after legacy adoption identically with and without restart",
        async () => {
        async function adoptAndPublish(restart: boolean) {
          const fixture = await buildGoal(factory, "clarifying", null);
          let restarted: PlanLifecycleContractFixture | null = null;
          let active = fixture;
          try {
            await fixture.seedWork(GOAL_ID, {
              taskStatuses: ["planned", "planned"],
              openQuestionCount: 0,
              legacy: true,
            });
            const before = await fixture.observe(GOAL_ID);
            const claim = requireClaimWinner(
              await fixture.lifecycle.claimPlan(
                  claimInput("initial", "legacy-adoption", OWNER_TOKEN_A, null, PROVENANCE_A),
              ),
            );
            expect(claim).toMatchObject({
              legacyAdopted: true,
              adoptedManifest: {
                milestoneIds: before.milestones.map(({ id }) => id),
                taskIds: before.tasks.map(({ id }) => id),
              },
            });
            if (restart) {
              restarted = await fixture.restart();
              active = restarted;
            }

            const published = await active.lifecycle.publishPlanDraft(
              publishInput(claim, "publish-legacy-adoption"),
            );
            if (!published.ok) {
              throw new Error("legacy-adoption publication unexpectedly conflicted");
            }
            const state = await active.observe(GOAL_ID);
            const adoptedMilestoneIds = new Set(claim.adoptedManifest.milestoneIds);
            const adoptedTaskIds = new Set(claim.adoptedManifest.taskIds);
            const publishedTaskIds = new Set(
              published.acknowledgement.manifest.tasks.map(({ id }) => id),
            );
            return {
              replacedManifest: published.acknowledgement.replacedManifest,
              adoptedMilestones: state.milestones
                .filter(({ id }) => adoptedMilestoneIds.has(id))
                .map(({ id, status }) => ({ id, status })),
              adoptedTasks: state.tasks
                .filter(({ id }) => adoptedTaskIds.has(id))
                .map(({ id, status, executable, dependsOn }) => ({
                  id,
                  status,
                  executable,
                  dependsOn,
                })),
              publishedTasks: state.tasks
                .filter(({ id }) => publishedTaskIds.has(id))
                .map(({ id, status, executable, dependsOn }) => ({
                  id,
                  status,
                  executable,
                  dependsOn,
                })),
              readyTaskIds: state.readyTaskIds,
            };
          } finally {
            if (restarted !== null) await restarted.dispose();
            await fixture.dispose();
          }
        }

        const uninterrupted = await adoptAndPublish(false);
        const restarted = await adoptAndPublish(true);

        expect(restarted).toEqual(uninterrupted);
        expect(uninterrupted).toEqual({
          replacedManifest: {
            revision: 1,
            milestones: [{ key: "seeded_milestone", id: "M1" }],
            tasks: [
              { key: "seeded_task_1", id: "T1" },
              { key: "seeded_task_2", id: "T2" },
            ],
          },
          adoptedMilestones: [{ id: "M1", status: "open" }],
          adoptedTasks: [
            { id: "T1", status: "planned", executable: true, dependsOn: [] },
            {
              id: "T2",
              status: "planned",
              executable: true,
              dependsOn: ["T1"],
            },
          ],
          publishedTasks: [
            { id: "T3", status: "planned", executable: false, dependsOn: [] },
            {
              id: "T4",
              status: "planned",
              executable: false,
              dependsOn: ["T3"],
            },
          ],
          readyTaskIds: ["T1"],
        });
        },
        timeout,
      );

      it(
        "rejects follow-up replacement when implementation is actually active",
        async () => {
        const fixture = await buildGoal(factory, "planned", 4);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["wip", "blocked"],
            openQuestionCount: 1,
            legacy: false,
          });
          const before = await fixture.observe(GOAL_ID);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "active-work", OWNER_TOKEN_A, 4, PROVENANCE_A),
          );
          expect(result).toEqual({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: GOAL_ID,
              tasks: [
                { taskId: before.tasks[0]!.id, status: "wip" },
                { taskId: before.tasks[1]!.id, status: "blocked" },
              ],
            },
          });
          expect(await fixture.observe(GOAL_ID)).toEqual(before);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "adopts only the declared legacy manifest and never abandons goal-ref orphans",
        async () => {
        const fixture = await buildGoal(factory, "planned", null);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 0,
            legacy: true,
          });
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 0,
            legacy: true,
            register: false,
          });
          const before = await fixture.observe(GOAL_ID);
          expect(before.tasks).toHaveLength(2);
          const [declaredTask, orphanTask] = before.tasks;
          if (declaredTask === undefined || orphanTask === undefined) {
            throw new Error("seeded tasks missing");
          }
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "legacy-follow-up", OWNER_TOKEN_A, null, PROVENANCE_A),
          );
          const acknowledgement = requireClaimWinner(result);
          expect(acknowledgement.legacyAdopted).toBe(true);
          expect(acknowledgement.adoptedManifest).toEqual({
            milestoneIds: [declaredTask.milestoneId],
            taskIds: [declaredTask.id],
          });
          const after = await fixture.observe(GOAL_ID);
          expect(after.phase).toBe("planning");
          expect(after.generation).toBe(1);
          // The declared work is superseded; the adopted manifest is NOT
          // installed as the new generation's executable draft.
          expect(after.milestoneIds).toEqual([]);
          expect(after.finalizedManifest).toBeNull();
          expect(after.currentDraft).toBeNull();
          const declared = after.tasks.find(({ id }) => id === declaredTask.id);
          expect(declared?.status).toBe("abandoned");
          const declaredMilestone = after.milestones.find(
            ({ id }) => id === declaredTask.milestoneId,
          );
          expect(declaredMilestone?.status).toBe("postponed");
          // The orphan references the goal but sits outside the declared
          // milestones: never adopted, never abandoned, never scanned.
          const orphan = after.tasks.find(({ id }) => id === orphanTask.id);
          expect(orphan?.status).toBe("planned");
          const orphanMilestone = after.milestones.find(
            ({ id }) => id === orphanTask.milestoneId,
          );
          expect(orphanMilestone?.status).toBe("open");
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "replaces an unstarted planned task cleanly on follow-up",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const before = await fixture.observe(GOAL_ID);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "replace-planned", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          const acknowledgement = requireClaimWinner(result);
          expect(acknowledgement.generation).toBe(2);
          const after = await fixture.observe(GOAL_ID);
          expect(after.phase).toBe("planning");
          expect(after.tasks.map(({ status }) => status)).toEqual(["abandoned"]);
          expect(after.milestones.map(({ status }) => status)).toEqual(["postponed"]);
          expect(after.questions.map(({ status }) => status)).toEqual(["withdrawn"]);
          expect(after.milestoneIds).toEqual([]);
          expect(after.finalizedManifest).toBeNull();
          expect(before.tasks[0]?.dependsOn).toEqual([]);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "replaces a planned task whose dependencies are merely unsatisfied",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned", "planned"],
            openQuestionCount: 0,
            legacy: false,
          });
          const before = await fixture.observe(GOAL_ID);
          // The second task could never have started: its dependency is not done.
          expect(before.tasks[1]?.dependsOn).toEqual([before.tasks[0]!.id]);
          expect(before.readyTaskIds).toEqual([before.tasks[0]!.id]);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "replace-chained", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          requireClaimWinner(result);
          const after = await fixture.observe(GOAL_ID);
            expect(after.tasks.map(({ status }) => status)).toEqual(["abandoned", "abandoned"]);
          // The dangling dependency edge into superseded work is reconciled.
          expect(after.tasks[1]?.dependsOn).toEqual([]);
          expect(after.milestones.map(({ status }) => status)).toEqual(["postponed"]);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "rejects follow-up on a wip task without touching linked questions or backlinks",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["wip", "planned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const before = await fixture.observe(GOAL_ID);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "reject-wip", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          expect(result).toEqual({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: GOAL_ID,
              tasks: [{ taskId: before.tasks[0]!.id, status: "wip" }],
            },
          });
          expect(await fixture.observe(GOAL_ID)).toEqual(before);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "rejects follow-up on a task blocked straight from planned, byte-identically",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const seeded = await fixture.observe(GOAL_ID);
          await fixture.blockTask(seeded.tasks[0]!.id, PROVENANCE_B);
          const before = await fixture.observe(GOAL_ID);
          expect(before.tasks[0]?.status).toBe("blocked");
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "reject-blocked-planned", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          expect(result).toEqual({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: GOAL_ID,
              tasks: [{ taskId: before.tasks[0]!.id, status: "blocked" }],
            },
          });
          // The blocked task retains its linked open question and the goal's
          // declared manifest: rejection is mutation-free.
          expect(await fixture.observe(GOAL_ID)).toEqual(before);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "rejects follow-up on a task blocked from wip, byte-identically",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned"],
            openQuestionCount: 1,
            legacy: false,
          });
          const seeded = await fixture.observe(GOAL_ID);
          await fixture.startTask(seeded.tasks[0]!.id, PROVENANCE_B);
          await fixture.blockTask(seeded.tasks[0]!.id, PROVENANCE_B);
          const before = await fixture.observe(GOAL_ID);
          expect(before.tasks[0]?.status).toBe("blocked");
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "reject-blocked-wip", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          expect(result).toEqual({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: GOAL_ID,
              tasks: [{ taskId: before.tasks[0]!.id, status: "blocked" }],
            },
          });
          expect(await fixture.observe(GOAL_ID)).toEqual(before);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "reopens a drained manifest normally",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["done", "abandoned"],
            openQuestionCount: 0,
            legacy: false,
          });
          const before = await fixture.observe(GOAL_ID);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "reopen-drained", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          const claim = requireClaimWinner(result);
          expect(claim.generation).toBe(2);
          const drained = await fixture.observe(GOAL_ID);
          // Nothing was left to terminalize; the drained tasks are untouched.
            expect(drained.tasks.map(({ status }) => status)).toEqual(["done", "abandoned"]);
          expect(drained.milestones.map(({ status }) => status)).toEqual(["postponed"]);
          expect(drained.phase).toBe("planning");

          // …and the reopened goal plans and finalizes a fresh manifest.
          const published = await fixture.lifecycle.publishPlanDraft(
            publishInput(claim, "reopen-draft"),
          );
          if (!published.ok) throw new Error("draft publication unexpectedly conflicted");
          const draft: PlanDraftIdentity = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            revision: published.acknowledgement.manifest.revision,
          };
          await fixture.seedReview({
            reviewId: "R91",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft,
            provenance: PROVENANCE_B,
          });
          const finalized = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "reopen-finalize",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R91",
            draftRevision: draft.revision,
            decision: { headline: "Reopen with a fresh manifest" },
          });
          if (!finalized.ok) throw new Error("finalize unexpectedly conflicted");
          const reopened = await fixture.observe(GOAL_ID);
          expect(reopened.phase).toBe("planned");
          expect(reopened.readyTaskIds).toEqual([
            finalized.acknowledgement.manifest.tasks[0]!.id,
          ]);
          // The drained tasks stayed terminal and outside the new manifest.
            expect(reopened.tasks.find(({ id }) => id === before.tasks[0]!.id)?.status).toBe(
              "done",
            );
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "withdraws only questions owned solely by superseded work and strips dangling backlinks",
        async () => {
        const fixture = await buildGoal(factory, "planned", 1);
        try {
          await fixture.seedGoal({
            goalId: OTHER_GOAL_ID,
            phase: "clarifying",
            generation: null,
          });
          await fixture.seedWork(GOAL_ID, {
            taskStatuses: ["planned", "planned"],
            openQuestionCount: 0,
            legacy: false,
          });
          const seeded = await fixture.observe(GOAL_ID);
          const [first, second] = seeded.tasks;
          if (first === undefined || second === undefined) {
            throw new Error("seeded tasks missing");
          }
          await fixture.seedQuestion(GOAL_ID, [`goals:${GOAL_ID}`]);
          await fixture.seedQuestion(GOAL_ID, [`goals:${GOAL_ID}`, `tasks:${second.id}`]);
          await fixture.seedQuestion(GOAL_ID, [`goals:${GOAL_ID}`, `goals:${OTHER_GOAL_ID}`]);
          await fixture.seedQuestion(GOAL_ID, [
            `goals:${GOAL_ID}`,
            `tasks:${second.id}`,
            `goals:${OTHER_GOAL_ID}`,
          ]);
          const result = await fixture.lifecycle.claimPlan(
            claimInput("follow-up", "reconcile-questions", OWNER_TOKEN_A, 1, PROVENANCE_A),
          );
          requireClaimWinner(result);
          const after = await fixture.observe(GOAL_ID);
            expect(after.tasks.map(({ status }) => status)).toEqual(["abandoned", "abandoned"]);
          const [soleGoal, soleWork, shared, sharedStripped] = after.questions;
          // Owned solely by the goal's superseded work: withdrawn with it.
          expect(soleGoal?.status).toBe("withdrawn");
          expect(soleWork?.status).toBe("withdrawn");
          // Shared with a live goal: survives, refs untouched.
          expect(shared?.status).toBe("open");
          expect(shared?.ledgerRefs).toEqual([`goals:${GOAL_ID}`, `goals:${OTHER_GOAL_ID}`]);
          // Shared, but carrying a backlink into the superseded manifest: the
          // question survives and the dangling backlink is reconciled away.
          expect(sharedStripped?.status).toBe("open");
          expect(sharedStripped?.ledgerRefs).toEqual([
            `goals:${GOAL_ID}`,
            `goals:${OTHER_GOAL_ID}`,
          ]);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "rejects an opposite contender at the armed serialization boundary",
        async () => {
          const fixture = await buildGoal(factory, "planned", 1);
          try {
            await fixture.seedWork(GOAL_ID, {
              taskStatuses: ["planned"],
              openQuestionCount: 1,
              legacy: false,
            });
            const before = await fixture.observe(GOAL_ID);
            let peerStarted = false;
            await expect(
              fixture.raceAtSerializationBoundary(
                "task-start",
                () =>
                  fixture.lifecycle.claimPlan(
                    claimInput("follow-up", "opposite-contender", OWNER_TOKEN_A, 1, PROVENANCE_A),
                  ),
                async () => {
                  peerStarted = true;
                  await fixture.startTask(before.tasks[0]!.id, PROVENANCE_B);
                },
              ),
            ).rejects.toThrow(/expected task-start, received follow-up-claim/);
            expect(peerStarted).toBe(false);
            expect(await fixture.observe(GOAL_ID)).toEqual(before);
          } finally {
            await fixture.dispose();
          }
        },
        timeout,
      );

      it(
        "settles a task start racing a follow-up claim to exactly one authority",
        async () => {
        for (const headStart of ["starter", "replacer"] as const) {
          const fixture = await buildGoal(factory, "planned", 1);
          try {
            await fixture.seedWork(GOAL_ID, {
              taskStatuses: ["planned"],
              openQuestionCount: 1,
              legacy: false,
            });
            const seeded = await fixture.observe(GOAL_ID);
            const taskId = seeded.tasks[0]!.id;
            const start = () =>
              fixture.startTask(taskId, PROVENANCE_B).then(
                () => "started" as const,
                () => "rejected" as const,
              );
            const claim = () =>
              fixture.lifecycle.claimPlan(
                claimInput("follow-up", `race-${headStart}`, OWNER_TOKEN_A, 1, PROVENANCE_A),
              );
              let startOutcome: Awaited<ReturnType<typeof start>>;
              let claimOutcome: Awaited<ReturnType<typeof claim>>;
              if (headStart === "starter") {
                const raced = await fixture.raceAtSerializationBoundary("task-start", start, claim);
                expect(raced.arrivals).toEqual(["task-start"]);
                startOutcome = raced.holder;
                claimOutcome = raced.peer;
              } else {
                const raced = await fixture.raceAtSerializationBoundary(
                  "follow-up-claim",
                  claim,
                  start,
                );
                expect(raced.arrivals).toEqual(["follow-up-claim"]);
                claimOutcome = raced.holder;
                startOutcome = raced.peer;
              }
            const after = await fixture.observe(GOAL_ID);
              if (headStart === "replacer") {
                expect(claimOutcome.ok).toBe(true);
                if (!claimOutcome.ok) {
                  throw new Error(`replacement lost with ${claimOutcome.conflict.code}`);
                }
              expect(startOutcome).toBe("rejected");
              expect(after.tasks[0]?.status).toBe("abandoned");
              expect(after.generation).toBe(2);
              expect(after.phase).toBe("planning");
            } else {
              expect(startOutcome).toBe("started");
                expect(claimOutcome.ok).toBe(false);
                if (claimOutcome.ok) {
                  throw new Error("starter head start unexpectedly lost");
                }
                expect(claimOutcome.conflict).toEqual({
                  code: "implementation-active",
                  goalId: GOAL_ID,
                  tasks: [{ taskId, status: "wip" }],
                });
              expect(after.tasks[0]?.status).toBe("wip");
              expect(after.generation).toBe(1);
              expect(after.phase).toBe("planned");
              expect(after.questions.map(({ status }) => status)).toEqual(["open"]);
            }
          } finally {
            await fixture.dispose();
          }
        }
        },
        timeout,
      );

      it(
        "settles a wip-to-blocked park racing a follow-up claim to one rejection",
        async () => {
        for (const headStart of ["block", "claim"] as const) {
          const fixture = await buildGoal(factory, "planned", 1);
          try {
            await fixture.seedWork(GOAL_ID, {
              taskStatuses: ["wip"],
              openQuestionCount: 1,
              legacy: false,
            });
            const seeded = await fixture.observe(GOAL_ID);
            const taskId = seeded.tasks[0]!.id;
            const block = () =>
              fixture.blockTask(taskId, PROVENANCE_B).then(
                () => "blocked" as const,
                () => "rejected" as const,
              );
            const claim = () =>
              fixture.lifecycle.claimPlan(
                claimInput("follow-up", `race-${headStart}`, OWNER_TOKEN_A, 1, PROVENANCE_A),
              );
              let blockOutcome: Awaited<ReturnType<typeof block>>;
              let claimOutcome: Awaited<ReturnType<typeof claim>>;
              if (headStart === "block") {
                const raced = await fixture.raceAtSerializationBoundary("task-block", block, claim);
                expect(raced.arrivals).toEqual(["task-block"]);
                blockOutcome = raced.holder;
                claimOutcome = raced.peer;
              } else {
                const raced = await fixture.raceAtSerializationBoundary(
                  "follow-up-claim",
                  claim,
                  block,
                );
                expect(raced.arrivals).toEqual(["follow-up-claim"]);
                claimOutcome = raced.holder;
                blockOutcome = raced.peer;
              }
            // Whichever serialized first, the follow-up can NEVER supersede
            // active work: the claim is refused, the park commits, and the
            // linked question stays open.
            expect(blockOutcome).toBe("blocked");
            expect(claimOutcome.ok).toBe(false);
            if (claimOutcome.ok) {
              throw new Error("follow-up unexpectedly superseded active work");
            }
            expect(claimOutcome.conflict).toEqual({
              code: "implementation-active",
              goalId: GOAL_ID,
                tasks: [{ taskId, status: headStart === "block" ? "blocked" : "wip" }],
            });
            const after = await fixture.observe(GOAL_ID);
            expect(after.tasks[0]?.status).toBe("blocked");
            expect(after.generation).toBe(1);
            expect(after.phase).toBe("planned");
            expect(after.milestoneIds).toEqual(seeded.milestoneIds);
            expect(after.questions.map(({ status }) => status)).toEqual(["open"]);
            expect(after.milestones.map(({ status }) => status)).toEqual(["open"]);
          } finally {
            await fixture.dispose();
          }
        }
        },
        timeout,
      );

      it(
        "publishes a complete nonactionable draft with reciprocal links and exact replay",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "publish", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const beforeInvalid = await fixture.observe(GOAL_ID);
          await expect(
            fixture.lifecycle.publishPlanDraft({
              ...publishInput(claim, "invalid-publish"),
              manifest: {
                milestones: [{ key: "declared", title: "Declared" }],
                tasks: [
                  {
                    key: "orphan",
                    milestoneKey: "missing",
                    headline: "Must reject the whole manifest",
                  },
                ],
              },
            } as never),
          ).rejects.toThrow();
          expect(await fixture.observe(GOAL_ID)).toEqual(beforeInvalid);

          const input: PlanPublishDraftInput = {
            ...publishInput(claim, "publish-1"),
            reviewDefects: {
              reviewId: "R1",
              defects: [
                {
                  key: "guard",
                  headline: "Guard the write",
                  severity: "high",
                },
              ],
            },
          };
          const first = await fixture.lifecycle.publishPlanDraft(input);
          if (!first.ok) throw new Error("draft publication unexpectedly conflicted");
          expect(first.acknowledgement.manifest).toMatchObject({ revision: 1 });
          expect(first.acknowledgement.reviewDefects).toHaveLength(1);

          const state = await fixture.observe(GOAL_ID);
          const milestone = state.milestones[0];
          expect(milestone?.taskIds).toEqual(state.tasks.map(({ id }) => id));
          expect(state.tasks.every(({ goalId }) => goalId === GOAL_ID)).toBe(true);
            expect(state.tasks.every(({ milestoneId }) => milestoneId === milestone?.id)).toBe(
              true,
            );
            expect(state.tasks.map(({ executable }) => executable)).toEqual([false, false]);
          expect(state.readyTaskIds).toEqual([]);
          expect(state.tasks.map(({ provenance }) => provenance)).toEqual([
            PROVENANCE_A,
            PROVENANCE_A,
          ]);
          expect(state.defects[0]).toMatchObject({
            goalId: GOAL_ID,
            reviewId: "R1",
            severity: "high",
            provenance: PROVENANCE_A,
          });
            await expect(fixture.startTask(state.tasks[0]!.id, PROVENANCE_B)).rejects.toThrow(
              /draft|superseded/,
            );

          const restarted = await fixture.restart();
          expect(await restarted.lifecycle.publishPlanDraft(input)).toEqual({
            ...first,
            replayed: true,
          });
          expect(
            await restarted.lifecycle.publishPlanDraft({
              ...input,
              manifest: {
                ...input.manifest,
                tasks: [
                  {
                    ...input.manifest.tasks[0]!,
                    headline: "changed under the same operation id",
                  },
                ],
              },
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "idempotency-key-reused",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              operation: "publish-draft",
              operationId: "publish-1",
            },
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "preserves complete manifest fields and supersedes an independent prior draft",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "rich-replacement", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const first = await fixture.lifecycle.publishPlanDraft(
            publishInput(claim, "rich-draft", RICH_MANIFEST),
          );
          if (!first.ok) throw new Error("rich draft publication unexpectedly conflicted");
            expect(
              await fixture.lifecycle.publishPlanDraft(
                publishInput(claim, "rich-draft", RICH_MANIFEST),
              ),
            ).toEqual({ ...first, replayed: true });
          const firstMilestones = Object.fromEntries(
            first.acknowledgement.manifest.milestones.map(({ key, id }) => [key, id]),
          );
          const firstTasks = Object.fromEntries(
            first.acknowledgement.manifest.tasks.map(({ key, id }) => [key, id]),
          );
          const firstState = await fixture.observe(GOAL_ID);
          expect(firstState.currentDraft?.revision).toBe(1);
          expect(firstState.milestones).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: firstMilestones["design"],
                goalId: GOAL_ID,
                title: "Design guarded planning",
                description: "Preserve every milestone field",
                dependsOn: ["researches:RS8"],
                blockedBy: [firstMilestones["delivery"]],
                taskIds: [firstTasks["contract"]],
                provenance: PROVENANCE_A,
              }),
              expect.objectContaining({
                id: firstMilestones["delivery"],
                goalId: GOAL_ID,
                description: "Own the implementation tasks",
                dependsOn: [firstMilestones["design"]],
                blockedBy: ["questions:Q1"],
                taskIds: [firstTasks["implementation"]],
                provenance: PROVENANCE_A,
              }),
            ]),
          );
          expect(firstState.tasks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: firstTasks["contract"],
                goalId: GOAL_ID,
                milestoneId: firstMilestones["design"],
                description: "Retain the task description",
                acceptance: "The contract remains unchanged across adapters",
                suggestedModel: "frontier",
                  ledgerRefs: ["goals:G1", "defects:D264"],
                  sourceRefs: ["nix/pkg/cq-ledgers/packages/ledger/src/planLifecycle.ts"],
                tags: ["contract", "guarded"],
                dependsOn: [firstMilestones["design"], "researches:RS8"],
                blockedBy: [firstTasks["implementation"]],
                executable: false,
                provenance: PROVENANCE_A,
              }),
              expect.objectContaining({
                id: firstTasks["implementation"],
                goalId: GOAL_ID,
                milestoneId: firstMilestones["delivery"],
                description: "Retain implementation metadata",
                acceptance: "Only the finalized current draft becomes executable",
                suggestedModel: "frontier",
                  ledgerRefs: ["goals:G1", "defects:D264"],
                sourceRefs: ["tasks:T846"],
                tags: ["implementation"],
                dependsOn: [firstTasks["contract"]],
                blockedBy: ["questions:Q2"],
                executable: false,
                provenance: PROVENANCE_A,
              }),
            ]),
          );
          const replacement = await fixture.lifecycle.publishPlanDraft(
            publishInput(claim, "replacement-draft", COMPLETE_MANIFEST),
          );
          if (!replacement.ok) {
            throw new Error("replacement draft publication unexpectedly conflicted");
          }
          expect(replacement.acknowledgement.manifest.revision).toBe(2);
          expect(replacement.acknowledgement.replacedManifest).toEqual(
            first.acknowledgement.manifest,
          );
          const replacementTaskIds = replacement.acknowledgement.manifest.tasks.map(
            ({ id }) => id,
          );
          const replacedState = await fixture.observe(GOAL_ID);
          expect(replacedState.currentDraft?.revision).toBe(2);
          expect(
            replacedState.tasks
              .filter(({ id }) => Object.values(firstTasks).includes(id))
              .map(({ status, executable }) => ({ status, executable })),
          ).toEqual([
            { status: "abandoned", executable: false },
            { status: "abandoned", executable: false },
          ]);
          expect(
            replacedState.milestones
              .filter(({ id }) => Object.values(firstMilestones).includes(id))
              .map(({ status }) => status),
          ).toEqual(["postponed", "postponed"]);
          const supersededIds = new Set([
            ...Object.values(firstMilestones),
            ...Object.values(firstTasks),
          ]);
          for (const item of [...replacedState.milestones, ...replacedState.tasks]) {
            expect(
              [...item.dependsOn, ...item.blockedBy].some((id) => supersededIds.has(id)),
            ).toBe(false);
          }
          expect(
            replacedState.tasks
              .filter(({ id }) => replacementTaskIds.includes(id))
                .map(({ executable, ledgerRefs }) => ({ executable, ledgerRefs })),
            ).toEqual([
              { executable: false, ledgerRefs: ["goals:G1"] },
              { executable: false, ledgerRefs: ["goals:G1"] },
            ]);

          const draft = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            revision: replacement.acknowledgement.manifest.revision,
          };
          await fixture.seedReview({
            reviewId: "R4",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft,
            provenance: PROVENANCE_B,
          });
          const finalized = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "finalize-replacement",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R4",
            draftRevision: draft.revision,
            decision: { headline: "Finalize only the replacement" },
          });
          if (!finalized.ok) throw new Error("replacement finalize unexpectedly conflicted");
          const finalizedState = await fixture.observe(GOAL_ID);
          expect(finalizedState.milestoneIds).toEqual(
            replacement.acknowledgement.manifest.milestones.map(({ id }) => id),
          );
          expect(
            finalizedState.tasks
              .filter(({ id }) => Object.values(firstTasks).includes(id))
              .map(({ executable }) => executable),
          ).toEqual([false, false]);
          expect(finalizedState.readyTaskIds).toEqual([replacementTaskIds[0]!]);
            expect(
              finalizedState.tasks
                .filter(({ id }) => replacementTaskIds.includes(id))
                .map(({ ledgerRefs }) => ledgerRefs),
            ).toEqual([["goals:G1"], ["goals:G1"]]);
            await expect(fixture.startTask(firstTasks["contract"]!, PROVENANCE_B)).rejects.toThrow(
              /draft|superseded/,
            );
          // A superseded task is TERMINAL (abandoned), so the raw reopen path —
          // a write path distinct from updateItem — must carry the same fence.
          expect(
              finalizedState.tasks.find(({ id }) => id === firstTasks["contract"])?.status,
          ).toBe("abandoned");
            await expect(fixture.rawReopenTask(firstTasks["contract"]!, "planned")).rejects.toThrow(
              /draft|superseded/,
            );
          expect(await fixture.observe(GOAL_ID)).toEqual(finalizedState);
            const restartedAfterFinalize = await fixture.restart();
            try {
              const restartedTasks = (await restartedAfterFinalize.observe(GOAL_ID)).tasks;
              expect(
                restartedTasks
                  .filter(({ id }) => Object.values(firstTasks).includes(id))
                  .map(({ ledgerRefs, sourceRefs }) => ({ ledgerRefs, sourceRefs })),
              ).toEqual([
                {
                  ledgerRefs: ["goals:G1", "defects:D264"],
                  sourceRefs: ["nix/pkg/cq-ledgers/packages/ledger/src/planLifecycle.ts"],
                },
                {
                  ledgerRefs: ["goals:G1", "defects:D264"],
                  sourceRefs: ["tasks:T846"],
                },
              ]);
              expect(
                restartedTasks
                  .filter(({ id }) => replacementTaskIds.includes(id))
                  .map(({ ledgerRefs }) => ledgerRefs),
              ).toEqual([["goals:G1"], ["goals:G1"]]);
            } finally {
              await restartedAfterFinalize.dispose();
            }
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "partitions operation idempotency scopes and rejects stale or raw bypass writes",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "scopes", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const publish = publishInput(claim, "shared-operation");
          expect((await fixture.lifecycle.publishPlanDraft(publish)).ok).toBe(true);
          const beforeBypass = await fixture.observe(GOAL_ID);
          await expect(fixture.rawMutateManagedState(GOAL_ID)).rejects.toThrow(
            /only through PlanLifecycleStore/,
          );
          expect(await fixture.observe(GOAL_ID)).toEqual(beforeBypass);

          expect(
            await fixture.lifecycle.publishPlanDraft({
              ...publish,
              ownerFenceToken: OWNER_TOKEN_B,
              operationId: "wrong-owner",
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "owner-fence-mismatch",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
            },
          });

          const release = await fixture.lifecycle.releasePlanClaim({
            kind: "abandon",
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "shared-operation",
            reason: "same operation id, independent release scope",
            ...PROVENANCE_B,
          });
          expect(release.ok).toBe(true);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "commits question and defect effects atomically with release and provenance",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "questions", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const invalid = {
            kind: "pause",
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "invalid-pause",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            effect: {
              kind: "questions",
              questions: [
                { key: "duplicate", question: "First?" },
                { key: "duplicate", question: "Second?" },
              ],
            },
          };
          const before = await fixture.observe(GOAL_ID);
            await expect(fixture.lifecycle.releasePlanClaim(invalid as never)).rejects.toThrow();
          expect(await fixture.observe(GOAL_ID)).toEqual(before);

          const input: Extract<PlanReleaseInput, { kind: "pause" }> = {
            kind: "pause",
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "question-pause",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            effect: {
              kind: "questions",
              questions: [
                {
                  key: "policy",
                  question: "Which policy?",
                  context: "Only the user can select this requirement",
                  suggestions: ["strict", "permissive"],
                  recommendation: "strict",
                },
              ],
            },
            reviewDefects: {
              reviewId: "R2",
              defects: [
                {
                  key: "ambiguity",
                  headline: "Policy is ambiguous",
                  severity: "medium",
                  description: "The requirements permit two policies",
                  rootCause: "No preference was recorded",
                  suggestedFix: "Ask the user",
                  sourceRefs: ["goals:G1"],
                  tags: ["requirements"],
                },
              ],
            },
          };
          const first = await fixture.lifecycle.releasePlanClaim(input);
          if (!first.ok || first.acknowledgement.kind !== "questions") {
            throw new Error("question pause unexpectedly conflicted");
          }
          const state = await fixture.observe(GOAL_ID);
          expect(state.phase).toBe("clarifying");
          expect(state.activeClaim).toBeNull();
          expect(state.questions).toHaveLength(1);
          expect(state.questions[0]).toMatchObject({
            id: first.acknowledgement.questions[0]!.id,
            goalId: GOAL_ID,
            text: "Which policy?",
            context: "Only the user can select this requirement",
            suggestions: ["strict", "permissive"],
            recommendation: "strict",
            provenance: PROVENANCE_A,
          });
          expect(state.defects).toHaveLength(1);
          expect(state.defects[0]).toMatchObject({
            id: first.acknowledgement.reviewDefects[0]!.id,
            goalId: GOAL_ID,
            reviewId: "R2",
            description: "The requirements permit two policies",
            rootCause: "No preference was recorded",
            suggestedFix: "Ask the user",
            sourceRefs: ["goals:G1"],
            tags: ["requirements"],
            provenance: PROVENANCE_A,
          });
          const restarted = await fixture.restart();
          expect(await restarted.lifecycle.releasePlanClaim(input)).toEqual({
            ...first,
            replayed: true,
          });
          expect(
            await restarted.lifecycle.releasePlanClaim({
              ...input,
              effect: {
                kind: "questions",
                questions: [{ key: "changed", question: "Changed retry?" }],
              },
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "idempotency-key-reused",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              operation: "release",
              operationId: "question-pause",
            },
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "replays a multi-defect publish batch with identical ids, links, and provenance",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "multi-defect", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const input: PlanPublishDraftInput = {
            ...publishInput(claim, "multi-defect-publish"),
            reviewDefects: {
              reviewId: "R7",
              defects: [
                {
                  key: "lost_response",
                  headline: "A lost publish response must not double-file",
                  severity: "critical",
                  rootCause: "The response was lost after the batch committed",
                  suggestedFix: "Replay the recorded allocation exactly",
                },
                {
                  key: "unlinked_defect",
                  headline: "A filed defect must link its goal and review",
                  severity: "high",
                  sourceRefs: ["reviews:R7"],
                  tags: ["guard"],
                },
              ],
            },
          };
          const first = await fixture.lifecycle.publishPlanDraft(input);
          if (!first.ok) throw new Error("multi-defect publish unexpectedly conflicted");
          expect(first.acknowledgement.reviewDefects).toHaveLength(2);
          const allocatedIds = first.acknowledgement.reviewDefects.map(({ id }) => id);
          expect(new Set(allocatedIds).size).toBe(2);

          const state = await fixture.observe(GOAL_ID);
          expect(state.defects).toHaveLength(2);
            for (const [index, allocation] of first.acknowledgement.reviewDefects.entries()) {
            expect(state.defects[index]).toMatchObject({
              id: allocation.id,
              goalId: GOAL_ID,
              reviewId: "R7",
              provenance: PROVENANCE_A,
            });
          }

          // The exact retry — same operationId AND same payload, across a
          // restart — replays the recorded acknowledgement verbatim: SAME
          // allocated defect ids, and no defect is re-filed.
          const restarted = await fixture.restart();
          const replay = await restarted.lifecycle.publishPlanDraft(input);
          expect(replay).toEqual({ ...first, replayed: true });
          if (!replay.ok) throw new Error("multi-defect replay unexpectedly conflicted");
          expect(replay.acknowledgement.reviewDefects).toEqual(
            first.acknowledgement.reviewDefects,
          );
          const replayed = await restarted.observe(GOAL_ID);
          expect(replayed.defects).toEqual(state.defects);
          expect([...replayed.defects.map(({ id }) => id)].sort()).toEqual(
            [...allocatedIds].sort(),
          );
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "persists research waits and suppresses claims until every wait is terminal",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "research", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const release = await fixture.lifecycle.releasePlanClaim({
            kind: "pause",
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "research-pause",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            effect: {
              kind: "researches",
              researches: [
                {
                  key: "probe",
                  question: "Does it work?",
                  scope: "Exercise the public lifecycle boundary",
                },
              ],
            },
          });
          if (!release.ok || release.acknowledgement.kind !== "researches") {
            throw new Error("research pause unexpectedly conflicted");
          }
          const researchId = release.acknowledgement.researches[0]!.id;
          const waiting = await fixture.observe(GOAL_ID);
          expect(waiting.waitingResearches).toEqual([researchId]);
          expect(waiting.researches).toEqual([
            expect.objectContaining({
              id: researchId,
              goalId: GOAL_ID,
              text: "Does it work?",
              scope: "Exercise the public lifecycle boundary",
              provenance: PROVENANCE_A,
            }),
          ]);
          const suppressed = await fixture.lifecycle.claimPlan(
            claimInput("initial", "resume", OWNER_TOKEN_B, 1, PROVENANCE_B),
          );
          expect(suppressed).toEqual({
            ok: false,
            conflict: {
              code: "research-wait-active",
              goalId: GOAL_ID,
              researchIds: [researchId],
            },
          });
          await fixture.setResearchStatus(researchId, "concluded");
          const resumed = await fixture.lifecycle.claimPlan(
            claimInput("initial", "resume", OWNER_TOKEN_B, 1, PROVENANCE_B),
          );
          expect(resumed.ok).toBe(true);
          expect((await fixture.observe(GOAL_ID)).waitingResearches).toEqual([]);
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "reacquisition preserves the current draft and clears satisfied wait metadata",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const first = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "reacquire-1", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const published = await fixture.lifecycle.publishPlanDraft(
            publishInput(first, "reacquire-draft"),
          );
          if (!published.ok) throw new Error("draft publication unexpectedly conflicted");
          const pause = await fixture.lifecycle.releasePlanClaim({
            kind: "pause",
            goalId: GOAL_ID,
            claimId: first.claimId,
            generation: first.generation,
            operationId: "reacquire-pause",
            ownerFenceToken: first.ownerFenceToken,
            ...PROVENANCE_A,
            effect: {
              kind: "researches",
                researches: [{ key: "probe", question: "Does the draft survive reacquisition?" }],
            },
          });
          if (!pause.ok || pause.acknowledgement.kind !== "researches") {
            throw new Error("research pause unexpectedly conflicted");
          }
          const [researchId] = pause.acknowledgement.waitingResearches;
          if (researchId === undefined) throw new Error("research allocation missing");

          // The wait suppresses re-planning until it concludes; concluding
          // SATISFIES it, so the next claim is admitted...
          await fixture.setResearchStatus(researchId, "concluded");
          const second = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "reacquire-2", OWNER_TOKEN_B, 1, PROVENANCE_B),
            ),
          );
          expect(second.generation).toBe(2);
          const state = await fixture.observe(GOAL_ID);
          // ...the prior generation's draft is PRESERVED for the new round to
          // revise (never reset by reacquisition)...
          expect(state.currentDraft).toEqual({
            goalId: GOAL_ID,
            claimId: first.claimId,
            generation: first.generation,
            revision: 1,
          });
          // ...and the satisfied wait metadata is cleared.
          expect(state.waitingResearches).toEqual([]);

          // Revision CONTINUES from the preserved draft: the next publish
          // supersedes it and reports the preserved manifest as replaced.
          const revised = await fixture.lifecycle.publishPlanDraft(
            publishInput(second, "reacquire-revised"),
          );
          if (!revised.ok) throw new Error("revision unexpectedly conflicted");
          expect(revised.acknowledgement.manifest.revision).toBe(2);
          expect(revised.acknowledgement.replacedManifest).toEqual(
            published.acknowledgement.manifest,
          );
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "supports exact tokenless abandonment with an atomic defect batch",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "abandon", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const stale = await fixture.lifecycle.releasePlanClaim({
            kind: "abandon",
            goalId: GOAL_ID,
            claimId: "other-claim",
            generation: claim.generation,
            operationId: "stale-abandon",
            reason: "must not release a different claim",
            ...PROVENANCE_B,
          });
          expect(stale.ok).toBe(false);
          if (stale.ok) throw new Error("stale abandonment unexpectedly succeeded");
          expect(stale.conflict.code).toBe("stale-claim");
            expect((await fixture.observe(GOAL_ID)).activeClaim?.claimId).toBe(claim.claimId);

          const input: Extract<PlanReleaseInput, { kind: "abandon" }> = {
            kind: "abandon",
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "exact-abandon",
            reason: "recover after response loss",
            ...PROVENANCE_B,
            reviewDefects: {
              reviewId: "R3",
              defects: [
                {
                  key: "lost",
                  headline: "Planner response was lost",
                  severity: "low",
                },
              ],
            },
          };
          const first = await fixture.lifecycle.releasePlanClaim(input);
          if (!first.ok) throw new Error("exact abandonment unexpectedly conflicted");
          const state = await fixture.observe(GOAL_ID);
          expect(state.activeClaim).toBeNull();
          expect(state.defects).toHaveLength(1);
          expect(state.defects[0]).toMatchObject({
            reviewId: "R3",
            provenance: PROVENANCE_B,
          });
          const restarted = await fixture.restart();
          expect(await restarted.lifecycle.releasePlanClaim(input)).toEqual({
            ...first,
            replayed: true,
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "binds finalize to the exact approved draft and atomically fences task start",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const claim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "finalize", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const published = await fixture.lifecycle.publishPlanDraft(
            publishInput(claim, "publish-final"),
          );
          if (!published.ok) throw new Error("draft publication unexpectedly conflicted");
          const draft: PlanDraftIdentity = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            revision: published.acknowledgement.manifest.revision,
          };
          await fixture.seedGoal({
            goalId: OTHER_GOAL_ID,
            phase: "clarifying",
            generation: null,
          });
          await fixture.seedReview({
            reviewId: "R7",
            goalId: OTHER_GOAL_ID,
            status: "go-ahead",
            draft: { ...draft, goalId: OTHER_GOAL_ID },
            provenance: PROVENANCE_B,
          });
          await fixture.seedReview({
            reviewId: "R8",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft: { ...draft, generation: draft.generation + 1 },
            provenance: PROVENANCE_B,
          });
          await fixture.seedReview({
            reviewId: "R9",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft: { ...draft, claimId: "different_claim" },
            provenance: PROVENANCE_B,
          });
          await fixture.seedReview({
            reviewId: "R10",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft,
            provenance: PROVENANCE_B,
          });

          const goalMismatch = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "wrong-goal-binding",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R7",
            draftRevision: draft.revision,
            decision: { headline: "Must not finalize another goal" },
          });
          expect(goalMismatch.ok).toBe(false);
          if (goalMismatch.ok) {
            throw new Error("wrong-goal review unexpectedly finalized");
          }
          expect(goalMismatch.conflict.code).toBe("review-draft-mismatch");
          const generationMismatch = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "wrong-generation-binding",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R8",
            draftRevision: draft.revision,
            decision: { headline: "Must not finalize another generation" },
          });
          expect(generationMismatch.ok).toBe(false);
          if (generationMismatch.ok) {
            throw new Error("wrong-generation review unexpectedly finalized");
          }
            expect(generationMismatch.conflict.code).toBe("review-generation-mismatch");
          const claimMismatch = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "wrong-claim-binding",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R9",
            draftRevision: draft.revision,
            decision: { headline: "Must not finalize another claim" },
          });
          expect(claimMismatch.ok).toBe(false);
          if (claimMismatch.ok) {
            throw new Error("wrong-claim review unexpectedly finalized");
          }
          expect(claimMismatch.conflict.code).toBe("review-draft-mismatch");

          const beforeInvalidBatch = await fixture.observe(GOAL_ID);
          await expect(
            fixture.lifecycle.finalizePlan({
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              operationId: "invalid-finalize-batch",
              ownerFenceToken: claim.ownerFenceToken,
              ...PROVENANCE_A,
              reviewId: "R10",
              draftRevision: draft.revision,
              decision: { headline: "Invalid batch must write nothing" },
              reviewDefects: {
                reviewId: "R10",
                defects: [
                  {
                    key: "invalid",
                    headline: "Invalid severity",
                    severity: "urgent",
                  },
                ],
              },
            } as never),
          ).rejects.toThrow();
          expect(await fixture.observe(GOAL_ID)).toEqual(beforeInvalidBatch);

          const wrongRevision = await fixture.lifecycle.finalizePlan({
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "wrong-revision",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R10",
            draftRevision: draft.revision + 1,
            decision: { headline: "Must not finalize stale review" },
          });
          expect(wrongRevision.ok).toBe(false);
          if (wrongRevision.ok) throw new Error("stale review unexpectedly finalized");
          expect(wrongRevision.conflict.code).toBe("review-draft-mismatch");
          const beforeFinalize = await fixture.observe(GOAL_ID);
          expect(beforeFinalize.decisions).toEqual([]);
          expect(beforeFinalize.readyTaskIds).toEqual([]);

          const input: PlanFinalizeInput = {
            goalId: GOAL_ID,
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "finalize-exact",
            ownerFenceToken: claim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R10",
            draftRevision: draft.revision,
            decision: {
              headline: "Lock the exact reviewed draft",
              rationale: "The reviewer approved this exact identity",
              alternatives: "Re-plan and publish a later revision",
            },
            reviewDefects: {
              reviewId: "R10",
              defects: [
                {
                  key: "follow-up",
                  headline: "Track a follow-up",
                  severity: "low",
                  description: "The follow-up remains outside this finalized manifest",
                  rootCause: "The review identified deferred work",
                  suggestedFix: "Open a later planning generation",
                  sourceRefs: ["reviews:R10"],
                  tags: ["follow-up"],
                },
              ],
            },
          };
          const first = await fixture.lifecycle.finalizePlan(input);
          if (!first.ok) throw new Error("exact finalize unexpectedly conflicted");
          const state = await fixture.observe(GOAL_ID);
          expect(state.phase).toBe("planned");
          expect(state.activeClaim).toBeNull();
          expect(state.finalizedManifest).toEqual(first.acknowledgement.manifest);
          expect(state.milestoneIds).toEqual(
            first.acknowledgement.manifest.milestones.map(({ id }) => id),
          );
            expect(state.readyTaskIds).toEqual([first.acknowledgement.manifest.tasks[0]!.id]);
          expect(state.decisions[0]).toMatchObject({
            id: first.acknowledgement.decisionId,
            goalId: GOAL_ID,
            reviewId: "R10",
            text: "Lock the exact reviewed draft",
            rationale: "The reviewer approved this exact identity",
            alternatives: "Re-plan and publish a later revision",
            provenance: PROVENANCE_A,
          });
          expect(state.reviews[0]).toMatchObject({
            goalId: GOAL_ID,
            draft,
            provenance: PROVENANCE_B,
          });
          expect(state.defects[0]).toMatchObject({
            reviewId: "R10",
            description: "The follow-up remains outside this finalized manifest",
            rootCause: "The review identified deferred work",
            suggestedFix: "Open a later planning generation",
            sourceRefs: ["reviews:R10"],
            tags: ["follow-up"],
            provenance: PROVENANCE_A,
          });
          await fixture.startTask(state.readyTaskIds[0]!, PROVENANCE_B);
          await expect(
              fixture.startTask(first.acknowledgement.manifest.tasks[1]!.id, PROVENANCE_B),
          ).rejects.toThrow(/dependencies/);

          const restarted = await fixture.restart();
          expect(await restarted.lifecycle.finalizePlan(input)).toEqual({
            ...first,
            replayed: true,
          });
          expect(
            await restarted.lifecycle.finalizePlan({
              ...input,
              decision: { headline: "Changed under the same finalize id" },
            }),
          ).toEqual({
            ok: false,
            conflict: {
              code: "idempotency-key-reused",
              goalId: GOAL_ID,
              claimId: claim.claimId,
              generation: claim.generation,
              operation: "finalize",
              operationId: "finalize-exact",
            },
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "serializes concurrent publish, release, and finalize exact replays",
        async () => {
        const publishFixture = await buildGoal(factory, "clarifying", null);
        const releaseFixture = await buildGoal(factory, "clarifying", null);
        const finalizeFixture = await buildGoal(factory, "clarifying", null);
        try {
          const publishClaim = requireClaimWinner(
            await publishFixture.lifecycle.claimPlan(
              claimInput("initial", "concurrent-publish", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const publish = publishInput(publishClaim, "concurrent-publish");
          const publishResults = await Promise.all([
            publishFixture.lifecycle.publishPlanDraft(publish),
            publishFixture.lifecycle.publishPlanDraft(publish),
          ]);
          const firstPublish = publishResults[0]!;
          const replayedPublish = publishResults[1]!;
          if (!firstPublish.ok || !replayedPublish.ok) {
            throw new Error("concurrent exact publish unexpectedly conflicted");
          }
            expect([firstPublish.replayed, replayedPublish.replayed].sort()).toEqual([false, true]);
            expect(firstPublish.acknowledgement).toEqual(replayedPublish.acknowledgement);
          expect((await publishFixture.observe(GOAL_ID)).tasks).toHaveLength(2);

          const releaseClaim = requireClaimWinner(
            await releaseFixture.lifecycle.claimPlan(
              claimInput("initial", "concurrent-release", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const release: Extract<PlanReleaseInput, { kind: "pause" }> = {
            kind: "pause",
            goalId: GOAL_ID,
            claimId: releaseClaim.claimId,
            generation: releaseClaim.generation,
            operationId: "concurrent-release",
            ownerFenceToken: releaseClaim.ownerFenceToken,
            ...PROVENANCE_A,
            effect: {
              kind: "questions",
              questions: [{ key: "choice", question: "Which choice?" }],
            },
          };
          const releaseResults = await Promise.all([
            releaseFixture.lifecycle.releasePlanClaim(release),
            releaseFixture.lifecycle.releasePlanClaim(release),
          ]);
          const firstRelease = releaseResults[0]!;
          const replayedRelease = releaseResults[1]!;
          if (!firstRelease.ok || !replayedRelease.ok) {
            throw new Error("concurrent exact release unexpectedly conflicted");
          }
            expect([firstRelease.replayed, replayedRelease.replayed].sort()).toEqual([false, true]);
            expect(firstRelease.acknowledgement).toEqual(replayedRelease.acknowledgement);
          expect((await releaseFixture.observe(GOAL_ID)).questions).toHaveLength(1);

          const finalizeClaim = requireClaimWinner(
            await finalizeFixture.lifecycle.claimPlan(
              claimInput("initial", "concurrent-finalize", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          const published = await finalizeFixture.lifecycle.publishPlanDraft(
            publishInput(finalizeClaim, "publish-concurrent-finalize"),
          );
          if (!published.ok) {
            throw new Error("concurrent finalize draft publication failed");
          }
          const draft = {
            goalId: GOAL_ID,
            claimId: finalizeClaim.claimId,
            generation: finalizeClaim.generation,
            revision: published.acknowledgement.manifest.revision,
          };
          await finalizeFixture.seedReview({
            reviewId: "R11",
            goalId: GOAL_ID,
            status: "go-ahead",
            draft,
            provenance: PROVENANCE_B,
          });
          const finalize: PlanFinalizeInput = {
            goalId: GOAL_ID,
            claimId: finalizeClaim.claimId,
            generation: finalizeClaim.generation,
            operationId: "concurrent-finalize",
            ownerFenceToken: finalizeClaim.ownerFenceToken,
            ...PROVENANCE_A,
            reviewId: "R11",
            draftRevision: draft.revision,
            decision: { headline: "Commit once" },
          };
          const finalizeResults = await Promise.all([
            finalizeFixture.lifecycle.finalizePlan(finalize),
            finalizeFixture.lifecycle.finalizePlan(finalize),
          ]);
          const firstFinalize = finalizeResults[0]!;
          const replayedFinalize = finalizeResults[1]!;
          if (!firstFinalize.ok || !replayedFinalize.ok) {
            throw new Error("concurrent exact finalize unexpectedly conflicted");
          }
          expect([firstFinalize.replayed, replayedFinalize.replayed].sort()).toEqual([
            false,
            true,
          ]);
            expect(firstFinalize.acknowledgement).toEqual(replayedFinalize.acknowledgement);
          expect((await finalizeFixture.observe(GOAL_ID)).decisions).toHaveLength(1);
        } finally {
          await Promise.all([
            publishFixture.dispose(),
            releaseFixture.dispose(),
            finalizeFixture.dispose(),
          ]);
        }
        },
        timeout,
      );

      it(
        "rejects stale writes after a newer generation wins without disturbing it",
        async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const oldClaim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "old", OWNER_TOKEN_A, null, PROVENANCE_A),
            ),
          );
          await fixture.lifecycle.releasePlanClaim({
            kind: "abandon",
            goalId: GOAL_ID,
            claimId: oldClaim.claimId,
            generation: oldClaim.generation,
            operationId: "release-old",
            reason: "make room for a new generation",
            ...PROVENANCE_A,
          });
          const newClaim = requireClaimWinner(
            await fixture.lifecycle.claimPlan(
              claimInput("initial", "new", OWNER_TOKEN_B, 1, PROVENANCE_B),
            ),
          );
          const stale = await fixture.lifecycle.publishPlanDraft({
            ...publishInput(oldClaim, "stale-publish"),
          });
          expect(stale.ok).toBe(false);
          if (stale.ok) throw new Error("stale publish unexpectedly succeeded");
          expect(stale.conflict).toEqual({
            code: "stale-claim",
            goalId: GOAL_ID,
            suppliedClaimId: oldClaim.claimId,
            currentClaimId: newClaim.claimId,
            currentGeneration: newClaim.generation,
          });
          expect((await fixture.observe(GOAL_ID)).activeClaim).toMatchObject({
            claimId: newClaim.claimId,
            generation: 2,
          });
        } finally {
          await fixture.dispose();
        }
        },
        timeout,
      );

      it(
        "rejects claim and publish on an absent or terminal coordination milestone before any allocation",
        async () => {
        for (const kind of ["absent", "terminal"] as const) {
          const expectedCode =
            kind === "absent" ? "parent-milestone-absent" : "parent-milestone-terminal";

          // Claim path: a seeded goal orphaned into a legacy-inconsistent
          // parent must not produce generation, phase, claim, operation, or
          // counter changes.
          const claimFixture = await buildGoal(factory, "planning", null);
          try {
            const before = await claimFixture.observe(GOAL_ID);
            await claimFixture.seedOrphanGoal(GOAL_ID, kind);
            const rejected = await claimFixture.lifecycle.claimPlan(
              claimInput("initial", `orphan-claim-${kind}`, OWNER_TOKEN_A, null, PROVENANCE_A),
            );
            expect(rejected.ok).toBe(false);
            if (rejected.ok) throw new Error("orphaned claim unexpectedly succeeded");
            expect(rejected.conflict.code).toBe(expectedCode);
            expect(rejected.conflict.goalId).toBe(GOAL_ID);
            expect(await claimFixture.observe(GOAL_ID)).toEqual(before);
          } finally {
            await claimFixture.dispose();
          }

          // Publish path: an established active claim whose parent is then
          // orphaned must not produce a draft revision, an operation record,
          // or any id allocation; the active claim survives untouched.
          const publishFixture = await buildGoal(factory, "planning", null);
          try {
            const claim = requireClaimWinner(
              await publishFixture.lifecycle.claimPlan(
                claimInput("initial", `orphan-publish-claim-${kind}`, OWNER_TOKEN_A, null, PROVENANCE_A),
              ),
            );
            const before = await publishFixture.observe(GOAL_ID);
            await publishFixture.seedOrphanGoal(GOAL_ID, kind);
            const rejected = await publishFixture.lifecycle.publishPlanDraft(
              publishInput(claim, `orphan-publish-${kind}`),
            );
            expect(rejected.ok).toBe(false);
            if (rejected.ok) throw new Error("orphaned publish unexpectedly succeeded");
            expect(rejected.conflict.code).toBe(expectedCode);
            expect(rejected.conflict.goalId).toBe(GOAL_ID);
            expect(await publishFixture.observe(GOAL_ID)).toEqual(before);
          } finally {
            await publishFixture.dispose();
          }
        }
        },
        timeout,
      );
    },
  );
}
