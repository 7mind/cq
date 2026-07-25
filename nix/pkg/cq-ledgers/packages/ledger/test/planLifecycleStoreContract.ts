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
  phase: "clarifying" | "planning" | "planned",
  generation: number | null,
): Promise<PlanLifecycleContractFixture> {
  const fixture = await factory.build();
  await fixture.seedGoal({ goalId: GOAL_ID, phase, generation });
  return fixture;
}

export function runPlanLifecycleStoreContract(
  factory: PlanLifecycleContractFactory,
): void {
  const contractDescribe = factory.progression ? describe.skip : describe;
  const timeout = factory.progression ? 5_000 : 10_000;

  contractDescribe(
    `PlanLifecycleStore contract — ${factory.name} (${factory.classification})`,
    () => {
      it("serializes simultaneous fresh claims and exposes only the winning public fence", async () => {
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
          expect(jsonHasAuthorityMaterial(state, [OWNER_TOKEN_A, OWNER_TOKEN_B])).toBe(
            false,
          );
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("replays a lost claim response after restart from verifier-only durable state", async () => {
        const fixture = await buildGoal(factory, "clarifying", null);
        try {
          const input = claimInput(
            "initial",
            "lost-claim",
            OWNER_TOKEN_A,
            null,
            PROVENANCE_A,
          );
          const first = await fixture.lifecycle.claimPlan(input);
          if (!first.ok) throw new Error("initial claim unexpectedly conflicted");

          const restarted = await fixture.restart();
          expect(await restarted.observe(GOAL_ID)).toEqual(
            await fixture.observe(GOAL_ID),
          );
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
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("adopts declared legacy work, but fences simultaneous follow-up replacement", async () => {
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
          expect(state.tasks.map(({ status }) => status)).toEqual([
            "abandoned",
            "done",
          ]);
          expect(state.tasks[1]?.dependsOn).toEqual([]);
          expect(state.milestones.map(({ status }) => status)).toEqual([
            "postponed",
          ]);
          expect(state.questions.map(({ status }) => status)).toEqual(["withdrawn"]);
        } finally {
          await followUp.dispose();
        }
      }, timeout);

      it("rejects follow-up replacement when implementation is actually active", async () => {
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
      }, timeout);

      it("publishes a complete nonactionable draft with reciprocal links and exact replay", async () => {
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
          expect(
            state.tasks.every(({ milestoneId }) => milestoneId === milestone?.id),
          ).toBe(true);
          expect(state.tasks.map(({ executable }) => executable)).toEqual([
            false,
            false,
          ]);
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
          await expect(
            fixture.startTask(state.tasks[0]!.id, PROVENANCE_B),
          ).rejects.toThrow(/draft|superseded/);

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
      }, timeout);

      it("partitions operation idempotency scopes and rejects stale or raw bypass writes", async () => {
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
      }, timeout);

      it("commits question and defect effects atomically with release and provenance", async () => {
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
          await expect(
            fixture.lifecycle.releasePlanClaim(invalid as never),
          ).rejects.toThrow();
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
              questions: [{ key: "policy", question: "Which policy?" }],
            },
            reviewDefects: {
              reviewId: "R2",
              defects: [
                {
                  key: "ambiguity",
                  headline: "Policy is ambiguous",
                  severity: "medium",
                },
              ],
            },
          };
          const first = await fixture.lifecycle.releasePlanClaim(input);
          if (!first.ok) throw new Error("question pause unexpectedly conflicted");
          const state = await fixture.observe(GOAL_ID);
          expect(state.phase).toBe("clarifying");
          expect(state.activeClaim).toBeNull();
          expect(state.questions).toHaveLength(1);
          expect(state.questions[0]).toMatchObject({ provenance: PROVENANCE_A });
          expect(state.defects).toHaveLength(1);
          expect(state.defects[0]).toMatchObject({
            reviewId: "R2",
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
      }, timeout);

      it("persists research waits and suppresses claims until every wait is terminal", async () => {
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
              researches: [{ key: "probe", question: "Does it work?" }],
            },
          });
          if (!release.ok || release.acknowledgement.kind !== "researches") {
            throw new Error("research pause unexpectedly conflicted");
          }
          const researchId = release.acknowledgement.researches[0]!.id;
          expect((await fixture.observe(GOAL_ID)).waitingResearches).toEqual([
            researchId,
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
      }, timeout);

      it("supports exact tokenless abandonment with an atomic defect batch", async () => {
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
          expect((await fixture.observe(GOAL_ID)).activeClaim?.claimId).toBe(
            claim.claimId,
          );

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
      }, timeout);

      it("binds finalize to the exact approved draft and atomically fences task start", async () => {
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
          expect(generationMismatch.conflict.code).toBe(
            "review-generation-mismatch",
          );
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
            decision: { headline: "Lock the exact reviewed draft" },
            reviewDefects: {
              reviewId: "R10",
              defects: [
                {
                  key: "follow-up",
                  headline: "Track a follow-up",
                  severity: "low",
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
          expect(state.readyTaskIds).toEqual([
            first.acknowledgement.manifest.tasks[0]!.id,
          ]);
          expect(state.decisions[0]).toMatchObject({
            id: first.acknowledgement.decisionId,
            goalId: GOAL_ID,
            reviewId: "R10",
            provenance: PROVENANCE_A,
          });
          expect(state.reviews[0]).toMatchObject({
            goalId: GOAL_ID,
            draft,
            provenance: PROVENANCE_B,
          });
          expect(state.defects[0]).toMatchObject({
            reviewId: "R10",
            provenance: PROVENANCE_A,
          });
          await fixture.startTask(state.readyTaskIds[0]!, PROVENANCE_B);
          await expect(
            fixture.startTask(
              first.acknowledgement.manifest.tasks[1]!.id,
              PROVENANCE_B,
            ),
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
      }, timeout);

      it("rejects stale writes after a newer generation wins without disturbing it", async () => {
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
      }, timeout);
    },
  );
}
