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
 *   gateReRan, resultCommitVerified, summary?, gateDurationMs?,
 *   gateReRanReason? }`. `verdict` is `approve | disapprove`; each `defects`
 *   item is `{ headline, description, severity, suggestedFix? }`.
 *   `gateReRan`/`resultCommitVerified` are REQUIRED (T895, closing the
 *   reviewer-side half of the D156/H135 self-report-evidence gap): a verdict
 *   must state whether the reviewer re-ran the gate itself and whether it
 *   verified the worker's `resultCommit`, rather than trusting the worker's
 *   claim silently. `gateDurationMs` is required IFF `gateReRan` is true.
 *   `gateReRanReason` is an optional free-text field for stating why the gate
 *   was not re-run when `gateReRan` is false.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two implement-reviewer verdict tokens. */
export const IMPLEMENT_REVIEW_VERDICTS = ["approve", "disapprove"] as const;

/** The required criticism when the prepare-bound implementation-review phase expires. */
export const IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM =
  "Implementation-review phase budget exhausted before a complete acceptance verdict could be established.";

/** Server-owned fields callers omit and prepare binds into the final reviewer input. */
export const IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS = [
  "responseStoreNow",
  "gateCompleteBy",
  "synthesisStoreReserveMs",
] as const;

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
    responseStoreNow: {
      type: "string",
      minLength: 1,
      description: "Prepare-bound absolute deadline by which the reviewer must store its verdict.",
    },
    gateCompleteBy: {
      type: "string",
      minLength: 1,
      description:
        "Prepare-bound absolute deadline for inspection, verification, and gate settlement.",
    },
    synthesisStoreReserveMs: {
      const: 60_000,
      description: "Reserved interval between gateCompleteBy and responseStoreNow.",
    },
  },
  required: [
    "taskId",
    "acceptance",
    "worktreePath",
    "branch",
    "baseCommit",
    "workerResult",
    "round",
    "responseStoreNow",
    "gateCompleteBy",
    "synthesisStoreReserveMs",
  ],
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
 * The verdict-block output contract (T895 evidence-carrying revision).
 * `criticism`/`questions` are string lists; `defects` is orthogonal to the
 * verdict (out-of-scope faults to file-and-defer); `summary` is optional.
 * `gateReRan` and `resultCommitVerified` are ALWAYS required — a verdict must
 * state whether the reviewer re-ran `bun run check` itself and whether it
 * verified the worker's `resultCommit` sha, rather than accepting the
 * self-report silently. `gateDurationMs` is required IFF `gateReRan` is
 * `true` via the `if`/`then` below (a real conditional, not an
 * unconditionally-required field — the negative-direction check is
 * `gateReRan: false` with no `gateDurationMs`, which must stay ACCEPTED).
 * `gateReRanReason` is an optional string for documenting why the gate was
 * not re-run when `gateReRan` is `false`.
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
    gateReRan: {
      type: "boolean",
      description:
        "Whether the reviewer re-ran `bun run check` itself rather than trusting the worker's claim.",
    },
    resultCommitVerified: {
      type: "boolean",
      description:
        "Whether the reviewer verified the worker's resultCommit sha (e.g. via cat-file / tip equality) rather than accepting it unchecked.",
    },
    gateDurationMs: {
      type: "integer",
      minimum: 0,
      description:
        "Wall-clock milliseconds the reviewer's own re-run of `bun run check` took. Required when gateReRan is true.",
    },
    gateReRanReason: {
      type: "string",
      description:
        "Optional free-text explanation for why the gate was not re-run, when gateReRan is false.",
    },
  },
  required: [
    "taskId",
    "verdict",
    "criticism",
    "questions",
    "defects",
    "rationale",
    "gateReRan",
    "resultCommitVerified",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: {
          gateReRan: { const: true },
        },
        required: ["gateReRan"],
      },
      then: {
        required: ["gateDurationMs"],
      },
    },
    {
      if: {
        properties: {
          verdict: { const: "disapprove" },
        },
        required: ["verdict"],
      },
      then: {
        anyOf: [
          {
            properties: { criticism: { minItems: 1 } },
            required: ["criticism"],
          },
          {
            properties: { questions: { minItems: 1 } },
            required: ["questions"],
          },
        ],
      },
    },
  ],
} as const;

/**
 * The implement-reviewer per-role schema sidecar (storage-format decision 3).
 * `version: 3` binds server-derived absolute phase timing into the input and
 * makes an empty disapproval invalid, so a stale deployed root rendered against
 * the old contract must not be mistaken for this one;
 * DISPATCHED_ROLE_VERSIONS derives this automatically, it is not hand-edited.
 */
export const implementReviewerSidecar: RoleSchemaSidecar = {
  id: "implement-reviewer",
  version: 3,
  inputSchema,
  outputSchema,
};
