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
const GIT_OBJECT_ID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";

const ancestrySchema = {
  type: "object",
  properties: {
    ancestor: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
    descendant: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
  },
  required: ["ancestor", "descendant"],
  additionalProperties: false,
} as const;

const conflictStageSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    stage: { type: "integer", enum: [1, 2, 3] },
    mode: { type: "string", pattern: "^[0-9]{6}$" },
    oid: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
  },
  required: ["path", "stage", "mode", "oid"],
  additionalProperties: false,
} as const;

const rebaseStateSchema = {
  type: "object",
  properties: {
    baseCommit: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
    currentHead: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
    expectedAncestry: { type: "array", items: ancestrySchema },
    sequencer: {
      type: "object",
      properties: {
        kind: { type: "string", const: "rebase-merge" },
        identity: { type: "string", pattern: "^[0-9a-f]{64}$" },
        headName: { type: "string", minLength: 1 },
        originalTip: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        onto: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        stoppedCommit: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        currentCommand: { type: "string", minLength: 1 },
        todoDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        doneDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      required: [
        "kind",
        "identity",
        "headName",
        "originalTip",
        "onto",
        "stoppedCommit",
        "currentCommand",
        "todoDigest",
        "doneDigest",
      ],
      additionalProperties: false,
    },
    conflicts: { type: "array", minItems: 1, items: conflictStageSchema },
  },
  required: ["baseCommit", "currentHead", "expectedAncestry", "sequencer", "conflicts"],
  additionalProperties: false,
} as const;

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
    conflictState: {
      ...rebaseStateSchema,
      description:
        "Complete parent-observed rebase transaction supplied unchanged to the first git_resolve_continue call.",
    },
  },
  required: ["taskId", "branch", "baseCommit", "conflictingFiles", "conflictState"],
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
    actualWorktreePath: {
      type: "string",
      minLength: 1,
      description:
        "Optional absolute path of the worktree the resolver actually operated in (D143).",
    },
    branch: {
      type: "string",
      pattern: "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$",
    },
    conflictReceipts: {
      type: "array",
      items: { $ref: "#/$defs/conflictReceipt" },
      description:
        "Complete durable git_resolve_continue receipt chain when the dispatch carries the resolver capability.",
    },
  },
  required: ["taskId", "status", "resultCommit", "filesResolved", "checkSummary", "summary"],
  additionalProperties: false,
  $defs: {
    rebaseState: rebaseStateSchema,
    conflictReceipt: {
      type: "object",
      properties: {
        kind: { type: "string", const: "cq-git-conflict-continuation-receipt" },
        version: { type: "integer", const: 1 },
        attestationId: { type: "string", minLength: 1 },
        generation: { type: "integer", minimum: 1 },
        taskId: { type: "string", pattern: "^T[0-9]+$" },
        operationId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
        requestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        oldHead: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        newHead: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        objectOids: {
          type: "array",
          items: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
        },
        paths: { type: "array", items: { type: "string", minLength: 1 } },
        outcome: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "terminal" },
                tip: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
              },
              required: ["kind", "tip"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "conflict" },
                tip: { type: "string", pattern: GIT_OBJECT_ID_PATTERN },
                state: { $ref: "#/$defs/rebaseState" },
              },
              required: ["kind", "tip", "state"],
              additionalProperties: false,
            },
          ],
        },
        continuedAt: { type: "string", minLength: 1 },
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
        "objectOids",
        "paths",
        "outcome",
        "continuedAt",
      ],
      additionalProperties: false,
    },
  },
} as const;

/**
 * The conflict-resolver per-role schema sidecar (storage-format decision 3).
 * `version: 3` adds the durable conflict-continuation evidence carried by a
 * resolver dispatch without changing D143's advisory worktree input.
 */
export const implementConflictResolverSidecar: RoleSchemaSidecar = {
  id: "implement-conflict-resolver",
  version: 3,
  inputSchema,
  outputSchema,
};
