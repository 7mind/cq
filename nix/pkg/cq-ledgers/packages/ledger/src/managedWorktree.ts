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
 * Fault-injection hooks sit immediately before irreversible deletes so a
 * injected failure cannot destroy recoverable work.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseWipArtifact, WipArtifactParseError } from "@cq/config";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDLE_KIND = "cq-managed-worktree-handle" as const;
const HANDLE_VERSION = 1 as const;
const DEFAULT_BRANCH_PREFIX = "implement/";
const REGISTRY_DIRNAME = ".cq-managed-registry";
const TASK_INDEX_DIRNAME = "by-task";
const HANDLES_DIRNAME = "handles";
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^T\d+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const BUN_LOCK_NAMES = ["bun.lock", "bun.lockb"] as const;
const FROZEN_INSTALL_ARGS = ["install", "--frozen-lockfile"] as const;

export type ManagedWorktreeTerminalDisposition = "done" | "abandoned";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque handle. Callers must not invent fields; only values returned by prepare. */
export interface ManagedWorktreeHandle {
  readonly kind: typeof HANDLE_KIND;
  readonly version: typeof HANDLE_VERSION;
  readonly token: string;
  readonly worktreeId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  readonly absolutePath: string;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly nonce: string;
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
  readonly mode: "fresh" | "resume";
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
  | "registry-conflict";

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
  | "already-live-elsewhere";

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
  if (
    cacheRelation === ".." ||
    cacheRelation.startsWith(`..${sep}`) ||
    isAbsolute(cacheRelation)
  ) {
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

function handlePath(regRoot: string, token: string): string {
  return join(regRoot, HANDLES_DIRNAME, `${token}.json`);
}

function taskIndexDir(regRoot: string, taskId: string): string {
  return join(regRoot, TASK_INDEX_DIRNAME, taskId);
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
  readonly releasedAt?: string;
}

function isHandleShape(value: unknown): value is ManagedWorktreeHandle {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["kind"] === HANDLE_KIND &&
    record["version"] === HANDLE_VERSION &&
    typeof record["token"] === "string" &&
    typeof record["worktreeId"] === "string" &&
    typeof record["taskId"] === "string" &&
    typeof record["branch"] === "string" &&
    typeof record["repositoryRoot"] === "string" &&
    typeof record["absolutePath"] === "string" &&
    typeof record["baseCommit"] === "string" &&
    typeof record["createdAt"] === "string" &&
    typeof record["nonce"] === "string"
  );
}

function assertHandleIntegrity(
  handle: ManagedWorktreeHandle,
  repositoryRoot: string,
): PrepareManagedWorktreeRefusalReason | ReleaseManagedWorktreeRefusalReason | null {
  if (!isHandleShape(handle)) return "handle-invalid";
  if (handle.kind !== HANDLE_KIND || handle.version !== HANDLE_VERSION) return "handle-invalid";
  if (!isUuidV7(handle.worktreeId)) return "handle-invalid";
  if (!isSafeTaskId(handle.taskId)) return "handle-invalid";
  if (!FULL_COMMIT_SHA.test(handle.baseCommit)) return "handle-invalid";
  if (handle.token.trim() === "" || handle.nonce.trim() === "") return "handle-invalid";
  if (handle.absolutePath.includes("\0") || handle.repositoryRoot.includes("\0")) {
    return "handle-invalid";
  }
  const resolvedRepo = resolve(repositoryRoot);
  if (resolve(handle.repositoryRoot) !== resolvedRepo) return "handle-foreign";
  if (!isAbsolute(handle.absolutePath)) return "handle-path-traversal";
  const expectedParent = worktreesParent(resolvedRepo);
  if (!containedPath(expectedParent, handle.absolutePath)) return "handle-path-traversal";
  if (basename(handle.absolutePath) !== handle.worktreeId) return "handle-path-traversal";
  if (handle.absolutePath.includes("..")) return "handle-path-traversal";
  return null;
}

async function readStoredHandle(
  regRoot: string,
  token: string,
): Promise<StoredHandleRecord | null> {
  try {
    const raw = await fs.readFile(handlePath(regRoot, token), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<StoredHandleRecord>;
    if (!isHandleShape(record.handle)) return null;
    if (record.fingerprint !== fingerprintHandle(record.handle)) return null;
    if (record.status !== "live" && record.status !== "released") return null;
    if (typeof record.headAtPrepare !== "string") return null;
    if (typeof record.bunWorkspaceRoot !== "string") return null;
    return record as StoredHandleRecord;
  } catch {
    return null;
  }
}

async function writeStoredHandleExclusive(
  regRoot: string,
  record: StoredHandleRecord,
): Promise<void> {
  const target = handlePath(regRoot, record.handle.token);
  await fs.mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
  try {
    await fs.link(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const indexDir = taskIndexDir(regRoot, record.handle.taskId);
  await fs.mkdir(indexDir, { recursive: true });
  const indexFile = join(indexDir, `${record.handle.token}.json`);
  await fs.writeFile(
    indexFile,
    `${JSON.stringify({ token: record.handle.token, status: record.status }, null, 2)}\n`,
    { encoding: "utf8" },
  );
}

async function updateStoredHandle(regRoot: string, record: StoredHandleRecord): Promise<void> {
  const target = handlePath(regRoot, record.handle.token);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
  await fs.rename(temporary, target);
  const indexFile = join(taskIndexDir(regRoot, record.handle.taskId), `${record.handle.token}.json`);
  await fs.mkdir(dirname(indexFile), { recursive: true });
  await fs.writeFile(
    indexFile,
    `${JSON.stringify({ token: record.handle.token, status: record.status }, null, 2)}\n`,
    { encoding: "utf8" },
  );
}

async function listLiveHandlesForTask(
  regRoot: string,
  taskId: string,
): Promise<StoredHandleRecord[]> {
  const indexDir = taskIndexDir(regRoot, taskId);
  let names: string[] = [];
  try {
    names = await fs.readdir(indexDir);
  } catch {
    return [];
  }
  const live: StoredHandleRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const token = name.slice(0, -".json".length);
    const stored = await readStoredHandle(regRoot, token);
    if (stored === null) continue;
    if (stored.status !== "live") continue;
    if (stored.handle.taskId !== taskId) continue;
    live.push(stored);
  }
  return live;
}

// ---------------------------------------------------------------------------
// Bun workspace discovery
// ---------------------------------------------------------------------------

export async function discoverBunWorkspaceRoot(
  repositoryRoot: string,
): Promise<string | null> {
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

// ---------------------------------------------------------------------------
// WIP / dirty inspection (G122)
// ---------------------------------------------------------------------------

export interface WipOpenCheckpointFinding {
  readonly path: string;
  readonly openCheckpoints: readonly string[];
}

export async function findOpenWipCheckpoints(
  worktreePath: string,
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
      if (artifact.openCheckpoints.length > 0) {
        findings.push({ path: full, openCheckpoints: artifact.openCheckpoints });
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
  mode: "fresh" | "resume",
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
    return refusedPrepare(
      "repository-invalid",
      `not a git repository: ${request.repositoryRoot}`,
    );
  }

  const regRoot = registryRoot(repositoryRoot, deps.stateDir);
  await fs.mkdir(regRoot, { recursive: true });

  // Explicit resume via handle.
  if (request.handle !== undefined) {
    const integrity = assertHandleIntegrity(request.handle, repositoryRoot);
    if (integrity !== null) {
      return refusedPrepare(integrity, `handle failed integrity: ${integrity}`);
    }
    const stored = await readStoredHandle(regRoot, request.handle.token);
    if (stored === null) {
      return refusedPrepare("handle-invalid", `unknown or tampered handle token`);
    }
    // Reject path/field tampering relative to the stored record.
    if (fingerprintHandle(request.handle) !== stored.fingerprint) {
      return refusedPrepare(
        "handle-mismatch",
        "presented handle does not match the stored registry fingerprint",
      );
    }
    if (resolve(request.handle.absolutePath) !== resolve(stored.handle.absolutePath)) {
      return refusedPrepare("handle-path-traversal", "handle absolutePath does not match registry");
    }
    return resumeFromStored(request, deps, stored, repositoryRoot);
  }

  // Handle-free: inspect live trees for this task.
  const live = await listLiveHandlesForTask(regRoot, request.taskId);
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

  const bunWorkspaceRoot =
    deps.bunWorkspaceRoot ?? (await discoverBunWorkspaceRoot(repositoryRoot));
  if (bunWorkspaceRoot === null) {
    return refusedPrepare(
      "bun-workspace-missing",
      `no Bun workspace (bun.lock) discovered under ${repositoryRoot}`,
    );
  }

  const installPlan = buildManagedWorktreeInstallPlan({
    bunWorkspaceRoot,
    cacheRoot: deps.cacheRoot,
  });
  const planValidation = validateManagedWorktreeInstallPlan(installPlan, {
    cacheRoot: deps.cacheRoot,
  });
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

  // If we attached to an existing branch, require base ancestry (no reset).
  if (branchExists) {
    const head = await revParse(git, absolutePath, "HEAD");
    if (head === null) {
      return refusedPrepare("worktree-missing", "worktree HEAD missing after add");
    }
    const ancestor = await git(absolutePath, ["merge-base", "--is-ancestor", baseCommit, head]);
    if (ancestor.code !== 0) {
      return refusedPrepare(
        "base-unresolvable",
        `existing branch ${branch} at ${head} does not contain base ${baseCommit}; refusing reset`,
      );
    }
  }

  if (!deps.skipInstall) {
    await fs.mkdir(installPlan.bunInstallCacheDir, { recursive: true });
    const installResult = await install(installPlan);
    if (installResult.code !== 0) {
      return refusedPrepare(
        "bun-install-failed",
        `bun install failed (exit ${installResult.code}): ${installResult.stderr.trim()}`,
      );
    }
    const symlinkProblem = await assertNoNodeModulesSymlink(bunWorkspaceRoot);
    if (symlinkProblem !== null) {
      return refusedPrepare("bun-install-plan-invalid", symlinkProblem);
    }
  }

  const headCommit = await revParse(git, absolutePath, "HEAD");
  if (headCommit === null) {
    return refusedPrepare("worktree-missing", "HEAD missing after prepare");
  }

  const createdAt = now().toISOString();
  const token = randomBytes(16).toString("hex");
  const nonce = randomBytes(8).toString("hex");
  const handle: ManagedWorktreeHandle = {
    kind: HANDLE_KIND,
    version: HANDLE_VERSION,
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

  await fault("before-registry-commit", {
    token,
    absolutePath,
    taskId: request.taskId,
  });

  const stored: StoredHandleRecord = {
    handle,
    fingerprint: fingerprintHandle(handle),
    status: "live",
    headAtPrepare: headCommit,
    bunWorkspaceRoot,
  };
  try {
    await writeStoredHandleExclusive(regRoot, stored);
  } catch (error) {
    return refusedPrepare(
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
  const stored = await readStoredHandle(regRoot, request.handle.token);
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
  if (!pathExists) {
    return refusedRelease("worktree-missing", `worktree path missing: ${absolutePath}`, {
      absolutePath,
    });
  }

  const porcelain = await gitPorcelain(git, absolutePath);
  if (porcelain.code !== 0) {
    return refusedRelease("ambiguous", `git status failed in ${absolutePath}`, { absolutePath });
  }
  if (porcelain.porcelain.trim() !== "") {
    return refusedRelease("dirty", `worktree has uncommitted changes`, { absolutePath });
  }

  const wip = await findOpenWipCheckpoints(absolutePath);
  if (wip.status === "malformed") {
    return refusedRelease("wip-malformed", `WIP artifact malformed at ${wip.path}: ${wip.detail}`, {
      absolutePath,
    });
  }
  if (wip.status === "open") {
    const openCheckpoints = wip.findings.flatMap((finding) => finding.openCheckpoints);
    return refusedRelease("wip-open", `open WIP checkpoints: ${openCheckpoints.join(", ")}`, {
      absolutePath,
      openCheckpoints,
    });
  }

  const head = await revParse(git, absolutePath, "HEAD");
  if (head === null) {
    return refusedRelease("ambiguous", `cannot resolve HEAD in ${absolutePath}`, { absolutePath });
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

  // Ambiguity: more than one live handle for the same path.
  const live = await listLiveHandlesForTask(regRoot, stored.handle.taskId);
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

  if (deleteBranch) {
    // Best-effort branch delete; failure does not revive the worktree.
    await git(repositoryRoot, ["branch", "-D", stored.handle.branch]);
  }

  await fault("before-registry-release", {
    token: stored.handle.token,
    taskId: stored.handle.taskId,
  });

  const released: StoredHandleRecord = {
    ...stored,
    status: "released",
    releasedAt: now().toISOString(),
  };
  await updateStoredHandle(regRoot, released);

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
}

/** Test helper: read registry live count for a task. */
export async function listManagedLiveWorktrees(
  repositoryRoot: string,
  taskId: string,
  stateDir?: string,
): Promise<readonly ManagedWorktreeHandle[]> {
  const git = nodeManagedWorktreeGitRunner;
  const root = (await resolveRepositoryRoot(git, repositoryRoot)) ?? resolve(repositoryRoot);
  const live = await listLiveHandlesForTask(registryRoot(root, stateDir), taskId);
  return live.map((entry) => entry.handle);
}

export function managedWorktreeHandleSegment(): string {
  return AGENT_WORKTREE_SEGMENT;
}

export function normalizeManagedPath(value: string): string {
  return normalize(resolve(value));
}
