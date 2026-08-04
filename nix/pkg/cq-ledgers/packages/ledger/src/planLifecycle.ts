/**
 * Public contract for the guarded plan lifecycle (G99 / D134).
 *
 * This module specifies wire-safe inputs, acknowledgements, conflicts, and
 * state tables. It deliberately contains no persistence or locking behavior:
 * production adapters implement the same contract in later tasks.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

const GOAL_ID_RE = /^G\d+$/;
const MILESTONE_ID_RE = /^M\d+$/;
const TASK_ID_RE = /^T\d+$/;
const QUESTION_ID_RE = /^Q\d+$/;
const RESEARCH_ID_RE = /^RS\d+$/;
const DEFECT_ID_RE = /^D\d+$/;
const REVIEW_ID_RE = /^R\d+$/;
const DECISION_ID_RE = /^K\d+$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]+$/;
const CLIENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OWNER_FENCE_TOKEN_RE = /^[A-Za-z0-9_-]{22,}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const goalIdSchema = z.string().regex(GOAL_ID_RE);
const milestoneIdSchema = z.string().regex(MILESTONE_ID_RE);
const taskIdSchema = z.string().regex(TASK_ID_RE);
const questionIdSchema = z.string().regex(QUESTION_ID_RE);
const researchIdSchema = z.string().regex(RESEARCH_ID_RE);
const defectIdSchema = z.string().regex(DEFECT_ID_RE);
const reviewIdSchema = z.string().regex(REVIEW_ID_RE);
const decisionIdSchema = z.string().regex(DECISION_ID_RE);
const opaqueIdSchema = z.string().regex(OPAQUE_ID_RE);
const clientKeySchema = z.string().regex(CLIENT_KEY_RE);
const generationSchema = z.number().int().positive();
const nonEmptyStringSchema = z.string().min(1);

export const PLAN_LIFECYCLE_CONTRACT_VERSION = 1 as const;

export const PlanClaimPurposeSchema = z.enum(["initial", "follow-up"]);
export type PlanClaimPurpose = z.infer<typeof PlanClaimPurposeSchema>;

export const PlanClaimGoalPhaseSchema = z.enum([
  "clarifying",
  "planning",
  "planned",
  "building",
]);
export type PlanClaimGoalPhase = z.infer<typeof PlanClaimGoalPhaseSchema>;

export const PlanReviewDefectSeveritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type PlanReviewDefectSeverity = z.infer<typeof PlanReviewDefectSeveritySchema>;

export const PlanOperationSchema = z.enum(["claim", "publish-draft", "release", "finalize"]);
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

export const PlanWriteProvenanceSchema = z
  .object({
    author: nonEmptyStringSchema,
    session: nonEmptyStringSchema.optional(),
  })
  .strict();
export type PlanWriteProvenance = z.infer<typeof PlanWriteProvenanceSchema>;

const provenanceShape = {
  author: nonEmptyStringSchema,
  session: nonEmptyStringSchema.optional(),
} as const;

export const PLAN_CLAIM_PHASE_TRANSITIONS = {
  initial: {
    allowed: ["clarifying", "planning"],
    resulting: "planning",
  },
  "follow-up": {
    allowed: ["planned", "building"],
    resulting: "planning",
  },
} as const satisfies Record<
  PlanClaimPurpose,
  {
    readonly allowed: readonly PlanClaimGoalPhase[];
    readonly resulting: "planning";
  }
>;

export type PlanClaimPhaseResolution =
  | {
      readonly ok: true;
      readonly previousGoalPhase: PlanClaimGoalPhase;
      readonly goalPhase: "planning";
    }
  | {
      readonly ok: false;
      readonly conflict:
        | {
            readonly code: "goal-terminal";
            readonly goalId: string;
            readonly status: "done" | "abandoned";
          }
        | {
            readonly code: "goal-phase-conflict";
            readonly goalId: string;
            readonly status: string;
            readonly allowed: readonly PlanClaimGoalPhase[];
          };
    };

export function resolvePlanClaimPhase(
  goalId: string,
  purpose: PlanClaimPurpose,
  currentPhase: string,
): PlanClaimPhaseResolution {
  if (currentPhase === "done" || currentPhase === "abandoned") {
    return {
      ok: false,
      conflict: { code: "goal-terminal", goalId, status: currentPhase },
    };
  }
  const transition = PLAN_CLAIM_PHASE_TRANSITIONS[purpose];
  if (!(transition.allowed as readonly string[]).includes(currentPhase)) {
    return {
      ok: false,
      conflict: {
        code: "goal-phase-conflict",
        goalId,
        status: currentPhase,
        allowed: transition.allowed,
      },
    };
  }
  return {
    ok: true,
    previousGoalPhase: currentPhase as PlanClaimGoalPhase,
    goalPhase: transition.resulting,
  };
}

function validateClaimPhaseTransition(
  value: {
    purpose: PlanClaimPurpose;
    previousGoalPhase: PlanClaimGoalPhase;
    goalPhase: "planning";
  },
  context: z.RefinementCtx,
): void {
  const transition = PLAN_CLAIM_PHASE_TRANSITIONS[value.purpose];
  if (!(transition.allowed as readonly PlanClaimGoalPhase[]).includes(value.previousGoalPhase)) {
    context.addIssue({
      code: "custom",
      message: `${value.purpose} claim does not allow phase ${value.previousGoalPhase}`,
      path: ["previousGoalPhase"],
    });
  }
  if (value.goalPhase !== transition.resulting) {
    context.addIssue({
      code: "custom",
      message: `${value.purpose} claim must result in phase ${transition.resulting}`,
      path: ["goalPhase"],
    });
  }
}

export const PlanPublicClaimSchema = z
  .object({
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
    purpose: PlanClaimPurposeSchema,
  })
  .strict();
export type PlanPublicClaim = z.infer<typeof PlanPublicClaimSchema>;

export const PlanAdoptedManifestSchema = z
  .object({
    milestoneIds: z.array(milestoneIdSchema),
    taskIds: z.array(taskIdSchema),
  })
  .strict();
export type PlanAdoptedManifest = z.infer<typeof PlanAdoptedManifestSchema>;

/**
 * Durable private claim authority. The plaintext token never belongs in
 * persistence: adapters store only its lowercase SHA-256 verifier. The
 * remaining fields are the complete redacted claim request and acknowledgement
 * projection needed to reconstruct an exact retry after process restart.
 */
export const PlanPrivateClaimRecordSchema = PlanPublicClaimSchema.extend({
  claimRequestId: opaqueIdSchema,
  ownerFenceTokenVerifier: z.string().regex(SHA256_HEX_RE),
  expectedGeneration: generationSchema.nullable(),
  priorGeneration: generationSchema.nullable(),
  previousGoalPhase: PlanClaimGoalPhaseSchema,
  goalPhase: z.literal("planning"),
  legacyAdopted: z.boolean(),
  adoptedManifest: PlanAdoptedManifestSchema,
  waitingResearches: z.array(researchIdSchema).length(0),
  ...provenanceShape,
  state: z.enum(["active", "released", "finalized"]),
})
  .strict()
  .superRefine((record, context) => {
    if (record.expectedGeneration !== record.priorGeneration) {
      context.addIssue({
        code: "custom",
        message: "expectedGeneration must equal priorGeneration",
        path: ["expectedGeneration"],
      });
    }
    validateClaimPhaseTransition(record, context);
  });
export type PlanPrivateClaimRecord = z.infer<typeof PlanPrivateClaimRecordSchema>;

export const PLAN_SECRET_FIELD_NAMES = ["ownerFenceToken", "ownerFenceTokenVerifier"] as const;

/**
 * Additive public goal metadata owned by {@link PlanLifecycleStore}. Private
 * claim authority and replay records deliberately do not live in item fields:
 * observers may read every value below without learning an owner token or its
 * verifier.
 */
export const PLAN_GENERATION_FIELD = "planGeneration" as const;
export const PLAN_ACTIVE_CLAIM_FIELD = "planActiveClaim" as const;
export const PLAN_CURRENT_DRAFT_FIELD = "planCurrentDraft" as const;
export const PLAN_FINALIZED_DRAFT_FIELD = "planFinalizedDraft" as const;
export const PLAN_FINALIZED_MANIFEST_FIELD = "planFinalizedManifest" as const;
export const PLAN_WAITING_RESEARCHES_FIELD = "waitingResearches" as const;

export const PLAN_MANAGED_GOAL_FIELD_NAMES = [
  PLAN_GENERATION_FIELD,
  PLAN_ACTIVE_CLAIM_FIELD,
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_WAITING_RESEARCHES_FIELD,
] as const;

export const PlanOperationKeySchema = z
  .object({
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
    operationId: opaqueIdSchema,
  })
  .strict();
export type PlanOperationKey = z.infer<typeof PlanOperationKeySchema>;

export const PlanDraftIdentitySchema = z
  .object({
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
    revision: generationSchema,
  })
  .strict();
export type PlanDraftIdentity = z.infer<typeof PlanDraftIdentitySchema>;

export const PlanReviewDraftBindingSchema = z
  .object({
    reviewId: reviewIdSchema,
    draft: PlanDraftIdentitySchema,
  })
  .strict();
export type PlanReviewDraftBinding = z.infer<typeof PlanReviewDraftBindingSchema>;

const operationKeyShape = {
  goalId: goalIdSchema,
  claimId: opaqueIdSchema,
  generation: generationSchema,
  operationId: opaqueIdSchema,
} as const;

const ownerOperationShape = {
  ...operationKeyShape,
  ownerFenceToken: z.string().regex(OWNER_FENCE_TOKEN_RE),
  ...provenanceShape,
} as const;

export const PlanClaimInputSchema = z
  .object({
    goalId: goalIdSchema,
    purpose: PlanClaimPurposeSchema,
    claimRequestId: opaqueIdSchema,
    ownerFenceToken: z.string().regex(OWNER_FENCE_TOKEN_RE),
    expectedGeneration: generationSchema.nullable(),
    ...provenanceShape,
  })
  .strict();
export type PlanClaimInput = z.infer<typeof PlanClaimInputSchema>;

export const PlanDraftReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("draft-milestone"),
      key: clientKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("draft-task"),
      key: clientKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ledger"),
      ref: nonEmptyStringSchema,
    })
    .strict(),
]);
export type PlanDraftReference = z.infer<typeof PlanDraftReferenceSchema>;

export const PlanMilestoneDraftSchema = z
  .object({
    key: clientKeySchema,
    title: nonEmptyStringSchema,
    description: z.string().optional(),
    dependsOn: z.array(PlanDraftReferenceSchema).optional(),
    blockedBy: z.array(PlanDraftReferenceSchema).optional(),
  })
  .strict();
export type PlanMilestoneDraft = z.infer<typeof PlanMilestoneDraftSchema>;

export const PlanTaskDraftSchema = z
  .object({
    key: clientKeySchema,
    milestoneKey: clientKeySchema,
    headline: nonEmptyStringSchema,
    description: z.string().optional(),
    acceptance: z.string().optional(),
    suggestedModel: z.string().optional(),
    ledgerRefs: z.array(nonEmptyStringSchema).optional(),
    sourceRefs: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    dependsOn: z.array(PlanDraftReferenceSchema).optional(),
    blockedBy: z.array(PlanDraftReferenceSchema).optional(),
  })
  .strict();
export type PlanTaskDraft = z.infer<typeof PlanTaskDraftSchema>;

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export const PlanDraftManifestSchema = z
  .object({
    milestones: z.array(PlanMilestoneDraftSchema).min(1),
    tasks: z.array(PlanTaskDraftSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const milestoneKeys = manifest.milestones.map(({ key }) => key);
    const taskKeys = manifest.tasks.map(({ key }) => key);

    for (const duplicate of duplicateValues(milestoneKeys)) {
      context.addIssue({
        code: "custom",
        message: `duplicate milestone key "${duplicate}"`,
        path: ["milestones"],
      });
    }
    for (const duplicate of duplicateValues(taskKeys)) {
      context.addIssue({
        code: "custom",
        message: `duplicate task key "${duplicate}"`,
        path: ["tasks"],
      });
    }

    const milestones = new Set(milestoneKeys);
    const tasks = new Set(taskKeys);
    for (const [index, task] of manifest.tasks.entries()) {
      if (!milestones.has(task.milestoneKey)) {
        context.addIssue({
          code: "custom",
          message: `unknown milestone key "${task.milestoneKey}"`,
          path: ["tasks", index, "milestoneKey"],
        });
      }
    }

    const allEntries = [...manifest.milestones, ...manifest.tasks];
    for (const [entryIndex, entry] of allEntries.entries()) {
      for (const field of ["dependsOn", "blockedBy"] as const) {
        for (const [refIndex, ref] of (entry[field] ?? []).entries()) {
          if (ref.kind === "draft-milestone" && !milestones.has(ref.key)) {
            context.addIssue({
              code: "custom",
              message: `unknown draft milestone key "${ref.key}"`,
              path: ["entries", entryIndex, field, refIndex],
            });
          }
          if (ref.kind === "draft-task" && !tasks.has(ref.key)) {
            context.addIssue({
              code: "custom",
              message: `unknown draft task key "${ref.key}"`,
              path: ["entries", entryIndex, field, refIndex],
            });
          }
        }
      }
    }
  });
export type PlanDraftManifest = z.infer<typeof PlanDraftManifestSchema>;

export const PlanReviewDefectDraftSchema = z
  .object({
    key: clientKeySchema,
    headline: nonEmptyStringSchema,
    severity: PlanReviewDefectSeveritySchema,
    description: z.string().optional(),
    rootCause: z.string().optional(),
    suggestedFix: z.string().optional(),
    sourceRefs: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type PlanReviewDefectDraft = z.infer<typeof PlanReviewDefectDraftSchema>;

export const PlanReviewDefectBatchSchema = z
  .object({
    reviewId: reviewIdSchema,
    defects: z.array(PlanReviewDefectDraftSchema).min(1),
  })
  .strict()
  .superRefine((batch, context) => {
    for (const duplicate of duplicateValues(batch.defects.map(({ key }) => key))) {
      context.addIssue({
        code: "custom",
        message: `duplicate review defect key "${duplicate}"`,
        path: ["defects"],
      });
    }
  });
export type PlanReviewDefectBatch = z.infer<typeof PlanReviewDefectBatchSchema>;

export const PlanPublishDraftInputSchema = z
  .object({
    ...ownerOperationShape,
    manifest: PlanDraftManifestSchema,
    reviewDefects: PlanReviewDefectBatchSchema.optional(),
  })
  .strict();
export type PlanPublishDraftInput = z.infer<typeof PlanPublishDraftInputSchema>;

export const PlanQuestionDraftSchema = z
  .object({
    key: clientKeySchema,
    question: nonEmptyStringSchema,
    context: z.string().optional(),
    suggestions: z.array(z.string()).optional(),
    recommendation: z.string().optional(),
  })
  .strict();
export type PlanQuestionDraft = z.infer<typeof PlanQuestionDraftSchema>;

export const PlanResearchDraftSchema = z
  .object({
    key: clientKeySchema,
    question: nonEmptyStringSchema,
    scope: z.string().optional(),
  })
  .strict();
export type PlanResearchDraft = z.infer<typeof PlanResearchDraftSchema>;

export const PlanPauseEffectSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("questions"),
        questions: z.array(PlanQuestionDraftSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("researches"),
        researches: z.array(PlanResearchDraftSchema).min(1),
      })
      .strict(),
  ])
  .superRefine((effect, context) => {
    const entries = effect.kind === "questions" ? effect.questions : effect.researches;
    for (const duplicate of duplicateValues(entries.map(({ key }) => key))) {
      context.addIssue({
        code: "custom",
        message: `duplicate ${effect.kind} key "${duplicate}"`,
        path: [effect.kind],
      });
    }
  });
export type PlanPauseEffect = z.infer<typeof PlanPauseEffectSchema>;

const ownerReleaseInputSchema = z
  .object({
    kind: z.literal("pause"),
    ...ownerOperationShape,
    effect: PlanPauseEffectSchema,
    reviewDefects: PlanReviewDefectBatchSchema.optional(),
  })
  .strict();

const publicAbandonInputSchema = z
  .object({
    kind: z.literal("abandon"),
    ...operationKeyShape,
    reason: nonEmptyStringSchema,
    reviewDefects: PlanReviewDefectBatchSchema.optional(),
    ...provenanceShape,
  })
  .strict();

/**
 * Pause requires owner authority. Exact abandonment deliberately does not:
 * the public claim id and generation fence a recovery release without a clock.
 */
export const PlanReleaseInputSchema = z.discriminatedUnion("kind", [
  ownerReleaseInputSchema,
  publicAbandonInputSchema,
]);
export type PlanReleaseInput = z.infer<typeof PlanReleaseInputSchema>;

export const PlanFinalizeInputSchema = z
  .object({
    ...ownerOperationShape,
    reviewId: reviewIdSchema,
    draftRevision: generationSchema,
    decision: z
      .object({
        headline: nonEmptyStringSchema,
        rationale: z.string().optional(),
        alternatives: z.string().optional(),
      })
      .strict(),
    reviewDefects: PlanReviewDefectBatchSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.reviewDefects !== undefined && input.reviewDefects.reviewId !== input.reviewId) {
      context.addIssue({
        code: "custom",
        message: "reviewDefects.reviewId must equal finalize reviewId",
        path: ["reviewDefects", "reviewId"],
      });
    }
  });
export type PlanFinalizeInput = z.infer<typeof PlanFinalizeInputSchema>;

const publicClaimShape = {
  goalId: goalIdSchema,
  claimId: opaqueIdSchema,
  generation: generationSchema,
} as const;

const goalNotFoundConflictSchema = z
  .object({ code: z.literal("goal-not-found"), goalId: goalIdSchema })
  .strict();
const goalTerminalConflictSchema = z
  .object({
    code: z.literal("goal-terminal"),
    goalId: goalIdSchema,
    status: z.enum(["done", "abandoned"]),
  })
  .strict();
const parentMilestoneAbsentConflictSchema = z
  .object({
    code: z.literal("parent-milestone-absent"),
    goalId: goalIdSchema,
    milestoneId: opaqueIdSchema,
  })
  .strict();
const parentMilestoneTerminalConflictSchema = z
  .object({
    code: z.literal("parent-milestone-terminal"),
    goalId: goalIdSchema,
    milestoneId: opaqueIdSchema,
    status: nonEmptyStringSchema,
  })
  .strict();
const goalPhaseConflictSchema = z
  .object({
    code: z.literal("goal-phase-conflict"),
    goalId: goalIdSchema,
    status: nonEmptyStringSchema,
    allowed: z.array(nonEmptyStringSchema),
  })
  .strict();
const claimActiveConflictSchema = z
  .object({
    code: z.literal("claim-active"),
    ...publicClaimShape,
  })
  .strict();
const claimNotActiveConflictSchema = z
  .object({
    code: z.literal("claim-not-active"),
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
  })
  .strict();
const staleClaimConflictSchema = z
  .object({
    code: z.literal("stale-claim"),
    goalId: goalIdSchema,
    suppliedClaimId: opaqueIdSchema,
    currentClaimId: opaqueIdSchema.nullable(),
    currentGeneration: generationSchema.nullable(),
  })
  .strict();
const staleGenerationConflictSchema = z
  .object({
    code: z.literal("stale-generation"),
    goalId: goalIdSchema,
    expectedGeneration: generationSchema.nullable(),
    currentGeneration: generationSchema.nullable(),
  })
  .strict();
const ownerFenceMismatchConflictSchema = z
  .object({
    code: z.literal("owner-fence-mismatch"),
    ...publicClaimShape,
  })
  .strict();
const claimRequestReusedConflictSchema = z
  .object({
    code: z.literal("claim-request-reused"),
    ...publicClaimShape,
    claimRequestId: opaqueIdSchema,
  })
  .strict();
const idempotencyKeyReusedConflictSchema = z
  .object({
    code: z.literal("idempotency-key-reused"),
    ...publicClaimShape,
    operation: PlanOperationSchema,
    operationId: opaqueIdSchema,
  })
  .strict();
const publishDraftIdempotencyKeyReusedConflictSchema =
  idempotencyKeyReusedConflictSchema.extend({
    operation: z.literal("publish-draft"),
  });
const releaseIdempotencyKeyReusedConflictSchema = idempotencyKeyReusedConflictSchema.extend({
  operation: z.literal("release"),
});
const finalizeIdempotencyKeyReusedConflictSchema = idempotencyKeyReusedConflictSchema.extend({
  operation: z.literal("finalize"),
});
const implementationActiveConflictSchema = z
  .object({
    code: z.literal("implementation-active"),
    goalId: goalIdSchema,
    tasks: z
      .array(
        z
          .object({
            taskId: taskIdSchema,
            status: z.enum(["wip", "blocked"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const researchWaitActiveConflictSchema = z
  .object({
    code: z.literal("research-wait-active"),
    goalId: goalIdSchema,
    researchIds: z.array(researchIdSchema).min(1),
  })
  .strict();
const draftNotFoundConflictSchema = z
  .object({
    code: z.literal("draft-not-found"),
    ...publicClaimShape,
  })
  .strict();
const reviewNotFoundConflictSchema = z
  .object({
    code: z.literal("review-not-found"),
    ...publicClaimShape,
    reviewId: reviewIdSchema,
  })
  .strict();
const reviewNotApprovedConflictSchema = z
  .object({
    code: z.literal("review-not-approved"),
    ...publicClaimShape,
    reviewId: reviewIdSchema,
    status: z.literal("revise"),
  })
  .strict();
const reviewGenerationMismatchConflictSchema = z
  .object({
    code: z.literal("review-generation-mismatch"),
    ...publicClaimShape,
    reviewId: reviewIdSchema,
    reviewGeneration: generationSchema.nullable(),
  })
  .strict();
const reviewDraftMismatchConflictSchema = z
  .object({
    code: z.literal("review-draft-mismatch"),
    ...publicClaimShape,
    reviewId: reviewIdSchema,
    requestedDraftRevision: generationSchema,
    currentDraftRevision: generationSchema,
    reviewDraftRevision: generationSchema.nullable(),
  })
  .strict();

const conflictSchemas = [
  goalNotFoundConflictSchema,
  goalTerminalConflictSchema,
  parentMilestoneAbsentConflictSchema,
  parentMilestoneTerminalConflictSchema,
  goalPhaseConflictSchema,
  claimActiveConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  claimRequestReusedConflictSchema,
  idempotencyKeyReusedConflictSchema,
  implementationActiveConflictSchema,
  researchWaitActiveConflictSchema,
  draftNotFoundConflictSchema,
  reviewNotFoundConflictSchema,
  reviewNotApprovedConflictSchema,
  reviewGenerationMismatchConflictSchema,
  reviewDraftMismatchConflictSchema,
] as const;

export const PlanConflictSchema = z.discriminatedUnion("code", conflictSchemas);
export type PlanConflict = z.infer<typeof PlanConflictSchema>;

export const PlanClaimConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  goalTerminalConflictSchema,
  parentMilestoneAbsentConflictSchema,
  parentMilestoneTerminalConflictSchema,
  goalPhaseConflictSchema,
  claimActiveConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  implementationActiveConflictSchema,
  researchWaitActiveConflictSchema,
  claimRequestReusedConflictSchema,
]);
export type PlanClaimConflict = z.infer<typeof PlanClaimConflictSchema>;

export const PlanPublishDraftConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  parentMilestoneAbsentConflictSchema,
  parentMilestoneTerminalConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  goalPhaseConflictSchema,
  publishDraftIdempotencyKeyReusedConflictSchema,
]);
export type PlanPublishDraftConflict = z.infer<typeof PlanPublishDraftConflictSchema>;

export const PlanPauseConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  goalPhaseConflictSchema,
  releaseIdempotencyKeyReusedConflictSchema,
]);
export type PlanPauseConflict = z.infer<typeof PlanPauseConflictSchema>;

export const PlanAbandonConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  releaseIdempotencyKeyReusedConflictSchema,
]);
export type PlanAbandonConflict = z.infer<typeof PlanAbandonConflictSchema>;

export const PlanReleaseConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  goalPhaseConflictSchema,
  releaseIdempotencyKeyReusedConflictSchema,
]);
export type PlanReleaseConflict = z.infer<typeof PlanReleaseConflictSchema>;

export const PlanFinalizeConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  draftNotFoundConflictSchema,
  reviewNotFoundConflictSchema,
  reviewNotApprovedConflictSchema,
  reviewGenerationMismatchConflictSchema,
  reviewDraftMismatchConflictSchema,
  finalizeIdempotencyKeyReusedConflictSchema,
]);
export type PlanFinalizeConflict = z.infer<typeof PlanFinalizeConflictSchema>;

export type PlanFinalizeDraftBindingResolution =
  | { readonly ok: true; readonly draft: PlanDraftIdentity }
  | { readonly ok: false; readonly conflict: PlanFinalizeConflict };

/**
 * Check the persisted review binding against both the requested and current
 * draft identity. The caller supplies the current draft from the exact
 * goal/claim/generation lookup; a different scope indicates adapter misuse.
 */
export function resolvePlanFinalizeDraftBinding(
  finalizeInput: unknown,
  currentDraftIdentity: unknown,
  reviewBinding: unknown,
): PlanFinalizeDraftBindingResolution {
  const input = PlanFinalizeInputSchema.parse(finalizeInput);
  const currentDraft = PlanDraftIdentitySchema.parse(currentDraftIdentity);
  const binding = PlanReviewDraftBindingSchema.nullable().parse(reviewBinding);
  if (
    currentDraft.goalId !== input.goalId ||
    currentDraft.claimId !== input.claimId ||
    currentDraft.generation !== input.generation
  ) {
    throw new Error("current draft lookup must use the finalize goal, claim, and generation");
  }
  if (binding !== null && binding.reviewId !== input.reviewId) {
    return {
      ok: false,
      conflict: {
        code: "review-not-found",
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        reviewId: input.reviewId,
      },
    };
  }
  if (binding !== null && binding.draft.generation !== input.generation) {
    return {
      ok: false,
      conflict: {
        code: "review-generation-mismatch",
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        reviewId: input.reviewId,
        reviewGeneration: binding.draft.generation,
      },
    };
  }

  if (
    currentDraft.revision !== input.draftRevision ||
    binding === null ||
    binding.draft.goalId !== input.goalId ||
    binding.draft.claimId !== input.claimId ||
    binding.draft.revision !== input.draftRevision
  ) {
    return {
      ok: false,
      conflict: {
        code: "review-draft-mismatch",
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        reviewId: input.reviewId,
        requestedDraftRevision: input.draftRevision,
        currentDraftRevision: currentDraft.revision,
        reviewDraftRevision: binding?.draft.revision ?? null,
      },
    };
  }
  return { ok: true, draft: currentDraft };
}

export const PlanIdAllocationSchema = z
  .object({
    key: clientKeySchema,
    id: nonEmptyStringSchema,
  })
  .strict();
export type PlanIdAllocation = z.infer<typeof PlanIdAllocationSchema>;

export const PlanPublishedManifestSchema = z
  .object({
    revision: generationSchema,
    milestones: z.array(PlanIdAllocationSchema.extend({ id: milestoneIdSchema }).strict()),
    tasks: z.array(PlanIdAllocationSchema.extend({ id: taskIdSchema }).strict()),
  })
  .strict();
export type PlanPublishedManifest = z.infer<typeof PlanPublishedManifestSchema>;

const mutationSuccess = <Acknowledgement extends z.ZodType>(acknowledgement: Acknowledgement) =>
  z
    .object({
      ok: z.literal(true),
      replayed: z.boolean(),
      acknowledgement,
    })
    .strict();

const mutationConflict = <Conflict extends z.ZodType>(conflict: Conflict) =>
  z
    .object({
      ok: z.literal(false),
      conflict,
    })
    .strict();

export const PlanClaimAcknowledgementSchema = z
  .object({
    ...publicClaimShape,
    purpose: PlanClaimPurposeSchema,
    claimRequestId: opaqueIdSchema,
    ownerFenceToken: z.string().regex(OWNER_FENCE_TOKEN_RE),
    previousGoalPhase: PlanClaimGoalPhaseSchema,
    goalPhase: z.literal("planning"),
    legacyAdopted: z.boolean(),
    adoptedManifest: PlanAdoptedManifestSchema,
    waitingResearches: z.array(researchIdSchema).length(0),
  })
  .strict()
  .superRefine(validateClaimPhaseTransition);
export type PlanClaimAcknowledgement = z.infer<typeof PlanClaimAcknowledgementSchema>;

export const PlanClaimResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanClaimAcknowledgementSchema),
  mutationConflict(PlanClaimConflictSchema),
]);
export type PlanClaimResult = z.infer<typeof PlanClaimResultSchema>;

function claimRequestChanged(
  record: PlanPrivateClaimRecord,
  input: PlanClaimInput,
): boolean {
  return (
    record.purpose !== input.purpose ||
    record.expectedGeneration !== input.expectedGeneration ||
    record.author !== input.author ||
    record.session !== input.session
  );
}

/**
 * Reconstruct the live claim winner acknowledgement from verifier-only durable
 * state. Exact replay echoes the caller-supplied token only after its SHA-256
 * digest matches; the durable record itself never contains plaintext authority.
 */
export function replayPlanClaim(
  durableRecord: unknown,
  retryInput: unknown,
): PlanClaimResult {
  const record = PlanPrivateClaimRecordSchema.parse(durableRecord);
  const input = PlanClaimInputSchema.parse(retryInput);
  if (record.goalId !== input.goalId || record.claimRequestId !== input.claimRequestId) {
    throw new Error("claim replay lookup must use the recorded goalId and claimRequestId scope");
  }
  if (claimRequestChanged(record, input)) {
    return {
      ok: false,
      conflict: {
        code: "claim-request-reused",
        goalId: record.goalId,
        claimId: record.claimId,
        generation: record.generation,
        claimRequestId: record.claimRequestId,
      },
    };
  }

  const suppliedVerifier = createHash("sha256")
    .update(input.ownerFenceToken, "utf8")
    .digest("hex");
  if (suppliedVerifier !== record.ownerFenceTokenVerifier) {
    return {
      ok: false,
      conflict: {
        code: "owner-fence-mismatch",
        goalId: record.goalId,
        claimId: record.claimId,
        generation: record.generation,
      },
    };
  }

  return PlanClaimResultSchema.parse({
    ok: true,
    replayed: true,
    acknowledgement: {
      goalId: record.goalId,
      claimId: record.claimId,
      generation: record.generation,
      purpose: record.purpose,
      claimRequestId: record.claimRequestId,
      ownerFenceToken: input.ownerFenceToken,
      previousGoalPhase: record.previousGoalPhase,
      goalPhase: record.goalPhase,
      legacyAdopted: record.legacyAdopted,
      adoptedManifest: record.adoptedManifest,
      waitingResearches: record.waitingResearches,
    },
  });
}

export const PlanPublishDraftAcknowledgementSchema = z
  .object({
    ...operationKeyShape,
    manifest: PlanPublishedManifestSchema,
    replacedManifest: PlanPublishedManifestSchema.nullable(),
    reviewDefects: z.array(PlanIdAllocationSchema.extend({ id: defectIdSchema }).strict()),
  })
  .strict();
export type PlanPublishDraftAcknowledgement = z.infer<typeof PlanPublishDraftAcknowledgementSchema>;

export const PlanPublishDraftResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanPublishDraftAcknowledgementSchema),
  mutationConflict(PlanPublishDraftConflictSchema),
]);
export type PlanPublishDraftResult = z.infer<typeof PlanPublishDraftResultSchema>;

const releaseAcknowledgementBase = {
  ...operationKeyShape,
  reviewDefects: z.array(PlanIdAllocationSchema.extend({ id: defectIdSchema }).strict()),
} as const;

export const PlanReleaseAcknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("questions"),
      ...releaseAcknowledgementBase,
      questions: z.array(PlanIdAllocationSchema.extend({ id: questionIdSchema }).strict()).min(1),
      researches: z
        .array(PlanIdAllocationSchema.extend({ id: researchIdSchema }).strict())
        .length(0),
      waitingResearches: z.array(researchIdSchema).length(0),
      goalPhase: z.literal("clarifying"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("researches"),
      ...releaseAcknowledgementBase,
      questions: z
        .array(PlanIdAllocationSchema.extend({ id: questionIdSchema }).strict())
        .length(0),
      researches: z.array(PlanIdAllocationSchema.extend({ id: researchIdSchema }).strict()).min(1),
      waitingResearches: z.array(researchIdSchema).min(1),
      goalPhase: z.literal("planning"),
    })
    .strict()
    .superRefine((acknowledgement, context) => {
      if (
        acknowledgement.researches.length !== acknowledgement.waitingResearches.length ||
        acknowledgement.researches.some(
          ({ id }, index) => acknowledgement.waitingResearches[index] !== id,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "waitingResearches must exactly equal researchIds",
          path: ["waitingResearches"],
        });
      }
    }),
  z
    .object({
      kind: z.literal("abandon"),
      ...releaseAcknowledgementBase,
      questions: z
        .array(PlanIdAllocationSchema.extend({ id: questionIdSchema }).strict())
        .length(0),
      researches: z
        .array(PlanIdAllocationSchema.extend({ id: researchIdSchema }).strict())
        .length(0),
      waitingResearches: z.array(researchIdSchema).length(0),
      goalPhase: z.literal("planning"),
    })
    .strict(),
]);
export type PlanReleaseAcknowledgement = z.infer<typeof PlanReleaseAcknowledgementSchema>;

export const PlanReleaseResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanReleaseAcknowledgementSchema),
  mutationConflict(PlanReleaseConflictSchema),
]);
export type PlanReleaseResult = z.infer<typeof PlanReleaseResultSchema>;

export const PlanFinalizeAcknowledgementSchema = z
  .object({
    ...operationKeyShape,
    reviewId: reviewIdSchema,
    draft: PlanDraftIdentitySchema,
    decisionId: decisionIdSchema,
    manifest: PlanPublishedManifestSchema,
    reviewDefects: z.array(PlanIdAllocationSchema.extend({ id: defectIdSchema }).strict()),
    goalPhase: z.literal("planned"),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (
      acknowledgement.draft.goalId !== acknowledgement.goalId ||
      acknowledgement.draft.claimId !== acknowledgement.claimId ||
      acknowledgement.draft.generation !== acknowledgement.generation ||
      acknowledgement.draft.revision !== acknowledgement.manifest.revision
    ) {
      context.addIssue({
        code: "custom",
        message: "finalized draft identity must equal the operation claim and manifest revision",
        path: ["draft"],
      });
    }
  });
export type PlanFinalizeAcknowledgement = z.infer<typeof PlanFinalizeAcknowledgementSchema>;

export const PlanFinalizeResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanFinalizeAcknowledgementSchema),
  mutationConflict(PlanFinalizeConflictSchema),
]);
export type PlanFinalizeResult = z.infer<typeof PlanFinalizeResultSchema>;

export const PlanReplayableOperationSchema = z.enum(["publish-draft", "release", "finalize"]);
export type PlanReplayableOperation = z.infer<typeof PlanReplayableOperationSchema>;

export const PlanOperationReplayRecordSchema = PlanOperationKeySchema.extend({
  operation: PlanReplayableOperationSchema,
  requestPayloadVerifier: z.string().regex(SHA256_HEX_RE),
}).strict();
export type PlanOperationReplayRecord = z.infer<typeof PlanOperationReplayRecordSchema>;

export type PlanOperationReplayResolution =
  | { readonly kind: "independent-operation" }
  | { readonly kind: "exact-replay" }
  | {
      readonly kind: "conflict";
      readonly conflict: Extract<PlanConflict, { code: "idempotency-key-reused" }>;
    };

/**
 * Compare one durable non-claim operation record with an attempted operation.
 * The payload verifier detects changed retries but never grants authority:
 * claim/generation and owner-token verification remain separate preconditions.
 */
export function resolvePlanOperationReplay(
  durableRecord: unknown,
  attemptedRecord: unknown,
): PlanOperationReplayResolution {
  const recorded = PlanOperationReplayRecordSchema.parse(durableRecord);
  const attempted = PlanOperationReplayRecordSchema.parse(attemptedRecord);
  const sameScope =
    recorded.claimId === attempted.claimId &&
    recorded.generation === attempted.generation &&
    recorded.operation === attempted.operation &&
    recorded.operationId === attempted.operationId;
  if (!sameScope) return { kind: "independent-operation" };
  if (recorded.requestPayloadVerifier === attempted.requestPayloadVerifier) {
    return { kind: "exact-replay" };
  }
  return {
    kind: "conflict",
    conflict: {
      code: "idempotency-key-reused",
      goalId: recorded.goalId,
      claimId: recorded.claimId,
      generation: recorded.generation,
      operation: recorded.operation,
      operationId: recorded.operationId,
    },
  };
}

/**
 * Capability implemented by guarded stores. Keeping it separate from
 * LedgerStore lets T846 publish the contract before backend implementations.
 */
export interface PlanLifecycleStore {
  claimPlan(input: PlanClaimInput): Promise<PlanClaimResult>;
  publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult>;
  releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult>;
  finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult>;
}

export const PLAN_RESEARCH_WAIT_DISPOSITION = {
  open: "suppress",
  wip: "suppress",
  inconclusive: "suppress",
  concluded: "resume",
  abandoned: "resume",
  missing: "resume",
  archived: "resume",
} as const;
export type PlanResearchWaitState = keyof typeof PLAN_RESEARCH_WAIT_DISPOSITION;
export type PlanResearchWaitDisposition =
  (typeof PLAN_RESEARCH_WAIT_DISPOSITION)[PlanResearchWaitState];

export const PLAN_FOLLOW_UP_TASK_DISPOSITION = {
  planned: "replace",
  wip: "reject-implementation-active",
  blocked: "reject-implementation-active",
  done: "drained",
  abandoned: "drained",
} as const;
export type PlanFollowUpTaskStatus = keyof typeof PLAN_FOLLOW_UP_TASK_DISPOSITION;
export type PlanFollowUpTaskDisposition =
  (typeof PLAN_FOLLOW_UP_TASK_DISPOSITION)[PlanFollowUpTaskStatus];

export const PLAN_FOLLOW_UP_AGGREGATE_PRECEDENCE = [
  "reject-implementation-active",
  "replace",
  "drained",
] as const;

export const PLAN_FOLLOW_UP_CLEANUP = {
  plannedTasks: "transition-to-abandoned",
  milestones: "transition-to-postponed",
  dependencyRefs: "remove-if-owned-only-by-superseded-work",
  backlinks: "remove-if-owned-only-by-superseded-work",
  openQuestions: "withdraw-if-owned-only-by-superseded-work",
  activeTasks: "reject-without-mutation",
} as const;

export const PLAN_LEGACY_ADOPTION = {
  metadataAbsentExpectedGeneration: null,
  baselineGeneration: "absent",
  firstAllocatedGeneration: 1,
  milestoneSource: "goal.milestones-only",
  taskSource: "tasks-under-declared-milestones-only",
  goalRefOrphans: "ignore",
  missingOptionalMetadata: "compatible",
} as const;

export const PLAN_AUTHORITY_RULES = {
  ownerTokenInput: "caller-generated-random-base64url-at-least-128-bits",
  ownerTokenPersistence: "sha256-verifier-only",
  ownerTokenEcho: "winning-or-exact-claim-retry-channel-only",
  observerExposure: "never",
  claimRequestScope: ["goalId", "claimRequestId"],
  operationScope: ["claimId", "generation", "operation", "operationId"],
  exactReplay:
    "reconstruct-live-acknowledgement-from-redacted-durable-state-and-caller-token",
  claimReplayPersistence:
    "request-fields-token-verifier-phase-and-legacy-adoption-without-plaintext-token",
  operationReplayPersistence:
    "payload-verifier-is-idempotency-only-never-authority",
  changedClaimReplayPayload: "claim-request-reused",
  changedOperationReplayPayload: "idempotency-key-reused",
  expiry: "none",
  heartbeat: "none",
  digestAuthority: "none",
  coordinator: "none",
  abandonmentAuthority:
    "exact-public-claim-id-generation-and-release-operation-id-without-owner-token",
} as const;

export const PLAN_MANAGED_MUTATION_OWNERS = {
  activeClaim: ["claim", "release", "finalize"],
  generation: ["claim"],
  draft: ["publish-draft"],
  waitingResearches: ["claim", "release"],
  goalPhase: ["claim", "release", "finalize"],
  finalizedManifest: ["finalize"],
  followUpCleanup: ["claim"],
  reviewDefects: ["publish-draft", "release", "finalize"],
  rawCrud: "reject-managed-plan-fields-and-transitions",
} as const;

export const PLAN_RELEASE_VARIANT_CONFLICTS = {
  pause: [
    "goal-not-found",
    "claim-not-active",
    "stale-claim",
    "stale-generation",
    "owner-fence-mismatch",
    "goal-phase-conflict",
    "idempotency-key-reused",
  ],
  abandon: [
    "goal-not-found",
    "claim-not-active",
    "stale-claim",
    "stale-generation",
    "idempotency-key-reused",
  ],
} as const satisfies Record<
  PlanReleaseInput["kind"],
  readonly PlanReleaseConflict["code"][]
>;

export const PLAN_OPERATION_CONTRACTS = {
  claim: {
    preconditions: [
      "goal-exists-and-is-nonterminal",
      "initial-goal-phase-is-clarifying-or-planning",
      "follow-up-goal-phase-is-planned-or-building",
      "expected-generation-matches",
      "no-different-active-claim",
      "no-active-research-wait",
      "follow-up-has-no-wip-or-blocked-manifest-task",
    ],
    postconditions: [
      "claim-and-generation-allocated-once",
      "request-id-and-sha256-token-verifier-persisted-atomically",
      "claim-replay-state-is-durable-redacted-and-complete",
      "claim-transitions-goal-to-planning-and-acknowledges-prior-and-resulting-phase",
      "follow-up-replacement-cleanup-is-atomic",
      "waiting-researches-cleared",
      "legacy-manifest-adopted-from-declared-milestones-only",
    ],
    conflicts: [
      "goal-not-found",
      "goal-terminal",
      "goal-phase-conflict",
      "claim-active",
      "stale-generation",
      "owner-fence-mismatch",
      "implementation-active",
      "research-wait-active",
      "claim-request-reused",
    ],
  },
  "publish-draft": {
    preconditions: [
      "exact-active-claim-and-generation",
      "owner-token-matches-persisted-verifier",
      "manifest-is-complete",
    ],
    postconditions: [
      "complete-draft-and-review-defects-published-atomically",
      "prior-draft-superseded-with-cleanup",
      "draft-tasks-remain-nonactionable",
      "acknowledgement-and-allocated-ids-recorded",
    ],
    conflicts: [
      "goal-not-found",
      "claim-not-active",
      "stale-claim",
      "stale-generation",
      "owner-fence-mismatch",
      "goal-phase-conflict",
      "idempotency-key-reused",
    ],
  },
  release: {
    preconditions: [
      "pause-has-exact-active-owner-authority",
      "abandon-has-exact-public-claim-and-generation",
      "abandon-never-accepts-or-checks-owner-token",
      "entire-effect-and-review-defect-batch-validates-before-write",
    ],
    postconditions: [
      "questions-create-exact-items-and-transition-planning-to-clarifying",
      "researches-create-exact-items-and-replace-waiting-researches",
      "abandon-releases-only-the-exact-claim",
      "effect-defects-release-and-acknowledgement-commit-atomically",
    ],
    conflicts: [
      "goal-not-found",
      "claim-not-active",
      "stale-claim",
      "stale-generation",
      "owner-fence-mismatch",
      "goal-phase-conflict",
      "idempotency-key-reused",
    ],
  },
  finalize: {
    preconditions: [
      "exact-active-owner-authority",
      "complete-current-draft-exists",
      "review-exists-is-go-ahead-and-matches-exact-draft-identity",
    ],
    postconditions: [
      "decision-created-or-reused-before-finalized-marker",
      "review-defects-decision-manifest-and-claim-release-commit-atomically",
      "goal-milestones-equals-finalized-manifest",
      "only-finalized-current-manifest-is-executable",
      "acknowledgement-and-allocated-ids-recorded",
    ],
    conflicts: [
      "goal-not-found",
      "claim-not-active",
      "stale-claim",
      "stale-generation",
      "owner-fence-mismatch",
      "draft-not-found",
      "review-not-found",
      "review-not-approved",
      "review-generation-mismatch",
      "review-draft-mismatch",
      "idempotency-key-reused",
    ],
  },
} as const satisfies Record<
  PlanOperation,
  {
    readonly preconditions: readonly string[];
    readonly postconditions: readonly string[];
    readonly conflicts: readonly PlanConflict["code"][];
  }
>;

export type PlanOperationContract = typeof PLAN_OPERATION_CONTRACTS;
type PlanOperationContractEntry = PlanOperationContract[PlanOperation];
export type PlanOperationPrecondition = PlanOperationContractEntry["preconditions"][number];
export type PlanOperationPostcondition = PlanOperationContractEntry["postconditions"][number];
