import type { ChildProcess } from "node:child_process";
import {
  readProcessIdentity,
  settleProcessGroups,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
} from "@cq/process-control";

export interface PiChildLifecycleDependencies {
  readonly readIdentity: typeof readProcessIdentity;
  readonly settleGroups: typeof settleProcessGroups;
}

const PRODUCTION_DEPENDENCIES: PiChildLifecycleDependencies = {
  readIdentity: readProcessIdentity,
  settleGroups: settleProcessGroups,
};

export async function waitForPiChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): Promise<number> {
  return waitForPiChildWithDependencies(child, signal, PRODUCTION_DEPENDENCIES);
}

export async function waitForPiChildWithDependencies(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  dependencies: PiChildLifecycleDependencies,
): Promise<number> {
  let spawnFailed = false;
  let resolveClose: ((code: number | null) => void) | null = null;
  const closed = new Promise<number | null>((resolve) => {
    resolveClose = resolve;
  });

  const registration = registerOwnedGroup(child, dependencies);
  let settlement: Promise<SettleProcessGroupsResult> | null = null;
  const settleOnce = (): Promise<SettleProcessGroupsResult> => {
    settlement ??= registration.then(async (owned) => {
      if (owned === null) return { signaled: [], survivors: [] };
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
      // The authoritative await below reports settlement failure after close.
    });
  };

  const onError = (): void => {
    spawnFailed = true;
    observeSettlement();
  };
  const onClose = (code: number | null): void => {
    resolveClose?.(code);
  };
  const onExit = (): void => observeSettlement();
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);

  const onAbort = (): void => observeSettlement();
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  try {
    const exitCode = await closed;
    await settleOnce();
    return spawnFailed ? 1 : (exitCode ?? 0);
  } finally {
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function registerOwnedGroup(
  child: ChildProcess,
  dependencies: PiChildLifecycleDependencies,
): Promise<ProcessGroupRegistration | null> {
  const pid = child.pid;
  if (pid === undefined) return null;
  const leader = await dependencies.readIdentity(pid);
  if (leader === null) return null;
  return { pgid: pid, leader };
}
