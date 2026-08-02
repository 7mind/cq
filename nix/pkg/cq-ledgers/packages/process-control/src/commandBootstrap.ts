import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const START_POLL_MS = 2;
const COMPLETION_POLL_MS = 25;
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

async function waitForRelease(
  path: string,
  expectedNonce: string,
  expectedPgid: number,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (value["nonce"] !== expectedNonce || value["pgid"] !== expectedPgid) {
        throw new Error("cq registered-launch bootstrap: release identity mismatch");
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
): Promise<void> {
  for (;;) {
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

async function main(argv: readonly string[]): Promise<TargetOutcome> {
  const protocolDirectory = argv[0];
  const nonce = argv[1];
  const commandCwd = argv[2];
  const executable = argv[3];
  if (
    protocolDirectory === undefined ||
    protocolDirectory === "" ||
    nonce === undefined ||
    nonce === "" ||
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
  await waitForRelease(releasePath, nonce, process.pid);
  await rm(releasePath, { force: true });

  let child: ChildProcess;
  let exited: Promise<TargetOutcome>;
  try {
    child = spawn(executable, argv.slice(4), {
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
  await waitForCompletion(completionPath, nonce, process.pid);
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
