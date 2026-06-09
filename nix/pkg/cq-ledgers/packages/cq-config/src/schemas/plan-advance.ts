/**
 * plan-advance role schema sidecar (T336, goal G41) — the FIRST proof-of-one-role
 * for the typed prompt catalog (storage-format decision 3: per-role typed sidecar
 * co-located under `./schemas/`, not embedded in the prose `## Catalogue` block).
 *
 * The schemas below are authored DIRECTLY from `cq-assets/agents/plan-advance.md`
 * — its `## Catalogue` block and its DEFAULT/CANDIDATE mode contract:
 *
 * - **Input** — a goal id `G`, plus the explicit CANDIDATE-mode flag the
 *   orchestrator sets when it dispatches one of N parallel candidate planners
 *   (generate-N-then-judge, Q100/Q101). The ledger state for `G` is read by the
 *   subagent itself via the ledger MCP tools, so it is not part of the
 *   parent-supplied input contract; the parent supplies the goal id and the mode.
 *
 * - **Output** — mode-gated, so a `oneOf`:
 *   - DEFAULT mode returns exactly one STATUS TOKEN (the last line of the reply):
 *     `awaiting-answers | review-requested | completed | noop`.
 *   - CANDIDATE mode returns a fenced-json candidate task-DAG `{ milestones[],
 *     tasks[], rationale }` and writes nothing. The task/milestone field shapes
 *     mirror the asset's verbatim candidate-JSON contract.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/**
 * The four DEFAULT-mode status tokens, in the asset's order. Exported so the
 * downstream dispatch/return flow (later chain tasks) can reuse the exact set.
 */
export const PLAN_ADVANCE_STATUS_TOKENS = [
  "awaiting-answers",
  "review-requested",
  "completed",
  "noop",
] as const;

/** The cross-tool model-tier vocabulary a candidate task carries. */
const MODEL_TIERS = ["frontier", "standard", "fast"] as const;

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
 * dependsOn?, ledgerRefs) so the judge can feed them straight into create_item.
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
 * The mode-gated output contract: EITHER a DEFAULT-mode status token OR a
 * CANDIDATE-mode task-DAG. Modelled as a `oneOf` because exactly one applies per
 * dispatch.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/plan-advance/output",
  title: "plan-advance output",
  oneOf: [
    {
      title: "DEFAULT-mode status token",
      type: "object",
      properties: {
        mode: { type: "string", enum: ["default"] },
        status: { type: "string", enum: [...PLAN_ADVANCE_STATUS_TOKENS] },
      },
      required: ["mode", "status"],
      additionalProperties: false,
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
