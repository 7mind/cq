/**
 * implement-conflict-resolver role schema sidecar (T341, goal G41) —
 * generalising the T336 one-role proof across the dispatched-subagent roster
 * (storage-format decision 3: per-role typed sidecar under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/implement-conflict-resolver.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the task id + headline + description (for that side's intent),
 *   the mid-rebase worktree path + branch + base commit, the conflicting files
 *   list, and an optional one-line note on what the base-side change did.
 *
 * - **Output** — the result block
 *   `{ taskId, status, resultCommit, filesResolved[], checkSummary, summary,
 *   blockedReason? }`. `status` is `pass | fail`; `resultCommit` is the rebased
 *   tip sha on pass and `null` on fail.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";

/** The two conflict-resolver terminal-status tokens. */
export const CONFLICT_RESOLVER_STATUSES = ["pass", "fail"] as const;

/**
 * The parent-supplied input contract for a conflict-resolver dispatch: the task
 * identity, the mid-rebase worktree coordinates, the conflicting files, and an
 * optional base-side note.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-conflict-resolver/input",
  title: "implement-conflict-resolver input",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    headline: { type: "string", minLength: 1 },
    description: { type: "string" },
    worktreePath: { type: "string", minLength: 1 },
    branch: {
      type: "string",
      description:
        "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    baseCommit: { type: "string", minLength: 1 },
    conflictingFiles: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "The conflicting files from git status.",
    },
    baseSideNote: {
      type: "string",
      description: "Optional one-line note on what the base-side change did.",
    },
  },
  required: ["taskId", "worktreePath", "branch", "baseCommit", "conflictingFiles"],
  additionalProperties: false,
} as const;

/**
 * The result-block output contract. `resultCommit` is the rebased tip sha on
 * pass and `null` on fail; `blockedReason` is present only on fail.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/implement-conflict-resolver/output",
  title: "implement-conflict-resolver result",
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^T[0-9]+$" },
    status: { type: "string", enum: [...CONFLICT_RESOLVER_STATUSES] },
    resultCommit: { type: ["string", "null"] },
    filesResolved: { type: "array", items: { type: "string" } },
    checkSummary: { type: "string" },
    summary: { type: "string" },
    blockedReason: { type: "string" },
  },
  required: ["taskId", "status", "resultCommit", "filesResolved", "checkSummary", "summary"],
  additionalProperties: false,
} as const;

/** The conflict-resolver per-role schema sidecar (storage-format decision 3). */
export const implementConflictResolverSidecar: RoleSchemaSidecar = {
  id: "implement-conflict-resolver",
  version: 1,
  inputSchema,
  outputSchema,
};
