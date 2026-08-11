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
}

export interface CodexNativeQualificationInput {
  readonly cwd: string;
  readonly handle: ManagedWorktreeHandle;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly workerGate: CodexProviderGateObservation;
  readonly resolverGate: CodexProviderGateObservation;
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

function exactOrderedStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function codexProviderGateViolation(
  value: unknown,
  expectedRole: CodexProviderGateObservation["roleId"],
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${expectedRole} provider gate is not an observation object`;
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
  if (!exactOrderedStrings(gate["preturnBindings"], CODEX_PROVIDER_PRETURN_BINDINGS)) {
    return `${expectedRole} provider gate did not prove the canonical preturn binding set`;
  }
  if (!exactOrderedStrings(gate["routes"], CODEX_PROVIDER_ROUTES)) {
    return `${expectedRole} provider gate did not prove both native and process routes`;
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
  if (!exactOrderedStrings(gate["failureControls"], CODEX_PROVIDER_FAILURE_CONTROLS)) {
    return `${expectedRole} provider gate did not prove the canonical fail-closed controls`;
  }
  return undefined;
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
  return Object.freeze({
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
