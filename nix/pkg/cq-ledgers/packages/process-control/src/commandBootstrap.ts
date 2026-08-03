import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessIdentityWithDarwinHelper, type ProcessIdentity } from "./processGroup.ts";
import { REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS } from "./registeredLaunchProtocol.ts";

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

async function launchOrphanProcessGroupReaper(
  launcherDarwinHelper: string | null,
  settlementDeadline: number,
): Promise<void> {
  const bootstrap = await readProcessIdentityWithDarwinHelper(process.pid, launcherDarwinHelper);
  if (bootstrap === null) {
    throw new Error("cq registered-launch bootstrap: bootstrap identity disappeared");
  }
  // The spawned sibling must exist under the runtime that loaded this module:
  // the .ts source when running src directly (plain Node type-stripping, Bun,
  // jiti), the compiled .js when running from dist (D273).
  const selfExtension = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
  const reaperExecutable = fileURLToPath(
    new URL(`./orphanProcessGroupReaper${selfExtension}`, import.meta.url),
  );
  const reaper = spawn(
    process.execPath,
    [
      reaperExecutable,
      String(bootstrap.pid),
      bootstrap.startTime,
      launcherDarwinHelper ?? "",
      String(settlementDeadline),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    },
  );
  await childSpawned(reaper);
  reaper.unref();
}

async function rejectOrphanedLauncher(
  protocolDirectory: string,
  launcherDarwinHelper: string | null,
  settleOwnedGroup: boolean,
): Promise<never> {
  const settlementDeadline = Date.now() + REGISTERED_LAUNCH_ORPHAN_SETTLEMENT_MS;
  await rm(protocolDirectory, { recursive: true, force: true });
  if (settleOwnedGroup) {
    await launchOrphanProcessGroupReaper(launcherDarwinHelper, settlementDeadline);
  }
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
      await rejectOrphanedLauncher(protocolDirectory, launcherDarwinHelper, false);
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
        await rejectOrphanedLauncher(protocolDirectory, launcherDarwinHelper, false);
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

type LauncherMonitorResult =
  | { readonly state: "launcher-lost" }
  | { readonly state: "cancelled" };

function childExit(child: ChildProcess): Promise<TargetOutcome> {
  return new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function monitorInitialLauncher(
  expectedLauncher: ProcessIdentity,
  launcherDarwinHelper: string | null,
  signal: AbortSignal,
): Promise<LauncherMonitorResult> {
  while (!signal.aborted) {
    if (!(await isInitialLauncherAlive(expectedLauncher, launcherDarwinHelper))) {
      return { state: "launcher-lost" };
    }
    await new Promise((resolve) => setTimeout(resolve, COMPLETION_POLL_MS));
  }
  return { state: "cancelled" };
}

async function waitWhileLauncherLives<T>(
  operation: Promise<T>,
  launcherMonitor: Promise<LauncherMonitorResult>,
  protocolDirectory: string,
  launcherDarwinHelper: string | null,
  launcherMonitorController: AbortController,
  child: ChildProcess,
): Promise<T> {
  const result = await Promise.race([
    operation.then((value) => ({ state: "completed" as const, value })),
    launcherMonitor,
  ]);
  if (result.state === "completed") return result.value;
  if (result.state === "launcher-lost") {
    launcherMonitorController.abort();
    child.unref();
    await rejectOrphanedLauncher(protocolDirectory, launcherDarwinHelper, true);
  }
  throw new Error("cq registered-launch bootstrap: launcher monitor cancelled unexpectedly");
}

async function waitForCompletion(
  path: string,
  expectedNonce: string,
  expectedPgid: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (value["nonce"] !== expectedNonce || value["pgid"] !== expectedPgid) {
        throw new Error("cq registered-launch bootstrap: completion identity mismatch");
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
  try {
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
  } catch (error) {
    await rm(protocolDirectory, { recursive: true, force: true });
    throw error;
  }

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

  const launcherMonitorController = new AbortController();
  const launcherMonitor = monitorInitialLauncher(
    launcher,
    launcherDarwinHelper,
    launcherMonitorController.signal,
  );
  try {
    await waitWhileLauncherLives(
      writeJsonAtomic(statusPath, { nonce, pgid: process.pid, state: "launched" }),
      launcherMonitor,
      protocolDirectory,
      launcherDarwinHelper,
      launcherMonitorController,
      child,
    );
    const outcome = await waitWhileLauncherLives(
      exited,
      launcherMonitor,
      protocolDirectory,
      launcherDarwinHelper,
      launcherMonitorController,
      child,
    );
    await waitWhileLauncherLives(
      writeJsonAtomic(statusPath, {
        nonce,
        pgid: process.pid,
        state: "exited",
        ...outcome,
      }),
      launcherMonitor,
      protocolDirectory,
      launcherDarwinHelper,
      launcherMonitorController,
      child,
    );
    await waitWhileLauncherLives(
      waitForCompletion(
        completionPath,
        nonce,
        process.pid,
        launcherMonitorController.signal,
      ),
      launcherMonitor,
      protocolDirectory,
      launcherDarwinHelper,
      launcherMonitorController,
      child,
    );
    if (!(await isInitialLauncherAlive(launcher, launcherDarwinHelper))) {
      await rejectOrphanedLauncher(protocolDirectory, launcherDarwinHelper, true);
    }
    await rm(completionPath, { force: true });
    return outcome;
  } finally {
    launcherMonitorController.abort();
  }
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
