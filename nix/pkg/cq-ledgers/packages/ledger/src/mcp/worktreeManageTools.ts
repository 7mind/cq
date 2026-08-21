/**
 * Single `worktree_manage` MCP capability (T1306 / G121 / Q363).
 *
 * One tool over a flat operation-discriminated input
 * (`prepare` | `observe-conflict` | `release`).
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
import { validateManagedWorktreeHandle } from "@cq/config";
import { TASKS_LEDGER } from "../constants.js";
import {
  dependencyTaskSnapshotFromItem,
  type DependencyTaskSnapshot,
  type DependencyTaskSnapshotReader,
} from "../dependencyResultCommits.js";
import {
  isUuidV7,
  prepareManagedWorktree,
  observeManagedWorktreeLiveTip,
  releaseManagedWorktree,
  resolveManagedWorktreeTerminalReleaseRegistryBinding,
  resolveManagedWorktreeDispatchBinding,
  type ManagedWorktreeDeps,
  type ManagedWorktreeDispatchBinding,
  type ManagedWorktreeHandle,
  type PrepareManagedWorktreeRequest,
  type PrepareManagedWorktreeResult,
  type ReleaseManagedWorktreeRequest,
  type ReleaseManagedWorktreeResult,
} from "../managedWorktree.js";
import { observeManagedWorktreeConflictState } from "../gitConflictContinuation.js";
import { createManagedWorktreeGitEffectRunner } from "../worksetGitEffects.js";
import { mintManagedTerminalReleaseBinding } from "../managedTerminalReleaseAdmission.js";
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
  "adoptWorktreePath",
  "expectedHead",
] as const;

const RELEASE_ONLY_KEYS = ["terminalDisposition", "resultCommit", "deleteBranch"] as const;

const fullCommitSha = z
  .string()
  .regex(FULL_COMMIT_SHA_RE, "expected a 40-char lowercase hex commit SHA");

const taskIdSchema = z.string().regex(TASK_ID_RE, "expected task id matching /^T\\d+$/");

const managedWorktreeHandleFields = {
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
} as const;

const managedWorktreeHandleV1Schema = z
  .object({
    kind: z.literal(HANDLE_KIND),
    version: z.literal(1),
    ...managedWorktreeHandleFields,
  })
  .strict();

const managedWorktreeHandleV2Schema = z
  .object({
    kind: z.literal(HANDLE_KIND),
    version: z.literal(2),
    ...managedWorktreeHandleFields,
  })
  .strict();

const managedWorktreeHandleSchema = z
  .discriminatedUnion("version", [managedWorktreeHandleV1Schema, managedWorktreeHandleV2Schema])
  .superRefine((handle, context) => {
    const validation = validateManagedWorktreeHandle(handle);
    if (validation.status === "invalid") {
      context.addIssue({
        code: "custom",
        message: validation.detail,
      });
    }
  });

/**
 * Flat wire shape. Variant-specific members are optional here; the handler
 * rebuilds the operation member and re-parses against the strict contracts so
 * mixed prepare/release fields are rejected rather than silently coerced.
 */
export const WORKTREE_MANAGE_INPUT_SHAPE = {
  operation: z
    .enum(["prepare", "observe-conflict", "resolve-dispatch-recovery", "release"])
    .describe(
      "prepare = mint or resume; observe-conflict = return the manager-observed rebase state; resolve-dispatch-recovery = resolve the latest bound parent-lost worker; release = guarded teardown",
    ),
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
  adoptWorktreePath: z
    .string()
    .min(1)
    .optional()
    .describe("prepare only: exact canonical legacy worktree path to adopt"),
  expectedHead: fullCommitSha
    .optional()
    .describe("prepare only: exact legacy HEAD at adoptWorktreePath"),
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
  readonly observeConflict?: (
    handle: ManagedWorktreeHandle,
    deps: ManagedWorktreeDeps,
  ) => Promise<object>;
  readonly resolveDispatchRecovery?: (
    binding: ManagedWorktreeDispatchBinding,
    liveTip: string,
  ) => Promise<object>;
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
          snapshots.push(dependencyTaskSnapshotFromItem(item, false));
        }
      }
      for (const pointer of fetched.archivePointers) {
        const archive = await store.fetchArchive(TASKS_LEDGER, pointer.id);
        if (archive.kind === "group") {
          for (const item of archive.milestone.items) {
            snapshots.push(dependencyTaskSnapshotFromItem(item, true));
          }
        } else {
          snapshots.push(dependencyTaskSnapshotFromItem(archive.item, true));
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
  readonly operation:
    | "prepare"
    | "observe-conflict"
    | "resolve-dispatch-recovery"
    | "release";
  readonly prepare?: Omit<PrepareManagedWorktreeRequest, "repositoryRoot" | "dependencyReader">;
  readonly observeHandle?: ManagedWorktreeHandle;
  readonly recoveryHandle?: ManagedWorktreeHandle;
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
        "adoptWorktreePath",
        "expectedHead",
      ]),
    } as Omit<PrepareManagedWorktreeRequest, "repositoryRoot" | "dependencyReader">;
    if (prepare.taskId === undefined && prepare.handle === undefined) {
      rejectPath("taskId", "prepare requires taskId (or a resume handle carrying it)");
    }
    if (prepare.handle !== undefined) {
      // Re-validate handle through the strict schema path already applied.
      managedWorktreeHandleSchema.parse(prepare.handle);
    }
    const adoptionFieldCount =
      Number(prepare.adoptWorktreePath !== undefined) +
      Number(prepare.expectedHead !== undefined);
    if (adoptionFieldCount === 1 || (adoptionFieldCount > 0 && prepare.handle !== undefined)) {
      rejectPath(
        "adoptWorktreePath",
        "adoptWorktreePath and expectedHead must appear together on handle-free prepare",
      );
    }
    return { operation: "prepare", prepare };
  }

  if (flat.operation === "observe-conflict") {
    for (const key of [...PREPARE_ONLY_KEYS, ...RELEASE_ONLY_KEYS]) {
      if (raw[key] !== undefined) {
        rejectPath(key, `field "${key}" must not accompany operation=observe-conflict`);
      }
    }
    if (flat.handle === undefined) {
      rejectPath("handle", "observe-conflict requires handle");
    }
    return {
      operation: "observe-conflict",
      observeHandle: managedWorktreeHandleSchema.parse(flat.handle) as ManagedWorktreeHandle,
    };
  }

  if (flat.operation === "resolve-dispatch-recovery") {
    for (const key of [...PREPARE_ONLY_KEYS, ...RELEASE_ONLY_KEYS]) {
      if (raw[key] !== undefined) {
        rejectPath(key, `field "${key}" must not accompany operation=resolve-dispatch-recovery`);
      }
    }
    if (flat.handle === undefined) {
      rejectPath("handle", "resolve-dispatch-recovery requires handle");
    }
    return {
      operation: "resolve-dispatch-recovery",
      recoveryHandle: managedWorktreeHandleSchema.parse(flat.handle) as ManagedWorktreeHandle,
    };
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
  "Prepare, observe an active rebase conflict, resolve parent-lost dispatch recovery, or release ONE managed implement-flow worktree. " +
  "`operation=prepare` mints a fresh UUIDv7-named tree under `.claude/worktrees/` " +
  "(or resumes by optional handle / returns typed resume-required when a live " +
  "tree already exists). A handle-free prepare may adopt one exact legacy tree " +
  "only when paired `adoptWorktreePath` and `expectedHead` coordinates are supplied; " +
  "the server constructs adoption authority internally. Dependency result-commit closure is derived " +
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
      const result = await prepareFn(request, {
        ...deps,
        git:
          deps.git ??
          createManagedWorktreeGitEffectRunner({
            store,
            taskId,
            repositoryRoot: capability.repositoryRoot,
          }),
        taskAdoptionAuthority: store,
      });
      return produceWireDto(result as object);
    }

    if (parsed.operation === "observe-conflict") {
      const handle = parsed.observeHandle!;
      if (capability.observeConflict !== undefined) {
        return produceWireDto(await capability.observeConflict(handle, deps));
      }
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: capability.repositoryRoot,
          taskId: handle.taskId,
          worktreePath: handle.absolutePath,
          branch: handle.branch,
          allowDetachedRebase: true,
        },
        deps,
      );
      if (
        binding === null ||
        binding.handleToken !== handle.token ||
        binding.baseCommit !== handle.baseCommit
      ) {
        throw new Error("observe-conflict handle does not resolve to one live managed worktree");
      }
      const conflictState = await observeManagedWorktreeConflictState(binding, deps);
      return produceWireDto({ status: "conflict-observed", conflictState });
    }

    if (parsed.operation === "resolve-dispatch-recovery") {
      if (capability.resolveDispatchRecovery === undefined) {
        throw new Error("worktree_manage dispatch recovery is unavailable for this server");
      }
      const handle = parsed.recoveryHandle!;
      const registryBinding = await resolveManagedWorktreeTerminalReleaseRegistryBinding(
        capability.repositoryRoot,
        handle,
        deps,
      );
      const binding = await resolveManagedWorktreeDispatchBinding(
        {
          repositoryRoot: capability.repositoryRoot,
          taskId: handle.taskId,
          worktreePath: handle.absolutePath,
          branch: handle.branch,
        },
        deps,
      );
      if (
        registryBinding === null ||
        registryBinding.registryStatus !== "live" ||
        binding === null ||
        binding.handleToken !== handle.token ||
        binding.handleFingerprint !== registryBinding.handleFingerprint ||
        binding.baseCommit !== handle.baseCommit
      ) {
        throw new Error(
          "resolve-dispatch-recovery handle does not resolve to one live managed worktree",
        );
      }
      const liveTip = await observeManagedWorktreeLiveTip(binding, deps);
      return produceWireDto(await capability.resolveDispatchRecovery(binding, liveTip));
    }

    const release = parsed.release!;
    const registryBinding = await resolveManagedWorktreeTerminalReleaseRegistryBinding(
      capability.repositoryRoot,
      release.handle,
      deps,
    );
    if (registryBinding === null) {
      throw new Error(
        "worktree_manage release handle does not match the authoritative manager registry",
      );
    }
    if (registryBinding.taskId !== release.handle.taskId) {
      throw new Error("worktree_manage release registry task does not match the presented handle");
    }
    const terminalDisposition = release.terminalDisposition;
    if (terminalDisposition !== "done" && terminalDisposition !== "abandoned") {
      throw new Error("worktree_manage release terminal disposition is not canonical");
    }
    const task = store.fetchItem(TASKS_LEDGER, release.handle.taskId);
    if (task.id !== release.handle.taskId) {
      throw new Error("worktree_manage release task identity changed during authoritative read");
    }
    if (task.status !== terminalDisposition) {
      throw new Error(
        `worktree_manage release task status ${task.status} does not equal terminalDisposition ${terminalDisposition}`,
      );
    }
    const terminalReleaseBinding = mintManagedTerminalReleaseBinding({
      taskId: registryBinding.taskId,
      handleToken: registryBinding.handleToken,
      handleFingerprint: registryBinding.handleFingerprint,
      repositoryRoot: registryBinding.repositoryRoot,
      worktreePath: registryBinding.worktreePath,
      branch: registryBinding.branch,
      terminalDisposition,
    });
    const result = await releaseFn(release, {
      ...deps,
      git:
        deps.git ??
        createManagedWorktreeGitEffectRunner({
          store,
          taskId: release.handle.taskId,
          repositoryRoot: registryBinding.repositoryRoot,
          terminalReleaseBinding,
        }),
    });
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
