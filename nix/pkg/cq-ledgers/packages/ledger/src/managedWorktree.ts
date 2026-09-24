/**
 * Managed worktree prepare + guarded release core (T1305).
 *
 * Owns the durable lifecycle of an implement-flow task worktree:
 *   - fresh prepare verifies base + transitive dependency result commits
 *     BEFORE any git worktree mutation, then creates a UUIDv7-named tree
 *     under the CQ-managed parent (`cqManagedWorktreesParent`, defects:D404),
 *     retains branch identity `implement/<taskId>`,
 *     runs a locked-down Bun install, and returns an opaque handle;
 *   - resume revalidates handle/path/branch/task and never reset/rebases
 *     criticism-round commits;
 *   - handle-free prepare when the task already owns exactly one live managed
 *     tree returns typed `resume-required` with the recoverable handle;
 *   - release revalidates handle, dirty state, G122 WIP open checkpoints, and
 *     terminal disposition, refusing without mutation when ineligible, and
 *     releasing eligible clean terminal trees idempotently.
 *
 * Named fault-injection hooks cover registry publication and irreversible
 * deletes so restart tests can establish the recoverability boundaries.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  promises as fs,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  delimiter as pathDelimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGED_WORKTREE_HANDLE_KIND,
  assertDispatchCohortRebaseTransition,
  cohortRebaseManagerBinding,
  cohortRebaseTransitionMatches,
  type DispatchCohortRebaseTransition,
  type DispatchCohortGitEffectBinding,
  type DispatchHandle,
  assessWipArtifactClosure,
  parseWipArtifact,
  validateManagedTaskWorktreeHandle as validateManagedWorktreeHandleContract,
  validateManagedWorktreeHandle as validateAnyManagedWorktreeHandle,
  WipArtifactParseError,
  type DispatchGuardedRebaseBridge,
  type ManagedTaskWorktreeHandle as ConfigManagedWorktreeHandle,
  type ManagedWorktreeHandle as AnyManagedWorktreeHandle,
  type ManagedWorktreeHandleV3,
  type CohortEffectEnvelopeV1,
  type ManagedWorktreeHandleV1 as ConfigManagedWorktreeHandleV1,
  type ImplementTaskWorkerSupervisedGateEvidence,
  type WipClosureProjection,
  CQ_MANAGED_WORKTREES_SEGMENTS,
  cqManagedWorktreesParent,
  harnessNativeWorktreesParent,
  managedWorktreeRegistryRoot,
} from "@cq/config";
import { recordManagerOwnedReleaseResult } from "../../cq-config/src/internal/managedWorktreeReleaseAuthority.js";
import {
  type DependencyResultCommit,
  type DependencyResultCommitResolution,
  type DependencyTaskSnapshotReader,
  resolveDependencyResultCommitsForDispatch,
} from "./dependencyResultCommits.js";
import {
  type DispatchBaseGitRunner,
  type DispatchBaseVerification,
  nodeDispatchBaseGitRunner,
  observeDispatchBase,
  verifyDispatchBase,
} from "./dispatchBase.js";
import { MANAGED_GATE_CLOSURE_MANIFEST, resolveManagedGateClosure } from "./gateClosure.js";

import {
  assessLegacyReconciliationActivity,
  beginLegacyWorktreeReconciliation,
  createGitLegacyReconciliationObservationAdapter,
  nodeLegacyReconciliationGitRunner,
  recoverLegacyWorktreeReconciliation,
  type LegacyWorktreeActivityFence,
  type LegacyWorktreeManagerLock,
  type LegacyWorktreeReconciliationTransaction,
} from "./legacyWorktreeReconciliation.js";
import { Lockfile } from "./store/lockfile.js";
import { assertCohortEffectEnvelopeV1, cohortValueDigestV1, cohortWorktreeIdentityFromEnvelopeV1,
  createCohortCandidateIntentV1, createCohortEffectEnvelopeV1, resolveCohortDefinitionObservationV1 } from "./workCohort.js";
import { cohortEffectTargetRefV1, runWorksetGitEffectGate } from "@cq/process-control";
import { createCohortWorksetEffectAdmissionProvider } from "./workCohortEffects.js";
import { materializeGuardedRebaseBridge, verifyHistoricalCohortGuardedRebaseBridge } from "./guardedRebaseContinuation.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import type { WorkCohortLeaseV1, WorkCohortStore } from "./workCohortStore.js";
import { readAuthorizedCohortTerminalReleaseV1, type AuthorizedCohortTerminalReleaseV1 } from "./workCohortCompletion.js";
import { mintManagedCohortTerminalReleaseBinding } from "./managedTerminalReleaseAdmission.js";
import { createManagedCohortTerminalReleaseGitRunner } from "./worksetGitEffects.js";
import {
  currentRecoveryJournalRoot,
  FsCurrentRecoverySealJournalStore,
} from "./currentRecoverySeal.js";
import type {
  TaskAdoptionEligibilityFence,
  TaskAdoptionEligibilityResult,
  TaskAdoptionPublicationResult,
} from "./taskAdoptionEligibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRESH_HANDLE_VERSION = 1 as const;
const ADOPTED_HANDLE_VERSION = 2 as const;
const DEFAULT_BRANCH_PREFIX = "implement/";
const TASK_INDEX_DIRNAME = "by-task";
const HANDLES_DIRNAME = "handles";
const TASK_REGISTRY_DIRNAME = "tasks";
const COHORT_REGISTRY_DIRNAME = "cohorts";
const COHORT_REGISTRY_KEY_RE = /^cohort-[0-9a-f]{64}$/;
const TASK_GENERATIONS_DIRNAME = "generations";
const TASK_STAGING_DIRNAME = "staging";
const TASK_CURRENT_FILENAME = "current.json";
const REGISTRY_QUARANTINE_DIRNAME = "quarantine";
const PREPARE_LOCKS_DIRNAME = "locks";
const RECOVERY_REF_PREFIX = "refs/cq-managed-recovery";
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^T\d+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const BUN_LOCK_NAMES = ["bun.lock", "bun.lockb"] as const;
const FROZEN_INSTALL_ARGS = ["install", "--frozen-lockfile"] as const;

export type ManagedWorktreeTerminalDisposition = "done" | "abandoned";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque handle. Callers must not invent fields; only values returned by prepare. */
export type ManagedWorktreeHandle = ConfigManagedWorktreeHandle;

/** Public core validator shared by registry resume/release and transport adapters. */
export function validateManagedWorktreeHandle(value: unknown, expectedRepositoryRoot?: string) {
  return validateManagedWorktreeHandleContract(value, expectedRepositoryRoot);
}

/** Server-side worktree identity bound into one dispatch Git-effect capability. */
export interface ManagedWorktreeDispatchBinding {
  readonly taskId: string;
  /** Registry locator retained only inside the trusted server. */
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly ref: string;
  readonly baseCommit: string;
}

export interface ManagedCohortWorktreeAuthority {
  readonly store: WorkCohortStore;
  readonly lease: WorkCohortLeaseV1;
  readonly envelope: CohortEffectEnvelopeV1;
}

export interface ManagedCohortWorktreeDispatchBinding extends Omit<ManagedWorktreeDispatchBinding, "taskId"> {
  readonly cohort: CohortEffectEnvelopeV1;
}

export interface PrepareManagedCohortWorktreeRequest {
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly handle: ManagedWorktreeHandleV3 | null;
  readonly dependencyReader: DependencyTaskSnapshotReader;
  readonly priorResultCommit: string | null;
  readonly integrationHead: string;
}

export type PrepareManagedCohortWorktreeResult =
  | ManagedWorktreeAllocationResult<ManagedWorktreeHandleV3>
  | { readonly status: "resume-required"; readonly reason: "live-tree-exists";
      readonly handle: ManagedWorktreeHandleV3; readonly evidence: PreparedWorktreeEvidence };

/** Registry identity sufficient to order a prepare with lineage sealing. */
export interface ManagedWorktreeLineageBinding {
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
}

/** Exact manager-registry identity used only to authorize terminal teardown. */
export interface ManagedWorktreeTerminalReleaseRegistryBinding {
  readonly registryStatus: "live" | "released";
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface PreparedWorktreeEvidence {
  readonly registryPublicationWarning?: string;
  readonly worktreeId: string;
  readonly absolutePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly bunWorkspaceRoot: string;
  readonly bunWorkspaceRoots: readonly string[];
  readonly bunInstallCacheDir: string;
  readonly bunInstallArgs: readonly string[];
  readonly dependencyResultCommits: readonly DependencyResultCommit[];
  readonly mode: "fresh" | "resume" | "adopted";
}

export type PrepareManagedWorktreeRefusalReason =
  | "task-id-invalid"
  | "repository-invalid"
  | "base-unresolvable"
  | "base-rebase-required"
  | "dependency-unresolvable"
  | "live-tree-ambiguous"
  | "branch-checked-out-elsewhere"
  | "branch-identity-mismatch"
  | "handle-invalid"
  | "handle-foreign"
  | "handle-path-traversal"
  | "handle-mismatch"
  | "worktree-missing"
  | "prior-result-commit-mismatch"
  | "bun-workspace-missing"
  | "bun-install-plan-invalid"
  | "bun-install-failed"
  | "gate-closure-invalid"
  | "adoption-invalid"
  | "adoption-unavailable"
  | "adoption-ineligible"
  | "adoption-activity-changed"
  | "adoption-reconciliation-failed"
  | "adoption-authority-stale"
  | "adoption-recovery-failed"
  | "registry-conflict"
  | "cohort-authority-stale"
  | "member-reserved"
  | "prepare-lock-busy";

export type PrepareManagedWorktreeResult =
  | {
      readonly status: "prepared";
      readonly handle: ManagedWorktreeHandle;
      readonly evidence: PreparedWorktreeEvidence;
    }
  | {
      readonly status: "resume-required";
      readonly handle: ManagedWorktreeHandle;
      readonly reason: "live-tree-exists";
      readonly evidence: PreparedWorktreeEvidence;
    }
  | {
      readonly status: "refused";
      readonly reason: PrepareManagedWorktreeRefusalReason;
      readonly detail: string;
      readonly dependency?: DependencyResultCommitResolution & { status: "unresolvable" };
      readonly base?: DispatchBaseVerification;
    };

export type ReleaseManagedWorktreeRefusalReason =
  | "handle-invalid"
  | "handle-foreign"
  | "handle-path-traversal"
  | "handle-mismatch"
  | "worktree-missing"
  | "dirty"
  | "wip-open"
  | "wip-malformed"
  | "wip-retained"
  | "not-terminal"
  | "commit-mismatch"
  | "ambiguous"
  | "already-live-elsewhere"
  | "effect-lock-busy";

export type ReleaseManagedWorktreeResult =
  | {
      readonly status: "released";
      readonly handle: ManagedWorktreeHandle;
      readonly idempotent: boolean;
      readonly absolutePath: string;
    }
  | {
      readonly status: "refused";
      readonly reason: ReleaseManagedWorktreeRefusalReason;
      readonly detail: string;
      readonly absolutePath?: string;
      readonly openCheckpoints?: readonly string[];
    };

export interface ManagedWorktreeInstallPlan {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly bunInstallCacheDir: string;
}

export type ManagedWorktreeInstallPlanValidation =
  | { readonly status: "valid"; readonly plan: ManagedWorktreeInstallPlan }
  | {
      readonly status: "invalid";
      readonly reason:
        | "missing-bun-install-cache-dir"
        | "bun-install-cache-dir-outside-root"
        | "args-not-frozen-lockfile"
        | "cwd-empty";
      readonly detail: string;
    };

export interface ManagedWorktreeGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type ManagedWorktreeGitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<ManagedWorktreeGitResult>;

export type ManagedWorktreeInstallRunner = (
  plan: ManagedWorktreeInstallPlan,
) => Promise<ManagedWorktreeGitResult>;

export type ManagedWorktreeIdFactory = () => string;

export type ManagedWorktreeFaultBoundary =
  | "before-worktree-add"
  | "before-registry-commit"
  | "after-registry-directory-sync"
  | "after-registry-generation-sync"
  | "before-registry-pointer-rename"
  | "after-registry-pointer-rename"
  | "after-adoption-reconciliation"
  | "after-adoption-install"
  | "after-adoption-stage"
  | "after-adoption-publication"
  | "before-adoption-commit"
  | "before-worktree-remove"
  | "before-registry-release"
  | "before-directory-delete";

export type ManagedWorktreeFaultInjector = (
  boundary: ManagedWorktreeFaultBoundary,
  context: Readonly<Record<string, string>>,
) => void | Promise<void>;

export interface PrepareManagedWorktreeRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** Required for fresh prepare; ignored on pure resume when handle carries it. */
  readonly baseCommit?: string;
  /** When set, forces the resume path and skips fresh creation. */
  readonly handle?: ManagedWorktreeHandle;
  /**
   * Handle-free entry: when the task already owns exactly one live managed
   * tree, return `resume-required` instead of creating a second tree.
   * Defaults to true.
   */
  readonly allowResumeRequired?: boolean;
  readonly branch?: string;
  readonly dependencyReader?: DependencyTaskSnapshotReader;
  /**
   * Prior worker result commit to revalidate on resume (criticism rounds).
   * When set, HEAD must equal it or contain it as an ancestor.
   */
  readonly priorResultCommit?: string | null;
  /** Integration / main-checkout HEAD used as the dispatch-base ancestry tip. */
  readonly integrationHead?: string;
  /** Prepare-only exact legacy worktree target; requires expectedHead. */
  readonly adoptWorktreePath?: string;
  /** Prepare-only exact legacy HEAD; requires adoptWorktreePath. */
  readonly expectedHead?: string;
}

export interface ManagedWorktreeTaskAdoptionAuthority {
  captureTaskAdoptionEligibility(taskId: string): Promise<TaskAdoptionEligibilityResult>;
  publishTaskAdoption(
    fence: TaskAdoptionEligibilityFence,
    publish: () => undefined,
  ): Promise<TaskAdoptionPublicationResult>;
}

export interface ReleaseManagedWorktreeRequest {
  readonly handle: ManagedWorktreeHandle;
  readonly terminalDisposition: ManagedWorktreeTerminalDisposition | string;
  /** When set, require worktree HEAD equals this commit before release. */
  readonly resultCommit?: string | null;
  /** Delete the task branch after a successful worktree remove. Default true. */
  readonly deleteBranch?: boolean;
}

export interface ManagedWorktreeDeps {
  readonly git?: ManagedWorktreeGitRunner;
  readonly dispatchGit?: DispatchBaseGitRunner;
  readonly install?: ManagedWorktreeInstallRunner;
  readonly idFactory?: ManagedWorktreeIdFactory;
  readonly now?: () => Date;
  readonly stateDir?: string;
  readonly cacheRoot?: string;
  readonly bunWorkspaceRoot?: string;
  /** Repository-relative v1 closure manifest path. Defaults to cq-gate-closure.json. */
  readonly gateClosureManifestPath?: string;
  readonly faultInjector?: ManagedWorktreeFaultInjector;
  /** Skip real install (tests that only cover git/registry). Default false. */
  readonly skipInstall?: boolean;
  /** Override prepare-lock acquisition (tests). */
  readonly lockfile?: Lockfile;
  /** Override prepare-lock timeout (ms). */
  readonly prepareLockTimeoutMs?: number;
  /** Override broker/store/release effect-lock timeout (ms). */
  readonly effectLockTimeoutMs?: number;
  /** Bound ledger authority; required only for prepare-only legacy adoption. */
  readonly taskAdoptionAuthority?: ManagedWorktreeTaskAdoptionAuthority;
  /** Bound dispatch/lease/process/content observer required for legacy adoption. */
  readonly adoptionActivityFence?: LegacyWorktreeActivityFence;
  readonly cohortStore?: WorkCohortStore;
  readonly validateCohortPublication?: (envelope: CohortEffectEnvelopeV1) => undefined;
}

// ---------------------------------------------------------------------------
// Install plan
// ---------------------------------------------------------------------------

export function resolveCqCacheRoot(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") {
    if (!isAbsolute(explicit)) {
      throw new Error(`CQ cache root must be absolute, got ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  const xdg = process.env["XDG_CACHE_HOME"];
  const base =
    xdg !== undefined && xdg.trim() !== "" && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "cq");
}

export function resolveBunInstallCacheDir(cacheRoot?: string): string {
  return join(resolveCqCacheRoot(cacheRoot), "bun-install");
}

/**
 * Directory containing a `node-gyp` executable resolvable from this package
 * graph (D292). Managed `bun install` runs native postinstall scripts (e.g.
 * node-pty) under a minimal MCP PATH that does not include workspace
 * `node_modules/.bin`; without this prefix, prepare fails with exit 127.
 */
export function resolveNodeGypBinDir(
  resolveFrom: string = fileURLToPath(import.meta.url),
): string | null {
  try {
    const require = createRequire(resolveFrom);
    require.resolve("node-gyp/package.json");
    const searchPaths = require.resolve.paths("node-gyp") ?? [];
    for (const modulesDir of searchPaths) {
      const packageJson = join(modulesDir, "node-gyp", "package.json");
      const executable = join(modulesDir, ".bin", "node-gyp");
      if (existsSync(packageJson) && existsSync(executable)) {
        return join(modulesDir, ".bin");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the exact install plan prepare will execute. Negative-control tests
 * mutate the plan and feed it to {@link validateManagedWorktreeInstallPlan}.
 */
export function buildManagedWorktreeInstallPlan(input: {
  readonly bunWorkspaceRoot: string;
  readonly cacheRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ManagedWorktreeInstallPlan {
  const bunInstallCacheDir = resolveBunInstallCacheDir(input.cacheRoot);
  const baseEnv = input.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env["BUN_INSTALL_CACHE_DIR"] = bunInstallCacheDir;
  // D292: ensure node-gyp is on PATH for native module postinstall scripts.
  const nodeGypBin = resolveNodeGypBinDir();
  if (nodeGypBin !== null) {
    const priorPath = env["PATH"] ?? "";
    env["PATH"] = priorPath.length === 0 ? nodeGypBin : `${nodeGypBin}${pathDelimiter}${priorPath}`;
  }
  return {
    cwd: input.bunWorkspaceRoot,
    args: [...FROZEN_INSTALL_ARGS],
    env,
    bunInstallCacheDir,
  };
}

export function validateManagedWorktreeInstallPlan(
  plan: ManagedWorktreeInstallPlan,
  opts: { readonly cacheRoot?: string } = {},
): ManagedWorktreeInstallPlanValidation {
  if (plan.cwd.trim() === "") {
    return { status: "invalid", reason: "cwd-empty", detail: "install cwd must be non-empty" };
  }
  const cacheDir = plan.env["BUN_INSTALL_CACHE_DIR"];
  if (cacheDir === undefined || cacheDir.trim() === "") {
    return {
      status: "invalid",
      reason: "missing-bun-install-cache-dir",
      detail: "BUN_INSTALL_CACHE_DIR must be set on the install environment",
    };
  }
  const cacheRoot = resolveCqCacheRoot(opts.cacheRoot);
  const cacheRelation = relative(cacheRoot, resolve(cacheDir));
  if (cacheRelation === ".." || cacheRelation.startsWith(`..${sep}`) || isAbsolute(cacheRelation)) {
    return {
      status: "invalid",
      reason: "bun-install-cache-dir-outside-root",
      detail: `BUN_INSTALL_CACHE_DIR ${cacheDir} escapes CQ cache root ${cacheRoot}`,
    };
  }
  if (plan.args.length !== FROZEN_INSTALL_ARGS.length) {
    return {
      status: "invalid",
      reason: "args-not-frozen-lockfile",
      detail: `expected args ${JSON.stringify(FROZEN_INSTALL_ARGS)}, got ${JSON.stringify(plan.args)}`,
    };
  }
  for (let i = 0; i < FROZEN_INSTALL_ARGS.length; i++) {
    if (plan.args[i] !== FROZEN_INSTALL_ARGS[i]) {
      return {
        status: "invalid",
        reason: "args-not-frozen-lockfile",
        detail: `expected args ${JSON.stringify(FROZEN_INSTALL_ARGS)}, got ${JSON.stringify(plan.args)}`,
      };
    }
  }
  return { status: "valid", plan };
}

// ---------------------------------------------------------------------------
// UUIDv7
// ---------------------------------------------------------------------------

/** RFC 9562 UUIDv7 (48-bit unix-ms timestamp + version/variant + random). */
export function generateUuidV7(nowMs: number = Date.now()): string {
  const ms = BigInt(nowMs);
  const bytes = randomBytes(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[7] = bytes[7]!;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value: string): boolean {
  return UUIDV7_RE.test(value);
}

// ---------------------------------------------------------------------------
// Git default runner
// ---------------------------------------------------------------------------

const DEFAULT_GIT_ENV_STRIP = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function managedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of DEFAULT_GIT_ENV_STRIP) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

export const nodeManagedWorktreeGitRunner: ManagedWorktreeGitRunner = (cwd, args) =>
  new Promise<ManagedWorktreeGitResult>((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: managedGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolvePromise({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        });
      },
    );
  });

const defaultInstallRunner: ManagedWorktreeInstallRunner = (plan) =>
  new Promise<ManagedWorktreeGitResult>((resolvePromise, reject) => {
    execFile(
      "bun",
      [...plan.args],
      {
        cwd: plan.cwd,
        encoding: "utf8",
        env: plan.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolvePromise({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Path / handle helpers
// ---------------------------------------------------------------------------

function refusedPrepare(
  reason: PrepareManagedWorktreeRefusalReason,
  detail: string,
  extra: Partial<Extract<PrepareManagedWorktreeResult, { status: "refused" }>> = {},
): Extract<PrepareManagedWorktreeResult, { readonly status: "refused" }> {
  return { status: "refused", reason, detail, ...extra };
}

function refusedRelease(
  reason: ReleaseManagedWorktreeRefusalReason,
  detail: string,
  extra: Partial<Extract<ReleaseManagedWorktreeResult, { status: "refused" }>> = {},
): Extract<ReleaseManagedWorktreeResult, { status: "refused" }> {
  return { status: "refused", reason, detail, ...extra };
}

function defaultBranchForTask(taskId: string): string {
  return `${DEFAULT_BRANCH_PREFIX}${taskId}`;
}

function isSafeTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function worktreesParent(repositoryRoot: string): string {
  return cqManagedWorktreesParent(repositoryRoot);
}

/**
 * Create the managed parent and make it ignore itself (D404).
 *
 * Managed worktrees now live under the CQ placement, INSIDE the repository,
 * which is not wholesale-ignored the way the harness namespace was — so without
 * this every managed tree would show up as untracked in the repository it was
 * cut from, and `git status --porcelain` checks that gate cohort integration
 * would see a dirty tree. A `.gitignore` holding `*` inside the parent ignores
 * the trees AND itself, so no consumer has to edit their own ignore rules to
 * adopt this. Idempotent: an existing file is left exactly as it is.
 */
async function ensureManagedParentSelfIgnored(parent: string): Promise<void> {
  await fs.mkdir(parent, { recursive: true });
  const ignorePath = join(parent, ".gitignore");
  try {
    await fs.writeFile(ignorePath, "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function registryRoot(repositoryRoot: string, stateDir: string | undefined): string {
  return managedWorktreeRegistryRoot(repositoryRoot, stateDir);
}

function legacyHandlePath(regRoot: string, token: string): string {
  return join(regRoot, HANDLES_DIRNAME, `${token}.json`);
}

function legacyTaskIndexDir(regRoot: string, taskId: string): string {
  return join(regRoot, TASK_INDEX_DIRNAME, taskId);
}

function taskRegistryDir(regRoot: string, taskId: string): string {
  return join(regRoot, COHORT_REGISTRY_KEY_RE.test(taskId) ? COHORT_REGISTRY_DIRNAME : TASK_REGISTRY_DIRNAME, taskId);
}

function taskGenerationPath(regRoot: string, taskId: string, generation: string): string {
  return join(taskRegistryDir(regRoot, taskId), TASK_GENERATIONS_DIRNAME, `${generation}.json`);
}

function taskCurrentPath(regRoot: string, taskId: string): string {
  return join(taskRegistryDir(regRoot, taskId), TASK_CURRENT_FILENAME);
}

function registrySubjectKey(handle: AnyManagedWorktreeHandle): string {
  return handle.version === 3 ? `cohort-${handle.cohort.candidateIntentDigest}` : handle.taskId;
}

function fingerprintHandle(handle: AnyManagedWorktreeHandle): string {
  if (handle.version === 3) return cohortValueDigestV1(handle);
  const material = [
    handle.kind,
    String(handle.version),
    handle.token,
    handle.worktreeId,
    handle.taskId,
    handle.branch,
    handle.repositoryRoot,
    handle.absolutePath,
    handle.baseCommit,
    handle.createdAt,
    handle.nonce,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

interface StoredHandleRecord<H extends AnyManagedWorktreeHandle = ManagedWorktreeHandle> {
  readonly handle: H;
  readonly fingerprint: string;
  readonly status: "live" | "released";
  readonly headAtPrepare: string;
  readonly bunWorkspaceRoot: string;
  readonly trustedGateProjection?: ManagedWorktreeTrustedGateProjection;
  readonly releasedAt?: string;
  readonly retainedCohortAuthority?: {
    readonly lease: WorkCohortLeaseV1;
    readonly envelope: CohortEffectEnvelopeV1;
  };
  readonly cohortRebaseSuccessor?: {
    readonly proof: DispatchCohortRebaseTransition;
    readonly bridge: Extract<DispatchGuardedRebaseBridge, { readonly version: 2 }>;
    readonly handle: ManagedWorktreeHandleV3;
  };
  readonly cohortRebasePredecessor?: {
    readonly proof: DispatchCohortRebaseTransition;
    readonly bridge: Extract<DispatchGuardedRebaseBridge, { readonly version: 2 }>;
  };
}

interface ManagedWorktreeTrustedGateProjection {
  readonly kind: "cq-managed-trusted-gate-projection";
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly resultCommit: string;
  readonly integrationBaseCommit?: string;
  readonly gateExitCode: 0;
  readonly passCount: number;
  readonly failCount: 0;
  readonly capturedAt: string;
}

type TaskRegistryGeneration =
  | { readonly version: 2; readonly taskId: string; readonly records: readonly StoredHandleRecord[] }
  | { readonly version: 3; readonly subjectKey: string; readonly records: readonly StoredHandleRecord<AnyManagedWorktreeHandle>[] };

interface TaskRegistryPointer {
  readonly version: 2;
  readonly generation: string;
}

function isHandleShape(value: unknown): value is ManagedWorktreeHandle {
  return validateManagedWorktreeHandle(value).status === "valid";
}

type HandleIntegrityFailure = "handle-invalid" | "handle-foreign" | "handle-path-traversal";

function assertHandleIntegrity(
  handle: ManagedWorktreeHandle,
  repositoryRoot: string,
): HandleIntegrityFailure | null {
  const validation = validateManagedWorktreeHandle(handle, resolve(repositoryRoot));
  return validation.status === "valid" ? null : validation.reason;
}

async function readStoredHandle(
  regRoot: string,
  taskId: string,
  token: string,
  fault: ManagedWorktreeFaultInjector,
): Promise<StoredHandleRecord | null> {
  const records = await loadOrReconcileTaskRecords(regRoot, taskId, fault);
  return records.find((record) => record.handle.token === token) ?? null;
}

async function writeStoredHandleExclusive(
  regRoot: string,
  record: StoredHandleRecord<AnyManagedWorktreeHandle>,
  fault: ManagedWorktreeFaultInjector,
): Promise<void> {
  const key = registrySubjectKey(record.handle);
  const records = await loadOrReconcileSubjectRecords(regRoot, key, fault);
  if (records.some((entry) => entry.handle.token === record.handle.token)) {
    throw new Error(`managed registry token already exists: ${record.handle.token}`);
  }
  await publishTaskGeneration(regRoot, key, [...records, record], fault);
}

async function updateStoredHandle(
  regRoot: string,
  record: StoredHandleRecord,
  fault: ManagedWorktreeFaultInjector,
): Promise<void> {
  const records = await loadOrReconcileTaskRecords(regRoot, record.handle.taskId, fault);
  const index = records.findIndex((entry) => entry.handle.token === record.handle.token);
  if (index < 0) {
    throw new Error(`managed registry token does not exist: ${record.handle.token}`);
  }
  const next = [...records];
  next[index] = record;
  await publishTaskGeneration(regRoot, record.handle.taskId, next, fault);
}

async function listLiveHandlesForTask(
  regRoot: string,
  taskId: string,
  fault: ManagedWorktreeFaultInjector,
): Promise<StoredHandleRecord[]> {
  const records = await loadOrReconcileTaskRecords(regRoot, taskId, fault);
  return records.filter((record) => record.status === "live");
}

function isStoredHandleRecord(value: unknown, taskId?: string): value is StoredHandleRecord<AnyManagedWorktreeHandle> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<StoredHandleRecord<AnyManagedWorktreeHandle>>;
  const validation = validateAnyManagedWorktreeHandle(record.handle);
  if (validation.status !== "valid") return false;
  const handle = validation.handle;
  if (taskId !== undefined && registrySubjectKey(handle) !== taskId) return false;
  if (record.fingerprint !== fingerprintHandle(handle)) return false;
  if (record.status !== "live" && record.status !== "released") return false;
  if (typeof record.headAtPrepare !== "string") return false;
  if (typeof record.bunWorkspaceRoot !== "string") return false;
  const projectionBinding = { handle, fingerprint: record.fingerprint };
  if (
    record.trustedGateProjection !== undefined &&
    !isManagedWorktreeTrustedGateProjection(record.trustedGateProjection, projectionBinding)
  ) {
    return false;
  }
  if (record.releasedAt !== undefined && typeof record.releasedAt !== "string") return false;
  if (record.cohortRebaseSuccessor !== undefined) {
    const successor = record.cohortRebaseSuccessor;
    try { assertDispatchCohortRebaseTransition(successor.proof); } catch { return false; }
    if (handle.version !== 3 || validateAnyManagedWorktreeHandle(successor.handle).status !== "valid" ||
        successor.proof.sourceBinding.handleToken !== handle.token || successor.proof.sourceBinding.handleFingerprint !== record.fingerprint ||
        successor.proof.successorBinding.handleFingerprint !== fingerprintHandle(successor.handle) ||
        successor.proof.guardedRebaseBridgeDigest !== cohortValueDigestV1(successor.bridge)) return false;
  }
  if (record.cohortRebasePredecessor !== undefined) {
    const predecessor = record.cohortRebasePredecessor;
    try { assertDispatchCohortRebaseTransition(predecessor.proof); } catch { return false; }
    if (handle.version !== 3 || predecessor.proof.successorBinding.handleFingerprint !== record.fingerprint ||
        predecessor.proof.guardedRebaseBridgeDigest !== cohortValueDigestV1(predecessor.bridge)) return false;
  }
  if (record.retainedCohortAuthority !== undefined) {
    if (handle.version !== 3) return false;
    const retained = record.retainedCohortAuthority;
    if (typeof retained !== "object" || retained === null ||
        Object.keys(retained).sort().join(",") !== "envelope,lease" ||
        typeof retained.lease !== "object" || retained.lease === null ||
        Object.keys(retained.lease).sort().join(",") !== "capability,executionEpoch,holderId,semanticSubject" ||
        Object.values(retained.lease).some((value) => typeof value !== "string" || value.length === 0)) return false;
    try { assertCohortEffectEnvelopeV1(retained.envelope); } catch { return false; }
    if (retained.lease.executionEpoch !== retained.envelope.executionEpoch ||
        retained.lease.semanticSubject !== retained.envelope.semanticSubject ||
        cohortValueDigestV1(handle.cohort) !== cohortValueDigestV1(cohortWorktreeIdentityFromEnvelopeV1(retained.envelope))) return false;
  }
  return true;
}

function canonicalStoredHandleRecord(record: StoredHandleRecord<AnyManagedWorktreeHandle>): StoredHandleRecord<AnyManagedWorktreeHandle> {
  const handle = record.handle;
  return {
    handle: handle.version === 3 ? {
      kind: handle.kind, version: handle.version, token: handle.token, worktreeId: handle.worktreeId,
      branch: handle.branch, repositoryRoot: handle.repositoryRoot, absolutePath: handle.absolutePath,
      baseCommit: handle.baseCommit, createdAt: handle.createdAt, nonce: handle.nonce,
      cohort: { kind: handle.cohort.kind, version: handle.cohort.version, cohortId: handle.cohort.cohortId,
        definitionDigest: handle.cohort.definitionDigest, candidateIntentDigest: handle.cohort.candidateIntentDigest,
        memberSetDigest: handle.cohort.memberSetDigest, memberAuthorities: handle.cohort.memberAuthorities.map((member) => ({
          taskRef: member.taskRef, taskRevision: member.taskRevision, goalRef: member.goalRef,
          finalizedManifestDigest: member.finalizedManifestDigest, authorityRevision: member.authorityRevision,
        })) },
    } : {
      kind: handle.kind,
      version: handle.version,
      token: handle.token,
      worktreeId: handle.worktreeId,
      taskId: handle.taskId,
      branch: handle.branch,
      repositoryRoot: handle.repositoryRoot,
      absolutePath: handle.absolutePath,
      baseCommit: handle.baseCommit,
      createdAt: handle.createdAt,
      nonce: handle.nonce,
    },
    fingerprint: record.fingerprint,
    status: record.status,
    headAtPrepare: record.headAtPrepare,
    bunWorkspaceRoot: record.bunWorkspaceRoot,
    ...(record.trustedGateProjection === undefined
      ? {}
      : { trustedGateProjection: record.trustedGateProjection }),
    ...(record.releasedAt !== undefined ? { releasedAt: record.releasedAt } : {}),
    ...(record.retainedCohortAuthority === undefined ? {} :
      { retainedCohortAuthority: structuredClone(record.retainedCohortAuthority) }),
    ...(record.cohortRebaseSuccessor === undefined ? {} : { cohortRebaseSuccessor: structuredClone(record.cohortRebaseSuccessor) }),
    ...(record.cohortRebasePredecessor === undefined ? {} : { cohortRebasePredecessor: structuredClone(record.cohortRebasePredecessor) }),
  };
}

function isManagedWorktreeTrustedGateProjection(
  value: unknown,
  record: Pick<StoredHandleRecord<AnyManagedWorktreeHandle>, "handle" | "fingerprint">,
): value is ManagedWorktreeTrustedGateProjection {
  if (record.handle.version === 3) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const projection = value as Partial<ManagedWorktreeTrustedGateProjection>;
  return (
    projection.kind === "cq-managed-trusted-gate-projection" &&
    projection.version === 1 &&
    typeof projection.attestationId === "string" &&
    projection.attestationId.length > 0 &&
    Number.isSafeInteger(projection.generation) &&
    (projection.generation ?? 0) > 0 &&
    projection.taskId === record.handle.taskId &&
    projection.handleToken === record.handle.token &&
    projection.handleFingerprint === record.fingerprint &&
    projection.repositoryRoot === record.handle.repositoryRoot &&
    projection.worktreePath === record.handle.absolutePath &&
    projection.branch === record.handle.branch &&
    typeof projection.resultCommit === "string" &&
    /^[0-9a-f]{40}$/u.test(projection.resultCommit) &&
    (projection.integrationBaseCommit === undefined ||
      /^[0-9a-f]{40}$/u.test(projection.integrationBaseCommit)) &&
    projection.gateExitCode === 0 &&
    Number.isSafeInteger(projection.passCount) &&
    (projection.passCount ?? 0) > 0 &&
    projection.failCount === 0 &&
    typeof projection.capturedAt === "string" &&
    Number.isFinite(Date.parse(projection.capturedAt))
  );
}

function serializeTaskGeneration(taskId: string, records: readonly StoredHandleRecord<AnyManagedWorktreeHandle>[]): string {
  const generation = {
    ...(COHORT_REGISTRY_KEY_RE.test(taskId) ? { version: 3, subjectKey: taskId } : { version: 2, taskId }),
    records: [...records]
      .sort((left, right) => left.handle.token.localeCompare(right.handle.token))
      .map(canonicalStoredHandleRecord),
  };
  return `${JSON.stringify(generation, null, 2)}\n`;
}

function digestRegistryBytes(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncRegistryDirectory(
  directory: string,
  phase: string,
  fault: ManagedWorktreeFaultInjector,
): Promise<void> {
  await syncDirectory(directory);
  await fault("after-registry-directory-sync", { directory, phase });
}

async function readCurrentTaskGeneration(
  regRoot: string,
  taskId: string,
): Promise<readonly StoredHandleRecord<AnyManagedWorktreeHandle>[] | null> {
  let pointerRaw: string;
  try {
    pointerRaw = await fs.readFile(taskCurrentPath(regRoot, taskId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let pointerValue: unknown;
  try {
    pointerValue = JSON.parse(pointerRaw);
  } catch {
    throw new Error(`managed registry current pointer is malformed for ${taskId}`);
  }
  if (typeof pointerValue !== "object" || pointerValue === null || Array.isArray(pointerValue)) {
    throw new Error(`managed registry current pointer is malformed for ${taskId}`);
  }
  const pointer = pointerValue as Partial<TaskRegistryPointer>;
  if (
    pointer.version !== 2 ||
    typeof pointer.generation !== "string" ||
    !/^[0-9a-f]{64}$/.test(pointer.generation)
  ) {
    throw new Error(`managed registry current pointer is malformed for ${taskId}`);
  }
  const generationRaw = await fs.readFile(
    taskGenerationPath(regRoot, taskId, pointer.generation),
    "utf8",
  );
  if (digestRegistryBytes(generationRaw) !== pointer.generation) {
    throw new Error(`managed registry generation fingerprint mismatch for ${taskId}`);
  }
  let generationValue: unknown;
  try {
    generationValue = JSON.parse(generationRaw);
  } catch {
    throw new Error(`managed registry generation is malformed for ${taskId}`);
  }
  if (
    typeof generationValue !== "object" ||
    generationValue === null ||
    Array.isArray(generationValue)
  ) {
    throw new Error(`managed registry generation is malformed for ${taskId}`);
  }
  const generation = generationValue as Partial<TaskRegistryGeneration>;
  if (
    (COHORT_REGISTRY_KEY_RE.test(taskId)
      ? generation.version !== 3 || generation.subjectKey !== taskId
      : generation.version !== 2 || generation.taskId !== taskId) ||
    !Array.isArray(generation.records)
  ) {
    throw new Error(`managed registry generation is malformed for ${taskId}`);
  }
  const tokens = new Set<string>();
  for (const record of generation.records) {
    if (!isStoredHandleRecord(record, taskId) || tokens.has(record.handle.token)) {
      throw new Error(`managed registry generation contains an invalid record for ${taskId}`);
    }
    tokens.add(record.handle.token);
  }
  return generation.records as readonly StoredHandleRecord<AnyManagedWorktreeHandle>[];
}

async function publishTaskGeneration(
  regRoot: string,
  taskId: string,
  records: readonly StoredHandleRecord<AnyManagedWorktreeHandle>[],
  fault: ManagedWorktreeFaultInjector,
): Promise<void> {
  const generationRaw = serializeTaskGeneration(taskId, records);
  const generation = digestRegistryBytes(generationRaw);
  const current = await readCurrentTaskGeneration(regRoot, taskId);
  if (
    current !== null &&
    digestRegistryBytes(serializeTaskGeneration(taskId, current)) === generation
  ) {
    return;
  }

  const taskDir = taskRegistryDir(regRoot, taskId);
  const tasksDir = dirname(taskDir);
  const generationsDir = join(taskDir, TASK_GENERATIONS_DIRNAME);
  const stagingDir = join(taskDir, TASK_STAGING_DIRNAME);
  if (COHORT_REGISTRY_KEY_RE.test(taskId)) {
    await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
    await fs.chmod(tasksDir, 0o700);
  }
  await fs.mkdir(generationsDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  const finalGeneration = taskGenerationPath(regRoot, taskId, generation);
  try {
    const existing = await fs.readFile(finalGeneration, "utf8");
    if (existing !== generationRaw) {
      throw new Error(`managed registry immutable generation collision for ${taskId}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stagedGeneration = join(
      stagingDir,
      `generation-${generation}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
    );
    const generationHandle = await fs.open(stagedGeneration, "wx", 0o600);
    try {
      await generationHandle.writeFile(generationRaw, "utf8");
      await generationHandle.sync();
    } finally {
      await generationHandle.close();
    }
    await fs.rename(stagedGeneration, finalGeneration);
    await syncRegistryDirectory(generationsDir, "generation", fault);
  }

  const identity = COHORT_REGISTRY_KEY_RE.test(taskId) ? { subjectKey: taskId } : { taskId };
  await fault("after-registry-generation-sync", { ...identity, generation });

  const pointer: TaskRegistryPointer = { version: 2, generation };
  const pointerRaw = `${JSON.stringify(pointer, null, 2)}\n`;
  const stagedPointer = join(
    stagingDir,
    `current-${generation}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  const pointerHandle = await fs.open(stagedPointer, "wx", 0o600);
  try {
    await pointerHandle.writeFile(pointerRaw, "utf8");
    await pointerHandle.sync();
  } finally {
    await pointerHandle.close();
  }
  await fault("before-registry-pointer-rename", { ...identity, generation });
  await fs.rename(stagedPointer, taskCurrentPath(regRoot, taskId));
  await syncRegistryDirectory(taskDir, "pointer", fault);
  if (current === null) {
    await syncRegistryDirectory(tasksDir, "task-directory", fault);
    await syncRegistryDirectory(regRoot, "tasks-directory", fault);
    await syncRegistryDirectory(dirname(regRoot), "registry-root", fault);
  }
  await fault("after-registry-pointer-rename", { ...identity, generation });
}

interface StagedTaskGenerationPublication {
  readonly generation: string;
  readonly published: boolean;
  publish(): undefined;
  rollback(): Promise<void>;
}

function syncDirectoryNow(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function stageTaskGenerationPublication(
  regRoot: string,
  taskId: string,
  records: readonly StoredHandleRecord<AnyManagedWorktreeHandle>[],
  fault: ManagedWorktreeFaultInjector,
): Promise<StagedTaskGenerationPublication> {
  const generationRaw = serializeTaskGeneration(taskId, records);
  const generation = digestRegistryBytes(generationRaw);
  const taskDir = taskRegistryDir(regRoot, taskId);
  const tasksDir = dirname(taskDir);
  const generationsDir = join(taskDir, TASK_GENERATIONS_DIRNAME);
  const stagingDir = join(taskDir, TASK_STAGING_DIRNAME);
  if (COHORT_REGISTRY_KEY_RE.test(taskId)) {
    await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
    await fs.chmod(tasksDir, 0o700);
  }
  await fs.mkdir(generationsDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  const finalGeneration = taskGenerationPath(regRoot, taskId, generation);
  try {
    const existing = await fs.readFile(finalGeneration, "utf8");
    if (existing !== generationRaw) {
      throw new Error(`managed registry immutable generation collision for ${taskId}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stagedGeneration = join(
      stagingDir,
      `generation-${generation}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
    );
    const generationHandle = await fs.open(stagedGeneration, "wx", 0o600);
    try {
      await generationHandle.writeFile(generationRaw, "utf8");
      await generationHandle.sync();
    } finally {
      await generationHandle.close();
    }
    await fs.rename(stagedGeneration, finalGeneration);
    await syncRegistryDirectory(generationsDir, "generation", fault);
  }
  const identity = COHORT_REGISTRY_KEY_RE.test(taskId) ? { subjectKey: taskId } : { taskId };
  await fault("after-registry-generation-sync", { ...identity, generation });

  const currentPath = taskCurrentPath(regRoot, taskId);
  let oldPointerRaw: string | null = null;
  try {
    oldPointerRaw = await fs.readFile(currentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pointerRaw = `${JSON.stringify({ version: 2, generation } satisfies TaskRegistryPointer, null, 2)}\n`;
  const stagedPointer = join(
    stagingDir,
    `current-${generation}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  const pointerHandle = await fs.open(stagedPointer, "wx", 0o600);
  try {
    await pointerHandle.writeFile(pointerRaw, "utf8");
    await pointerHandle.sync();
  } finally {
    await pointerHandle.close();
  }

  let published = false;
  return {
    generation,
    get published(): boolean {
      return published;
    },
    publish(): undefined {
      if (published) throw new Error(`managed registry generation ${generation} already published`);
      renameSync(stagedPointer, currentPath);
      published = true;
      syncDirectoryNow(taskDir);
      if (oldPointerRaw === null) {
        syncDirectoryNow(tasksDir);
        syncDirectoryNow(regRoot);
        syncDirectoryNow(dirname(regRoot));
      }
      return undefined;
    },
    async rollback(): Promise<void> {
      if (!published) {
        await fs.rm(stagedPointer, { force: true });
        return;
      }
      if (oldPointerRaw === null) {
        rmSync(currentPath, { force: true });
        syncDirectoryNow(taskDir);
        return;
      }
      const restorePointer = join(
        stagingDir,
        `restore-${generation}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
      );
      const restoreHandle = await fs.open(restorePointer, "wx", 0o600);
      try {
        await restoreHandle.writeFile(oldPointerRaw, "utf8");
        await restoreHandle.sync();
      } finally {
        await restoreHandle.close();
      }
      await fs.rename(restorePointer, currentPath);
      syncDirectoryNow(taskDir);
    },
  };
}

async function quarantineLegacyIndex(
  regRoot: string,
  taskId: string,
  name: string,
  raw: string,
): Promise<void> {
  const source = join(legacyTaskIndexDir(regRoot, taskId), name);
  const quarantineDir = join(regRoot, REGISTRY_QUARANTINE_DIRNAME, TASK_INDEX_DIRNAME, taskId);
  await fs.mkdir(quarantineDir, { recursive: true });
  const digest = digestRegistryBytes(raw).slice(0, 16);
  const target = join(quarantineDir, `${name}.${digest}.quarantined`);
  try {
    const existing = await fs.readFile(target, "utf8");
    if (existing !== raw) {
      throw new Error(`managed registry quarantine collision for ${taskId}/${name}`);
    }
    await fs.rm(source, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.rename(source, target);
  }
}

async function readLegacyTaskRecords(
  regRoot: string,
  taskId: string,
): Promise<readonly StoredHandleRecord[]> {
  const records = new Map<string, StoredHandleRecord>();
  let handleNames: string[] = [];
  try {
    handleNames = await fs.readdir(join(regRoot, HANDLES_DIRNAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of handleNames) {
    if (!name.endsWith(".json")) continue;
    const token = name.slice(0, -".json".length);
    const raw = await fs.readFile(legacyHandlePath(regRoot, token), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isStoredHandleRecord(value, taskId) || value.handle.version === 3) continue;
    if (name !== `${value.handle.token}.json`) continue;
    records.set(value.handle.token, { ...value, handle: value.handle });
  }

  let indexNames: string[] = [];
  try {
    indexNames = await fs.readdir(legacyTaskIndexDir(regRoot, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of indexNames) {
    if (!name.endsWith(".json")) continue;
    const indexPath = join(legacyTaskIndexDir(regRoot, taskId), name);
    const raw = await fs.readFile(indexPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      await quarantineLegacyIndex(regRoot, taskId, name, raw);
      continue;
    }
    const index = value as { readonly token?: unknown; readonly status?: unknown };
    const keys = typeof value === "object" && value !== null ? Object.keys(value).sort() : [];
    const token = name.slice(0, -".json".length);
    const record = records.get(token);
    const valid =
      keys.length === 2 &&
      keys[0] === "status" &&
      keys[1] === "token" &&
      index.token === token &&
      (index.status === "live" || index.status === "released") &&
      record !== undefined &&
      record.status === index.status;
    if (!valid) {
      await quarantineLegacyIndex(regRoot, taskId, name, raw);
    }
  }
  return [...records.values()].sort((left, right) =>
    left.handle.token.localeCompare(right.handle.token),
  );
}

async function loadOrReconcileTaskRecords(
  regRoot: string,
  taskId: string,
  fault: ManagedWorktreeFaultInjector,
): Promise<readonly StoredHandleRecord[]> {
  const current = await readCurrentTaskGeneration(regRoot, taskId);
  if (current !== null) return current.map((record) => {
    if (record.handle.version === 3) throw new Error("task registry contains a cohort handle");
    return { ...record, handle: record.handle };
  });
  const legacy = await readLegacyTaskRecords(regRoot, taskId);
  if (legacy.length === 0) return [];
  await publishTaskGeneration(regRoot, taskId, legacy, fault);
  return legacy;
}

async function loadOrReconcileSubjectRecords(
  regRoot: string, subjectKey: string, fault: ManagedWorktreeFaultInjector,
): Promise<readonly StoredHandleRecord<AnyManagedWorktreeHandle>[]> {
  if (COHORT_REGISTRY_KEY_RE.test(subjectKey)) return (await readCurrentTaskGeneration(regRoot, subjectKey)) ?? [];
  if (!TASK_ID_RE.test(subjectKey)) throw new Error("managed registry subject key is invalid");
  return loadOrReconcileTaskRecords(regRoot, subjectKey, fault);
}

// ---------------------------------------------------------------------------
// Bun workspace discovery
// ---------------------------------------------------------------------------

export async function discoverBunWorkspaceRoot(repositoryRoot: string): Promise<string | null> {
  const root = resolve(repositoryRoot);
  async function hasLock(dir: string): Promise<boolean> {
    for (const name of BUN_LOCK_NAMES) {
      try {
        await fs.access(join(dir, name));
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  if (await hasLock(root)) return root;

  // Prefer the ledger-suite workspace layout used by this monorepo.
  const preferred = join(root, "nix", "pkg", "cq-ledgers");
  if (await hasLock(preferred)) return preferred;

  // Shallow scan of first-level and second-level directories.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules" || entry === ".claude") continue;
    const child = join(root, entry);
    let stat;
    try {
      stat = await fs.stat(child);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (await hasLock(child)) return child;
    let grandchildren: string[] = [];
    try {
      grandchildren = await fs.readdir(child);
    } catch {
      continue;
    }
    for (const grand of grandchildren) {
      if (grand === "node_modules" || grand === ".git") continue;
      const grandPath = join(child, grand);
      try {
        const gstat = await fs.stat(grandPath);
        if (gstat.isDirectory() && (await hasLock(grandPath))) return grandPath;
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function assertNoNodeModulesSymlink(workspaceRoot: string): Promise<string | null> {
  const candidate = join(workspaceRoot, "node_modules");
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      return `node_modules at ${candidate} is a symlink; managed prepare refuses symlink installs`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Map a seed-side Bun workspace root onto the workspace path inside a managed
 * worktree. Discovery runs against the seed repository; install must target the
 * copy under `absolutePath`, never the main checkout.
 */
export function rebaseBunWorkspaceIntoWorktree(
  repositoryRoot: string,
  seedBunWorkspaceRoot: string,
  absolutePath: string,
): string | null {
  const repo = resolve(repositoryRoot);
  const seed = resolve(seedBunWorkspaceRoot);
  const managed = resolve(absolutePath);
  if (!containedPath(repo, seed) && seed !== repo) {
    // Allow an override already pointing inside the managed tree.
    if (containedPath(managed, seed) || seed === managed) return seed;
    return null;
  }
  const rel = relative(repo, seed);
  if (rel === "") return managed;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return join(managed, rel);
}

async function rollbackFreshWorktree(
  git: ManagedWorktreeGitRunner,
  repositoryRoot: string,
  absolutePath: string,
  branch: string,
  createdBranch: boolean,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const remove = await git(repositoryRoot, ["worktree", "remove", "--force", absolutePath]);
  // Best-effort residual directory cleanup if git left anything behind.
  try {
    await fs.rm(absolutePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (createdBranch) {
    await git(repositoryRoot, ["branch", "-D", branch]);
  }
  // Confirm the path is gone and the branch is no longer checked out here.
  let pathGone = false;
  try {
    await fs.stat(absolutePath);
  } catch {
    pathGone = true;
  }
  if (!pathGone) {
    return {
      ok: false,
      detail: `rollback failed to remove worktree path ${absolutePath}: ${remove.stderr.trim() || remove.stdout.trim()}`,
    };
  }
  return { ok: true, detail: "" };
}

async function emergencyRegisterLiveHandle(
  regRoot: string,
  handle: AnyManagedWorktreeHandle,
  headCommit: string,
  bunWorkspaceRoot: string,
): Promise<boolean> {
  try {
    await writeStoredHandleExclusive(
      regRoot,
      {
        handle,
        fingerprint: fingerprintHandle(handle),
        status: "live",
        headAtPrepare: headCommit,
        bunWorkspaceRoot,
      },
      async () => undefined,
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WIP / dirty inspection (G122)
// ---------------------------------------------------------------------------

export interface WipOpenCheckpointFinding {
  readonly path: string;
  readonly openCheckpoints: readonly string[];
}

export async function findOpenWipCheckpoints(
  worktreePath: string,
  projection?: WipClosureProjection,
  candidateNames?: ReadonlySet<string>,
  candidateTaskId?: string,
): Promise<
  | { readonly status: "clean" }
  | { readonly status: "open"; readonly findings: readonly WipOpenCheckpointFinding[] }
  | { readonly status: "malformed"; readonly path: string; readonly detail: string }
> {
  let names: string[] = [];
  try {
    names = await fs.readdir(worktreePath);
  } catch (error) {
    return {
      status: "malformed",
      path: worktreePath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const findings: WipOpenCheckpointFinding[] = [];
  for (const name of names) {
    if (!name.startsWith("WIP-") || !name.endsWith(".md")) continue;
    if (candidateNames !== undefined && !candidateNames.has(name)) continue;
    const full = join(worktreePath, name);
    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        status: "malformed",
        path: full,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const artifact = parseWipArtifact(full, content);
      if (
        candidateTaskId !== undefined &&
        (name !== `WIP-${candidateTaskId}.md` ||
          artifact.id !== candidateTaskId ||
          artifact.role !== "implement-worker")
      ) {
        return {
          status: "malformed",
          path: full,
          detail: `foreign WIP artifact ${name} does not belong to ${candidateTaskId}`,
        };
      }
      const assessment = assessWipArtifactClosure(full, artifact, projection);
      if (assessment.status === "foreign") {
        return { status: "malformed", path: full, detail: assessment.detail };
      }
      if (assessment.status === "open") {
        findings.push({ path: full, openCheckpoints: assessment.openCheckpoints });
      }
    } catch (error) {
      if (error instanceof WipArtifactParseError) {
        return { status: "malformed", path: full, detail: error.reason };
      }
      throw error;
    }
  }
  if (findings.length > 0) return { status: "open", findings };
  return { status: "clean" };
}

async function gitPorcelain(
  git: ManagedWorktreeGitRunner,
  cwd: string,
): Promise<{ readonly code: number; readonly porcelain: string }> {
  const result = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return { code: result.code, porcelain: result.stdout };
}

async function revParse(
  git: ManagedWorktreeGitRunner,
  cwd: string,
  rev: string,
): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * D405 — task ids whose `WIP-<taskId>.md` is STILL PRESENT in `commit`'s tree.
 *
 * Closing every checkpoint makes an artifact "clean" for G122, but release
 * fast-forwards this exact commit into the integration tree, so a clean-but-
 * retained artifact lands there permanently. Recovery durability is unaffected:
 * the WIP remains reachable through the branch history that release parks under
 * the recovery ref, so only the TERMINAL tree has to be free of it.
 */
async function wipPathsRetainedInTree(
  git: ManagedWorktreeGitRunner,
  worktreePath: string,
  commit: string,
  taskIds: readonly string[],
): Promise<readonly string[]> {
  if (taskIds.length === 0) return [];
  const paths = taskIds.map((taskId) => `WIP-${taskId}.md`);
  const listed = await git(worktreePath, ["ls-tree", "--name-only", "-z", commit, "--", ...paths]);
  if (listed.code !== 0) {
    throw new Error(
      `managed release could not inspect the terminal tree: ${listed.stderr.trim() || listed.stdout.trim()}`,
    );
  }
  return listed.stdout.split("\0").filter((name: string) => name !== "");
}

function rootWipNames(output: string): readonly string[] {
  return output
    .split("\0")
    .map((name) => name.split("/", 1)[0] ?? "")
    .filter((name) => name.startsWith("WIP-") && name.endsWith(".md"));
}

async function recoverableWipCandidateNames(
  git: ManagedWorktreeGitRunner,
  worktreePath: string,
  taskStartCommit: string,
  resultCommit: string,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const start = await revParse(git, worktreePath, taskStartCommit);
  if (start === null) throw new Error("managed WIP closure requires the task starting commit");
  const ancestor = await git(worktreePath, ["merge-base", "--is-ancestor", start, resultCommit]);
  if (ancestor.code !== 0) {
    throw new Error("managed WIP closure candidate diverges from the task starting commit");
  }
  const changed = await git(worktreePath, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACMRTUXB",
    `${start}..${resultCommit}`,
    "--",
  ]);
  if (changed.code !== 0) {
    throw new Error(
      `managed WIP closure could not compare the candidate to its task start: ${changed.stderr.trim() || changed.stdout.trim()}`,
    );
  }
  const untracked = await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) {
    throw new Error(
      `managed WIP closure could not inspect untracked artifacts: ${untracked.stderr.trim() || untracked.stdout.trim()}`,
    );
  }
  return new Set([
    ...taskIds.map((taskId) => `WIP-${taskId}.md`),
    ...rootWipNames(changed.stdout),
    ...rootWipNames(untracked.stdout),
  ]);
}

async function branchCheckedOutPaths(
  git: ManagedWorktreeGitRunner,
  repositoryRoot: string,
  branch: string,
): Promise<string[]> {
  const result = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return [];
  const paths: string[] = [];
  let currentPath: string | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && currentPath !== null) {
      const ref = line.slice("branch ".length);
      if (ref === `refs/heads/${branch}` || ref === branch) {
        paths.push(currentPath);
      }
    } else if (line === "") {
      currentPath = null;
    }
  }
  return paths;
}

async function localBranchExists(
  git: ManagedWorktreeGitRunner,
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await git(repositoryRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

async function resolveRepositoryRoot(
  git: ManagedWorktreeGitRunner,
  candidate: string,
): Promise<string | null> {
  const abs = resolve(candidate);
  const result = await git(abs, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  const top = result.stdout.trim();
  if (top === "") return null;
  return resolve(top);
}

async function verifyBaseCommit(
  dispatchGit: DispatchBaseGitRunner,
  repositoryRoot: string,
  baseCommit: string,
  integrationHead: string | undefined,
): Promise<DispatchBaseVerification> {
  const headRevision = integrationHead ?? baseCommit;
  const observations = await observeDispatchBase(
    { cwd: repositoryRoot, baseRevision: baseCommit, headRevision },
    dispatchGit,
  );
  return verifyDispatchBase(observations);
}

async function buildEvidence(
  handle: AnyManagedWorktreeHandle,
  headCommit: string,
  bunWorkspaceRoot: string,
  bunWorkspaceRoots: readonly string[],
  bunInstallCacheDir: string,
  dependencyResultCommits: readonly DependencyResultCommit[],
  mode: "fresh" | "resume" | "adopted",
): Promise<PreparedWorktreeEvidence> {
  return {
    worktreeId: handle.worktreeId,
    absolutePath: handle.absolutePath,
    branch: handle.branch,
    baseCommit: handle.baseCommit,
    headCommit,
    bunWorkspaceRoot,
    bunWorkspaceRoots,
    bunInstallCacheDir,
    bunInstallArgs: [...FROZEN_INSTALL_ARGS],
    dependencyResultCommits,
    mode,
  };
}

async function resumeFromStored(
  request: PrepareManagedWorktreeRequest,
  deps: ManagedWorktreeDeps,
  stored: StoredHandleRecord,
  repositoryRoot: string,
): Promise<PrepareManagedWorktreeResult> {
  const handle = stored.handle;
  const integrity = assertHandleIntegrity(handle, repositoryRoot);
  if (integrity !== null) {
    return refusedPrepare(integrity, `resume handle failed integrity: ${integrity}`);
  }
  if (handle.taskId !== request.taskId) {
    return refusedPrepare(
      "handle-mismatch",
      `handle taskId ${handle.taskId} does not match request taskId ${request.taskId}`,
    );
  }
  if (request.branch !== undefined && request.branch !== handle.branch) {
    return refusedPrepare(
      "branch-identity-mismatch",
      `handle branch ${handle.branch} does not match requested branch ${request.branch}`,
    );
  }

  return resumeManagedRecord(request.priorResultCommit, deps, stored);
}

async function resumeManagedRecord<H extends AnyManagedWorktreeHandle>(
  priorResultCommit: string | null | undefined,
  deps: ManagedWorktreeDeps,
  stored: StoredHandleRecord<H>,
): Promise<ManagedWorktreeAllocationResult<H>> {
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const handle = stored.handle;

  try {
    const stat = await fs.stat(handle.absolutePath);
    if (!stat.isDirectory()) {
      return refusedPrepare(
        "worktree-missing",
        `managed worktree path is not a directory: ${handle.absolutePath}`,
      );
    }
  } catch {
    return refusedPrepare(
      "worktree-missing",
      `managed worktree path missing: ${handle.absolutePath}`,
    );
  }

  const head = await revParse(git, handle.absolutePath, "HEAD");
  if (head === null) {
    return refusedPrepare("worktree-missing", `cannot resolve HEAD in ${handle.absolutePath}`);
  }
  const branchHead = await revParse(git, handle.absolutePath, handle.branch);
  if (branchHead === null || branchHead !== head) {
    return refusedPrepare(
      "branch-identity-mismatch",
      `worktree HEAD ${head} does not match branch ${handle.branch}`,
    );
  }

  if (priorResultCommit !== undefined && priorResultCommit !== null) {
    if (!FULL_COMMIT_SHA.test(priorResultCommit)) {
      return refusedPrepare(
        "prior-result-commit-mismatch",
        `priorResultCommit is not a full SHA: ${priorResultCommit}`,
      );
    }
    const ancestor = await git(handle.absolutePath, [
      "merge-base",
      "--is-ancestor",
      priorResultCommit,
      head,
    ]);
    if (ancestor.code !== 0 && priorResultCommit !== head) {
      return refusedPrepare(
        "prior-result-commit-mismatch",
        `priorResultCommit ${priorResultCommit} is not equal to or an ancestor of HEAD ${head}`,
      );
    }
  }

  if (stored.status === "released") {
    return refusedPrepare(
      "handle-mismatch",
      `handle ${handle.token} is already released; create a fresh prepare`,
    );
  }

  const evidence = await buildEvidence(
    handle,
    head,
    stored.bunWorkspaceRoot,
    [stored.bunWorkspaceRoot],
    resolveBunInstallCacheDir(deps.cacheRoot),
    [],
    "resume",
  );
  return { status: "prepared", handle, evidence };
}

/**
 * Prepare a managed task worktree (fresh or resume) or return typed
 * `resume-required` when a handle-free call finds exactly one live tree.
 */
export async function prepareManagedWorktree(
  request: PrepareManagedWorktreeRequest,
  deps: ManagedWorktreeDeps = {},
): Promise<PrepareManagedWorktreeResult> {
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const dispatchGit = deps.dispatchGit ?? nodeDispatchBaseGitRunner;
  const install = deps.install ?? defaultInstallRunner;
  const idFactory = deps.idFactory ?? (() => generateUuidV7(deps.now?.().getTime()));
  const now = deps.now ?? (() => new Date());
  const allowResumeRequired = request.allowResumeRequired ?? true;
  const fault = deps.faultInjector ?? (async () => undefined);

  if (!isSafeTaskId(request.taskId)) {
    return refusedPrepare("task-id-invalid", `taskId must match /^T\\d+$/, got ${request.taskId}`);
  }

  const repositoryRoot = await resolveRepositoryRoot(git, request.repositoryRoot);
  if (repositoryRoot === null) {
    return refusedPrepare("repository-invalid", `not a git repository: ${request.repositoryRoot}`);
  }

  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });

  if (request.handle !== undefined) {
    const integrity = assertHandleIntegrity(request.handle, repositoryRoot);
    if (integrity !== null) {
      return refusedPrepare(integrity, `handle failed integrity: ${integrity}`);
    }
    if (request.handle.taskId !== request.taskId) {
      return refusedPrepare(
        "handle-mismatch",
        `handle taskId ${request.handle.taskId} does not match request taskId ${request.taskId}`,
      );
    }
  }
  const adoptionFieldCount =
    Number(request.adoptWorktreePath !== undefined) + Number(request.expectedHead !== undefined);
  if (adoptionFieldCount === 1 || (adoptionFieldCount > 0 && request.handle !== undefined)) {
    return refusedPrepare(
      "adoption-invalid",
      "adoptWorktreePath and expectedHead must appear together on handle-free prepare",
    );
  }

  // Every read that may reconcile legacy state and every publication shares
  // the same per-task lock. Readers outside this critical section only follow
  // the atomically replaced current pointer.
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.prepareLockTimeoutMs !== undefined
        ? { acquireTimeoutMs: deps.prepareLockTimeoutMs }
        : {}),
    });
  const locksDir = join(regRoot, PREPARE_LOCKS_DIRNAME);
  let releasePrepareLock: (() => Promise<void>) | undefined;
  try {
    releasePrepareLock = await lockfile.acquire(locksDir, `prepare-${request.taskId}`);
  } catch (error) {
    return refusedPrepare(
      "prepare-lock-busy",
      `could not acquire prepare lock for ${request.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const reservation = await findCohortMemberOwner(regRoot, [request.taskId], null);
    if (reservation !== null) return refusedPrepare("member-reserved", reservation);
    if (deps.cohortStore !== undefined) {
      const transitions = (await deps.cohortStore.snapshot()).portable.reservationTransitions;
      const active = new Map<string, (typeof transitions)[number]>();
      for (const transition of transitions) {
        if (transition.transition === "reserved") active.set(transition.reservationId, transition);
        else active.delete(transition.reservationId);
      }
      if ([...active.values()].some((value) => value.memberRefs.includes(`tasks:${request.taskId}`))) {
        return refusedPrepare("member-reserved", `task ${request.taskId} belongs to an active cohort reservation`);
      }
    }
    if (request.handle !== undefined) {
      let stored: StoredHandleRecord | null;
      try {
        stored = await readStoredHandle(regRoot, request.taskId, request.handle.token, fault);
      } catch (error) {
        return refusedPrepare(
          "registry-conflict",
          `managed registry could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stored === null) {
        return refusedPrepare("handle-invalid", `unknown or tampered handle token`);
      }
      if (fingerprintHandle(request.handle) !== stored.fingerprint) {
        return refusedPrepare(
          "handle-mismatch",
          "presented handle does not match the stored registry fingerprint",
        );
      }
      if (resolve(request.handle.absolutePath) !== resolve(stored.handle.absolutePath)) {
        return refusedPrepare(
          "handle-path-traversal",
          "handle absolutePath does not match registry",
        );
      }
      return resumeFromStored(request, deps, stored, repositoryRoot);
    }
    return await prepareManagedWorktreeHandleFreeUnderLock(request, deps, {
      git,
      dispatchGit,
      install,
      idFactory,
      now,
      allowResumeRequired,
      fault,
      repositoryRoot,
      regRoot,
    });
  } finally {
    if (releasePrepareLock !== undefined) {
      await releasePrepareLock();
    }
  }
}

async function findCohortMemberOwner(
  regRoot: string, taskIds: readonly string[], permittedSubject: string | null,
): Promise<string | null> {
  const directory = join(regRoot, COHORT_REGISTRY_DIRNAME);
  let entries: string[];
  try { entries = await fs.readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const members = new Set(taskIds.map((id) => `tasks:${id}`));
  for (const key of entries) {
    if (!COHORT_REGISTRY_KEY_RE.test(key)) throw new Error("invalid cohort registry subject directory");
    if (key === permittedSubject) continue;
    const records = await readCurrentTaskGeneration(regRoot, key);
    for (const record of records ?? []) {
      if (record.handle.version !== 3) throw new Error("cohort registry contains a task handle");
      if (record.status === "live" && record.handle.cohort.memberAuthorities.some((member) => members.has(member.taskRef))) {
        return `cohort ${record.handle.cohort.cohortId} already owns an overlapping member`;
      }
    }
  }
  return null;
}

async function withManagedMemberPrepareLocks<T>(
  regRoot: string, taskIds: readonly string[], deps: ManagedWorktreeDeps, effect: () => Promise<T>,
): Promise<T> {
  const lockfile = deps.lockfile ?? new Lockfile({ ...(deps.prepareLockTimeoutMs === undefined ? {} :
    { acquireTimeoutMs: deps.prepareLockTimeoutMs }) });
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const taskId of [...new Set(taskIds)].sort()) {
      releases.push(await lockfile.acquire(join(regRoot, PREPARE_LOCKS_DIRNAME), `prepare-${taskId}`));
    }
    return await effect();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

export async function prepareManagedCohortWorktree(
  request: PrepareManagedCohortWorktreeRequest,
  deps: ManagedWorktreeDeps,
  authority: ManagedCohortWorktreeAuthority,
): Promise<PrepareManagedCohortWorktreeResult> {
  const { store, lease, envelope } = authority;
  try { await store.assertLiveCohortAuthority(lease, envelope); }
  catch (error) { return refusedPrepare("cohort-authority-stale", String(error)); }
  const cohort = cohortWorktreeIdentityFromEnvelopeV1(envelope);
  const taskIds = cohort.memberAuthorities.map((member) => member.taskRef.slice("tasks:".length));
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const repositoryRoot = await resolveRepositoryRoot(git, request.repositoryRoot);
  if (repositoryRoot === null) return refusedPrepare("repository-invalid", "cohort repository does not exist");
  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  const subjectKey = `cohort-${cohort.candidateIntentDigest}`;
  if (request.handle !== null) {
    const validated = validateAnyManagedWorktreeHandle(request.handle, repositoryRoot);
    if (validated.status !== "valid" || validated.handle.version !== 3) return refusedPrepare("handle-invalid", "cohort handle is invalid");
    if (cohortValueDigestV1(validated.handle.cohort) !== cohortValueDigestV1(cohort)) {
      return refusedPrepare("handle-mismatch", "handle differs from the complete current cohort identity");
    }
  }
  return withManagedMemberPrepareLocks(regRoot, taskIds, deps, async () => {
    try { await store.assertLiveCohortAuthority(lease, envelope); }
    catch (error) { return refusedPrepare("cohort-authority-stale", String(error)); }
    const overlap = await findCohortMemberOwner(regRoot, taskIds, subjectKey);
    if (overlap !== null) return refusedPrepare("member-reserved", overlap);
    const fault = deps.faultInjector ?? (async () => undefined);
    for (const taskId of taskIds) {
      if ((await listLiveHandlesForTask(regRoot, taskId, fault)).length > 0) {
        return refusedPrepare("member-reserved", `member ${taskId} already owns a task worktree`);
      }
    }
    const records = await loadOrReconcileSubjectRecords(regRoot, subjectKey, fault);
    const live = records.filter((record) => record.status === "live");
    if (live.length > 1) return refusedPrepare("live-tree-ambiguous", "cohort owns multiple live worktrees");
    if (request.handle !== null || live.length > 0) {
      const stored = request.handle === null ? live[0] : records.find((record) => record.handle.token === request.handle!.token);
      if (stored === undefined || stored.handle.version !== 3 ||
          cohortValueDigestV1(stored.handle.cohort) !== cohortValueDigestV1(cohort) ||
          (request.handle !== null && fingerprintHandle(request.handle) !== stored.fingerprint)) {
        return refusedPrepare("handle-mismatch", "cohort handle does not match its authoritative registry");
      }
      const resumed = await resumeManagedRecord(request.priorResultCommit, deps, { ...stored, handle: stored.handle });
      if (resumed.status === "refused") return resumed;
      try { await store.assertLiveCohortAuthority(lease, envelope); }
      catch (error) { return refusedPrepare("cohort-authority-stale", String(error)); }
      try { await store.publishLiveCohortEffect(lease, envelope, () => { deps.validateCohortPublication?.(envelope); }); }
      catch (error) { return refusedPrepare("cohort-authority-stale", String(error)); }
      return request.handle === null ? { ...resumed, status: "resume-required", reason: "live-tree-exists" } : resumed;
    }
    if (envelope.state !== "pre-seal") return refusedPrepare("cohort-authority-stale", "a sealed candidate cannot allocate a new worktree");
    const repository = await managedRepositoryIdentity(git, repositoryRoot);
    const tree = await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${request.baseCommit}^{tree}`]);
    if (repository === null || repository.repositoryId !== envelope.definition.repository.repositoryId ||
        request.baseCommit !== envelope.definition.repository.headCommit ||
        tree.code !== 0 || tree.stdout.trim() !== envelope.definition.repository.treeOid) {
      return refusedPrepare("repository-invalid", "cohort definition does not bind this exact repository/base/tree");
    }
    const dispatchGit = deps.dispatchGit ?? nodeDispatchBaseGitRunner;
    const base = await verifyBaseCommit(dispatchGit, repositoryRoot, request.baseCommit, request.integrationHead);
    if (base.status !== "verified") return refusedPrepare(base.status === "rebase-required" ? "base-rebase-required" : "base-unresolvable", "cohort dispatch base is not verified", { base });
    const dependencies = new Map<string, DependencyResultCommit>();
    for (const taskId of taskIds) {
      const resolved = await resolveDependencyResultCommitsForDispatch({ cwd: repositoryRoot,
        rootTaskRef: taskId, proposedDispatchBase: request.baseCommit }, request.dependencyReader, dispatchGit);
      if (resolved.status === "unresolvable") return refusedPrepare("dependency-unresolvable", "cohort member dependency is unresolved", { dependency: resolved });
      for (const dependency of resolved.dependencyResultCommits) dependencies.set(cohortValueDigestV1(dependency), dependency);
    }
    const branch = `implement/${subjectKey}`;
    if ((await branchCheckedOutPaths(git, repositoryRoot, branch)).length > 0) return refusedPrepare("branch-checked-out-elsewhere", "cohort branch is already checked out");
    const ctx: PrepareUnderLockContext = { git, dispatchGit, install: deps.install ?? defaultInstallRunner,
      idFactory: deps.idFactory ?? (() => generateUuidV7(deps.now?.().getTime())), now: deps.now ?? (() => new Date()),
      allowResumeRequired: true, fault, repositoryRoot, regRoot };
    return allocateManagedWorktreeUnderLock({ baseCommit: request.baseCommit, branch,
      dependencyResultCommits: [...dependencies.values()] }, {
      audit: { cohortId: cohort.cohortId, candidateIntentDigest: cohort.candidateIntentDigest },
      createHandle: (fields): ManagedWorktreeHandleV3 => ({ ...fields, version: 3, cohort }),
      register: async (handle, headCommit, bunWorkspaceRoot) => {
        const record: StoredHandleRecord<ManagedWorktreeHandleV3> = { handle, fingerprint: fingerprintHandle(handle),
          status: "live", headAtPrepare: headCommit, bunWorkspaceRoot,
          retainedCohortAuthority: { lease: structuredClone(lease), envelope: structuredClone(envelope) } };
        const staged = await stageTaskGenerationPublication(regRoot, subjectKey, [...records, record], fault);
        try {
          await fault("before-registry-pointer-rename", { subjectKey, generation: staged.generation });
          await store.publishLiveCohortEffect(lease, envelope, () => { deps.validateCohortPublication?.(envelope); return staged.publish(); });
          await fault("after-registry-pointer-rename", { subjectKey, generation: staged.generation });
        } catch (error) {
          if (staged.published) throw new PublishedManagedWorktreeRegistryError(String(error));
          await staged.rollback();
          throw error;
        }
      },
      emergencyRegister: (handle, head, workspace) => emergencyRegisterLiveHandle(regRoot, handle, head, workspace),
    }, deps, ctx);
  });
}

async function managedRepositoryIdentity(git: ManagedWorktreeGitRunner, repositoryRoot: string): Promise<{
  readonly repositoryId: string; readonly repositoryRoot: string; readonly commonDir: string;
} | null> {
  const result = await git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.code !== 0 || result.stdout.trim() === "") return null;
  const canonicalRepository = await fs.realpath(repositoryRoot);
  const commonDir = await fs.realpath(result.stdout.trim());
  return { repositoryRoot: canonicalRepository, commonDir,
    repositoryId: createHash("sha256").update(`${canonicalRepository}\n${commonDir}`).digest("hex") };
}

interface PrepareUnderLockContext {
  readonly git: ManagedWorktreeGitRunner;
  readonly dispatchGit: DispatchBaseGitRunner;
  readonly install: ManagedWorktreeInstallRunner;
  readonly idFactory: ManagedWorktreeIdFactory;
  readonly now: () => Date;
  readonly allowResumeRequired: boolean;
  readonly fault: ManagedWorktreeFaultInjector;
  readonly repositoryRoot: string;
  readonly regRoot: string;
}

class AdoptionRefusal extends Error {
  constructor(
    readonly reason: PrepareManagedWorktreeRefusalReason,
    detail: string,
  ) {
    super(detail);
  }
}

const heldAdoptionManagerLock: LegacyWorktreeManagerLock = {
  async acquire() {
    return async () => undefined;
  },
};

function adoptionTransactionId(taskId: string, expectedHead: string): string {
  return `adopt-${taskId}-${expectedHead.slice(0, 16)}`;
}

async function prepareAdoptedWorktreeUnderLock(
  request: PrepareManagedWorktreeRequest & {
    readonly adoptWorktreePath: string;
    readonly expectedHead: string;
  },
  deps: ManagedWorktreeDeps,
  ctx: PrepareUnderLockContext,
  live: readonly StoredHandleRecord[],
): Promise<PrepareManagedWorktreeResult> {
  const { git, dispatchGit, install, idFactory, now, fault, repositoryRoot, regRoot } = ctx;
  const authority = deps.taskAdoptionAuthority;
  const activityFence = deps.adoptionActivityFence;
  if (authority === undefined || activityFence === undefined || deps.skipInstall === true) {
    return refusedPrepare(
      "adoption-unavailable",
      "legacy adoption requires bound task authority, activity fencing, and the real frozen install",
    );
  }

  const baseCommit = request.baseCommit;
  if (baseCommit === undefined || !FULL_COMMIT_SHA.test(baseCommit)) {
    return refusedPrepare("base-unresolvable", "legacy adoption requires a full baseCommit");
  }
  if (!FULL_COMMIT_SHA.test(request.expectedHead) || !isAbsolute(request.adoptWorktreePath)) {
    return refusedPrepare(
      "adoption-invalid",
      "legacy adoption requires an absolute adoptWorktreePath and full expectedHead",
    );
  }
  const branch = request.branch ?? defaultBranchForTask(request.taskId);
  const expectedBranch = defaultBranchForTask(request.taskId);
  const absolutePath = resolve(request.adoptWorktreePath);
  // D404: legacy adoption adopts a tree that ALREADY EXISTS, and every such
  // tree predates the cutover, so its expected location is the harness-native
  // parent — not CQ's placement, which only fresh creation uses.
  const expectedPath = join(
    harnessNativeWorktreesParent(repositoryRoot),
    `implement-${request.taskId}`,
  );
  if (branch !== expectedBranch || absolutePath !== expectedPath) {
    return refusedPrepare(
      "adoption-invalid",
      `legacy adoption requires branch ${expectedBranch} at ${expectedPath}`,
    );
  }

  const transactionId = adoptionTransactionId(request.taskId, request.expectedHead);
  const journalDirectory = join(regRoot, "adoption-reconciliation");
  const journalPath = join(journalDirectory, `${transactionId}.json`);
  const recoveryRequest = { transactionId, journalDirectory } as const;

  if (live.length === 1) {
    const stored = live[0]!;
    if (
      stored.handle.version !== ADOPTED_HANDLE_VERSION ||
      resolve(stored.handle.absolutePath) !== absolutePath ||
      stored.handle.branch !== branch ||
      stored.handle.baseCommit !== baseCommit
    ) {
      return refusedPrepare(
        "registry-conflict",
        `task ${request.taskId} already owns a different live managed worktree`,
      );
    }
    const recovered = await recoverLegacyWorktreeReconciliation(
      {
        ...recoveryRequest,
        finalizeReconciled: true,
        repairPublishedV1: {
          repositoryRoot,
          worktreePath: absolutePath,
          branch,
          baseCommit,
          legacyHead: request.expectedHead,
          candidateHead: stored.headAtPrepare,
        },
      },
      { managerLock: heldAdoptionManagerLock, activityFence },
    );
    if (recovered.status === "refused" && recovered.reason !== "journal-missing") {
      return refusedPrepare(
        "adoption-recovery-failed",
        `published adoption recovery refused: ${recovered.reason}: ${recovered.detail}`,
      );
    }
    const resumed = await resumeFromStored(request, deps, stored, repositoryRoot);
    if (resumed.status !== "prepared") return resumed;
    return { ...resumed, evidence: { ...resumed.evidence, mode: "adopted" } };
  }
  if (live.length > 1) {
    return refusedPrepare(
      "live-tree-ambiguous",
      `task ${request.taskId} owns ${live.length} live managed worktrees`,
    );
  }

  const records = await loadOrReconcileTaskRecords(regRoot, request.taskId, fault);
  if (records.length !== 0) {
    return refusedPrepare(
      "registry-conflict",
      `task ${request.taskId} already has ${records.length} managed registry record(s)`,
    );
  }

  const pendingRecovery = await recoverLegacyWorktreeReconciliation(recoveryRequest, {
    managerLock: heldAdoptionManagerLock,
    activityFence,
  });
  if (pendingRecovery.status === "recovered") {
    if (pendingRecovery.outcome !== "rolled-back") {
      return refusedPrepare(
        "adoption-recovery-failed",
        "reconciliation is committed but no authoritative managed handle exists",
      );
    }
    await fs.rm(journalPath, { force: true });
  } else if (pendingRecovery.reason !== "journal-missing") {
    return refusedPrepare(
      "adoption-recovery-failed",
      `pending adoption recovery refused: ${pendingRecovery.reason}: ${pendingRecovery.detail}`,
    );
  }

  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    return refusedPrepare(
      "adoption-invalid",
      `legacy adoption path cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return refusedPrepare("adoption-invalid", "legacy adoption path must be a real directory");
  }
  const top = await resolveRepositoryRoot(git, absolutePath);
  if (top !== absolutePath) {
    return refusedPrepare("adoption-invalid", "legacy adoption path is not its worktree root");
  }
  const checkedOut = await branchCheckedOutPaths(git, repositoryRoot, branch);
  if (checkedOut.length !== 1 || resolve(checkedOut[0]!) !== absolutePath) {
    return refusedPrepare(
      "adoption-invalid",
      `branch ${branch} is not checked out exactly at ${absolutePath}`,
    );
  }
  const symbolic = await git(absolutePath, ["symbolic-ref", "--quiet", "HEAD"]);
  const observedHead = await revParse(git, absolutePath, "HEAD");
  const branchHead = await revParse(git, repositoryRoot, branch);
  if (
    symbolic.code !== 0 ||
    symbolic.stdout.trim() !== `refs/heads/${branch}` ||
    observedHead !== request.expectedHead ||
    branchHead !== request.expectedHead
  ) {
    return refusedPrepare(
      "adoption-invalid",
      `legacy adoption identity does not match branch ${branch} at expected HEAD ${request.expectedHead}`,
    );
  }

  const wip = await findOpenWipCheckpoints(absolutePath);
  if (wip.status !== "clean") {
    const detail =
      wip.status === "open"
        ? `open WIP checkpoints: ${wip.findings.flatMap((entry) => entry.openCheckpoints).join(", ")}`
        : `malformed WIP artifact ${wip.path}: ${wip.detail}`;
    return refusedPrepare("adoption-invalid", detail);
  }

  const baseVerification = await verifyBaseCommit(
    dispatchGit,
    repositoryRoot,
    baseCommit,
    request.integrationHead,
  );
  if (baseVerification.status === "rebase-required") {
    return refusedPrepare("base-rebase-required", `base ${baseCommit} has diverged`, {
      base: baseVerification,
    });
  }
  if (baseVerification.status === "unresolvable") {
    return refusedPrepare(
      "base-unresolvable",
      `base verification failed: ${baseVerification.reason}`,
      { base: baseVerification },
    );
  }

  let dependencyResultCommits: readonly DependencyResultCommit[] = [];
  if (request.dependencyReader !== undefined) {
    const resolution = await resolveDependencyResultCommitsForDispatch(
      { cwd: repositoryRoot, rootTaskRef: request.taskId, proposedDispatchBase: baseCommit },
      request.dependencyReader,
      dispatchGit,
    );
    if (resolution.status === "unresolvable") {
      return refusedPrepare(
        "dependency-unresolvable",
        `dependency closure refused: ${resolution.reason}`,
        { dependency: resolution },
      );
    }
    dependencyResultCommits = resolution.dependencyResultCommits;
  }

  const eligibility = await authority.captureTaskAdoptionEligibility(request.taskId);
  if (eligibility.status !== "eligible") {
    return refusedPrepare(
      "adoption-ineligible",
      `task adoption is ineligible: ${eligibility.ineligibility.reason}`,
    );
  }

  const seedBunWorkspaceRoot =
    deps.bunWorkspaceRoot ?? (await discoverBunWorkspaceRoot(repositoryRoot));
  if (seedBunWorkspaceRoot === null) {
    return refusedPrepare("bun-workspace-missing", "no Bun workspace found for adoption");
  }
  const bunWorkspaceRoot = rebaseBunWorkspaceIntoWorktree(
    repositoryRoot,
    seedBunWorkspaceRoot,
    absolutePath,
  );
  if (bunWorkspaceRoot === null) {
    return refusedPrepare("bun-workspace-missing", "Bun workspace is outside the adopted tree");
  }
  const installPlan = buildManagedWorktreeInstallPlan({
    bunWorkspaceRoot,
    ...(deps.cacheRoot === undefined ? {} : { cacheRoot: deps.cacheRoot }),
  });
  const planValidation = validateManagedWorktreeInstallPlan(
    installPlan,
    deps.cacheRoot === undefined ? {} : { cacheRoot: deps.cacheRoot },
  );
  if (planValidation.status === "invalid") {
    return refusedPrepare(
      "bun-install-plan-invalid",
      `${planValidation.reason}: ${planValidation.detail}`,
    );
  }
  const preInstallSymlink = await assertNoNodeModulesSymlink(bunWorkspaceRoot);
  if (preInstallSymlink !== null) {
    return refusedPrepare("bun-install-plan-invalid", preInstallSymlink);
  }

  let transaction: LegacyWorktreeReconciliationTransaction | null = null;
  let staged: StagedTaskGenerationPublication | null = null;
  let publishedResult: Extract<
    PrepareManagedWorktreeResult,
    { readonly status: "prepared" }
  > | null = null;
  try {
    const reconciled = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot,
        worktreePath: absolutePath,
        branch,
        baseCommit,
        expectedHead: request.expectedHead,
        transactionId,
        journalDirectory,
      },
      { managerLock: heldAdoptionManagerLock, activityFence },
    );
    if (reconciled.status !== "reconciled") {
      throw new AdoptionRefusal(
        "adoption-reconciliation-failed",
        `${reconciled.reason}: ${reconciled.detail}`,
      );
    }
    transaction = reconciled.transaction;
    await fault("after-adoption-reconciliation", { taskId: request.taskId, transactionId });

    await fs.mkdir(installPlan.bunInstallCacheDir, { recursive: true });
    const installResult = await install(installPlan);
    if (installResult.code !== 0) {
      throw new AdoptionRefusal(
        "bun-install-failed",
        `bun install failed (exit ${installResult.code}): ${installResult.stderr.trim()}`,
      );
    }
    const postInstallSymlink = await assertNoNodeModulesSymlink(bunWorkspaceRoot);
    if (postInstallSymlink !== null) {
      throw new AdoptionRefusal("bun-install-plan-invalid", postInstallSymlink);
    }
    await fault("after-adoption-install", { taskId: request.taskId, transactionId });

    const observationAdapter = createGitLegacyReconciliationObservationAdapter(
      nodeLegacyReconciliationGitRunner,
      activityFence,
    );
    const afterInstall = await assessLegacyReconciliationActivity(
      observationAdapter,
      absolutePath,
      reconciled.evidence.activity.postTransition,
    );
    if (afterInstall.status !== "accepted") {
      throw new AdoptionRefusal("adoption-activity-changed", afterInstall.detail);
    }
    const headCommit = await revParse(git, absolutePath, "HEAD");
    if (headCommit !== reconciled.evidence.candidateHead) {
      throw new AdoptionRefusal(
        "adoption-activity-changed",
        `adopted HEAD changed to ${String(headCommit)}`,
      );
    }

    const worktreeId = idFactory();
    if (!isUuidV7(worktreeId)) {
      throw new AdoptionRefusal("registry-conflict", "idFactory produced a non-UUIDv7 id");
    }
    const handle: ManagedWorktreeHandle = {
      kind: MANAGED_WORKTREE_HANDLE_KIND,
      version: ADOPTED_HANDLE_VERSION,
      token: randomBytes(16).toString("hex"),
      worktreeId,
      taskId: request.taskId,
      branch,
      repositoryRoot,
      absolutePath,
      baseCommit,
      createdAt: now().toISOString(),
      nonce: randomBytes(8).toString("hex"),
    };
    const stored: StoredHandleRecord = {
      handle,
      fingerprint: fingerprintHandle(handle),
      status: "live",
      headAtPrepare: headCommit,
      bunWorkspaceRoot,
    };
    staged = await stageTaskGenerationPublication(regRoot, request.taskId, [stored], fault);
    await fault("after-adoption-stage", {
      taskId: request.taskId,
      transactionId,
      generation: staged.generation,
    });
    const beforePublication = await assessLegacyReconciliationActivity(
      observationAdapter,
      absolutePath,
      reconciled.evidence.activity.postTransition,
    );
    if (beforePublication.status !== "accepted") {
      throw new AdoptionRefusal("adoption-activity-changed", beforePublication.detail);
    }

    const evidence = await buildEvidence(
      handle,
      headCommit,
      bunWorkspaceRoot,
      [bunWorkspaceRoot],
      installPlan.bunInstallCacheDir,
      dependencyResultCommits,
      "adopted",
    );
    publishedResult = { status: "prepared", handle, evidence };
    const publication = await authority.publishTaskAdoption(eligibility.fence, () =>
      staged!.publish(),
    );
    if (publication.status !== "published") {
      throw new AdoptionRefusal(
        "adoption-authority-stale",
        `task adoption publication refused: ${publication.status}`,
      );
    }
    await fault("after-adoption-publication", {
      taskId: request.taskId,
      transactionId,
      generation: staged.generation,
    });
    await fault("before-adoption-commit", { taskId: request.taskId, transactionId });
    const finalized = await recoverLegacyWorktreeReconciliation(
      { ...recoveryRequest, finalizeReconciled: true },
      { managerLock: heldAdoptionManagerLock, activityFence },
    );
    if (finalized.status !== "recovered" || finalized.outcome !== "committed") {
      throw new AdoptionRefusal(
        "adoption-recovery-failed",
        finalized.status === "recovered"
          ? `published adoption finalized as ${finalized.outcome}`
          : `published adoption recovery refused: ${finalized.reason}: ${finalized.detail}`,
      );
    }
    transaction = null;
    return publishedResult;
  } catch (error) {
    if (staged?.published === true) {
      const recovered = await recoverLegacyWorktreeReconciliation(
        { ...recoveryRequest, finalizeReconciled: true },
        { managerLock: heldAdoptionManagerLock, activityFence },
      );
      if (
        recovered.status === "recovered" &&
        recovered.outcome === "committed" &&
        publishedResult !== null
      ) {
        transaction = null;
        return publishedResult;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const recoveryDetail =
        recovered.status === "recovered"
          ? `recovery produced ${recovered.outcome}`
          : `${recovered.reason}: ${recovered.detail}`;
      return refusedPrepare(
        "adoption-recovery-failed",
        `${detail}; published generation remains authoritative; ${recoveryDetail}`,
      );
    }
    const compensation: string[] = [];
    if (staged !== null) {
      try {
        await staged.rollback();
      } catch (caught) {
        compensation.push(
          `registry rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
    if (transaction !== null) {
      try {
        await transaction.rollback();
        await fs.rm(journalPath, { force: true });
      } catch (caught) {
        compensation.push(
          `reconciliation rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (compensation.length > 0) {
      return refusedPrepare("adoption-recovery-failed", `${detail}; ${compensation.join("; ")}`);
    }
    return refusedPrepare(
      error instanceof AdoptionRefusal ? error.reason : "adoption-reconciliation-failed",
      detail,
    );
  }
}

async function prepareManagedWorktreeHandleFreeUnderLock(
  request: PrepareManagedWorktreeRequest,
  deps: ManagedWorktreeDeps,
  ctx: PrepareUnderLockContext,
): Promise<PrepareManagedWorktreeResult> {
  const {
    git,
    dispatchGit,
    allowResumeRequired,
    fault,
    repositoryRoot,
    regRoot,
  } = ctx;

  // Handle-free: inspect live trees for this task (under exclusive lock).
  let live: StoredHandleRecord[];
  try {
    live = await listLiveHandlesForTask(regRoot, request.taskId, fault);
  } catch (error) {
    return refusedPrepare(
      "registry-conflict",
      `managed registry could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (request.adoptWorktreePath !== undefined && request.expectedHead !== undefined) {
    return prepareAdoptedWorktreeUnderLock(
      request as PrepareManagedWorktreeRequest & {
        readonly adoptWorktreePath: string;
        readonly expectedHead: string;
      },
      deps,
      ctx,
      live,
    );
  }
  if (live.length > 1) {
    return refusedPrepare(
      "live-tree-ambiguous",
      `task ${request.taskId} owns ${live.length} live managed worktrees`,
    );
  }
  if (live.length === 1) {
    const only = live[0]!;
    if (allowResumeRequired) {
      const resumed = await resumeFromStored(request, deps, only, repositoryRoot);
      if (resumed.status !== "prepared") return resumed;
      return {
        status: "resume-required",
        handle: resumed.handle,
        reason: "live-tree-exists",
        evidence: resumed.evidence,
      };
    }
    return refusedPrepare(
      "registry-conflict",
      `task ${request.taskId} already owns live managed worktree ${only.handle.absolutePath}`,
    );
  }

  // Fresh prepare requires baseCommit.
  const baseCommit = request.baseCommit;
  if (baseCommit === undefined || !FULL_COMMIT_SHA.test(baseCommit)) {
    return refusedPrepare(
      "base-unresolvable",
      `fresh prepare requires a 40-char baseCommit, got ${String(baseCommit)}`,
    );
  }

  const branch = request.branch ?? defaultBranchForTask(request.taskId);

  // --- Verify base + deps BEFORE any worktree mutation ---
  const baseVerification = await verifyBaseCommit(
    dispatchGit,
    repositoryRoot,
    baseCommit,
    request.integrationHead,
  );
  if (baseVerification.status === "rebase-required") {
    return refusedPrepare(
      "base-rebase-required",
      `base ${baseCommit} has diverged from integration head`,
      { base: baseVerification },
    );
  }
  if (baseVerification.status === "unresolvable") {
    return refusedPrepare(
      "base-unresolvable",
      `base verification failed: ${baseVerification.reason}`,
      { base: baseVerification },
    );
  }

  let dependencyResultCommits: readonly DependencyResultCommit[] = [];
  if (request.dependencyReader !== undefined) {
    const depResolution = await resolveDependencyResultCommitsForDispatch(
      {
        cwd: repositoryRoot,
        rootTaskRef: request.taskId,
        proposedDispatchBase: baseCommit,
      },
      request.dependencyReader,
      dispatchGit,
    );
    if (depResolution.status === "unresolvable") {
      return refusedPrepare(
        "dependency-unresolvable",
        `dependency closure refused: ${depResolution.reason}`,
        { dependency: depResolution },
      );
    }
    dependencyResultCommits = depResolution.dependencyResultCommits;
  }

  const checkedOut = await branchCheckedOutPaths(git, repositoryRoot, branch);
  if (checkedOut.length > 0) {
    return refusedPrepare(
      "branch-checked-out-elsewhere",
      `branch ${branch} is already checked out at ${checkedOut.join(", ")}`,
    );
  }


  return allocateManagedWorktreeUnderLock<ManagedWorktreeHandle>(
    { baseCommit, branch, dependencyResultCommits },
    {
      audit: { taskId: request.taskId },
      createHandle: (fields) => ({ ...fields, version: FRESH_HANDLE_VERSION, taskId: request.taskId }),
      register: async (handle, headCommit, bunWorkspaceRoot) => {
        await writeStoredHandleExclusive(regRoot, {
          handle, fingerprint: fingerprintHandle(handle), status: "live", headAtPrepare: headCommit, bunWorkspaceRoot,
        }, fault);
      },
      emergencyRegister: (handle, headCommit, bunWorkspaceRoot) =>
        emergencyRegisterLiveHandle(regRoot, handle, headCommit, bunWorkspaceRoot),
    },
    deps,
    ctx,
  );
}

type ManagedWorktreeAllocationResult<H> =
  | { readonly status: "prepared"; readonly handle: H; readonly evidence: PreparedWorktreeEvidence }
  | Extract<PrepareManagedWorktreeResult, { readonly status: "refused" }>;

interface ManagedWorktreeAllocationOwner<H extends AnyManagedWorktreeHandle> {
  readonly audit: Readonly<{ taskId: string }> | Readonly<{ cohortId: string; candidateIntentDigest: string }>;
  createHandle(fields: Omit<ConfigManagedWorktreeHandleV1, "version" | "taskId">): H;
  register(handle: H, headCommit: string, bunWorkspaceRoot: string): Promise<void>;
  emergencyRegister(handle: H, headCommit: string, bunWorkspaceRoot: string): Promise<boolean>;
}

class PublishedManagedWorktreeRegistryError extends Error {}

async function allocateManagedWorktreeUnderLock<H extends AnyManagedWorktreeHandle>(
  input: { readonly baseCommit: string; readonly branch: string; readonly dependencyResultCommits: readonly DependencyResultCommit[] },
  owner: ManagedWorktreeAllocationOwner<H>,
  deps: ManagedWorktreeDeps,
  ctx: PrepareUnderLockContext,
): Promise<ManagedWorktreeAllocationResult<H>> {
  const { baseCommit, branch, dependencyResultCommits } = input;
  const { git, install, idFactory, now, fault, repositoryRoot } = ctx;
  // An explicit root is a test/legacy seam. Production closure selection must
  // happen from the clean target worktree, not from a possibly divergent seed.
  const seedBunWorkspaceRoot = deps.bunWorkspaceRoot;
  const seedInstallPlan = buildManagedWorktreeInstallPlan({
    bunWorkspaceRoot: seedBunWorkspaceRoot ?? repositoryRoot,
    ...(deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {}),
  });
  const planValidation = validateManagedWorktreeInstallPlan(
    seedInstallPlan,
    deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {},
  );
  if (planValidation.status === "invalid") {
    return refusedPrepare(
      "bun-install-plan-invalid",
      `${planValidation.reason}: ${planValidation.detail}`,
    );
  }

  await fault("before-worktree-add", {
    repositoryRoot,
    ...owner.audit,
    branch,
    baseCommit,
  });

  // --- Mutation boundary: create worktree ---
  const worktreeId = idFactory();
  if (!isUuidV7(worktreeId)) {
    return refusedPrepare(
      "registry-conflict",
      `idFactory produced a non-UUIDv7 worktree id: ${worktreeId}`,
    );
  }
  const parent = worktreesParent(repositoryRoot);
  await ensureManagedParentSelfIgnored(parent);
  const absolutePath = join(parent, worktreeId);

  const branchExists = await localBranchExists(git, repositoryRoot, branch);
  const createdBranch = !branchExists;
  const addArgs = branchExists
    ? (["worktree", "add", "--quiet", absolutePath, branch] as const)
    : (["worktree", "add", "--quiet", "-b", branch, absolutePath, baseCommit] as const);
  const addResult = await git(repositoryRoot, addArgs);
  if (addResult.code !== 0) {
    // Best-effort cleanup of an empty failed path; never delete if content appeared.
    try {
      await fs.rmdir(absolutePath);
    } catch {
      // leave recoverable residue
    }
    return refusedPrepare(
      "registry-conflict",
      `git worktree add failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
    );
  }

  // From here on, any failure MUST roll back the worktree (and the branch we
  // created) OR leave a live registry handle. Never leave a checked-out branch
  // with live=0.
  const refuseAfterAdd = async (
    reason: PrepareManagedWorktreeRefusalReason,
    detail: string,
    extra: Partial<Extract<PrepareManagedWorktreeResult, { status: "refused" }>> = {},
  ): Promise<ManagedWorktreeAllocationResult<H>> => {
    const rolled = await rollbackFreshWorktree(
      git,
      repositoryRoot,
      absolutePath,
      branch,
      createdBranch,
    ).catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    if (rolled.ok) {
      return refusedPrepare(reason, detail, extra);
    }
    // Rollback failed — try to commit a live handle so release can recover.
    const headForRecovery =
      (await revParse(git, absolutePath, "HEAD")) ??
      (await revParse(git, repositoryRoot, branch)) ??
      baseCommit;
    const managedWorkspace =
      seedBunWorkspaceRoot === undefined
        ? absolutePath
        : (rebaseBunWorkspaceIntoWorktree(repositoryRoot, seedBunWorkspaceRoot, absolutePath) ??
          absolutePath);
    const createdAt = now().toISOString();
    const token = randomBytes(16).toString("hex");
    const nonce = randomBytes(8).toString("hex");
    const recoveryHandle = owner.createHandle({
      kind: MANAGED_WORKTREE_HANDLE_KIND,
      token,
      worktreeId,
      branch,
      repositoryRoot,
      absolutePath,
      baseCommit,
      createdAt,
      nonce,
    });
    const registered = await owner.emergencyRegister(
      recoveryHandle,
      headForRecovery,
      managedWorkspace,
    );
    if (registered) {
      return refusedPrepare(
        reason,
        `${detail}; rollback failed (${rolled.detail}); left live handle ${token} for recovery`,
        extra,
      );
    }
    return refusedPrepare(
      reason,
      `${detail}; rollback failed (${rolled.detail}); emergency registry commit also failed — manual recovery required at ${absolutePath}`,
      extra,
    );
  };

  // If we attached to an existing branch, require base ancestry (no reset).
  if (branchExists) {
    const head = await revParse(git, absolutePath, "HEAD");
    if (head === null) {
      return refuseAfterAdd("worktree-missing", "worktree HEAD missing after add");
    }
    const ancestor = await git(absolutePath, ["merge-base", "--is-ancestor", baseCommit, head]);
    if (ancestor.code !== 0) {
      return refuseAfterAdd(
        "base-unresolvable",
        `existing branch ${branch} at ${head} does not contain base ${baseCommit}; refusing reset`,
      );
    }
  }

  let bunWorkspaceRoots: readonly string[];
  if (seedBunWorkspaceRoot !== undefined) {
    const rebased = rebaseBunWorkspaceIntoWorktree(
      repositoryRoot,
      seedBunWorkspaceRoot,
      absolutePath,
    );
    if (rebased === null) {
      return refuseAfterAdd(
        "bun-workspace-missing",
        `seed workspace ${seedBunWorkspaceRoot} could not be rebased into managed worktree ${absolutePath}`,
      );
    }
    bunWorkspaceRoots = [rebased];
  } else {
    const closure = await resolveManagedGateClosure(
      absolutePath,
      deps.gateClosureManifestPath ?? MANAGED_GATE_CLOSURE_MANIFEST,
    );
    if (closure.status === "invalid") {
      // Generic managed repositories retain their single-workspace contract.
      // A cq-ledgers target is closure-aware and never receives this fallback.
      const cqTarget = join(absolutePath, "nix", "pkg", "cq-ledgers", "package.json");
      if (closure.reason === "manifest-missing" && !existsSync(cqTarget)) {
        const discovered = await discoverBunWorkspaceRoot(absolutePath);
        if (discovered !== null) {
          bunWorkspaceRoots = [discovered];
        } else {
          return refuseAfterAdd(
            "bun-workspace-missing",
            `no Bun workspace (bun.lock) discovered under managed target ${absolutePath}`,
          );
        }
      } else {
        return refuseAfterAdd("gate-closure-invalid", `${closure.reason}: ${closure.detail}`);
      }
    } else {
      bunWorkspaceRoots = closure.installRoots;
    }
  }
  if (bunWorkspaceRoots.length === 0) {
    return refuseAfterAdd("gate-closure-invalid", "resolved gate closure has no install roots");
  }

  const installPlans: ManagedWorktreeInstallPlan[] = [];
  for (const bunWorkspaceRoot of bunWorkspaceRoots) {
    try {
      await fs.access(bunWorkspaceRoot);
    } catch {
      return refuseAfterAdd(
        "bun-workspace-missing",
        `managed worktree workspace missing at ${bunWorkspaceRoot}`,
      );
    }
    const installPlan = buildManagedWorktreeInstallPlan({
      bunWorkspaceRoot,
      ...(deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {}),
    });
    const managedPlanValidation = validateManagedWorktreeInstallPlan(
      installPlan,
      deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {},
    );
    if (managedPlanValidation.status === "invalid") {
      return refuseAfterAdd(
        "bun-install-plan-invalid",
        `${managedPlanValidation.reason}: ${managedPlanValidation.detail}`,
      );
    }
    const preInstallSymlink = await assertNoNodeModulesSymlink(bunWorkspaceRoot);
    if (preInstallSymlink !== null) {
      return refuseAfterAdd("bun-install-plan-invalid", preInstallSymlink);
    }
    installPlans.push(installPlan);
  }

  if (!deps.skipInstall) {
    await fs.mkdir(installPlans[0]!.bunInstallCacheDir, { recursive: true });
    for (const installPlan of installPlans) {
      const installResult = await install(installPlan);
      if (installResult.code !== 0) {
        return refuseAfterAdd(
          "bun-install-failed",
          `bun install failed in ${installPlan.cwd} (exit ${installResult.code}): ${installResult.stderr.trim()}`,
        );
      }
      const symlinkProblem = await assertNoNodeModulesSymlink(installPlan.cwd);
      if (symlinkProblem !== null) {
        return refuseAfterAdd("bun-install-plan-invalid", symlinkProblem);
      }
    }
  }
  const bunWorkspaceRoot = bunWorkspaceRoots[0]!;
  const installPlan = installPlans[0]!;

  const headCommit = await revParse(git, absolutePath, "HEAD");
  if (headCommit === null) {
    return refuseAfterAdd("worktree-missing", "HEAD missing after prepare");
  }

  const createdAt = now().toISOString();
  const token = randomBytes(16).toString("hex");
  const nonce = randomBytes(8).toString("hex");
  const handle = owner.createHandle({
    kind: MANAGED_WORKTREE_HANDLE_KIND,
    token,
    worktreeId,
    branch,
    repositoryRoot,
    absolutePath,
    baseCommit,
    createdAt,
    nonce,
  });

  try {
    await fault("before-registry-commit", {
      token,
      absolutePath,
      ...owner.audit,
    });
  } catch (error) {
    return refuseAfterAdd(
      "registry-conflict",
      `fault before registry commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let registryPublicationWarning: string | null = null;
  try {
    await owner.register(handle, headCommit, bunWorkspaceRoot);
  } catch (error) {
    if (error instanceof PublishedManagedWorktreeRegistryError) {
      registryPublicationWarning = `Registry pointer published; retained worktree after publication fault: ${error.message}`;
    } else {
      return refuseAfterAdd(
        "registry-conflict",
        `failed to commit handle registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const evidence = await buildEvidence(
    handle,
    headCommit,
    bunWorkspaceRoot,
    bunWorkspaceRoots,
    installPlan.bunInstallCacheDir,
    dependencyResultCommits,
    "fresh",
  );
  return { status: "prepared", handle, evidence: registryPublicationWarning === null ? evidence : { ...evidence, registryPublicationWarning } };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

function isTerminalDisposition(value: string): value is ManagedWorktreeTerminalDisposition {
  return value === "done" || value === "abandoned";
}

export type ReleaseManagedCohortWorktreeResult =
  | { readonly status: "released"; readonly handle: ManagedWorktreeHandleV3; readonly idempotent: boolean; readonly absolutePath: string }
  | Extract<ReleaseManagedWorktreeResult, { readonly status: "refused" }>;

export async function releaseCompletedManagedCohortWorktree(input: {
  readonly repositoryRoot: string; readonly ledger: LedgerStore; readonly authority: AuthorizedCohortTerminalReleaseV1;
}, deps: ManagedWorktreeDeps): Promise<ReleaseManagedCohortWorktreeResult> {
  const batch = readAuthorizedCohortTerminalReleaseV1(input.authority);
  const identity = cohortWorktreeIdentityFromEnvelopeV1(batch.envelope);
  const regRoot = registryRoot(input.repositoryRoot, deps.stateDir);
  const subjectKey = `cohort-${identity.candidateIntentDigest}`;
  const fault = deps.faultInjector ?? (async () => undefined);
  const locate = async () => {
    const records = await loadOrReconcileSubjectRecords(regRoot, subjectKey, fault);
    if (records.length !== 1) throw new Error("completed cohort release requires its unique retained manager record");
    const stored = records[0]!;
    if (stored.handle.version !== 3 || validateAnyManagedWorktreeHandle(stored.handle, input.repositoryRoot).status !== "valid" ||
        fingerprintHandle(stored.handle) !== stored.fingerprint || cohortValueDigestV1(stored.handle.cohort) !== cohortValueDigestV1(identity)) {
      throw new Error("completed cohort release differs from its exact manager identity");
    }
    return { stored, handle: stored.handle, records };
  };
  const initial = await locate();
  return withManagedWorktreeEffectLock({ repositoryRoot: input.repositoryRoot, handleToken: initial.handle.token }, deps, () =>
    withManagedMemberPrepareLocks(regRoot, identity.memberAuthorities.map(({ taskRef }) => taskRef.slice("tasks:".length)), deps, async () => {
      const { stored, handle, records } = await locate();
      if (handle.token !== initial.handle.token) throw new Error("completed cohort manager record changed before release");
      const absolutePath = handle.absolutePath;
      const readOnlyGit = deps.git ?? nodeManagedWorktreeGitRunner;
      const binding = mintManagedCohortTerminalReleaseBinding(input.authority, { handleToken: handle.token,
        handleFingerprint: stored.fingerprint, repositoryRoot: input.repositoryRoot, worktreePath: absolutePath, branch: handle.branch });
      const git = createManagedCohortTerminalReleaseGitRunner({ store: input.ledger, binding, envelope: batch.envelope, readOnlyGit });
      const branchTip = await revParse(git, input.repositoryRoot, handle.branch);
      if (branchTip !== null && branchTip !== batch.resultCommit) return refusedRelease("commit-mismatch", "cohort branch no longer names its completed commit", { absolutePath });
      let pathExists: boolean;
      try { pathExists = (await fs.stat(absolutePath)).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; pathExists = false; }
      if (pathExists) {
        if (stored.status === "released") return refusedRelease("ambiguous", "released cohort worktree path reappeared", { absolutePath });
        const coordinates = await resolveManagedGitCoordinates(stored, input.repositoryRoot, false, git);
        if (coordinates === null || coordinates.repositoryId !== batch.envelope.definition.repository.repositoryId) {
          return refusedRelease("handle-mismatch", "cohort worktree no longer resolves to its authenticated Git coordinates", { absolutePath });
        }
        if (await revParse(git, absolutePath, "HEAD") !== batch.resultCommit) return refusedRelease("commit-mismatch", "cohort HEAD differs from its completed commit", { absolutePath });
        const status = await gitPorcelain(git, absolutePath);
        if (status.code !== 0 || status.porcelain.trim() !== "") return refusedRelease("dirty", "cohort worktree has uncommitted changes", { absolutePath });
        const taskIds = identity.memberAuthorities.map(({ taskRef }) => taskRef.slice("tasks:".length));
        const candidateNames = await recoverableWipCandidateNames(git, absolutePath, stored.headAtPrepare, batch.resultCommit, taskIds);
        const ownedNames = new Set(taskIds.map((taskId) => `WIP-${taskId}.md`));
        if ([...candidateNames].some((name) => !ownedNames.has(name))) return refusedRelease("wip-malformed", "cohort candidate changed a foreign WIP artifact", { absolutePath });
        for (const taskId of taskIds) {
          const wip = await findOpenWipCheckpoints(absolutePath, undefined, new Set([`WIP-${taskId}.md`]), taskId);
          if (wip.status === "malformed") return refusedRelease("wip-malformed", `WIP artifact malformed at ${wip.path}: ${wip.detail}`, { absolutePath });
          if (wip.status === "open") return refusedRelease("wip-open", "cohort worktree retains open WIP checkpoints", { absolutePath });
        }
        let cohortRetained: readonly string[];
        try {
          cohortRetained = await wipPathsRetainedInTree(git, absolutePath, batch.resultCommit, taskIds);
        } catch (error) {
          return refusedRelease("ambiguous", error instanceof Error ? error.message : String(error), { absolutePath });
        }
        if (cohortRetained.length > 0) {
          return refusedRelease("wip-retained", `cohort terminal tree still contains ${cohortRetained.join(", ")}`, { absolutePath });
        }
        await fault("before-worktree-remove", { absolutePath, token: handle.token });
        const removed = await git(input.repositoryRoot, ["worktree", "remove", "--force", absolutePath]);
        if (removed.code !== 0) return refusedRelease("ambiguous", `cohort worktree removal failed: ${removed.stderr}`, { absolutePath });
      }
      if (stored.status !== "released") {
        await fault("before-registry-release", { absolutePath, token: handle.token });
        const { retainedCohortAuthority: _authority, ...historical } = stored;
        await publishTaskGeneration(regRoot, subjectKey, records.map((record) => record.handle.token === handle.token
          ? { ...historical, status: "released", releasedAt: (deps.now ?? (() => new Date()))().toISOString() } : record), fault);
      }
      if (branchTip !== null) {
        const parked = await git(input.repositoryRoot, ["update-ref", `${RECOVERY_REF_PREFIX}/${handle.branch}`, batch.resultCommit]);
        if (parked.code !== 0) return refusedRelease("ambiguous", `cohort recovery ref publication failed: ${parked.stderr}`, { absolutePath });
        const deleted = await git(input.repositoryRoot, ["branch", "-D", handle.branch]);
        if (deleted.code !== 0) return refusedRelease("ambiguous", `cohort branch removal failed: ${deleted.stderr}`, { absolutePath });
      }
      return { status: "released", handle, idempotent: stored.status === "released", absolutePath };
    }));
}

/**
 * Guarded release of a managed worktree. Refuses without mutation when the
 * tree is dirty, carries open WIP checkpoints, is non-terminal, or the handle
 * does not revalidate. Eligible clean terminal releases are idempotent.
 */
export async function releaseManagedWorktree(
  request: ReleaseManagedWorktreeRequest,
  deps: ManagedWorktreeDeps = {},
): Promise<ReleaseManagedWorktreeResult> {
  if (!isHandleShape(request.handle)) {
    return refusedRelease("handle-invalid", "handle has invalid shape");
  }
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const repositoryRoot = await resolveRepositoryRoot(git, request.handle.repositoryRoot);
  if (repositoryRoot === null) {
    return refusedRelease("handle-foreign", "handle repositoryRoot is not a git repository");
  }
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.effectLockTimeoutMs === undefined
        ? {}
        : { acquireTimeoutMs: deps.effectLockTimeoutMs }),
    });
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lockfile.acquire(
      join(registryRoot(repositoryRoot, deps.stateDir), PREPARE_LOCKS_DIRNAME),
      `effect-${request.handle.token}`,
    );
  } catch (error) {
    return refusedRelease(
      "effect-lock-busy",
      `could not acquire worktree effect lock: ${error instanceof Error ? error.message : String(error)}`,
      { absolutePath: request.handle.absolutePath },
    );
  }
  try {
    const result = await releaseManagedWorktreeUnderEffectLock(request, deps);
    return result.status === "released" ? recordManagerOwnedReleaseResult(result) : result;
  } finally {
    if (releaseLock !== undefined) await releaseLock();
  }
}

async function releaseManagedWorktreeUnderEffectLock(
  request: ReleaseManagedWorktreeRequest,
  deps: ManagedWorktreeDeps = {},
): Promise<ReleaseManagedWorktreeResult> {
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const now = deps.now ?? (() => new Date());
  const fault = deps.faultInjector ?? (async () => undefined);
  const deleteBranch = request.deleteBranch ?? true;

  if (!isHandleShape(request.handle)) {
    return refusedRelease("handle-invalid", "handle has invalid shape");
  }

  const repositoryRoot = await resolveRepositoryRoot(git, request.handle.repositoryRoot);
  if (repositoryRoot === null) {
    return refusedRelease("handle-foreign", "handle repositoryRoot is not a git repository");
  }

  const integrity = assertHandleIntegrity(request.handle, repositoryRoot);
  if (integrity !== null) {
    return refusedRelease(integrity, `handle failed integrity: ${integrity}`);
  }

  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.prepareLockTimeoutMs !== undefined
        ? { acquireTimeoutMs: deps.prepareLockTimeoutMs }
        : {}),
    });
  let releaseTaskLock: (() => Promise<void>) | undefined;
  try {
    releaseTaskLock = await lockfile.acquire(
      join(regRoot, PREPARE_LOCKS_DIRNAME),
      `prepare-${request.handle.taskId}`,
    );
  } catch (error) {
    return refusedRelease(
      "ambiguous",
      `could not acquire managed registry lock for ${request.handle.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    let stored: StoredHandleRecord | null;
    try {
      stored = await readStoredHandle(regRoot, request.handle.taskId, request.handle.token, fault);
    } catch (error) {
      return refusedRelease(
        "ambiguous",
        `managed registry could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stored === null) {
      return refusedRelease("handle-invalid", "unknown or tampered handle token");
    }
    if (fingerprintHandle(request.handle) !== stored.fingerprint) {
      return refusedRelease(
        "handle-mismatch",
        "presented handle does not match the stored registry fingerprint",
      );
    }
    if (resolve(request.handle.absolutePath) !== resolve(stored.handle.absolutePath)) {
      return refusedRelease("handle-path-traversal", "handle absolutePath does not match registry");
    }

    // Idempotent path: already released cleanly.
    if (stored.status === "released") {
      await new FsCurrentRecoverySealJournalStore(
        currentRecoveryJournalRoot(repositoryRoot, deps.stateDir),
      ).remove(stored.handle.taskId);
      return {
        status: "released",
        handle: stored.handle,
        idempotent: true,
        absolutePath: stored.handle.absolutePath,
      };
    }

    if (!isTerminalDisposition(request.terminalDisposition)) {
      return refusedRelease(
        "not-terminal",
        `terminalDisposition must be done|abandoned, got ${request.terminalDisposition}`,
        { absolutePath: stored.handle.absolutePath },
      );
    }

    const absolutePath = stored.handle.absolutePath;
    let pathExists = true;
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) pathExists = false;
    } catch {
      pathExists = false;
    }

    // Ambiguity: more than one live handle for the same path.
    const live = await listLiveHandlesForTask(regRoot, stored.handle.taskId, fault);
    const samePath = live.filter(
      (entry) => resolve(entry.handle.absolutePath) === resolve(absolutePath),
    );
    if (samePath.length !== 1) {
      return refusedRelease(
        "ambiguous",
        `expected exactly one live handle for path, found ${samePath.length}`,
        { absolutePath },
      );
    }

    // worktree-missing + live registry is completable: the path may already be
    // gone (crash mid-release, manual removal) while the handle is still live.
    // Durable registry release happens first; branch cleanup follows.
    if (!pathExists) {
      if (request.resultCommit !== undefined && request.resultCommit !== null) {
        const branchTip = await revParse(git, repositoryRoot, stored.handle.branch);
        if (branchTip !== null && branchTip !== request.resultCommit) {
          return refusedRelease(
            "commit-mismatch",
            `branch ${stored.handle.branch} tip ${branchTip} does not equal resultCommit ${request.resultCommit}`,
            { absolutePath },
          );
        }
      }

      await fault("before-registry-release", {
        token: stored.handle.token,
        taskId: stored.handle.taskId,
        absolutePath,
        mode: "worktree-missing",
      });

      const releasedMissing: StoredHandleRecord = {
        ...stored,
        status: "released",
        releasedAt: now().toISOString(),
      };
      await updateStoredHandle(regRoot, releasedMissing, fault);

      if (deleteBranch) {
        await deleteBranchAfterRegistryRelease(git, repositoryRoot, stored.handle.branch);
      }

      await new FsCurrentRecoverySealJournalStore(
        currentRecoveryJournalRoot(repositoryRoot, deps.stateDir),
      ).remove(stored.handle.taskId);

      return {
        status: "released",
        handle: stored.handle,
        idempotent: false,
        absolutePath,
      };
    }

    const porcelain = await gitPorcelain(git, absolutePath);
    if (porcelain.code !== 0) {
      return refusedRelease("ambiguous", `git status failed in ${absolutePath}`, { absolutePath });
    }
    if (porcelain.porcelain.trim() !== "") {
      return refusedRelease("dirty", `worktree has uncommitted changes`, { absolutePath });
    }

    const head = await revParse(git, absolutePath, "HEAD");
    if (head === null) {
      return refusedRelease("ambiguous", `cannot resolve HEAD in ${absolutePath}`, {
        absolutePath,
      });
    }
    if (request.resultCommit !== undefined && request.resultCommit !== null) {
      if (request.resultCommit !== head) {
        return refusedRelease(
          "commit-mismatch",
          `HEAD ${head} does not equal resultCommit ${request.resultCommit}`,
          { absolutePath },
        );
      }
    }

    const projection = trustedWipProjectionForRecord(stored, head, request.resultCommit);
    let candidateNames: ReadonlySet<string>;
    try {
      candidateNames = await recoverableWipCandidateNames(
        git,
        absolutePath,
        projection?.integrationBaseCommit ?? stored.headAtPrepare,
        head,
        [stored.handle.taskId],
      );
    } catch (error) {
      return refusedRelease("ambiguous", error instanceof Error ? error.message : String(error), {
        absolutePath,
      });
    }
    const wip = await findOpenWipCheckpoints(
      absolutePath,
      projection,
      candidateNames,
      stored.handle.taskId,
    );
    if (wip.status === "malformed") {
      return refusedRelease(
        "wip-malformed",
        `WIP artifact malformed at ${wip.path}: ${wip.detail}`,
        {
          absolutePath,
        },
      );
    }
    if (wip.status === "open") {
      const openCheckpoints = wip.findings.flatMap((finding) => finding.openCheckpoints);
      return refusedRelease("wip-open", `open WIP checkpoints: ${openCheckpoints.join(", ")}`, {
        absolutePath,
        openCheckpoints,
      });
    }

    // Only a `done` release hands its tip to integration, so only that tip has
    // to be free of the artifact. An abandoned worktree merges nothing, and
    // refusing it here would strand work this guard was never meant to touch.
    if (request.terminalDisposition === "done") {
      let retained: readonly string[];
      try {
        retained = await wipPathsRetainedInTree(git, absolutePath, head, [stored.handle.taskId]);
      } catch (error) {
        return refusedRelease("ambiguous", error instanceof Error ? error.message : String(error), {
          absolutePath,
        });
      }
      if (retained.length > 0) {
        return refusedRelease(
          "wip-retained",
          `terminal tree still contains ${retained.join(", ")}; delete the artifact and commit that deletion before release`,
          { absolutePath },
        );
      }
    }

    await fault("before-worktree-remove", {
      absolutePath,
      token: stored.handle.token,
      taskId: stored.handle.taskId,
    });

    const remove = await git(repositoryRoot, ["worktree", "remove", "--force", absolutePath]);
    if (remove.code !== 0) {
      // Do not delete recoverable work on failure.
      return refusedRelease(
        "ambiguous",
        `git worktree remove failed: ${remove.stderr.trim() || remove.stdout.trim()}`,
        { absolutePath },
      );
    }

    // Durable registry release BEFORE branch -D. A fault at this boundary must
    // leave the precious commit reachable via the still-live branch tip.
    await fault("before-registry-release", {
      token: stored.handle.token,
      taskId: stored.handle.taskId,
      absolutePath,
      head,
    });

    const released: StoredHandleRecord = {
      ...stored,
      status: "released",
      releasedAt: now().toISOString(),
    };
    await updateStoredHandle(regRoot, released, fault);

    if (deleteBranch) {
      await deleteBranchAfterRegistryRelease(git, repositoryRoot, stored.handle.branch);
    }

    await new FsCurrentRecoverySealJournalStore(
      currentRecoveryJournalRoot(repositoryRoot, deps.stateDir),
    ).remove(stored.handle.taskId);

    await fault("before-directory-delete", { absolutePath });
    // git worktree remove already deleted the directory; residual cleanup only.
    try {
      await fs.rm(absolutePath, { recursive: true, force: true });
    } catch {
      // ignore — path may already be gone
    }

    return {
      status: "released",
      handle: stored.handle,
      idempotent: false,
      absolutePath,
    };
  } finally {
    if (releaseTaskLock !== undefined) {
      await releaseTaskLock();
    }
  }
}

/**
 * Delete the task branch only after the registry row is durably released.
 * If `-D` would lose the tip before recovery is possible, first park it under
 * a recovery ref (best-effort).
 */
async function deleteBranchAfterRegistryRelease(
  git: ManagedWorktreeGitRunner,
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  const tip = await revParse(git, repositoryRoot, branch);
  if (tip !== null) {
    // Park the tip so a subsequent failure still has a recoverable ref.
    await git(repositoryRoot, ["update-ref", `${RECOVERY_REF_PREFIX}/${branch}`, tip]);
  }
  await git(repositoryRoot, ["branch", "-D", branch]);
}

/** Test helper: read registry live count for a task. */
export async function listManagedLiveWorktrees(
  repositoryRoot: string,
  taskId: string,
  stateDir?: string,
): Promise<readonly ManagedWorktreeHandle[]> {
  const git = nodeManagedWorktreeGitRunner;
  const root = (await resolveRepositoryRoot(git, repositoryRoot)) ?? resolve(repositoryRoot);
  const regRoot = registryRoot(root, stateDir);
  await fs.mkdir(regRoot, { recursive: true });
  const lockfile = new Lockfile();
  const releaseTaskLock = await lockfile.acquire(
    join(regRoot, PREPARE_LOCKS_DIRNAME),
    `prepare-${taskId}`,
  );
  try {
    const live = await listLiveHandlesForTask(regRoot, taskId, async () => undefined);
    return live.map((entry) => entry.handle);
  } finally {
    await releaseTaskLock();
  }
}

type TrustedWipClosureProjection = WipClosureProjection & {
  readonly integrationBaseCommit?: string;
};

function trustedWipProjectionForRecord(
  stored: StoredHandleRecord,
  head: string,
  requestedResultCommit: string | null | undefined,
): TrustedWipClosureProjection | undefined {
  const projection = stored.trustedGateProjection;
  if (
    projection === undefined ||
    requestedResultCommit !== head ||
    projection.resultCommit !== head ||
    projection.taskId !== stored.handle.taskId ||
    projection.handleToken !== stored.handle.token ||
    projection.handleFingerprint !== stored.fingerprint ||
    projection.repositoryRoot !== stored.handle.repositoryRoot ||
    projection.worktreePath !== stored.handle.absolutePath ||
    projection.branch !== stored.handle.branch ||
    projection.gateExitCode !== 0 ||
    projection.failCount !== 0 ||
    projection.passCount <= 0
  ) {
    return undefined;
  }
  return {
    taskId: projection.taskId,
    ...(projection.integrationBaseCommit === undefined
      ? {}
      : { integrationBaseCommit: projection.integrationBaseCommit }),
  };
}

/** Persist a runner-minted exact-tip projection outside the Git worktree. */
export async function recordManagedWorktreeSupervisedGateEvidence(
  binding: ManagedWorktreeDispatchBinding & {
    readonly guardedRebaseBridge?: DispatchGuardedRebaseBridge;
  },
  evidence: ImplementTaskWorkerSupervisedGateEvidence,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir" | "prepareLockTimeoutMs"> = {},
): Promise<void> {
  await assertManagedWorktreeDispatchBindingLive(binding, deps);
  if (
    evidence.kind !== "cq-supervised-gate-evidence" ||
    evidence.version !== 1 ||
    evidence.taskId !== binding.taskId ||
    resolve(evidence.worktreePath) !== binding.worktreePath ||
    evidence.branch !== binding.branch ||
    evidence.gateExitCode !== 0 ||
    evidence.failCount !== 0 ||
    evidence.passCount <= 0
  ) {
    throw new Error("supervised gate evidence does not match the managed worktree binding");
  }
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const head = await revParse(git, binding.worktreePath, "HEAD");
  if (head === null || head !== evidence.resultCommit) {
    throw new Error("supervised gate evidence is stale for the managed worktree tip");
  }
  const integrationHead = await revParse(git, binding.repositoryRoot, "HEAD");
  if (integrationHead === null) {
    throw new Error("supervised gate evidence cannot resolve the integration tip");
  }
  const integrationBaseCommit = binding.guardedRebaseBridge?.ontoCommit ?? integrationHead;
  if (binding.guardedRebaseBridge !== undefined) {
    const currentIntegrationAncestry = await git(binding.repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      integrationBaseCommit,
      integrationHead,
    ]);
    if (currentIntegrationAncestry.code !== 0) {
      throw new Error(
        "supervised gate integration tip does not contain the authenticated guarded-rebase base",
      );
    }
  }
  const integrationAncestry = await git(binding.repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    integrationBaseCommit,
    evidence.resultCommit,
  ]);
  if (integrationAncestry.code !== 0) {
    throw new Error("supervised gate result does not contain the authenticated integration tip");
  }

  const regRoot = registryRoot(binding.repositoryRoot, deps.stateDir);
  const lockfile = new Lockfile({
    ...(deps.prepareLockTimeoutMs === undefined
      ? {}
      : { acquireTimeoutMs: deps.prepareLockTimeoutMs }),
  });
  const releaseTaskLock = await lockfile.acquire(
    join(regRoot, PREPARE_LOCKS_DIRNAME),
    `prepare-${binding.taskId}`,
  );
  try {
    const stored = await readStoredHandle(
      regRoot,
      binding.taskId,
      binding.handleToken,
      async () => undefined,
    );
    if (
      stored === null ||
      stored.status !== "live" ||
      stored.fingerprint !== binding.handleFingerprint ||
      stored.handle.absolutePath !== binding.worktreePath ||
      stored.handle.branch !== binding.branch
    ) {
      throw new Error("managed worktree registry changed before gate projection publication");
    }
    const trustedGateProjection: ManagedWorktreeTrustedGateProjection = Object.freeze({
      kind: "cq-managed-trusted-gate-projection",
      version: 1,
      attestationId: evidence.attestationId,
      generation: evidence.generation,
      taskId: binding.taskId,
      handleToken: binding.handleToken,
      handleFingerprint: binding.handleFingerprint,
      repositoryRoot: binding.repositoryRoot,
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      resultCommit: evidence.resultCommit,
      integrationBaseCommit,
      gateExitCode: 0,
      passCount: evidence.passCount,
      failCount: 0,
      capturedAt: evidence.capturedAt,
    });
    await updateStoredHandle(regRoot, { ...stored, trustedGateProjection }, async () => undefined);
  } finally {
    await releaseTaskLock();
  }
}

/** Fail closed unless the exact candidate tip's WIP table is virtually complete. */
export async function assertManagedWorktreeWipClosure(
  binding: ManagedWorktreeDispatchBinding,
  resultCommit: string,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir"> = {},
): Promise<void> {
  await assertManagedWorktreeDispatchBindingLive(binding, deps);
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const head = await revParse(git, binding.worktreePath, "HEAD");
  if (head === null || head !== resultCommit) {
    throw new Error("managed WIP closure requires the immutable candidate tip");
  }
  const regRoot = registryRoot(binding.repositoryRoot, deps.stateDir);
  const lockfile = new Lockfile();
  const releaseTaskLock = await lockfile.acquire(
    join(regRoot, PREPARE_LOCKS_DIRNAME),
    `prepare-${binding.taskId}`,
  );
  let stored: StoredHandleRecord | null;
  try {
    stored = await readStoredHandle(
      regRoot,
      binding.taskId,
      binding.handleToken,
      async () => undefined,
    );
  } finally {
    await releaseTaskLock();
  }
  if (stored === null || stored.fingerprint !== binding.handleFingerprint) {
    throw new Error("managed WIP closure registry binding changed");
  }
  const projection = trustedWipProjectionForRecord(stored, head, resultCommit);
  const candidateNames = await recoverableWipCandidateNames(
    git,
    binding.worktreePath,
    projection?.integrationBaseCommit ?? stored.headAtPrepare,
    resultCommit,
    [binding.taskId],
  );
  const assessment = await findOpenWipCheckpoints(
    binding.worktreePath,
    projection,
    candidateNames,
    binding.taskId,
  );
  if (assessment.status === "malformed") {
    throw new Error(
      `managed WIP closure denied malformed artifact ${assessment.path}: ${assessment.detail}`,
    );
  }
  if (assessment.status === "open") {
    throw new Error(
      `managed WIP closure denied open checkpoints: ${assessment.findings
        .flatMap((finding) => finding.openCheckpoints)
        .join(", ")}`,
    );
  }
}

/**
 * Resolve the presented handle against the authoritative manager registry.
 * Every caller-visible coordinate participates in the stored fingerprint;
 * exact repository/task/token/path/branch equality is also checked directly.
 */
export async function resolveManagedWorktreeTerminalReleaseRegistryBinding(
  repositoryCandidate: string,
  handle: ManagedWorktreeHandle,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir" | "lockfile" | "prepareLockTimeoutMs"> = {},
): Promise<ManagedWorktreeTerminalReleaseRegistryBinding | null> {
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const repositoryRoot = await resolveRepositoryRoot(git, repositoryCandidate);
  if (repositoryRoot === null || handle.repositoryRoot !== repositoryRoot) return null;
  if (assertHandleIntegrity(handle, repositoryRoot) !== null) return null;
  if (handle.branch !== defaultBranchForTask(handle.taskId)) return null;

  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.prepareLockTimeoutMs === undefined
        ? {}
        : { acquireTimeoutMs: deps.prepareLockTimeoutMs }),
    });
  let releaseTaskLock: (() => Promise<void>) | undefined;
  try {
    releaseTaskLock = await lockfile.acquire(
      join(regRoot, PREPARE_LOCKS_DIRNAME),
      `prepare-${handle.taskId}`,
    );
    const stored = await readStoredHandle(
      regRoot,
      handle.taskId,
      handle.token,
      async () => undefined,
    );
    if (stored === null) return null;
    if (fingerprintHandle(handle) !== stored.fingerprint) return null;
    if (
      stored.handle.taskId !== handle.taskId ||
      stored.handle.token !== handle.token ||
      stored.handle.repositoryRoot !== repositoryRoot ||
      stored.handle.absolutePath !== handle.absolutePath ||
      stored.handle.branch !== handle.branch
    ) {
      return null;
    }
    return Object.freeze({
      registryStatus: stored.status,
      taskId: stored.handle.taskId,
      handleToken: stored.handle.token,
      handleFingerprint: stored.fingerprint,
      repositoryRoot,
      worktreePath: stored.handle.absolutePath,
      branch: stored.handle.branch,
    });
  } catch {
    return null;
  } finally {
    if (releaseTaskLock !== undefined) await releaseTaskLock();
  }
}

export interface ResolveManagedWorktreeDispatchBindingRequest {
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** Admit the detached HEAD only when an active rebase names the bound task ref. */
  readonly allowDetachedRebase?: boolean;
}

/** Resolve the manager registry identity without consulting mutable Git state. */
export async function resolveManagedWorktreeLineageBinding(
  request: ResolveManagedWorktreeDispatchBindingRequest,
  deps: Pick<ManagedWorktreeDeps, "stateDir" | "lockfile" | "prepareLockTimeoutMs"> = {},
): Promise<ManagedWorktreeLineageBinding | null> {
  const repositoryRoot = resolve(request.repositoryRoot);
  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.prepareLockTimeoutMs === undefined
        ? {}
        : { acquireTimeoutMs: deps.prepareLockTimeoutMs }),
    });
  const releaseTaskLock = await lockfile.acquire(
    join(regRoot, PREPARE_LOCKS_DIRNAME),
    `prepare-${request.taskId}`,
  );
  let live: StoredHandleRecord[];
  try {
    live = await listLiveHandlesForTask(regRoot, request.taskId, async () => undefined);
  } finally {
    await releaseTaskLock();
  }
  const matches = live.filter(
    ({ handle }) =>
      resolve(handle.repositoryRoot) === repositoryRoot &&
      resolve(handle.absolutePath) === resolve(request.worktreePath) &&
      handle.branch === request.branch,
  );
  if (matches.length !== 1) return null;
  const stored = matches[0]!;
  return Object.freeze({
    taskId: stored.handle.taskId,
    handleToken: stored.handle.token,
    handleFingerprint: stored.fingerprint,
    repositoryRoot,
    worktreePath: resolve(stored.handle.absolutePath),
    branch: stored.handle.branch,
  });
}

/** Resolve one live manager record without exposing its resolved task Git directory. */
export async function resolveManagedWorktreeDispatchBinding(
  request: ResolveManagedWorktreeDispatchBindingRequest,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir"> = {},
): Promise<ManagedWorktreeDispatchBinding | null> {
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const repositoryRoot = await resolveRepositoryRoot(git, request.repositoryRoot);
  if (repositoryRoot === null) return null;
  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });
  const lockfile = new Lockfile();
  const releaseTaskLock = await lockfile.acquire(
    join(regRoot, PREPARE_LOCKS_DIRNAME),
    `prepare-${request.taskId}`,
  );
  let live: StoredHandleRecord[];
  try {
    live = await listLiveHandlesForTask(regRoot, request.taskId, async () => undefined);
  } finally {
    await releaseTaskLock();
  }
  const matches = live.filter(
    ({ handle }) =>
      resolve(handle.absolutePath) === resolve(request.worktreePath) &&
      handle.branch === request.branch,
  );
  if (matches.length !== 1) return null;
  const stored = matches[0]!;
  const coordinates = await resolveManagedGitCoordinates(stored, repositoryRoot, request.allowDetachedRebase === true, git);
  return coordinates === null ? null : Object.freeze({ ...coordinates, taskId: stored.handle.taskId });
}

async function resolveManagedGitCoordinates(
  stored: StoredHandleRecord<AnyManagedWorktreeHandle>,
  repositoryRoot: string,
  allowDetachedRebase: boolean,
  git: ManagedWorktreeGitRunner,
): Promise<Omit<ManagedWorktreeDispatchBinding, "taskId"> | null> {
  const top = await resolveRepositoryRoot(git, stored.handle.absolutePath);
  if (top === null || top !== resolve(stored.handle.absolutePath)) return null;
  const commonResult = await git(stored.handle.absolutePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonResult.code !== 0 || commonResult.stdout.trim() === "") return null;
  const commonDir = resolve(commonResult.stdout.trim());
  let canonicalCommon: string;
  let canonicalRepository: string;
  try {
    canonicalCommon = await fs.realpath(commonDir);
    canonicalRepository = await fs.realpath(repositoryRoot);
  } catch {
    return null;
  }
  const symbolic = await git(stored.handle.absolutePath, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = `refs/heads/${stored.handle.branch}`;
  if (symbolic.code !== 0 || symbolic.stdout.trim() !== ref) {
    if (!allowDetachedRebase) return null;
    const gitDirResult = await git(stored.handle.absolutePath, [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
    ]);
    if (gitDirResult.code !== 0 || gitDirResult.stdout.trim() === "") return null;
    try {
      const headName = (
        await fs.readFile(
          join(resolve(gitDirResult.stdout.trim()), "rebase-merge", "head-name"),
          "utf8",
        )
      ).trim();
      if (headName !== ref) return null;
    } catch {
      return null;
    }
  }
  return Object.freeze({
    handleToken: stored.handle.token,
    handleFingerprint: stored.fingerprint,
    repositoryRoot: canonicalRepository,
    repositoryId: createHash("sha256")
      .update(`${canonicalRepository}\n${canonicalCommon}`)
      .digest("hex"),
    commonDir: canonicalCommon,
    worktreePath: resolve(stored.handle.absolutePath),
    branch: stored.handle.branch,
    ref,
    baseCommit: stored.handle.baseCommit,
  });
}

export async function resolveManagedCohortWorktreeDispatchBinding(
  handle: ManagedWorktreeHandleV3,
  authority: ManagedCohortWorktreeAuthority,
  deps: ManagedWorktreeDeps,
  allowDetachedRebase: boolean,
): Promise<ManagedCohortWorktreeDispatchBinding | null> {
  await authority.store.assertLiveCohortAuthority(authority.lease, authority.envelope);
  const validated = validateAnyManagedWorktreeHandle(handle);
  if (validated.status !== "valid" || validated.handle.version !== 3) return null;
  const identity = cohortWorktreeIdentityFromEnvelopeV1(authority.envelope);
  if (cohortValueDigestV1(handle.cohort) !== cohortValueDigestV1(identity)) return null;
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const repositoryRoot = await resolveRepositoryRoot(git, handle.repositoryRoot);
  if (repositoryRoot === null || repositoryRoot !== handle.repositoryRoot) return null;
  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  return withManagedMemberPrepareLocks(regRoot, identity.memberAuthorities.map((member) => member.taskRef.slice("tasks:".length)), deps, async () => {
    await authority.store.assertLiveCohortAuthority(authority.lease, authority.envelope);
    const records = await loadOrReconcileSubjectRecords(regRoot, registrySubjectKey(handle), async () => undefined);
    const stored = records.find((record) => record.status === "live" && record.handle.token === handle.token);
    if (stored === undefined || fingerprintHandle(handle) !== stored.fingerprint || stored.handle.version !== 3) return null;
    const coordinates = await resolveManagedGitCoordinates(stored, repositoryRoot, allowDetachedRebase, git);
    if (coordinates === null || coordinates.repositoryId !== authority.envelope.definition.repository.repositoryId ||
        (coordinates.baseCommit !== authority.envelope.definition.repository.headCommit &&
         coordinates.baseCommit !== stored.cohortRebasePredecessor?.bridge.ontoCommit)) return null;
    await authority.store.assertLiveCohortAuthority(authority.lease, authority.envelope);
    return Object.freeze({ ...coordinates, cohort: authority.envelope });
  });
}

export async function resolveRetainedManagedCohortAuthority(
  repositoryRoot: string,
  store: WorkCohortStore,
  envelope: CohortEffectEnvelopeV1,
  deps: ManagedWorktreeDeps,
  allowDetachedRebase: boolean,
): Promise<{ readonly authority: ManagedCohortWorktreeAuthority;
  readonly binding: ManagedCohortWorktreeDispatchBinding; readonly handle: ManagedWorktreeHandleV3 }> {
  assertCohortEffectEnvelopeV1(envelope);
  const records = await readCurrentTaskGeneration(registryRoot(repositoryRoot, deps.stateDir), `cohort-${envelope.intent.intentDigest}`);
  const live = (records ?? []).filter((record) => record.status === "live");
  if (live.length !== 1 || live[0]!.handle.version !== 3 || live[0]!.retainedCohortAuthority === undefined) {
    throw new Error("cohort authority retention is unavailable; explicit resume is required");
  }
  const stored = live[0]!;
  const handle = stored.handle;
  if (handle.version !== 3) throw new Error("cohort authority resolved a task worktree");
  const retained = stored.retainedCohortAuthority!;
  if (cohortValueDigestV1(retained.envelope) !== cohortValueDigestV1(envelope)) {
    throw new Error("cohort dispatch differs from the exact retained authority; explicit resume is required");
  }
  const authority = { store, lease: structuredClone(retained.lease), envelope: structuredClone(retained.envelope) };
  await store.assertLiveCohortAuthority(authority.lease, authority.envelope);
  const binding = await resolveManagedCohortWorktreeDispatchBinding(handle, authority, deps, allowDetachedRebase);
  if (binding === null || handle.repositoryRoot !== repositoryRoot || binding.handleFingerprint !== stored.fingerprint) {
    throw new Error("retained cohort authority no longer resolves to its actual managed worktree");
  }
  return { authority, binding, handle };
}

export async function readRetainedManagedCohortHandle(repositoryRoot: string, intentDigest: string,
  deps: ManagedWorktreeDeps): Promise<ManagedWorktreeHandleV3 | null> {
  if (!/^[0-9a-f]{64}$/u.test(intentDigest)) throw new Error("cohort handle lookup requires an exact intent digest");
  const records = await readCurrentTaskGeneration(registryRoot(repositoryRoot, deps.stateDir), `cohort-${intentDigest}`);
  const live = (records ?? []).filter((record) => record.status === "live");
  if (live.length === 0) return null;
  if (live.length !== 1 || live[0]!.handle.version !== 3 || live[0]!.fingerprint !== fingerprintHandle(live[0]!.handle)) {
    throw new Error("cohort handle lookup does not resolve one authentic live registry record");
  }
  return structuredClone(live[0]!.handle as ManagedWorktreeHandleV3);
}

export async function readManagedCohortRebaseSuccessor(prior: DispatchCohortGitEffectBinding,
  deps: ManagedWorktreeDeps): Promise<NonNullable<StoredHandleRecord["cohortRebaseSuccessor"]> | null> {
  const records = await readCurrentTaskGeneration(registryRoot(prior.repositoryRoot, deps.stateDir), `cohort-${prior.cohort.intent.intentDigest}`);
  const stored = (records ?? []).find((record) => record.handle.token === prior.handleToken && record.fingerprint === prior.handleFingerprint);
  return stored?.cohortRebaseSuccessor === undefined ? null : structuredClone(stored.cohortRebaseSuccessor);
}

export interface ManagedCohortRebaseSuccessorRequest {
  readonly source: DispatchHandle; readonly prior: DispatchCohortGitEffectBinding; readonly guardedRebase: string;
  readonly ontoCommit: string; readonly priorResultCommit: string;
}

export function prepareManagedCohortRebaseSuccessor(input: ManagedCohortRebaseSuccessorRequest,
  store: WorkCohortStore, ledger: LedgerStore, deps: ManagedWorktreeDeps) {
  return prepareManagedCohortRebaseSuccessorWithResume(input, store, ledger, deps, null);
}

export function resumeManagedCohortRebaseSuccessor(input: ManagedCohortRebaseSuccessorRequest, holderId: string,
  store: WorkCohortStore, ledger: LedgerStore, deps: ManagedWorktreeDeps) {
  if (holderId.trim() === "") throw new Error("cohort transfer resume requires an explicit holder");
  return prepareManagedCohortRebaseSuccessorWithResume(input, store, ledger, deps, holderId);
}

async function prepareManagedCohortRebaseSuccessorWithResume(input: ManagedCohortRebaseSuccessorRequest,
  store: WorkCohortStore, ledger: LedgerStore, deps: ManagedWorktreeDeps, resumeHolder: string | null) {
  if (ledger.worksetStore === undefined) throw new Error("cohort successor requires an all-member workset store");
  const workset = ledger.worksetStore();
  const prior = input.prior;
  const regRoot = registryRoot(prior.repositoryRoot, deps.stateDir);
  const sourceKey = `cohort-${prior.cohort.intent.intentDigest}`;
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
  const fault = deps.faultInjector ?? (async () => undefined);
  return withManagedCohortAuthorityWriterLock(prior.repositoryRoot, deps, () =>
    withManagedWorktreeEffectLock(prior, deps, async () => {
      let records = await readCurrentTaskGeneration(regRoot, sourceKey);
      let stored = records?.find((record) => record.handle.token === prior.handleToken && record.fingerprint === prior.handleFingerprint);
      if (stored === undefined || stored.handle.version !== 3 || stored.retainedCohortAuthority === undefined) throw new Error("cohort rebase source registry is unavailable");
      let sourceAuthority = { store, ...stored.retainedCohortAuthority };
      let successor = stored.cohortRebaseSuccessor;
      if (resumeHolder !== null && successor === undefined) throw new Error("cohort transfer resume requires an existing private transition");
      if (successor === undefined) {
        const sourceBinding = { ...cohortRebaseManagerBinding(prior), cohort: sourceAuthority.envelope };
        const bridge = await materializeGuardedRebaseBridge({ reference: input.guardedRebase, prior: { ...prior, ...input.source },
          current: sourceBinding, cohortAuthority: sourceAuthority,
          baseCommitInput: input.ontoCommit,
          startingCommitInput: (await git(prior.worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          priorResultCommitInput: input.priorResultCommit,
          ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
        });
        if (bridge.version !== 2 || sourceAuthority.envelope.state !== "sealed") throw new Error("cohort successor requires a finalized sealed source");
        const state = (await store.snapshot()).portable;
        const definition = sourceAuthority.envelope.definition;
        const intent = createCohortCandidateIntentV1(definition, `guarded-successor:${input.source.attestationId}:${input.source.generation}:${bridge.requestDigest}`);
        const envelope = createCohortEffectEnvelopeV1({ definition, intent,
          observation: resolveCohortDefinitionObservationV1({ definition, observations: state.observations, decisions: state.decisions }),
          evidenceSubject: null, executionEpoch: sourceAuthority.envelope.executionEpoch });
        const handle: ManagedWorktreeHandleV3 = { ...stored.handle, token: randomBytes(24).toString("hex"), nonce: randomBytes(16).toString("hex"),
          branch: `implement/cohort-${intent.intentDigest}`, baseCommit: bridge.ontoCommit,
          createdAt: new Date().toISOString(), cohort: cohortWorktreeIdentityFromEnvelopeV1(envelope) };
        const successorBinding = { ...cohortRebaseManagerBinding(prior), cohort: envelope, handleToken: handle.token,
          handleFingerprint: fingerprintHandle(handle), branch: handle.branch, ref: `refs/heads/${handle.branch}`, baseCommit: handle.baseCommit };
        const unsigned = { kind: "cq-cohort-rebase-transition" as const, version: 1 as const, source: input.source,
          sourceBinding: cohortRebaseManagerBinding(prior), successorBinding, guardedRebaseBridgeDigest: cohortValueDigestV1(bridge) };
        successor = { proof: { ...unsigned, transitionDigest: cohortValueDigestV1(unsigned) }, bridge, handle };
        const retainedSuccessor = successor;
        await withManagedMemberPrepareLocks(regRoot, definition.members.map((member) => member.memberRef.slice("tasks:".length)), deps, async () => {
          records = await readCurrentTaskGeneration(regRoot, sourceKey);
          if (records === null) throw new Error("cohort source disappeared before transition intent");
          const next = records.map((record) => record.handle.token === prior.handleToken ? { ...record, cohortRebaseSuccessor: retainedSuccessor } : record);
          const staged = await stageTaskGenerationPublication(regRoot, sourceKey, next, fault);
          await store.publishLiveCohortEffect(sourceAuthority.lease, sourceAuthority.envelope, () => {
            deps.validateCohortPublication?.(sourceAuthority.envelope); return staged.publish();
          });
          stored = next.find((record) => record.handle.token === prior.handleToken)!;
        });
      }
      const { proof, bridge, handle } = successor;
      if (input.guardedRebase !== bridge.guardedRebase || input.ontoCommit !== bridge.ontoCommit || input.priorResultCommit !== bridge.oldResultCommit || !cohortRebaseTransitionMatches(prior,
        { ...proof.successorBinding, guardedRebaseBridge: bridge, cohortRebaseTransition: proof }, input.source)) {
        throw new Error("cohort successor request differs from its durable transition intent");
      }
      await verifyHistoricalCohortGuardedRebaseBridge(bridge, deps.stateDir);
      const completed = await readCurrentTaskGeneration(regRoot, registrySubjectKey(handle));
      const completedRecord = completed?.find((record) => record.status === "live" && record.fingerprint === proof.successorBinding.handleFingerprint);
      if (completedRecord?.retainedCohortAuthority !== undefined && stored.status === "released" &&
          (await store.snapshot()).runtime.lease?.semanticSubject === completedRecord.retainedCohortAuthority.envelope.semanticSubject) {
        const resolved = await resolveRetainedManagedCohortAuthority(prior.repositoryRoot, store,
          completedRecord.retainedCohortAuthority.envelope, deps, false);
        return { ...resolved, bridge, proof };
      }
      const symbol = await git(prior.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
      const head = await revParse(git, prior.worktreePath, "HEAD");
      const status = await git(prior.worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
      if (head !== bridge.rebasedStartCommit || status.code !== 0 || status.stdout.trim() !== "") throw new Error("cohort successor transition lost its exact clean rebased tip");
      if (symbol.stdout.trim() !== prior.ref && symbol.stdout.trim() !== proof.successorBinding.ref) throw new Error("cohort successor branch was substituted");
      const snapshot = await store.snapshot();
      if (resumeHolder !== null && sourceAuthority.envelope.executionEpoch !== snapshot.runtime.executionEpoch) {
        if (sourceAuthority.envelope.state !== "sealed") throw new Error("cohort transfer resume lacks a sealed source");
        const oldEnvelope = sourceAuthority.envelope;
        const envelope = createCohortEffectEnvelopeV1({ definition: oldEnvelope.definition, intent: oldEnvelope.intent,
          observation: resolveCohortDefinitionObservationV1({ definition: oldEnvelope.definition,
            observations: snapshot.portable.observations, decisions: snapshot.portable.decisions }),
          evidenceSubject: oldEnvelope.evidenceSubject, executionEpoch: snapshot.runtime.executionEpoch });
        const recoveryDirectory = join(regRoot, "cohort-transfer-recovery");
        await fs.mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
        const recoveryPath = join(recoveryDirectory, `${cohortValueDigestV1({ transition: proof.transitionDigest, epoch: envelope.executionEpoch })}.json`);
        let lease: WorkCohortLeaseV1;
        if (snapshot.runtime.lease !== null) {
          const recovery = JSON.parse(await fs.readFile(recoveryPath, "utf8")) as {
            readonly transitionDigest: string; readonly envelope: CohortEffectEnvelopeV1; readonly lease: WorkCohortLeaseV1 };
          if (Object.keys(recovery).sort().join(",") !== "envelope,lease,transitionDigest" || recovery.transitionDigest !== proof.transitionDigest ||
              cohortValueDigestV1(recovery.envelope) !== cohortValueDigestV1(envelope)) throw new Error("cohort transfer recovery authority was substituted");
          lease = recovery.lease;
        } else {
          const receiptBridge = snapshot.portable.receiptBridges.find((entry) => entry.sealDigest === oldEnvelope.evidenceSubject.sealDigest);
          if (receiptBridge === undefined) throw new Error("cohort transfer resume lost its exact source receipt bridge");
          await store.revalidateForResume({ definitionDigest: oldEnvelope.definition.definitionDigest,
            sealDigest: oldEnvelope.evidenceSubject.sealDigest, evidenceSubjectDigest: oldEnvelope.evidenceSubject.evidenceSubjectDigest,
            acceptanceMatrixDigest: oldEnvelope.definition.acceptanceMatrixDigest,
            environmentDigest: oldEnvelope.definition.environment.environmentDigest, receiptBridgeDigest: receiptBridge.bridgeDigest });
          lease = await store.acquireLeaseAndPublish({ holderId: resumeHolder, semanticSubject: envelope.semanticSubject }, (renewed) => {
            deps.validateCohortPublication?.(envelope);
            const stagedPath = `${recoveryPath}.${randomBytes(12).toString("hex")}.tmp`;
            const descriptor = openSync(stagedPath, "wx", 0o600);
            try { writeFileSync(descriptor, JSON.stringify({ transitionDigest: proof.transitionDigest, envelope, lease: renewed })); fsyncSync(descriptor); }
            finally { closeSync(descriptor); }
            renameSync(stagedPath, recoveryPath); syncDirectoryNow(recoveryDirectory); syncDirectoryNow(regRoot);
            return undefined;
          });
        }
        await store.assertLiveCohortAuthority(lease, envelope);
        sourceAuthority = { store, lease, envelope };
      }
      const plannedEnvelope = proof.successorBinding.cohort;
      const nextEnvelope = createCohortEffectEnvelopeV1({ definition: plannedEnvelope.definition, intent: plannedEnvelope.intent,
        observation: resolveCohortDefinitionObservationV1({ definition: plannedEnvelope.definition,
          observations: snapshot.portable.observations, decisions: snapshot.portable.decisions }),
        evidenceSubject: null, executionEpoch: sourceAuthority.envelope.executionEpoch });
      const nextLease = { ...sourceAuthority.lease, semanticSubject: nextEnvelope.semanticSubject };
      if (symbol.stdout.trim() === prior.ref) {
        const expected = { kind: "branch-create" as const, mode: "cohort-rebase-successor" as const,
          cohort: sourceAuthority.envelope, successor: nextEnvelope, targetRef: cohortEffectTargetRefV1(sourceAuthority.envelope),
          repositoryRoot: prior.repositoryRoot, worktreePath: prior.worktreePath, branch: prior.branch,
          successorBranch: handle.branch, expectedCommit: head, guardedRebaseBridgeDigest: proof.guardedRebaseBridgeDigest };
        const effect = await runWorksetGitEffectGate({ expected,
          provider: createCohortWorksetEffectAdmissionProvider(sourceAuthority, workset),
          resolve: async () => { await store.assertLiveCohortAuthority(sourceAuthority.lease, sourceAuthority.envelope);
            if ((await git(prior.worktreePath, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !== prior.ref ||
                await revParse(git, prior.worktreePath, "HEAD") !== head) throw new Error("cohort successor branch changed before rename");
            return expected; },
        });
        if (effect.code !== 0) throw new Error(`cohort successor branch rename failed: ${effect.stderr}`);
      }
      await withManagedMemberPrepareLocks(regRoot, prior.cohort.definition.members.map((member) => member.memberRef.slice("tasks:".length)), deps, async () => {
        records = await readCurrentTaskGeneration(regRoot, sourceKey);
        if (records === null || stored === undefined) throw new Error("cohort successor source record disappeared");
        const sourceRecords = records.map((record) => record.handle.token === prior.handleToken ? { ...record, status: "released" as const, releasedAt: handle.createdAt } : record);
        const targetKey = registrySubjectKey(handle);
        const targetRecords = await readCurrentTaskGeneration(regRoot, targetKey);
        const target: StoredHandleRecord<ManagedWorktreeHandleV3> = { handle, fingerprint: fingerprintHandle(handle), status: "live",
          headAtPrepare: head, bunWorkspaceRoot: stored.bunWorkspaceRoot,
          retainedCohortAuthority: { lease: nextLease, envelope: nextEnvelope }, cohortRebasePredecessor: { proof, bridge } };
        if (targetRecords !== null && targetRecords.some((record) => record.fingerprint !== target.fingerprint)) throw new Error("cohort successor registry already belongs to another transition");
        const sourcePublication = await stageTaskGenerationPublication(regRoot, sourceKey, sourceRecords, fault);
        const nextPublication = await stageTaskGenerationPublication(regRoot, targetKey, [target], fault);
        await store.transitionLeaseToSuccessor(sourceAuthority.lease, sourceAuthority.envelope, nextEnvelope, () => {
          deps.validateCohortPublication?.(nextEnvelope);
          sourcePublication.publish(); nextPublication.publish(); return undefined;
        });
      });
      const resolved = await resolveRetainedManagedCohortAuthority(prior.repositoryRoot, store, nextEnvelope, deps, false);
      return { ...resolved, bridge, proof };
    }));
}

export async function resolveManagedCohortRebaseTransition(binding: DispatchCohortGitEffectBinding,
  prior: DispatchCohortGitEffectBinding, source: DispatchHandle, reference: string, deps: ManagedWorktreeDeps) {
  const records = await readCurrentTaskGeneration(registryRoot(binding.repositoryRoot, deps.stateDir), `cohort-${binding.cohort.intent.intentDigest}`);
  const stored = (records ?? []).find((record) => record.status === "live" && record.fingerprint === binding.handleFingerprint);
  const retained = stored?.cohortRebasePredecessor;
  if (retained === undefined || retained.bridge.guardedRebase !== reference ||
      !cohortRebaseTransitionMatches(prior, { ...binding, guardedRebaseBridge: retained.bridge, cohortRebaseTransition: retained.proof }, source)) {
    throw new Error("cohort prepare lacks its exact private manager successor transition");
  }
  await verifyHistoricalCohortGuardedRebaseBridge(retained.bridge, deps.stateDir);
  return structuredClone(retained);
}

export async function withManagedCohortAuthorityWriterLock<T>(
  repositoryRoot: string, deps: ManagedWorktreeDeps, run: () => Promise<T>,
): Promise<T> {
  const lockfile = deps.lockfile ?? new Lockfile();
  const release = await lockfile.acquire(join(registryRoot(repositoryRoot, deps.stateDir), PREPARE_LOCKS_DIRNAME), "cohort-authority");
  try { return await run(); } finally { await release(); }
}

export async function bindRetainedManagedCohortSeal(
  repositoryRoot: string, store: WorkCohortStore, envelope: CohortEffectEnvelopeV1, deps: ManagedWorktreeDeps,
): Promise<{ readonly authority: ManagedCohortWorktreeAuthority;
  readonly binding: ManagedCohortWorktreeDispatchBinding; readonly handle: ManagedWorktreeHandleV3 }> {
  if (envelope.state !== "sealed") throw new Error("retained cohort transition requires a sealed candidate");
  const records = await readCurrentTaskGeneration(registryRoot(repositoryRoot, deps.stateDir), `cohort-${envelope.intent.intentDigest}`);
  const live = (records ?? []).filter((record) => record.status === "live");
  const stored = live.length === 1 ? live[0] : undefined;
  if (stored === undefined || stored.handle.version !== 3 || stored.retainedCohortAuthority === undefined ||
      stored.handle.repositoryRoot !== repositoryRoot ||
      stored.retainedCohortAuthority.envelope.executionEpoch !== envelope.executionEpoch ||
      cohortValueDigestV1(stored.handle.cohort) !== cohortValueDigestV1(cohortWorktreeIdentityFromEnvelopeV1(envelope))) {
    throw new Error("cohort seal transition lacks its exact current retained authority");
  }
  const lease = await store.bindLeaseToSeal(stored.retainedCohortAuthority.lease, envelope);
  const authority = { store, lease, envelope: structuredClone(envelope) };
  await retainManagedCohortAuthority(stored.handle, authority, deps);
  return resolveRetainedManagedCohortAuthority(repositoryRoot, store, envelope, deps, false);
}

export async function retainManagedCohortAuthority(
  handle: ManagedWorktreeHandleV3,
  authority: ManagedCohortWorktreeAuthority,
  deps: ManagedWorktreeDeps,
): Promise<void> {
  await authority.store.assertLiveCohortAuthority(authority.lease, authority.envelope);
  if (cohortValueDigestV1(handle.cohort) !== cohortValueDigestV1(cohortWorktreeIdentityFromEnvelopeV1(authority.envelope))) {
    throw new Error("retained cohort authority substituted its managed membership");
  }
  const regRoot = registryRoot(handle.repositoryRoot, deps.stateDir);
  const key = registrySubjectKey(handle);
  await withManagedMemberPrepareLocks(regRoot, handle.cohort.memberAuthorities.map((member) => member.taskRef.slice("tasks:".length)), deps, async () => {
    const records = await readCurrentTaskGeneration(regRoot, key);
    if (records === null) throw new Error("cohort authority publication requires a current managed registry");
    const index = records.findIndex((record) => record.status === "live" && record.handle.token === handle.token);
    const stored = records[index];
    if (stored === undefined || stored.fingerprint !== fingerprintHandle(handle)) throw new Error("cohort authority publication lost its actual managed handle");
    const next = [...records];
    next[index] = { ...stored, retainedCohortAuthority: { lease: structuredClone(authority.lease), envelope: structuredClone(authority.envelope) } };
    const fault = deps.faultInjector ?? (async () => undefined);
    const staged = await stageTaskGenerationPublication(regRoot, key, next, fault);
    try {
      await fault("before-registry-pointer-rename", { subjectKey: key, generation: staged.generation });
      await authority.store.publishLiveCohortEffect(authority.lease, authority.envelope, () => { deps.validateCohortPublication?.(authority.envelope); return staged.publish(); });
      await fault("after-registry-pointer-rename", { subjectKey: key, generation: staged.generation });
    } catch (error) {
      if (!staged.published) await staged.rollback();
      throw error;
    }
  });
}

export async function assertManagedCohortWorktreeDispatchBindingLive(
  binding: ManagedCohortWorktreeDispatchBinding,
  authority: ManagedCohortWorktreeAuthority,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir">,
  allowDetachedRebase: boolean,
): Promise<void> {
  await authority.store.assertLiveCohortAuthority(authority.lease, authority.envelope);
  if (cohortValueDigestV1(binding.cohort) !== cohortValueDigestV1(authority.envelope)) {
    throw new Error("cohort binding differs from its complete live effect authority");
  }
  const regRoot = registryRoot(binding.repositoryRoot, deps.stateDir);
  const records = await loadOrReconcileSubjectRecords(regRoot, `cohort-${authority.envelope.intent.intentDigest}`, async () => undefined);
  const stored = records.find((record) => record.status === "live" && record.handle.token === binding.handleToken);
  if (stored === undefined || stored.handle.version !== 3) throw new Error("cohort worktree binding is no longer live");
  const current = await resolveManagedCohortWorktreeDispatchBinding(stored.handle, authority, deps, allowDetachedRebase);
  if (current === null) throw new Error("cohort worktree binding no longer resolves to its managed Git coordinates");
  for (const key of ["handleToken", "handleFingerprint", "repositoryRoot", "repositoryId", "commonDir",
    "worktreePath", "branch", "ref", "baseCommit"] as const) {
    if (current[key] !== binding[key]) throw new Error(`cohort worktree binding changed at ${key}`);
  }
}

/** Recheck the complete manager/repository identity while the effect lock is held. */
export async function assertManagedWorktreeDispatchBindingLive(
  binding: ManagedWorktreeDispatchBinding,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir"> = {},
): Promise<void> {
  const resolved = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot: binding.repositoryRoot,
      taskId: binding.taskId,
      worktreePath: binding.worktreePath,
      branch: binding.branch,
    },
    deps,
  );
  if (resolved === null) throw new Error("managed worktree binding is no longer live");
  for (const key of [
    "taskId",
    "handleToken",
    "handleFingerprint",
    "repositoryRoot",
    "repositoryId",
    "commonDir",
    "worktreePath",
    "branch",
    "ref",
    "baseCommit",
  ] as const) {
    if (resolved[key] !== binding[key]) {
      throw new Error(`managed worktree binding changed at ${key}`);
    }
  }
}

/** Resolve the exact live HEAD after revalidating every manager binding coordinate. */
export async function observeManagedWorktreeLiveTip(
  binding: ManagedWorktreeDispatchBinding,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir"> = {},
): Promise<string> {
  await assertManagedWorktreeDispatchBindingLive(binding, deps);
  const tip = await revParse(
    deps.git ?? nodeManagedWorktreeGitRunner,
    binding.worktreePath,
    "HEAD",
  );
  if (tip === null || !FULL_COMMIT_SHA.test(tip)) {
    throw new Error("managed worktree HEAD is not a full commit SHA");
  }
  return tip;
}

/** Resolve HEAD while permitting the exact manager-bound detached rebase state. */
export async function observeManagedWorktreeRebaseTip(
  binding: ManagedWorktreeDispatchBinding,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir">,
): Promise<string> {
  await assertManagedWorktreeConflictDispatchBindingLive(binding, deps);
  const tip = await revParse(
    deps.git ?? nodeManagedWorktreeGitRunner,
    binding.worktreePath,
    "HEAD",
  );
  if (tip === null || !FULL_COMMIT_SHA.test(tip)) {
    throw new Error("managed rebase worktree HEAD is not a full commit SHA");
  }
  return tip;
}

/** Recheck a manager binding while Git has detached HEAD for its active rebase. */
export async function assertManagedWorktreeConflictDispatchBindingLive(
  binding: ManagedWorktreeDispatchBinding,
  deps: Pick<ManagedWorktreeDeps, "git" | "stateDir">,
): Promise<void> {
  const resolved = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot: binding.repositoryRoot,
      taskId: binding.taskId,
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      allowDetachedRebase: true,
    },
    deps,
  );
  if (resolved === null) throw new Error("managed conflict worktree binding is no longer live");
  for (const key of [
    "taskId",
    "handleToken",
    "handleFingerprint",
    "repositoryRoot",
    "repositoryId",
    "commonDir",
    "worktreePath",
    "branch",
    "ref",
    "baseCommit",
  ] as const) {
    if (resolved[key] !== binding[key]) {
      throw new Error(`managed conflict worktree binding changed at ${key}`);
    }
  }
}

/** Shared lock order for broker commit, result storage, and guarded release. */
export async function withManagedWorktreeEffectLock<T>(
  binding: Pick<ManagedWorktreeLineageBinding, "repositoryRoot" | "handleToken">,
  deps: Pick<ManagedWorktreeDeps, "stateDir" | "lockfile" | "effectLockTimeoutMs">,
  effect: () => Promise<T>,
): Promise<T> {
  const lockfile =
    deps.lockfile ??
    new Lockfile({
      ...(deps.effectLockTimeoutMs === undefined
        ? {}
        : { acquireTimeoutMs: deps.effectLockTimeoutMs }),
    });
  const releaseLock = await lockfile.acquire(
    join(registryRoot(binding.repositoryRoot, deps.stateDir), PREPARE_LOCKS_DIRNAME),
    `effect-${binding.handleToken}`,
  );
  try {
    return await effect();
  } finally {
    await releaseLock();
  }
}

export function managedWorktreeHandleSegment(): string {
  return CQ_MANAGED_WORKTREES_SEGMENTS.join("/");
}

export function normalizeManagedPath(value: string): string {
  return normalize(resolve(value));
}
