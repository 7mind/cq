import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const LEGACY_JOURNAL_VERSION = 1 as const;
const JOURNAL_VERSION = 2 as const;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9_-]+$/;
const ZERO_SHA = "0".repeat(40);

export interface LegacyWorktreeActivityObservation {
  readonly epoch: string;
  readonly contentToken: string;
  readonly liveDispatches: readonly string[];
  readonly liveLeases: readonly string[];
  readonly liveProcesses: readonly string[];
}

export interface LegacyWorktreeActivityFence {
  observe(worktreePath: string): Promise<LegacyWorktreeActivityObservation>;
}

export interface LegacyWorktreeManagedOwnerObservation {
  readonly liveDispatches: readonly string[];
  readonly liveLeases: readonly string[];
}

export type LegacyWorktreeManagedOwnerObserver = (
  worktreePath: string,
) => Promise<LegacyWorktreeManagedOwnerObservation>;

export interface LegacyWorktreeManagerLock {
  acquire(worktreePath: string): Promise<() => Promise<void>>;
}

export interface LegacyReconciliationGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type LegacyReconciliationGitRunner = (
  cwd: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<LegacyReconciliationGitResult>;

export type LegacyReconciliationClassification =
  | "upstream-equivalent"
  | "linear-unpublished";

export type LegacyReconciliationFaultBoundary =
  | "after-capture"
  | "after-journal-durable"
  | "after-classification"
  | "after-candidate-overlay"
  | "before-first-mutation"
  | "after-candidate-import"
  | "after-recovery-ref"
  | "after-head-cas"
  | "after-reset"
  | "after-overlay-restore"
  | "after-reconciled-journal"
  | "before-commit"
  | "before-rollback";

export type LegacyReconciliationFaultInjector = (
  boundary: LegacyReconciliationFaultBoundary,
  context: Readonly<Record<string, string>>,
) => void | Promise<void>;

export interface BeginLegacyWorktreeReconciliationRequest {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly transactionId: string;
  readonly journalDirectory: string;
  /** Additional worktree-relative roots excluded from overlay capture. */
  readonly excludedRelativePaths?: readonly string[];
}

export interface LegacyWorktreeReconciliationDeps {
  readonly managerLock: LegacyWorktreeManagerLock;
  readonly activityFence: LegacyWorktreeActivityFence;
  readonly git?: LegacyReconciliationGitRunner;
  readonly observationAdapter?: LegacyReconciliationObservationAdapter;
  readonly faultInjector?: LegacyReconciliationFaultInjector;
}

export type LegacyReconciliationHistoryObservation =
  | {
      readonly status: "observed";
      readonly mergeCommits: readonly string[];
      readonly cherry: readonly string[];
    }
  | {
      readonly status: "unresolvable";
      readonly detail: string;
    };

export interface LegacyReconciliationObservationAdapter {
  observeActivity(worktreePath: string): Promise<LegacyWorktreeActivityObservation>;
  observeHistory(input: {
    readonly repositoryRoot: string;
    readonly baseCommit: string;
    readonly headCommit: string;
  }): Promise<LegacyReconciliationHistoryObservation>;
}

export type LegacyReconciliationActivityAssessment =
  | { readonly status: "accepted"; readonly observation: LegacyWorktreeActivityObservation }
  | {
      readonly status: "refused";
      readonly reason: "activity-live" | "activity-changed";
      readonly detail: string;
    };

export type LegacyReconciliationHistoryAssessment =
  | {
      readonly status: "accepted";
      readonly classification: LegacyReconciliationClassification;
      readonly cherry: readonly string[];
      readonly replayedCommits: readonly string[];
    }
  | {
      readonly status: "refused";
      readonly reason: "history-unresolvable" | "divergent-merge";
      readonly detail: string;
    };

export interface LegacyOverlayJournalEntry {
  readonly path: string;
  readonly type: "file" | "symlink" | "deleted";
  readonly mode: number | null;
  readonly sha256: string;
  readonly bytesBase64: string | null;
}

type GitFileMode = "100644" | "100755" | "120000";

interface GitPathState {
  readonly mode: GitFileMode;
  readonly oid: string;
}

interface WorktreePathState extends GitPathState {
  readonly type: "file" | "symlink";
  readonly sha256: string;
  readonly bytesBase64: string;
}

interface GitPathDelta {
  readonly path: string;
  readonly before: GitPathState | null;
  readonly after: GitPathState | null;
}

interface WorktreePathDelta {
  readonly path: string;
  readonly before: GitPathState | null;
  readonly after: WorktreePathState | null;
}

interface UntrackedPathEntry {
  readonly path: string;
  readonly after: WorktreePathState;
}

interface CandidatePathPreimage {
  readonly path: string;
  readonly head: GitPathState | null;
}

interface LegacySemanticOverlay {
  readonly paths: readonly CandidatePathPreimage[];
  readonly staged: readonly GitPathDelta[];
  readonly unstaged: readonly WorktreePathDelta[];
  readonly untracked: readonly UntrackedPathEntry[];
}

export interface LegacyWorktreeReconciliationEvidence {
  readonly transactionId: string;
  readonly journalPath: string;
  readonly recoveryRef: string;
  readonly candidateRef: string;
  readonly oldHead: string;
  readonly candidateHead: string;
  readonly classification: LegacyReconciliationClassification;
  readonly cherry: readonly string[];
  readonly replayedCommits: readonly string[];
  readonly overlaySha256: string;
  readonly overlayEntries: readonly LegacyOverlayJournalEntry[];
  readonly wipArtifacts: readonly string[];
  readonly activity: {
    readonly captured: LegacyWorktreeActivityObservation;
    readonly journaled: LegacyWorktreeActivityObservation;
    /** Last pre-mutation fence; prevents a concurrent adoption transition. */
    readonly transition: LegacyWorktreeActivityObservation;
    /** Durable quiescent baseline captured after the candidate becomes live. */
    readonly postTransition: LegacyWorktreeActivityObservation;
  };
}

export interface LegacyWorktreeReconciliationTransaction {
  readonly evidence: LegacyWorktreeReconciliationEvidence;
  commit(): Promise<{ readonly status: "committed"; readonly idempotent: boolean }>;
  rollback(): Promise<{ readonly status: "rolled-back"; readonly idempotent: boolean }>;
}

export type BeginLegacyWorktreeReconciliationRefusalReason =
  | "request-invalid"
  | "identity-mismatch"
  | "activity-live"
  | "activity-changed"
  | "transaction-exists"
  | "history-unresolvable"
  | "divergent-merge"
  | "replay-conflict"
  | "candidate-path-collision"
  | "overlay-unsupported"
  | "overlay-mismatch"
  | "transition-failed"
  | "rollback-failed";

export type BeginLegacyWorktreeReconciliationResult =
  | {
      readonly status: "reconciled";
      readonly evidence: LegacyWorktreeReconciliationEvidence;
      readonly transaction: LegacyWorktreeReconciliationTransaction;
    }
  | {
      readonly status: "refused";
      readonly reason: BeginLegacyWorktreeReconciliationRefusalReason;
      readonly detail: string;
      readonly restored: boolean;
    };

export interface RecoverLegacyWorktreeReconciliationRequest {
  readonly transactionId: string;
  readonly journalDirectory: string;
  /** Adoption recovery only: finalize an already-reconciled transaction. */
  readonly finalizeReconciled?: boolean;
  /** Published adopted handle authority required to repair a committed v1 stale index. */
  readonly repairPublishedV1?: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly legacyHead: string;
    readonly candidateHead: string;
  };
}

export type RecoverLegacyWorktreeReconciliationResult =
  | {
      readonly status: "recovered";
      readonly outcome: "committed" | "rolled-back";
      readonly idempotent: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: "journal-missing" | "journal-invalid" | "activity-live" | "activity-changed" | "rollback-failed";
      readonly detail: string;
    };

interface CapturedRefs {
  readonly headSymbolicRef: string;
  readonly branchRef: string;
  readonly head: string;
  readonly base: string;
  readonly recoveryRef: string;
  readonly recoveryValue: string | null;
  readonly candidateRef: string;
  readonly candidateValue: string | null;
}

interface CapturedIndex {
  readonly path: string;
  readonly sha256: string;
  readonly bytesBase64: string;
}

interface LegacyV1IndexRepair {
  readonly version: 1;
  readonly status: "installed";
  readonly semanticOverlay: LegacySemanticOverlay;
  readonly semanticOverlaySha256: string;
  readonly candidateIndexSha256: string;
  readonly repairedAt: string;
}

type JournalPhase =
  | "captured"
  | "candidate-ready"
  | "transition-ready"
  | "reconciled"
  | "committed"
  | "rolled-back";

interface LegacyReconciliationJournal {
  readonly version: typeof LEGACY_JOURNAL_VERSION | typeof JOURNAL_VERSION;
  readonly transactionId: string;
  readonly request: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly expectedHead: string;
    readonly journalDirectory: string;
    readonly excludedRelativePaths: readonly string[];
  };
  readonly refs: CapturedRefs;
  readonly index: CapturedIndex;
  readonly overlay: readonly LegacyOverlayJournalEntry[];
  readonly overlaySha256: string;
  readonly semanticOverlay?: LegacySemanticOverlay;
  readonly semanticOverlaySha256?: string;
  readonly wipArtifacts: readonly string[];
  readonly capturedActivity: LegacyWorktreeActivityObservation;
  readonly phase: JournalPhase;
  readonly classification?: LegacyReconciliationClassification;
  readonly cherry?: readonly string[];
  readonly replayedCommits?: readonly string[];
  readonly candidateHead?: string;
  readonly journaledActivity?: LegacyWorktreeActivityObservation;
  readonly transitionActivity?: LegacyWorktreeActivityObservation;
  readonly postTransitionActivity?: LegacyWorktreeActivityObservation;
  readonly repair?: LegacyV1IndexRepair;
}

class ReconciliationRefusal extends Error {
  constructor(
    readonly reason: BeginLegacyWorktreeReconciliationRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

function gitEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[variable];
  }
  return {
    ...environment,
    GIT_COMMITTER_NAME: "CQ Legacy Reconciliation",
    GIT_COMMITTER_EMAIL: "cq-reconciliation@example.invalid",
    ...(overrides ?? {}),
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
}

export const nodeLegacyReconciliationGitRunner: LegacyReconciliationGitRunner = (
  cwd,
  args,
  environment,
) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env: gitEnvironment(environment), maxBuffer: 32 * 1024 * 1024 },
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

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function journalPath(journalDirectory: string, transactionId: string): string {
  return join(journalDirectory, `${transactionId}.json`);
}

function candidateBuildPath(journalDirectory: string, transactionId: string): string {
  return join(journalDirectory, "builds", transactionId);
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function canonicalRequest(
  request: BeginLegacyWorktreeReconciliationRequest,
): LegacyReconciliationJournal["request"] {
  return {
    repositoryRoot: resolve(request.repositoryRoot),
    worktreePath: resolve(request.worktreePath),
    branch: request.branch,
    baseCommit: request.baseCommit,
    expectedHead: request.expectedHead,
    journalDirectory: resolve(request.journalDirectory),
    excludedRelativePaths: [...(request.excludedRelativePaths ?? [])].sort(comparePaths),
  };
}

function validateRequest(request: LegacyReconciliationJournal["request"], transactionId: string): void {
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new ReconciliationRefusal("request-invalid", `invalid transactionId ${transactionId}`);
  }
  if (!FULL_SHA.test(request.baseCommit) || !FULL_SHA.test(request.expectedHead)) {
    throw new ReconciliationRefusal("request-invalid", "baseCommit and expectedHead must be full lowercase SHAs");
  }
  if (!isAbsolute(request.repositoryRoot) || !isAbsolute(request.worktreePath) || !isAbsolute(request.journalDirectory)) {
    throw new ReconciliationRefusal("request-invalid", "repositoryRoot, worktreePath, and journalDirectory must be absolute");
  }
  if (isContained(request.worktreePath, request.journalDirectory)) {
    throw new ReconciliationRefusal("request-invalid", "journalDirectory must be outside the reconciled worktree");
  }
  for (const excluded of request.excludedRelativePaths) {
    if (excluded === "" || isAbsolute(excluded) || excluded === ".." || excluded.startsWith(`..${sep}`)) {
      throw new ReconciliationRefusal("request-invalid", `invalid excluded path ${excluded}`);
    }
  }
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function runRequired(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  args: readonly string[],
  reason: BeginLegacyWorktreeReconciliationRefusalReason,
  environment?: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await git(cwd, args, environment);
  if (result.code !== 0) {
    throw new ReconciliationRefusal(
      reason,
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function runRequiredRaw(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  args: readonly string[],
  reason: BeginLegacyWorktreeReconciliationRefusalReason,
  environment?: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await git(cwd, args, environment);
  if (result.code !== 0) {
    throw new ReconciliationRefusal(
      reason,
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

async function resolveCommit(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  revision: string,
): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return FULL_SHA.test(value) ? value : null;
}

async function resolveRef(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  ref: string,
): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return FULL_SHA.test(value) ? value : null;
}

function recoveryRefFor(transactionId: string): string {
  return `refs/cq-managed-recovery/legacy/${transactionId}`;
}

function candidateRefFor(transactionId: string): string {
  return `refs/cq-managed-candidates/legacy/${transactionId}`;
}

async function captureRefs(
  request: LegacyReconciliationJournal["request"],
  transactionId: string,
  git: LegacyReconciliationGitRunner,
): Promise<CapturedRefs> {
  const repositoryTop = await runRequired(git, request.repositoryRoot, ["rev-parse", "--show-toplevel"], "identity-mismatch");
  const worktreeTop = await runRequired(git, request.worktreePath, ["rev-parse", "--show-toplevel"], "identity-mismatch");
  if (resolve(repositoryTop) !== request.repositoryRoot || resolve(worktreeTop) !== request.worktreePath) {
    throw new ReconciliationRefusal("identity-mismatch", "repository or worktree root does not match the request");
  }
  const headSymbolicRef = await runRequired(git, request.worktreePath, ["symbolic-ref", "-q", "HEAD"], "identity-mismatch");
  const branchRef = `refs/heads/${request.branch}`;
  if (headSymbolicRef !== branchRef) {
    throw new ReconciliationRefusal("identity-mismatch", `worktree HEAD names ${headSymbolicRef}, expected ${branchRef}`);
  }
  const head = await resolveCommit(git, request.worktreePath, "HEAD");
  const branchHead = await resolveCommit(git, request.repositoryRoot, branchRef);
  const base = await resolveCommit(git, request.repositoryRoot, request.baseCommit);
  if (head === null || branchHead === null || base === null) {
    throw new ReconciliationRefusal("history-unresolvable", "HEAD, branch, or base object is missing");
  }
  if (head !== request.expectedHead || branchHead !== request.expectedHead) {
    throw new ReconciliationRefusal(
      "identity-mismatch",
      `expected HEAD ${request.expectedHead}, observed worktree ${head} and branch ${branchHead}`,
    );
  }
  const recoveryRef = recoveryRefFor(transactionId);
  const candidateRef = candidateRefFor(transactionId);
  const recoveryValue = await resolveRef(git, request.repositoryRoot, recoveryRef);
  const candidateValue = await resolveRef(git, request.repositoryRoot, candidateRef);
  if (recoveryValue !== null || candidateValue !== null) {
    throw new ReconciliationRefusal(
      "transaction-exists",
      `transaction refs already exist: recovery=${String(recoveryValue)} candidate=${String(candidateValue)}`,
    );
  }
  return {
    headSymbolicRef,
    branchRef,
    head,
    base,
    recoveryRef,
    recoveryValue,
    candidateRef,
    candidateValue,
  };
}

async function captureIndex(
  git: LegacyReconciliationGitRunner,
  worktreePath: string,
): Promise<CapturedIndex> {
  const rawPath = await runRequired(git, worktreePath, ["rev-parse", "--git-path", "index"], "identity-mismatch");
  const indexPath = isAbsolute(rawPath) ? rawPath : resolve(worktreePath, rawPath);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(indexPath);
  } catch (error) {
    throw new ReconciliationRefusal(
      "identity-mismatch",
      `cannot read worktree index ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: indexPath, sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
}

function isExcludedPath(path: string, excludedRelativePaths: readonly string[]): boolean {
  const segments = path.split("/");
  if (segments.includes("node_modules")) return true;
  return excludedRelativePaths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

async function captureOneOverlayEntry(
  worktreePath: string,
  path: string,
): Promise<LegacyOverlayJournalEntry> {
  const fullPath = join(worktreePath, path);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, type: "deleted", mode: null, sha256: sha256(""), bytesBase64: null };
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isFile()) {
    const bytes = await fs.readFile(fullPath);
    return { path, type: "file", mode, sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
  }
  if (stat.isSymbolicLink()) {
    const bytes = (await fs.readlink(fullPath, { encoding: "buffer" })) as unknown as Buffer;
    return { path, type: "symlink", mode, sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
  }
  throw new ReconciliationRefusal("overlay-unsupported", `overlay path ${path} has unsupported filesystem type`);
}

async function captureOverlay(
  git: LegacyReconciliationGitRunner,
  worktreePath: string,
  excludedRelativePaths: readonly string[],
): Promise<readonly LegacyOverlayJournalEntry[]> {
  const modified = await runRequiredRaw(
    git,
    worktreePath,
    ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
    "identity-mismatch",
  );
  const untracked = await runRequiredRaw(
    git,
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    "identity-mismatch",
  );
  const paths = new Set<string>();
  for (const value of [modified, untracked]) {
    for (const path of value.split("\0")) {
      if (path !== "" && !isExcludedPath(path, excludedRelativePaths)) paths.add(path);
    }
  }
  const sorted = [...paths].sort(comparePaths);
  return Promise.all(sorted.map((path) => captureOneOverlayEntry(worktreePath, path)));
}

function parseNulPaths(raw: string, excludedRelativePaths: readonly string[]): readonly string[] {
  const paths = new Set<string>();
  for (const path of raw.split("\0")) {
    if (path !== "" && !isExcludedPath(path, excludedRelativePaths)) paths.add(path);
  }
  return [...paths].sort(comparePaths);
}

function isGitFileMode(value: string): value is GitFileMode {
  return value === "100644" || value === "100755" || value === "120000";
}

function parseGitPathState(raw: string, expectedPath: string): GitPathState | null {
  if (raw === "") return null;
  const records = raw.split("\0").filter((record) => record !== "");
  if (records.length !== 1) {
    throw new ReconciliationRefusal(
      "overlay-unsupported",
      `path ${expectedPath} has ${records.length} index/tree records`,
    );
  }
  const record = records[0]!;
  const tab = record.indexOf("\t");
  if (tab < 0 || record.slice(tab + 1) !== expectedPath) {
    throw new ReconciliationRefusal("overlay-unsupported", `malformed state record for ${expectedPath}`);
  }
  const fields = record.slice(0, tab).split(" ");
  const mode = fields[0];
  const treeRecord = fields[1] === "blob";
  const oid = treeRecord ? fields[2] : fields[1];
  const stage = treeRecord ? undefined : fields[2];
  if (!isGitFileMode(mode ?? "") || !FULL_SHA.test(oid ?? "") || (stage !== undefined && stage !== "0")) {
    throw new ReconciliationRefusal(
      "overlay-unsupported",
      `unsupported mode, object, or stage for ${expectedPath}`,
    );
  }
  return { mode: mode as GitFileMode, oid: oid! };
}

async function captureTreePathState(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  commit: string,
  path: string,
): Promise<GitPathState | null> {
  const raw = await runRequiredRaw(
    git,
    cwd,
    ["ls-tree", "-z", commit, "--", path],
    "history-unresolvable",
  );
  return parseGitPathState(raw, path);
}

async function captureIndexPathState(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  path: string,
  environment?: Readonly<Record<string, string>>,
): Promise<GitPathState | null> {
  const raw = await runRequiredRaw(
    git,
    cwd,
    ["ls-files", "--stage", "-z", "--", path],
    "overlay-unsupported",
    environment,
  );
  return parseGitPathState(raw, path);
}

function gitBlobOid(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

async function captureWorktreePathState(
  worktreePath: string,
  path: string,
): Promise<WorktreePathState | null> {
  const fullPath = join(worktreePath, path);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let bytes: Buffer;
  let type: WorktreePathState["type"];
  let mode: GitFileMode;
  if (stat.isFile()) {
    bytes = await fs.readFile(fullPath);
    type = "file";
    mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
  } else if (stat.isSymbolicLink()) {
    bytes = Buffer.from(await fs.readlink(fullPath, { encoding: "buffer" }));
    type = "symlink";
    mode = "120000";
  } else {
    throw new ReconciliationRefusal("overlay-unsupported", `overlay path ${path} has unsupported filesystem type`);
  }
  return {
    type,
    mode,
    oid: gitBlobOid(bytes),
    sha256: sha256(bytes),
    bytesBase64: bytes.toString("base64"),
  };
}

async function captureSemanticOverlay(
  git: LegacyReconciliationGitRunner,
  worktreePath: string,
  head: string,
  excludedRelativePaths: readonly string[],
): Promise<LegacySemanticOverlay> {
  const [stagedRaw, unstagedRaw, untrackedRaw] = await Promise.all([
    runRequiredRaw(
      git,
      worktreePath,
      ["diff", "--cached", "--name-only", "--no-renames", "-z", head, "--"],
      "identity-mismatch",
    ),
    runRequiredRaw(
      git,
      worktreePath,
      ["diff", "--name-only", "--no-renames", "-z", "--"],
      "identity-mismatch",
    ),
    runRequiredRaw(
      git,
      worktreePath,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      "identity-mismatch",
    ),
  ]);
  const stagedPaths = parseNulPaths(stagedRaw, excludedRelativePaths);
  const unstagedPaths = parseNulPaths(unstagedRaw, excludedRelativePaths);
  const untrackedPaths = parseNulPaths(untrackedRaw, excludedRelativePaths);
  const allPaths = [...new Set([...stagedPaths, ...unstagedPaths, ...untrackedPaths])].sort(comparePaths);
  const paths = await Promise.all(
    allPaths.map(async (path) => ({ path, head: await captureTreePathState(git, worktreePath, head, path) })),
  );
  const staged = await Promise.all(
    stagedPaths.map(async (path) => ({
      path,
      before: await captureTreePathState(git, worktreePath, head, path),
      after: await captureIndexPathState(git, worktreePath, path),
    })),
  );
  const unstaged = await Promise.all(
    unstagedPaths.map(async (path) => ({
      path,
      before: await captureIndexPathState(git, worktreePath, path),
      after: await captureWorktreePathState(worktreePath, path),
    })),
  );
  const untracked = await Promise.all(
    untrackedPaths.map(async (path) => {
      const after = await captureWorktreePathState(worktreePath, path);
      if (after === null) {
        throw new ReconciliationRefusal("activity-changed", `untracked path ${path} disappeared during capture`);
      }
      return { path, after };
    }),
  );
  return { paths, staged, unstaged, untracked };
}

function semanticOverlayDigest(overlay: LegacySemanticOverlay): string {
  return sha256(JSON.stringify(overlay));
}

function sameSemanticOverlay(left: LegacySemanticOverlay, right: LegacySemanticOverlay): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function overlayDigest(entries: readonly LegacyOverlayJournalEntry[]): string {
  return sha256(
    JSON.stringify(
      entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        sha256: entry.sha256,
      })),
    ),
  );
}

async function liveWorktreeProcesses(worktreePath: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir("/proc", { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await new Promise((resolvePromise, reject) => {
      execFile(
        "lsof",
        ["-a", "-d", "cwd", "-Fpn"],
        { encoding: "utf8" },
        (lsofError, stdout) => {
          const code = (lsofError as { readonly code?: string | number } | null)?.code;
          if (lsofError !== null && code !== 1) {
            if (code === "ENOENT") {
              resolvePromise(["process-observation-unavailable"]);
              return;
            }
            reject(lsofError);
            return;
          }
          const live = new Set<string>();
          let pid: string | null = null;
          for (const line of String(stdout).split(/\r?\n/)) {
            if (line.startsWith("p")) pid = line.slice(1);
            if (line.startsWith("n") && pid !== null && isContained(worktreePath, line.slice(1))) {
              live.add(pid);
            }
          }
          resolvePromise([...live].sort(comparePaths));
        },
      );
    });
  }
  const live: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const cwd = await fs.readlink(join("/proc", entry.name, "cwd"));
      if (isContained(worktreePath, cwd)) live.push(entry.name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "ENOENT" && code !== "EPERM") throw error;
    }
  }
  return live.sort(comparePaths);
}

/**
 * Production activity authority for a legacy worktree. The Git index and
 * overlay digest exclude install-owned node_modules while retaining staged,
 * tracked, untracked, deletion, mode, symlink, and byte changes. Process cwd
 * ownership fails closed when neither procfs nor lsof can observe it.
 */
export function createGitLegacyWorktreeActivityFence(
  observeManagedOwners?: LegacyWorktreeManagedOwnerObserver,
): LegacyWorktreeActivityFence {
  const owners =
    observeManagedOwners ??
    (async (): Promise<LegacyWorktreeManagedOwnerObservation> => ({
      liveDispatches: [],
      liveLeases: [],
    }));
  return {
    async observe(worktreePath) {
      const index = await runRequiredRaw(
        nodeLegacyReconciliationGitRunner,
        worktreePath,
        ["ls-files", "--stage", "-z"],
        "identity-mismatch",
      );
      const overlay = await captureOverlay(nodeLegacyReconciliationGitRunner, worktreePath, []);
      const [managed, liveProcesses] = await Promise.all([
        owners(worktreePath),
        liveWorktreeProcesses(worktreePath),
      ]);
      return {
        epoch: sha256(resolve(worktreePath)),
        contentToken: sha256(`${sha256(index)}\n${overlayDigest(overlay)}`),
        liveDispatches: [...managed.liveDispatches].sort(comparePaths),
        liveLeases: [...managed.liveLeases].sort(comparePaths),
        liveProcesses,
      };
    },
  };
}

async function listWipArtifacts(worktreePath: string): Promise<readonly string[]> {
  const names = await fs.readdir(worktreePath);
  return names
    .filter((name) => name.startsWith("WIP-") && name.endsWith(".md"))
    .sort(comparePaths);
}

function assertQuiescent(activity: LegacyWorktreeActivityObservation): void {
  const live = [
    ...activity.liveDispatches.map((value) => `dispatch:${value}`),
    ...activity.liveLeases.map((value) => `lease:${value}`),
    ...activity.liveProcesses.map((value) => `process:${value}`),
  ];
  if (live.length > 0) {
    throw new ReconciliationRefusal("activity-live", `worktree has live owners: ${live.join(", ")}`);
  }
}

function assertSameActivity(
  expected: LegacyWorktreeActivityObservation,
  observed: LegacyWorktreeActivityObservation,
): void {
  assertQuiescent(observed);
  if (observed.epoch !== expected.epoch || observed.contentToken !== expected.contentToken) {
    throw new ReconciliationRefusal(
      "activity-changed",
      `activity changed from ${expected.epoch}/${expected.contentToken} to ${observed.epoch}/${observed.contentToken}`,
    );
  }
}

export async function assessLegacyReconciliationActivity(
  adapter: LegacyReconciliationObservationAdapter,
  worktreePath: string,
  expected: LegacyWorktreeActivityObservation | null,
): Promise<LegacyReconciliationActivityAssessment> {
  const observation = await adapter.observeActivity(worktreePath);
  try {
    if (expected === null) assertQuiescent(observation);
    else assertSameActivity(expected, observation);
    return { status: "accepted", observation };
  } catch (error) {
    const reason =
      error instanceof ReconciliationRefusal && error.reason === "activity-live"
        ? "activity-live"
        : "activity-changed";
    return {
      status: "refused",
      reason,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function durableWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path);
  const directory = await fs.open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeJournal(path: string, journal: LegacyReconciliationJournal): Promise<void> {
  await durableWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function parseCherry(stdout: string): readonly string[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const line of lines) {
    if (!/^[+-] [0-9a-f]{40}$/.test(line)) {
      throw new ReconciliationRefusal("history-unresolvable", `malformed git cherry output ${JSON.stringify(line)}`);
    }
  }
  return lines;
}

export function classifyLegacyHistory(input: {
  readonly mergeCommits: readonly string[];
  readonly cherry: readonly string[];
}): {
  readonly classification: LegacyReconciliationClassification;
  readonly replayedCommits: readonly string[];
} {
  if (input.mergeCommits.length > 0) {
    throw new ReconciliationRefusal(
      "divergent-merge",
      `legacy-only history contains merge commits: ${input.mergeCommits.join(", ")}`,
    );
  }
  const plus = input.cherry
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2));
  return plus.length === 0
    ? { classification: "upstream-equivalent", replayedCommits: [] }
    : { classification: "linear-unpublished", replayedCommits: plus };
}

export async function assessLegacyReconciliationHistory(
  adapter: LegacyReconciliationObservationAdapter,
  input: {
    readonly repositoryRoot: string;
    readonly baseCommit: string;
    readonly headCommit: string;
  },
): Promise<LegacyReconciliationHistoryAssessment> {
  const observation = await adapter.observeHistory(input);
  if (observation.status === "unresolvable") {
    return {
      status: "refused",
      reason: "history-unresolvable",
      detail: observation.detail,
    };
  }
  try {
    const cherry = parseCherry(observation.cherry.join("\n"));
    const classified = classifyLegacyHistory({
      mergeCommits: observation.mergeCommits,
      cherry,
    });
    return { status: "accepted", ...classified, cherry };
  } catch (error) {
    if (
      error instanceof ReconciliationRefusal &&
      (error.reason === "history-unresolvable" || error.reason === "divergent-merge")
    ) {
      return { status: "refused", reason: error.reason, detail: error.message };
    }
    throw error;
  }
}

export function createGitLegacyReconciliationObservationAdapter(
  git: LegacyReconciliationGitRunner,
  activityFence: LegacyWorktreeActivityFence,
): LegacyReconciliationObservationAdapter {
  return {
    observeActivity: (worktreePath) => activityFence.observe(worktreePath),
    async observeHistory(input) {
      const mergeBase = await git(input.repositoryRoot, [
        "merge-base",
        input.baseCommit,
        input.headCommit,
      ]);
      if (mergeBase.code !== 0 || !FULL_SHA.test(mergeBase.stdout.trim())) {
        return {
          status: "unresolvable",
          detail: `base and legacy HEAD have no resolvable merge base: ${mergeBase.stderr.trim()}`,
        };
      }
      const merges = await git(input.repositoryRoot, [
        "rev-list",
        "--merges",
        `${input.baseCommit}..${input.headCommit}`,
      ]);
      if (merges.code !== 0) {
        return {
          status: "unresolvable",
          detail: `git rev-list failed (${merges.code}): ${merges.stderr.trim()}`,
        };
      }
      const cherry = await git(input.repositoryRoot, [
        "cherry",
        input.baseCommit,
        input.headCommit,
      ]);
      if (cherry.code !== 0) {
        return {
          status: "unresolvable",
          detail: `git cherry failed (${cherry.code}): ${cherry.stderr.trim()}`,
        };
      }
      return {
        status: "observed",
        mergeCommits: merges.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== ""),
        cherry: cherry.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    },
  };
}

async function classifyHistory(
  adapter: LegacyReconciliationObservationAdapter,
  request: LegacyReconciliationJournal["request"],
  refs: CapturedRefs,
): Promise<{
  readonly classification: LegacyReconciliationClassification;
  readonly cherry: readonly string[];
  readonly replayedCommits: readonly string[];
}> {
  const assessed = await assessLegacyReconciliationHistory(adapter, {
    repositoryRoot: request.repositoryRoot,
    baseCommit: refs.base,
    headCommit: refs.head,
  });
  if (assessed.status === "refused") {
    throw new ReconciliationRefusal(assessed.reason, assessed.detail);
  }
  return assessed;
}

async function ensureSafeParent(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
      await fs.rm(current, { recursive: true, force: true });
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
}

async function applyOverlay(
  worktreePath: string,
  entries: readonly LegacyOverlayJournalEntry[],
): Promise<void> {
  for (const entry of entries) {
    const target = join(worktreePath, entry.path);
    await fs.rm(target, { recursive: true, force: true });
    if (entry.type === "deleted") continue;
    await ensureSafeParent(worktreePath, entry.path);
    const bytes = Buffer.from(entry.bytesBase64!, "base64");
    if (entry.type === "file") {
      await fs.writeFile(target, bytes, { mode: entry.mode! });
      await fs.chmod(target, entry.mode!);
    } else {
      await fs.symlink(bytes, target);
    }
  }
}

async function verifyOverlay(
  worktreePath: string,
  expected: readonly LegacyOverlayJournalEntry[],
): Promise<void> {
  const observed = await Promise.all(expected.map((entry) => captureOneOverlayEntry(worktreePath, entry.path)));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new ReconciliationRefusal("overlay-mismatch", "restored overlay does not match the durable journal");
  }
}

function sameGitPathState(left: GitPathState | null, right: GitPathState | null): boolean {
  return left?.mode === right?.mode && left?.oid === right?.oid;
}

function assertSafeOverlayPath(path: string, excludedRelativePaths: readonly string[]): void {
  if (
    path === "" ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../") ||
    isExcludedPath(path, excludedRelativePaths)
  ) {
    throw new Error(`journal contains unsafe overlay path ${path}`);
  }
}

function validateGitPathState(state: unknown, context: string): asserts state is GitPathState | null {
  if (state === null) return;
  if (typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`${context} has an invalid Git state`);
  }
  const record = state as Partial<GitPathState>;
  if (!isGitFileMode(record.mode ?? "") || !FULL_SHA.test(record.oid ?? "")) {
    throw new Error(`${context} has an invalid mode or object`);
  }
}

function validateWorktreePathState(state: unknown, context: string): asserts state is WorktreePathState | null {
  if (state === null) return;
  validateGitPathState(state, context);
  const record = state as Partial<WorktreePathState>;
  if (
    (record.type !== "file" && record.type !== "symlink") ||
    !SHA256.test(record.sha256 ?? "") ||
    typeof record.bytesBase64 !== "string"
  ) {
    throw new Error(`${context} has invalid worktree bytes`);
  }
  if ((record.type === "symlink") !== (record.mode === "120000")) {
    throw new Error(`${context} has inconsistent type and mode`);
  }
  const bytes = Buffer.from(record.bytesBase64, "base64");
  if (sha256(bytes) !== record.sha256 || gitBlobOid(bytes) !== record.oid) {
    throw new Error(`${context} bytes do not match their object guards`);
  }
}

function validateSemanticOverlay(
  value: unknown,
  excludedRelativePaths: readonly string[],
): asserts value is LegacySemanticOverlay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("journal lacks a semantic overlay");
  }
  const overlay = value as Partial<LegacySemanticOverlay>;
  if (
    !Array.isArray(overlay.paths) ||
    !Array.isArray(overlay.staged) ||
    !Array.isArray(overlay.unstaged) ||
    !Array.isArray(overlay.untracked)
  ) {
    throw new Error("journal semantic overlay has invalid layers");
  }
  const validateSortedPaths = (entries: readonly { readonly path: string }[], layer: string): void => {
    let prior: string | null = null;
    for (const entry of entries) {
      if (typeof entry.path !== "string") throw new Error(`${layer} contains an invalid path`);
      assertSafeOverlayPath(entry.path, excludedRelativePaths);
      if (prior !== null && comparePaths(prior, entry.path) >= 0) {
        throw new Error(`${layer} paths are not strictly byte-sorted and unique`);
      }
      prior = entry.path;
    }
  };
  validateSortedPaths(overlay.paths, "semantic preimage");
  validateSortedPaths(overlay.staged, "staged overlay");
  validateSortedPaths(overlay.unstaged, "unstaged overlay");
  validateSortedPaths(overlay.untracked, "untracked overlay");

  const preimages = new Map<string, GitPathState | null>();
  for (const entry of overlay.paths) {
    validateGitPathState(entry.head, `preimage ${entry.path}`);
    preimages.set(entry.path, entry.head);
  }
  const staged = new Map<string, GitPathState | null>();
  for (const entry of overlay.staged) {
    validateGitPathState(entry.before, `staged preimage ${entry.path}`);
    validateGitPathState(entry.after, `staged postimage ${entry.path}`);
    if (!sameGitPathState(entry.before, preimages.get(entry.path) ?? null)) {
      throw new Error(`staged preimage ${entry.path} does not match HEAD`);
    }
    if (sameGitPathState(entry.before, entry.after)) {
      throw new Error(`staged delta ${entry.path} does not change mode or object`);
    }
    staged.set(entry.path, entry.after);
  }
  const layeredPaths = new Set<string>(overlay.staged.map((entry) => entry.path));
  for (const entry of overlay.unstaged) {
    validateGitPathState(entry.before, `unstaged preimage ${entry.path}`);
    validateWorktreePathState(entry.after, `unstaged postimage ${entry.path}`);
    const expectedBefore = staged.has(entry.path)
      ? staged.get(entry.path)!
      : preimages.get(entry.path) ?? null;
    if (!sameGitPathState(entry.before, expectedBefore)) {
      throw new Error(`unstaged preimage ${entry.path} does not match the staged layer`);
    }
    if (sameGitPathState(entry.before, entry.after)) {
      throw new Error(`unstaged delta ${entry.path} does not change mode or object`);
    }
    layeredPaths.add(entry.path);
  }
  for (const entry of overlay.untracked) {
    validateWorktreePathState(entry.after, `untracked postimage ${entry.path}`);
    if (entry.after === null) throw new Error(`untracked path ${entry.path} is deleted`);
    if ((preimages.get(entry.path) ?? null) !== null || layeredPaths.has(entry.path)) {
      throw new Error(`untracked path ${entry.path} collides with a tracked layer`);
    }
    layeredPaths.add(entry.path);
  }
  if (
    overlay.paths.length !== layeredPaths.size ||
    overlay.paths.some((entry) => !layeredPaths.has(entry.path))
  ) {
    throw new Error("semantic preimage paths do not equal the layered path set");
  }
}

async function verifySemanticObjects(
  git: LegacyReconciliationGitRunner,
  repositoryRoot: string,
  overlay: LegacySemanticOverlay,
): Promise<void> {
  const objectIds = new Set<string>();
  for (const entry of overlay.paths) if (entry.head !== null) objectIds.add(entry.head.oid);
  for (const entry of overlay.staged) {
    if (entry.before !== null) objectIds.add(entry.before.oid);
    if (entry.after !== null) objectIds.add(entry.after.oid);
  }
  for (const entry of overlay.unstaged) if (entry.before !== null) objectIds.add(entry.before.oid);
  for (const oid of objectIds) {
    const observed = await git(repositoryRoot, ["cat-file", "-t", oid]);
    if (observed.code !== 0 || observed.stdout.trim() !== "blob") {
      throw new ReconciliationRefusal("overlay-mismatch", `semantic object ${oid} is not an available blob`);
    }
  }
}

async function assertCandidateCompatible(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  candidateHead: string,
  overlay: LegacySemanticOverlay,
): Promise<void> {
  for (const entry of overlay.paths) {
    const candidate = await captureTreePathState(git, cwd, candidateHead, entry.path);
    if (!sameGitPathState(candidate, entry.head)) {
      throw new ReconciliationRefusal(
        "candidate-path-collision",
        `candidate changed touched path ${entry.path} from its captured HEAD preimage`,
      );
    }
  }
}

async function buildCandidateIndexBytes(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  candidateHead: string,
  overlay: LegacySemanticOverlay,
  temporaryRoot: string,
): Promise<Buffer> {
  const temporary = `${temporaryRoot}.cq-candidate-${process.pid}-${Date.now()}`;
  const environment = { GIT_INDEX_FILE: temporary } as const;
  await fs.rm(temporary, { force: true });
  try {
    await runRequired(git, cwd, ["read-tree", candidateHead], "transition-failed", environment);
    for (const entry of overlay.staged) {
      const before = await captureIndexPathState(git, cwd, entry.path, environment);
      if (!sameGitPathState(before, entry.before)) {
        throw new ReconciliationRefusal(
          "candidate-path-collision",
          `candidate index preimage changed for ${entry.path}`,
        );
      }
      if (entry.after === null) {
        await runRequired(
          git,
          cwd,
          ["update-index", "--force-remove", "--", entry.path],
          "transition-failed",
          environment,
        );
      } else {
        await runRequired(
          git,
          cwd,
          ["update-index", "--add", "--cacheinfo", `${entry.after.mode},${entry.after.oid},${entry.path}`],
          "transition-failed",
          environment,
        );
      }
      const installed = await captureIndexPathState(git, cwd, entry.path, environment);
      if (!sameGitPathState(installed, entry.after)) {
        throw new ReconciliationRefusal("overlay-mismatch", `candidate index postimage differs for ${entry.path}`);
      }
    }
    return await fs.readFile(temporary);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function installCandidateIndex(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  candidateHead: string,
  overlay: LegacySemanticOverlay,
  indexPath: string,
): Promise<void> {
  const bytes = await buildCandidateIndexBytes(git, cwd, candidateHead, overlay, indexPath);
  await durableWrite(indexPath, bytes);
}

async function verifySemanticOverlay(
  git: LegacyReconciliationGitRunner,
  worktreePath: string,
  head: string,
  excludedRelativePaths: readonly string[],
  expected: LegacySemanticOverlay,
): Promise<void> {
  const observed = await captureSemanticOverlay(git, worktreePath, head, excludedRelativePaths);
  if (!sameSemanticOverlay(observed, expected)) {
    throw new ReconciliationRefusal("overlay-mismatch", "candidate delta space does not match the durable semantic overlay");
  }
}

function legacyOverlayWorktreeState(entry: LegacyOverlayJournalEntry): WorktreePathState | null {
  if (entry.type === "deleted") return null;
  const bytes = Buffer.from(entry.bytesBase64!, "base64");
  const mode: GitFileMode =
    entry.type === "symlink" ? "120000" : (entry.mode! & 0o111) === 0 ? "100644" : "100755";
  return {
    type: entry.type,
    mode,
    oid: gitBlobOid(bytes),
    sha256: sha256(bytes),
    bytesBase64: entry.bytesBase64!,
  };
}

async function reconstructV1HeadWorktreePostimage(
  git: LegacyReconciliationGitRunner,
  journal: LegacyReconciliationJournal,
  path: string,
): Promise<WorktreePathState | null> {
  const expected = await captureTreePathState(
    git,
    journal.request.worktreePath,
    journal.refs.head,
    path,
  );
  const observed = await captureWorktreePathState(journal.request.worktreePath, path);
  if (!sameGitPathState(expected, observed)) {
    throw new ReconciliationRefusal(
      "overlay-mismatch",
      `post-publication tracked bytes differ from legacy HEAD for ${path}`,
    );
  }
  return observed;
}

async function reconstructV1SemanticOverlay(
  git: LegacyReconciliationGitRunner,
  journal: LegacyReconciliationJournal,
): Promise<LegacySemanticOverlay> {
  const temporary = `${journal.index.path}.cq-v1-repair-${process.pid}-${Date.now()}`;
  await durableWrite(temporary, Buffer.from(journal.index.bytesBase64, "base64"));
  const environment = { GIT_INDEX_FILE: temporary } as const;
  try {
    const stagedRaw = await runRequiredRaw(
      git,
      journal.request.worktreePath,
      ["diff", "--cached", "--name-only", "--no-renames", "-z", journal.refs.head, "--"],
      "overlay-mismatch",
      environment,
    );
    const stagedPaths = parseNulPaths(stagedRaw, journal.request.excludedRelativePaths);
    const legacyEntries = new Map(journal.overlay.map((entry) => [entry.path, entry]));
    const staged = await Promise.all(
      stagedPaths.map(async (path) => ({
        path,
        before: await captureTreePathState(git, journal.request.worktreePath, journal.refs.head, path),
        after: await captureIndexPathState(git, journal.request.worktreePath, path, environment),
      })),
    );
    const unstaged: WorktreePathDelta[] = [];
    const untracked: UntrackedPathEntry[] = [];
    for (const entry of staged) {
      if (legacyEntries.has(entry.path)) continue;
      const after = await reconstructV1HeadWorktreePostimage(git, journal, entry.path);
      unstaged.push({ path: entry.path, before: entry.after, after });
    }
    for (const entry of journal.overlay) {
      const head = await captureTreePathState(
        git,
        journal.request.worktreePath,
        journal.refs.head,
        entry.path,
      );
      const index = await captureIndexPathState(
        git,
        journal.request.worktreePath,
        entry.path,
        environment,
      );
      const after = legacyOverlayWorktreeState(entry);
      if (head === null && index === null) {
        if (after === null) throw new ReconciliationRefusal("overlay-mismatch", `v1 untracked path ${entry.path} is deleted`);
        untracked.push({ path: entry.path, after });
      } else if (!sameGitPathState(index, after)) {
        unstaged.push({ path: entry.path, before: index, after });
      }
    }
    unstaged.sort((left, right) => comparePaths(left.path, right.path));
    untracked.sort((left, right) => comparePaths(left.path, right.path));
    const allPaths = [...new Set([
      ...staged.map((entry) => entry.path),
      ...unstaged.map((entry) => entry.path),
      ...untracked.map((entry) => entry.path),
    ])].sort(comparePaths);
    const paths = await Promise.all(
      allPaths.map(async (path) => ({
        path,
        head: await captureTreePathState(git, journal.request.worktreePath, journal.refs.head, path),
      })),
    );
    const semanticOverlay = { paths, staged, unstaged, untracked };
    validateSemanticOverlay(semanticOverlay, journal.request.excludedRelativePaths);
    return semanticOverlay;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function verifyCandidateWorktreeForV1Repair(
  git: LegacyReconciliationGitRunner,
  journal: LegacyReconciliationJournal,
  semanticOverlay: LegacySemanticOverlay,
  candidateIndexBytes: Uint8Array,
): Promise<void> {
  const temporary = `${journal.index.path}.cq-v1-probe-${process.pid}-${Date.now()}`;
  await durableWrite(temporary, candidateIndexBytes);
  const environment = { GIT_INDEX_FILE: temporary } as const;
  try {
    const trackedRaw = await runRequiredRaw(
      git,
      journal.request.worktreePath,
      ["diff", "--name-only", "--no-renames", "-z", "--"],
      "overlay-mismatch",
      environment,
    );
    const trackedPaths = parseNulPaths(trackedRaw, journal.request.excludedRelativePaths);
    const expectedTrackedPaths = semanticOverlay.unstaged.map((entry) => entry.path);
    if (JSON.stringify(trackedPaths) !== JSON.stringify(expectedTrackedPaths)) {
      throw new ReconciliationRefusal(
        "overlay-mismatch",
        "post-publication tracked paths differ from the committed v1 journal",
      );
    }
    for (const entry of semanticOverlay.unstaged) {
      const observed = await captureWorktreePathState(journal.request.worktreePath, entry.path);
      if (JSON.stringify(observed) !== JSON.stringify(entry.after)) {
        throw new ReconciliationRefusal("overlay-mismatch", `post-publication tracked bytes differ for ${entry.path}`);
      }
    }

    const untrackedRaw = await runRequiredRaw(
      git,
      journal.request.worktreePath,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      "overlay-mismatch",
      environment,
    );
    const untrackedPaths = parseNulPaths(untrackedRaw, journal.request.excludedRelativePaths);
    const semanticPaths = new Set(semanticOverlay.paths.map((entry) => entry.path));
    const journaledUntracked = new Map(semanticOverlay.untracked.map((entry) => [entry.path, entry.after]));
    for (const [path, expected] of journaledUntracked) {
      if (!untrackedPaths.includes(path)) {
        throw new ReconciliationRefusal("overlay-mismatch", `journaled untracked path ${path} is missing`);
      }
      const observed = await captureWorktreePathState(journal.request.worktreePath, path);
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        throw new ReconciliationRefusal("overlay-mismatch", `journaled untracked bytes differ for ${path}`);
      }
    }
    for (const path of untrackedPaths) {
      if (journaledUntracked.has(path)) continue;
      if (semanticPaths.has(path)) {
        throw new ReconciliationRefusal("overlay-mismatch", `additional untracked path collides with ${path}`);
      }
      await captureWorktreePathState(journal.request.worktreePath, path);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function verifyInstalledCandidateIndexForV1Repair(
  git: LegacyReconciliationGitRunner,
  journal: LegacyReconciliationJournal,
  semanticOverlay: LegacySemanticOverlay,
): Promise<void> {
  const stagedRaw = await runRequiredRaw(
    git,
    journal.request.worktreePath,
    ["diff", "--cached", "--name-only", "--no-renames", "-z", journal.candidateHead!, "--"],
    "overlay-mismatch",
  );
  const stagedPaths = parseNulPaths(stagedRaw, journal.request.excludedRelativePaths);
  const expectedPaths = semanticOverlay.staged.map((entry) => entry.path);
  if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
    throw new ReconciliationRefusal("overlay-mismatch", "installed candidate index has different staged paths");
  }
  for (const entry of semanticOverlay.staged) {
    const installed = await captureIndexPathState(git, journal.request.worktreePath, entry.path);
    if (!sameGitPathState(installed, entry.after)) {
      throw new ReconciliationRefusal("overlay-mismatch", `installed candidate index differs for ${entry.path}`);
    }
  }
}

async function deterministicReplayEnvironment(
  git: LegacyReconciliationGitRunner,
  cwd: string,
  commit: string,
): Promise<Readonly<Record<string, string>>> {
  const identity = await runRequiredRaw(
    git,
    cwd,
    ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit],
    "history-unresolvable",
  );
  const fields = identity.replace(/\r?\n$/, "").split("\0");
  if (fields.length !== 6 || fields.some((field) => field === "")) {
    throw new ReconciliationRefusal(
      "history-unresolvable",
      `commit ${commit} has incomplete deterministic identity metadata`,
    );
  }
  return {
    GIT_AUTHOR_NAME: fields[0]!,
    GIT_AUTHOR_EMAIL: fields[1]!,
    GIT_AUTHOR_DATE: fields[2]!,
    GIT_COMMITTER_NAME: fields[3]!,
    GIT_COMMITTER_EMAIL: fields[4]!,
    GIT_COMMITTER_DATE: fields[5]!,
  };
}

async function buildCandidateOffPath(
  git: LegacyReconciliationGitRunner,
  request: LegacyReconciliationJournal["request"],
  transactionId: string,
  classification: LegacyReconciliationClassification,
  replayedCommits: readonly string[],
  overlay: readonly LegacyOverlayJournalEntry[],
  semanticOverlay: LegacySemanticOverlay,
): Promise<{ readonly buildPath: string; readonly candidateHead: string }> {
  const buildPath = candidateBuildPath(request.journalDirectory, transactionId);
  await fs.rm(buildPath, { recursive: true, force: true });
  await fs.mkdir(dirname(buildPath), { recursive: true });
  await runRequired(
    git,
    request.repositoryRoot,
    ["clone", "--quiet", "--no-checkout", "--no-local", request.repositoryRoot, buildPath],
    "history-unresolvable",
  );
  await runRequired(git, buildPath, ["checkout", "--quiet", "--detach", request.baseCommit], "history-unresolvable");
  await runRequired(git, buildPath, ["config", "commit.gpgSign", "false"], "history-unresolvable");
  await runRequired(git, buildPath, ["config", "core.hooksPath", "/dev/null"], "history-unresolvable");
  await runRequired(git, buildPath, ["config", "rerere.enabled", "false"], "history-unresolvable");
  if (classification === "linear-unpublished") {
    for (const commit of replayedCommits) {
      const replayEnvironment = await deterministicReplayEnvironment(git, buildPath, commit);
      const cherryPick = await git(buildPath, ["cherry-pick", commit], replayEnvironment);
      if (cherryPick.code !== 0) {
        await git(buildPath, ["cherry-pick", "--abort"]);
        throw new ReconciliationRefusal(
          "replay-conflict",
          `replay of ${commit} failed: ${cherryPick.stderr.trim() || cherryPick.stdout.trim()}`,
        );
      }
    }
  }
  const candidateHead = await resolveCommit(git, buildPath, "HEAD");
  if (candidateHead === null) {
    throw new ReconciliationRefusal("history-unresolvable", "off-path candidate HEAD is missing");
  }
  await assertCandidateCompatible(git, buildPath, candidateHead, semanticOverlay);
  await applyOverlay(buildPath, overlay);
  await verifyOverlay(buildPath, overlay);
  return { buildPath, candidateHead };
}

async function importCandidate(
  git: LegacyReconciliationGitRunner,
  journal: LegacyReconciliationJournal,
  buildPath: string,
): Promise<void> {
  const candidateHead = journal.candidateHead!;
  if (candidateHead === journal.refs.base) {
    await runRequired(
      git,
      journal.request.repositoryRoot,
      ["update-ref", journal.refs.candidateRef, candidateHead, ZERO_SHA],
      "transition-failed",
    );
    return;
  }
  await runRequired(git, buildPath, ["update-ref", "refs/heads/cq-candidate", candidateHead], "transition-failed");
  await runRequired(
    git,
    journal.request.repositoryRoot,
    ["fetch", "--quiet", "--no-write-fetch-head", buildPath, `refs/heads/cq-candidate:${journal.refs.candidateRef}`],
    "transition-failed",
  );
  const imported = await resolveCommit(git, journal.request.repositoryRoot, journal.refs.candidateRef);
  if (imported !== candidateHead) {
    throw new ReconciliationRefusal("transition-failed", `candidate import resolved ${String(imported)}, expected ${candidateHead}`);
  }
}

async function restoreIndex(index: CapturedIndex): Promise<void> {
  await durableWrite(index.path, Buffer.from(index.bytesBase64, "base64"));
}

async function verifyIndex(index: CapturedIndex): Promise<void> {
  const observed = sha256(await fs.readFile(index.path));
  if (observed !== index.sha256) {
    throw new ReconciliationRefusal("overlay-mismatch", `index digest ${observed} does not match ${index.sha256}`);
  }
}

async function deleteRefIfValue(
  git: LegacyReconciliationGitRunner,
  repositoryRoot: string,
  ref: string,
  expected: string,
): Promise<void> {
  const value = await resolveRef(git, repositoryRoot, ref);
  if (value === null) return;
  if (value !== expected) {
    throw new Error(`ref ${ref} changed from expected ${expected} to ${value}`);
  }
  const deleted = await git(repositoryRoot, ["update-ref", "-d", ref, expected]);
  if (deleted.code !== 0) throw new Error(`failed to delete ${ref}: ${deleted.stderr.trim()}`);
}

async function rollbackJournalState(
  git: LegacyReconciliationGitRunner,
  path: string,
  journal: LegacyReconciliationJournal,
): Promise<LegacyReconciliationJournal> {
  const candidateHead = journal.candidateHead ?? journal.refs.base;
  const rawIndexPath = await runRequired(
    git,
    journal.request.worktreePath,
    ["rev-parse", "--git-path", "index"],
    "rollback-failed",
  );
  const actualIndexPath = isAbsolute(rawIndexPath)
    ? resolve(rawIndexPath)
    : resolve(journal.request.worktreePath, rawIndexPath);
  if (actualIndexPath !== resolve(journal.index.path)) {
    throw new ReconciliationRefusal(
      "rollback-failed",
      `journal index path ${journal.index.path} does not match worktree index ${actualIndexPath}`,
    );
  }
  const branchValue = await resolveRef(git, journal.request.repositoryRoot, journal.refs.branchRef);
  if (branchValue === candidateHead) {
    await runRequired(
      git,
      journal.request.repositoryRoot,
      ["update-ref", journal.refs.branchRef, journal.refs.head, candidateHead],
      "rollback-failed",
    );
  } else if (branchValue !== journal.refs.head) {
    throw new ReconciliationRefusal(
      "rollback-failed",
      `branch changed outside transaction: observed ${String(branchValue)}, expected ${candidateHead} or ${journal.refs.head}`,
    );
  }
  await runRequired(git, journal.request.worktreePath, ["clean", "-f", "-d"], "rollback-failed");
  await runRequired(git, journal.request.worktreePath, ["reset", "--hard", journal.refs.head], "rollback-failed");
  await restoreIndex(journal.index);
  await applyOverlay(journal.request.worktreePath, journal.overlay);
  await verifyIndex(journal.index);
  await verifyOverlay(journal.request.worktreePath, journal.overlay);
  const restoredHead = await resolveCommit(git, journal.request.worktreePath, "HEAD");
  if (restoredHead !== journal.refs.head) {
    throw new ReconciliationRefusal("rollback-failed", `restored HEAD ${String(restoredHead)} does not equal ${journal.refs.head}`);
  }
  const rolledBack: LegacyReconciliationJournal = { ...journal, phase: "rolled-back" };
  await writeJournal(path, rolledBack);
  await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.recoveryRef, journal.refs.head);
  await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.candidateRef, candidateHead);
  return rolledBack;
}

function evidenceFromJournal(journal: LegacyReconciliationJournal, path: string): LegacyWorktreeReconciliationEvidence {
  return {
    transactionId: journal.transactionId,
    journalPath: path,
    recoveryRef: journal.refs.recoveryRef,
    candidateRef: journal.refs.candidateRef,
    oldHead: journal.refs.head,
    candidateHead: journal.candidateHead!,
    classification: journal.classification!,
    cherry: journal.cherry!,
    replayedCommits: journal.replayedCommits!,
    overlaySha256: journal.overlaySha256,
    overlayEntries: journal.overlay,
    wipArtifacts: journal.wipArtifacts,
    activity: {
      captured: journal.capturedActivity,
      journaled: journal.journaledActivity!,
      transition: journal.transitionActivity!,
      postTransition: journal.postTransitionActivity!,
    },
  };
}

class ActiveLegacyReconciliationTransaction implements LegacyWorktreeReconciliationTransaction {
  private terminal: "committed" | "rolled-back" | null = null;
  private released = false;

  constructor(
    readonly evidence: LegacyWorktreeReconciliationEvidence,
    private journal: LegacyReconciliationJournal,
    private readonly path: string,
    private readonly git: LegacyReconciliationGitRunner,
    private readonly releaseLock: () => Promise<void>,
    private readonly fault: LegacyReconciliationFaultInjector,
  ) {}

  private async releaseOnce(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseLock();
  }

  async commit(): Promise<{ readonly status: "committed"; readonly idempotent: boolean }> {
    if (this.terminal !== null) {
      if (this.terminal !== "committed") throw new Error("reconciliation already rolled back");
      return { status: "committed", idempotent: true };
    }
    try {
      await this.fault("before-commit", { transactionId: this.journal.transactionId });
      const branch = await resolveRef(this.git, this.journal.request.repositoryRoot, this.journal.refs.branchRef);
      if (branch !== this.journal.candidateHead) {
        throw new Error(`cannot commit: branch is ${String(branch)}, expected ${this.journal.candidateHead}`);
      }
      const recovery = await resolveRef(this.git, this.journal.request.repositoryRoot, this.journal.refs.recoveryRef);
      if (recovery !== this.journal.refs.head) {
        throw new Error(`cannot commit: recovery ref is ${String(recovery)}, expected ${this.journal.refs.head}`);
      }
      const committed: LegacyReconciliationJournal = { ...this.journal, phase: "committed" };
      await writeJournal(this.path, committed);
      this.journal = committed;
      await deleteRefIfValue(this.git, this.journal.request.repositoryRoot, this.journal.refs.recoveryRef, this.journal.refs.head);
      await deleteRefIfValue(this.git, this.journal.request.repositoryRoot, this.journal.refs.candidateRef, this.journal.candidateHead!);
      this.terminal = "committed";
      return { status: "committed", idempotent: false };
    } catch (error) {
      if (this.journal.phase !== "committed") {
        try {
          this.journal = await rollbackJournalState(this.git, this.path, this.journal);
          this.terminal = "rolled-back";
        } catch (rollbackError) {
          throw new Error(
            `commit failed (${error instanceof Error ? error.message : String(error)}); rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
          );
        }
      }
      throw error;
    } finally {
      await this.releaseOnce();
    }
  }

  async rollback(): Promise<{ readonly status: "rolled-back"; readonly idempotent: boolean }> {
    if (this.terminal !== null) {
      if (this.terminal !== "rolled-back") throw new Error("reconciliation already committed");
      return { status: "rolled-back", idempotent: true };
    }
    try {
      let boundaryError: unknown = null;
      try {
        await this.fault("before-rollback", { transactionId: this.journal.transactionId });
      } catch (error) {
        boundaryError = error;
      }
      this.journal = await rollbackJournalState(this.git, this.path, this.journal);
      this.terminal = "rolled-back";
      if (boundaryError !== null) throw boundaryError;
      return { status: "rolled-back", idempotent: false };
    } finally {
      await this.releaseOnce();
    }
  }
}

function refusal(
  reason: BeginLegacyWorktreeReconciliationRefusalReason,
  detail: string,
  restored: boolean,
): BeginLegacyWorktreeReconciliationResult {
  return { status: "refused", reason, detail, restored };
}

export async function beginLegacyWorktreeReconciliation(
  input: BeginLegacyWorktreeReconciliationRequest,
  deps: LegacyWorktreeReconciliationDeps,
): Promise<BeginLegacyWorktreeReconciliationResult> {
  const request = canonicalRequest(input);
  const git = deps.git ?? nodeLegacyReconciliationGitRunner;
  const observationAdapter =
    deps.observationAdapter ??
    createGitLegacyReconciliationObservationAdapter(git, deps.activityFence);
  const fault = deps.faultInjector ?? (async () => undefined);
  const path = journalPath(request.journalDirectory, input.transactionId);
  let releaseLock: (() => Promise<void>) | null = null;
  let journal: LegacyReconciliationJournal | null = null;
  let buildPath: string | null = null;
  let sourceMutationStarted = false;
  try {
    validateRequest(request, input.transactionId);
    releaseLock = await deps.managerLock.acquire(request.worktreePath);
    try {
      await fs.access(path);
      throw new ReconciliationRefusal("transaction-exists", `journal already exists at ${path}`);
    } catch (error) {
      if (error instanceof ReconciliationRefusal) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const capturedAssessment = await assessLegacyReconciliationActivity(
      observationAdapter,
      request.worktreePath,
      null,
    );
    if (capturedAssessment.status === "refused") {
      throw new ReconciliationRefusal(capturedAssessment.reason, capturedAssessment.detail);
    }
    const capturedActivity = capturedAssessment.observation;
    const refs = await captureRefs(request, input.transactionId, git);
    const overlay = await captureOverlay(git, request.worktreePath, request.excludedRelativePaths);
    const semanticOverlay = await captureSemanticOverlay(
      git,
      request.worktreePath,
      refs.head,
      request.excludedRelativePaths,
    );
    validateSemanticOverlay(semanticOverlay, request.excludedRelativePaths);
    await verifySemanticObjects(git, request.repositoryRoot, semanticOverlay);
    const index = await captureIndex(git, request.worktreePath);
    await fault("after-capture", { transactionId: input.transactionId, oldHead: refs.head });
    const wipArtifacts = await listWipArtifacts(request.worktreePath);
    journal = {
      version: JOURNAL_VERSION,
      transactionId: input.transactionId,
      request,
      refs,
      index,
      overlay,
      overlaySha256: overlayDigest(overlay),
      semanticOverlay,
      semanticOverlaySha256: semanticOverlayDigest(semanticOverlay),
      wipArtifacts,
      capturedActivity,
      phase: "captured",
    };
    await writeJournal(path, journal);
    await fault("after-journal-durable", { transactionId: input.transactionId, overlaySha256: journal.overlaySha256 });
    const journaledAssessment = await assessLegacyReconciliationActivity(
      observationAdapter,
      request.worktreePath,
      capturedActivity,
    );
    if (journaledAssessment.status === "refused") {
      throw new ReconciliationRefusal(journaledAssessment.reason, journaledAssessment.detail);
    }
    const journaledActivity = journaledAssessment.observation;
    const classified = await classifyHistory(observationAdapter, request, refs);
    await fault("after-classification", { transactionId: input.transactionId, classification: classified.classification });
    const built = await buildCandidateOffPath(
      git,
      request,
      input.transactionId,
      classified.classification,
      classified.replayedCommits,
      overlay,
      semanticOverlay,
    );
    buildPath = built.buildPath;
    await fault("after-candidate-overlay", { transactionId: input.transactionId, candidateHead: built.candidateHead });
    journal = {
      ...journal,
      phase: "candidate-ready",
      classification: classified.classification,
      cherry: classified.cherry,
      replayedCommits: classified.replayedCommits,
      candidateHead: built.candidateHead,
      journaledActivity,
    };
    await writeJournal(path, journal);
    const transitionAssessment = await assessLegacyReconciliationActivity(
      observationAdapter,
      request.worktreePath,
      capturedActivity,
    );
    if (transitionAssessment.status === "refused") {
      throw new ReconciliationRefusal(transitionAssessment.reason, transitionAssessment.detail);
    }
    const transitionActivity = transitionAssessment.observation;
    journal = { ...journal, phase: "transition-ready", transitionActivity };
    await writeJournal(path, journal);
    const guardedHead = await resolveCommit(git, request.worktreePath, "HEAD");
    const guardedBranch = await resolveRef(git, request.repositoryRoot, refs.branchRef);
    const guardedRecovery = await resolveRef(git, request.repositoryRoot, refs.recoveryRef);
    const guardedCandidate = await resolveRef(git, request.repositoryRoot, refs.candidateRef);
    if (
      guardedHead !== refs.head ||
      guardedBranch !== refs.head ||
      guardedRecovery !== refs.recoveryValue ||
      guardedCandidate !== refs.candidateValue
    ) {
      throw new ReconciliationRefusal(
        "activity-changed",
        "HEAD, branch, recovery, or candidate ref changed before transition",
      );
    }
    await verifyIndex(index);
    await verifyOverlay(request.worktreePath, overlay);
    const guardedSemanticOverlay = await captureSemanticOverlay(
      git,
      request.worktreePath,
      refs.head,
      request.excludedRelativePaths,
    );
    if (!sameSemanticOverlay(guardedSemanticOverlay, semanticOverlay)) {
      throw new ReconciliationRefusal("activity-changed", "semantic overlay changed before transition");
    }
    await fault("before-first-mutation", { transactionId: input.transactionId, candidateHead: built.candidateHead });

    sourceMutationStarted = true;
    await importCandidate(git, journal, buildPath);
    await fault("after-candidate-import", { transactionId: input.transactionId, candidateRef: refs.candidateRef });
    await runRequired(
      git,
      request.repositoryRoot,
      ["update-ref", refs.recoveryRef, refs.head, ZERO_SHA],
      "transition-failed",
    );
    await fault("after-recovery-ref", { transactionId: input.transactionId, recoveryRef: refs.recoveryRef });
    await runRequired(
      git,
      request.repositoryRoot,
      ["update-ref", refs.branchRef, built.candidateHead, refs.head],
      "transition-failed",
    );
    await fault("after-head-cas", { transactionId: input.transactionId, oldHead: refs.head, candidateHead: built.candidateHead });
    await runRequired(git, request.worktreePath, ["clean", "-f", "-d"], "transition-failed");
    await runRequired(git, request.worktreePath, ["reset", "--hard", built.candidateHead], "transition-failed");
    await fault("after-reset", { transactionId: input.transactionId });
    await installCandidateIndex(
      git,
      request.worktreePath,
      built.candidateHead,
      semanticOverlay,
      index.path,
    );
    await applyOverlay(request.worktreePath, overlay);
    await fault("after-overlay-restore", { transactionId: input.transactionId, overlaySha256: journal.overlaySha256 });
    await verifyOverlay(request.worktreePath, overlay);
    await verifySemanticOverlay(
      git,
      request.worktreePath,
      built.candidateHead,
      request.excludedRelativePaths,
      semanticOverlay,
    );
    const transitionedHead = await resolveCommit(git, request.worktreePath, "HEAD");
    if (transitionedHead !== built.candidateHead) {
      throw new ReconciliationRefusal(
        "transition-failed",
        `transitioned HEAD ${String(transitionedHead)} does not equal candidate ${built.candidateHead}`,
      );
    }
    // The pre-transition fence protects the mutation window. Once the candidate
    // has become live, its index/overlay are intentionally different from the
    // legacy state, so all later adoption checks must compare to this distinct
    // production-Git baseline instead of the legacy snapshot.
    const postTransitionAssessment = await assessLegacyReconciliationActivity(
      observationAdapter,
      request.worktreePath,
      null,
    );
    if (postTransitionAssessment.status === "refused") {
      throw new ReconciliationRefusal(postTransitionAssessment.reason, postTransitionAssessment.detail);
    }
    const postTransitionActivity = postTransitionAssessment.observation;
    journal = {
      ...journal,
      phase: "reconciled",
      transitionActivity,
      postTransitionActivity,
    };
    await writeJournal(path, journal);
    await fault("after-reconciled-journal", { transactionId: input.transactionId });
    await fs.rm(buildPath, { recursive: true, force: true });
    buildPath = null;
    const evidence = evidenceFromJournal(journal, path);
    const transaction = new ActiveLegacyReconciliationTransaction(
      evidence,
      journal,
      path,
      git,
      releaseLock,
      fault,
    );
    releaseLock = null;
    return { status: "reconciled", evidence, transaction };
  } catch (error) {
    let restored = !sourceMutationStarted;
    let rollbackError: unknown = null;
    if (sourceMutationStarted && journal !== null) {
      try {
        journal = await rollbackJournalState(git, path, journal);
        restored = true;
      } catch (caught) {
        rollbackError = caught;
      }
    } else if (journal !== null) {
      try {
        journal = { ...journal, phase: "rolled-back" };
        await writeJournal(path, journal);
      } catch {
        // The source remains unmodified; preserve the original refusal detail.
      }
    }
    if (buildPath !== null) await fs.rm(buildPath, { recursive: true, force: true }).catch(() => undefined);
    if (releaseLock !== null) await releaseLock();
    if (rollbackError !== null) {
      return refusal(
        "rollback-failed",
        `reconciliation failed (${error instanceof Error ? error.message : String(error)}); rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
        false,
      );
    }
    if (error instanceof ReconciliationRefusal) return refusal(error.reason, error.message, restored);
    return refusal("transition-failed", error instanceof Error ? error.message : String(error), restored);
  }
}

function isJournal(value: unknown): value is LegacyReconciliationJournal {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<LegacyReconciliationJournal>;
  return (
    (record.version === LEGACY_JOURNAL_VERSION || record.version === JOURNAL_VERSION) &&
    typeof record.transactionId === "string" &&
    typeof record.phase === "string" &&
    record.request !== undefined &&
    record.refs !== undefined &&
    record.index !== undefined &&
    Array.isArray(record.overlay)
  );
}

function isActivityObservation(value: unknown): value is LegacyWorktreeActivityObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["epoch"] === "string" &&
    typeof record["contentToken"] === "string" &&
    ["liveDispatches", "liveLeases", "liveProcesses"].every((key) =>
      Array.isArray(record[key]) && record[key].every((item) => typeof item === "string"),
    )
  );
}

function validatePersistedJournal(
  journal: LegacyReconciliationJournal,
  expectedJournalDirectory: string,
): void {
  validateRequest(journal.request, journal.transactionId);
  if (resolve(journal.request.journalDirectory) !== resolve(expectedJournalDirectory)) {
    throw new Error("journal directory does not match the recovery request");
  }
  if (
    journal.refs.head !== journal.request.expectedHead ||
    journal.refs.base !== journal.request.baseCommit ||
    journal.refs.branchRef !== `refs/heads/${journal.request.branch}` ||
    journal.refs.recoveryRef !== recoveryRefFor(journal.transactionId) ||
    journal.refs.candidateRef !== candidateRefFor(journal.transactionId) ||
    journal.refs.recoveryValue !== null ||
    journal.refs.candidateValue !== null
  ) {
    throw new Error("journal ref snapshot does not match its request");
  }
  if (!FULL_SHA.test(journal.refs.head) || !FULL_SHA.test(journal.refs.base)) {
    throw new Error("journal contains an invalid captured commit");
  }
  if (journal.candidateHead !== undefined && !FULL_SHA.test(journal.candidateHead)) {
    throw new Error("journal contains an invalid candidate commit");
  }
  const phases: readonly JournalPhase[] = [
    "captured",
    "candidate-ready",
    "transition-ready",
    "reconciled",
    "committed",
    "rolled-back",
  ];
  if (!phases.includes(journal.phase)) throw new Error(`journal contains invalid phase ${journal.phase}`);
  const indexBytes = Buffer.from(journal.index.bytesBase64, "base64");
  if (sha256(indexBytes) !== journal.index.sha256) {
    throw new Error("journal index bytes do not match their SHA-256 digest");
  }
  let priorPath: string | null = null;
  for (const entry of journal.overlay) {
    if (
      entry.path === "" ||
      isAbsolute(entry.path) ||
      entry.path === ".." ||
      entry.path.startsWith("../") ||
      entry.path.includes("/../") ||
      isExcludedPath(entry.path, journal.request.excludedRelativePaths)
    ) {
      throw new Error(`journal contains unsafe overlay path ${entry.path}`);
    }
    if (priorPath !== null && comparePaths(priorPath, entry.path) >= 0) {
      throw new Error("journal overlay paths are not strictly byte-sorted and unique");
    }
    priorPath = entry.path;
    if (entry.type === "deleted") {
      if (entry.mode !== null || entry.bytesBase64 !== null || entry.sha256 !== sha256("")) {
        throw new Error(`journal deletion entry ${entry.path} has bytes or mode`);
      }
      continue;
    }
    if (entry.mode === null || entry.bytesBase64 === null) {
      throw new Error(`journal entry ${entry.path} lacks bytes or mode`);
    }
    if (sha256(Buffer.from(entry.bytesBase64, "base64")) !== entry.sha256) {
      throw new Error(`journal entry ${entry.path} bytes do not match SHA-256`);
    }
  }
  if (overlayDigest(journal.overlay) !== journal.overlaySha256) {
    throw new Error("journal overlay digest does not match its entries");
  }
  if (journal.version === JOURNAL_VERSION) {
    validateSemanticOverlay(journal.semanticOverlay, journal.request.excludedRelativePaths);
    if (
      typeof journal.semanticOverlaySha256 !== "string" ||
      semanticOverlayDigest(journal.semanticOverlay) !== journal.semanticOverlaySha256
    ) {
      throw new Error("journal semantic overlay digest does not match its layers");
    }
  }
  if (journal.repair !== undefined) {
    if (
      journal.version !== LEGACY_JOURNAL_VERSION ||
      journal.phase !== "committed" ||
      journal.repair.version !== 1 ||
      journal.repair.status !== "installed" ||
      !SHA256.test(journal.repair.candidateIndexSha256) ||
      typeof journal.repair.repairedAt !== "string"
    ) {
      throw new Error("journal contains an invalid v1 repair outcome");
    }
    validateSemanticOverlay(journal.repair.semanticOverlay, journal.request.excludedRelativePaths);
    if (
      semanticOverlayDigest(journal.repair.semanticOverlay) !==
      journal.repair.semanticOverlaySha256
    ) {
      throw new Error("journal v1 repair digest does not match its semantic overlay");
    }
  }
  if (!isActivityObservation(journal.capturedActivity)) {
    throw new Error("journal contains an invalid captured activity observation");
  }
  if (
    journal.phase !== "captured" &&
    !isActivityObservation(journal.journaledActivity)
  ) {
    throw new Error("journal phase requires a valid journaled activity observation");
  }
  if (
    ["transition-ready", "reconciled", "committed"].includes(journal.phase) &&
    !isActivityObservation(journal.transitionActivity)
  ) {
    throw new Error("journal phase requires a valid pre-transition activity observation");
  }
  if (
    ["reconciled", "committed"].includes(journal.phase) &&
    !isActivityObservation(journal.postTransitionActivity)
  ) {
    throw new Error("journal phase requires a valid post-transition activity observation");
  }
}

async function repairCommittedV1Journal(
  git: LegacyReconciliationGitRunner,
  observationAdapter: LegacyReconciliationObservationAdapter,
  path: string,
  journal: LegacyReconciliationJournal,
  expected: NonNullable<RecoverLegacyWorktreeReconciliationRequest["repairPublishedV1"]>,
): Promise<Extract<RecoverLegacyWorktreeReconciliationResult, { readonly status: "recovered" }>> {
  if (
    journal.version !== LEGACY_JOURNAL_VERSION ||
    journal.phase !== "committed" ||
    journal.request.repositoryRoot !== resolve(expected.repositoryRoot) ||
    journal.request.worktreePath !== resolve(expected.worktreePath) ||
    journal.request.branch !== expected.branch ||
    journal.request.baseCommit !== expected.baseCommit ||
    journal.refs.head !== expected.legacyHead ||
    journal.candidateHead !== expected.candidateHead
  ) {
    throw new Error("published handle identity does not agree with the committed v1 journal");
  }
  if (
    !FULL_SHA.test(expected.baseCommit) ||
    !FULL_SHA.test(expected.legacyHead) ||
    !FULL_SHA.test(expected.candidateHead)
  ) {
    throw new Error("published handle repair expectation contains an invalid commit");
  }

  const firstActivity = await observationAdapter.observeActivity(journal.request.worktreePath);
  assertQuiescent(firstActivity);
  if (firstActivity.epoch !== journal.postTransitionActivity!.epoch) {
    throw new ReconciliationRefusal("activity-changed", "published v1 worktree epoch differs from its journal");
  }
  const observedHead = await resolveCommit(git, journal.request.worktreePath, "HEAD");
  const branch = await resolveRef(git, journal.request.repositoryRoot, journal.refs.branchRef);
  const recovery = await resolveRef(git, journal.request.repositoryRoot, journal.refs.recoveryRef);
  const candidate = await resolveRef(git, journal.request.repositoryRoot, journal.refs.candidateRef);
  if (
    observedHead !== expected.candidateHead ||
    branch !== expected.candidateHead ||
    recovery !== null ||
    candidate !== null
  ) {
    throw new Error("published v1 HEAD, branch, or transaction refs differ from the journal");
  }
  const rawIndexPath = await runRequired(
    git,
    journal.request.worktreePath,
    ["rev-parse", "--git-path", "index"],
    "overlay-mismatch",
  );
  const actualIndexPath = isAbsolute(rawIndexPath)
    ? resolve(rawIndexPath)
    : resolve(journal.request.worktreePath, rawIndexPath);
  if (actualIndexPath !== resolve(journal.index.path)) {
    throw new Error("published v1 index path differs from the journal");
  }

  const semanticOverlay = await reconstructV1SemanticOverlay(git, journal);
  await verifySemanticObjects(git, journal.request.repositoryRoot, semanticOverlay);
  await assertCandidateCompatible(git, journal.request.repositoryRoot, expected.candidateHead, semanticOverlay);
  const candidateIndexBytes = await buildCandidateIndexBytes(
    git,
    journal.request.worktreePath,
    expected.candidateHead,
    semanticOverlay,
    journal.index.path,
  );
  const candidateIndexSha256 = sha256(candidateIndexBytes);
  if (journal.repair !== undefined) {
    if (
      !sameSemanticOverlay(journal.repair.semanticOverlay, semanticOverlay) ||
      journal.repair.semanticOverlaySha256 !== semanticOverlayDigest(semanticOverlay) ||
      journal.repair.candidateIndexSha256 !== candidateIndexSha256
    ) {
      throw new Error("published v1 repair outcome differs from reconstructed semantics");
    }
  }
  const currentIndexSha256 = sha256(await fs.readFile(journal.index.path));
  const staleIndexInstalled = currentIndexSha256 === journal.index.sha256;
  if (!staleIndexInstalled) {
    try {
      await verifyInstalledCandidateIndexForV1Repair(git, journal, semanticOverlay);
    } catch {
      throw new Error("installed index matches neither the journaled stale index nor the repaired candidate semantics");
    }
  }
  await verifyCandidateWorktreeForV1Repair(git, journal, semanticOverlay, candidateIndexBytes);

  const secondActivity = await observationAdapter.observeActivity(journal.request.worktreePath);
  assertSameActivity(firstActivity, secondActivity);
  const guardedHead = await resolveCommit(git, journal.request.worktreePath, "HEAD");
  const guardedBranch = await resolveRef(git, journal.request.repositoryRoot, journal.refs.branchRef);
  const guardedIndexSha256 = sha256(await fs.readFile(journal.index.path));
  if (
    guardedHead !== expected.candidateHead ||
    guardedBranch !== expected.candidateHead ||
    guardedIndexSha256 !== currentIndexSha256
  ) {
    throw new ReconciliationRefusal("activity-changed", "published v1 HEAD, branch, or index changed during repair");
  }
  await verifyCandidateWorktreeForV1Repair(git, journal, semanticOverlay, candidateIndexBytes);

  const alreadyRecorded = journal.repair !== undefined;
  if (staleIndexInstalled) {
    await durableWrite(journal.index.path, candidateIndexBytes);
  }
  await verifyInstalledCandidateIndexForV1Repair(git, journal, semanticOverlay);
  await verifyCandidateWorktreeForV1Repair(git, journal, semanticOverlay, candidateIndexBytes);
  if (!alreadyRecorded) {
    const repaired: LegacyReconciliationJournal = {
      ...journal,
      repair: {
        version: 1,
        status: "installed",
        semanticOverlay,
        semanticOverlaySha256: semanticOverlayDigest(semanticOverlay),
        candidateIndexSha256,
        repairedAt: new Date().toISOString(),
      },
    };
    await writeJournal(path, repaired);
  }
  return { status: "recovered", outcome: "committed", idempotent: alreadyRecorded };
}

export async function recoverLegacyWorktreeReconciliation(
  request: RecoverLegacyWorktreeReconciliationRequest,
  deps: LegacyWorktreeReconciliationDeps,
): Promise<RecoverLegacyWorktreeReconciliationResult> {
  if (!TRANSACTION_ID.test(request.transactionId)) {
    return { status: "refused", reason: "journal-invalid", detail: "invalid transactionId" };
  }
  const path = journalPath(resolve(request.journalDirectory), request.transactionId);
  let journal: LegacyReconciliationJournal;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!isJournal(parsed) || parsed.transactionId !== request.transactionId) {
      return { status: "refused", reason: "journal-invalid", detail: `invalid journal at ${path}` };
    }
    journal = parsed;
    validatePersistedJournal(journal, request.journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "refused", reason: "journal-missing", detail: `journal missing at ${path}` };
    }
    return { status: "refused", reason: "journal-invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  const git = deps.git ?? nodeLegacyReconciliationGitRunner;
  const observationAdapter =
    deps.observationAdapter ??
    createGitLegacyReconciliationObservationAdapter(git, deps.activityFence);
  const release = await deps.managerLock.acquire(journal.request.worktreePath);
  try {
    if (journal.version === LEGACY_JOURNAL_VERSION && request.repairPublishedV1 !== undefined) {
      try {
        return await repairCommittedV1Journal(
          git,
          observationAdapter,
          path,
          journal,
          request.repairPublishedV1,
        );
      } catch (error) {
        const reason =
          error instanceof ReconciliationRefusal && error.reason === "activity-live"
            ? "activity-live"
            : error instanceof ReconciliationRefusal && error.reason === "activity-changed"
              ? "activity-changed"
              : "journal-invalid";
        return { status: "refused", reason, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    // A completed rollback restores the legacy HEAD, index, and overlay. Its
    // terminal recovery fence must therefore use the pre-transition snapshot;
    // all candidate-state phases retain the post-transition baseline.
    const recoveryActivity =
      journal.phase === "rolled-back"
        ? journal.capturedActivity
        : journal.postTransitionActivity ?? journal.capturedActivity;
    const first = await assessLegacyReconciliationActivity(
      observationAdapter,
      journal.request.worktreePath,
      recoveryActivity,
    );
    if (first.status === "refused") return first;
    const second = await assessLegacyReconciliationActivity(
      observationAdapter,
      journal.request.worktreePath,
      recoveryActivity,
    );
    if (second.status === "refused") return second;
    if (journal.phase === "committed") {
      if (journal.candidateHead !== undefined) {
        await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.recoveryRef, journal.refs.head);
        await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.candidateRef, journal.candidateHead);
      }
      return { status: "recovered", outcome: "committed", idempotent: true };
    }
    if (journal.phase === "rolled-back") {
      const candidateHead = journal.candidateHead ?? journal.refs.base;
      await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.recoveryRef, journal.refs.head);
      await deleteRefIfValue(git, journal.request.repositoryRoot, journal.refs.candidateRef, candidateHead);
      return { status: "recovered", outcome: "rolled-back", idempotent: true };
    }
    if (request.finalizeReconciled === true) {
      if (journal.phase !== "reconciled" || journal.candidateHead === undefined) {
        return {
          status: "refused",
          reason: "journal-invalid",
          detail: `cannot finalize reconciliation from phase ${journal.phase}`,
        };
      }
      const candidateHead = journal.candidateHead;
      const branch = await resolveRef(git, journal.request.repositoryRoot, journal.refs.branchRef);
      const recovery = await resolveRef(
        git,
        journal.request.repositoryRoot,
        journal.refs.recoveryRef,
      );
      if (branch !== candidateHead || recovery !== journal.refs.head) {
        return {
          status: "refused",
          reason: "journal-invalid",
          detail: "reconciled refs no longer match the durable journal",
        };
      }
      journal = { ...journal, phase: "committed" };
      await writeJournal(path, journal);
      await deleteRefIfValue(
        git,
        journal.request.repositoryRoot,
        journal.refs.recoveryRef,
        journal.refs.head,
      );
      await deleteRefIfValue(
        git,
        journal.request.repositoryRoot,
        journal.refs.candidateRef,
        candidateHead,
      );
      return { status: "recovered", outcome: "committed", idempotent: false };
    }
    try {
      journal = await rollbackJournalState(git, path, journal);
      return { status: "recovered", outcome: "rolled-back", idempotent: false };
    } catch (error) {
      return { status: "refused", reason: "rollback-failed", detail: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await release();
  }
}
