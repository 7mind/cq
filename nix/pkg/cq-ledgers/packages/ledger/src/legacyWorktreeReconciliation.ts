import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const JOURNAL_VERSION = 1 as const;
const FULL_SHA = /^[0-9a-f]{40}$/;
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
  readonly faultInjector?: LegacyReconciliationFaultInjector;
}

export interface LegacyOverlayJournalEntry {
  readonly path: string;
  readonly type: "file" | "symlink" | "deleted";
  readonly mode: number | null;
  readonly sha256: string;
  readonly bytesBase64: string | null;
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
    readonly transition: LegacyWorktreeActivityObservation;
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

type JournalPhase =
  | "captured"
  | "candidate-ready"
  | "transition-ready"
  | "reconciled"
  | "committed"
  | "rolled-back";

interface LegacyReconciliationJournal {
  readonly version: typeof JOURNAL_VERSION;
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
  readonly wipArtifacts: readonly string[];
  readonly capturedActivity: LegacyWorktreeActivityObservation;
  readonly phase: JournalPhase;
  readonly classification?: LegacyReconciliationClassification;
  readonly cherry?: readonly string[];
  readonly replayedCommits?: readonly string[];
  readonly candidateHead?: string;
  readonly journaledActivity?: LegacyWorktreeActivityObservation;
  readonly transitionActivity?: LegacyWorktreeActivityObservation;
}

class ReconciliationRefusal extends Error {
  constructor(
    readonly reason: BeginLegacyWorktreeReconciliationRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
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
    GIT_TERMINAL_PROMPT: "0",
    GIT_COMMITTER_NAME: "CQ Legacy Reconciliation",
    GIT_COMMITTER_EMAIL: "cq-reconciliation@example.invalid",
    LANG: "C",
    LC_ALL: "C",
  };
}

export const nodeLegacyReconciliationGitRunner: LegacyReconciliationGitRunner = (
  cwd,
  args,
) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env: gitEnvironment(), maxBuffer: 32 * 1024 * 1024 },
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
): Promise<string> {
  const result = await git(cwd, args);
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
): Promise<string> {
  const result = await git(cwd, args);
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

async function classifyHistory(
  git: LegacyReconciliationGitRunner,
  request: LegacyReconciliationJournal["request"],
  refs: CapturedRefs,
): Promise<{
  readonly classification: LegacyReconciliationClassification;
  readonly cherry: readonly string[];
  readonly replayedCommits: readonly string[];
}> {
  const mergeBase = await git(request.repositoryRoot, ["merge-base", refs.base, refs.head]);
  if (mergeBase.code !== 0 || !FULL_SHA.test(mergeBase.stdout.trim())) {
    throw new ReconciliationRefusal(
      "history-unresolvable",
      `base and legacy HEAD have no resolvable merge base: ${mergeBase.stderr.trim()}`,
    );
  }
  const merges = await runRequired(
    git,
    request.repositoryRoot,
    ["rev-list", "--merges", `${refs.base}..${refs.head}`],
    "history-unresolvable",
  );
  const mergeCommits = merges === "" ? [] : merges.split(/\r?\n/).filter((line) => line !== "");
  const cherryResult = await git(request.repositoryRoot, ["cherry", refs.base, refs.head]);
  if (cherryResult.code !== 0) {
    throw new ReconciliationRefusal(
      "history-unresolvable",
      `git cherry failed (${cherryResult.code}): ${cherryResult.stderr.trim()}`,
    );
  }
  const cherry = parseCherry(cherryResult.stdout);
  const classified = classifyLegacyHistory({ mergeCommits, cherry });
  return { ...classified, cherry };
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

async function buildCandidateOffPath(
  git: LegacyReconciliationGitRunner,
  request: LegacyReconciliationJournal["request"],
  transactionId: string,
  classification: LegacyReconciliationClassification,
  replayedCommits: readonly string[],
  overlay: readonly LegacyOverlayJournalEntry[],
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
  if (classification === "linear-unpublished") {
    for (const commit of replayedCommits) {
      const cherryPick = await git(buildPath, ["cherry-pick", commit]);
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
    const capturedActivity = await deps.activityFence.observe(request.worktreePath);
    assertQuiescent(capturedActivity);
    const refs = await captureRefs(request, input.transactionId, git);
    const index = await captureIndex(git, request.worktreePath);
    await fault("after-capture", { transactionId: input.transactionId, oldHead: refs.head });
    const overlay = await captureOverlay(git, request.worktreePath, request.excludedRelativePaths);
    const wipArtifacts = await listWipArtifacts(request.worktreePath);
    journal = {
      version: JOURNAL_VERSION,
      transactionId: input.transactionId,
      request,
      refs,
      index,
      overlay,
      overlaySha256: overlayDigest(overlay),
      wipArtifacts,
      capturedActivity,
      phase: "captured",
    };
    await writeJournal(path, journal);
    await fault("after-journal-durable", { transactionId: input.transactionId, overlaySha256: journal.overlaySha256 });
    const journaledActivity = await deps.activityFence.observe(request.worktreePath);
    assertSameActivity(capturedActivity, journaledActivity);
    const classified = await classifyHistory(git, request, refs);
    await fault("after-classification", { transactionId: input.transactionId, classification: classified.classification });
    const built = await buildCandidateOffPath(
      git,
      request,
      input.transactionId,
      classified.classification,
      classified.replayedCommits,
      overlay,
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
    journal = { ...journal, phase: "transition-ready" };
    await writeJournal(path, journal);
    const transitionActivity = await deps.activityFence.observe(request.worktreePath);
    assertSameActivity(capturedActivity, transitionActivity);
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
    await applyOverlay(request.worktreePath, overlay);
    await fault("after-overlay-restore", { transactionId: input.transactionId, overlaySha256: journal.overlaySha256 });
    await verifyOverlay(request.worktreePath, overlay);
    const transitionedHead = await resolveCommit(git, request.worktreePath, "HEAD");
    if (transitionedHead !== built.candidateHead) {
      throw new ReconciliationRefusal(
        "transition-failed",
        `transitioned HEAD ${String(transitionedHead)} does not equal candidate ${built.candidateHead}`,
      );
    }
    journal = { ...journal, phase: "reconciled", transitionActivity };
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
    record.version === JOURNAL_VERSION &&
    typeof record.transactionId === "string" &&
    typeof record.phase === "string" &&
    record.request !== undefined &&
    record.refs !== undefined &&
    record.index !== undefined &&
    Array.isArray(record.overlay)
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
  const release = await deps.managerLock.acquire(journal.request.worktreePath);
  try {
    const first = await deps.activityFence.observe(journal.request.worktreePath);
    try {
      assertQuiescent(first);
    } catch (error) {
      return { status: "refused", reason: "activity-live", detail: error instanceof Error ? error.message : String(error) };
    }
    const second = await deps.activityFence.observe(journal.request.worktreePath);
    try {
      assertSameActivity(first, second);
    } catch (error) {
      const reason = error instanceof ReconciliationRefusal && error.reason === "activity-live" ? "activity-live" : "activity-changed";
      return { status: "refused", reason, detail: error instanceof Error ? error.message : String(error) };
    }
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
