/**
 * implement-worker role schema sidecar (T341, goal G41) — generalising the T336
 * one-role proof across the dispatched-subagent roster (storage-format decision
 * 3: per-role typed sidecar co-located under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/implement-worker.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the task spec the orchestrator passes verbatim (task id +
 *   headline + description + acceptance), optional advisory `worktreePath`
 *   (D143 — when a surface adapter supplies its own isolated worktree that one
 *   wins), branch (`implement/<taskId>`, OR a Claude native-isolation
 *   `worktree-agent-<hex>` name — D77), the verified base commit (full SHA),
 *   required `round` (T1307), authoritative `startingCommit`, optional
 *   `priorResultCommit` (round>0 resume evidence), and optional prior-round
 *   `criticism[]` on a re-dispatch after review. The resolved model class is
 *   informational; it is not load-bearing for the dispatch contract.
 *
 * - **Output** — the worker result block
 *   `{ taskId, status, resultCommit, branch, actualWorktreePath, filesTouched,
 *   checkSummary, summary, baseVerification, gitReceipts, blockedReason?,
 *   gateDurationMs?, mutationTable? }`.
 *   `status` is `pass | fail`; `resultCommit` is a full-sha string
 *   (`^[0-9a-f]{40}$`) on pass and `null` on fail. `actualWorktreePath` is the
 *   absolute path the worker actually operated in (`git rev-parse
 *   --show-toplevel`) and is ALWAYS required (D143). `baseVerification` is the
 *   T1307/G121 discriminated union: pass requires the verified full-SHA arm;
 *   fail accepts verified or unresolvable (closed reason, no fabricated SHA).
 *   `gateDurationMs` is required on a pass (T894). `mutationTable` — an array of
 *   `{mutation, observed, restored}` — is required IFF `filesTouched`
 *   intersects {@link TEST_GUARD_GLOBS} (T894, closing the D156/H135
 *   self-report-evidence gap): a worker that only touched non-test/guard
 *   files may omit it.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two worker terminal-status tokens. */
export const IMPLEMENT_WORKER_STATUSES = ["pass", "fail"] as const;

/** Full lowercase object SHA — every commit field on this contract uses it. */
export const IMPLEMENT_WORKER_FULL_SHA_PATTERN = "^[0-9a-f]{40}$";

/** The only full-gate command the trusted Codex supervisor may attest. */
export const IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND =
  'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check';

/** Typed terminal details for a completed deterministic parent-gate rejection. */
export interface ImplementWorkerSupervisedGateRejectionDetails {
  readonly kind: "cq-supervised-gate-rejection";
  readonly version: 1;
  readonly command: typeof IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND;
  readonly gateExitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly outputTail: string;
}

export const IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_KIND =
  "cq-supervised-gate-rejection" as const;
export const IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT = 896;

export function isImplementWorkerSupervisedGateRejectionDetails(
  value: unknown,
): value is ImplementWorkerSupervisedGateRejectionDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "command",
    "failCount",
    "gateExitCode",
    "kind",
    "outputTail",
    "passCount",
    "version",
  ];
  const countFields = ["gateExitCode", "passCount", "failCount"] as const;
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    record["kind"] === IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_KIND &&
    record["version"] === 1 &&
    record["command"] === IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND &&
    countFields.every(
      (field) => Number.isSafeInteger(record[field]) && (record[field] as number) >= 0,
    ) &&
    typeof record["outputTail"] === "string" &&
    Buffer.byteLength(record["outputTail"], "utf8") <=
      IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT &&
    (record["gateExitCode"] !== 0 || record["failCount"] !== 0 || record["passCount"] === 0)
  );
}

/** Versioned discriminator for runner-owned Codex full-gate evidence. */
export const IMPLEMENT_WORKER_SUPERVISED_GATE_KIND = "cq-supervised-gate-evidence" as const;

/**
 * Closed unresolvable reasons a worker may report on `baseVerification` without
 * inventing a SHA (T1307 / G121 / Q364 fail-closed). Mirrors
 * `DispatchBaseUnresolvableReason` plus the Step-0 placement mismatch arms.
 */
export const IMPLEMENT_WORKER_BASE_UNRESOLVABLE_REASONS = [
  "base-missing",
  "base-not-commit",
  "head-missing",
  "head-not-commit",
  "unrelated-histories",
  "ancestry-unobserved",
  "path-mismatch",
  "branch-mismatch",
  "starting-commit-mismatch",
  "prior-result-commit-mismatch",
] as const;

export type ImplementWorkerBaseUnresolvableReason =
  (typeof IMPLEMENT_WORKER_BASE_UNRESOLVABLE_REASONS)[number];

/**
 * The glob classification rule (T894) pinning when a worker result MUST carry
 * a `mutationTable`: a `filesTouched` entry matches one of these globs iff it
 * is a test file (`**\/test/**`, `**\/*.test.ts`) or names a guard/invariant
 * (`**\/*guard*`, `**\/*invariant*`) — the paths whose self-reported pass
 * claim needs a mutation-observed-restored record to be trustworthy. Kept as
 * a named export so a consumer (e.g. a future non-schema classifier) can
 * reuse the exact same list the JSON-Schema `if`/`then` below compiles from.
 */
export const TEST_GUARD_GLOBS = [
  "**/test/**",
  "**/*.test.ts",
  "**/*guard*",
  "**/*invariant*",
] as const;

/**
 * {@link TEST_GUARD_GLOBS}, translated to a single alternation regex usable as
 * an Ajv `pattern` inside a `contains` check over `filesTouched`. Each glob
 * segment maps literally: a leading `**` path segment becomes an optional
 * "any directory prefix" group, and a bare name segment becomes "matches
 * anywhere in the basename"; the `.test.ts` glob keeps that literal suffix.
 */
const TEST_GUARD_PATTERN =
  "(?:^(.*/)?test/.*$)" +
  "|(?:^(.*/)?[^/]*\\.test\\.ts$)" +
  "|(?:^(.*/)?[^/]*guard[^/]*$)" +
  "|(?:^(.*/)?[^/]*invariant[^/]*$)";

const fullShaString = {
  type: "string",
  pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
} as const;

/** Nullable full SHA: pattern applies only to string instances so null validates. */
const fullShaOrNull = {
  type: ["string", "null"],
  pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
} as const;

const sha256String = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
} as const;

const gitChangeReceiptSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "cq-git-change-receipt" },
    version: { type: "integer", const: 1 },
    attestationId: { type: "string", minLength: 1 },
    generation: { type: "integer", minimum: 1 },
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    operationId: { type: "string", minLength: 1 },
    requestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    oldHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    newHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    tree: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    objectOids: {
      type: "array",
      items: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    },
    paths: { type: "array", items: { type: "string", minLength: 1 } },
    committedAt: { type: "string", minLength: 1 },
  },
  required: [
    "kind",
    "version",
    "attestationId",
    "generation",
    "taskId",
    "operationId",
    "requestDigest",
    "oldHead",
    "newHead",
    "tree",
    "objectOids",
    "paths",
    "committedAt",
  ],
  additionalProperties: false,
} as const;

/**
 * Runner-owned exact-tip gate evidence. The public schema pins its complete
 * wire shape; store_result additionally resolves every binding against the
 * prepared dispatch and refuses caller-authored instances.
 */
export const implementWorkerSupervisedGateEvidenceSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: IMPLEMENT_WORKER_SUPERVISED_GATE_KIND },
    version: { type: "integer", const: 1 },
    attestationId: { type: "string", pattern: "^att_[A-Za-z0-9_-]{32,}$" },
    generation: { type: "integer", minimum: 1 },
    roleId: { type: "string", const: "implement-worker" },
    roleVersion: { type: "integer", minimum: 1 },
    surface: { type: "string", const: "codex" },
    promptDigest: sha256String,
    catalogHash: sha256String,
    inputDigest: sha256String,
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    worktreePath: { type: "string", minLength: 1 },
    branch: { type: "string", pattern: "^implement/T[0-9]+$" },
    baseCommit: fullShaString,
    startingCommit: fullShaString,
    resultCommit: fullShaString,
    clean: { type: "boolean", const: true },
    command: { type: "string", const: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND },
    gateExitCode: { type: "integer", const: 0 },
    passCount: { type: "integer", minimum: 1 },
    failCount: { type: "integer", const: 0 },
    gateDurationMs: { type: "integer", minimum: 0 },
    capturedAt: {
      type: "string",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
    },
    filesTouchedDigest: sha256String,
    gitReceiptsDigest: sha256String,
    mutationTableDigest: sha256String,
  },
  required: [
    "kind",
    "version",
    "attestationId",
    "generation",
    "roleId",
    "roleVersion",
    "surface",
    "promptDigest",
    "catalogHash",
    "inputDigest",
    "taskId",
    "worktreePath",
    "branch",
    "baseCommit",
    "startingCommit",
    "resultCommit",
    "clean",
    "command",
    "gateExitCode",
    "passCount",
    "failCount",
    "gateDurationMs",
    "capturedAt",
    "filesTouchedDigest",
    "gitReceiptsDigest",
    "mutationTableDigest",
  ],
  additionalProperties: false,
} as const;

export interface ImplementWorkerSupervisedGateEvidence {
  readonly kind: typeof IMPLEMENT_WORKER_SUPERVISED_GATE_KIND;
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly roleId: "implement-worker";
  readonly roleVersion: number;
  readonly surface: "codex";
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly inputDigest: string;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly startingCommit: string;
  readonly resultCommit: string;
  readonly clean: true;
  readonly command: typeof IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND;
  readonly gateExitCode: 0;
  readonly passCount: number;
  readonly failCount: 0;
  readonly gateDurationMs: number;
  readonly capturedAt: string;
  readonly filesTouchedDigest: string;
  readonly gitReceiptsDigest: string;
  readonly mutationTableDigest: string;
}

/**
 * Verified arm of `baseVerification` — only full object SHAs, never abbreviated
 * or fabricated placeholders (T1307).
 */
export const implementWorkerVerifiedBaseVerificationSchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "verified" },
    relation: { type: "string", enum: ["equal", "descendant"] },
    baseCommit: fullShaString,
    headCommit: fullShaString,
  },
  required: ["status", "relation", "baseCommit", "headCommit"],
  additionalProperties: false,
} as const;

/**
 * Unresolvable arm — closed reason vocabulary; commit fields are full SHA or
 * null (never a fabricated non-SHA string).
 */
export const implementWorkerUnresolvableBaseVerificationSchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "unresolvable" },
    reason: {
      type: "string",
      enum: [...IMPLEMENT_WORKER_BASE_UNRESOLVABLE_REASONS],
    },
    baseCommit: fullShaOrNull,
    headCommit: fullShaOrNull,
  },
  required: ["status", "reason", "baseCommit", "headCommit"],
  additionalProperties: false,
} as const;

/**
 * Discriminated `baseVerification` union. Pass results may only carry the
 * verified arm (enforced via `allOf` below); fail may carry either arm.
 */
export const implementWorkerBaseVerificationSchema = {
  oneOf: [
    implementWorkerVerifiedBaseVerificationSchema,
    implementWorkerUnresolvableBaseVerificationSchema,
  ],
} as const;

/**
 * The parent-supplied input contract for an implement-worker dispatch: the task
 * spec, worktree coordinates, base commit, required round, and optional
 * prior-round criticism / prior result commit.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-worker/input",
  title: "implement-worker input",
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "The task id T passed in the dispatch prompt (e.g. T341).",
      pattern: "^T[0-9]+$",
    },
    headline: { type: "string", minLength: 1 },
    description: { type: "string" },
    acceptance: { type: "string", minLength: 1 },
    worktreePath: {
      type: "string",
      minLength: 1,
      description:
        "Optional advisory path from worktree_manage prepare. When a surface adapter supplies its own isolated worktree, that one wins (D143). Preferred Claude placement is .claude/worktrees/<taskId>.",
    },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    baseCommit: {
      type: "string",
      description: "The commit the worktree was prepared from (full 40-hex object SHA).",
      pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
    },
    round: {
      type: "integer",
      description:
        "The zero-based implementation or correction round. Required end-to-end; a default of 0 is allowed only during refs-form normalization, never by omitting the field from the final worker input.",
      minimum: 0,
    },
    startingCommit: {
      type: "string",
      description: "The authoritative worktree tip immediately before this round launches.",
      pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
    },
    priorResultCommit: {
      type: ["string", "null"],
      description:
        "Prior-round worker resultCommit to revalidate when round > 0 (full SHA or null). Must be equal to or an ancestor of HEAD; the worker must not reset or rebase away from it.",
      pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
    },
    priorCriticism: {
      type: "array",
      items: { type: "string" },
      description: "Prior-round reviewer criticism[] on a re-dispatch after review.",
    },
    guardedRebaseLineage: {
      type: "object",
      description:
        "Closed server-injected guarded-rebase bridge (D334/T2150). Callers must omit it; the trusted manager injects it only after resolving the opaque guardedRebase reference against a terminal durable journal and the exact terminal prior generation. The guarded round's baseCommit equals ontoCommit and its startingCommit equals rebasedStartCommit.",
      properties: {
        guardedRebase: {
          type: "string",
          pattern: "^cq-guarded-rebase:v1:[0-9a-f]{64}$",
          description: "The resolved opaque digest-backed guarded-rebase reference.",
        },
        oldResultCommit: {
          ...fullShaString,
          description:
            "The exact terminal pre-rebase worker result tip. On the initial bridge round priorResultCommit equals exactly this value — the one exempted ancestry exception.",
        },
        ontoCommit: {
          ...fullShaString,
          description: "The exact rebase target; the guarded dispatch's diff base.",
        },
        rebasedStartCommit: {
          ...fullShaString,
          description:
            "The verified terminal rebased head; the guarded round's startingCommit. The fresh receipt suffix begins here.",
        },
        exactTip: {
          type: "boolean",
          description:
            "Server-resolved permission for the no-new-commit arm: when true the worker may report resultCommit == rebasedStartCommit with an empty fresh suffix; when false a non-empty contiguous suffix is mandatory.",
        },
      },
      required: [
        "guardedRebase",
        "oldResultCommit",
        "ontoCommit",
        "rebasedStartCommit",
        "exactTip",
      ],
      additionalProperties: false,
    },
    resolvedModel: {
      type: "string",
      description: "The resolved model class (informational).",
    },
  },
  required: ["taskId", "acceptance", "branch", "baseCommit", "round", "startingCommit"],
  additionalProperties: false,
} as const;

/**
 * The worker result-block output contract (T894 evidence-carrying revision +
 * D143 actualWorktreePath + T1307 baseVerification). `resultCommit` is
 * `string | null` — on pass it must be a FULL sha (`^[0-9a-f]{40}$`; an
 * abbreviated or non-hex value like `"deadbeef"` fails), and `null` on fail.
 * `actualWorktreePath` is ALWAYS required (D143). `baseVerification` is ALWAYS
 * required; on `status: "pass"` only the verified full-SHA arm is accepted.
 * `gateDurationMs` is required on a pass (T894 clause (b)). `mutationTable` is
 * required IFF `filesTouched` contains an entry matching
 * {@link TEST_GUARD_GLOBS} — a test/guard/invariant path — via the `if`/`then`
 * below; a worker that touched none of those may omit it entirely (T894
 * clause (d), the negative-direction check: this must stay a real
 * conditional, not an always-required field). `blockedReason` is present only
 * on fail.
 */
/** Guarded arm: the fresh post-rebase suffix is mandatory (empty only in exact-tip mode). */
const guardedReceiptSuffixArm = {
  if: { required: ["gitLineage"] },
  then: { required: ["gitReceipts"] },
} as const;

const outputMutationTableArm = {
  if: {
    properties: {
      filesTouched: {
        type: "array",
        contains: {
          type: "string",
          pattern: TEST_GUARD_PATTERN,
        },
      },
    },
    required: ["filesTouched"],
  },
  then: {
    required: ["mutationTable"],
  },
} as const;

const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-worker/output",
  title: "implement-worker result",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    status: { type: "string", enum: [...IMPLEMENT_WORKER_STATUSES] },
    resultCommit: {
      type: ["string", "null"],
      description:
        "Full 40-hex commit sha on pass (^[0-9a-f]{40}$); null on fail. The pattern applies only to a string instance, so null still validates.",
      pattern: IMPLEMENT_WORKER_FULL_SHA_PATTERN,
    },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    actualWorktreePath: {
      type: "string",
      minLength: 1,
      description:
        "Absolute path of the worktree the worker actually operated in (git rev-parse --show-toplevel). Required so the orchestrator learns harness-minted paths (D143).",
    },
    filesTouched: { type: "array", items: { type: "string" } },
    gitReceipts: {
      type: "array",
      description:
        "Fresh dispatch-bound broker receipts returned to this worker generation. Both ordinary and guarded correction rounds omit the protected inherited prefix; the server reconstructs and validates the complete durable chain. The suffix may be empty when the generation performs no Git effect; the server rejects an empty complete chain.",
      items: {
        ...gitChangeReceiptSchema,
      },
    },
    gitLineage: {
      type: "object",
      description:
        "Closed guarded-rebase discriminant (D334/T2150). Omitted by ordinary workers; a guarded worker reports exactly the server-injected lineage coordinates and treats gitReceipts as the fresh post-rebase suffix. A caller can never mint this arm: store_result resolves it against the persisted dispatch Git binding.",
      properties: {
        kind: { type: "string", const: "guarded-rebase" },
        guardedRebase: {
          type: "string",
          pattern: "^cq-guarded-rebase:v1:[0-9a-f]{64}$",
        },
        ontoCommit: fullShaString,
        rebasedStartCommit: fullShaString,
        exactTip: { type: "boolean" },
      },
      required: ["kind", "guardedRebase", "ontoCommit", "rebasedStartCommit", "exactTip"],
      additionalProperties: false,
    },
    checkSummary: { type: "string" },
    summary: { type: "string" },
    baseVerification: {
      ...implementWorkerBaseVerificationSchema,
      description:
        "T1307/G121 Step-0 base evidence. Pass requires the verified full-SHA arm; fail accepts verified or unresolvable with a closed reason and null SHAs where unobserved.",
    },
    blockedReason: { type: "string" },
    gateDurationMs: {
      type: "integer",
      minimum: 0,
      description: 'Wall-clock milliseconds `bun run check` took. Required when status is "pass".',
    },
    supervisedGateEvidence: {
      ...implementWorkerSupervisedGateEvidenceSchema,
      description:
        "Runner-owned Codex exact-tip gate evidence. This arm is mutually exclusive with the legacy in-child gateDurationMs arm and is accepted only after store_result resolves it against the prepared dispatch.",
    },
    mutationTable: {
      type: "array",
      description:
        "Evidence rows for a claimed mutation/guard change: one {mutation, observed, restored} " +
        "triple per test/guard mutated. REQUIRED iff filesTouched intersects TEST_GUARD_GLOBS = " +
        "['**/test/**', '**/*.test.ts', '**/*guard*', '**/*invariant*'] — i.e. at least one " +
        "filesTouched entry is under a test/ directory, ends in .test.ts, or names a guard or " +
        "invariant. Omit entirely when no touched file matches (do not send an empty array).",
      items: {
        type: "object",
        properties: {
          mutation: { type: "string" },
          observed: { type: "string" },
          restored: { type: "string" },
        },
        required: ["mutation", "observed", "restored"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "taskId",
    "status",
    "resultCommit",
    "branch",
    "actualWorktreePath",
    "filesTouched",
    "checkSummary",
    "summary",
    "baseVerification",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: {
          status: { const: "pass" },
        },
        required: ["status"],
      },
      then: {
        oneOf: [
          {
            required: ["gateDurationMs"],
            not: { required: ["supervisedGateEvidence"] },
          },
          {
            required: ["supervisedGateEvidence"],
            not: { required: ["gateDurationMs"] },
          },
        ],
        properties: {
          baseVerification: implementWorkerVerifiedBaseVerificationSchema,
        },
      },
    },
    outputMutationTableArm,
    {
      if: { required: ["supervisedGateEvidence"] },
      then: {
        properties: { status: { const: "pass" } },
        required: ["status"],
      },
    },
    guardedReceiptSuffixArm,
  ],
} as const;

/** Parent-gated pass output before runner-owned evidence is attached. */
export const implementWorkerStagedOutputSchema = {
  ...outputSchema,
  allOf: [
    {
      if: {
        properties: { status: { const: "pass" } },
        required: ["status"],
      },
      then: {
        not: {
          anyOf: [
            { required: ["gateDurationMs"] },
            { required: ["supervisedGateEvidence"] },
          ],
        },
        properties: { baseVerification: implementWorkerVerifiedBaseVerificationSchema },
      },
    },
    outputMutationTableArm,
    guardedReceiptSuffixArm,
  ],
} as const;

/**
 * The implement-worker per-role schema sidecar (storage-format decision 3).
 * `version: 10` (bumped from 9, T2852): inherited receipts leave the worker
 * input and every correction output carries only its fresh receipt suffix.
 * The server reconstructs and validates the complete durable chain. A stale
 * deployed root rendered against the v9 contract must not be mistaken for this one.
 * DISPATCHED_ROLE_VERSIONS derives this automatically; it is not hand-edited.
 */
export const implementWorkerSidecar: RoleSchemaSidecar = {
  id: "implement-worker",
  version: 10,
  inputSchema,
  outputSchema,
};
