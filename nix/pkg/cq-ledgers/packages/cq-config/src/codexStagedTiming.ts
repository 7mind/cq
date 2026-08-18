import {
  REGISTERED_LAUNCH_BOOTSTRAP_HANDSHAKE_TIMEOUT_MS,
  REGISTERED_LAUNCH_IDENTITY_HANDSHAKE_TIMEOUT_MS,
} from "@cq/process-control";

export const CODEX_STAGED_TIMING_PHASE_NAMES = [
  "child-launch-admission",
  "store-result-effect-lock",
  "store-result-synchronous",
  "store-result-acknowledgement",
  "post-submission-terminal",
  "parent-startup-binding",
  "parent-effect-lock",
  "parent-claim",
  "parent-gate-finalization",
  "parent-reconciliation-reserve",
  "parent-termination-grace",
] as const;

export type CodexStagedTimingPhaseName = (typeof CODEX_STAGED_TIMING_PHASE_NAMES)[number];

export interface CodexStagedTimingPhase {
  readonly name: CodexStagedTimingPhaseName;
  readonly durationMs: number;
}

export interface CodexStagedTimingBasis {
  readonly childLaunchAdmissionMs: number;
  readonly registeredLaunchIdentityHandshakeMs: number;
  readonly registeredLaunchBootstrapHandshakeMs: number;
  readonly storeResultEffectLockAcquisitionMs: number;
  readonly storeResultSynchronousPhaseMs: number;
  readonly storeResultDurableAcknowledgementMs: number;
  readonly storeResultSubmissionBudgetMs: number;
  readonly ledgerToolTimeoutSec: number;
  readonly postStoreSubmissionFinalizationMs: number;
  readonly outerBoundaryReserveMs: number;
  readonly parentStartupBindingMs: number;
  readonly parentEffectLockAcquisitionMs: number;
  readonly parentClaimMs: number;
  readonly parentGateFinalizationMs: number;
  readonly parentPathMs: number;
  readonly parentGateReconciliationReserveMs: number;
  readonly parentGateTerminationGraceMs: number;
  readonly parentGateWindowMs: number;
  readonly parentFirstAttemptMs: number;
}

export const CODEX_STAGED_TIMING_PHASES: readonly CodexStagedTimingPhase[] = Object.freeze([
  Object.freeze({ name: "child-launch-admission", durationMs: 300_000 }),
  Object.freeze({ name: "store-result-effect-lock", durationMs: 3_600_000 }),
  Object.freeze({ name: "store-result-synchronous", durationMs: 300_000 }),
  Object.freeze({ name: "store-result-acknowledgement", durationMs: 60_000 }),
  Object.freeze({ name: "post-submission-terminal", durationMs: 300_000 }),
  Object.freeze({ name: "parent-startup-binding", durationMs: 300_000 }),
  Object.freeze({ name: "parent-effect-lock", durationMs: 3_600_000 }),
  Object.freeze({ name: "parent-claim", durationMs: 60_000 }),
  Object.freeze({ name: "parent-gate-finalization", durationMs: 5_620_000 }),
  Object.freeze({ name: "parent-reconciliation-reserve", durationMs: 30_000 }),
  Object.freeze({ name: "parent-termination-grace", durationMs: 1_000 }),
]);

function checkedMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Codex staged timing ${label} must be a positive safe integer number of milliseconds`,
    );
  }
  return value;
}

function checkedSum(label: string, values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`Codex staged timing ${label} exceeds the safe integer range`);
    }
  }
  return total;
}

function exactSeconds(milliseconds: number): number {
  if (milliseconds % 1_000 !== 0) {
    throw new Error(
      "Codex staged timing store_result budget must convert to whole tool-timeout seconds",
    );
  }
  return milliseconds / 1_000;
}

export function calculateCodexParentFirstAttemptMs(
  parentGateWindowMs: number,
  reconciliationReserveMs: number,
  terminationGraceMs: number,
  minimumParentPathMs: number,
): number {
  const window = checkedMilliseconds(parentGateWindowMs, "parent gate window");
  const reserves = checkedSum("parent gate reserves", [
    checkedMilliseconds(reconciliationReserveMs, "parent reconciliation reserve"),
    checkedMilliseconds(terminationGraceMs, "parent termination grace"),
  ]);
  const firstAttemptMs = window - reserves;
  if (!Number.isSafeInteger(firstAttemptMs) || firstAttemptMs < minimumParentPathMs) {
    throw new Error(
      "Codex staged timing parent gate reserves shorten the first attempt below the parent path",
    );
  }
  return firstAttemptMs;
}

export function calculateCodexStagedTimingBasis(
  phases: readonly CodexStagedTimingPhase[],
): CodexStagedTimingBasis {
  if (phases.length !== CODEX_STAGED_TIMING_PHASES.length) {
    throw new Error("Codex staged timing must contain every phase exactly once");
  }
  const durations = new Map<CodexStagedTimingPhaseName, number>();
  for (const [index, phase] of phases.entries()) {
    const expected = CODEX_STAGED_TIMING_PHASES[index];
    if (durations.has(phase.name)) {
      throw new Error(`Codex staged timing phase ${phase.name} is duplicated`);
    }
    if (expected === undefined || phase.name !== expected.name) {
      throw new Error("Codex staged timing phases must retain their source order");
    }
    const durationMs = checkedMilliseconds(phase.durationMs, phase.name);
    if (durationMs < expected.durationMs) {
      throw new Error(`Codex staged timing phase ${phase.name} is shorter than its source bound`);
    }
    durations.set(phase.name, durationMs);
  }
  const phase = (name: CodexStagedTimingPhaseName): number => {
    const durationMs = durations.get(name);
    if (durationMs === undefined) {
      throw new Error(`Codex staged timing phase ${name} is missing`);
    }
    return durationMs;
  };

  const childLaunchAdmissionMs = phase("child-launch-admission");
  const storeResultEffectLockAcquisitionMs = phase("store-result-effect-lock");
  const storeResultSynchronousPhaseMs = phase("store-result-synchronous");
  const storeResultDurableAcknowledgementMs = phase("store-result-acknowledgement");
  const storeResultSubmissionBudgetMs = checkedSum("store_result submission budget", [
    storeResultEffectLockAcquisitionMs,
    storeResultSynchronousPhaseMs,
    storeResultDurableAcknowledgementMs,
  ]);
  const postStoreSubmissionFinalizationMs = phase("post-submission-terminal");
  const outerBoundaryReserveMs = checkedSum("outer boundary reserve", [
    childLaunchAdmissionMs,
    storeResultSubmissionBudgetMs,
    postStoreSubmissionFinalizationMs,
  ]);
  const parentStartupBindingMs = phase("parent-startup-binding");
  const parentEffectLockAcquisitionMs = phase("parent-effect-lock");
  const parentClaimMs = phase("parent-claim");
  const parentGateFinalizationMs = phase("parent-gate-finalization");
  const parentPathMs = checkedSum("parent path", [
    parentStartupBindingMs,
    parentEffectLockAcquisitionMs,
    parentClaimMs,
    parentGateFinalizationMs,
  ]);
  const parentGateReconciliationReserveMs = phase("parent-reconciliation-reserve");
  const parentGateTerminationGraceMs = phase("parent-termination-grace");
  const parentGateWindowMs = checkedSum("parent gate window", [
    parentPathMs,
    parentGateReconciliationReserveMs,
    parentGateTerminationGraceMs,
  ]);
  const parentFirstAttemptMs = calculateCodexParentFirstAttemptMs(
    parentGateWindowMs,
    parentGateReconciliationReserveMs,
    parentGateTerminationGraceMs,
    parentPathMs,
  );

  return Object.freeze({
    childLaunchAdmissionMs,
    registeredLaunchIdentityHandshakeMs: REGISTERED_LAUNCH_IDENTITY_HANDSHAKE_TIMEOUT_MS,
    registeredLaunchBootstrapHandshakeMs: REGISTERED_LAUNCH_BOOTSTRAP_HANDSHAKE_TIMEOUT_MS,
    storeResultEffectLockAcquisitionMs,
    storeResultSynchronousPhaseMs,
    storeResultDurableAcknowledgementMs,
    storeResultSubmissionBudgetMs,
    ledgerToolTimeoutSec: exactSeconds(storeResultSubmissionBudgetMs),
    postStoreSubmissionFinalizationMs,
    outerBoundaryReserveMs,
    parentStartupBindingMs,
    parentEffectLockAcquisitionMs,
    parentClaimMs,
    parentGateFinalizationMs,
    parentPathMs,
    parentGateReconciliationReserveMs,
    parentGateTerminationGraceMs,
    parentGateWindowMs,
    parentFirstAttemptMs,
  });
}

export const CODEX_STAGED_TIMING_BASIS = calculateCodexStagedTimingBasis(
  CODEX_STAGED_TIMING_PHASES,
);
