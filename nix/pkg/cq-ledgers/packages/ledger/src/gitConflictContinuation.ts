import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { RebaseContinueEffectBinding } from "@cq/process-control";
import type { GitPathState, GitRegularMode, DispatchBoundGitAuthorization } from "./gitChangeBroker.js";
import {
  assertManagedWorktreeConflictDispatchBindingLive,
  withManagedWorktreeEffectLock,
  type ManagedWorktreeDeps,
  type ManagedWorktreeDispatchBinding,
} from "./managedWorktree.js";

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REGULAR_MODES = new Set<GitRegularMode>(["100644", "100755"]);

export interface GitConflictStage {
  readonly path: string;
  readonly stage: 1 | 2 | 3;
  readonly mode: string;
  readonly oid: string;
}

export interface GitExpectedAncestry {
  readonly ancestor: string;
  readonly descendant: string;
}

export interface GitRebaseSequencerState {
  readonly kind: "rebase-merge";
  readonly identity: string;
  readonly headName: string;
  readonly originalTip: string;
  readonly onto: string;
  readonly stoppedCommit: string;
  readonly currentCommand: string;
  readonly todoDigest: string;
  readonly doneDigest: string;
}

export interface GitRebaseConflictState {
  readonly baseCommit: string;
  readonly currentHead: string;
  readonly expectedAncestry: readonly GitExpectedAncestry[];
  readonly sequencer: GitRebaseSequencerState;
  readonly conflicts: readonly GitConflictStage[];
}

export type GitConflictResolution =
  | { readonly kind: "regular"; readonly path: string; readonly newState: GitPathState }
  | { readonly kind: "delete"; readonly path: string };

export interface GitConflictContinuationRequest {
  readonly authorization: DispatchBoundGitAuthorization;
  readonly operationId: string;
  readonly expectedState: GitRebaseConflictState;
  readonly resolutions: readonly GitConflictResolution[];
}

export type GitConflictContinuationOutcome =
  | { readonly kind: "terminal"; readonly tip: string }
  | { readonly kind: "conflict"; readonly tip: string; readonly state: GitRebaseConflictState };

export interface GitConflictContinuationReceipt {
  readonly kind: "cq-git-conflict-continuation-receipt";
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly oldHead: string;
  readonly newHead: string;
  readonly objectOids: readonly string[];
  readonly paths: readonly string[];
  readonly outcome: GitConflictContinuationOutcome;
  readonly continuedAt: string;
}

export interface GitConflictContinuationResultEvidence {
  readonly taskId: string;
  readonly resultCommit: string | null;
  readonly branch: string;
  readonly actualWorktreePath: string;
  readonly filesResolved: readonly string[];
  readonly conflictReceipts: readonly GitConflictContinuationReceipt[];
}

export interface GitConflictContinuationDeps
  extends Pick<ManagedWorktreeDeps, "stateDir" | "lockfile"> {
  readonly authorize: (authorization: DispatchBoundGitAuthorization) => void | Promise<void>;
  readonly now?: () => Date;
  readonly runRebaseContinue?: (
    expected: RebaseContinueEffectBinding,
    resolveBinding: () => Promise<RebaseContinueEffectBinding>,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

export type GitConflictContinuationEvidenceDeps = Pick<ManagedWorktreeDeps, "stateDir">;

type JournalState =
  | "intent"
  | "prepared"
  | "git-finished"
  | "objects-installed"
  | "index-installed"
  | "completed";

const JOURNAL_STATES = new Set<JournalState>([
  "intent",
  "prepared",
  "git-finished",
  "objects-installed",
  "index-installed",
  "completed",
]);

interface ConflictJournal {
  readonly version: 1;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly state: JournalState;
  readonly privateIndex?: string;
  readonly privateIndexDigest?: string;
  readonly quarantine?: string;
  readonly preparedObjectOids?: readonly string[];
  readonly receipt?: GitConflictContinuationReceipt;
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

function requestDigest(request: GitConflictContinuationRequest): string {
  const { authorization, ...effect } = request;
  const { handleToken: _serverHeld, ...publicBinding } = authorization;
  void _serverHeld;
  return sha256(canonical({ authorization: publicBinding, ...effect }));
}

export function gitRebaseConflictStateDigest(state: GitRebaseConflictState): string {
  return sha256(canonical(state));
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
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    LANG: "C",
    LC_ALL: "C",
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  input?: Uint8Array,
): Promise<GitResult> {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "commit.cleanup=verbatim",
      "-c",
      "commit.status=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "merge.conflictStyle=merge",
      "-c",
      "merge.renormalize=false",
      "-c",
      "rebase.updateRefs=false",
      "-c",
      "rebase.autoStash=false",
      "-c",
      "rerere.enabled=false",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      cwd,
      env: environment ?? trustedGitEnvironment(),
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).then(([code, stdout, stderr]) => ({
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }));
}

async function checkedGit(
  cwd: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  input?: Uint8Array,
): Promise<Buffer> {
  const result = await runGit(cwd, args, environment, input);
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

async function gitDirectory(worktreePath: string): Promise<string> {
  return resolve(
    (await checkedGit(worktreePath, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]))
      .toString()
      .trim(),
  );
}

async function readSequencerFile(directory: string, name: string): Promise<Buffer> {
  const file = join(directory, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`rebase sequencer file ${name} must be a regular file`);
  }
  return await fs.readFile(file);
}

function currentCommand(done: string): string {
  const commands = done
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const command = commands.at(-1);
  if (command === undefined) throw new Error("rebase sequencer has no current command");
  return command;
}

async function assertAncestry(
  worktreePath: string,
  expected: readonly GitExpectedAncestry[],
): Promise<void> {
  for (const edge of expected) {
    if (!FULL_OID.test(edge.ancestor) || !FULL_OID.test(edge.descendant)) {
      throw new Error("expected ancestry contains a malformed Git oid");
    }
    const result = await runGit(worktreePath, [
      "merge-base",
      "--is-ancestor",
      edge.ancestor,
      edge.descendant,
    ]);
    if (result.code !== 0) {
      throw new Error(`expected ancestry ${edge.ancestor} -> ${edge.descendant} does not hold`);
    }
  }
}

async function observeConflictUnchecked(
  authorization: ManagedWorktreeDispatchBinding,
): Promise<GitRebaseConflictState> {
  const gitDir = await gitDirectory(authorization.worktreePath);
  const sequencerDir = join(gitDir, "rebase-merge");
  const sequencerStat = await fs.lstat(sequencerDir);
  if (!sequencerStat.isDirectory() || sequencerStat.isSymbolicLink()) {
    throw new Error("only the regular rebase-merge sequencer is supported");
  }
  const [headNameBytes, originalTipBytes, ontoBytes, stoppedBytes, todoBytes, doneBytes] =
    await Promise.all([
      readSequencerFile(sequencerDir, "head-name"),
      readSequencerFile(sequencerDir, "orig-head"),
      readSequencerFile(sequencerDir, "onto"),
      readSequencerFile(sequencerDir, "stopped-sha"),
      readSequencerFile(sequencerDir, "git-rebase-todo"),
      readSequencerFile(sequencerDir, "done"),
    ]);
  const headName = headNameBytes.toString().trim();
  const originalTip = originalTipBytes.toString().trim();
  const onto = ontoBytes.toString().trim();
  const stoppedCommit = stoppedBytes.toString().trim();
  const currentHead = (
    await checkedGit(authorization.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])
  )
    .toString()
    .trim();
  for (const [label, oid] of [
    ["original tip", originalTip],
    ["onto", onto],
    ["stopped commit", stoppedCommit],
    ["current HEAD", currentHead],
    ["base commit", authorization.baseCommit],
  ] as const) {
    if (!FULL_OID.test(oid)) throw new Error(`rebase ${label} is not a full Git oid`);
  }
  if (headName !== authorization.ref) throw new Error("rebase sequencer head-name is not the bound task ref");
  const rawStages = (
    await checkedGit(authorization.worktreePath, ["ls-files", "--unmerged", "-z"])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const conflicts = rawStages.map((line): GitConflictStage => {
    const match = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/u.exec(line);
    if (match === null) throw new Error("Git returned an invalid unmerged-index entry");
    return Object.freeze({
      path: assertPath(match[4]!, "conflict path"),
      stage: Number(match[3]) as 1 | 2 | 3,
      mode: match[1]!,
      oid: match[2]!,
    });
  });
  if (conflicts.length === 0) throw new Error("rebase sequencer has no conflicted index entries");
  conflicts.sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage);
  const gitDirStat = await fs.lstat(gitDir);
  const identity = sha256(
    canonical({
      commonDir: authorization.commonDir,
      gitDirDev: gitDirStat.dev,
      gitDirIno: gitDirStat.ino,
      headName,
      originalTip,
      onto,
    }),
  );
  const expectedAncestry = Object.freeze([
    Object.freeze({ ancestor: authorization.baseCommit, descendant: originalTip }),
    Object.freeze({ ancestor: authorization.baseCommit, descendant: onto }),
    Object.freeze({ ancestor: onto, descendant: currentHead }),
  ]);
  await assertAncestry(authorization.worktreePath, expectedAncestry);
  return Object.freeze({
    baseCommit: authorization.baseCommit,
    currentHead,
    expectedAncestry,
    sequencer: Object.freeze({
      kind: "rebase-merge" as const,
      identity,
      headName,
      originalTip,
      onto,
      stoppedCommit,
      currentCommand: currentCommand(doneBytes.toString()),
      todoDigest: sha256(todoBytes),
      doneDigest: sha256(doneBytes),
    }),
    conflicts: Object.freeze(conflicts),
  });
}

/** Trusted parent observation of every coordinate later bound to one continuation request. */
export async function observeManagedRebaseConflict(
  authorization: DispatchBoundGitAuthorization,
  deps: Pick<ManagedWorktreeDeps, "stateDir">,
): Promise<GitRebaseConflictState> {
  if (authorization.roleId !== "implement-conflict-resolver") {
    throw new Error("rebase conflict observation is reserved for implement-conflict-resolver");
  }
  return await observeManagedWorktreeConflictState(authorization, deps);
}

/** Trusted-manager observation used to bind a resolver dispatch before capability minting. */
export async function observeManagedWorktreeConflictState(
  binding: ManagedWorktreeDispatchBinding,
  deps: Pick<ManagedWorktreeDeps, "stateDir">,
): Promise<GitRebaseConflictState> {
  await assertManagedWorktreeConflictDispatchBindingLive(binding, deps);
  return await observeConflictUnchecked(binding);
}

function assertSupportedSequencer(state: GitRebaseConflictState): void {
  const fields = state.sequencer.currentCommand.split(/\s+/u);
  const current = fields[0];
  if (current !== "pick") throw new Error(`unsupported current rebase command ${String(current)}`);
  const commandOid = fields[1];
  if (
    commandOid === undefined ||
    (!state.sequencer.stoppedCommit.startsWith(commandOid) &&
      !commandOid.startsWith(state.sequencer.stoppedCommit))
  ) {
    throw new Error("current rebase command does not name stopped-sha");
  }
}

async function assertTodoHasNoExec(authorization: DispatchBoundGitAuthorization): Promise<void> {
  const todo = await readSequencerFile(join(await gitDirectory(authorization.worktreePath), "rebase-merge"), "git-rebase-todo");
  for (const line of todo.toString().split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const command = trimmed.split(/\s+/u)[0];
    if (command !== "pick") throw new Error(`unsupported rebase todo command ${String(command)}`);
  }
}

async function assertNoSequencerOptions(
  authorization: DispatchBoundGitAuthorization,
): Promise<void> {
  const sequencerDir = join(
    await gitDirectory(authorization.worktreePath),
    "rebase-merge",
  );
  for (const name of [
    "allow_rerere_autoupdate",
    "gpg_sign_opt",
    "reschedule-failed-exec",
    "signoff",
    "strategy",
    "strategy_opts",
    "update-refs",
  ]) {
    try {
      await fs.lstat(join(sequencerDir, name));
      throw new Error(`unsupported rebase sequencer option ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function assertHermeticConfiguration(
  authorization: DispatchBoundGitAuthorization,
): Promise<void> {
  const configured = await runGit(authorization.worktreePath, [
    "config",
    "--includes",
    "--get-regexp",
    "^(filter\\.|merge\\..*\\.driver$)",
  ]);
  if (configured.code === 0 && configured.stdout.length > 0) {
    throw new Error("configured Git filters or external merge drivers are unsupported during conflict continuation");
  }
  if (configured.code !== 0 && configured.code !== 1) {
    throw new Error(`git config inspection failed: ${configured.stderr.toString().trim()}`);
  }
  const replacements = await checkedGit(authorization.worktreePath, ["for-each-ref", "--format=%(refname)", "refs/replace"]);
  if (replacements.length > 0) {
    throw new Error("replace refs are unsupported during conflict continuation");
  }
  const trackedPaths = await checkedGit(authorization.worktreePath, ["ls-files", "-z"]);
  const attributes = (
    await checkedGit(
      authorization.worktreePath,
      ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"],
      undefined,
      trackedPaths,
    )
  )
    .toString()
    .split("\0");
  if (attributes.at(-1) === "") attributes.pop();
  if (attributes.length % 3 !== 0) {
    throw new Error("Git returned malformed attribute inspection output");
  }
  for (let index = 0; index < attributes.length; index += 3) {
    if (attributes[index + 2] !== "unspecified") {
      throw new Error(
        `Git filter attribute ${attributes[index + 1]} is active for ${attributes[index]}`,
      );
    }
  }
}

async function assertExactResolutionWorktreePaths(
  authorization: DispatchBoundGitAuthorization,
  expected: readonly string[],
): Promise<void> {
  const modified = (
    await checkedGit(authorization.worktreePath, ["diff", "--name-only", "-z", "--"])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await checkedGit(authorization.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const observed = [...new Set([...modified, ...untracked])].sort();
  if (canonical(observed) !== canonical(expected)) {
    throw new Error(
      `resolution worktree paths [${observed.join(", ")}] do not equal conflicts [${expected.join(", ")}]`,
    );
  }
}

function resolutionPaths(
  state: GitRebaseConflictState,
  resolutions: readonly GitConflictResolution[],
): readonly string[] {
  const conflicted = [...new Set(state.conflicts.map((stage) => stage.path))].sort();
  const paths = resolutions.map((resolution, index) =>
    assertPath(resolution.path, `resolutions[${index}].path`),
  );
  if (paths.length !== new Set(paths).size) throw new Error("resolution paths must be unique");
  if (canonical([...paths].sort()) !== canonical(conflicted)) {
    throw new Error("resolution paths must equal the complete conflicted path set");
  }
  for (const [index, resolution] of resolutions.entries()) {
    if (resolution.kind === "regular") {
      if (!REGULAR_MODES.has(resolution.newState.mode) || !SHA256.test(resolution.newState.digest)) {
        throw new Error(`resolutions[${index}].newState must contain a regular mode and SHA-256`);
      }
    } else if (resolution.kind !== "delete") {
      throw new Error(`resolutions[${index}].kind is unsupported`);
    }
  }
  for (const stage of state.conflicts) {
    if (!FULL_OID.test(stage.oid) || !REGULAR_MODES.has(stage.mode as GitRegularMode)) {
      throw new Error(`unsupported symlink or gitlink conflict stage at ${stage.path}`);
    }
  }
  return Object.freeze([...paths].sort());
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
  let parent = resolve(root);
  const identities: { readonly path: string; readonly dev: number; readonly ino: number }[] = [];
  for (const component of entryPath.split("/").slice(0, -1)) {
    parent = join(parent, component);
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`path ${entryPath} has a non-directory or symlink ancestor`);
    }
    identities.push({ path: parent, dev: stat.dev, ino: stat.ino });
  }
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`path ${entryPath} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathStat = await fs.lstat(absolute);
    for (const identity of identities) {
      const observed = await fs.lstat(identity.path);
      if (!observed.isDirectory() || observed.dev !== identity.dev || observed.ino !== identity.ino) {
        throw new Error(`path ${entryPath} changed while conflict continuation snapshotted it`);
      }
    }
    const mode: GitRegularMode = (after.mode & 0o111) === 0 ? "100644" : "100755";
    if (
      !pathStat.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathStat.dev !== after.dev ||
      pathStat.ino !== after.ino ||
      mode !== expected.mode ||
      sha256(bytes) !== expected.digest
    ) {
      throw new Error(`path ${entryPath} changed or does not match its declared resolution`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function actualIndexPath(authorization: DispatchBoundGitAuthorization): Promise<string> {
  const indexPath = resolve(
    (await checkedGit(authorization.worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]))
      .toString()
      .trim(),
  );
  const relation = relative(resolve(authorization.commonDir), indexPath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("task index path escapes the bound repository common directory");
  }
  return indexPath;
}

function operationRoot(
  authorization: DispatchBoundGitAuthorization,
  operationId: string,
  stateDir?: string,
): string {
  const root = stateDir ?? join(authorization.repositoryRoot, ".claude", "worktrees", ".cq-managed-registry");
  const key = sha256(`${authorization.attestationId}\n${authorization.generation}\n${operationId}`);
  return join(root, "git-conflict-broker", key);
}

async function writeJournal(file: string, journal: ConflictJournal): Promise<void> {
  const journalDirectory = dirname(file);
  await fs.mkdir(journalDirectory, { recursive: true });
  await syncDirectory(journalDirectory);
  await syncDirectory(dirname(journalDirectory));
  await syncDirectory(dirname(dirname(journalDirectory)));
  const temporary = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await syncDirectory(journalDirectory);
}

async function readJournal(file: string): Promise<ConflictJournal | null> {
  try {
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: string;
    try {
      bytes = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const journal = JSON.parse(bytes) as ConflictJournal;
    if (
      journal === null ||
      typeof journal !== "object" ||
      journal.version !== 1 ||
      !SHA256.test(journal.requestDigest) ||
      typeof journal.createdAt !== "string" ||
      new Date(journal.createdAt).toISOString() !== journal.createdAt ||
      !JOURNAL_STATES.has(journal.state)
    ) {
      throw new Error("invalid durable conflict-continuation journal");
    }
    if (journal.state === "intent") {
      if (
        journal.privateIndex !== undefined ||
        journal.privateIndexDigest !== undefined ||
        journal.quarantine !== undefined ||
        journal.preparedObjectOids !== undefined ||
        journal.receipt !== undefined
      ) {
        throw new Error("invalid intent conflict-continuation journal");
      }
    } else if (
      typeof journal.privateIndex !== "string" ||
      !SHA256.test(journal.privateIndexDigest ?? "") ||
      typeof journal.quarantine !== "string" ||
      !Array.isArray(journal.preparedObjectOids) ||
      journal.preparedObjectOids.some((oid) => !FULL_OID.test(oid)) ||
      canonical(journal.preparedObjectOids) !==
        canonical([...new Set(journal.preparedObjectOids)].sort()) ||
      (journal.state === "completed") !== (journal.receipt !== undefined)
    ) {
      throw new Error("invalid prepared conflict-continuation journal");
    }
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function regularFileDigestNoFollow(file: string): Promise<string> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${file} must be a regular file`);
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function quarantineOids(directory: string): Promise<readonly string[]> {
  const oids: string[] = [];
  for (const prefixEntry of await fs.readdir(directory, { withFileTypes: true })) {
    if (prefixEntry.name === "info" || prefixEntry.name === "pack") {
      if (!prefixEntry.isDirectory() || (await fs.readdir(join(directory, prefixEntry.name))).length > 0) {
        throw new Error(`unsupported quarantine entry ${prefixEntry.name}`);
      }
      continue;
    }
    if (!prefixEntry.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefixEntry.name)) {
      throw new Error(`unsupported quarantine entry ${prefixEntry.name}`);
    }
    for (const suffixEntry of await fs.readdir(join(directory, prefixEntry.name), {
      withFileTypes: true,
    })) {
      const oid = `${prefixEntry.name}${suffixEntry.name}`;
      if (!suffixEntry.isFile() || suffixEntry.isSymbolicLink() || !FULL_OID.test(oid)) {
        throw new Error(`unsupported quarantine object ${oid}`);
      }
      oids.push(oid);
    }
  }
  return Object.freeze(oids.sort());
}

async function installObjects(
  authorization: DispatchBoundGitAuthorization,
  quarantine: string,
  objectOids: readonly string[],
): Promise<void> {
  const objectRoot = join(authorization.commonDir, "objects");
  for (const oid of objectOids) {
    const source = join(quarantine, oid.slice(0, 2), oid.slice(2));
    const target = join(objectRoot, oid.slice(0, 2), oid.slice(2));
    const targetDirectory = dirname(target);
    await fs.mkdir(targetDirectory, { recursive: true });
    await syncDirectory(objectRoot);
    const sourceHandle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let attributed: Buffer;
    try {
      attributed = await sourceHandle.readFile();
    } finally {
      await sourceHandle.close();
    }
    const temporary = `${target}.cq-${basename(dirname(quarantine))}`;
    await fs.rm(temporary, { force: true });
    const temporaryHandle = await fs.open(temporary, "wx", 0o444);
    try {
      await temporaryHandle.writeFile(attributed);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    try {
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingHandle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let existing: Buffer;
        try {
          existing = await existingHandle.readFile();
        } finally {
          await existingHandle.close();
        }
        if (!existing.equals(attributed)) {
          throw new Error(`pre-existing object ${oid} has different bytes`);
        }
      }
    } finally {
      await fs.unlink(temporary);
    }
    await syncDirectory(targetDirectory);
  }
}

async function installIndex(authorization: DispatchBoundGitAuthorization, privateIndex: string): Promise<void> {
  const indexPath = await actualIndexPath(authorization);
  const temporary = `${indexPath}.cq-conflict-${basename(dirname(privateIndex))}`;
  await fs.rm(temporary, { force: true });
  const privateHandle = await fs.open(privateIndex, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await privateHandle.readFile();
  } finally {
    await privateHandle.close();
  }
  const installed = await fs.open(temporary, "wx", 0o600);
  try {
    await installed.writeFile(bytes);
    await installed.sync();
  } finally {
    await installed.close();
  }
  await fs.rename(temporary, indexPath);
  await syncDirectory(dirname(indexPath));
}

async function preparePrivateIndex(
  request: GitConflictContinuationRequest,
  root: string,
): Promise<{
  readonly privateIndex: string;
  readonly privateIndexDigest: string;
  readonly quarantine: string;
  readonly preparedObjectOids: readonly string[];
}> {
  const privateIndex = join(root, "index");
  const quarantine = join(root, "objects");
  await fs.mkdir(join(quarantine, "info"), { recursive: true });
  await fs.mkdir(join(quarantine, "pack"), { recursive: true });
  await fs.copyFile(await actualIndexPath(request.authorization), privateIndex, fsConstants.COPYFILE_EXCL);
  const privateIndexHandle = await fs.open(privateIndex, "r");
  try {
    await privateIndexHandle.sync();
  } finally {
    await privateIndexHandle.close();
  }
  await syncDirectory(root);
  const environment = {
    ...trustedGitEnvironment(),
    GIT_INDEX_FILE: privateIndex,
    GIT_OBJECT_DIRECTORY: quarantine,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(request.authorization.commonDir, "objects"),
  };
  for (const resolution of request.resolutions) {
    if (resolution.kind === "delete") {
      try {
        await fs.lstat(join(request.authorization.worktreePath, resolution.path));
        throw new Error(`deleted resolution ${resolution.path} still exists in the worktree`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await checkedGit(
        request.authorization.worktreePath,
        ["update-index", "--force-remove", "--", resolution.path],
        environment,
      );
      continue;
    }
    const bytes = await snapshotRegularFile(
      request.authorization.worktreePath,
      resolution.path,
      resolution.newState,
    );
    const oid = (
      await checkedGit(request.authorization.worktreePath, ["hash-object", "-w", "--stdin"], environment, bytes)
    )
      .toString()
      .trim();
    await checkedGit(
      request.authorization.worktreePath,
      ["update-index", "--add", "--cacheinfo", `${resolution.newState.mode},${oid},${resolution.path}`],
      environment,
    );
  }
  const unresolved = await checkedGit(request.authorization.worktreePath, ["ls-files", "--unmerged"], environment);
  if (unresolved.length > 0) throw new Error("private index still contains unresolved conflict stages");
  return {
    privateIndex,
    privateIndexDigest: await regularFileDigestNoFollow(privateIndex),
    quarantine,
    preparedObjectOids: await quarantineOids(quarantine),
  };
}

async function runAuthorizedContinue(
  request: GitConflictContinuationRequest,
  privateIndex: string,
  quarantine: string,
  deps: GitConflictContinuationDeps,
): Promise<void> {
  const environment = {
    ...trustedGitEnvironment(),
    GIT_INDEX_FILE: privateIndex,
    GIT_OBJECT_DIRECTORY: quarantine,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(request.authorization.commonDir, "objects"),
  };
  const expected: RebaseContinueEffectBinding = {
    kind: "rebase",
    targetRef: `tasks:${request.authorization.taskId}`,
    repositoryRoot: request.authorization.repositoryRoot,
    worktreePath: request.authorization.worktreePath,
    continueAtHead: request.expectedState.currentHead,
  };
  const resolveBinding = async (): Promise<RebaseContinueEffectBinding> => {
    await deps.authorize(request.authorization);
    await assertManagedWorktreeConflictDispatchBindingLive(request.authorization, deps);
    if (
      canonical(await observeConflictUnchecked(request.authorization)) !==
      canonical(request.expectedState)
    ) {
      throw new Error("rebase transaction changed before brokered continuation launch");
    }
    return expected;
  };
  const result =
    deps.runRebaseContinue === undefined
      ? await runGit(request.authorization.worktreePath, ["rebase", "--continue"], environment)
      : await deps.runRebaseContinue(expected, resolveBinding, environment);
  if (result.code === 0) return;
  const unresolved = await checkedGit(
    request.authorization.worktreePath,
    ["ls-files", "--unmerged"],
    {
      ...trustedGitEnvironment(),
      GIT_INDEX_FILE: privateIndex,
      GIT_OBJECT_DIRECTORY: quarantine,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(request.authorization.commonDir, "objects"),
    },
  );
  if (unresolved.length === 0) {
    throw new Error(`hermetic git rebase --continue failed: ${result.stderr.toString().trim()}`);
  }
}

async function currentOutcome(
  authorization: DispatchBoundGitAuthorization,
): Promise<GitConflictContinuationOutcome> {
  try {
    const state = await observeConflictUnchecked(authorization);
    await assertExactResolutionWorktreePaths(
      authorization,
      [...new Set(state.conflicts.map((stage) => stage.path))].sort(),
    );
    return Object.freeze({ kind: "conflict" as const, tip: state.currentHead, state });
  } catch (error) {
    try {
      await fs.lstat(join(await gitDirectory(authorization.worktreePath), "rebase-merge"));
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
        const tip = (
          await checkedGit(authorization.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])
        )
          .toString()
          .trim();
        const symbolic = await checkedGit(authorization.worktreePath, [
          "symbolic-ref",
          "--quiet",
          "HEAD",
        ]);
        if (symbolic.toString().trim() !== authorization.ref) {
          throw new Error("terminal rebase did not restore the bound task ref");
        }
        const status = await checkedGit(authorization.worktreePath, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        if (status.length !== 0) throw new Error("terminal rebase left a dirty worktree");
        return Object.freeze({ kind: "terminal" as const, tip });
      }
    }
    throw error;
  }
}

async function transactionCoordinatesChanged(
  authorization: ManagedWorktreeDispatchBinding,
  expected: GitRebaseConflictState,
): Promise<boolean> {
  const gitDir = await gitDirectory(authorization.worktreePath);
  const sequencerDir = join(gitDir, "rebase-merge");
  try {
    const [gitDirStat, sequencerStat] = await Promise.all([
      fs.lstat(gitDir),
      fs.lstat(sequencerDir),
    ]);
    if (!sequencerStat.isDirectory() || sequencerStat.isSymbolicLink()) return true;
    const [head, headName, originalTip, onto, stopped, todo, done] = await Promise.all([
      readSequencerFile(gitDir, "HEAD"),
      readSequencerFile(sequencerDir, "head-name"),
      readSequencerFile(sequencerDir, "orig-head"),
      readSequencerFile(sequencerDir, "onto"),
      readSequencerFile(sequencerDir, "stopped-sha"),
      readSequencerFile(sequencerDir, "git-rebase-todo"),
      readSequencerFile(sequencerDir, "done"),
    ]);
    const identity = sha256(
      canonical({
        commonDir: authorization.commonDir,
        gitDirDev: gitDirStat.dev,
        gitDirIno: gitDirStat.ino,
        headName: headName.toString().trim(),
        originalTip: originalTip.toString().trim(),
        onto: onto.toString().trim(),
      }),
    );
    return (
      head.toString().trim() !== expected.currentHead ||
      headName.toString().trim() !== expected.sequencer.headName ||
      originalTip.toString().trim() !== expected.sequencer.originalTip ||
      onto.toString().trim() !== expected.sequencer.onto ||
      stopped.toString().trim() !== expected.sequencer.stoppedCommit ||
      sha256(todo) !== expected.sequencer.todoDigest ||
      sha256(done) !== expected.sequencer.doneDigest ||
      identity !== expected.sequencer.identity
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function assertReceiptMatchesRequest(
  receipt: GitConflictContinuationReceipt,
  journal: ConflictJournal,
  request: GitConflictContinuationRequest,
  paths: readonly string[],
): void {
  if (
    receipt.kind !== "cq-git-conflict-continuation-receipt" ||
    receipt.version !== 1 ||
    receipt.attestationId !== request.authorization.attestationId ||
    receipt.generation !== request.authorization.generation ||
    receipt.taskId !== request.authorization.taskId ||
    receipt.operationId !== request.operationId ||
    receipt.requestDigest !== journal.requestDigest ||
    receipt.oldHead !== request.expectedState.currentHead ||
    receipt.newHead === receipt.oldHead ||
    receipt.continuedAt !== journal.createdAt ||
    canonical(receipt.paths) !== canonical(paths) ||
    !Array.isArray(receipt.objectOids) ||
    canonical(receipt.objectOids) !== canonical([...new Set(receipt.objectOids)].sort()) ||
    receipt.objectOids.some((oid) => !FULL_OID.test(oid)) ||
    receipt.outcome === null ||
    typeof receipt.outcome !== "object" ||
    receipt.newHead !== receipt.outcome.tip ||
    !FULL_OID.test(receipt.newHead) ||
    (receipt.outcome.kind !== "terminal" && receipt.outcome.kind !== "conflict") ||
    (receipt.outcome.kind === "conflict" &&
      receipt.outcome.state.currentHead !== receipt.outcome.tip)
  ) {
    throw new Error("durable conflict-continuation receipt does not match its request journal");
  }
}

async function completePrepared(
  request: GitConflictContinuationRequest,
  journalFile: string,
  journal: ConflictJournal,
  paths: readonly string[],
  deps: GitConflictContinuationDeps,
): Promise<GitConflictContinuationReceipt> {
  const privateIndex = journal.privateIndex;
  const privateIndexDigest = journal.privateIndexDigest;
  const quarantine = journal.quarantine;
  const preparedObjectOids = journal.preparedObjectOids;
  if (
    privateIndex === undefined ||
    privateIndexDigest === undefined ||
    quarantine === undefined ||
    preparedObjectOids === undefined
  ) {
    throw new Error("prepared conflict-continuation journal is incomplete");
  }
  const operationDirectory = dirname(journalFile);
  if (
    privateIndex !== join(operationDirectory, "index") ||
    quarantine !== join(operationDirectory, "objects")
  ) {
    throw new Error("prepared conflict-continuation paths escape their operation directory");
  }
  let state = journal.state;
  if (state === "prepared") {
    const gitMayHaveRun =
      (await regularFileDigestNoFollow(privateIndex)) !== privateIndexDigest ||
      canonical(await quarantineOids(quarantine)) !== canonical(preparedObjectOids) ||
      (await transactionCoordinatesChanged(request.authorization, request.expectedState));
    let stillAtExpected = false;
    try {
      stillAtExpected = canonical(await observeConflictUnchecked(request.authorization)) === canonical(request.expectedState);
    } catch (error) {
      if (!gitMayHaveRun) throw error;
    }
    if (stillAtExpected && !gitMayHaveRun) {
      await runAuthorizedContinue(request, privateIndex, quarantine, deps);
    }
    state = "git-finished";
    await writeJournal(journalFile, { ...journal, state });
  }
  const objectOids = await quarantineOids(quarantine);
  if (state === "git-finished") {
    await installObjects(request.authorization, quarantine, objectOids);
    state = "objects-installed";
    await writeJournal(journalFile, { ...journal, state });
  }
  if (state === "objects-installed") {
    await installIndex(request.authorization, privateIndex);
    state = "index-installed";
    await writeJournal(journalFile, { ...journal, state });
  }
  const outcome = await currentOutcome(request.authorization);
  const receipt: GitConflictContinuationReceipt = Object.freeze({
    kind: "cq-git-conflict-continuation-receipt" as const,
    version: 1 as const,
    attestationId: request.authorization.attestationId,
    generation: request.authorization.generation,
    taskId: request.authorization.taskId,
    operationId: request.operationId,
    requestDigest: journal.requestDigest,
    oldHead: request.expectedState.currentHead,
    newHead: outcome.tip,
    objectOids,
    paths,
    outcome,
    continuedAt: journal.createdAt,
  });
  assertReceiptMatchesRequest(receipt, journal, request, paths);
  await writeJournal(journalFile, { ...journal, state: "completed", receipt });
  return receipt;
}

/** Continue exactly the parent-observed conflicted rebase step under the manager lock. */
export async function continueManagedWorktreeRebase(
  request: GitConflictContinuationRequest,
  deps: GitConflictContinuationDeps,
): Promise<GitConflictContinuationReceipt> {
  if (!OPERATION_ID.test(request.operationId)) {
    throw new Error("operationId must match /^[A-Za-z0-9_-]{1,128}$/");
  }
  if (request.authorization.roleId !== "implement-conflict-resolver") {
    throw new Error("conflict continuation is authorized only for implement-conflict-resolver");
  }
  const now = (deps.now ?? (() => new Date()))();
  const deadline = Date.parse(request.authorization.childCancelAt);
  if (!Number.isFinite(deadline) || now.getTime() > deadline) {
    throw new Error("conflict-continuation authorization has expired");
  }
  const paths = resolutionPaths(request.expectedState, request.resolutions);
  const digest = requestDigest(request);
  const root = operationRoot(request.authorization, request.operationId, deps.stateDir);
  const journalFile = join(root, "journal.json");
  return await withManagedWorktreeEffectLock(request.authorization, deps, async () => {
    await deps.authorize(request.authorization);
    await assertManagedWorktreeConflictDispatchBindingLive(request.authorization, deps);
    let journal = await readJournal(journalFile);
    if (journal !== null) {
      if (journal.requestDigest !== digest) {
        throw new Error(`operationId ${request.operationId} was reused with a different request`);
      }
      if (journal.state === "completed") {
        if (journal.receipt === undefined) throw new Error("completed continuation journal lacks receipt");
        assertReceiptMatchesRequest(journal.receipt, journal, request, paths);
        return journal.receipt;
      }
      if (journal.state !== "intent") {
        return await completePrepared(request, journalFile, journal, paths, deps);
      }
    }
    const expectedDigest = gitRebaseConflictStateDigest(request.expectedState);
    if (expectedDigest !== request.authorization.conflictStateDigest) {
      const predecessors = await durableReceipts(request.authorization, deps);
      const authorizingPredecessors = predecessors.filter(
        (receipt) =>
          receipt.outcome.kind === "conflict" &&
          canonical(receipt.outcome.state) === canonical(request.expectedState),
      );
      if (authorizingPredecessors.length !== 1) {
        throw new Error("expected rebase state was not parent-bound or returned by one prior step");
      }
    }
    if (journal === null) {
      journal = { version: 1, requestDigest: digest, createdAt: now.toISOString(), state: "intent" };
      await writeJournal(journalFile, journal);
    }
    await deps.authorize(request.authorization);
    await assertManagedWorktreeConflictDispatchBindingLive(request.authorization, deps);
    const observed = await observeConflictUnchecked(request.authorization);
    if (canonical(observed) !== canonical(request.expectedState)) {
      throw new Error("parent-observed rebase transaction no longer matches current state");
    }
    assertSupportedSequencer(observed);
    await assertTodoHasNoExec(request.authorization);
    await assertNoSequencerOptions(request.authorization);
    await assertHermeticConfiguration(request.authorization);
    await assertExactResolutionWorktreePaths(request.authorization, paths);
    await fs.rm(join(root, "index"), { force: true });
    await fs.rm(join(root, "objects"), { recursive: true, force: true });
    const prepared = await preparePrivateIndex(request, root);
    journal = { ...journal, state: "prepared", ...prepared };
    await writeJournal(journalFile, journal);
    await deps.authorize(request.authorization);
    await assertManagedWorktreeConflictDispatchBindingLive(request.authorization, deps);
    if (canonical(await observeConflictUnchecked(request.authorization)) !== canonical(request.expectedState)) {
      throw new Error("rebase transaction changed after private index construction");
    }
    return await completePrepared(request, journalFile, journal, paths, deps);
  });
}

function brokerRoot(binding: ManagedWorktreeDispatchBinding, stateDir?: string): string {
  return stateDir ?? join(binding.repositoryRoot, ".claude", "worktrees", ".cq-managed-registry");
}

function orderReceiptChain(
  receipts: readonly GitConflictContinuationReceipt[],
): readonly GitConflictContinuationReceipt[] {
  if (receipts.length < 2) return Object.freeze([...receipts]);
  const newHeads = new Set(receipts.map((receipt) => receipt.newHead));
  const starts = receipts.filter((receipt) => !newHeads.has(receipt.oldHead));
  if (starts.length !== 1) throw new Error("durable continuation receipts do not have one chain start");
  const byOldHead = new Map<string, GitConflictContinuationReceipt>();
  for (const receipt of receipts) {
    if (byOldHead.has(receipt.oldHead)) {
      throw new Error("durable continuation receipts fork from one oldHead");
    }
    byOldHead.set(receipt.oldHead, receipt);
  }
  const ordered: GitConflictContinuationReceipt[] = [];
  let cursor: GitConflictContinuationReceipt | undefined = starts[0];
  while (cursor !== undefined) {
    ordered.push(cursor);
    byOldHead.delete(cursor.oldHead);
    cursor = byOldHead.get(cursor.newHead);
  }
  if (byOldHead.size !== 0) throw new Error("durable continuation receipts do not form one chain");
  return Object.freeze(ordered);
}

async function collectDurableReceipts(
  binding: ManagedWorktreeDispatchBinding,
  deps: GitConflictContinuationEvidenceDeps,
  predicate: (receipt: GitConflictContinuationReceipt) => boolean,
): Promise<readonly GitConflictContinuationReceipt[]> {
  const root = join(brokerRoot(binding, deps.stateDir), "git-conflict-broker");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const receipts: GitConflictContinuationReceipt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = await readJournal(join(root, entry.name, "journal.json"));
    if (journal?.state !== "completed" || journal.receipt === undefined) continue;
    const receipt = journal.receipt;
    if (!predicate(receipt)) continue;
    const expectedDirectory = sha256(
      `${receipt.attestationId}\n${String(receipt.generation)}\n${receipt.operationId}`,
    );
    if (entry.name !== expectedDirectory) {
      throw new Error(`durable continuation receipt ${receipt.operationId} has a substituted operationId`);
    }
    if (receipt.requestDigest !== journal.requestDigest || receipt.continuedAt !== journal.createdAt) {
      throw new Error(`durable continuation receipt ${receipt.operationId} does not match its journal`);
    }
    receipts.push(receipt);
  }
  return orderReceiptChain(receipts);
}

async function durableReceipts(
  authorization: DispatchBoundGitAuthorization,
  deps: GitConflictContinuationEvidenceDeps,
): Promise<readonly GitConflictContinuationReceipt[]> {
  return await collectDurableReceipts(
    authorization,
    deps,
    (receipt) =>
      receipt.attestationId === authorization.attestationId &&
      receipt.generation === authorization.generation &&
      receipt.taskId === authorization.taskId,
  );
}

/**
 * Every durable continuation receipt one managed handle produced, across every
 * resolver generation, as one ordered chain. The guarded-rebase journal uses
 * this to reconcile a conflicted rebase to its verified terminal tip (D334).
 */
export async function durableHandleConflictContinuationReceipts(
  binding: ManagedWorktreeDispatchBinding,
  deps: GitConflictContinuationEvidenceDeps,
): Promise<readonly GitConflictContinuationReceipt[]> {
  return await collectDurableReceipts(binding, deps, (receipt) => receipt.taskId === binding.taskId);
}

/** Trusted-parent validation of resolver continuation receipts before result storage. */
export async function validateGitConflictContinuationResultEvidence(
  authorization: DispatchBoundGitAuthorization,
  evidence: GitConflictContinuationResultEvidence,
  deps: GitConflictContinuationEvidenceDeps,
): Promise<void> {
  if (authorization.roleId !== "implement-conflict-resolver") {
    throw new Error("conflict receipt verification requires a resolver authorization");
  }
  if (evidence.resultCommit !== null && !FULL_OID.test(evidence.resultCommit)) {
    throw new Error("conflict receipt resultCommit must be null or a full oid");
  }
  if (evidence.taskId !== authorization.taskId || evidence.branch !== authorization.branch) {
    throw new Error("conflict receipt result identity does not match the dispatch binding");
  }
  if (!isAbsolute(evidence.actualWorktreePath) || resolve(evidence.actualWorktreePath) !== resolve(authorization.worktreePath)) {
    throw new Error("conflict receipt worktree path does not match the dispatch binding");
  }
  const durable = await durableReceipts(authorization, deps);
  if (canonical(durable) !== canonical(evidence.conflictReceipts)) {
    throw new Error("conflict receipt chain omits, invents, or substitutes a durable operation");
  }
  if (evidence.conflictReceipts.length === 0) {
    if (evidence.resultCommit !== null || evidence.filesResolved.length !== 0) {
      throw new Error("an empty conflict receipt chain can describe only a pre-mutation failure");
    }
    return;
  }
  let previous: string | undefined;
  const paths = new Set<string>();
  for (const [index, receipt] of evidence.conflictReceipts.entries()) {
    if (receipt.kind !== "cq-git-conflict-continuation-receipt" || receipt.version !== 1) {
      throw new Error(`conflict receipt ${index} has an unsupported kind or version`);
    }
    if (previous !== undefined && receipt.oldHead !== previous) {
      throw new Error(`conflict receipt ${index} does not continue the preceding step`);
    }
    const ancestry = await runGit(authorization.worktreePath, [
      "merge-base",
      "--is-ancestor",
      receipt.oldHead,
      receipt.newHead,
    ]);
    if (ancestry.code !== 0) {
      throw new Error(`conflict receipt ${index} does not advance from its oldHead`);
    }
    if (receipt.outcome.kind === "conflict" && canonical(receipt.outcome.state.currentHead) !== canonical(receipt.newHead)) {
      throw new Error(`conflict receipt ${index} next state has a substituted HEAD`);
    }
    if (index < evidence.conflictReceipts.length - 1 && receipt.outcome.kind !== "conflict") {
      throw new Error(`conflict receipt ${index} terminates before the chain end`);
    }
    for (const oid of receipt.objectOids) await checkedGit(authorization.worktreePath, ["cat-file", "-e", oid]);
    for (const entryPath of receipt.paths) paths.add(assertPath(entryPath, "receipt path"));
    previous = receipt.newHead;
  }
  const final = evidence.conflictReceipts.at(-1)!;
  const actualHead = (await checkedGit(authorization.worktreePath, ["rev-parse", "HEAD"]))
    .toString()
    .trim();
  if (evidence.resultCommit === null) {
    if (final.outcome.kind !== "conflict") {
      throw new Error("a failed conflict result cannot conceal a terminal continuation receipt");
    }
    if (actualHead !== final.newHead) {
      throw new Error("failed conflict receipt chain does not end at the worktree tip");
    }
    const observed = await observeManagedRebaseConflict(authorization, deps);
    if (canonical(observed) !== canonical(final.outcome.state)) {
      throw new Error("failed conflict receipt chain does not end at the live conflict state");
    }
  } else {
    if (final.outcome.kind !== "terminal" || final.newHead !== evidence.resultCommit) {
      throw new Error("conflict receipt chain is not terminal at resultCommit");
    }
    if (actualHead !== evidence.resultCommit) {
      throw new Error("conflict receipt resultCommit is not the worktree tip");
    }
  }
  const claimed = evidence.filesResolved.map((entryPath) => assertPath(entryPath, "filesResolved")).sort();
  if (canonical([...paths].sort()) !== canonical([...new Set(claimed)])) {
    throw new Error("conflict receipt paths do not match filesResolved");
  }
}
