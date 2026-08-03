import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD_READY_TIMEOUT_MS = 5_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 5;
const GIT_IDENTITY = {
  email: "kill-harness@example.invalid",
  name: "CQ kill harness",
} as const;

export const KILL_BLOCKING_MECHANISM =
  "wait on a release sentinel that the parent never creates" as const;

export type KillHarnessScenario = "control" | "commit-before-kill";

export interface GitProbeResults {
  readonly status: string;
  readonly log: string;
  readonly stash: string;
}

export interface TerminationObservation {
  readonly checkpoint: string;
  readonly blockingMechanism: typeof KILL_BLOCKING_MECHANISM;
  readonly aliveBeforeSigterm: boolean;
  readonly releaseSentinelPresentBeforeSigterm: boolean;
  readonly blockedBeforeSigterm: boolean;
  readonly signalSent: "SIGTERM";
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
}

export interface KillHarness {
  readonly repository: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly blockingMechanism: typeof KILL_BLOCKING_MECHANISM;
  readonly expensiveWorkSentinel: string;
  readonly releaseSentinel: string;
  readonly terminalWritePath: string;
  terminateAtBlock(): Promise<TerminationObservation>;
  readProbes(): GitProbeResults;
  cleanup(): Promise<void>;
}

export interface GitCommandObservation {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface RebaseByteSnapshots {
  readonly head: Buffer;
  readonly unmergedIndex: Buffer;
  readonly conflictedFile: Buffer;
}

export interface ConflictedRebaseFixtureOptions {
  readonly taskId: string;
  readonly role: string;
}

export interface ConflictedRebaseFixture {
  readonly repository: string;
  readonly worktree: string;
  readonly taskId: string;
  readonly role: string;
  readonly commonBaseCommit: string;
  readonly baseCommit: string;
  readonly taskCommit: string;
  readonly wipRef: string;
  readonly conflictedFilePath: string;
  readonly initialSnapshots: RebaseByteSnapshots;
  attemptOrdinaryCommit(): GitCommandObservation;
  captureSnapshots(): Promise<RebaseByteSnapshots>;
  terminateAfterWipRefCheckpoint(checkpoint: string): Promise<TerminationObservation>;
  readWipRef(): Buffer;
  cleanup(): Promise<void>;
}

interface BlockedChildOptions {
  readonly cwd: string;
  readonly checkpoint: string;
  readonly checkpointSentinel: string;
  readonly releaseSentinel: string;
  readonly beforeCheckpointSource: string;
  readonly afterReleaseSource: string;
}

interface ChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function runGit(cwd: string, args: readonly string[]): GitCommandResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr),
  };
}

function requireGit(cwd: string, args: readonly string[]): Buffer {
  const result = runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit ${result.exitCode}: ${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

function gitCommit(cwd: string, message: string): void {
  requireGit(cwd, [
    "-c",
    `user.email=${GIT_IDENTITY.email}`,
    "-c",
    `user.name=${GIT_IDENTITY.name}`,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

function commitSource(fileName: string): string {
  return [
    `writeFileSync(join(process.cwd(), ${JSON.stringify(fileName)}), "persisted before kill\\n");`,
    `execFileSync("git", ["add", ${JSON.stringify(fileName)}], { cwd: process.cwd() });`,
    "execFileSync(",
    '  "git",',
    "  [",
    '    "-c",',
    `    ${JSON.stringify(`user.email=${GIT_IDENTITY.email}`)},`,
    '    "-c",',
    `    ${JSON.stringify(`user.name=${GIT_IDENTITY.name}`)},`,
    '    "-c",',
    '    "commit.gpgsign=false",',
    '    "commit",',
    '    "-q",',
    '    "-m",',
    '    "worker checkpoint",',
    "  ],",
    "  { cwd: process.cwd() },",
    ");",
  ].join("\n");
}

function spawnBlockedChild(options: BlockedChildOptions): {
  readonly child: ChildProcess;
  readonly exited: Promise<ChildExit>;
  readonly stderr: () => string;
} {
  const source = [
    'const { execFileSync } = require("node:child_process");',
    'const { existsSync, writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    options.beforeCheckpointSource,
    `writeFileSync(${JSON.stringify(options.checkpointSentinel)}, ${JSON.stringify(options.checkpoint)});`,
    "const blocker = new Int32Array(new SharedArrayBuffer(4));",
    `while (!existsSync(${JSON.stringify(options.releaseSentinel)})) {`,
    "  Atomics.wait(blocker, 0, 0, 1000);",
    "}",
    options.afterReleaseSource,
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source], {
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let capturedStderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    capturedStderr += chunk;
  });
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return { child, exited, stderr: () => capturedStderr };
}

function childIsAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function waitForCheckpoint(
  checkpointSentinel: string,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
  while (!(await pathExists(checkpointSentinel))) {
    if (!childIsAlive(child)) {
      throw new Error(`child exited before its checkpoint: ${stderr() || "<empty stderr>"}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`child did not reach its checkpoint: ${stderr() || "<empty stderr>"}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function waitForChildExit(exited: Promise<ChildExit>): Promise<ChildExit> {
  const outcome = await Promise.race([
    exited.then((value) => ({ kind: "exit" as const, value })),
    Bun.sleep(CHILD_EXIT_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
  ]);
  if (outcome.kind === "timeout") throw new Error("child did not exit after SIGTERM");
  return outcome.value;
}

async function terminateBlockedChild(
  blocked: ReturnType<typeof spawnBlockedChild>,
  checkpointSentinel: string,
  releaseSentinel: string,
  expectedCheckpoint: string,
): Promise<TerminationObservation> {
  await waitForCheckpoint(checkpointSentinel, blocked.child, blocked.stderr);
  const checkpoint = await readFile(checkpointSentinel, "utf8");
  const releaseSentinelPresentBeforeSigterm = await pathExists(releaseSentinel);
  const aliveBeforeSigterm = childIsAlive(blocked.child);
  const blockedBeforeSigterm =
    checkpoint === expectedCheckpoint && !releaseSentinelPresentBeforeSigterm && aliveBeforeSigterm;
  if (!blockedBeforeSigterm) {
    throw new Error(
      `child did not remain blocked at ${expectedCheckpoint}: ` +
        JSON.stringify({ checkpoint, releaseSentinelPresentBeforeSigterm, aliveBeforeSigterm }),
    );
  }
  if (!blocked.child.kill("SIGTERM")) throw new Error("failed to send SIGTERM to blocked child");
  const exit = await waitForChildExit(blocked.exited);
  return {
    checkpoint,
    blockingMechanism: KILL_BLOCKING_MECHANISM,
    aliveBeforeSigterm,
    releaseSentinelPresentBeforeSigterm,
    blockedBeforeSigterm,
    signalSent: "SIGTERM",
    exitCode: exit.exitCode,
    exitSignal: exit.signal,
  };
}

async function cleanupBlockedChild(
  root: string,
  blocked: ReturnType<typeof spawnBlockedChild> | undefined,
): Promise<void> {
  if (blocked !== undefined && childIsAlive(blocked.child)) {
    blocked.child.kill("SIGKILL");
    await blocked.exited;
  }
  await rm(root, { recursive: true, force: true });
}

async function createSeededRepository(prefix: string): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly baseCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repository = join(root, "repository");
  await mkdir(repository);
  requireGit(repository, ["init", "-q", "-b", "main"]);
  await writeFile(join(repository, "tracked.txt"), "base\n");
  requireGit(repository, ["add", "tracked.txt"]);
  gitCommit(repository, "base");
  const baseCommit = requireGit(repository, ["rev-parse", "HEAD"]).toString("utf8").trim();
  return { root, repository, baseCommit };
}

export async function createKillHarness(scenario: KillHarnessScenario): Promise<KillHarness> {
  const seeded = await createSeededRepository("cq-kill-harness-");
  const worktree = join(seeded.root, "worktree");
  const checkpointSentinel = join(seeded.root, "worker.blocked");
  const expensiveWorkSentinel = join(seeded.root, "expensive-work.complete");
  const releaseSentinel = join(seeded.root, "parent.release");
  const terminalWritePath = join(worktree, "terminal-result.txt");
  let blocked: ReturnType<typeof spawnBlockedChild> | undefined;
  try {
    requireGit(seeded.repository, [
      "worktree",
      "add",
      "-q",
      "-b",
      "task-worker",
      worktree,
      seeded.baseCommit,
    ]);
    const beforeCheckpointSource = [
      "let checksum = 0;",
      "for (let index = 0; index < 100000; index += 1) checksum = (checksum + index) % 65521;",
      `writeFileSync(${JSON.stringify(expensiveWorkSentinel)}, String(checksum));`,
      scenario === "commit-before-kill" ? commitSource("worker-result.txt") : "",
    ].join("\n");
    blocked = spawnBlockedChild({
      cwd: worktree,
      checkpoint: "terminal-write-blocked",
      checkpointSentinel,
      releaseSentinel,
      beforeCheckpointSource,
      afterReleaseSource: `writeFileSync(${JSON.stringify(terminalWritePath)}, "terminal write\\n");`,
    });
    await waitForCheckpoint(checkpointSentinel, blocked.child, blocked.stderr);
    const activeBlocker = blocked;
    return {
      repository: seeded.repository,
      worktree,
      baseCommit: seeded.baseCommit,
      blockingMechanism: KILL_BLOCKING_MECHANISM,
      expensiveWorkSentinel,
      releaseSentinel,
      terminalWritePath,
      terminateAtBlock: () =>
        terminateBlockedChild(
          activeBlocker,
          checkpointSentinel,
          releaseSentinel,
          "terminal-write-blocked",
        ),
      readProbes: () => ({
        status: requireGit(worktree, ["status", "--porcelain", "--untracked-files=all"]).toString(
          "utf8",
        ),
        log: requireGit(worktree, ["log", `${seeded.baseCommit}..HEAD`]).toString("utf8"),
        stash: requireGit(worktree, ["stash", "list"]).toString("utf8"),
      }),
      cleanup: () => cleanupBlockedChild(seeded.root, activeBlocker),
    };
  } catch (error) {
    await cleanupBlockedChild(seeded.root, blocked);
    throw error;
  }
}

export async function createConflictedRebaseFixture(
  options: ConflictedRebaseFixtureOptions,
): Promise<ConflictedRebaseFixture> {
  const seeded = await createSeededRepository("cq-conflicted-rebase-");
  const worktree = join(seeded.root, "worktree");
  const conflictedFilePath = join(worktree, "tracked.txt");
  const taskBranch = `task-${options.taskId}-${options.role}`;
  const wipRef = `refs/cq/wip/${options.taskId}/${options.role}`;
  let blocked: ReturnType<typeof spawnBlockedChild> | undefined;
  try {
    requireGit(seeded.repository, ["checkout", "-q", "-b", taskBranch]);
    await writeFile(join(seeded.repository, "tracked.txt"), "task change\n");
    requireGit(seeded.repository, ["add", "tracked.txt"]);
    gitCommit(seeded.repository, "task change");
    const taskCommit = requireGit(seeded.repository, ["rev-parse", "HEAD"]).toString("utf8").trim();

    requireGit(seeded.repository, ["checkout", "-q", "main"]);
    await writeFile(join(seeded.repository, "tracked.txt"), "base change\n");
    requireGit(seeded.repository, ["add", "tracked.txt"]);
    gitCommit(seeded.repository, "base change");
    const baseCommit = requireGit(seeded.repository, ["rev-parse", "HEAD"]).toString("utf8").trim();

    requireGit(seeded.repository, ["worktree", "add", "-q", worktree, taskBranch]);
    const rebase = runGit(worktree, ["rebase", baseCommit]);
    if (rebase.exitCode === 0) throw new Error("conflicted rebase unexpectedly completed");
    const initialSnapshots = await captureRebaseSnapshots(worktree, conflictedFilePath);
    if (initialSnapshots.unmergedIndex.length === 0) {
      throw new Error(
        `rebase failed without unresolved index entries: ${rebase.stderr.toString()}`,
      );
    }

    return {
      repository: seeded.repository,
      worktree,
      taskId: options.taskId,
      role: options.role,
      commonBaseCommit: seeded.baseCommit,
      baseCommit,
      taskCommit,
      wipRef,
      conflictedFilePath,
      initialSnapshots,
      attemptOrdinaryCommit: () =>
        runGit(worktree, [
          "-c",
          `user.email=${GIT_IDENTITY.email}`,
          "-c",
          `user.name=${GIT_IDENTITY.name}`,
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "ordinary commit must fail",
        ]),
      captureSnapshots: () => captureRebaseSnapshots(worktree, conflictedFilePath),
      terminateAfterWipRefCheckpoint: async (checkpoint) => {
        if (blocked !== undefined) throw new Error("side-ref blocker already spawned");
        const checkpointSentinel = join(seeded.root, "side-ref.checkpoint");
        const releaseSentinel = join(seeded.root, "side-ref.release");
        blocked = spawnBlockedChild({
          cwd: worktree,
          checkpoint,
          checkpointSentinel,
          releaseSentinel,
          beforeCheckpointSource: `execFileSync("git", ["update-ref", ${JSON.stringify(wipRef)}, "HEAD"], { cwd: process.cwd() });`,
          afterReleaseSource:
            'writeFileSync(join(process.cwd(), "post-checkpoint"), "unreachable\\n");',
        });
        return terminateBlockedChild(blocked, checkpointSentinel, releaseSentinel, checkpoint);
      },
      readWipRef: () => requireGit(worktree, ["rev-parse", wipRef]),
      cleanup: () => cleanupBlockedChild(seeded.root, blocked),
    };
  } catch (error) {
    await cleanupBlockedChild(seeded.root, blocked);
    throw error;
  }
}

async function captureRebaseSnapshots(
  worktree: string,
  conflictedFilePath: string,
): Promise<RebaseByteSnapshots> {
  return {
    head: requireGit(worktree, ["rev-parse", "HEAD"]),
    unmergedIndex: requireGit(worktree, ["ls-files", "-u"]),
    conflictedFile: await readFile(conflictedFilePath),
  };
}
