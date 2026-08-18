import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  assertManagedWorktreeDispatchBindingLive,
  withManagedWorktreeEffectLock,
  type ManagedWorktreeDispatchBinding,
  type ManagedWorktreeDeps,
} from "./managedWorktree.js";

const SHA256 = /^[0-9a-f]{64}$/;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REGULAR_MODES = new Set<GitRegularMode>(["100644", "100755"]);
const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;

export type GitRegularMode = "100644" | "100755";

export interface GitPathState {
  readonly mode: GitRegularMode;
  /** SHA-256 over the unfiltered file bytes. */
  readonly digest: string;
}

export type GitChangeManifestEntry =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly newState: GitPathState;
    }
  | {
      readonly kind: "modify";
      readonly path: string;
      readonly oldState: GitPathState;
      readonly newState: GitPathState;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly oldState: GitPathState;
    }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly newPath: string;
      readonly oldState: GitPathState;
      readonly newState: GitPathState;
    };

/** Server-held authorization persisted on one prepared dispatch envelope. */
export interface DispatchBoundGitAuthorization extends ManagedWorktreeDispatchBinding {
  readonly attestationId: string;
  readonly generation: number;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly conflictStateDigest?: string;
  readonly surface: string;
  readonly childCancelAt: string;
  readonly inheritedGitReceipts?: readonly GitChangeBrokerReceipt[];
}

export interface GitChangeBrokerRequest {
  readonly authorization: DispatchBoundGitAuthorization;
  readonly operationId: string;
  readonly expectedHead: string;
  readonly message: string;
  readonly changes: readonly GitChangeManifestEntry[];
}

export interface GitChangeBrokerReceipt {
  readonly kind: "cq-git-change-receipt";
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly oldHead: string;
  readonly newHead: string;
  readonly tree: string;
  readonly objectOids: readonly string[];
  readonly paths: readonly string[];
  readonly committedAt: string;
}

export interface GitChangeBrokerResultEvidence {
  readonly taskId: string;
  readonly resultCommit: string | null;
  readonly branch: string;
  readonly actualWorktreePath: string;
  readonly filesTouched: readonly string[];
  readonly gitReceipts: readonly GitChangeBrokerReceipt[];
}

export interface GitChangeBrokerDeps extends Pick<ManagedWorktreeDeps, "stateDir" | "lockfile"> {
  /** Revalidates the dispatch envelope. It must fail unless it remains prepared and materialized. */
  readonly authorize: (authorization: DispatchBoundGitAuthorization) => void | Promise<void>;
  readonly now?: () => Date;
}

export type GitChangeBrokerEvidenceDeps = Pick<ManagedWorktreeDeps, "stateDir"> & {
  /** Dispatch-round base used to prove every surviving result path was reported. */
  readonly diffBaseCommit?: string;
  /** Absolute staging deadline propagated to each checked Git subprocess. */
  readonly deadlineMs?: number;
};

function assertEvidenceDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs === undefined) return;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) {
    throw new Error("Git evidence validation exceeded its staging deadline");
  }
}

export type GitChangeReceiptLineageBinding = Omit<
  DispatchBoundGitAuthorization,
  "roleId" | "surface" | "childCancelAt"
> & {
  readonly inheritedGitReceipts?: readonly GitChangeBrokerReceipt[];
};

interface BrokerJournal {
  readonly version: 1;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly state: "intent" | "constructed" | "objects-installed" | "ref-advanced" | "completed";
  readonly receipt?: GitChangeBrokerReceipt;
  readonly privateIndex?: string;
  readonly quarantine?: string;
}

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeVerifiedGitBatchObject(
  output: Uint8Array,
  expectedOid: string,
  expectedType: string,
): Buffer {
  const batch = Buffer.from(output);
  const headerEnd = batch.indexOf(0x0a);
  if (headerEnd < 0) throw new Error("Git batch-object response lacks a header terminator");
  const [oid, type, sizeText, ...extra] = batch.subarray(0, headerEnd).toString().split(" ");
  if (
    extra.length !== 0 ||
    oid !== expectedOid ||
    !FULL_OID.test(oid) ||
    !/^(?:0|[1-9][0-9]*)$/.test(sizeText ?? "")
  ) {
    throw new Error("Git batch-object response does not identify the requested object");
  }
  if (type !== expectedType) {
    throw new Error(`Git batch-object response must have type ${expectedType}`);
  }
  const size = Number(sizeText);
  const contentStart = headerEnd + 1;
  const contentEnd = contentStart + size;
  if (
    !Number.isSafeInteger(size) ||
    batch.byteLength !== contentEnd + 1 ||
    batch[contentEnd] !== 0x0a
  ) {
    throw new Error("Git batch-object response has an invalid content boundary");
  }
  const content = batch.subarray(contentStart, contentEnd);
  const algorithm = expectedOid.length === 40 ? "sha1" : "sha256";
  const observedOid = createHash(algorithm)
    .update(`${type} ${content.byteLength}\0`)
    .update(content)
    .digest("hex");
  if (observedOid !== expectedOid) {
    throw new Error("Git batch-object content does not match requested oid");
  }
  return Buffer.from(content);
}

function requestDigest(request: GitChangeBrokerRequest): string {
  const { authorization, ...effect } = request;
  const { handleToken: _serverHeld, ...publicBinding } = authorization;
  void _serverHeld;
  return sha256(canonical({ authorization: publicBinding, ...effect }));
}

function assertPath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value === "." ||
    isAbsolute(value) ||
    value === ".git" ||
    value.startsWith(".git/") ||
    posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} must be one canonical repository-relative path`);
  }
  return value;
}

function assertState(state: GitPathState, label: string): void {
  if (!REGULAR_MODES.has(state.mode)) {
    throw new Error(`${label}.mode must be 100644 or 100755`);
  }
  if (!SHA256.test(state.digest)) {
    throw new Error(`${label}.digest must be a lowercase SHA-256`);
  }
}

function manifestPaths(changes: readonly GitChangeManifestEntry[]): readonly string[] {
  if (changes.length === 0) throw new Error("changes must contain at least one entry");
  const all: string[] = [];
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (!["add", "modify", "delete", "rename"].includes((change as { kind: string }).kind)) {
      throw new Error(`changes[${index}].kind is not a supported Git change`);
    }
    if (change.kind === "rename") {
      const oldPath = assertPath(change.oldPath, `changes[${index}].oldPath`);
      const newPath = assertPath(change.newPath, `changes[${index}].newPath`);
      if (oldPath === newPath) throw new Error("rename oldPath and newPath must differ");
      assertState(change.oldState, `changes[${index}].oldState`);
      assertState(change.newState, `changes[${index}].newState`);
      if (sources.has(oldPath) || destinations.has(oldPath) || destinations.has(newPath)) {
        throw new Error(`duplicate manifest path in rename ${oldPath} -> ${newPath}`);
      }
      sources.add(oldPath);
      destinations.add(newPath);
      all.push(oldPath, newPath);
      continue;
    }
    const entryPath = assertPath(change.path, `changes[${index}].path`);
    if (sources.has(entryPath) || destinations.has(entryPath)) {
      throw new Error(`duplicate manifest path ${entryPath}`);
    }
    destinations.add(entryPath);
    all.push(entryPath);
    if (change.kind !== "add") assertState(change.oldState, `changes[${index}].oldState`);
    if (change.kind !== "delete") assertState(change.newState, `changes[${index}].newState`);
  }
  return Object.freeze([...new Set(all)].sort());
}

function brokerRoot(binding: ManagedWorktreeDispatchBinding, stateDir?: string): string {
  return stateDir ?? join(binding.repositoryRoot, ".claude", "worktrees", ".cq-managed-registry");
}

function operationRoot(
  binding: GitChangeReceiptLineageBinding,
  operationId: string,
  stateDir?: string,
): string {
  const key = sha256(`${binding.attestationId}\n${binding.generation}\n${operationId}`);
  return join(brokerRoot(binding, stateDir), "git-broker", key);
}

async function readJournal(file: string): Promise<BrokerJournal | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BrokerJournal;
    if (parsed.version !== 1 || typeof parsed.requestDigest !== "string") {
      throw new Error("invalid durable Git broker journal");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function committedDispatchReceipts(
  authorization: GitChangeReceiptLineageBinding,
  resultCommit: string,
  deps: GitChangeBrokerEvidenceDeps,
): Promise<readonly GitChangeBrokerReceipt[]> {
  assertEvidenceDeadline(deps.deadlineMs);
  const root = join(brokerRoot(authorization, deps.stateDir), "git-broker");
  let operationDirectories;
  try {
    operationDirectories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const candidates: GitChangeBrokerReceipt[] = [];
  for (const operationDirectory of operationDirectories) {
    assertEvidenceDeadline(deps.deadlineMs);
    if (!operationDirectory.isDirectory()) continue;
    const journal = await readJournal(join(root, operationDirectory.name, "journal.json"));
    if (journal?.receipt === undefined || journal.state === "intent") continue;
    const receipt = journal.receipt;
    if (
      receipt.attestationId !== authorization.attestationId ||
      receipt.generation !== authorization.generation ||
      receipt.taskId !== authorization.taskId
    ) {
      continue;
    }
    if (
      operationDirectory.name !==
      basename(operationRoot(authorization, receipt.operationId, deps.stateDir))
    ) {
      throw new Error(
        `durable broker receipt ${receipt.operationId} has a substituted operationId`,
      );
    }
    if (receipt.requestDigest !== journal.requestDigest) {
      throw new Error(
        `durable broker receipt ${receipt.operationId} has a substituted requestDigest`,
      );
    }
    if (receipt.committedAt !== journal.createdAt) {
      throw new Error(
        `durable broker receipt ${receipt.operationId} has a substituted committedAt`,
      );
    }
    const ancestry = await runGit(
      authorization.worktreePath,
      ["merge-base", "--is-ancestor", receipt.newHead, resultCommit],
      undefined,
      undefined,
      deps.deadlineMs,
    );
    if (ancestry.code === 0) {
      candidates.push(receipt);
      continue;
    }
    if (journal.state === "completed" || journal.state === "ref-advanced") {
      throw new Error(
        `durable broker receipt ${receipt.operationId} does not belong to resultCommit`,
      );
    }
    if (ancestry.code !== 1 && journal.state !== "constructed") {
      throw new Error(
        `durable broker receipt ${receipt.operationId} cannot be resolved from the object store`,
      );
    }
  }

  const byNewHead = new Map<string, GitChangeBrokerReceipt>();
  for (const receipt of candidates) {
    if (byNewHead.has(receipt.newHead)) {
      throw new Error(`durable broker receipt chain repeats commit ${receipt.newHead}`);
    }
    byNewHead.set(receipt.newHead, receipt);
  }
  const reversed: GitChangeBrokerReceipt[] = [];
  let cursor = resultCommit;
  while (true) {
    const receipt = byNewHead.get(cursor);
    if (receipt === undefined) break;
    reversed.push(receipt);
    byNewHead.delete(cursor);
    cursor = receipt.oldHead;
  }
  if (byNewHead.size > 0) {
    throw new Error("durable broker receipts do not form one complete commit chain");
  }
  return Object.freeze(reversed.reverse());
}

/** Resolve the exact durable prefix a terminal generation contributes to its retry. */
export async function resolveInheritedGitChangeReceipts(
  authorization: GitChangeReceiptLineageBinding,
  resultCommit: string,
  deps: GitChangeBrokerEvidenceDeps = {},
): Promise<readonly GitChangeBrokerReceipt[]> {
  if (!FULL_OID.test(resultCommit)) throw new Error("inherited receipt tip must be a full Git oid");
  const inherited = authorization.inheritedGitReceipts ?? [];
  const current = await committedDispatchReceipts(authorization, resultCommit, deps);
  const combined = [...inherited, ...current];
  if (combined.length === 0) return Object.freeze([]);
  for (const [index, receipt] of combined.entries()) {
    if (receipt.taskId !== authorization.taskId) {
      throw new Error(`inherited receipt chain entry ${index} has a foreign task identity`);
    }
    const preceding = combined[index - 1];
    if (preceding !== undefined && receipt.oldHead !== preceding.newHead) {
      throw new Error(`inherited receipt chain diverges at entry ${index}`);
    }
  }
  if (combined.at(-1)?.newHead !== resultCommit) {
    throw new Error("inherited receipt chain is stale relative to startingCommit");
  }
  return Object.freeze(combined.map((receipt) => Object.freeze({ ...receipt })));
}

async function writeJournal(file: string, journal: BrokerJournal): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function trustedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
  };
}

function gitEnvironment(
  binding: DispatchBoundGitAuthorization,
  privateIndex: string,
  quarantine: string,
  committedAt: string,
): NodeJS.ProcessEnv {
  return {
    ...trustedGitEnvironment(),
    GIT_INDEX_FILE: privateIndex,
    GIT_OBJECT_DIRECTORY: quarantine,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(binding.commonDir, "objects"),
    GIT_AUTHOR_NAME: "cq Git change broker",
    GIT_AUTHOR_EMAIL: "cq-broker@example.invalid",
    GIT_COMMITTER_NAME: "cq Git change broker",
    GIT_COMMITTER_EMAIL: "cq-broker@example.invalid",
    GIT_AUTHOR_DATE: committedAt,
    GIT_COMMITTER_DATE: committedAt,
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  input?: Uint8Array,
  deadlineMs?: number,
): Promise<GitResult> {
  assertEvidenceDeadline(deadlineMs);
  const selectedEnvironment = environment ?? trustedGitEnvironment();
  const child = Bun.spawn(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      env: selectedEnvironment,
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
  const timer =
    remainingMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, remainingMs);
  return Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).then(([code, stdout, stderr]) => {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) throw new Error("Git evidence validation exceeded its staging deadline");
    return {
      code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    };
  });
}

async function checkedGit(
  cwd: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  input?: Uint8Array,
  deadlineMs?: number,
): Promise<Buffer> {
  const result = await runGit(cwd, args, environment, input, deadlineMs);
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout;
}

async function currentHead(
  binding: DispatchBoundGitAuthorization,
  deadlineMs?: number,
): Promise<string> {
  return (
    await checkedGit(
      binding.worktreePath,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      undefined,
      undefined,
      deadlineMs,
    )
  )
    .toString()
    .trim();
}

async function assertExactDirtyPaths(
  binding: DispatchBoundGitAuthorization,
  expected: readonly string[],
): Promise<void> {
  const tracked = (
    await checkedGit(binding.worktreePath, ["diff", "--name-only", "-z", "HEAD", "--"])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await checkedGit(binding.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const staged = (await checkedGit(binding.worktreePath, ["diff", "--cached", "--name-only", "-z"]))
    .toString()
    .split("\0")
    .filter(Boolean);
  if (staged.length > 0) throw new Error(`broker refuses pre-staged paths: ${staged.join(", ")}`);
  const observed = [...new Set([...tracked, ...untracked])].sort();
  if (canonical(observed) !== canonical(expected)) {
    throw new Error(
      `dirty path set does not equal manifest: observed [${observed.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }
}

interface TreeEntry {
  readonly mode: GitRegularMode;
  readonly oid: string;
  readonly digest: string;
}

async function treeEntry(
  binding: DispatchBoundGitAuthorization,
  head: string,
  entryPath: string,
): Promise<TreeEntry | null> {
  const output = await checkedGit(binding.worktreePath, ["ls-tree", "-z", head, "--", entryPath]);
  if (output.length === 0) return null;
  const line = output.toString().replace(/\0$/, "");
  const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t(.+)$/.exec(line);
  if (match === null || match[4] !== entryPath)
    throw new Error(`ambiguous tree entry ${entryPath}`);
  if (match[2] !== "blob" || !REGULAR_MODES.has(match[1] as GitRegularMode)) {
    throw new Error(`unsupported symlink or gitlink at ${entryPath}`);
  }
  const bytes = await checkedGit(binding.worktreePath, ["cat-file", "blob", match[3]!]);
  return { mode: match[1] as GitRegularMode, oid: match[3]!, digest: sha256(bytes) };
}

function assertTreeState(actual: TreeEntry | null, expected: GitPathState, label: string): void {
  if (actual === null) throw new Error(`${label} does not exist in expected HEAD`);
  if (actual.mode !== expected.mode || actual.digest !== expected.digest) {
    throw new Error(`${label} old state does not match expected mode/digest`);
  }
}

async function snapshotRegularFile(
  root: string,
  entryPath: string,
  expected: GitPathState,
): Promise<Buffer> {
  const absolute = resolve(root, entryPath);
  const relation = relative(resolve(root), absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`path ${entryPath} escapes the managed worktree`);
  }
  const components = entryPath.split("/").slice(0, -1);
  let parent = resolve(root);
  const parentIdentities: { readonly path: string; readonly dev: number; readonly ino: number }[] =
    [];
  for (const component of components) {
    parent = join(parent, component);
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`path ${entryPath} has a non-directory or symlink ancestor`);
    }
    parentIdentities.push({ path: parent, dev: stat.dev, ino: stat.ino });
  }
  let handle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`path ${entryPath} must be a regular file, not a symlink`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error(`path ${entryPath} must be a regular file, not a symlink`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathStat = await fs.lstat(absolute);
    for (const identity of parentIdentities) {
      const stat = await fs.lstat(identity.path);
      if (!stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
        throw new Error(`path ${entryPath} changed while the broker snapshotted it`);
      }
    }
    if (
      !pathStat.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathStat.dev !== after.dev ||
      pathStat.ino !== after.ino
    ) {
      throw new Error(`path ${entryPath} changed while the broker snapshotted it`);
    }
    const mode: GitRegularMode = (after.mode & 0o111) === 0 ? "100644" : "100755";
    if (mode !== expected.mode || sha256(bytes) !== expected.digest) {
      throw new Error(`path ${entryPath} does not match declared new mode/digest`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validateAndSnapshot(
  request: GitChangeBrokerRequest,
  paths: readonly string[],
): Promise<ReadonlyMap<string, Buffer>> {
  const { authorization: binding } = request;
  if ((await currentHead(binding)) !== request.expectedHead) {
    throw new Error(`expectedHead ${request.expectedHead} is stale`);
  }
  await assertExactDirtyPaths(binding, paths);
  const snapshots = new Map<string, Buffer>();
  for (const change of request.changes) {
    if (change.kind === "add") {
      if ((await treeEntry(binding, request.expectedHead, change.path)) !== null) {
        throw new Error(`add path ${change.path} already exists in expected HEAD`);
      }
      snapshots.set(
        change.path,
        await snapshotRegularFile(binding.worktreePath, change.path, change.newState),
      );
      continue;
    }
    if (change.kind === "delete") {
      assertTreeState(
        await treeEntry(binding, request.expectedHead, change.path),
        change.oldState,
        change.path,
      );
      try {
        await fs.lstat(join(binding.worktreePath, change.path));
        throw new Error(`delete path ${change.path} still exists in the worktree`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (change.kind === "modify") {
      assertTreeState(
        await treeEntry(binding, request.expectedHead, change.path),
        change.oldState,
        change.path,
      );
      snapshots.set(
        change.path,
        await snapshotRegularFile(binding.worktreePath, change.path, change.newState),
      );
      continue;
    }
    assertTreeState(
      await treeEntry(binding, request.expectedHead, change.oldPath),
      change.oldState,
      change.oldPath,
    );
    if ((await treeEntry(binding, request.expectedHead, change.newPath)) !== null) {
      throw new Error(`rename destination ${change.newPath} already exists in expected HEAD`);
    }
    try {
      await fs.lstat(join(binding.worktreePath, change.oldPath));
      throw new Error(`rename source ${change.oldPath} still exists in the worktree`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    snapshots.set(
      change.newPath,
      await snapshotRegularFile(binding.worktreePath, change.newPath, change.newState),
    );
  }
  return snapshots;
}

async function quarantineOids(directory: string): Promise<readonly string[]> {
  const oids: string[] = [];
  for (const prefix of await fs.readdir(directory)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    for (const suffix of await fs.readdir(join(directory, prefix))) {
      const oid = `${prefix}${suffix}`;
      if (FULL_OID.test(oid)) oids.push(oid);
    }
  }
  return Object.freeze(oids.sort());
}

async function materializeExistingTree(
  worktreePath: string,
  commonDir: string,
  quarantine: string,
  environment: NodeJS.ProcessEnv,
  tree: string,
): Promise<void> {
  const isolatedObjectEnvironment = { ...environment };
  delete isolatedObjectEnvironment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const target = join(quarantine, tree.slice(0, 2), tree.slice(2));
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    await fs.copyFile(
      join(commonDir, "objects", tree.slice(0, 2), tree.slice(2)),
      target,
      fsConstants.COPYFILE_EXCL,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw error;
    if (code === "ENOENT") {
      const batch = await checkedGit(
        worktreePath,
        ["cat-file", "--batch"],
        environment,
        Buffer.from(`${tree}\n`),
      );
      const content = decodeVerifiedGitBatchObject(batch, tree, "tree");
      const written = (
        await checkedGit(
          worktreePath,
          ["hash-object", "-w", "-t", "tree", "--stdin"],
          isolatedObjectEnvironment,
          content,
        )
      )
        .toString()
        .trim();
      if (written !== tree)
        throw new Error("materialized tree oid does not match write-tree output");
    }
  }
  const isolatedBatch = await checkedGit(
    worktreePath,
    ["cat-file", "--batch"],
    isolatedObjectEnvironment,
    Buffer.from(`${tree}\n`),
  );
  decodeVerifiedGitBatchObject(isolatedBatch, tree, "tree");
}

async function constructPrivateCommit(
  request: GitChangeBrokerRequest,
  operationDirectory: string,
  committedAt: string,
  paths: readonly string[],
  snapshots: ReadonlyMap<string, Buffer>,
  digest: string,
): Promise<{ readonly journal: BrokerJournal; readonly receipt: GitChangeBrokerReceipt }> {
  const privateIndex = join(operationDirectory, "index");
  const quarantine = join(operationDirectory, "objects");
  await fs.mkdir(join(quarantine, "info"), { recursive: true });
  await fs.mkdir(join(quarantine, "pack"), { recursive: true });
  await fs.rm(privateIndex, { force: true });
  const environment = gitEnvironment(request.authorization, privateIndex, quarantine, committedAt);
  await checkedGit(
    request.authorization.worktreePath,
    ["read-tree", request.expectedHead],
    environment,
  );
  for (const change of request.changes) {
    if (change.kind === "delete") {
      await checkedGit(
        request.authorization.worktreePath,
        ["update-index", "--force-remove", "--", change.path],
        environment,
      );
      continue;
    }
    if (change.kind === "rename") {
      await checkedGit(
        request.authorization.worktreePath,
        ["update-index", "--force-remove", "--", change.oldPath],
        environment,
      );
      const bytes = snapshots.get(change.newPath);
      if (bytes === undefined) throw new Error(`missing snapshot for ${change.newPath}`);
      const oid = (
        await checkedGit(
          request.authorization.worktreePath,
          ["hash-object", "-w", "--stdin"],
          environment,
          bytes,
        )
      )
        .toString()
        .trim();
      await checkedGit(
        request.authorization.worktreePath,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${change.newState.mode},${oid},${change.newPath}`,
        ],
        environment,
      );
      continue;
    }
    const bytes = snapshots.get(change.path);
    if (bytes === undefined) throw new Error(`missing snapshot for ${change.path}`);
    const oid = (
      await checkedGit(
        request.authorization.worktreePath,
        ["hash-object", "-w", "--stdin"],
        environment,
        bytes,
      )
    )
      .toString()
      .trim();
    await checkedGit(
      request.authorization.worktreePath,
      ["update-index", "--add", "--cacheinfo", `${change.newState.mode},${oid},${change.path}`],
      environment,
    );
  }
  const tree = (await checkedGit(request.authorization.worktreePath, ["write-tree"], environment))
    .toString()
    .trim();
  const changedPaths = (
    await checkedGit(
      request.authorization.worktreePath,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", request.expectedHead, tree],
      environment,
    )
  )
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  if (canonical(changedPaths) !== canonical(paths)) {
    throw new Error(
      `private tree changed [${changedPaths.join(", ")}], expected [${paths.join(", ")}]`,
    );
  }
  if (!(await quarantineOids(quarantine)).includes(tree)) {
    await materializeExistingTree(
      request.authorization.worktreePath,
      request.authorization.commonDir,
      quarantine,
      environment,
      tree,
    );
  }
  const newHead = (
    await checkedGit(
      request.authorization.worktreePath,
      ["commit-tree", tree, "-p", request.expectedHead, "-m", request.message],
      environment,
    )
  )
    .toString()
    .trim();
  const objectOids = await quarantineOids(quarantine);
  if (!objectOids.includes(tree) || !objectOids.includes(newHead)) {
    throw new Error("private object quarantine lacks the generated tree or commit");
  }
  for (const oid of objectOids) {
    const object = await fs.open(join(quarantine, oid.slice(0, 2), oid.slice(2)), "r");
    try {
      await object.sync();
    } finally {
      await object.close();
    }
  }
  const index = await fs.open(privateIndex, "r");
  try {
    await index.sync();
  } finally {
    await index.close();
  }
  const receipt: GitChangeBrokerReceipt = Object.freeze({
    kind: "cq-git-change-receipt" as const,
    version: 1 as const,
    attestationId: request.authorization.attestationId,
    generation: request.authorization.generation,
    taskId: request.authorization.taskId,
    operationId: request.operationId,
    requestDigest: digest,
    oldHead: request.expectedHead,
    newHead,
    tree,
    objectOids,
    paths,
    committedAt,
  });
  return {
    receipt,
    journal: {
      version: 1,
      requestDigest: digest,
      createdAt: committedAt,
      state: "constructed",
      receipt,
      privateIndex,
      quarantine,
    },
  };
}

async function installObjects(
  binding: DispatchBoundGitAuthorization,
  quarantine: string,
  objectOids: readonly string[],
): Promise<void> {
  const objectRoot = join(binding.commonDir, "objects");
  for (const oid of objectOids) {
    const source = join(quarantine, oid.slice(0, 2), oid.slice(2));
    const target = join(objectRoot, oid.slice(0, 2), oid.slice(2));
    await fs.mkdir(dirname(target), { recursive: true });
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      await fs.chmod(target, 0o444);
      const installed = await fs.open(target, "r");
      try {
        await installed.sync();
      } finally {
        await installed.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [existing, attributed] = await Promise.all([fs.readFile(target), fs.readFile(source)]);
      if (!existing.equals(attributed)) {
        throw new Error(`pre-existing object ${oid} has different bytes`);
      }
    }
  }
}

async function installIndex(
  binding: DispatchBoundGitAuthorization,
  privateIndex: string,
): Promise<void> {
  const raw = (
    await checkedGit(binding.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])
  )
    .toString()
    .trim();
  const indexPath = resolve(raw);
  const commonRelation = relative(resolve(binding.commonDir), indexPath);
  if (
    commonRelation === ".." ||
    commonRelation.startsWith(`..${sep}`) ||
    isAbsolute(commonRelation)
  ) {
    throw new Error("task index path escapes the bound repository common directory");
  }
  const temporary = `${indexPath}.cq-broker-${process.pid}`;
  await fs.copyFile(privateIndex, temporary, fsConstants.COPYFILE_EXCL);
  const installed = await fs.open(temporary, "r");
  try {
    await installed.sync();
  } finally {
    await installed.close();
  }
  await fs.rename(temporary, indexPath);
  const directory = await fs.open(dirname(indexPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function completeConstructed(
  request: GitChangeBrokerRequest,
  deps: GitChangeBrokerDeps,
  journalFile: string,
  journal: BrokerJournal,
): Promise<GitChangeBrokerReceipt> {
  const receipt = journal.receipt;
  const privateIndex = journal.privateIndex;
  const quarantine = journal.quarantine;
  if (receipt === undefined || privateIndex === undefined || quarantine === undefined) {
    throw new Error("constructed Git broker journal is incomplete");
  }
  let state = journal.state;
  if (state === "constructed") {
    await installObjects(request.authorization, quarantine, receipt.objectOids);
    state = "objects-installed";
    await writeJournal(journalFile, { ...journal, state });
  }
  if (state === "objects-installed") {
    await deps.authorize(request.authorization);
    await assertManagedWorktreeDispatchBindingLive(request.authorization, deps);
    const observed = await currentHead(request.authorization);
    if (observed === receipt.oldHead) {
      await checkedGit(request.authorization.worktreePath, [
        "update-ref",
        request.authorization.ref,
        receipt.newHead,
        receipt.oldHead,
      ]);
    } else if (observed !== receipt.newHead) {
      throw new Error(`manager-bound ref moved to ${observed}, expected ${receipt.oldHead}`);
    }
    state = "ref-advanced";
    await writeJournal(journalFile, { ...journal, state });
  }
  if (state === "ref-advanced") {
    await installIndex(request.authorization, privateIndex);
    await writeJournal(journalFile, { ...journal, state: "completed" });
  }
  return receipt;
}

/**
 * Admit exactly one dispatch/handle-bound change manifest. The durable journal
 * makes a lost response or restart replay the byte-identical receipt.
 */
export async function commitManagedWorktreeChanges(
  request: GitChangeBrokerRequest,
  deps: GitChangeBrokerDeps,
): Promise<GitChangeBrokerReceipt> {
  if (!OPERATION_ID.test(request.operationId)) {
    throw new Error("operationId must match /^[A-Za-z0-9_-]{1,128}$/");
  }
  if (!FULL_OID.test(request.expectedHead)) throw new Error("expectedHead must be a full Git oid");
  if (
    request.message.length === 0 ||
    request.message.includes("\0") ||
    Buffer.byteLength(request.message) > MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new Error("message must contain 1..16384 non-NUL UTF-8 bytes");
  }
  if (request.authorization.roleId !== "implement-worker") {
    throw new Error("Git commit effects are authorized only for implement-worker");
  }
  const deadline = Date.parse(request.authorization.childCancelAt);
  const now = (deps.now ?? (() => new Date()))();
  if (!Number.isFinite(deadline) || now.getTime() > deadline) {
    throw new Error("Git change authorization has expired");
  }
  const paths = manifestPaths(request.changes);
  const digest = requestDigest(request);
  const root = operationRoot(request.authorization, request.operationId, deps.stateDir);
  const journalFile = join(root, "journal.json");
  return await withManagedWorktreeEffectLock(request.authorization, deps, async () => {
    await deps.authorize(request.authorization);
    await assertManagedWorktreeDispatchBindingLive(request.authorization, deps);
    let journal = await readJournal(journalFile);
    if (journal !== null) {
      if (journal.requestDigest !== digest) {
        throw new Error(`operationId ${request.operationId} was reused with a different request`);
      }
      if (journal.state === "completed") {
        if (journal.receipt === undefined)
          throw new Error("completed broker journal lacks receipt");
        return journal.receipt;
      }
      if (journal.state !== "intent") {
        return await completeConstructed(request, deps, journalFile, journal);
      }
    } else {
      journal = {
        version: 1,
        requestDigest: digest,
        createdAt: now.toISOString(),
        state: "intent",
      };
      await writeJournal(journalFile, journal);
    }
    await deps.authorize(request.authorization);
    await assertManagedWorktreeDispatchBindingLive(request.authorization, deps);
    const snapshots = await validateAndSnapshot(request, paths);
    const constructed = await constructPrivateCommit(
      request,
      root,
      journal.createdAt,
      paths,
      snapshots,
      digest,
    );
    await writeJournal(journalFile, constructed.journal);
    return await completeConstructed(request, deps, journalFile, constructed.journal);
  });
}

/** Trusted-parent verification of the receipt chain supplied by a broker-capable worker. */
export async function validateGitChangeBrokerResultEvidence(
  authorization: DispatchBoundGitAuthorization,
  evidence: GitChangeBrokerResultEvidence,
  deps: GitChangeBrokerEvidenceDeps = {},
): Promise<void> {
  if (evidence.resultCommit === null || !FULL_OID.test(evidence.resultCommit)) {
    throw new Error("broker receipt chain requires a full resultCommit oid");
  }
  if (evidence.taskId !== authorization.taskId) {
    throw new Error("broker receipt taskId does not match the dispatch binding");
  }
  if (evidence.branch !== authorization.branch) {
    throw new Error("broker receipt branch does not match the dispatch binding");
  }
  if (
    !isAbsolute(evidence.actualWorktreePath) ||
    resolve(evidence.actualWorktreePath) !== resolve(authorization.worktreePath)
  ) {
    throw new Error("broker receipt worktree path does not match the dispatch binding");
  }
  if (evidence.gitReceipts.length === 0) {
    throw new Error("broker-capable worker result requires a non-empty receipt chain");
  }
  const evidenceGit = async (args: readonly string[]): Promise<Buffer> =>
    await checkedGit(authorization.worktreePath, args, undefined, undefined, deps.deadlineMs);
  const runEvidenceGit = async (args: readonly string[]): Promise<GitResult> =>
    await runGit(authorization.worktreePath, args, undefined, undefined, deps.deadlineMs);

  const inheritedReceipts = authorization.inheritedGitReceipts ?? [];
  const currentReceipts = await committedDispatchReceipts(
    authorization,
    evidence.resultCommit,
    deps,
  );
  const durableReceipts = [...inheritedReceipts, ...currentReceipts];
  if (durableReceipts.length !== evidence.gitReceipts.length) {
    throw new Error("broker receipt chain omits or invents a durable operation");
  }
  for (const [index, receipt] of evidence.gitReceipts.entries()) {
    if (canonical(receipt) !== canonical(durableReceipts[index])) {
      throw new Error(`broker receipt chain entry ${index} does not match its durable journal`);
    }
  }

  const touched = [
    ...new Set(
      evidence.filesTouched.map((entryPath, index) =>
        assertPath(entryPath, `filesTouched[${index}]`),
      ),
    ),
  ].sort();
  if (touched.length !== evidence.filesTouched.length) {
    throw new Error("broker result filesTouched contains duplicate paths");
  }
  const receiptPaths = new Set<string>();
  let previousHead: string | undefined;
  for (const [index, receipt] of evidence.gitReceipts.entries()) {
    if (receipt.kind !== "cq-git-change-receipt" || receipt.version !== 1) {
      throw new Error(`broker receipt chain entry ${index} has an unsupported kind or version`);
    }
    const inherited = inheritedReceipts[index];
    if (
      inherited === undefined &&
      (receipt.attestationId !== authorization.attestationId ||
        receipt.generation !== authorization.generation ||
        receipt.taskId !== authorization.taskId)
    ) {
      throw new Error(`broker receipt chain entry ${index} does not match the dispatch identity`);
    }
    if (
      !FULL_OID.test(receipt.oldHead) ||
      !FULL_OID.test(receipt.newHead) ||
      !FULL_OID.test(receipt.tree)
    ) {
      throw new Error(`broker receipt chain entry ${index} contains a malformed Git oid`);
    }
    if (previousHead !== undefined && receipt.oldHead !== previousHead) {
      throw new Error(`broker receipt chain entry ${index} does not continue the preceding head`);
    }
    const paths = receipt.paths.map((entryPath, pathIndex) =>
      assertPath(entryPath, `gitReceipts[${index}].paths[${pathIndex}]`),
    );
    if (canonical(paths) !== canonical([...new Set(paths)].sort())) {
      throw new Error(`broker receipt chain entry ${index} paths are not unique and sorted`);
    }
    const parent = (await evidenceGit(["rev-parse", "--verify", `${receipt.newHead}^`]))
      .toString()
      .trim();
    if (parent !== receipt.oldHead) {
      throw new Error(`broker receipt chain entry ${index} oldHead is not the commit parent`);
    }
    const tree = (await evidenceGit(["rev-parse", "--verify", `${receipt.newHead}^{tree}`]))
      .toString()
      .trim();
    if (tree !== receipt.tree) {
      throw new Error(`broker receipt chain entry ${index} tree does not match newHead`);
    }
    const changedPaths = (
      await evidenceGit([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        receipt.oldHead,
        receipt.newHead,
        "--",
      ])
    )
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort();
    if (canonical(changedPaths) !== canonical(paths)) {
      throw new Error(`broker receipt chain entry ${index} paths do not match its commit diff`);
    }
    for (const oid of receipt.objectOids) {
      if (!FULL_OID.test(oid)) {
        throw new Error(`broker receipt chain entry ${index} contains a malformed object oid`);
      }
      await evidenceGit(["cat-file", "-e", oid]);
    }
    if (
      !receipt.objectOids.includes(receipt.newHead) ||
      !receipt.objectOids.includes(receipt.tree)
    ) {
      throw new Error(`broker receipt chain entry ${index} omits its commit or tree object`);
    }
    for (const entryPath of paths) receiptPaths.add(entryPath);
    previousHead = receipt.newHead;
  }

  const first = evidence.gitReceipts[0]!;
  const diffBaseCommit = deps.diffBaseCommit ?? authorization.baseCommit;
  if (!FULL_OID.test(diffBaseCommit)) {
    throw new Error("broker result diff base is not a full Git oid");
  }
  const baseAncestry = await runEvidenceGit([
    "merge-base",
    "--is-ancestor",
    diffBaseCommit,
    first.oldHead,
  ]);
  if (baseAncestry.code !== 0) {
    throw new Error("broker receipt chain begins outside the dispatch base ancestry");
  }
  if (previousHead !== evidence.resultCommit) {
    throw new Error("broker receipt chain head does not match resultCommit");
  }
  if (canonical([...receiptPaths].sort()) !== canonical(touched)) {
    throw new Error("broker receipt paths do not match filesTouched");
  }
  const actualResultPaths = (
    await evidenceGit([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      diffBaseCommit,
      evidence.resultCommit,
      "--",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  if (
    actualResultPaths.length !== touched.length ||
    actualResultPaths.some((entryPath, index) => entryPath !== touched[index])
  ) {
    throw new Error("broker filesTouched does not equal the actual base-to-result diff");
  }
  if ((await currentHead(authorization, deps.deadlineMs)) !== evidence.resultCommit) {
    throw new Error("broker receipt resultCommit does not match the manager-bound branch tip");
  }
}
