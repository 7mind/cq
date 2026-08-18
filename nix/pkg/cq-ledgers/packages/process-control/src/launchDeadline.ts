export class WorksetEffectLaunchDeadlineError extends Error {
  readonly phase: string;

  constructor(phase: string) {
    super(`@cq/process-control: child launch/admission deadline expired during ${phase}`);
    this.name = "WorksetEffectLaunchDeadlineError";
    this.phase = phase;
  }
}

export function validateLaunchDeadlineMs(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)) {
    throw new Error(
      "@cq/process-control: launchDeadlineMs must be a positive safe-integer absolute time",
    );
  }
}

export function remainingLaunchDeadlineMs(
  deadlineMs: number | undefined,
  phase: string,
): number | undefined {
  validateLaunchDeadlineMs(deadlineMs);
  if (deadlineMs === undefined) return undefined;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new WorksetEffectLaunchDeadlineError(phase);
  return remainingMs;
}

export function boundedLaunchPhaseDeadlineMs(
  launchDeadlineMs: number | undefined,
  phaseTimeoutMs: number,
  phase: string,
): number {
  const remainingMs = remainingLaunchDeadlineMs(launchDeadlineMs, phase);
  if (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs <= 0) {
    throw new Error("@cq/process-control: launch phase timeout must be a positive safe integer");
  }
  const phaseDeadlineMs = Date.now() + phaseTimeoutMs;
  if (!Number.isSafeInteger(phaseDeadlineMs)) {
    throw new Error("@cq/process-control: launch phase deadline exceeds the safe integer range");
  }
  return remainingMs === undefined
    ? phaseDeadlineMs
    : Math.min(launchDeadlineMs as number, phaseDeadlineMs);
}

export async function awaitBeforeLaunchDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number | undefined,
  phase: string,
): Promise<T> {
  const remainingMs = remainingLaunchDeadlineMs(deadlineMs, phase);
  if (remainingMs === undefined) return await operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorksetEffectLaunchDeadlineError(phase)), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
