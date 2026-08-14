import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import {
  WorksetEffectBroker,
  type ProcessGroupRegistration,
  type RegisteredLaunchBootstrapSpecification,
  type WorksetEffectAdmissionProvider,
} from "@cq/process-control";

export interface PiChildWorksetEffect {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly targetRef: string;
}

export interface PiChildLifecycleDependencies extends PiChildWorksetEffect {
  readonly settleRegisteredDescendants?: () => Promise<void>;
}

export interface LaunchedPiChild {
  readonly process: ChildProcess;
  readonly registration: ProcessGroupRegistration;
  readonly exited: Promise<number>;
}

function childExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 0));
  });
}

function streamDrained(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

function launchNodeBootstrap(
  specification: RegisteredLaunchBootstrapSpecification<StdioOptions>,
) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: childExited(child),
    outputDrained: Promise.all([
      streamDrained(child.stdout),
      streamDrained(child.stderr),
    ]).then(() => {}),
    resultFromTargetOutcome: (outcome: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }) => outcome.exitCode ?? 0,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

export async function launchPiChild(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  worksetEffect: PiChildWorksetEffect,
): Promise<LaunchedPiChild> {
  return launchPiChildWithDependencies(
    argv,
    cwd,
    env,
    signal,
    worksetEffect,
  );
}

export async function launchPiChildWithDependencies(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  dependencies: PiChildLifecycleDependencies,
): Promise<LaunchedPiChild> {
  const childEnvironment = { ...env };
  delete childEnvironment.CQ_SERVE_TOKEN;
  delete childEnvironment.CQ_SERVE_MANAGEMENT_TOKEN;
  delete childEnvironment.CQ_LEDGER_REMOTE_TOKEN;
  delete childEnvironment.CQ_WORKSET_EFFECT_PROVIDER_COMMAND;
  const broker = new WorksetEffectBroker({ provider: dependencies.provider });
  const launched = await broker.launch({
    kind: "child-dispatch",
    targetRef: dependencies.targetRef,
    argv,
    cwd,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
    launchBootstrap: launchNodeBootstrap,
    ...(signal === undefined ? {} : { signal }),
    ...(dependencies.settleRegisteredDescendants === undefined
      ? {}
      : { settleRegisteredDescendants: dependencies.settleRegisteredDescendants }),
  });
  return {
    process: launched.process,
    registration: launched.registration,
    exited: launched.exited,
  };
}
