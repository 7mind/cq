/**
 * implement-worker role schema sidecar (T341, goal G41) — generalising the T336
 * one-role proof across the dispatched-subagent roster (storage-format decision
 * 3: per-role typed sidecar co-located under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/implement-worker.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the task spec the orchestrator passes verbatim (task id +
 *   headline + description + acceptance), the worktree path + branch
 *   (`implement/<taskId>`, OR a Claude native-isolation `worktree-agent-<hex>`
 *   name — D77), the base commit, and an optional prior-round `criticism[]` on
 *   a re-dispatch after review. The resolved model class is informational; it
 *   is not load-bearing for the dispatch contract.
 *
 * - **Output** — the worker result block
 *   `{ taskId, status, resultCommit, branch, filesTouched, checkSummary,
 *   summary, blockedReason?, gateDurationMs?, mutationTable? }`. `status` is
 *   `pass | fail`; `resultCommit` is a full-sha string (`^[0-9a-f]{40}$`) on
 *   pass and `null` on fail. `gateDurationMs` is required on a pass (T894).
 *   `mutationTable` — an array of `{mutation, observed, restored}` — is
 *   required IFF `filesTouched` intersects {@link TEST_GUARD_GLOBS} (T894,
 *   closing the D156/H135 self-report-evidence gap): a worker that only
 *   touched non-test/guard files may omit it.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two worker terminal-status tokens. */
export const IMPLEMENT_WORKER_STATUSES = ["pass", "fail"] as const;

/**
 * The glob classification rule (T894) pinning when a worker result MUST carry
 * a `mutationTable`: a `filesTouched` entry matches one of these globs iff it
 * is a test file (`**\/test/**`, `**\/*.test.ts`) or names a guard/invariant
 * (`**\/*guard*`, `**\/*invariant*`) — the paths whose self-reported pass
 * claim needs a mutation-observed-restored record to be trustworthy. Kept as
 * a named export so a consumer (e.g. a future non-schema classifier) can
 * reuse the exact same list the JSON-Schema `if`/`then` below compiles from.
 */
export const TEST_GUARD_GLOBS = ["**/test/**", "**/*.test.ts", "**/*guard*", "**/*invariant*"] as const;

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

/**
 * The parent-supplied input contract for an implement-worker dispatch: the task
 * spec, worktree coordinates, base commit, and optional prior-round criticism.
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
    worktreePath: { type: "string", minLength: 1 },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    baseCommit: {
      type: "string",
      description: "The commit the worktree was cut from (full or abbreviated sha).",
      minLength: 1,
    },
    round: {
      type: "integer",
      description: "The zero-based implementation or correction round.",
      minimum: 0,
    },
    startingCommit: {
      type: "string",
      description: "The authoritative worktree tip immediately before this round launches.",
      pattern: "^[0-9a-f]{40}$",
    },
    priorCriticism: {
      type: "array",
      items: { type: "string" },
      description: "Prior-round reviewer criticism[] on a re-dispatch after review.",
    },
    resolvedModel: {
      type: "string",
      description: "The resolved model class (informational).",
    },
  },
  required: [
    "taskId",
    "acceptance",
    "worktreePath",
    "branch",
    "baseCommit",
    "round",
    "startingCommit",
  ],
  additionalProperties: false,
} as const;

/**
 * The worker result-block output contract (T894 evidence-carrying revision).
 * `resultCommit` is `string | null` — on pass it must be a FULL sha
 * (`^[0-9a-f]{40}$`; an abbreviated or non-hex value like `"deadbeef"` fails),
 * and `null` on fail. `gateDurationMs` is required on a pass (T894 clause (b)).
 * `mutationTable` is required IFF `filesTouched` contains an entry matching
 * {@link TEST_GUARD_GLOBS} — a test/guard/invariant path — via the `if`/`then`
 * below; a worker that touched none of those may omit it entirely (T894
 * clause (d), the negative-direction check: this must stay a real
 * conditional, not an always-required field). `blockedReason` is present only
 * on fail.
 */
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
      pattern: "^[0-9a-f]{40}$",
    },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    filesTouched: { type: "array", items: { type: "string" } },
    checkSummary: { type: "string" },
    summary: { type: "string" },
    blockedReason: { type: "string" },
    gateDurationMs: {
      type: "integer",
      minimum: 0,
      description: "Wall-clock milliseconds `bun run check` took. Required when status is \"pass\".",
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
  required: ["taskId", "status", "resultCommit", "branch", "filesTouched", "checkSummary", "summary"],
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
        required: ["gateDurationMs"],
      },
    },
    {
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
    },
  ],
} as const;

/**
 * The implement-worker per-role schema sidecar (storage-format decision 3).
 * `version: 3` (bumped from 2, T1629, decisions:D185): the input contract now
 * requires `round` and the full authoritative `startingCommit`, so a stale
 * deployed root rendered against the v2 contract must not be mistaken for this
 * one. DISPATCHED_ROLE_VERSIONS derives this automatically; it is not hand-edited.
 */
export const implementWorkerSidecar: RoleSchemaSidecar = {
  id: "implement-worker",
  version: 3,
  inputSchema,
  outputSchema,
};
