import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  WorksetEffectBroker,
  type RegisteredLaunchBootstrapSpecification,
} from "@cq/process-control";
import {
  createFsWorksetStore,
  worksetEffectAdmissionProviderFromStore,
} from "../src/index.js";

function exited(
  child: ChildProcess,
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function bootstrap(specification: RegisteredLaunchBootstrapSpecification<StdioOptions>) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: exited(child),
    outputDrained: Promise.resolve(),
    resultFromTargetOutcome: (outcome: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => outcome,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

const root = process.argv[2];
const statePath = process.argv[3];
const descendantPidPath = process.argv[4];
if (root === undefined || statePath === undefined || descendantPidPath === undefined) {
  throw new Error("workset broker FS child: incomplete arguments");
}

const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
const target = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: false, stdio: 'ignore' });`,
  `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
  "setInterval(() => {}, 1000);",
].join("\n");
const store = createFsWorksetStore({ root });
const broker = new WorksetEffectBroker({
  provider: worksetEffectAdmissionProviderFromStore(store),
  settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
});
const launched = await broker.launch({
  kind: "child-dispatch",
  targetRef: "tasks:T1979",
  argv: [process.execPath, "-e", target],
  cwd: root,
  env: process.env,
  stdio: "ignore" as const,
  launchBootstrap: bootstrap,
});
await writeFile(
  statePath,
  JSON.stringify({ pgid: launched.registration.pgid, leaderPid: launched.registration.leader.pid }),
  "utf8",
);
await launched.exited;
