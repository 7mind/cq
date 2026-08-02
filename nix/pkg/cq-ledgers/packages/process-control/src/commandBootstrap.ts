import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { constants } from "node:os";

const START_POLL_MS = 2;
const START_TIMEOUT_MS = 30_000;

async function waitForBarrier(
  path: string,
  expectedNonce: string,
  expectedPgid: number,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (value["nonce"] !== expectedNonce || value["pgid"] !== expectedPgid) {
        throw new Error("cq gate bootstrap: registration barrier identity mismatch");
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("cq gate bootstrap: timed out before command registration");
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const barrier = argv[0];
  const commandCwd = argv[1];
  const executable = argv[2];
  const nonce = process.env["CQ_GATE_NONCE"];
  if (
    barrier === undefined ||
    commandCwd === undefined ||
    executable === undefined ||
    nonce === undefined
  ) {
    throw new Error("cq gate bootstrap: incomplete launch arguments");
  }
  await waitForBarrier(barrier, nonce, process.pid);
  await rm(barrier, { force: true });

  const child = spawn(executable, argv.slice(3), {
    cwd: commandCwd,
    detached: false,
    stdio: "inherit",
    env: {
      ...process.env,
      CQ_GATE_COMMAND_PGID: String(process.pid),
    },
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else resolve(128 + signalNumber(signal));
    });
  });
}

function signalNumber(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = constants.signals[signal];
  return number ?? 1;
}

void main(process.argv.slice(2)).then(
  (exitCode) => process.exit(exitCode),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
