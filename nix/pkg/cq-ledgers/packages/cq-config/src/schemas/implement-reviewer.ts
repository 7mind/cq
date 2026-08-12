/**
 * implement-reviewer role schema sidecar (T341, goal G41) — generalising the
 * T336 one-role proof across the dispatched-subagent roster (storage-format
 * decision 3: per-role typed sidecar co-located under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/implement-reviewer.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the task spec (id + headline + description + acceptance), the
 *   worktree path + branch + base commit (full SHA), the worker's structured
 *   result (`{ resultCommit, checkSummary, filesTouched }`), the round number,
 *   any prior criticism already addressed, and optionally a parent-attested gate
 *   (K235 / T2007) for Codex sandboxed reviewers that cannot re-run the gate.
 *
 * - **Output** — the verdict block
 *   `{ taskId, verdict, criticism[], questions[], defects[], rationale,
 *   gateReRan, resultCommitVerified, resultCommitEvidence, baseAncestry,
 *   summary?, gateDurationMs?, gateReRanReason? }`. `verdict` is
 *   `approve | disapprove`; each `defects` item is
 *   `{ headline, description, severity, suggestedFix? }`.
 *   `gateReRan`/`resultCommitVerified` remain REQUIRED (T895). T1308/G121 adds
 *   required structured `resultCommitEvidence` and `baseAncestry` as closed
 *   verified-or-unresolvable unions with full object SHAs only on the verified
 *   arm. Approval requires both verified; disapproval may record unresolvable
 *   evidence with nullable observed values and a closed reason. `gateDurationMs`
 *   is required IFF `gateReRan` is true. `gateReRanReason` is optional free-text
 *   (including K235 `sandbox-denied-primitives`).
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";
import {
  implementWorkerSupervisedGateEvidenceSchema,
  type ImplementWorkerSupervisedGateEvidence,
} from "./implement-worker.js";

/** The two implement-reviewer verdict tokens. */
export const IMPLEMENT_REVIEW_VERDICTS = ["approve", "disapprove"] as const;

/** The required criticism when the prepare-bound implementation-review phase expires. */
export const IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM =
  "Implementation-review phase budget exhausted before a complete acceptance verdict could be established.";

/**
 * gateReRanReason token for the K235 parent-attested sandbox path: the reviewer
 * verified a parent-supplied green gate attestation instead of re-running
 * `cq gate` inside a sandbox that denies gate primitives.
 */
export const SANDBOX_DENIED_PRIMITIVES_GATE_REASON = "sandbox-denied-primitives" as const;

/** Full lowercase object SHA used on every commit field of this contract. */
export const IMPLEMENT_REVIEWER_FULL_SHA_PATTERN = "^[0-9a-f]{40}$";

/** Closed reasons when result-commit evidence cannot be established. */
export const IMPLEMENT_REVIEWER_RESULT_COMMIT_UNRESOLVABLE_REASONS = [
  "result-commit-missing",
  "result-commit-not-commit",
  "result-commit-malformed",
  "branch-tip-mismatch",
  "branch-unresolvable",
  "worktree-unresolvable",
] as const;

export type ImplementReviewerResultCommitUnresolvableReason =
  (typeof IMPLEMENT_REVIEWER_RESULT_COMMIT_UNRESOLVABLE_REASONS)[number];

/** Closed reasons when base ancestry cannot be established. */
export const IMPLEMENT_REVIEWER_BASE_ANCESTRY_UNRESOLVABLE_REASONS = [
  "base-missing",
  "base-not-commit",
  "result-commit-missing",
  "result-commit-not-commit",
  "merge-base-unobserved",
  "not-ancestor",
  "unrelated-histories",
] as const;

export type ImplementReviewerBaseAncestryUnresolvableReason =
  (typeof IMPLEMENT_REVIEWER_BASE_ANCESTRY_UNRESOLVABLE_REASONS)[number];

/** Server-owned fields callers omit and prepare binds into the final reviewer input. */
export const IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS = [
  "responseStoreNow",
  "gateCompleteBy",
  "synthesisStoreReserveMs",
] as const;

/** The `defects`-ledger severity vocabulary a reported defect carries. */
const DEFECT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

const fullShaString = {
  type: "string",
  pattern: IMPLEMENT_REVIEWER_FULL_SHA_PATTERN,
} as const;

const fullShaOrNull = {
  type: ["string", "null"],
  pattern: IMPLEMENT_REVIEWER_FULL_SHA_PATTERN,
} as const;

/**
 * Verified result-commit evidence: object type commit, equals branch tip, full
 * SHAs only (T1308).
 */
export const implementReviewerVerifiedResultCommitEvidenceSchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "verified" },
    resultCommit: fullShaString,
    branchTip: fullShaString,
  },
  required: ["status", "resultCommit", "branchTip"],
  additionalProperties: false,
} as const;

/** Unresolvable result-commit evidence with closed reason and nullable SHAs. */
export const implementReviewerUnresolvableResultCommitEvidenceSchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "unresolvable" },
    reason: {
      type: "string",
      enum: [...IMPLEMENT_REVIEWER_RESULT_COMMIT_UNRESOLVABLE_REASONS],
    },
    resultCommit: fullShaOrNull,
    branchTip: fullShaOrNull,
  },
  required: ["status", "reason", "resultCommit", "branchTip"],
  additionalProperties: false,
} as const;

export const implementReviewerResultCommitEvidenceSchema = {
  oneOf: [
    implementReviewerVerifiedResultCommitEvidenceSchema,
    implementReviewerUnresolvableResultCommitEvidenceSchema,
  ],
} as const;

/**
 * Verified base ancestry: dispatch base is an ancestor of resultCommit; exact
 * full SHAs including observed merge-base (T1308).
 */
export const implementReviewerVerifiedBaseAncestrySchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "verified" },
    relation: { type: "string", enum: ["equal", "descendant"] },
    baseCommit: fullShaString,
    resultCommit: fullShaString,
    mergeBase: fullShaString,
  },
  required: ["status", "relation", "baseCommit", "resultCommit", "mergeBase"],
  additionalProperties: false,
} as const;

/** Unresolvable base ancestry with closed reason and nullable observed SHAs. */
export const implementReviewerUnresolvableBaseAncestrySchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "unresolvable" },
    reason: {
      type: "string",
      enum: [...IMPLEMENT_REVIEWER_BASE_ANCESTRY_UNRESOLVABLE_REASONS],
    },
    baseCommit: fullShaOrNull,
    resultCommit: fullShaOrNull,
    mergeBase: fullShaOrNull,
  },
  required: ["status", "reason", "baseCommit", "resultCommit", "mergeBase"],
  additionalProperties: false,
} as const;

export const implementReviewerBaseAncestrySchema = {
  oneOf: [
    implementReviewerVerifiedBaseAncestrySchema,
    implementReviewerUnresolvableBaseAncestrySchema,
  ],
} as const;

/**
 * The worker's structured result the reviewer is handed (a subset of the worker
 * output: the fields the reviewer judges against). Kept open beyond these three
 * since the orchestrator may pass the full worker block through.
 */
const workerResultSchema = {
  type: "object",
  properties: {
    resultCommit: { type: ["string", "null"], pattern: IMPLEMENT_REVIEWER_FULL_SHA_PATTERN },
    checkSummary: { type: "string" },
    filesTouched: { type: "array", items: { type: "string" } },
  },
  required: ["resultCommit", "checkSummary", "filesTouched"],
  additionalProperties: true,
} as const;

/**
 * Parent-attested full-gate evidence (K235 / T2007). The parent attaches this
 * when launching a Codex sandboxed implement-reviewer whose sandbox denies
 * reliable gate primitives; the reviewer verifies it against `resultCommit`
 * instead of re-running `cq gate` inside the sandbox.
 */
const parentGateAttestationSchema = {
  type: "object",
  properties: {
    resultCommit: {
      type: "string",
      pattern: IMPLEMENT_REVIEWER_FULL_SHA_PATTERN,
      description: "The commit SHA the parent gate observed (must equal worker resultCommit).",
    },
    gateExitCode: {
      type: "integer",
      description: "Exit status of the parent-run full gate (0 = green).",
    },
    passCount: {
      type: "integer",
      minimum: 0,
      description: "Number of passing checks observed by the parent gate.",
    },
    failCount: {
      type: "integer",
      minimum: 0,
      description: "Number of failing checks observed by the parent gate.",
    },
    gateDurationMs: {
      type: "integer",
      minimum: 0,
      description: "Optional wall-clock milliseconds the parent gate took.",
    },
    command: {
      type: "string",
      minLength: 1,
      description: "The exact full-gate command the parent ran.",
    },
    capturedAt: {
      type: "string",
      minLength: 1,
      description: "ISO-8601 instant when the parent captured the gate evidence.",
    },
  },
  required: [
    "resultCommit",
    "gateExitCode",
    "passCount",
    "failCount",
    "command",
    "capturedAt",
  ],
  additionalProperties: false,
} as const;

/**
 * Structured parent-attested gate evidence attached to an implement-reviewer
 * dispatch when the Codex sandbox denies reliable gate primitives (K235).
 */
export interface ParentGateAttestation {
  readonly resultCommit: string;
  readonly gateExitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly gateDurationMs?: number;
  readonly command: string;
  readonly capturedAt: string;
}

/**
 * Semantic acceptance for a parent-attested gate (K235): exact commit match
 * against the worker `resultCommit`, green exit, zero failures, and at least
 * one passing check. Shape validation is the input schema's job; this helper
 * only enforces the green-attestation predicates an approving reviewer must
 * observe before setting `gateReRan=false` with
 * `gateReRanReason=sandbox-denied-primitives`.
 */
export function validateParentGateAttestation(
  attestation: ParentGateAttestation,
  expectedCommit: string,
): boolean {
  if (attestation.resultCommit !== expectedCommit) return false;
  if (attestation.gateExitCode !== 0) return false;
  if (attestation.failCount !== 0) return false;
  if (!(attestation.passCount > 0)) return false;
  return true;
}

/** Reviewer-side semantic binding for consumed runner-owned worker evidence. */
export function validateSupervisedWorkerGateEvidenceForReview(
  evidence: ImplementWorkerSupervisedGateEvidence,
  expected: {
    readonly taskId: string;
    readonly resultCommit: string;
    readonly branch: string;
    readonly worktreePath: string;
  },
): boolean {
  return (
    evidence.taskId === expected.taskId &&
    evidence.resultCommit === expected.resultCommit &&
    evidence.branch === expected.branch &&
    evidence.worktreePath === expected.worktreePath &&
    evidence.clean === true &&
    evidence.gateExitCode === 0 &&
    evidence.failCount === 0 &&
    evidence.passCount > 0
  );
}

/**
 * The parent-supplied input contract for an implement-reviewer dispatch: the
 * task spec, worktree coordinates, the worker's result, the round number, and
 * prior criticism already addressed. Optional `parentGateAttestation` carries
 * K235 parent-run full-gate evidence for the Codex sandbox-denied path.
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
    worktreePath: {
      type: "string",
      minLength: 1,
      description:
        "Optional advisory path. When a surface adapter supplies its own isolated worktree, that one wins (D143).",
    },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    baseCommit: {
      type: "string",
      pattern: IMPLEMENT_REVIEWER_FULL_SHA_PATTERN,
      description: "Dispatch base commit (full 40-hex object SHA) used for ancestry verification.",
    },
    workerResult: workerResultSchema,
    round: { type: "integer", minimum: 1 },
    priorCriticism: { type: "array", items: { type: "string" } },
    parentGateAttestation: parentGateAttestationSchema,
    supervisedGateEvidence: implementWorkerSupervisedGateEvidenceSchema,
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
 * The verdict-block output contract (T895 evidence-carrying revision + T1308
 * structured resultCommit/baseAncestry). `criticism`/`questions` are string
 * lists; `defects` is orthogonal to the verdict; `summary` is optional.
 * `gateReRan` and `resultCommitVerified` are ALWAYS required. Structured
 * `resultCommitEvidence` and `baseAncestry` are ALWAYS required. Approval
 * requires both verified arms (via `allOf` below). `gateDurationMs` is required
 * IFF `gateReRan` is `true`.
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
        "Whether the reviewer verified the worker's resultCommit sha (cat-file + tip equality) rather than accepting it unchecked.",
    },
    resultCommitEvidence: {
      ...implementReviewerResultCommitEvidenceSchema,
      description:
        "T1308 structured result-commit evidence. Approval requires the verified arm (commit object + branch tip equality, full SHAs).",
    },
    baseAncestry: {
      ...implementReviewerBaseAncestrySchema,
      description:
        "T1308 structured base-ancestry evidence. Approval requires the verified arm (dispatch base ancestor of resultCommit, exact merge-base full SHA).",
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
    actualWorktreePath: {
      type: "string",
      minLength: 1,
      description:
        "Optional absolute path of the worktree the reviewer actually inspected (D143).",
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
    "resultCommitEvidence",
    "baseAncestry",
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
    {
      if: {
        properties: {
          verdict: { const: "approve" },
        },
        required: ["verdict"],
      },
      then: {
        properties: {
          resultCommitVerified: { const: true },
          resultCommitEvidence: implementReviewerVerifiedResultCommitEvidenceSchema,
          baseAncestry: implementReviewerVerifiedBaseAncestrySchema,
        },
        required: ["resultCommitVerified", "resultCommitEvidence", "baseAncestry"],
      },
    },
  ],
} as const;

/**
 * The implement-reviewer per-role schema sidecar (storage-format decision 3).
 * `version: 7` (bumped from 6, T2081): sandboxed Codex reviewers may consume
 * the exact runner-owned gate evidence stored with a process worker result.
 * Existing parentGateAttestation and non-sandboxed child rerun paths remain.
 * A stale deployed root rendered against the v6 contract must not be mistaken for this
 * one; DISPATCHED_ROLE_VERSIONS derives this automatically, it is not
 * hand-edited.
 */
export const implementReviewerSidecar: RoleSchemaSidecar = {
  id: "implement-reviewer",
  version: 7,
  inputSchema,
  outputSchema,
};
