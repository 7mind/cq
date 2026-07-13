/**
 * implement-reviewer role schema sidecar (T341, goal G41) — generalising the
 * T336 one-role proof across the dispatched-subagent roster (storage-format
 * decision 3: per-role typed sidecar co-located under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/implement-reviewer.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the task spec (id + headline + description + acceptance), the
 *   worktree path + branch + base commit, the worker's structured result
 *   (`{ resultCommit, checkSummary, filesTouched }`), the round number, and any
 *   prior criticism already addressed.
 *
 * - **Output** — the verdict block
 *   `{ taskId, verdict, criticism[], questions[], defects[], rationale,
 *   summary? }`. `verdict` is `approve | disapprove`; each `defects` item is
 *   `{ headline, description, severity, suggestedFix? }`.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two implement-reviewer verdict tokens. */
export const IMPLEMENT_REVIEW_VERDICTS = ["approve", "disapprove"] as const;

/** The `defects`-ledger severity vocabulary a reported defect carries. */
const DEFECT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

/**
 * The worker's structured result the reviewer is handed (a subset of the worker
 * output: the fields the reviewer judges against). Kept open beyond these three
 * since the orchestrator may pass the full worker block through.
 */
const workerResultSchema = {
  type: "object",
  properties: {
    resultCommit: { type: ["string", "null"] },
    checkSummary: { type: "string" },
    filesTouched: { type: "array", items: { type: "string" } },
  },
  required: ["resultCommit", "checkSummary", "filesTouched"],
  additionalProperties: true,
} as const;

/**
 * The parent-supplied input contract for an implement-reviewer dispatch: the
 * task spec, worktree coordinates, the worker's result, the round number, and
 * prior criticism already addressed.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-reviewer/input",
  title: "implement-reviewer input",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    headline: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptance: { type: "string", minLength: 1 },
    worktreePath: { type: "string", minLength: 1 },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    baseCommit: { type: "string", minLength: 1 },
    workerResult: workerResultSchema,
    round: { type: "integer", minimum: 1 },
    priorCriticism: { type: "array", items: { type: "string" } },
  },
  required: ["taskId", "acceptance", "worktreePath", "branch", "baseCommit", "workerResult", "round"],
  additionalProperties: false,
} as const;

/**
 * A reported out-of-scope / pre-existing defect — the `defects`-ledger
 * vocabulary the reviewer returns. `severity` is REQUIRED; `suggestedFix` is
 * optional. Note the implement-side shape carries `description` (required),
 * unlike the plan-side reviewer's `rootCause`.
 */
const defectSchema = {
  type: "object",
  properties: {
    headline: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    severity: { type: "string", enum: [...DEFECT_SEVERITIES] },
    suggestedFix: { type: "string" },
  },
  required: ["headline", "description", "severity"],
  additionalProperties: false,
} as const;

/**
 * The verdict-block output contract. `criticism`/`questions` are string lists;
 * `defects` is orthogonal to the verdict (out-of-scope faults to file-and-defer);
 * `summary` is optional.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-reviewer/output",
  title: "implement-reviewer verdict",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    verdict: { type: "string", enum: [...IMPLEMENT_REVIEW_VERDICTS] },
    criticism: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    defects: { type: "array", items: defectSchema },
    rationale: { type: "string" },
    summary: { type: "string" },
  },
  required: ["taskId", "verdict", "criticism", "questions", "defects", "rationale"],
  additionalProperties: false,
} as const;

/** The implement-reviewer per-role schema sidecar (storage-format decision 3). */
export const implementReviewerSidecar: RoleSchemaSidecar = {
  id: "implement-reviewer",
  version: 1,
  inputSchema,
  outputSchema,
};
