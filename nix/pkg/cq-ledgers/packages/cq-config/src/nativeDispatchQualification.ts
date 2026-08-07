/**
 * Positive-only native adapter qualification (T1698/D263, T1699/D160).
 *
 * A `*:native` transport adapter is registered ONLY when structural
 * path-scoped confinement can be proven for that surface. Unproven surfaces
 * stay unregistered and resolve through a typed incompatibility — never a
 * silent prompt-best-effort write confinement claim.
 *
 * decisions:K170 chose the harness axis (same-harness → native transport,
 * cross-harness → process). It did NOT accept write/worktree confinement risk
 * for Claude native (D263). Handle-only output residual is a separate axis.
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
  | "missing-cwd-binding"
  | "cwd-not-absolute"
  | "provider-probe-unavailable";

export type NativePathConfinementStrength = "structural" | "unproven";

export interface NativeAdapterQualified {
  readonly status: "qualified";
  readonly adapterId: NativeAdapterId;
  readonly targetHarness: Harness;
  readonly transport: "native";
  readonly confinement: "structural";
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
   * Optional escape-canary observation. When omitted, qualification still
   * requires an absolute cwd and records structural placement evidence from
   * createAgentSession({cwd}) tool binding. When present and `escaped`,
   * qualification fails closed.
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
 * Claude same-harness native (`Agent` tool): no path parameter, child shares
 * the parent process and cwd. Structural path-scoped write confinement cannot
 * be proven on this surface — leave `claude:native` unregistered (D263).
 *
 * Provider-backed Claude probes are not required for this negative proof: the
 * Agent tool field table (tasks:T722 §8.1b) has no path parameter, which is a
 * structural absence independent of authentication.
 */
export function qualifyClaudeNativeAdapter(): NativeAdapterQualification {
  return Object.freeze({
    status: "incompatible" as const,
    adapterId: "claude:native" as const,
    targetHarness: "claude" as const,
    transport: "native" as const,
    reason: "path-scoped-confinement-unproven" as const,
    confinement: "unproven" as const,
    defect: "D263" as const,
    detail:
      "Claude Code Agent tool accepts subagent_type/prompt/model/isolation/run_in_background " +
      "and has no path parameter (tasks:T722 §8.1b). A native child shares the parent process " +
      "and cwd, so path-scoped write confinement is unproven. decisions:K170 selected native " +
      "transport on the harness axis only — it did NOT accept write-confinement residual for " +
      "D263. Positive-only policy leaves claude:native unregistered until structural " +
      "confinement can be proven.",
  });
}

/**
 * Pi same-harness native via createAgentSession({ cwd }) (or equivalent) bound
 * to the manager-returned worktree path. Qualifies only when cwd is absolute
 * and no escape canary observes an outside write (D160).
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

  if (input.escapeCanary?.escaped === true) {
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
    defectClosed: "D160" as const,
    evidence:
      "createAgentSession({cwd}) (or equivalent) binds built-in tools to the manager-returned " +
      `absolute path ${JSON.stringify(input.cwd)}; same-harness forceShellout=false must not ` +
      "use launchPiChild. Escape canary " +
      (input.escapeCanary === undefined
        ? "not supplied — placement confinement accepted on cwd-binding evidence alone"
        : `passed (${input.escapeCanary.evidence})`) +
      ".",
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
