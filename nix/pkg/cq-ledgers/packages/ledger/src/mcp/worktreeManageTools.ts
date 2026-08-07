/**
 * Single `worktree_manage` MCP capability (T1306 / G121 / Q363).
 *
 * One tool over a flat operation-discriminated input (`prepare` | `release`).
 * Direct Claude `tool()` and raw MCP SDK registrations both consume
 * {@link WORKTREE_MANAGE_TOOL_SPEC} so transport parity is structural.
 *
 * Authority rules:
 *  - prepare derives the dependency closure from `taskId` + the bound ledger
 *    store — never from a caller-supplied evidence list;
 *  - repository root, lifecycle core (`prepareManagedWorktree` /
 *    `releaseManagedWorktree`), and command adapters arrive via an injected
 *    {@link WorktreeManageCapability};
 *  - the schema rejects mixed prepare/release fields, unknown keys, invalid
 *    UUID/commit/handle values, and any smuggled dependency-evidence keys.
 */

import { z } from "zod";
import { TASKS_LEDGER } from "../constants.js";
import type { DependencyTaskSnapshot, DependencyTaskSnapshotReader } from "../dependencyResultCommits.js";
import {
  isUuidV7,
  prepareManagedWorktree,
  releaseManagedWorktree,
  type ManagedWorktreeDeps,
  type ManagedWorktreeHandle,
  type PrepareManagedWorktreeRequest,
  type PrepareManagedWorktreeResult,
  type ReleaseManagedWorktreeRequest,
  type ReleaseManagedWorktreeResult,
} from "../managedWorktree.js";
import type { Item } from "../types.js";
import type { LedgerStore } from "../store/LedgerStore.js";
import { produceWireDto, type ProducedWireDto } from "./wireResponseContract.js";

export const WORKTREE_MANAGE_TOOL_NAME = "worktree_manage" as const;

export type WorktreeManageToolName = typeof WORKTREE_MANAGE_TOOL_NAME;

const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const TASK_ID_RE = /^T\d+$/;
const HANDLE_KIND = "cq-managed-worktree-handle" as const;

const FORBIDDEN_DEPENDENCY_EVIDENCE_KEYS = [
  "dependencyResultCommits",
  "dependencyReader",
  "dependencies",
  "dependencyEvidence",
  "taskSnapshots",
] as const;

const PREPARE_ONLY_KEYS = [
  "taskId",
  "baseCommit",
  "allowResumeRequired",
  "branch",
  "priorResultCommit",
  "integrationHead",
] as const;

const RELEASE_ONLY_KEYS = ["terminalDisposition", "resultCommit", "deleteBranch"] as const;

const fullCommitSha = z
  .string()
  .regex(FULL_COMMIT_SHA_RE, "expected a 40-char lowercase hex commit SHA");

const taskIdSchema = z.string().regex(TASK_ID_RE, "expected task id matching /^T\\d+$/");

const managedWorktreeHandleSchema = z
  .object({
    kind: z.literal(HANDLE_KIND),
    version: z.literal(1),
    token: z.string().min(1),
    worktreeId: z
      .string()
      .min(1)
      .refine((value) => isUuidV7(value), "worktreeId must be a UUIDv7"),
    taskId: taskIdSchema,
    branch: z.string().min(1),
    repositoryRoot: z.string().min(1),
    absolutePath: z.string().min(1),
    baseCommit: fullCommitSha,
    createdAt: z.string().min(1),
    nonce: z.string().min(1),
  })
  .strict();

/**
 * Flat wire shape. Variant-specific members are optional here; the handler
 * rebuilds the operation member and re-parses against the strict contracts so
 * mixed prepare/release fields are rejected rather than silently coerced.
 */
export const WORKTREE_MANAGE_INPUT_SHAPE = {
  operation: z
    .enum(["prepare", "release"])
    .describe("prepare = mint or resume a managed worktree; release = guarded teardown"),
  taskId: taskIdSchema.optional().describe("required for prepare (except pure handle resume)"),
  baseCommit: fullCommitSha.optional().describe("required for fresh prepare"),
  handle: managedWorktreeHandleSchema
    .optional()
    .describe("opaque handle from a prior prepare; required for release and resume-by-handle"),
  allowResumeRequired: z
    .boolean()
    .optional()
    .describe("prepare only: when true (default), a live tree yields resume-required"),
  branch: z.string().min(1).optional().describe("prepare only: override default implement/<taskId>"),
  priorResultCommit: fullCommitSha
    .nullable()
    .optional()
    .describe("prepare only: prior worker result commit to revalidate on resume"),
  integrationHead: fullCommitSha
    .optional()
    .describe("prepare only: integration tip for base ancestry verification"),
  terminalDisposition: z
    .enum(["done", "abandoned"])
    .optional()
    .describe("release only: required terminal disposition"),
  resultCommit: fullCommitSha
    .nullable()
    .optional()
    .describe("release only: require worktree HEAD equals this commit"),
  deleteBranch: z
    .boolean()
    .optional()
    .describe("release only: delete the task branch after remove (default true)"),
} as const;

const worktreeManageFlatSchema = z.object(WORKTREE_MANAGE_INPUT_SHAPE).strict();

export type WorktreeManageFlatInput = z.infer<typeof worktreeManageFlatSchema>;

/**
 * Lifecycle core + command adapters injected at server construction. Tests
 * substitute fakes; production wires {@link prepareManagedWorktree} /
 * {@link releaseManagedWorktree} with default runners.
 */
export interface WorktreeManageCapability {
  readonly repositoryRoot: string;
  readonly prepare?: (
    request: PrepareManagedWorktreeRequest,
    deps?: ManagedWorktreeDeps,
  ) => Promise<PrepareManagedWorktreeResult>;
  readonly release?: (
    request: ReleaseManagedWorktreeRequest,
    deps?: ManagedWorktreeDeps,
  ) => Promise<ReleaseManagedWorktreeResult>;
  readonly deps?: ManagedWorktreeDeps;
}

/**
 * Thrown when `worktree_manage` is invoked without an injected capability
 * (no repository root / lifecycle core). Production servers always supply one.
 */
export class WorktreeManageNotImplementedError extends Error {
  constructor() {
    super(
      "worktree_manage is not implemented for this server: no WorktreeManageCapability " +
        "(repository root + lifecycle core) was injected",
    );
    this.name = "WorktreeManageNotImplementedError";
  }
}

function itemToSnapshot(item: Item, archived: boolean): DependencyTaskSnapshot {
  const rawDepends = item.fields["dependsOn"];
  const dependsOn = Array.isArray(rawDepends)
    ? rawDepends.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rawCommit = item.fields["resultCommit"];
  const resultCommit = typeof rawCommit === "string" && rawCommit.length > 0 ? rawCommit : null;
  return {
    taskId: item.id,
    status: item.status,
    dependsOn,
    resultCommit,
    archived,
  };
}

/**
 * Authoritative dependency-closure reader: active + archived tasks from the
 * bound ledger store. Callers cannot supply an alternate evidence list.
 */
export function dependencyTaskSnapshotReaderFromStore(
  store: LedgerStore,
): DependencyTaskSnapshotReader {
  return {
    async readTaskSnapshots(): Promise<readonly DependencyTaskSnapshot[]> {
      const fetched = store.fetch(TASKS_LEDGER);
      const snapshots: DependencyTaskSnapshot[] = [];
      for (const group of fetched.milestones) {
        for (const item of group.items) {
          snapshots.push(itemToSnapshot(item, false));
        }
      }
      for (const pointer of fetched.archivePointers) {
        const archive = await store.fetchArchive(TASKS_LEDGER, pointer.id);
        if (archive.kind === "group") {
          for (const item of archive.milestone.items) {
            snapshots.push(itemToSnapshot(item, true));
          }
        } else {
          snapshots.push(itemToSnapshot(archive.item, true));
        }
      }
      return snapshots;
    },
  };
}

function definedEntries(
  args: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) entries[key] = value;
  }
  return entries;
}

function rejectPath(path: string, message: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: path === "" ? [] : path.split("."),
      message,
    },
  ]);
}

/**
 * Parse the flat wire args into a typed prepare or release request. Rejects
 * unknown keys (via `.strict()`), mixed prepare/release fields, invalid
 * UUID/commit/handle values, and any smuggled dependency-evidence keys.
 */
export function parseWorktreeManageInput(args: unknown): {
  readonly operation: "prepare" | "release";
  readonly prepare?: Omit<PrepareManagedWorktreeRequest, "repositoryRoot" | "dependencyReader">;
  readonly release?: ReleaseManagedWorktreeRequest;
} {
  if (args !== null && typeof args === "object") {
    for (const key of FORBIDDEN_DEPENDENCY_EVIDENCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        rejectPath(key, "caller-supplied dependency evidence is rejected; prepare derives the closure from taskId + ledger");
      }
    }
  }

  const flat = worktreeManageFlatSchema.parse(args);
  const raw = flat as unknown as Record<string, unknown>;

  if (flat.operation === "prepare") {
    for (const key of RELEASE_ONLY_KEYS) {
      if (raw[key] !== undefined) {
        rejectPath(key, `field "${key}" is release-only and must not accompany operation=prepare`);
      }
    }
    const prepare = {
      ...definedEntries(raw, [
        "taskId",
        "baseCommit",
        "handle",
        "allowResumeRequired",
        "branch",
        "priorResultCommit",
        "integrationHead",
      ]),
    } as Omit<PrepareManagedWorktreeRequest, "repositoryRoot" | "dependencyReader">;
    if (prepare.taskId === undefined && prepare.handle === undefined) {
      rejectPath("taskId", "prepare requires taskId (or a resume handle carrying it)");
    }
    if (prepare.handle !== undefined) {
      // Re-validate handle through the strict schema path already applied.
      managedWorktreeHandleSchema.parse(prepare.handle);
    }
    return { operation: "prepare", prepare };
  }

  for (const key of PREPARE_ONLY_KEYS) {
    if (raw[key] !== undefined) {
      rejectPath(key, `field "${key}" is prepare-only and must not accompany operation=release`);
    }
  }
  if (flat.handle === undefined) {
    rejectPath("handle", "release requires handle");
  }
  if (flat.terminalDisposition === undefined) {
    rejectPath("terminalDisposition", "release requires terminalDisposition");
  }
  const release = {
    handle: managedWorktreeHandleSchema.parse(flat.handle) as ManagedWorktreeHandle,
    terminalDisposition: flat.terminalDisposition,
    ...definedEntries(raw, ["resultCommit", "deleteBranch"]),
  } as ReleaseManagedWorktreeRequest;
  return { operation: "release", release };
}

export interface WorktreeManageToolSpec {
  readonly name: WorktreeManageToolName;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  run(
    store: LedgerStore,
    capability: WorktreeManageCapability | undefined,
    args: unknown,
  ): Promise<ProducedWireDto<object>>;
}

const WORKTREE_MANAGE_DESCRIPTION =
  "Prepare or release ONE managed implement-flow worktree. " +
  "`operation=prepare` mints a fresh UUIDv7-named tree under `.claude/worktrees/` " +
  "(or resumes by optional handle / returns typed resume-required when a live " +
  "tree already exists). Dependency result-commit closure is derived " +
  "authoritatively from `taskId` and the bound ledger — callers MUST NOT supply " +
  "dependency evidence. `operation=release` performs guarded teardown " +
  "(dirty/WIP/terminal checks) and is idempotent once released. Returns a typed " +
  "acknowledgement; never exposes filesystem mutation primitives individually.";

export const WORKTREE_MANAGE_TOOL_SPEC: WorktreeManageToolSpec = {
  name: WORKTREE_MANAGE_TOOL_NAME,
  description: WORKTREE_MANAGE_DESCRIPTION,
  inputSchema: WORKTREE_MANAGE_INPUT_SHAPE,
  run: async (store, capability, args) => {
    if (capability === undefined) {
      throw new WorktreeManageNotImplementedError();
    }
    const parsed = parseWorktreeManageInput(args);
    const prepareFn = capability.prepare ?? prepareManagedWorktree;
    const releaseFn = capability.release ?? releaseManagedWorktree;
    const deps = capability.deps ?? {};

    if (parsed.operation === "prepare") {
      const prepare = parsed.prepare!;
      const taskId = prepare.taskId ?? prepare.handle?.taskId;
      if (taskId === undefined) {
        rejectPath("taskId", "prepare requires taskId (or a resume handle carrying it)");
      }
      const request: PrepareManagedWorktreeRequest = {
        ...prepare,
        repositoryRoot: capability.repositoryRoot,
        taskId,
        // Always authoritative — ignore any caller attempt to inject a reader.
        dependencyReader: dependencyTaskSnapshotReaderFromStore(store),
      };
      const result = await prepareFn(request, deps);
      return produceWireDto(result as object);
    }

    const result = await releaseFn(parsed.release!, deps);
    return produceWireDto(result as object);
  },
};

/** Default production capability over a repository root and optional adapter overrides. */
export function createWorktreeManageCapability(
  repositoryRoot: string,
  overrides: Omit<WorktreeManageCapability, "repositoryRoot"> = {},
): WorktreeManageCapability {
  if (repositoryRoot.trim() === "") {
    throw new Error("WorktreeManageCapability.repositoryRoot must be non-empty");
  }
  return {
    repositoryRoot,
    ...overrides,
  };
}
