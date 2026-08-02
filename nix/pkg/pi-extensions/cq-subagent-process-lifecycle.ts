import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import {
  launchRegisteredProcessGroup,
  settleProcessGroups,
  type ProcessGroupRegistration,
  type RegisteredLaunchBootstrapSpecification,
  type SettleProcessGroupsResult,
} from "@cq/process-control";

export interface PiChildLifecycleDependencies {
  readonly publishRegistration: (registration: ProcessGroupRegistration) => Promise<void>;
  readonly settleGroups: typeof settleProcessGroups;
}

export interface LaunchedPiChild {
  readonly process: ChildProcess;
  readonly exited: Promise<number>;
}

const PRODUCTION_DEPENDENCIES: PiChildLifecycleDependencies = {
  publishRegistration: async () => {},
  settleGroups: settleProcessGroups,
};

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
): Promise<LaunchedPiChild> {
  return launchPiChildWithDependencies(
    argv,
    cwd,
    env,
    signal,
    PRODUCTION_DEPENDENCIES,
  );
}

export async function launchPiChildWithDependencies(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  dependencies: PiChildLifecycleDependencies,
): Promise<LaunchedPiChild> {
  let resolveRegistration: (registration: ProcessGroupRegistration) => void = () => {
    throw new Error("Pi child registration resolver was not initialized");
  };
  let rejectRegistration: (error: unknown) => void = () => {
    throw new Error("Pi child registration rejecter was not initialized");
  };
  const registration = new Promise<ProcessGroupRegistration>((resolve, reject) => {
    resolveRegistration = resolve;
    rejectRegistration = reject;
  });
  void registration.catch(() => {});

  let settlement: Promise<SettleProcessGroupsResult> | null = null;
  const settleOnce = (): Promise<SettleProcessGroupsResult> => {
    settlement ??= registration.then(async (owned) => {
      const result = await dependencies.settleGroups([owned]);
      if (result.survivors.length > 0) {
        throw new Error(
          `Pi child process group did not settle: ${result.survivors.join(", ")}`,
        );
      }
      return result;
    });
    return settlement;
  };
  const observeSettlement = (): void => {
    void settleOnce().catch(() => {
      // The registered launch joins and reports the same settlement promise.
    });
  };
  const onAbort = (): void => observeSettlement();
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  try {
    const launched = await launchRegisteredProcessGroup({
      argv,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
      launchBootstrap: launchNodeBootstrap,
      register: async (owned) => {
        resolveRegistration(owned);
        await dependencies.publishRegistration(owned);
      },
      onTargetExit: async () => {
        await settleOnce();
      },
    });
    const exited = launched.exited.finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
    return { process: launched.process, exited };
  } catch (error) {
    rejectRegistration(error);
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }
}
