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
 *   summary, blockedReason? }`. `status` is `pass | fail`; `resultCommit` is the
 *   commit sha on pass and `null` on fail.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two worker terminal-status tokens. */
export const IMPLEMENT_WORKER_STATUSES = ["pass", "fail"] as const;

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
  required: ["taskId", "acceptance", "worktreePath", "branch", "baseCommit"],
  additionalProperties: false,
} as const;

/**
 * The worker result-block output contract. `resultCommit` is `string | null`
 * (a sha on pass, null on fail); `blockedReason` is present only on fail.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-worker/output",
  title: "implement-worker result",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    status: { type: "string", enum: [...IMPLEMENT_WORKER_STATUSES] },
    resultCommit: { type: ["string", "null"] },
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
  },
  required: ["taskId", "status", "resultCommit", "branch", "filesTouched", "checkSummary", "summary"],
  additionalProperties: false,
} as const;

/** The implement-worker per-role schema sidecar (storage-format decision 3). */
export const implementWorkerSidecar: RoleSchemaSidecar = {
  id: "implement-worker",
  version: 1,
  inputSchema,
  outputSchema,
};
