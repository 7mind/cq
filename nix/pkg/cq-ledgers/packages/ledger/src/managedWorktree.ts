/**
 * Managed worktree prepare + guarded release core (T1305).
 *
 * Owns the durable lifecycle of an implement-flow task worktree:
 *   - fresh prepare verifies base + transitive dependency result commits
 *     BEFORE any git worktree mutation, then creates a UUIDv7-named tree
 *     under `.claude/worktrees/`, retains branch identity `implement/<taskId>`,
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
  assessWipArtifactClosure,
  parseWipArtifact,
  validateManagedWorktreeHandle as validateManagedWorktreeHandleContract,
  WipArtifactParseError,
  type ManagedWorktreeHandle as ConfigManagedWorktreeHandle,
  type ImplementWorkerSupervisedGateEvidence,
  type WipClosureProjection,
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
import { AGENT_WORKTREE_SEGMENT } from "./projectKey.js";
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
const REGISTRY_DIRNAME = ".cq-managed-registry";
const TASK_INDEX_DIRNAME = "by-task";
const HANDLES_DIRNAME = "handles";
const TASK_REGISTRY_DIRNAME = "tasks";
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
  readonly worktreeId: string;
  readonly absolutePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly bunWorkspaceRoot: string;
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
  | "adoption-invalid"
  | "adoption-unavailable"
  | "adoption-ineligible"
  | "adoption-activity-changed"
  | "adoption-reconciliation-failed"
  | "adoption-authority-stale"
  | "adoption-recovery-failed"
  | "registry-conflict"
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
): PrepareManagedWorktreeResult {
  return { status: "refused", reason, detail, ...extra };
}

function refusedRelease(
  reason: ReleaseManagedWorktreeRefusalReason,
  detail: string,
  extra: Partial<Extract<ReleaseManagedWorktreeResult, { status: "refused" }>> = {},
): ReleaseManagedWorktreeResult {
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
  return join(repositoryRoot, ".claude", "worktrees");
}

function registryRoot(repositoryRoot: string, stateDir: string | undefined): string {
  if (stateDir !== undefined) return stateDir;
  return join(worktreesParent(repositoryRoot), REGISTRY_DIRNAME);
}

function legacyHandlePath(regRoot: string, token: string): string {
  return join(regRoot, HANDLES_DIRNAME, `${token}.json`);
}

function legacyTaskIndexDir(regRoot: string, taskId: string): string {
  return join(regRoot, TASK_INDEX_DIRNAME, taskId);
}

function taskRegistryDir(regRoot: string, taskId: string): string {
  return join(regRoot, TASK_REGISTRY_DIRNAME, taskId);
}

function taskGenerationPath(regRoot: string, taskId: string, generation: string): string {
  return join(taskRegistryDir(regRoot, taskId), TASK_GENERATIONS_DIRNAME, `${generation}.json`);
}

function taskCurrentPath(regRoot: string, taskId: string): string {
  return join(taskRegistryDir(regRoot, taskId), TASK_CURRENT_FILENAME);
}

function fingerprintHandle(handle: ManagedWorktreeHandle): string {
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

interface StoredHandleRecord {
  readonly handle: ManagedWorktreeHandle;
  readonly fingerprint: string;
  readonly status: "live" | "released";
  readonly headAtPrepare: string;
  readonly bunWorkspaceRoot: string;
  readonly trustedGateProjection?: ManagedWorktreeTrustedGateProjection;
  readonly releasedAt?: string;
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
  readonly gateExitCode: 0;
  readonly passCount: number;
  readonly failCount: 0;
  readonly capturedAt: string;
}

interface TaskRegistryGeneration {
  readonly version: 2;
  readonly taskId: string;
  readonly records: readonly StoredHandleRecord[];
}

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
  record: StoredHandleRecord,
  fault: ManagedWorktreeFaultInjector,
): Promise<void> {
  const records = await loadOrReconcileTaskRecords(regRoot, record.handle.taskId, fault);
  if (records.some((entry) => entry.handle.token === record.handle.token)) {
    throw new Error(`managed registry token already exists: ${record.handle.token}`);
  }
  await publishTaskGeneration(regRoot, record.handle.taskId, [...records, record], fault);
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

function isStoredHandleRecord(value: unknown, taskId?: string): value is StoredHandleRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<StoredHandleRecord>;
  if (!isHandleShape(record.handle)) return false;
  if (taskId !== undefined && record.handle.taskId !== taskId) return false;
  if (record.fingerprint !== fingerprintHandle(record.handle)) return false;
  if (record.status !== "live" && record.status !== "released") return false;
  if (typeof record.headAtPrepare !== "string") return false;
  if (typeof record.bunWorkspaceRoot !== "string") return false;
  const projectionBinding = { handle: record.handle, fingerprint: record.fingerprint };
  if (
    record.trustedGateProjection !== undefined &&
    !isManagedWorktreeTrustedGateProjection(record.trustedGateProjection, projectionBinding)
  ) {
    return false;
  }
  if (record.releasedAt !== undefined && typeof record.releasedAt !== "string") return false;
  return true;
}

function canonicalStoredHandleRecord(record: StoredHandleRecord): StoredHandleRecord {
  const handle = record.handle;
  return {
    handle: {
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
  };
}

function isManagedWorktreeTrustedGateProjection(
  value: unknown,
  record: Pick<StoredHandleRecord, "handle" | "fingerprint">,
): value is ManagedWorktreeTrustedGateProjection {
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
    projection.gateExitCode === 0 &&
    Number.isSafeInteger(projection.passCount) &&
    (projection.passCount ?? 0) > 0 &&
    projection.failCount === 0 &&
    typeof projection.capturedAt === "string" &&
    Number.isFinite(Date.parse(projection.capturedAt))
  );
}

function serializeTaskGeneration(taskId: string, records: readonly StoredHandleRecord[]): string {
  const generation: TaskRegistryGeneration = {
    version: 2,
    taskId,
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
): Promise<readonly StoredHandleRecord[] | null> {
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
    generation.version !== 2 ||
    generation.taskId !== taskId ||
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
  return generation.records as readonly StoredHandleRecord[];
}

async function publishTaskGeneration(
  regRoot: string,
  taskId: string,
  records: readonly StoredHandleRecord[],
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
  const tasksDir = join(regRoot, TASK_REGISTRY_DIRNAME);
  const generationsDir = join(taskDir, TASK_GENERATIONS_DIRNAME);
  const stagingDir = join(taskDir, TASK_STAGING_DIRNAME);
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

  await fault("after-registry-generation-sync", { taskId, generation });

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
  await fault("before-registry-pointer-rename", { taskId, generation });
  await fs.rename(stagedPointer, taskCurrentPath(regRoot, taskId));
  await syncRegistryDirectory(taskDir, "pointer", fault);
  if (current === null) {
    await syncRegistryDirectory(tasksDir, "task-directory", fault);
    await syncRegistryDirectory(regRoot, "tasks-directory", fault);
    await syncRegistryDirectory(dirname(regRoot), "registry-root", fault);
  }
  await fault("after-registry-pointer-rename", { taskId, generation });
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
  records: readonly StoredHandleRecord[],
  fault: ManagedWorktreeFaultInjector,
): Promise<StagedTaskGenerationPublication> {
  const generationRaw = serializeTaskGeneration(taskId, records);
  const generation = digestRegistryBytes(generationRaw);
  const taskDir = taskRegistryDir(regRoot, taskId);
  const tasksDir = join(regRoot, TASK_REGISTRY_DIRNAME);
  const generationsDir = join(taskDir, TASK_GENERATIONS_DIRNAME);
  const stagingDir = join(taskDir, TASK_STAGING_DIRNAME);
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
  await fault("after-registry-generation-sync", { taskId, generation });

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
    if (!isStoredHandleRecord(value, taskId)) continue;
    if (name !== `${value.handle.token}.json`) continue;
    records.set(value.handle.token, value);
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
  if (current !== null) return current;
  const legacy = await readLegacyTaskRecords(regRoot, taskId);
  if (legacy.length === 0) return [];
  await publishTaskGeneration(regRoot, taskId, legacy, fault);
  return legacy;
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
  handle: ManagedWorktreeHandle,
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
    const full = join(worktreePath, name);
    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    try {
      const artifact = parseWipArtifact(full, content);
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
  handle: ManagedWorktreeHandle,
  headCommit: string,
  bunWorkspaceRoot: string,
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
  const git = deps.git ?? nodeManagedWorktreeGitRunner;
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

  if (request.priorResultCommit !== undefined && request.priorResultCommit !== null) {
    if (!FULL_COMMIT_SHA.test(request.priorResultCommit)) {
      return refusedPrepare(
        "prior-result-commit-mismatch",
        `priorResultCommit is not a full SHA: ${request.priorResultCommit}`,
      );
    }
    const ancestor = await git(handle.absolutePath, [
      "merge-base",
      "--is-ancestor",
      request.priorResultCommit,
      head,
    ]);
    if (ancestor.code !== 0 && request.priorResultCommit !== head) {
      return refusedPrepare(
        "prior-result-commit-mismatch",
        `priorResultCommit ${request.priorResultCommit} is not equal to or an ancestor of HEAD ${head}`,
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
  const expectedPath = join(worktreesParent(repositoryRoot), `implement-${request.taskId}`);
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
    install,
    idFactory,
    now,
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

  // Discover the seed-side workspace BEFORE mutation; install cwd is rebased
  // into the managed worktree after `git worktree add`.
  const seedBunWorkspaceRoot =
    deps.bunWorkspaceRoot ?? (await discoverBunWorkspaceRoot(repositoryRoot));
  if (seedBunWorkspaceRoot === null) {
    return refusedPrepare(
      "bun-workspace-missing",
      `no Bun workspace (bun.lock) discovered under ${repositoryRoot}`,
    );
  }

  // Validate install plan shape against a placeholder cwd; the real managed
  // cwd is substituted after worktree add.
  const seedInstallPlan = buildManagedWorktreeInstallPlan({
    bunWorkspaceRoot: seedBunWorkspaceRoot,
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
    taskId: request.taskId,
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
  await fs.mkdir(parent, { recursive: true });
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
  ): Promise<PrepareManagedWorktreeResult> => {
    const rolled = await rollbackFreshWorktree(
      git,
      repositoryRoot,
      absolutePath,
      branch,
      createdBranch,
    );
    if (rolled.ok) {
      return refusedPrepare(reason, detail, extra);
    }
    // Rollback failed — try to commit a live handle so release can recover.
    const headForRecovery =
      (await revParse(git, absolutePath, "HEAD")) ??
      (await revParse(git, repositoryRoot, branch)) ??
      baseCommit;
    const managedWorkspace =
      rebaseBunWorkspaceIntoWorktree(repositoryRoot, seedBunWorkspaceRoot, absolutePath) ??
      absolutePath;
    const createdAt = now().toISOString();
    const token = randomBytes(16).toString("hex");
    const nonce = randomBytes(8).toString("hex");
    const recoveryHandle: ManagedWorktreeHandle = {
      kind: MANAGED_WORKTREE_HANDLE_KIND,
      version: FRESH_HANDLE_VERSION,
      token,
      worktreeId,
      taskId: request.taskId,
      branch,
      repositoryRoot,
      absolutePath,
      baseCommit,
      createdAt,
      nonce,
    };
    const registered = await emergencyRegisterLiveHandle(
      regRoot,
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

  const bunWorkspaceRoot = rebaseBunWorkspaceIntoWorktree(
    repositoryRoot,
    seedBunWorkspaceRoot,
    absolutePath,
  );
  if (bunWorkspaceRoot === null) {
    return refuseAfterAdd(
      "bun-workspace-missing",
      `seed workspace ${seedBunWorkspaceRoot} could not be rebased into managed worktree ${absolutePath}`,
    );
  }

  // Confirm the workspace exists inside the managed tree (git worktree copies the files).
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
  // Re-validate with the managed cwd (cwd non-empty + cache contract).
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

  if (!deps.skipInstall) {
    await fs.mkdir(installPlan.bunInstallCacheDir, { recursive: true });
    const installResult = await install(installPlan);
    if (installResult.code !== 0) {
      return refuseAfterAdd(
        "bun-install-failed",
        `bun install failed (exit ${installResult.code}): ${installResult.stderr.trim()}`,
      );
    }
    const symlinkProblem = await assertNoNodeModulesSymlink(bunWorkspaceRoot);
    if (symlinkProblem !== null) {
      return refuseAfterAdd("bun-install-plan-invalid", symlinkProblem);
    }
  }

  const headCommit = await revParse(git, absolutePath, "HEAD");
  if (headCommit === null) {
    return refuseAfterAdd("worktree-missing", "HEAD missing after prepare");
  }

  const createdAt = now().toISOString();
  const token = randomBytes(16).toString("hex");
  const nonce = randomBytes(8).toString("hex");
  const handle: ManagedWorktreeHandle = {
    kind: MANAGED_WORKTREE_HANDLE_KIND,
    version: FRESH_HANDLE_VERSION,
    token,
    worktreeId,
    taskId: request.taskId,
    branch,
    repositoryRoot,
    absolutePath,
    baseCommit,
    createdAt,
    nonce,
  };

  try {
    await fault("before-registry-commit", {
      token,
      absolutePath,
      taskId: request.taskId,
    });
  } catch (error) {
    return refuseAfterAdd(
      "registry-conflict",
      `fault before registry commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stored: StoredHandleRecord = {
    handle,
    fingerprint: fingerprintHandle(handle),
    status: "live",
    headAtPrepare: headCommit,
    bunWorkspaceRoot,
  };
  try {
    await writeStoredHandleExclusive(regRoot, stored, fault);
  } catch (error) {
    return refuseAfterAdd(
      "registry-conflict",
      `failed to commit handle registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const evidence = await buildEvidence(
    handle,
    headCommit,
    bunWorkspaceRoot,
    installPlan.bunInstallCacheDir,
    dependencyResultCommits,
    "fresh",
  );
  return { status: "prepared", handle, evidence };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

function isTerminalDisposition(value: string): value is ManagedWorktreeTerminalDisposition {
  return value === "done" || value === "abandoned";
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
    const wip = await findOpenWipCheckpoints(absolutePath, projection);
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

function trustedWipProjectionForRecord(
  stored: StoredHandleRecord,
  head: string,
  requestedResultCommit: string | null | undefined,
): WipClosureProjection | undefined {
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
  return { taskId: projection.taskId };
}

/** Persist a runner-minted exact-tip projection outside the Git worktree. */
export async function recordManagedWorktreeSupervisedGateEvidence(
  binding: ManagedWorktreeDispatchBinding,
  evidence: ImplementWorkerSupervisedGateEvidence,
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
  const assessment = await findOpenWipCheckpoints(binding.worktreePath, projection);
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
    if (request.allowDetachedRebase !== true) return null;
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
    taskId: stored.handle.taskId,
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
  binding: ManagedWorktreeDispatchBinding,
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
  return AGENT_WORKTREE_SEGMENT;
}

export function normalizeManagedPath(value: string): string {
  return normalize(resolve(value));
}
