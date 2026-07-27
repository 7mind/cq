/**
 * plan-advance role schema sidecar (T336, goal G41 — the FIRST proof-of-one-role
 * for the typed prompt catalog; T854 / G99 — the guarded plan protocol).
 *
 * The schemas below are authored DIRECTLY from `cq-assets/agents/plan-advance.md`
 * — its `## Catalogue` block and its DEFAULT/CANDIDATE mode contracts:
 *
 * - **Input** — a goal id `G`, plus the explicit CANDIDATE-mode flag the
 *   orchestrator sets when it dispatches one of N parallel candidate planners
 *   (generate-N-then-judge, Q100/Q101). The ledger state for `G` is read by the
 *   subagent itself via the ledger MCP tools, so it is not part of the
 *   parent-supplied input contract; the parent supplies the goal id and the mode.
 *
 * - **Output** — mode-gated, so a `oneOf`:
 *   - DEFAULT mode returns a typed **PlanStepResult** (T854): exactly one
 *     `action` of `questions | researches | draft | finalize | awaiting |
 *     noop`, the payload that action requires, an optional `grounding`, and an
 *     optional orthogonal `defectsToFile` batch. The planner writes NOTHING;
 *     the orchestrator validates the whole result against this schema and
 *     applies it through the ONE matching guarded plan mutation
 *     (`release_plan_claim` / `publish_plan_draft` / `finalize_plan`),
 *     supplying `defectsToFile` as that operation's `reviewDefects`. The
 *     payload shapes mirror the guarded mutations' own input contracts
 *     verbatim (the pause question/research drafts, the keyed publish
 *     manifest, the finalize decision, the review-defect batch).
 *   - CANDIDATE mode returns a fenced-json candidate task-DAG `{ milestones[],
 *     tasks[], rationale }` and writes nothing (UNCHANGED — configured
 *     candidates retain the DAG schema).
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/**
 * The six DEFAULT-mode PlanStepResult actions, in the asset's order. Exported
 * so the downstream dispatch/return flow can reuse the exact set.
 */
export const PLAN_STEP_ACTIONS = [
  "questions",
  "researches",
  "draft",
  "finalize",
  "awaiting",
  "noop",
] as const;

/** The cross-tool model-tier vocabulary a candidate task carries. */
const MODEL_TIERS = ["frontier", "standard", "fast"] as const;

/** The four review-defect severities (the defects schema's closed enum). */
const DEFECT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** Client-key slug grammar (mirrors the guarded mutations' CLIENT_KEY_RE). */
const CLIENT_KEY_PATTERN = "^[A-Za-z][A-Za-z0-9_-]*$";

/**
 * The parent-supplied input contract for a plan-advance dispatch: the goal id and
 * the optional candidate-mode flag. `goalId` matches the ledger goal-id token
 * shape (`G` followed by digits, e.g. `G41`).
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/plan-advance/input",
  title: "plan-advance input",
  type: "object",
  properties: {
    goalId: {
      type: "string",
      description: "The goal id G passed in the dispatch prompt (e.g. G41).",
      pattern: "^G[0-9]+$",
    },
    candidateMode: {
      type: "boolean",
      description:
        "True iff the orchestrator dispatched this planner in CANDIDATE mode (one of N parallel candidate planners under generate-N-then-judge). Absent/false ⇒ DEFAULT single-planner mode.",
    },
  },
  required: ["goalId"],
  additionalProperties: false,
} as const;

// --- DEFAULT-mode payload shapes (mirror the guarded plan mutations) --------

/** A question draft in the `questions` pause effect. */
const questionDraftSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: CLIENT_KEY_PATTERN },
    question: { type: "string", minLength: 1 },
    context: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
  required: ["key", "question"],
  additionalProperties: false,
} as const;

/** A research draft in the `researches` pause effect. */
const researchDraftSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: CLIENT_KEY_PATTERN },
    question: { type: "string", minLength: 1 },
    scope: { type: "string" },
  },
  required: ["key", "question"],
  additionalProperties: false,
} as const;

/**
 * A typed reference inside a draft manifest: another draft entry by key, or an
 * already-persisted ledger item by `<ledger>:<id>` (mirrors
 * PlanDraftReferenceSchema).
 */
const draftReferenceSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["draft-milestone"] },
        key: { type: "string", pattern: CLIENT_KEY_PATTERN },
      },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["draft-task"] },
        key: { type: "string", pattern: CLIENT_KEY_PATTERN },
      },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ledger"] },
        ref: { type: "string", minLength: 1 },
      },
      required: ["kind", "ref"],
      additionalProperties: false,
    },
  ],
} as const;

const draftMilestoneSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: CLIENT_KEY_PATTERN },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    dependsOn: { type: "array", items: draftReferenceSchema },
    blockedBy: { type: "array", items: draftReferenceSchema },
  },
  required: ["key", "title"],
  additionalProperties: false,
} as const;

const draftTaskSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: CLIENT_KEY_PATTERN },
    milestoneKey: { type: "string", pattern: CLIENT_KEY_PATTERN },
    headline: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptance: { type: "string" },
    suggestedModel: { type: "string", enum: [...MODEL_TIERS] },
    sourceRefs: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    dependsOn: { type: "array", items: draftReferenceSchema },
    blockedBy: { type: "array", items: draftReferenceSchema },
  },
  required: ["key", "milestoneKey", "headline"],
  additionalProperties: false,
} as const;

/**
 * The COMPLETE keyed draft manifest for the `draft` action (mirrors
 * PlanDraftManifestSchema; cross-key integrity — unique keys, known
 * milestoneKey/reference targets — is enforced by the guarded publish itself).
 */
const draftManifestSchema = {
  type: "object",
  properties: {
    milestones: { type: "array", items: draftMilestoneSchema, minItems: 1 },
    tasks: { type: "array", items: draftTaskSchema, minItems: 1 },
  },
  required: ["milestones", "tasks"],
  additionalProperties: false,
} as const;

/** The `finalize` action payload: the go-ahead review and the decision to lock. */
const finalizePayloadSchema = {
  type: "object",
  properties: {
    reviewId: { type: "string", pattern: "^R[0-9]+$" },
    decision: {
      type: "object",
      properties: {
        headline: { type: "string", minLength: 1 },
        rationale: { type: "string" },
        alternatives: { type: "string" },
      },
      required: ["headline"],
      additionalProperties: false,
    },
  },
  required: ["reviewId", "decision"],
  additionalProperties: false,
} as const;

/**
 * The orthogonal review-defect batch (mirrors PlanReviewDefectBatchSchema):
 * defects the review reported, filed atomically with the action's guarded
 * operation as its `reviewDefects`.
 */
const defectsToFileSchema = {
  type: "object",
  properties: {
    reviewId: { type: "string", pattern: "^R[0-9]+$" },
    defects: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          key: { type: "string", pattern: CLIENT_KEY_PATTERN },
          headline: { type: "string", minLength: 1 },
          severity: { type: "string", enum: [...DEFECT_SEVERITIES] },
          description: { type: "string" },
          rootCause: { type: "string" },
          suggestedFix: { type: "string" },
          sourceRefs: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["key", "headline", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviewId", "defects"],
  additionalProperties: false,
} as const;

/** The payload field each payload-bearing action requires. */
const ACTION_PAYLOAD_FIELD = {
  questions: "questions",
  researches: "researches",
  draft: "manifest",
  finalize: "finalize",
} as const;

const PAYLOAD_FIELDS = ["questions", "researches", "manifest", "finalize"] as const;

/**
 * Per-action payload rules: a payload-bearing action REQUIRES its field and
 * FORBIDS the other actions' payload fields; `awaiting`/`noop` forbid every
 * payload field. (`grounding` and `defectsToFile` are orthogonal — allowed on
 * every action.)
 */
const actionPayloadRules = [
  ...Object.entries(ACTION_PAYLOAD_FIELD).map(([action, field]) => ({
    if: { properties: { action: { const: action } }, required: ["action"] },
    then: {
      required: [field],
      not: {
        anyOf: PAYLOAD_FIELDS.filter((other) => other !== field).map((other) => ({
          required: [other],
        })),
      },
    },
  })),
  ...["awaiting", "noop"].map((action) => ({
    if: { properties: { action: { const: action } }, required: ["action"] },
    then: {
      not: { anyOf: PAYLOAD_FIELDS.map((field) => ({ required: [field] })) },
    },
  })),
] as const;

// --- CANDIDATE-mode shapes (UNCHANGED — the DAG schema) ---------------------

/**
 * A candidate work-milestone in CANDIDATE-mode output: a title and optional
 * dependsOn (other milestone titles in the same array).
 */
const candidateMilestoneSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    dependsOn: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

/**
 * A candidate task in CANDIDATE-mode output, mirroring the `tasks`-ledger schema
 * fields verbatim (headline, description, acceptance, suggestedModel, milestone,
 * dependsOn?, ledgerRefs) so the judge can map them onto the guarded publish
 * manifest with a mechanical key assignment.
 */
const candidateTaskSchema = {
  type: "object",
  properties: {
    headline: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptance: { type: "string" },
    suggestedModel: { type: "string", enum: [...MODEL_TIERS] },
    milestone: { type: "string", minLength: 1 },
    dependsOn: { type: "array", items: { type: "string" } },
    ledgerRefs: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "acceptance", "suggestedModel", "milestone", "ledgerRefs"],
  additionalProperties: false,
} as const;

/**
 * The mode-gated output contract: EITHER a DEFAULT-mode typed PlanStepResult OR
 * a CANDIDATE-mode task-DAG. Modelled as a `oneOf` because exactly one applies
 * per dispatch.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/plan-advance/output",
  title: "plan-advance output",
  oneOf: [
    {
      title: "DEFAULT-mode PlanStepResult",
      type: "object",
      properties: {
        mode: { type: "string", enum: ["default"] },
        action: { type: "string", enum: [...PLAN_STEP_ACTIONS] },
        grounding: { type: "string" },
        questions: { type: "array", items: questionDraftSchema, minItems: 1 },
        researches: { type: "array", items: researchDraftSchema, minItems: 1 },
        manifest: draftManifestSchema,
        finalize: finalizePayloadSchema,
        defectsToFile: defectsToFileSchema,
      },
      required: ["mode", "action"],
      additionalProperties: false,
      allOf: [...actionPayloadRules],
    },
    {
      title: "CANDIDATE-mode task-DAG",
      type: "object",
      properties: {
        mode: { type: "string", enum: ["candidate"] },
        milestones: { type: "array", items: candidateMilestoneSchema },
        tasks: { type: "array", items: candidateTaskSchema },
        rationale: { type: "string" },
      },
      required: ["mode", "milestones", "tasks", "rationale"],
      additionalProperties: false,
    },
  ],
} as const;

/** The plan-advance per-role schema sidecar (storage-format decision 3). */
export const planAdvanceSidecar: RoleSchemaSidecar = {
  id: "plan-advance",
  version: 1,
  inputSchema,
  outputSchema,
};
