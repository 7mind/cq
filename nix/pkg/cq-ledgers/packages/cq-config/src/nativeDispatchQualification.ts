/**
 * Positive-only native adapter qualification (T1698/D263, T1699/D160).
 *
 * A `*:native` transport adapter is registered ONLY under an explicit
 * confinement model:
 *  - `structural` — path-scoped write confinement proven for the surface
 *  - `harness-owned` — decisions:K238: worktree_manage path handoff +
 *    harness-owned native isolation accepted for Claude (NOT structural
 *    path-scoped write confinement; K170 still did not accept that residual)
 *
 * Unproven surfaces stay unregistered and resolve through a typed
 * incompatibility — never a silent prompt-best-effort write confinement claim.
 *
 * decisions:K170 chose the harness axis (same-harness → native transport,
 * cross-harness → process) and accepted handleOnlyOutput residual only.
 * decisions:K238 (Q383(b)) additionally accepts harness-owned isolation +
 * worktree_manage handoff for claude:native registration.
 */

import type { Harness } from "./types.js";
import {
  isRunnerOwnedCodexRoleBoundaryExecution,
  isRunnerOwnedCodexInstalledRoleBoundaryExecution,
  type CodexRoleBoundaryExecutionResult,
  type CodexInstalledRoleBoundaryExecution,
} from "./codexRoleBoundary.js";
import type { ConsumedDispatchResult } from "./compactDispatchProtocol.js";
import { isBackendOwnedConsumedDispatchResult } from "./dispatchAttestation.js";
import {
  isManagerOwnedReleaseResult,
  validateManagedWorktreeHandle,
  type ManagedWorktreeHandle,
} from "./managedWorktreeHandle.js";

export type NativeAdapterId = `${Harness}:native`;

export const NATIVE_ADAPTER_IDS = [
  "claude:native",
  "codex:native",
  "pi:native",
] as const satisfies readonly NativeAdapterId[];

export type NativeQualificationRefusalReason =
  | "path-scoped-confinement-unproven"
  | "escape-canary-failed"
  | "escape-canary-required"
  | "missing-cwd-binding"
  | "cwd-not-absolute"
  | "handle-invalid"
  | "handle-path-mismatch"
  | "handle-repository-mismatch"
  | "handle-task-mismatch"
  | "provider-gates-required"
  | "provider-gate-failed"
  | "provider-probe-unavailable";

export type NativePathConfinementStrength = "structural" | "harness-owned" | "unproven";

export interface NativeAdapterQualified {
  readonly status: "qualified";
  readonly adapterId: NativeAdapterId;
  readonly targetHarness: Harness;
  readonly transport: "native";
  readonly confinement: "structural" | "harness-owned";
  readonly evidence: string;
  readonly defectClosed: "D263" | "D160" | "D307" | null;
}

export interface NativeAdapterIncompatible {
  readonly status: "incompatible";
  readonly adapterId: NativeAdapterId;
  readonly targetHarness: Harness;
  readonly transport: "native";
  readonly reason: NativeQualificationRefusalReason;
  readonly detail: string;
  readonly defect: "D263" | "D160" | "D307";
  readonly confinement: "unproven";
}

export type NativeAdapterQualification = NativeAdapterQualified | NativeAdapterIncompatible;

/**
 * Typed refusal when a caller attempts to register or resolve a native adapter
 * that failed positive-only qualification.
 */
export class NativeAdapterIncompatibilityError extends Error {
  readonly adapterId: NativeAdapterId;
  readonly reason: NativeQualificationRefusalReason;
  readonly defect: "D263" | "D160" | "D307";

  constructor(qualification: NativeAdapterIncompatible) {
    super(
      `native adapter ${JSON.stringify(qualification.adapterId)} is incompatible ` +
        `(${qualification.reason}/${qualification.defect}): ${qualification.detail}`,
    );
    this.name = "NativeAdapterIncompatibilityError";
    this.adapterId = qualification.adapterId;
    this.reason = qualification.reason;
    this.defect = qualification.defect;
  }
}

export interface EscapeCanaryObservation {
  /** True when a write/path operation landed outside the bound cwd. */
  readonly escaped: boolean;
  readonly evidence: string;
  /** Optional: relative write under cwd succeeded (positive control). */
  readonly insideWriteOk?: boolean;
}

export interface PiNativeQualificationInput {
  /** Manager-returned absolute worktree path bound as createAgentSession cwd. */
  readonly cwd: string;
  /**
   * Required escape-canary observation for any isolation claim. Omission fails
   * closed (`escape-canary-required`); `escaped: true` fails closed
   * (`escape-canary-failed`). Qualification does NOT close D160 — residual
   * risk and open questions remain until a separate cutover decision.
   */
  readonly escapeCanary?: EscapeCanaryObservation;
  /**
   * When true, a provider-backed live probe was required but could not run
   * (e.g. unauthenticated). Fails closed rather than claiming qualification.
   */
  readonly providerProbeRequiredButUnavailable?: boolean;
}

const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

export function isAbsoluteFilesystemPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && ABSOLUTE_PATH_RE.test(value);
}

/**
 * Wire-shaped worktree_manage handle (D287). Mirrors @cq/ledger
 * ManagedWorktreeHandle / ClaudeNativeManagedWorktreeHandle without importing
 * claudeNativeWorktree (avoids a cycle through isAbsoluteFilesystemPath).
 */
export type ClaudeNativeQualificationHandle = ManagedWorktreeHandle;

export interface ClaudeNativeQualificationInput {
  /**
   * Manager-returned absolute worktree path (worktree_manage prepare evidence).
   * Required for K238 harness-owned qualification.
   */
  readonly cwd: string;
  /**
   * Opaque handle from worktree_manage prepare/resume (D287). Required — a free
   * boolean handoff is refused. The versioned handle placement and
   * handle.absolutePath must equal cwd after normalization.
   */
  readonly handle: ClaudeNativeQualificationHandle;
}

export const CODEX_PROVIDER_PRETURN_BINDINGS = Object.freeze([
  "worktree-path",
  "managed-handle",
  "repository",
  "task",
  "role-effect-capability",
  "receipt-expectations",
  "role-prompt",
  "role-tools",
  "model",
  "reasoning-effort",
  "workspace-write",
  "skills-policy",
  "multi-agent-disabled",
] as const);

export type CodexProviderPreturnBinding = (typeof CODEX_PROVIDER_PRETURN_BINDINGS)[number];

export const CODEX_PROVIDER_ROUTES = Object.freeze(["native", "process"] as const);

export type CodexProviderRoute = (typeof CODEX_PROVIDER_ROUTES)[number];

export const CODEX_PROVIDER_FAILURE_CONTROLS = Object.freeze([
  "identity",
  "operation",
  "digest",
  "capability",
  "generation",
  "deadline",
  "completion",
  "cancel",
  "restart",
  "post-store",
  "replay",
] as const);

export type CodexProviderFailureControl = (typeof CODEX_PROVIDER_FAILURE_CONTROLS)[number];

export interface CodexProviderGateObservation {
  readonly kind: "cq-codex-provider-gate";
  readonly version: 1;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly effect: "git-commit" | "git-conflict-continue";
  /** The installed cq-codex-role boundary ran; a source wrapper cannot set this. */
  readonly packagedBoundary: true;
  /** A selector-only, mocked, skipped, or substituted provider run cannot qualify. */
  readonly substituted: false;
  readonly preturnBindings: readonly CodexProviderPreturnBinding[];
  readonly routes: readonly CodexProviderRoute[];
  readonly receiptChainVerified: true;
  readonly directGitDenied: true;
  readonly confinementVerified: true;
  readonly objectAttributionVerified: true;
  readonly parentReleaseVerified: true;
  readonly lifecycle: "single-or-typed-abort";
  readonly behavior: "commit-and-resume" | "multi-step-rebase";
  readonly failureControls: readonly CodexProviderFailureControl[];
  readonly runnerExecution: CodexInstalledRoleBoundaryExecution;
}

export interface CodexProviderReleaseEvidence {
  readonly status: "released";
  readonly handle: ManagedWorktreeHandle;
  readonly idempotent: boolean;
  readonly absolutePath: string;
}

export interface CodexProviderGateAuthenticationInput {
  readonly installedGateTest: CodexInstalledGateTestResult;
  readonly consumed: ConsumedDispatchResult;
  readonly release: CodexProviderReleaseEvidence;
}

export interface CodexInstalledGateTestResult {
  readonly kind: "cq-codex-installed-gate-test-result";
  readonly version: 1;
  readonly execution: CodexInstalledRoleBoundaryExecution;
  readonly nativeExecution?: CodexRoleBoundaryExecutionResult;
  readonly priorExecution?: CodexInstalledRoleBoundaryExecution | CodexRoleBoundaryExecutionResult;
  readonly priorConsumed?: ConsumedDispatchResult;
  readonly preturnBindings: readonly CodexProviderPreturnBinding[];
  readonly routes: readonly CodexProviderRoute[];
  readonly failureControls: readonly CodexProviderFailureControl[];
  readonly receiptChainVerified: true;
  readonly directGitDenied: true;
  readonly confinementVerified: true;
  readonly objectAttributionVerified: true;
  readonly lifecycle: "single-or-typed-abort";
  readonly behavior: "commit-and-resume" | "multi-step-rebase";
}

export interface CodexInstalledGateTestInput {
  readonly execution: CodexInstalledRoleBoundaryExecution;
  readonly nativeExecution?: CodexRoleBoundaryExecutionResult;
  readonly priorExecution?: CodexInstalledRoleBoundaryExecution | CodexRoleBoundaryExecutionResult;
  readonly priorConsumed?: ConsumedDispatchResult;
  readonly failureControls: readonly CodexProviderFailureControl[];
  readonly directGitDenied: true;
  readonly confinementVerified: true;
  readonly objectAttributionVerified: true;
  readonly lifecycle: "single-or-typed-abort";
}

const AUTHENTICATED_CODEX_PROVIDER_GATES = new WeakSet<object>();
const AUTHENTICATED_CODEX_NATIVE_QUALIFICATIONS = new WeakSet<object>();
const TRUSTED_CODEX_INSTALLED_GATE_TEST_RESULTS = new WeakSet<object>();

export interface CodexNativeQualificationInput {
  readonly cwd: string;
  readonly handle: ManagedWorktreeHandle;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly workerGate: CodexProviderGateObservation;
  readonly resolverGate: CodexProviderGateObservation;
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sameDispatchHandle(
  left: { readonly attestationId: string; readonly generation: number },
  right: { readonly attestationId: string; readonly generation: number },
): boolean {
  return left.attestationId === right.attestationId && left.generation === right.generation;
}

function exactKnownSubset<T extends string>(
  values: readonly T[],
  known: readonly T[],
): boolean {
  return (
    values.length > 0 &&
    new Set(values).size === values.length &&
    values.every((value) => known.includes(value))
  );
}

function sameManagedHandle(left: ManagedWorktreeHandle, right: ManagedWorktreeHandle): boolean {
  return (
    left.token === right.token &&
    left.worktreeId === right.worktreeId &&
    left.taskId === right.taskId &&
    left.repositoryRoot === right.repositoryRoot &&
    left.absolutePath === right.absolutePath
  );
}

/** Mint only after the installed package harness has asserted its observed controls. */
export function attestCodexInstalledGateTestResult(
  input: CodexInstalledGateTestInput,
): CodexInstalledGateTestResult {
  if (!isRunnerOwnedCodexInstalledRoleBoundaryExecution(input.execution)) {
    throw new Error("Codex installed gate test lacks a runner-owned process execution");
  }
  if (!exactKnownSubset(input.failureControls, CODEX_PROVIDER_FAILURE_CONTROLS)) {
    throw new Error("Codex installed gate test contains an empty, duplicate, or unknown observation");
  }
  if (
    (input.nativeExecution !== undefined &&
      (!isRunnerOwnedCodexRoleBoundaryExecution(input.nativeExecution) ||
        input.nativeExecution.observation.agentType !== input.execution.roleId))
  ) {
    throw new Error("Codex installed gate native-route claim lacks a runner-owned native execution");
  }
  const hasPrior = input.priorExecution !== undefined || input.priorConsumed !== undefined;
  if (hasPrior) {
    const priorExecution = input.priorExecution;
    const priorConsumed = input.priorConsumed;
    const priorOutput =
      priorConsumed === undefined
        ? undefined
        : objectRecord(priorConsumed.output, "installedGateTest.priorConsumed.output");
    const installedPrior = isRunnerOwnedCodexInstalledRoleBoundaryExecution(priorExecution);
    const nativePrior = isRunnerOwnedCodexRoleBoundaryExecution(priorExecution);
    if (
      input.execution.roleId !== "implement-worker" ||
      priorExecution === undefined ||
      priorConsumed === undefined ||
      !isBackendOwnedConsumedDispatchResult(priorConsumed) ||
      (!installedPrior && !nativePrior) ||
      (installedPrior &&
        (!sameManagedHandle(priorExecution.managedHandle, input.execution.managedHandle) ||
          !sameInstalledIdentity(priorExecution, input.execution))) ||
      (nativePrior && priorExecution.observation.agentType !== "implement-worker") ||
      priorOutput?.["taskId"] !== input.execution.managedHandle.taskId ||
      priorOutput?.["actualWorktreePath"] !== input.execution.managedHandle.absolutePath ||
      !sameDispatchHandle(priorConsumed, priorExecution.handle)
    ) {
      throw new Error("Codex installed worker retry does not preserve opaque prior-run authority");
    }
  }
  if (
    (input.execution.roleId === "implement-worker" && !hasPrior) ||
    (input.execution.roleId === "implement-conflict-resolver" && hasPrior)
  ) {
    throw new Error("Codex installed gate behavior does not match its role and retry evidence");
  }
  const result = Object.freeze({
    kind: "cq-codex-installed-gate-test-result" as const,
    version: 1 as const,
    execution: input.execution,
    ...(input.nativeExecution === undefined ? {} : { nativeExecution: input.nativeExecution }),
    ...(input.priorExecution === undefined ? {} : { priorExecution: input.priorExecution }),
    ...(input.priorConsumed === undefined ? {} : { priorConsumed: input.priorConsumed }),
    preturnBindings: CODEX_PROVIDER_PRETURN_BINDINGS,
    routes: Object.freeze([
      ...(input.nativeExecution === undefined ? [] : (["native"] as const)),
      "process" as const,
    ]),
    failureControls: Object.freeze([...input.failureControls]),
    receiptChainVerified: true as const,
    directGitDenied: input.directGitDenied,
    confinementVerified: input.confinementVerified,
    objectAttributionVerified: input.objectAttributionVerified,
    lifecycle: input.lifecycle,
    behavior:
      input.execution.roleId === "implement-worker"
        ? ("commit-and-resume" as const)
        : ("multi-step-rebase" as const),
  });
  TRUSTED_CODEX_INSTALLED_GATE_TEST_RESULTS.add(result);
  return result;
}

/**
 * Mint opaque provider evidence only after an installed runner execution, the
 * trusted parent's consumed dispatch body, and the manager release all agree.
 */
export function authenticateCodexProviderGateObservation(
  input: CodexProviderGateAuthenticationInput,
): CodexProviderGateObservation {
  if (!TRUSTED_CODEX_INSTALLED_GATE_TEST_RESULTS.has(input.installedGateTest)) {
    throw new Error("Codex provider evidence lacks a trusted installedGateTest result");
  }
  const installedGateTest = input.installedGateTest;
  const execution = installedGateTest.execution;
  if (!isRunnerOwnedCodexInstalledRoleBoundaryExecution(execution)) {
    throw new Error("Codex provider evidence was not produced by the installed-boundary runner");
  }
  if (!isBackendOwnedConsumedDispatchResult(input.consumed)) {
    throw new Error("Codex provider consumed result was not materialized by the attestation backend");
  }
  if (!isManagerOwnedReleaseResult(input.release)) {
    throw new Error("Codex provider release was not produced by the managed-worktree manager");
  }
  if (input.consumed.state !== "consumed" || !sameDispatchHandle(input.consumed, execution.handle)) {
    throw new Error("Codex provider consumed result does not match the runner dispatch handle");
  }
  const completion = input.consumed.nativeCompletion;
  if (
    completion.kind !== "native-completion" ||
    completion.actor !== "trusted-parent" ||
    completion.childId !== execution.expectedChild.childId ||
    completion.runId !== execution.expectedChild.runId
  ) {
    throw new Error("Codex provider completion does not match the runner-owned child identity");
  }
  const expectedProvenance = execution.expectedPromptProvenance;
  const observedProvenance = input.consumed.promptProvenance;
  if (
    observedProvenance.roleId !== expectedProvenance.roleId ||
    observedProvenance.version !== expectedProvenance.version ||
    observedProvenance.promptDigest !== expectedProvenance.promptDigest ||
    observedProvenance.inputDigest !== expectedProvenance.inputDigest ||
    observedProvenance.catalogHash !== expectedProvenance.catalogHash
  ) {
    throw new Error("Codex provider consumed result has substituted prompt provenance");
  }

  const output = objectRecord(input.consumed.output, "consumed.output");
  const managed = execution.managedHandle;
  if (
    output["status"] !== "pass" ||
    output["taskId"] !== managed.taskId ||
    output["branch"] !== managed.branch ||
    output["actualWorktreePath"] !== managed.absolutePath ||
    typeof output["resultCommit"] !== "string"
  ) {
    throw new Error("Codex provider result does not match its managed task/worktree binding");
  }
  const receiptsField =
    execution.roleId === "implement-worker" ? "gitReceipts" : "conflictReceipts";
  const receipts = output[receiptsField];
  if (!Array.isArray(receipts) || receipts.length < 2) {
    throw new Error(`Codex provider ${receiptsField} must contain a multi-step receipt chain`);
  }
  let previousHead: string | undefined;
  for (const [index, value] of receipts.entries()) {
    const receipt = objectRecord(value, `${receiptsField}[${String(index)}]`);
    const expectedKind =
      execution.roleId === "implement-worker"
        ? "cq-git-change-receipt"
        : "cq-git-conflict-continuation-receipt";
    if (
      receipt["kind"] !== expectedKind ||
      receipt["version"] !== 1 ||
      receipt["attestationId"] !== execution.handle.attestationId ||
      receipt["generation"] !== execution.handle.generation ||
      receipt["taskId"] !== managed.taskId ||
      typeof receipt["oldHead"] !== "string" ||
      typeof receipt["newHead"] !== "string" ||
      (previousHead !== undefined && receipt["oldHead"] !== previousHead)
    ) {
      throw new Error(`Codex provider ${receiptsField}[${String(index)}] breaks its dispatch chain`);
    }
    previousHead = receipt["newHead"];
  }
  if (previousHead !== output["resultCommit"]) {
    throw new Error(`Codex provider ${receiptsField} does not terminate at resultCommit`);
  }
  if (installedGateTest.priorConsumed !== undefined) {
    const priorOutput = objectRecord(
      installedGateTest.priorConsumed.output,
      "installedGateTest.priorConsumed.output",
    );
    const firstReceipt = objectRecord(receipts[0], `${receiptsField}[0]`);
    if (
      typeof priorOutput["resultCommit"] !== "string" ||
      firstReceipt["oldHead"] !== priorOutput["resultCommit"]
    ) {
      throw new Error("Codex worker criticism retry did not continue from the prior result commit");
    }
  }
  if (execution.roleId === "implement-conflict-resolver") {
    const firstOutcome = objectRecord(
      objectRecord(receipts[0], `${receiptsField}[0]`)["outcome"],
      `${receiptsField}[0].outcome`,
    );
    const lastOutcome = objectRecord(
      objectRecord(receipts.at(-1), `${receiptsField}[-1]`)["outcome"],
      `${receiptsField}[-1].outcome`,
    );
    if (
      firstOutcome["kind"] !== "conflict" ||
      lastOutcome["kind"] !== "terminal" ||
      lastOutcome["tip"] !== output["resultCommit"]
    ) {
      throw new Error("Codex resolver evidence does not prove a multi-step terminal rebase");
    }
  }

  if (
    input.release.status !== "released" ||
    input.release.idempotent !== false ||
    input.release.absolutePath !== managed.absolutePath ||
    input.release.handle.token !== managed.token ||
    input.release.handle.taskId !== managed.taskId ||
    input.release.handle.repositoryRoot !== managed.repositoryRoot ||
    input.release.handle.absolutePath !== managed.absolutePath
  ) {
    throw new Error("Codex provider parent release does not match the managed runner handle");
  }

  const roleId = execution.roleId;
  const observation = Object.freeze({
    kind: "cq-codex-provider-gate" as const,
    version: 1 as const,
    roleId,
    effect: execution.effect,
    packagedBoundary: true as const,
    substituted: false as const,
    preturnBindings: installedGateTest.preturnBindings,
    routes: installedGateTest.routes,
    receiptChainVerified: installedGateTest.receiptChainVerified,
    directGitDenied: installedGateTest.directGitDenied,
    confinementVerified: installedGateTest.confinementVerified,
    objectAttributionVerified: installedGateTest.objectAttributionVerified,
    parentReleaseVerified: true as const,
    lifecycle: installedGateTest.lifecycle,
    behavior: installedGateTest.behavior,
    failureControls: installedGateTest.failureControls,
    runnerExecution: execution,
  });
  AUTHENTICATED_CODEX_PROVIDER_GATES.add(observation);
  return observation;
}

function normalizeAbsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Managed implement worktrees use a v1 UUID path or v2 adopted implement-T path. */
const MANAGED_WORKTREE_MARKER = "/.claude/worktrees/";
const MANAGED_WORKTREE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADOPTED_WORKTREE_SEGMENT = /^implement-T\d+$/;

export function isManagedWorktreePath(cwd: string): boolean {
  if (!isAbsoluteFilesystemPath(cwd)) return false;
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  // Reject traversal and empty segments before accepting the managed marker.
  if (normalized.includes("/../") || normalized.endsWith("/..") || normalized.includes("//")) {
    return false;
  }
  const idx = normalized.lastIndexOf(MANAGED_WORKTREE_MARKER);
  if (idx < 0) return false;
  const after = normalized.slice(idx + MANAGED_WORKTREE_MARKER.length);
  // Exactly one path segment (the worktree id); no nested escapes.
  if (after.length === 0 || after.includes("/")) return false;
  return MANAGED_WORKTREE_ID.test(after) || ADOPTED_WORKTREE_SEGMENT.test(after);
}

/**
 * Claude same-harness native (`Agent` tool): no path parameter; child shares
 * the parent process and cwd. Structural path-scoped write confinement remains
 * unproven (K170 did NOT accept that residual).
 *
 * decisions:K238 / Q383(b): qualify `claude:native` under **harness-owned**
 * confinement when the orchestrator bound an absolute managed worktree path via
 * worktree_manage. That is NOT a write-confinement claim — it is an explicit
 * acceptance of harness-owned isolation + path handoff.
 *
 * Without managed binding evidence the adapter stays incompatible.
 */
export function qualifyClaudeNativeAdapter(
  input?: ClaudeNativeQualificationInput,
): NativeAdapterQualification {
  if (input === undefined) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "missing-cwd-binding" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native requires worktree_manage handle + path handoff (decisions:K238 / Q383(b) / D287). " +
        "Call qualifyClaudeNativeAdapter({ cwd, handle }) with the manager-returned absolute path " +
        "and opaque handle. Structural path-scoped write confinement remains unproven; K170 did " +
        "NOT accept write-confinement residual.",
    });
  }

  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "missing-cwd-binding" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native K238 qualification requires a non-empty manager-returned cwd.",
    });
  }

  if (!isAbsoluteFilesystemPath(input.cwd)) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "cwd-not-absolute" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail: `claude:native cwd must be absolute; got ${JSON.stringify(input.cwd)}`,
    });
  }

  const handleValidation = validateManagedWorktreeHandle(input.handle);
  if (handleValidation.status === "invalid") {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason:
        handleValidation.reason === "handle-invalid"
          ? ("handle-invalid" as const)
          : ("handle-path-mismatch" as const),
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native K238 qualification requires a cq-managed-worktree-handle shaped handle " +
        `from worktree_manage (D287): ${handleValidation.detail}. Free-form boolean handoffs are refused. K170 did NOT ` +
        "accept write-confinement residual.",
    });
  }

  if (!isManagedWorktreePath(input.cwd)) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "path-scoped-confinement-unproven" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native managed path must use a UUID or canonical implement-T segment; got " +
        `${JSON.stringify(input.cwd)}. K170 did NOT accept write-confinement residual.`,
    });
  }

  const cwdNorm = normalizeAbsPath(input.cwd);
  const handlePathNorm = normalizeAbsPath(input.handle.absolutePath);
  if (cwdNorm !== handlePathNorm) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "handle-path-mismatch" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native K238: cwd must equal the version-validated handle.absolutePath " +
        `(D287). cwd=${JSON.stringify(input.cwd)} handle.worktreeId=` +
        `${JSON.stringify(input.handle.worktreeId)} handle.absolutePath=` +
        `${JSON.stringify(input.handle.absolutePath)}`,
    });
  }

  return Object.freeze({
    status: "qualified" as const,
    adapterId: "claude:native" as const,
    targetHarness: "claude" as const,
    transport: "native" as const,
    confinement: "harness-owned" as const,
    defectClosed: "D263" as const,
    evidence:
      "decisions:K238 / Q383(b) / D287: harness-owned Claude native isolation accepted after " +
      `worktree_manage handle+path handoff to ${JSON.stringify(input.cwd)} ` +
      `(worktreeId=${JSON.stringify(input.handle.worktreeId)}). ` +
      "Agent tool still has no path parameter — this is NOT structural path-scoped " +
      "write confinement. decisions:K170 did NOT accept write-confinement residual; " +
      "handleOnlyOutput remains the only K170 residual. D263 closed under harness-owned model.",
  });
}

/**
 * Pi same-harness native via createAgentSession({ cwd }) (or equivalent) bound
 * to the manager-returned worktree path. Qualifies only when cwd is absolute,
 * an escape canary is supplied and does not observe an outside write.
 *
 * IMPORTANT: a qualified result does NOT close D160 (`defectClosed` stays
 * null). Structural placement evidence is necessary but not a cutover claim.
 */
export function qualifyPiNativeAdapter(
  input: PiNativeQualificationInput,
): NativeAdapterQualification {
  if (input.providerProbeRequiredButUnavailable === true) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "pi:native" as const,
      targetHarness: "pi" as const,
      transport: "native" as const,
      reason: "provider-probe-unavailable" as const,
      confinement: "unproven" as const,
      defect: "D160" as const,
      detail:
        "A provider-backed Pi native probe was required but could not run; " +
        "positive-only policy refuses pi:native registration without structural proof.",
    });
  }

  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "pi:native" as const,
      targetHarness: "pi" as const,
      transport: "native" as const,
      reason: "missing-cwd-binding" as const,
      confinement: "unproven" as const,
      defect: "D160" as const,
      detail: "Pi native isolation requires createAgentSession({cwd}) with a manager-returned path.",
    });
  }

  if (!isAbsoluteFilesystemPath(input.cwd)) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "pi:native" as const,
      targetHarness: "pi" as const,
      transport: "native" as const,
      reason: "cwd-not-absolute" as const,
      confinement: "unproven" as const,
      defect: "D160" as const,
      detail: `Pi native cwd must be absolute; got ${JSON.stringify(input.cwd)}`,
    });
  }

  if (input.escapeCanary === undefined) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "pi:native" as const,
      targetHarness: "pi" as const,
      transport: "native" as const,
      reason: "escape-canary-required" as const,
      confinement: "unproven" as const,
      defect: "D160" as const,
      detail:
        "Pi native isolation claims require an escape-canary observation; " +
        "cwd-binding alone is insufficient and does not close D160.",
    });
  }

  if (input.escapeCanary.escaped === true) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "pi:native" as const,
      targetHarness: "pi" as const,
      transport: "native" as const,
      reason: "escape-canary-failed" as const,
      confinement: "unproven" as const,
      defect: "D160" as const,
      detail: input.escapeCanary.evidence,
    });
  }

  return Object.freeze({
    status: "qualified" as const,
    adapterId: "pi:native" as const,
    targetHarness: "pi" as const,
    transport: "native" as const,
    confinement: "structural" as const,
    // D160 stays OPEN: qualification is placement evidence, not cutover/closure.
    defectClosed: null,
    evidence:
      "createAgentSession({cwd}) (or equivalent) binds built-in tools to the manager-returned " +
      `absolute path ${JSON.stringify(input.cwd)}; same-harness forceShellout=false must not ` +
      "use launchPiChild. Escape canary passed " +
      `(${input.escapeCanary.evidence}). D160 remains open — not a cutover-ready claim.`,
  });
}

function codexIncompatible(
  reason: NativeQualificationRefusalReason,
  detail: string,
): NativeAdapterIncompatible {
  return Object.freeze({
    status: "incompatible" as const,
    adapterId: "codex:native" as const,
    targetHarness: "codex" as const,
    transport: "native" as const,
    reason,
    confinement: "unproven" as const,
    defect: "D307" as const,
    detail,
  });
}

function codexProviderGateViolation(
  value: unknown,
  expectedRole: CodexProviderGateObservation["roleId"],
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${expectedRole} provider gate is not an observation object`;
  }
  if (!AUTHENTICATED_CODEX_PROVIDER_GATES.has(value)) {
    return `${expectedRole} provider gate was not authenticated by the installed-boundary runner`;
  }
  const gate = value as Record<string, unknown>;
  const expectedEffect =
    expectedRole === "implement-worker" ? "git-commit" : "git-conflict-continue";
  const expectedBehavior =
    expectedRole === "implement-worker" ? "commit-and-resume" : "multi-step-rebase";
  if (
    gate["kind"] !== "cq-codex-provider-gate" ||
    gate["version"] !== 1 ||
    gate["roleId"] !== expectedRole ||
    gate["effect"] !== expectedEffect
  ) {
    return `${expectedRole} provider gate identity or effect does not match its bound role`;
  }
  if (gate["packagedBoundary"] !== true || gate["substituted"] !== false) {
    return `${expectedRole} provider gate did not run through the unsubstituted packaged boundary`;
  }
  if (
    !Array.isArray(gate["preturnBindings"]) ||
    !exactKnownSubset(
      gate["preturnBindings"] as CodexProviderPreturnBinding[],
      CODEX_PROVIDER_PRETURN_BINDINGS,
    )
  ) {
    return `${expectedRole} provider gate contains an invalid preturn binding observation`;
  }
  if (
    !Array.isArray(gate["routes"]) ||
    !exactKnownSubset(gate["routes"] as CodexProviderRoute[], CODEX_PROVIDER_ROUTES)
  ) {
    return `${expectedRole} provider gate contains an invalid route observation`;
  }
  if (
    gate["receiptChainVerified"] !== true ||
    gate["directGitDenied"] !== true ||
    gate["confinementVerified"] !== true ||
    gate["objectAttributionVerified"] !== true ||
    gate["parentReleaseVerified"] !== true ||
    gate["lifecycle"] !== "single-or-typed-abort" ||
    gate["behavior"] !== expectedBehavior
  ) {
    return `${expectedRole} provider gate did not prove its broker, receipt, lifecycle, and release invariants`;
  }
  if (
    !Array.isArray(gate["failureControls"]) ||
    !exactKnownSubset(
      gate["failureControls"] as CodexProviderFailureControl[],
      CODEX_PROVIDER_FAILURE_CONTROLS,
    )
  ) {
    return `${expectedRole} provider gate contains an invalid fail-closed control observation`;
  }
  return undefined;
}

function combinedObservationsCover<T extends string>(
  expected: readonly T[],
  ...observations: (readonly T[])[]
): boolean {
  const observed = new Set(observations.flat());
  return observed.size === expected.length && expected.every((entry) => observed.has(entry));
}

function codexProviderIdentityViolation(
  gate: CodexProviderGateObservation,
  expected: CodexNativeQualificationInput,
): string | undefined {
  const execution = gate.runnerExecution;
  const managed = execution.managedHandle;
  if (
    managed.token !== expected.handle.token ||
    managed.worktreeId !== expected.handle.worktreeId ||
    managed.taskId !== expected.taskId ||
    managed.repositoryRoot !== expected.repositoryRoot ||
    managed.absolutePath !== expected.cwd
  ) {
    return `${gate.roleId} provider gate does not match the exact qualification handle/repository/task identity`;
  }
  return undefined;
}

function sameInstalledIdentity(
  left: CodexInstalledRoleBoundaryExecution,
  right: CodexInstalledRoleBoundaryExecution,
): boolean {
  return (
    left.installedIdentity.storePath === right.installedIdentity.storePath &&
    left.installedIdentity.executablePath === right.installedIdentity.executablePath &&
    left.installedIdentity.executableDigest === right.installedIdentity.executableDigest
  );
}

/**
 * T2044 positive-only Codex qualification. A task binding alone cannot qualify:
 * both role-specific packaged provider gates must attest the trusted Git effect
 * boundary before `codex:native` may enter the dispatch registry.
 */
export function qualifyCodexNativeAdapter(
  input?: CodexNativeQualificationInput,
): NativeAdapterQualification {
  if (input === undefined || input.workerGate === undefined || input.resolverGate === undefined) {
    return codexIncompatible(
      "provider-gates-required",
      "codex:native requires both unsubstituted packaged provider gates: implement-worker " +
        "git_commit and implement-conflict-resolver git_conflict_continue. D307 remains the " +
        "controlling incompatibility until both observations pass.",
    );
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    return codexIncompatible(
      "missing-cwd-binding",
      "codex:native requires a non-empty worktree_manage cwd binding.",
    );
  }
  if (!isAbsoluteFilesystemPath(input.cwd)) {
    return codexIncompatible(
      "cwd-not-absolute",
      `codex:native cwd must be absolute; got ${JSON.stringify(input.cwd)}`,
    );
  }
  const handleValidation = validateManagedWorktreeHandle(input.handle);
  if (handleValidation.status === "invalid") {
    return codexIncompatible(
      handleValidation.reason === "handle-invalid" ? "handle-invalid" : "handle-path-mismatch",
      `codex:native requires an intact worktree_manage handle: ${handleValidation.detail}`,
    );
  }
  if (!isManagedWorktreePath(input.cwd)) {
    return codexIncompatible(
      "path-scoped-confinement-unproven",
      `codex:native cwd is not a managed worktree path: ${JSON.stringify(input.cwd)}`,
    );
  }
  if (normalizeAbsPath(input.cwd) !== normalizeAbsPath(input.handle.absolutePath)) {
    return codexIncompatible(
      "handle-path-mismatch",
      "codex:native cwd must equal the validated managed handle absolutePath.",
    );
  }
  if (
    !isAbsoluteFilesystemPath(input.repositoryRoot) ||
    normalizeAbsPath(input.repositoryRoot) !== normalizeAbsPath(input.handle.repositoryRoot)
  ) {
    return codexIncompatible(
      "handle-repository-mismatch",
      "codex:native repositoryRoot must equal the repository identity bound into the managed handle.",
    );
  }
  if (typeof input.taskId !== "string" || input.taskId !== input.handle.taskId) {
    return codexIncompatible(
      "handle-task-mismatch",
      "codex:native taskId must equal the task identity bound into the managed handle.",
    );
  }
  const workerViolation = codexProviderGateViolation(input.workerGate, "implement-worker");
  if (workerViolation !== undefined) {
    return codexIncompatible("provider-gate-failed", workerViolation);
  }
  const resolverViolation = codexProviderGateViolation(
    input.resolverGate,
    "implement-conflict-resolver",
  );
  if (resolverViolation !== undefined) {
    return codexIncompatible("provider-gate-failed", resolverViolation);
  }
  const workerIdentityViolation = codexProviderIdentityViolation(input.workerGate, input);
  if (workerIdentityViolation !== undefined) {
    return codexIncompatible("provider-gate-failed", workerIdentityViolation);
  }
  const resolverIdentityViolation = codexProviderIdentityViolation(input.resolverGate, input);
  if (resolverIdentityViolation !== undefined) {
    return codexIncompatible("provider-gate-failed", resolverIdentityViolation);
  }
  if (
    !sameInstalledIdentity(
      input.workerGate.runnerExecution,
      input.resolverGate.runnerExecution,
    )
  ) {
    return codexIncompatible(
      "provider-gate-failed",
      "Codex provider gates were not produced by the same exact installed derivation",
    );
  }
  if (
    !combinedObservationsCover(
      CODEX_PROVIDER_PRETURN_BINDINGS,
      input.workerGate.preturnBindings,
      input.resolverGate.preturnBindings,
    ) ||
    !combinedObservationsCover(
      CODEX_PROVIDER_ROUTES,
      input.workerGate.routes,
      input.resolverGate.routes,
    ) ||
    !combinedObservationsCover(
      CODEX_PROVIDER_FAILURE_CONTROLS,
      input.workerGate.failureControls,
      input.resolverGate.failureControls,
    )
  ) {
    return codexIncompatible(
      "provider-gate-failed",
      "Codex provider gates do not jointly cover every required preturn binding, route, and failure control",
    );
  }
  const qualification = Object.freeze({
    status: "qualified" as const,
    adapterId: "codex:native" as const,
    targetHarness: "codex" as const,
    transport: "native" as const,
    confinement: "structural" as const,
    defectClosed: "D307" as const,
    evidence:
      "T2044: exact worktree_manage path/handle/repository/task binding plus unsubstituted " +
      "packaged implement-worker and implement-conflict-resolver provider gates proved preturn " +
      "prompt/tool/model/effort/workspace-write/skills/multi-agent bindings, role-specific broker " +
      "capabilities, receipt chains, native+process routing, confinement/OID attribution, " +
      "single-or-typed-abort lifecycle, same-handle resume, multi-step rebase, and parent release.",
  });
  AUTHENTICATED_CODEX_NATIVE_QUALIFICATIONS.add(qualification);
  return qualification;
}

/** Registry guard: a caller-constructed qualified object has no authority. */
export function isAuthenticatedCodexNativeQualification(
  value: NativeAdapterQualification,
): value is NativeAdapterQualified & { readonly adapterId: "codex:native" } {
  return (
    value.status === "qualified" &&
    value.adapterId === "codex:native" &&
    AUTHENTICATED_CODEX_NATIVE_QUALIFICATIONS.has(value)
  );
}

/**
 * Refuse any incompatible positive-only qualification.
 */
export function assertNativeAdapterQualified(
  qualification: NativeAdapterQualification,
): asserts qualification is NativeAdapterQualified {
  if (qualification.status !== "qualified") {
    throw new NativeAdapterIncompatibilityError(qualification);
  }
}

/** Filter qualifications down to adapter ids that may be registered. */
export function selectQualifiedNativeAdapterIds(
  qualifications: readonly NativeAdapterQualification[],
): readonly NativeAdapterId[] {
  return Object.freeze(
    qualifications
      .filter((entry): entry is NativeAdapterQualified => entry.status === "qualified")
      .map((entry) => entry.adapterId),
  );
}

export function isNativeAdapterId(value: string): value is NativeAdapterId {
  return (NATIVE_ADAPTER_IDS as readonly string[]).includes(value);
}

export function nativeAdapterIdFor(targetHarness: Harness): NativeAdapterId {
  return `${targetHarness}:native`;
}
