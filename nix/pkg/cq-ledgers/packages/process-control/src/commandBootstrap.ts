import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";

const START_POLL_MS = 2;
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

function childClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      if (code !== null) resolve(code);
      else resolve(128 + signalNumber(signal));
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
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
  await waitForRelease(releasePath, nonce, process.pid);
  await rm(releasePath, { force: true });

  let child: ChildProcess;
  let closed: Promise<number>;
  try {
    child = spawn(executable, argv.slice(4), {
      cwd: commandCwd,
      detached: false,
      stdio: "inherit",
      env: process.env,
    });
    closed = childClose(child);
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
  return closed;
}

function signalNumber(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = constants.signals[signal];
  return number ?? 1;
}

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  },
);
