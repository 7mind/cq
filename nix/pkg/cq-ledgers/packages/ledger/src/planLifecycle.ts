/**
 * Public contract for the guarded plan lifecycle (G99 / D134).
 *
 * This module specifies wire-safe inputs, acknowledgements, conflicts, and
 * state tables. It deliberately contains no persistence or locking behavior:
 * production adapters implement the same contract in later tasks.
 */

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

export const PlanOperationSchema = z.enum(["claim", "publish-draft", "release", "finalize"]);
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

export const PlanWriteProvenanceSchema = z
  .object({
    author: nonEmptyStringSchema,
    session: nonEmptyStringSchema.optional(),
  })
  .strict();
export type PlanWriteProvenance = z.infer<typeof PlanWriteProvenanceSchema>;

export const PlanPublicClaimSchema = z
  .object({
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
    purpose: PlanClaimPurposeSchema,
  })
  .strict();
export type PlanPublicClaim = z.infer<typeof PlanPublicClaimSchema>;

/**
 * Durable private claim authority. The plaintext token never belongs in
 * persistence: adapters store only its lowercase SHA-256 verifier.
 */
export const PlanPrivateClaimRecordSchema = PlanPublicClaimSchema.extend({
  claimRequestId: opaqueIdSchema,
  ownerFenceTokenVerifier: z.string().regex(SHA256_HEX_RE),
  priorGeneration: generationSchema.nullable(),
  state: z.enum(["active", "released", "finalized"]),
}).strict();
export type PlanPrivateClaimRecord = z.infer<typeof PlanPrivateClaimRecordSchema>;

export const PLAN_SECRET_FIELD_NAMES = ["ownerFenceToken", "ownerFenceTokenVerifier"] as const;

export const PlanOperationKeySchema = z
  .object({
    goalId: goalIdSchema,
    claimId: opaqueIdSchema,
    generation: generationSchema,
    operationId: opaqueIdSchema,
  })
  .strict();
export type PlanOperationKey = z.infer<typeof PlanOperationKeySchema>;

const provenanceShape = {
  author: nonEmptyStringSchema,
  session: nonEmptyStringSchema.optional(),
} as const;

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
    severity: nonEmptyStringSchema,
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

export const PlanPauseEffectSchema = z.discriminatedUnion("kind", [
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
]);
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

const conflictSchemas = [
  goalNotFoundConflictSchema,
  goalTerminalConflictSchema,
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
] as const;

export const PlanConflictSchema = z.discriminatedUnion("code", conflictSchemas);
export type PlanConflict = z.infer<typeof PlanConflictSchema>;

export const PlanClaimConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  goalTerminalConflictSchema,
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
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  goalPhaseConflictSchema,
  idempotencyKeyReusedConflictSchema,
]);
export type PlanPublishDraftConflict = z.infer<typeof PlanPublishDraftConflictSchema>;

export const PlanReleaseConflictSchema = z.discriminatedUnion("code", [
  goalNotFoundConflictSchema,
  claimNotActiveConflictSchema,
  staleClaimConflictSchema,
  staleGenerationConflictSchema,
  ownerFenceMismatchConflictSchema,
  goalPhaseConflictSchema,
  idempotencyKeyReusedConflictSchema,
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
  idempotencyKeyReusedConflictSchema,
]);
export type PlanFinalizeConflict = z.infer<typeof PlanFinalizeConflictSchema>;

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
    legacyAdopted: z.boolean(),
    adoptedManifest: z
      .object({
        milestoneIds: z.array(milestoneIdSchema),
        taskIds: z.array(taskIdSchema),
      })
      .strict(),
    waitingResearches: z.array(researchIdSchema).length(0),
  })
  .strict();
export type PlanClaimAcknowledgement = z.infer<typeof PlanClaimAcknowledgementSchema>;

export const PlanClaimResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanClaimAcknowledgementSchema),
  mutationConflict(PlanClaimConflictSchema),
]);
export type PlanClaimResult = z.infer<typeof PlanClaimResultSchema>;

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
      reviewDefects: z
        .array(PlanIdAllocationSchema.extend({ id: defectIdSchema }).strict())
        .length(0),
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
    decisionId: decisionIdSchema,
    manifest: PlanPublishedManifestSchema,
    reviewDefects: z.array(PlanIdAllocationSchema.extend({ id: defectIdSchema }).strict()),
    goalPhase: z.literal("planned"),
  })
  .strict();
export type PlanFinalizeAcknowledgement = z.infer<typeof PlanFinalizeAcknowledgementSchema>;

export const PlanFinalizeResultSchema = z.discriminatedUnion("ok", [
  mutationSuccess(PlanFinalizeAcknowledgementSchema),
  mutationConflict(PlanFinalizeConflictSchema),
]);
export type PlanFinalizeResult = z.infer<typeof PlanFinalizeResultSchema>;

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
  exactReplay: "return-recorded-acknowledgement-and-side-effect-ids",
  changedClaimReplayPayload: "claim-request-reused",
  changedOperationReplayPayload: "idempotency-key-reused",
  expiry: "none",
  heartbeat: "none",
  digestAuthority: "none",
  coordinator: "none",
  abandonmentAuthority: "exact-public-claim-id-and-generation",
} as const;

export const PLAN_MANAGED_MUTATION_OWNERS = {
  activeClaim: ["claim", "release", "finalize"],
  generation: ["claim"],
  draft: ["publish-draft"],
  waitingResearches: ["claim", "release"],
  goalPhase: ["claim", "release", "finalize"],
  finalizedManifest: ["finalize"],
  followUpCleanup: ["claim"],
  reviewDefects: ["publish-draft", "release-pause", "finalize"],
  rawCrud: "reject-managed-plan-fields-and-transitions",
} as const;

export const PLAN_OPERATION_CONTRACTS = {
  claim: {
    preconditions: [
      "goal-exists-and-is-nonterminal",
      "expected-generation-matches",
      "no-different-active-claim",
      "no-active-research-wait",
      "follow-up-has-no-wip-or-blocked-manifest-task",
    ],
    postconditions: [
      "claim-and-generation-allocated-once",
      "request-id-and-sha256-token-verifier-persisted-atomically",
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
      "entire-effect-and-review-defect-batch-validates-before-write",
    ],
    postconditions: [
      "questions-create-exact-items-and-transition-planning-to-clarifying",
      "researches-create-exact-items-and-replace-waiting-researches",
      "abandon-releases-only-the-exact-claim",
      "pause-effect-defects-release-and-acknowledgement-commit-atomically",
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
      "review-exists-is-go-ahead-and-matches-claim-generation",
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
