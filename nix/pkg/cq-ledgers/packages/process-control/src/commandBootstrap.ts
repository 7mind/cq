import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProcessIdentityWithDarwinHelper, type ProcessIdentity } from "./processGroup.js";
import { REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS } from "./registeredLaunchProtocol.js";

const START_POLL_MS = 2;
const COMPLETION_POLL_MS = Math.min(25, REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS);
const START_TIMEOUT_MS = 30_000;

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function rejectOrphanedLauncher(protocolDirectory: string): Promise<never> {
  await rm(protocolDirectory, { recursive: true, force: true });
  throw new Error("cq registered-launch bootstrap: completion writer identity disappeared");
}

async function isInitialLauncherAlive(
  expected: ProcessIdentity,
  darwinHelper: string | null,
): Promise<boolean> {
  const observed = await readProcessIdentityWithDarwinHelper(expected.pid, darwinHelper);
  return (
    process.ppid === expected.pid && observed !== null && observed.startTime === expected.startTime
  );
}

async function waitForRelease(
  path: string,
  expectedNonce: string,
  expectedPgid: number,
  expectedLauncher: ProcessIdentity,
  launcherDarwinHelper: string | null,
  protocolDirectory: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (!(await isInitialLauncherAlive(expectedLauncher, launcherDarwinHelper))) {
      await rejectOrphanedLauncher(protocolDirectory);
    }
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const launcher = value["launcher"] as Record<string, unknown> | undefined;
      if (
        value["nonce"] !== expectedNonce ||
        value["pgid"] !== expectedPgid ||
        typeof launcher !== "object" ||
        launcher === null ||
        launcher["pid"] !== expectedLauncher.pid ||
        launcher["startTime"] !== expectedLauncher.startTime
      ) {
        throw new Error("cq registered-launch bootstrap: release identity mismatch");
      }
      if (!(await isInitialLauncherAlive(expectedLauncher, launcherDarwinHelper))) {
        await rejectOrphanedLauncher(protocolDirectory);
      }
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("cq registered-launch bootstrap: timed out before registration release");
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

function childSpawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

interface TargetOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function childExit(child: ChildProcess): Promise<TargetOutcome> {
  return new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function waitForCompletion(
  path: string,
  expectedNonce: string,
  expectedPgid: number,
  expectedLauncher: ProcessIdentity,
  launcherDarwinHelper: string | null,
  protocolDirectory: string,
): Promise<void> {
  for (;;) {
    if (!(await isInitialLauncherAlive(expectedLauncher, launcherDarwinHelper))) {
      await rejectOrphanedLauncher(protocolDirectory);
    }
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (value["nonce"] !== expectedNonce || value["pgid"] !== expectedPgid) {
        throw new Error("cq registered-launch bootstrap: completion identity mismatch");
      }
      if (!(await isInitialLauncherAlive(expectedLauncher, launcherDarwinHelper))) {
        await rejectOrphanedLauncher(protocolDirectory);
      }
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
  }
}

async function authenticateInitialLauncher(
  expected: ProcessIdentity,
  darwinHelper: string | null,
): Promise<void> {
  if (process.ppid !== expected.pid) {
    throw new Error("cq registered-launch bootstrap: launcher PID does not match initial parent");
  }
  const observed = await readProcessIdentityWithDarwinHelper(expected.pid, darwinHelper);
  if (observed === null || observed.startTime !== expected.startTime) {
    throw new Error("cq registered-launch bootstrap: launcher start-time identity mismatch");
  }
}

async function main(argv: readonly string[]): Promise<TargetOutcome> {
  const protocolDirectory = argv[0];
  const nonce = argv[1];
  const launcherPidText = argv[2];
  const launcherStartTime = argv[3];
  const launcherDarwinHelperText = argv[4];
  const commandCwd = argv[5];
  const executable = argv[6];
  if (
    protocolDirectory === undefined ||
    protocolDirectory === "" ||
    nonce === undefined ||
    nonce === "" ||
    launcherPidText === undefined ||
    launcherPidText === "" ||
    launcherStartTime === undefined ||
    launcherStartTime === "" ||
    launcherDarwinHelperText === undefined ||
    commandCwd === undefined ||
    commandCwd === "" ||
    executable === undefined ||
    executable === ""
  ) {
    throw new Error("cq registered-launch bootstrap: incomplete launch arguments");
  }

  const releasePath = join(protocolDirectory, "release.json");
  const statusPath = join(protocolDirectory, "status.json");
  const completionPath = join(protocolDirectory, "completion.json");
  const launcher = { pid: Number(launcherPidText), startTime: launcherStartTime };
  const launcherDarwinHelper = launcherDarwinHelperText === "" ? null : launcherDarwinHelperText;
  await authenticateInitialLauncher(launcher, launcherDarwinHelper);
  await waitForRelease(
    releasePath,
    nonce,
    process.pid,
    launcher,
    launcherDarwinHelper,
    protocolDirectory,
  );
  await rm(releasePath, { force: true });

  let child: ChildProcess;
  let exited: Promise<TargetOutcome>;
  try {
    child = spawn(executable, argv.slice(7), {
      cwd: commandCwd,
      detached: false,
      stdio: "inherit",
      env: process.env,
    });
    exited = childExit(child);
    await childSpawned(child);
  } catch (error) {
    await writeJsonAtomic(statusPath, {
      nonce,
      pgid: process.pid,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await writeJsonAtomic(statusPath, { nonce, pgid: process.pid, state: "launched" });
  const outcome = await exited;
  await writeJsonAtomic(statusPath, {
    nonce,
    pgid: process.pid,
    state: "exited",
    ...outcome,
  });
  await waitForCompletion(
    completionPath,
    nonce,
    process.pid,
    launcher,
    launcherDarwinHelper,
    protocolDirectory,
  );
  await rm(completionPath, { force: true });
  return outcome;
}

void main(process.argv.slice(2)).then(
  (outcome) => {
    if (outcome.exitCode !== null) {
      process.exitCode = outcome.exitCode;
    } else if (outcome.signal !== null) {
      process.kill(process.pid, outcome.signal);
    } else {
      process.exitCode = 1;
    }
  },
  (error: unknown) => {
    process.exitCode = 1;
    if (!process.stderr.writableEnded) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  },
);
