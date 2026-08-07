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
  | "provider-probe-unavailable";

export type NativePathConfinementStrength = "structural" | "harness-owned" | "unproven";

export interface NativeAdapterQualified {
  readonly status: "qualified";
  readonly adapterId: NativeAdapterId;
  readonly targetHarness: Harness;
  readonly transport: "native";
  readonly confinement: "structural" | "harness-owned";
  readonly evidence: string;
  readonly defectClosed: "D263" | "D160" | null;
}

export interface NativeAdapterIncompatible {
  readonly status: "incompatible";
  readonly adapterId: NativeAdapterId;
  readonly targetHarness: Harness;
  readonly transport: "native";
  readonly reason: NativeQualificationRefusalReason;
  readonly detail: string;
  readonly defect: "D263" | "D160";
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
  readonly defect: "D263" | "D160";

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

export interface ClaudeNativeQualificationInput {
  /**
   * Manager-returned absolute worktree path (worktree_manage prepare evidence).
   * Required for K238 harness-owned qualification.
   */
  readonly cwd: string;
  /**
   * When true, cwd was obtained from worktree_manage prepare/resume (not a
   * free-form path). Required for K238 qualification.
   */
  readonly worktreeManageBound: boolean;
}

/** Managed implement worktrees live under `<repo>/.claude/worktrees/<id>`. */
const MANAGED_WORKTREE_MARKER = "/.claude/worktrees/";

export function isManagedWorktreePath(cwd: string): boolean {
  if (!isAbsoluteFilesystemPath(cwd)) return false;
  const normalized = cwd.replace(/\\/g, "/");
  return normalized.includes(MANAGED_WORKTREE_MARKER);
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
        "claude:native requires worktree_manage path handoff (decisions:K238 / Q383(b)). " +
        "Call qualifyClaudeNativeAdapter({ cwd, worktreeManageBound: true }) with the " +
        "manager-returned absolute path. Structural path-scoped write confinement remains " +
        "unproven; K170 did NOT accept write-confinement residual.",
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

  if (input.worktreeManageBound !== true) {
    return Object.freeze({
      status: "incompatible" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      reason: "path-scoped-confinement-unproven" as const,
      confinement: "unproven" as const,
      defect: "D263" as const,
      detail:
        "claude:native K238 qualification requires worktreeManageBound=true (path from " +
        "worktree_manage prepare/resume). Free-form cwd is refused. K170 did NOT accept " +
        "write-confinement residual; harness-owned isolation only applies after managed handoff.",
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
        "claude:native managed path must lie under .claude/worktrees/; got " +
        `${JSON.stringify(input.cwd)}. K170 did NOT accept write-confinement residual.`,
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
      "decisions:K238 / Q383(b): harness-owned Claude native isolation accepted after " +
      `worktree_manage path handoff to ${JSON.stringify(input.cwd)}. ` +
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

/**
 * Codex native remains out of scope for D263/D160; callers supply their own
 * qualification. This helper only documents the positive-only gate shape.
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
