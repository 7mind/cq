/**
 * T687 — the CLAUDE-surface binding of the compact dispatch protocol:
 * `prepare_dispatch → child store_result → confirm_dispatch_completion →
 * fetch_dispatch_result`.
 *
 * The lifecycle itself is surface-agnostic and already lives in
 * {@link ./dispatchAttestation} (T685/T686/T720). NOTHING here re-implements it,
 * exactly as its Codex sibling {@link ./codexDispatchProtocol} re-implements
 * nothing. This module answers only the questions the shared service
 * deliberately does not:
 *
 *  1. **WHICH Claude child-delivery mode can carry a role prompt to a child and
 *     bring back a handle without materialising the body in the parent's
 *     context, and which modes cannot?** Answered by
 *     {@link CLAUDE_DELIVERY_MODES} — a classification whose every entry cites a
 *     MEASUREMENT from the tasks:T722 probe, not a reading of documentation.
 *  2. **WHAT counts as proof that the exact child the parent launched is the one
 *     that completed?** Answered by {@link ClaudeChildCorrelation} plus
 *     {@link decideClaudeCompletion}. Correlation is PARENT-MINTED before
 *     prepare and read back off the TRANSPORT, never off the child's own
 *     message — and its PROVENANCE STRENGTH differs by mode
 *     ({@link claudeCorrelationProvenance}), which this module states rather
 *     than averages away.
 *  3. **WHEN may the parent promote `result-stored → consumed`?** Answered by
 *     {@link decideClaudeCompletion}: on a captured, stored, handle-only reply
 *     whose TERMINAL SIGNAL says the turn completed. A process exit status only
 *     CORROBORATES (defects:D179).
 *
 * ## The harness-axis split this module implements (decisions:K170)
 *
 * decisions:K170 is a USER DECISION and is not re-opened here. One MCP surface,
 * `dispatch_agent`, serves every pairing; the transport is chosen by whether the
 * DISPATCHER shares the CHILD's harness. On the Claude surface — i.e. for a
 * CLAUDE child — that yields exactly two supported modes:
 *
 * | dispatcher | mode | transport |
 * |---|---|---|
 * | claude | {@link CLAUDE_NATIVE_DELIVERY_MODE} | NATIVE `Agent`, no shellout |
 * | codex / pi | {@link CLAUDE_CROSS_HARNESS_DELIVERY_MODE} | wrapper shellout |
 *
 * That is the same shape as the Codex surface's `native-agent` +
 * `exec-intercepted` pair, and for the same reason: same-harness dispatch is
 * native by decision, cross-harness dispatch needs a process boundary anyway.
 *
 * ## The residual decisions:K170 ACCEPTED, stated plainly because it is policy
 *
 * tasks:T722 recommendation #1 said, in terms, *do not build the Claude bridge
 * on the native `Agent` tool* — because a native subagent's final message can be
 * neither schema-constrained (there is no per-subagent equivalent of
 * `--json-schema`; the frontmatter field table has no output-schema field) nor
 * intercepted (`PostToolUse.hookSpecificOutput.updatedToolOutput` is INERT,
 * control-proven on a plain `Bash` tool; the background injection emits no hook
 * event at all). T722 measured what non-compliance costs: with the schema flag
 * the visible completion was 215 B and marker-free, and with it dropped the SAME
 * prompt produced **2,689 B containing the body**.
 *
 * decisions:K170 OVERRODE that recommendation, and the user affirmed the
 * tradeoff in terms ("on Q366, the tradeoff is acceptable"). This module
 * therefore does NOT pretend the native path is contained. It types the
 * difference instead — see {@link CLAUDE_CONTAINMENT_PROFILES} and
 * {@link CLAUDE_ACCEPTED_RESIDUALS} — so that "best-effort" is a value a caller
 * can read and a test can pin, not an omission. Per K170 there is deliberately
 * NO shellout fallback for the same-harness path: falling back would silently
 * reverse a user decision.
 *
 * The distinction that makes this honest rather than merely documented:
 * on a `prompt-best-effort` property the check here is a **DETECTOR, not a
 * PREVENTER**. {@link classifyClaudeFinalMessage} still aborts an echo, so the
 * LIFECYCLE stays sound; but the abort cannot un-read a body that already
 * reached the parent's context. T722's own formulation: *context, unlike a store
 * record, has no abort.*
 *
 * ## Scope boundary, stated explicitly (defects:D186's lesson)
 *
 * This module DEFINES the protocol and is inert: it renders no asset, spawns no
 * child, and changes no deployed instruction. tasks:T688 implements it against a
 * live child and tasks:T689 proves it. {@link CLAUDE_DISPATCH_DEFERRED} lists
 * what is deliberately NOT done here so none of it is silently assumed done.
 *
 * Shared FETCH semantics follow defects:D188: the body materializes exactly
 * once, and a repeat answers `output-already-materialized`.
 */

import {
  ATTESTATION_ID_ENTROPY_BYTES,
  AttestationContractError,
  LAUNCH_DEADLINE_MS,
  attestationInstantMs,
  type DispatchRandomBytes,
  type NativeChildIdentity,
  type TrustedDispatchActor,
} from "./dispatchAttestation.js";
import { DISPATCHED_ROLE_IDS } from "./promptCatalogStore.js";
import type {
  DispatchAbortReason,
  DispatchDeadlines,
  DispatchHandle,
  DispatchJSONValue,
  NativeCompletionProof,
} from "./compactDispatchProtocol.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A Claude delivery mode that cannot satisfy the ref-first contract was named on
 * a launch path.
 *
 * This is an AUTHORING defect, not a lifecycle outcome: an unsupported mode must
 * be refused before a child exists, so it can never become an abort reason and
 * can never be mistaken for a child failure.
 */
export class ClaudeUnsupportedModeError extends Error {
  readonly mode: string;
  readonly evidence: string;

  constructor(mode: string, evidence: string) {
    super(`Claude delivery mode "${mode}" cannot satisfy the ref-first contract: ${evidence}`);
    this.name = "ClaudeUnsupportedModeError";
    this.mode = mode;
    this.evidence = evidence;
  }
}

/**
 * An observation was presented whose provenance is not the native transport.
 *
 * Separate from {@link ClaudeUnsupportedModeError} because it is the one failure
 * a MALICIOUS or merely confused child could otherwise cause: a bridge that
 * accepted child-reported correlation would let any child claim to be any other.
 * tasks:T722 verdict #6, verbatim: a bridge "must not trust a child's
 * self-reported handle".
 */
export class ClaudeObservationProvenanceError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Claude completion observation ${field}: ${detail}`);
    this.name = "ClaudeObservationProvenanceError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// 1. Delivery-mode classification
// ---------------------------------------------------------------------------

/**
 * Every Claude mechanism PROPOSED or OBSERVED as a way to dispatch a Claude
 * child under the ref-first contract. Exactly two are supported; the rest are
 * enumerated so an unsupported one is refused BY NAME rather than silently
 * attempted.
 */
export const CLAUDE_DELIVERY_MODE_IDS = [
  "native-subagent",
  "wrapper-shellout",
  "background-native-subagent",
  "inherited-mcp-tool",
  "raw-print-stdout",
  "post-tool-use-rewrite",
  "setting-sources-isolated",
] as const;

export type ClaudeDeliveryMode = (typeof CLAUDE_DELIVERY_MODE_IDS)[number];

/**
 * Which dispatcher harness selects a mode, per decisions:K170's harness axis.
 * `same-harness` means a Claude parent dispatching a Claude child; `cross-harness`
 * means a codex or pi dispatcher reaching a Claude child.
 */
export const CLAUDE_DISPATCHER_CLASSES = ["same-harness", "cross-harness"] as const;

export type ClaudeDispatcherClass = (typeof CLAUDE_DISPATCHER_CLASSES)[number];

/**
 * How strongly a property is held. `structural` means the surface cannot violate
 * it whatever the child does; `prompt-best-effort` means the child is ASKED, the
 * violation is DETECTED after the fact, and the detection cannot undo it.
 */
export const CLAUDE_ENFORCEMENT_STRENGTHS = ["structural", "prompt-best-effort"] as const;

export type ClaudeEnforcementStrength = (typeof CLAUDE_ENFORCEMENT_STRENGTHS)[number];

/**
 * The three properties ref-first depends on, and how strongly each mode holds
 * them.
 *
 * `resultStorage` is typed as the literal `"structural"` rather than as a
 * {@link ClaudeEnforcementStrength} ON PURPOSE: the capability path never
 * depends on child compliance in EITHER mode — tasks:T722 §8.1a measured a
 * native child performing a genuine capability-bound `store_result` from a
 * per-subagent inline endpoint that was ABSENT from the parent's tool set — so a
 * mode that weakened it would not be a Claude dispatch mode at all. Making that
 * unrepresentable is cheaper than testing for it.
 */
export interface ClaudeContainmentProfile {
  /** Whether a body echo in the child's FINAL MESSAGE is prevented, or only detected. */
  readonly handleOnlyOutput: ClaudeEnforcementStrength;
  /** Whether the child is CONFINED to the prepared worktree, or only asked to stay in it. */
  readonly worktreeConfinement: ClaudeEnforcementStrength;
  /** Invariant across modes: the store path is capability-bound, never prompt-bound. */
  readonly resultStorage: "structural";
}

/**
 * One mode's verdict. `evidence` is the measurement that DECIDED the verdict —
 * every entry below traces to a tasks:T722 run, never to an inference from
 * documentation.
 */
export interface ClaudeDeliveryModeVerdict {
  readonly mode: ClaudeDeliveryMode;
  readonly supported: boolean;
  /** Which dispatcher class selects this mode (supported modes only). */
  readonly dispatcherClass?: ClaudeDispatcherClass;
  /** Who issues `confirm_dispatch_completion` in this mode (supported modes only). */
  readonly completionActor?: TrustedDispatchActor;
  /** How this mode holds the three ref-first properties (supported modes only). */
  readonly containment?: ClaudeContainmentProfile;
  readonly evidence: string;
}

const MODE_VERDICTS: readonly ClaudeDeliveryModeVerdict[] = Object.freeze([
  Object.freeze({
    mode: "native-subagent" as const,
    supported: true,
    dispatcherClass: "same-harness" as const,
    completionActor: "trusted-parent" as const,
    containment: Object.freeze({
      handleOnlyOutput: "prompt-best-effort" as const,
      worktreeConfinement: "prompt-best-effort" as const,
      resultStorage: "structural" as const,
    }),
    evidence:
      "decisions:K170 selects NATIVE for claude -> claude, and tasks:T722 §8.1a proved the " +
      "capability path by execution: a FOREGROUND `Agent` subagent declared with an inline " +
      "`mcpServers` entry holding the per-dispatch capability in that server's own `env` had " +
      "`mcp__…__store_result` in ITS tool set with `parent_tool_use_id` set, while the PARENT's " +
      '`init` reported `mcp=[]`, `tools=["Task"]`, `hasStoreTool=false`; `--strict-mcp-config` ' +
      "did NOT filter it out, and the child stored a 2,513-byte payload verified by an " +
      "independent read. What it CANNOT do is constrain or intercept the child's final message " +
      "(§5.3), which is why handleOnlyOutput is prompt-best-effort — a residual decisions:K170 " +
      "accepts explicitly.",
  }),
  Object.freeze({
    mode: "wrapper-shellout" as const,
    supported: true,
    dispatcherClass: "cross-harness" as const,
    completionActor: "trusted-extension" as const,
    containment: Object.freeze({
      handleOnlyOutput: "structural" as const,
      worktreeConfinement: "structural" as const,
      resultStorage: "structural" as const,
    }),
    evidence:
      "tasks:T722's CLAUDE-WRAPPER-SHELLOUT, measured end to end: trusted parent-side code " +
      "pre-assigns the child's run identity with `--session-id`, supplies a per-dispatch " +
      "`--mcp-config` whose server `env` holds the capability, reads the child's `stream-json` " +
      "itself, and prints only a handle. On a 45,833 B payload the child sent 43,672 B of store " +
      "arguments, its visible completion was 215 B and marker-free, wrapper stdout was 195 B, " +
      "and the marker was ABSENT from the entire 11,655 B orchestrator transcript — 44,353 B " +
      "reached the parent on ONE authorized fetch. Both containment properties are structural " +
      "here because the wrapper is a separate process: it sets the child's `cwd` and only its " +
      "own stdout crosses into a model turn.",
  }),
  Object.freeze({
    mode: "background-native-subagent" as const,
    supported: false,
    evidence:
      "The DEFAULT since Claude Code v2.1.198, and unusable for ref-first: tasks:T722 §4.1/§5.3 " +
      "observed that a background subagent's final text arrives as a harness-injected SYNTHETIC " +
      "USER MESSAGE derived from `task_notification.summary`, and that injection emits NO hook " +
      "event at all. So the parent does not receive the completion as the `tool_result` of the " +
      "launch it made, and no trusted non-model component can observe it either — leaving the " +
      "child's own text as the only thing tying a completion to a launch, which is exactly the " +
      "provenance tasks:T713 forbids. A native ref-first dispatch must therefore pass " +
      "`run_in_background: false` EXPLICITLY, against the harness default.",
  }),
  Object.freeze({
    mode: "inherited-mcp-tool" as const,
    supported: false,
    evidence:
      "Granting the child `store_result` via a `tools:` allowlist over the PARENT-INHERITED MCP " +
      "pool (tasks:T722 §8.1). The tool is then session-wide: the parent holds it too, so the " +
      "orchestrator could forge a submission and the capability is no longer per-dispatch. The " +
      "inline per-subagent `mcpServers` route (see `native-subagent`) is what replaces it, and " +
      "T722 measured the difference — `hasStoreTool=false` on the parent.",
  }),
  Object.freeze({
    mode: "raw-print-stdout" as const,
    supported: false,
    evidence:
      "Piping raw `claude -p` stdout into a parent model turn. The body is in `result.result`, so " +
      "this is structurally a body-returning parent surface — precisely what defects:D173 removed " +
      "from confirm after measuring a 45,833-byte payload come back on a 46,510-byte confirm " +
      "response. The wrapper mode exists so that a shellout child's stream is read by TRUSTED " +
      "CODE and never by a model turn.",
  }),
  Object.freeze({
    mode: "post-tool-use-rewrite" as const,
    supported: false,
    evidence:
      "Letting the child echo and rewriting its output with " +
      "`PostToolUse.hookSpecificOutput.updatedToolOutput`. tasks:T722 §5.2 control-proved the " +
      "field INERT in 2.1.220 on an ordinary `Bash` tool — so the inertness cannot be blamed on " +
      "the `Agent` tool — and it is documented, which is exactly why it must be refused by name " +
      "rather than assumed to work from the docs.",
  }),
  Object.freeze({
    mode: "setting-sources-isolated" as const,
    supported: false,
    evidence:
      "tasks:T722 verdict #7: `--setting-sources` must NOT be used to isolate a dispatched child " +
      "until its interaction with endpoint connection is understood, because the probe could not " +
      "establish that the per-dispatch endpoint still connects under it. Refused pending " +
      "measurement rather than adopted on plausibility; the consequence T722 recorded is that a " +
      "dispatched child currently inherits the operator's hooks.",
  }),
]);

/** Every mode's verdict, keyed by mode. A Map, so no prototype name resolves. */
export const CLAUDE_DELIVERY_MODES: ReadonlyMap<ClaudeDeliveryMode, ClaudeDeliveryModeVerdict> =
  new Map(MODE_VERDICTS.map((verdict) => [verdict.mode, verdict] as const));

/** The modes a launch path may name. */
export const SUPPORTED_CLAUDE_DELIVERY_MODES: readonly ClaudeDeliveryMode[] = Object.freeze(
  MODE_VERDICTS.filter((verdict) => verdict.supported).map((verdict) => verdict.mode),
);

/** The modes refused by name, each with its measured reason. */
export const UNSUPPORTED_CLAUDE_DELIVERY_MODES: readonly ClaudeDeliveryMode[] = Object.freeze(
  MODE_VERDICTS.filter((verdict) => !verdict.supported).map((verdict) => verdict.mode),
);

/**
 * The mode a CLAUDE parent uses for a CLAUDE child: the native `Agent` tool, no
 * shellout. decisions:K170's same-harness rule.
 */
export const CLAUDE_NATIVE_DELIVERY_MODE: ClaudeDeliveryMode = "native-subagent";

/**
 * The mode a CODEX or PI parent uses for a CLAUDE child: a trusted wrapper
 * shellout. decisions:K170's cross-harness rule.
 *
 * NOT a fallback for the native path. K170 chose native for same-harness with
 * the residual stated; silently shelling out when the native residual bites
 * would reverse a user decision, so no such fallback is defined.
 */
export const CLAUDE_CROSS_HARNESS_DELIVERY_MODE: ClaudeDeliveryMode = "wrapper-shellout";

/** Whether `mode` may be named on a launch path. */
export function isSupportedClaudeDeliveryMode(mode: string): mode is ClaudeDeliveryMode {
  const verdict = CLAUDE_DELIVERY_MODES.get(mode as ClaudeDeliveryMode);
  return verdict !== undefined && verdict.supported;
}

/**
 * Refuse an unsupported or unknown mode BEFORE a child exists. Returns the mode
 * so it can be used inline.
 */
export function assertSupportedClaudeDeliveryMode(mode: string): ClaudeDeliveryMode {
  const verdict = CLAUDE_DELIVERY_MODES.get(mode as ClaudeDeliveryMode);
  if (verdict === undefined) {
    throw new ClaudeUnsupportedModeError(
      String(mode),
      `unknown mode (expected one of ${[...CLAUDE_DELIVERY_MODE_IDS].join(", ")})`,
    );
  }
  if (!verdict.supported) {
    throw new ClaudeUnsupportedModeError(verdict.mode, verdict.evidence);
  }
  return verdict.mode;
}

/**
 * THE harness-axis selector (decisions:K170). A dispatcher's own harness decides
 * the transport; nothing else does.
 */
export function claudeDeliveryModeFor(dispatcherHarness: string): ClaudeDeliveryMode {
  return dispatcherHarness === "claude"
    ? CLAUDE_NATIVE_DELIVERY_MODE
    : CLAUDE_CROSS_HARNESS_DELIVERY_MODE;
}

/** Who issues the completion confirmation in a supported mode. */
export function claudeCompletionActor(mode: string): TrustedDispatchActor {
  const supported = assertSupportedClaudeDeliveryMode(mode);
  const actor = CLAUDE_DELIVERY_MODES.get(supported)?.completionActor;
  if (actor === undefined) {
    throw new AttestationContractError(
      "mode.completionActor",
      `supported mode "${supported}" declares no completion actor`,
    );
  }
  return actor;
}

/** How a supported mode holds the three ref-first properties. */
export const CLAUDE_CONTAINMENT_PROFILES: ReadonlyMap<
  ClaudeDeliveryMode,
  ClaudeContainmentProfile
> = new Map(
  MODE_VERDICTS.filter(
    (verdict): verdict is ClaudeDeliveryModeVerdict & { containment: ClaudeContainmentProfile } =>
      verdict.containment !== undefined,
  ).map((verdict) => [verdict.mode, verdict.containment] as const),
);

/** The containment profile of a supported mode. */
export function claudeContainmentProfile(mode: string): ClaudeContainmentProfile {
  const supported = assertSupportedClaudeDeliveryMode(mode);
  const profile = CLAUDE_CONTAINMENT_PROFILES.get(supported);
  if (profile === undefined) {
    throw new AttestationContractError(
      "mode.containment",
      `supported mode "${supported}" declares no containment profile`,
    );
  }
  return profile;
}

/**
 * The residuals decisions:K170 accepted, named so that "best-effort" is a
 * readable value rather than an omission, and so a later reversal has something
 * concrete to delete.
 *
 * Each entry is a `<mode>.<property>` coordinate into
 * {@link CLAUDE_CONTAINMENT_PROFILES} whose strength is `prompt-best-effort`.
 * The set is EXACTLY the best-effort coordinates — checked, not asserted — so a
 * new best-effort property cannot be introduced without either accepting it here
 * or failing the guard.
 */
export const CLAUDE_ACCEPTED_RESIDUALS = Object.freeze([
  "native-subagent.handleOnlyOutput",
  "native-subagent.worktreeConfinement",
] as const);

/**
 * The user's affirmation of those residuals, quoted rather than paraphrased so
 * that a reader can see this is a decision and not an oversight.
 * decisions:K170, 2026-07-28.
 */
export const CLAUDE_RESIDUAL_ACCEPTANCE_QUOTE = "on Q366, the tradeoff is acceptable" as const;

/**
 * The single upstream change that would let the native path become
 * `structural` on `handleOnlyOutput`. tasks:T722 §9 recorded it as the flip
 * condition; it is kept machine-readable so T688/T689 can re-test on a bump
 * instead of rediscovering the boundary.
 */
export const CLAUDE_NATIVE_ENFORCEMENT_GAP = Object.freeze({
  missing: "per-subagent-output-schema",
  probedVersion: "2.1.220",
  evidence:
    "`--json-schema` is a TOP-LEVEL print-mode flag (min-version 2.1.205) and cannot be scoped " +
    "to a subagent; the subagent frontmatter field table — description, tools, disallowedTools, " +
    "model, permissionMode, maxTurns, skills, mcpServers, hooks, memory, background, effort, " +
    "isolation, color, initialPrompt — contains NO output-schema field (tasks:T722 §8.1b, " +
    'grepped for `json-schema` / `outputSchema` / "structured output").',
  flipCondition:
    "If Claude Code adds a per-subagent output schema, re-test tasks:T722 §5.3: " +
    "`native-subagent.handleOnlyOutput` becomes structural and this residual disappears.",
});

// ---------------------------------------------------------------------------
// 2. Parent-minted child correlation
// ---------------------------------------------------------------------------

/** Entropy drawn for a launch nonce. Same width as an attestation id. */
export const CLAUDE_CORRELATION_ENTROPY_BYTES = ATTESTATION_ID_ENTROPY_BYTES;

/** Separates the role identity from the parent-minted nonce inside a childId. */
export const CLAUDE_CORRELATION_SEPARATOR = "#" as const;

const LAUNCH_NONCE_RE = /^[A-Za-z0-9_-]{32,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

/**
 * The identity of the child a Claude parent is about to launch, fixed BEFORE
 * prepare so prepare can bind it.
 *
 * `roleId` is the dispatched role — natively the `Agent` tool's
 * `subagent_type`, on the wrapper path the `--agents` entry name — so an unknown
 * role must be refused HERE, before a child exists. `launchNonce` is
 * PARENT-MINTED and carried into the launch, so two children of the same role in
 * the same session are distinguishable and a replayed child cannot present a
 * matching identity. `sessionId` is the run identity bound as `runId`, and its
 * PROVENANCE differs by mode — see {@link claudeCorrelationProvenance}.
 */
export interface ClaudeChildCorrelation {
  readonly roleId: string;
  readonly launchNonce: string;
  /**
   * On {@link CLAUDE_CROSS_HARNESS_DELIVERY_MODE} the child's session id,
   * PRE-ASSIGNED by the wrapper via `--session-id` and echoed back by the
   * terminal event. On {@link CLAUDE_NATIVE_DELIVERY_MODE} the DISPATCHING
   * PARENT's own session id, because a native `Agent` child's session cannot be
   * pre-assigned.
   */
  readonly sessionId: string;
}

/** Mint the parent-side launch nonce. */
export function mintClaudeLaunchNonce(randomBytes: DispatchRandomBytes): string {
  const bytes = randomBytes(CLAUDE_CORRELATION_ENTROPY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== CLAUDE_CORRELATION_ENTROPY_BYTES) {
    throw new AttestationContractError(
      "launchNonce",
      `expected ${CLAUDE_CORRELATION_ENTROPY_BYTES} bytes of entropy`,
    );
  }
  const nonce = base64url(bytes);
  if (!LAUNCH_NONCE_RE.test(nonce)) {
    throw new AttestationContractError("launchNonce", `minted a malformed nonce "${nonce}"`);
  }
  return nonce;
}

const DISPATCHED_ROLE_ID_SET: ReadonlySet<string> = new Set(DISPATCHED_ROLE_IDS);

/**
 * Validate a correlation. An unknown `roleId` is refused HERE, before a child
 * exists, so a dispatch whose role selection could fall through to a default is
 * impossible to construct.
 *
 * `sessionId` must be a UUID, and that is a real constraint rather than
 * tidiness: `claude --session-id` accepts only a UUID, so a non-UUID identity
 * CANNOT be pre-assigned on the wrapper path. Accepting one would let the native
 * path bind an identity shape the wrapper path could never produce, and the two
 * modes would stop being checkable against each other.
 */
export function assertClaudeChildCorrelation(
  correlation: ClaudeChildCorrelation,
  path = "expectedChild",
): ClaudeChildCorrelation {
  const roleId: unknown = correlation?.roleId;
  // Set membership, never `in` / property access: the value can arrive from a
  // stored row or an untyped boundary, so "constructor" must not resolve.
  if (typeof roleId !== "string" || !DISPATCHED_ROLE_ID_SET.has(roleId)) {
    throw new AttestationContractError(
      `${path}.roleId`,
      `expected a dispatched role id, got "${String(roleId)}"`,
    );
  }
  const launchNonce: unknown = correlation.launchNonce;
  if (typeof launchNonce !== "string" || !LAUNCH_NONCE_RE.test(launchNonce)) {
    throw new AttestationContractError(
      `${path}.launchNonce`,
      `expected a parent-minted nonce of at least 32 base64url characters, got "${String(launchNonce)}"`,
    );
  }
  const sessionId: unknown = correlation.sessionId;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    throw new AttestationContractError(
      `${path}.sessionId`,
      `expected a lowercase UUID session id (the only shape \`--session-id\` accepts), got "${String(sessionId)}"`,
    );
  }
  return Object.freeze({ roleId, launchNonce, sessionId });
}

/**
 * How strongly the transport attests {@link ClaudeChildCorrelation.sessionId}.
 *
 * This is the one place the two supported modes are genuinely unequal on
 * IDENTITY, and averaging them would be dishonest:
 *
 * - `transport-attested` (wrapper): the parent pre-assigns the child's session
 *   with `--session-id` and the child's terminal event ECHOES it. tasks:T722
 *   §6.3 ran the decisive negative control — with the flag dropped the child
 *   minted its own identity, stored successfully, and was STILL refused. Storing
 *   is not completing.
 * - `parent-constructed` (native): the `Agent` tool has no session parameter, so
 *   no child-side identity can be pre-assigned. The binding is instead that the
 *   parent knows which `Agent` call it made, in its own session, in-process. The
 *   child never supplies identity at all, and the capability it holds was minted
 *   for exactly one launch and delivered over a per-subagent, non-inherited
 *   channel — so a replayed or wrong-role child can neither store nor be
 *   confirmed. What `parent-constructed` does NOT prove is that the harness
 *   routed the `Agent` call to the declared `subagent_type`; that is a
 *   harness-integrity assumption, named here rather than hidden.
 */
export const CLAUDE_CORRELATION_PROVENANCES = ["transport-attested", "parent-constructed"] as const;

export type ClaudeCorrelationProvenance = (typeof CLAUDE_CORRELATION_PROVENANCES)[number];

export function claudeCorrelationProvenance(mode: string): ClaudeCorrelationProvenance {
  return assertSupportedClaudeDeliveryMode(mode) === CLAUDE_CROSS_HARNESS_DELIVERY_MODE
    ? "transport-attested"
    : "parent-constructed";
}

/**
 * Project a correlation onto the shared {@link NativeChildIdentity} that
 * `prepare_dispatch` binds and `confirm_dispatch_completion` checks.
 *
 * The role identity is folded INTO `childId` deliberately, exactly as on the
 * Codex surface: the shared service compares `childId`/`runId` for equality, so
 * binding the role there makes "a child of a different role completed" a binding
 * failure AT THE STORE, not merely a check this module happens to perform.
 */
export function claudeExpectedChild(correlation: ClaudeChildCorrelation): NativeChildIdentity {
  const resolved = assertClaudeChildCorrelation(correlation);
  return Object.freeze({
    childId: `${resolved.roleId}${CLAUDE_CORRELATION_SEPARATOR}${resolved.launchNonce}`,
    runId: resolved.sessionId,
  });
}

// ---------------------------------------------------------------------------
// 3. The launch gate: budget, remaining child window, and clock skew
// ---------------------------------------------------------------------------

/**
 * Why a launch was refused.
 *
 * There is deliberately NO `child-window-lapsed` entry, for a reason that is
 * arithmetic rather than preference: `prepare_dispatch` is the sole producer of
 * {@link DispatchDeadlines} and computes `childCancelAt = prepared + timeoutMs`
 * against `launchDeadline = prepared + LAUNCH_DEADLINE_MS`, while rejecting any
 * `timeoutMs` below `DISPATCH_TIMEOUT_MIN_MS` — and
 * `DISPATCH_TIMEOUT_MIN_MS === LAUNCH_DEADLINE_MS`. So
 * `childCancelAt >= launchDeadline` for every dispatch the system can
 * construct, and the cancel window can only lapse via `launch-budget-lapsed`.
 * A refusal no input can produce is exactly the defects:D186 class of dead
 * declaration, so it is not declared.
 */
export const CLAUDE_LAUNCH_REFUSALS = [
  "launch-budget-lapsed",
  "response-window-lapsed",
  "clock-skew",
] as const;

export type ClaudeLaunchRefusal = (typeof CLAUDE_LAUNCH_REFUSALS)[number];

export interface ClaudeLaunchApproved {
  readonly launch: true;
  /**
   * The CONSERVATIVE window handed to the child: the time remaining until
   * `responseStoreNow`, not until `childCancelAt`. A child told to work until
   * `childCancelAt` has no budget left in which to store.
   */
  readonly childWindowMs: number;
  /** The full remaining window before the parent must treat the child as lapsed. */
  readonly cancelWindowMs: number;
}

export interface ClaudeLaunchRefused {
  readonly launch: false;
  readonly refusal: ClaudeLaunchRefusal;
  /** The abort the parent must write instead of launching. */
  readonly abortReason: DispatchAbortReason;
  readonly detail: string;
}

export type ClaudeLaunchVerdict = ClaudeLaunchApproved | ClaudeLaunchRefused;

/**
 * Decide whether to launch, and for how long, from the AUTHORITATIVE deadlines
 * `prepare_dispatch` established.
 *
 * ## The skew rule, which is the point of this function
 *
 * `at` MUST come from the same injected clock the attestation service uses. The
 * child's clock never appears: the parent hands the child a DURATION
 * ({@link ClaudeLaunchApproved.childWindowMs}), never an absolute instant, so a
 * child whose clock is offset still stops at the right time, and every lifecycle
 * decision is taken by the service clock alone. An `at` that PRECEDES the
 * prepare instant means the caller is reading a different clock from the one
 * that prepared; that is refused as `clock-skew` rather than silently granting a
 * larger window than prepare authorised.
 *
 * The prepare instant is recovered exactly, not estimated:
 * `launchDeadline - LAUNCH_DEADLINE_MS` is how `prepare_dispatch` computed it.
 *
 * ## Why this is duplicated from the Codex surface, and how the duplication is
 * kept HONEST
 *
 * This gate reads nothing Claude-specific — it is a pure function of
 * {@link DispatchDeadlines} and one instant — so `codexLaunchGate` and this are
 * necessarily the same function, and a DIVERGENCE between them would be a
 * defects:D188-class cross-surface split. Consolidating the two into the shared
 * module is deferred to {@link CLAUDE_DISPATCH_DEFERRED} rather than done here,
 * because T687 must not edit tasks:T690's just-landed file. Until then the
 * duplication is held equivalent by a DIFFERENTIAL GUARD in this module's suite
 * that runs both gates over one witness matrix and requires identical verdicts —
 * so a future edit to either surface alone turns the suite red instead of
 * quietly creating a third divergence.
 *
 * One Claude-specific note that does NOT change the arithmetic: on the native
 * path there is no subprocess to kill, so `childCancelAt` is the instant the
 * parent stops WAITING, not an instant at which anything is terminated. The
 * lifecycle is unaffected — a lapsed child's late `store_result` is refused
 * `deadline-exceeded` by the service — but a caller must not read
 * `cancelWindowMs` as a kill deadline on that path.
 */
export function claudeLaunchGate(deadlines: DispatchDeadlines, at: string): ClaudeLaunchVerdict {
  const atMs = attestationInstantMs(at, "at");
  const launchMs = attestationInstantMs(deadlines.launchDeadline, "deadlines.launchDeadline");
  const storeMs = attestationInstantMs(deadlines.responseStoreNow, "deadlines.responseStoreNow");
  const cancelMs = attestationInstantMs(deadlines.childCancelAt, "deadlines.childCancelAt");
  const preparedMs = launchMs - LAUNCH_DEADLINE_MS;

  if (atMs < preparedMs) {
    return Object.freeze({
      launch: false as const,
      refusal: "clock-skew" as const,
      abortReason: "protocol-violation" as const,
      detail:
        `launch instant ${at} precedes the prepare instant ${new Date(preparedMs).toISOString()}; ` +
        "the launch gate must be evaluated on the clock that prepared the dispatch",
    });
  }
  if (atMs >= launchMs) {
    return Object.freeze({
      launch: false as const,
      refusal: "launch-budget-lapsed" as const,
      abortReason: "deadline-exceeded" as const,
      detail: `launchDeadline ${deadlines.launchDeadline} has passed at ${at}`,
    });
  }
  if (atMs >= storeMs) {
    return Object.freeze({
      launch: false as const,
      refusal: "response-window-lapsed" as const,
      abortReason: "deadline-exceeded" as const,
      detail:
        `responseStoreNow ${deadlines.responseStoreNow} has passed at ${at}; the remaining window ` +
        "cannot accommodate a store_result submission",
    });
  }
  return Object.freeze({
    launch: true as const,
    childWindowMs: storeMs - atMs,
    cancelWindowMs: cancelMs - atMs,
  });
}

// ---------------------------------------------------------------------------
// 4. The parent-side handle-only check (defects:D175)
// ---------------------------------------------------------------------------

/** The classification of a child's final message. */
export const CLAUDE_FINAL_MESSAGE_VERDICTS = [
  "handle-only",
  "echo",
  "wrong-handle",
  "unparseable",
] as const;

export type ClaudeFinalMessageVerdictKind = (typeof CLAUDE_FINAL_MESSAGE_VERDICTS)[number];

export type ClaudeFinalMessageVerdict =
  | { readonly verdict: "handle-only"; readonly handle: DispatchHandle }
  | { readonly verdict: "echo"; readonly extraKeys: readonly string[] }
  | { readonly verdict: "wrong-handle"; readonly claimed: DispatchHandle }
  | { readonly verdict: "unparseable"; readonly detail: string };

const HANDLE_KEYS: readonly string[] = Object.freeze(["attestationId", "generation"]);
const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;
/** The wrapper's own handle envelope, observed in tasks:T722 §6.2's transcript. */
const DISPATCH_TAG_RE = /^<dispatch>([\s\S]*?)<\/dispatch>$/;

/**
 * Classify a child's final message against the handle it was supposed to
 * return, and NOTHING else.
 *
 * ## Why this lives on the parent side, and what it is worth per mode
 *
 * defects:D175: echo is undetectable by the store BY CONSTRUCTION —
 * `store_result` sees a valid submission and has no visibility into what the
 * child additionally said in its own reply. This is that check for Claude. It is
 * a PURE function of the message text: it performs no store read, so it cannot
 * be satisfied by a child that stored correctly and then echoed.
 *
 * Its VALUE differs by mode, and that difference is the honest core of this
 * module:
 *
 * - On {@link CLAUDE_CROSS_HARNESS_DELIVERY_MODE} the check is defence in depth.
 *   `--json-schema` with `additionalProperties:false` already makes an echo
 *   structurally impossible in the validated output (tasks:T722 §7.1 #2: 215 B,
 *   marker absent), and the wrapper reads the stream itself, so a non-compliant
 *   reply is caught BEFORE anything crosses into a model turn.
 * - On {@link CLAUDE_NATIVE_DELIVERY_MODE} the check is a DETECTOR ONLY. There
 *   is no schema to enforce and no interception point, so by the time this
 *   function can classify the message, that message has already reached the
 *   parent's context. The abort it triggers keeps the LIFECYCLE sound — no echoed
 *   body is ever promoted to `consumed` — but it does not achieve containment.
 *   That is {@link CLAUDE_ACCEPTED_RESIDUALS}, and decisions:K170 accepted it.
 *
 * Three envelopes are unwrapped before parsing, because all three were OBSERVED
 * carrying a conformant handle in tasks:T722: bare JSON, a ```json fence, and
 * the wrapper's `<dispatch>…</dispatch>` tag. Unwrapping is deliberately NOT
 * generous beyond that: anything else is `unparseable`, and a body with prose
 * around a handle stays a violation.
 */
export function classifyClaudeFinalMessage(
  message: string,
  expected: DispatchHandle,
): ClaudeFinalMessageVerdict {
  if (typeof message !== "string") {
    return Object.freeze({
      verdict: "unparseable" as const,
      detail: `expected a final message string, got "${String(message)}"`,
    });
  }
  const trimmed = message.trim();
  const tagged = DISPATCH_TAG_RE.exec(trimmed);
  const untagged = (tagged === null ? trimmed : tagged[1]!).trim();
  const fenced = FENCE_RE.exec(untagged);
  const body = (fenced === null ? untagged : fenced[1]!).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    return Object.freeze({
      verdict: "unparseable" as const,
      detail: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Object.freeze({
      verdict: "unparseable" as const,
      detail: "expected a JSON object carrying exactly the dispatch handle",
    });
  }
  const keys = Object.keys(parsed);
  const extraKeys = keys.filter((key) => !HANDLE_KEYS.includes(key)).sort();
  if (extraKeys.length > 0) {
    // Any surplus key IS the echo: a handle-only reply has nowhere to put a
    // summary, an output body, a schema, or a prompt.
    return Object.freeze({ verdict: "echo" as const, extraKeys: Object.freeze(extraKeys) });
  }
  const record = parsed as Record<string, unknown>;
  const attestationId: unknown = record["attestationId"];
  const generation: unknown = record["generation"];
  if (typeof attestationId !== "string" || !Number.isInteger(generation)) {
    return Object.freeze({
      verdict: "unparseable" as const,
      detail: "expected a string attestationId and an integer generation",
    });
  }
  const claimed: DispatchHandle = Object.freeze({
    attestationId,
    generation: generation as number,
  });
  if (
    claimed.attestationId !== expected.attestationId ||
    claimed.generation !== expected.generation
  ) {
    return Object.freeze({ verdict: "wrong-handle" as const, claimed });
  }
  return Object.freeze({ verdict: "handle-only" as const, handle: claimed });
}

// ---------------------------------------------------------------------------
// 5. The completion decision (defects:D179 — exit status corroborates only)
// ---------------------------------------------------------------------------

/**
 * The terminal event the transport reported for the child's turn.
 *
 * `subtype` is carried and DELIBERATELY NOT DECISIVE. tasks:T722 §7.1 #4
 * measured a bogus-model run returning `{"type":"result","subtype":"success",
 * "is_error":true,…,"terminal_reason":"api_error"}` with exit code 1 — so a
 * bridge keying success on `subtype` alone would treat an API-error turn as a
 * successful dispatch. It is kept on the interface so that ignoring it is
 * visible and testable rather than achieved by omission.
 */
export interface ClaudeTerminalSignal {
  /** Carried for the record. NEVER read by {@link claudeTerminalOutcome}. */
  readonly subtype: string;
  readonly isError: boolean;
  readonly terminalReason: string;
  /**
   * Present only on {@link CLAUDE_CROSS_HARNESS_DELIVERY_MODE} — the native path
   * has no subprocess. CORROBORATING evidence only (defects:D179).
   */
  readonly exitStatus?: number;
}

/** The terminal reason that means the child's turn ran to completion. */
export const CLAUDE_COMPLETED_TERMINAL_REASON = "completed" as const;

/**
 * Judge a terminal signal. `is_error` and `terminal_reason` decide; `subtype`
 * and `exitStatus` do not.
 *
 * ## This DELIBERATELY NARROWS tasks:T722's measured wrapper predicate
 *
 * T722's probe wrapper used `exit==0 && subtype=="success" && is_error!==true &&
 * terminal_reason=="completed"`. Two of those four terms are dropped here, each
 * for a stated reason:
 *
 * - `exit==0` is dropped because defects:D179 / hypothesis:H177 measured a
 *   sibling extension's teardown race making a child process exit NON-ZERO
 *   AFTER a correct reply was already written. Keeping exit in the success
 *   predicate would let that race destroy a valid dispatch. The exit status is
 *   recorded as corroboration instead — see {@link claudeExitCorroboration}.
 * - `subtype=="success"` is dropped because T722's own measurement shows
 *   `subtype` is `"success"` on an API error, so the term is not merely
 *   redundant, it is misleading.
 *
 * What remains is the pair T722 proved discriminating. The narrowing is recorded
 * because it is a real change to a measured artifact, not a restatement of it.
 */
export function claudeTerminalOutcome(signal: ClaudeTerminalSignal): "completed" | "failed" {
  const isError: unknown = signal?.isError;
  if (typeof isError !== "boolean") {
    throw new AttestationContractError(
      "observation.terminal.isError",
      `expected a boolean is_error, got "${String(isError)}"`,
    );
  }
  const terminalReason: unknown = signal.terminalReason;
  if (typeof terminalReason !== "string" || terminalReason.trim() === "") {
    throw new AttestationContractError(
      "observation.terminal.terminalReason",
      `expected a non-empty terminal_reason, got "${String(terminalReason)}"`,
    );
  }
  const subtype: unknown = signal.subtype;
  if (typeof subtype !== "string") {
    throw new AttestationContractError(
      "observation.terminal.subtype",
      `expected a string subtype, got "${String(subtype)}"`,
    );
  }
  const exitStatus: unknown = signal.exitStatus;
  if (exitStatus !== undefined && !Number.isInteger(exitStatus)) {
    throw new AttestationContractError(
      "observation.terminal.exitStatus",
      `expected an integer exit status or none, got "${String(exitStatus)}"`,
    );
  }
  return !isError && terminalReason === CLAUDE_COMPLETED_TERMINAL_REASON ? "completed" : "failed";
}

/** The derived child outcome vocabulary. Closed and total. */
export const CLAUDE_CHILD_OUTCOMES = ["completed", "cancelled", "transport-failed"] as const;

export type ClaudeChildOutcome = (typeof CLAUDE_CHILD_OUTCOMES)[number];

/** How much weight a process exit status carries. Never decisive. */
export const CLAUDE_EXIT_CORROBORATIONS = ["corroborates", "contradicts", "unavailable"] as const;

export type ClaudeExitCorroboration = (typeof CLAUDE_EXIT_CORROBORATIONS)[number];

/**
 * What the parent OBSERVED about one child, read off the TRANSPORT.
 *
 * `source` is a literal, not a boolean, so a `"child-reported"` value cannot
 * type-check and is refused at runtime too. tasks:T713's constraint, verbatim:
 * "do not assume opaque ids prove provenance". `roleId`, `launchNonce` and
 * `sessionId` must come from the launch the parent made — the `Agent` call
 * (native) or the pre-assigned `--session-id` echoed by the terminal event
 * (wrapper) — NEVER from the child's own message, which the child controls.
 *
 * There is deliberately no caller-supplied `outcome` field. The outcome is
 * DERIVED ({@link claudeChildOutcome}) from `cancelled` plus the re-judged
 * terminal signal, so a caller cannot launder an API-error turn into a success
 * by asserting one.
 */
export interface ClaudeCompletionObservation {
  readonly source: "transport";
  readonly mode: ClaudeDeliveryMode;
  readonly roleId: string;
  readonly launchNonce: string;
  readonly sessionId: string;
  /** Whether the PARENT cancelled this dispatch. Outranks the terminal signal. */
  readonly cancelled: boolean;
  readonly terminal: ClaudeTerminalSignal;
  /** The child's last message. Checked for handle-only shape, never trusted for identity. */
  readonly finalMessage: string;
  readonly observedAt: string;
}

export interface ClaudeConfirmDecision {
  readonly action: "confirm";
  readonly nativeCompletion: NativeCompletionProof;
  /**
   * Whether the observed exit status agrees with the confirmation. Recorded, and
   * deliberately NOT a precondition (defects:D179).
   */
  readonly exitStatusCorroborates: ClaudeExitCorroboration;
  /**
   * How strongly the bound `sessionId` was attested on this mode. Recorded on
   * every confirmation so a consumer can tell a transport-attested promotion
   * from a parent-constructed one without re-deriving the mode.
   */
  readonly correlationProvenance: ClaudeCorrelationProvenance;
  /**
   * Whether handle-only output was ENFORCED on this mode or merely detected.
   * `prompt-best-effort` means: this reply happened to be conformant, and a
   * non-conformant one would have been caught only after reaching context.
   */
  readonly handleOnlyEnforcement: ClaudeEnforcementStrength;
}

export interface ClaudeAbortDecision {
  readonly action: "abort";
  readonly reason: DispatchAbortReason;
  readonly details: DispatchJSONValue;
}

export type ClaudeCompletionDecision = ClaudeConfirmDecision | ClaudeAbortDecision;

function assertObservation(observation: ClaudeCompletionObservation): ClaudeCompletionObservation {
  if (observation?.source !== "transport") {
    throw new ClaudeObservationProvenanceError(
      "source",
      `expected "transport", got "${String(observation?.source)}" — correlation read from a ` +
        "child-controlled message cannot prove which child completed",
    );
  }
  const cancelled: unknown = observation.cancelled;
  if (typeof cancelled !== "boolean") {
    throw new AttestationContractError(
      "observation.cancelled",
      `expected a boolean cancellation flag, got "${String(cancelled)}"`,
    );
  }
  attestationInstantMs(observation.observedAt, "observation.observedAt");
  return observation;
}

/**
 * Derive the child outcome. Cancellation is a parent-observed fact about the RUN
 * and outranks whatever the turn reported, because a cancelled dispatch is not a
 * verdict on the payload.
 */
export function claudeChildOutcome(observation: ClaudeCompletionObservation): ClaudeChildOutcome {
  const checked = assertObservation(observation);
  if (checked.cancelled) return "cancelled";
  return claudeTerminalOutcome(checked.terminal) === "completed" ? "completed" : "transport-failed";
}

/** The correlation fields on which the observation disagrees with the expectation. */
function correlationMismatches(
  expected: ClaudeChildCorrelation,
  observation: ClaudeCompletionObservation,
): readonly string[] {
  const fields: string[] = [];
  if (observation.roleId !== expected.roleId) fields.push("roleId");
  if (observation.launchNonce !== expected.launchNonce) fields.push("launchNonce");
  if (observation.sessionId !== expected.sessionId) fields.push("sessionId");
  return Object.freeze(fields);
}

export interface ClaudeCompletionRequest {
  /** The handle the child was told to return, and nothing more. */
  readonly handle: DispatchHandle;
  readonly expectedChild: ClaudeChildCorrelation;
  readonly observation: ClaudeCompletionObservation;
}

/**
 * Decide, from Claude-specific evidence ALONE, whether the parent may confirm.
 *
 * This function never reads the store, and that is deliberate: it must not be
 * able to turn "nothing was stored" into a success, and it must not be able to
 * turn a stored result into a failure. `missing-result` therefore stays where it
 * belongs — `confirm_dispatch_completion` aborts it when the record is still
 * `prepared` — which is defects:D179's rule expressed structurally: PROMOTION
 * KEYS ON WHETHER A VALID STRUCTURED RESULT WAS CAPTURED AND STORED, and the
 * transport's opinion (including a process exit status) only corroborates.
 *
 * Rule order, and why:
 *  1. An unsupported mode THROWS. It is an authoring defect and must never
 *     become an abort reason that reads like a child failure.
 *  2. A non-transport observation THROWS, for the same reason.
 *  3. `cancelled` aborts `cancelled` — even when a result was already stored,
 *     because abort WINS in the shared lifecycle.
 *  4. A failed terminal signal aborts `native-failure`.
 *  5. A correlation mismatch aborts `native-failure`: what completed is not what
 *     this parent launched. Classified as a NATIVE failure rather than a
 *     protocol violation because the child may have behaved perfectly — the
 *     transport delivered the wrong child.
 *  6. A final message that is not handle-only aborts `protocol-violation`, with
 *     the verdict in `details`. This is the defects:D175 check.
 *  7. Only then: confirm, recording the exit status as corroboration and the two
 *     per-mode strengths so a caller can see what the promotion actually rests on.
 */
export function decideClaudeCompletion(request: ClaudeCompletionRequest): ClaudeCompletionDecision {
  const observation = assertObservation(request.observation);
  const mode = assertSupportedClaudeDeliveryMode(observation.mode);
  const expected = assertClaudeChildCorrelation(request.expectedChild);
  const outcome = claudeChildOutcome(observation);

  if (outcome === "cancelled") {
    return Object.freeze({
      action: "abort" as const,
      reason: "cancelled" as const,
      details: Object.freeze({
        mode,
        observedAt: observation.observedAt,
        roleId: observation.roleId,
      }),
    });
  }
  if (outcome === "transport-failed") {
    return Object.freeze({
      action: "abort" as const,
      reason: "native-failure" as const,
      details: Object.freeze({
        mode,
        observedAt: observation.observedAt,
        // Both recorded, so a reader can see that `subtype` said success while
        // the authoritative pair said otherwise (tasks:T722 §7.1 #4).
        subtype: observation.terminal.subtype,
        isError: observation.terminal.isError,
        terminalReason: observation.terminal.terminalReason,
      }),
    });
  }

  const mismatched = correlationMismatches(expected, observation);
  if (mismatched.length > 0) {
    return Object.freeze({
      action: "abort" as const,
      reason: "native-failure" as const,
      details: Object.freeze({
        mode,
        mismatchedFields: mismatched,
        provenance: claudeCorrelationProvenance(mode),
        expected: Object.freeze({ ...expected }),
        observed: Object.freeze({
          roleId: observation.roleId,
          launchNonce: observation.launchNonce,
          sessionId: observation.sessionId,
        }),
      }),
    });
  }

  const message = classifyClaudeFinalMessage(observation.finalMessage, request.handle);
  if (message.verdict !== "handle-only") {
    return Object.freeze({
      action: "abort" as const,
      reason: "protocol-violation" as const,
      details: Object.freeze({
        mode,
        finalMessageVerdict: message.verdict,
        // On the native path the body is ALREADY in parent context by now, so
        // record that the abort is a lifecycle remedy and not containment.
        containedBeforeParentContext:
          claudeContainmentProfile(mode).handleOnlyOutput === "structural",
        ...(message.verdict === "echo" ? { extraKeys: message.extraKeys } : {}),
        ...(message.verdict === "wrong-handle"
          ? { claimed: Object.freeze({ ...message.claimed }) }
          : {}),
        ...(message.verdict === "unparseable" ? { detail: message.detail } : {}),
      }),
    });
  }

  const child = claudeExpectedChild(expected);
  return Object.freeze({
    action: "confirm" as const,
    nativeCompletion: Object.freeze({
      kind: "native-completion" as const,
      actor: claudeCompletionActor(mode),
      childId: child.childId,
      runId: child.runId,
      completedAt: observation.observedAt,
    }),
    exitStatusCorroborates: claudeExitCorroboration(observation.terminal.exitStatus),
    correlationProvenance: claudeCorrelationProvenance(mode),
    handleOnlyEnforcement: claudeContainmentProfile(mode).handleOnlyOutput,
  });
}

/**
 * Classify an observed exit status. `unavailable` is the honest answer for the
 * native mode, which has no subprocess and therefore no exit status at all —
 * distinguishing it from `corroborates` matters, because "we saw a clean exit"
 * and "there was nothing to see" are different pieces of evidence.
 */
export function claudeExitCorroboration(exitStatus: number | undefined): ClaudeExitCorroboration {
  if (exitStatus === undefined) return "unavailable";
  return exitStatus === 0 ? "corroborates" : "contradicts";
}

// ---------------------------------------------------------------------------
// 6. Reconciling decisions:K170 with questions:Q363 — worktree placement
// ---------------------------------------------------------------------------

/**
 * How a child is placed in the worktree the orchestrator prepared.
 *
 * ## The tension, stated before the resolution
 *
 * BOTH of these are locked and neither is re-opened here:
 *
 * - **questions:Q363 (user-answered)** chose option (iii): every surface gets a
 *   MANUALLY prepared worktree via one MCP method `worktree_manage(prepare|
 *   release)` over UUID-named fresh trees. That eliminates defects:D119
 *   STRUCTURALLY rather than detecting it — "a tree created fresh from a known
 *   base cannot have a stale base" — and Q363 named Claude as "the ONLY surface
 *   where the harness allocates-or-reuses the tree".
 * - **decisions:K170 (user decision)** requires claude → claude dispatch to be
 *   NATIVE, no shellout.
 *
 * They collide on a HARD CONSTRAINT that Q363 itself recorded: the `Agent` tool
 * accepts `subagent_type`, `prompt`, `model`, `isolation`, `run_in_background`
 * and **there is no path parameter**. The per-subagent frontmatter surface adds
 * `isolation` but likewise no path (tasks:T722 §8.1b enumerates the whole field
 * table). So native same-harness dispatch cannot be HANDED a prepared tree.
 * Q363 wrote that a prepare method "only pays off once dispatch stops using
 * native isolation" — and K170 then made native dispatch mandatory for the
 * same-harness case. T687 owns the reconciliation.
 *
 * ## The resolution, and why it is DERIVED rather than preferred
 *
 * {@link CLAUDE_WORKTREE_RECONCILIATION} records the chosen composition and the
 * cost of each rejected one. The choice is forced, not aesthetic: the
 * implement-worker input contract already makes `worktreePath` a REQUIRED
 * property, and `prepare_dispatch` validates `input` against that contract
 * BEFORE it allocates anything. So any composition in which the orchestrator
 * does not hold a path at prepare time cannot be prepared at all — it is
 * rejected as an invalid launch envelope. That is a machine-checkable
 * derivation, and this module's suite checks it.
 */
export const CLAUDE_WORKTREE_PLACEMENTS = ["wrapper-cwd", "input-path-absolute"] as const;

export type ClaudeWorktreePlacement = (typeof CLAUDE_WORKTREE_PLACEMENTS)[number];

/**
 * How each supported mode places its child in the prepared tree. The two modes
 * differ HERE, and the difference is exactly why one confinement is structural
 * and the other is not.
 */
export const CLAUDE_MODE_WORKTREE_PLACEMENTS: ReadonlyMap<
  ClaudeDeliveryMode,
  ClaudeWorktreePlacement
> = new Map([
  // The wrapper is a separate PROCESS: it spawns `claude -p` with the prepared
  // tree as that process's `cwd`. Confinement is structural because the child's
  // whole process is rooted there.
  [CLAUDE_CROSS_HARNESS_DELIVERY_MODE, "wrapper-cwd" as const],
  // A native child shares the PARENT's process and cwd, and the `Agent` tool has
  // no path parameter, so the prepared path can only arrive as input data.
  [CLAUDE_NATIVE_DELIVERY_MODE, "input-path-absolute" as const],
]);

/** Where a supported mode places its child. */
export function claudeWorktreePlacement(mode: string): ClaudeWorktreePlacement {
  const supported = assertSupportedClaudeDeliveryMode(mode);
  const placement = CLAUDE_MODE_WORKTREE_PLACEMENTS.get(supported);
  if (placement === undefined) {
    throw new AttestationContractError(
      "mode.worktreePlacement",
      `supported mode "${supported}" declares no worktree placement`,
    );
  }
  return placement;
}

/**
 * The input property through which a prepared worktree reaches a child. Already
 * REQUIRED by the implement-worker input contract, which is what makes the
 * chosen composition the only preparable one.
 */
export const CLAUDE_WORKTREE_INPUT_PROPERTY = "worktreePath" as const;

/**
 * The `isolation` argument a NATIVE ref-first dispatch must pass.
 *
 * Passing `"worktree"` would make the harness allocate-or-reuse its OWN tree at
 * whatever commit it was left — defects:D119's root cause, and exactly the
 * behaviour questions:Q363 abolished. So the one worktree-related argument the
 * `Agent` tool DOES accept must be set to keep the harness out of the way, and
 * the prepared path is carried in the input instead.
 */
export const CLAUDE_NATIVE_ISOLATION_ARGUMENT = "none" as const;

/**
 * The `run_in_background` argument a NATIVE ref-first dispatch must pass, against
 * the harness default. See the `background-native-subagent` verdict: a
 * background completion arrives as a synthetic user message with no hook event,
 * leaving no transport-supplied field to correlate on.
 */
export const CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT = false;

/**
 * Why a NATIVE child must address the prepared path ABSOLUTELY rather than
 * entering it once with `cd`.
 *
 * A dispatched agent's shell working directory is RESET BETWEEN TOOL CALLS —
 * tasks:T722 §6.2 caught the harness saying so in the measured orchestrator
 * transcript, whose tool_result ends with `Shell cwd was reset to /tmp/t722/ws`.
 * The reset target is the PROCESS's cwd, and that is precisely where the two
 * modes part company:
 *
 * - `wrapper-cwd`: the process cwd IS the prepared tree, so every reset returns
 *   the child TO the tree. The placement survives the reset for free.
 * - `input-path-absolute`: the process cwd is the PARENT's, which is not the
 *   prepared tree, so every reset takes the child OUT of it. A one-time
 *   `cd <worktreePath>` therefore stops holding after the child's first tool
 *   call, and confinement must be expressed as absolute paths instead.
 *
 * This is the mechanism behind the best-effort rating; it is not an extra
 * caution on top of it.
 */
export const CLAUDE_WORKTREE_ADDRESSING = "absolute-paths" as const;

/**
 * The reconciliation, with the cost of every option — including the chosen one.
 *
 * Recorded as data rather than prose so a reviewer can check that the rejected
 * options were actually priced, and so a later reversal has a specific entry to
 * argue with.
 */
export const CLAUDE_WORKTREE_RECONCILIATION = Object.freeze({
  chosen: "orchestrator-prepares-and-passes-path-as-input",
  chosenCost:
    "Native confinement becomes PROMPT-BEST-EFFORT: nothing stops a native child writing outside " +
    "the prepared tree, because it runs in the parent's process with no path-scoped sandbox. This " +
    "is the SAME residual class decisions:K170 already accepted for handle-only output, on the " +
    "same axis (native dispatch has no harness enforcement point) — it introduces no NEW kind of " +
    "exposure. The compensator is detection after the fact, which already exists: T894/T895 made " +
    "`resultCommitVerified` and `gateReRan` REQUIRED on an implement-reviewer result, and " +
    "merge-back verifies the worker's `resultCommit`, so a stray write is caught at review rather " +
    "than prevented at dispatch. Additionally the child must address the tree by ABSOLUTE PATH " +
    "(see CLAUDE_WORKTREE_ADDRESSING) — a `cd` does not survive a tool call.",
  rejected: Object.freeze([
    Object.freeze({
      option: "child-calls-worktree_manage(prepare)-as-its-first-act",
      cost:
        "NOT PREPARABLE, so this is refused on a structural ground rather than a preference. " +
        "`worktreePath` is a REQUIRED property of the implement-worker input contract and " +
        "`prepare_dispatch` validates the input against that contract BEFORE allocating, so an " +
        "orchestrator with no path yet cannot prepare the dispatch at all — it gets an " +
        "invalid-launch-envelope rejection. Making it work would require editing tasks:T894's " +
        "just-landed sidecar. It also inverts ownership: the CHILD would choose its own base, " +
        "which is precisely the pre-dispatch base guarantee questions:Q363 exists to provide, and " +
        "it would hand a MUTATING tool to a child whose capability set is otherwise minimal.",
    }),
    Object.freeze({
      option: "restrict-native-dispatch-to-roles-needing-no-worktree",
      cost:
        "Makes decisions:K170 VACUOUS on this surface. implement-worker and " +
        "implement-conflict-resolver are exactly the roles that need a tree, and they are the " +
        "roles same-harness dispatch is for — so claude -> claude native would never run for the " +
        "case it was chosen for. That is a silent reversal of a user decision dressed as a scope " +
        "restriction.",
    }),
    Object.freeze({
      option: "relax-the-prepared-worktree-requirement-for-native-dispatch",
      cost:
        "Reinstates defects:D119. Without a prepared tree the harness allocates-or-REUSES one at " +
        "whatever commit it was left, which is the stale-base failure questions:Q363 eliminated " +
        "by construction and the class behind the 2026-07-28 incident. Trading a locked defect " +
        "fix for convenience is strictly worse than accepting a best-effort confinement.",
    }),
  ]),
  /**
   * The one place the two locked decisions AGREE, which is why the composition
   * works at all: Q363's `prepare` returns a PATH, and a path is data. Data can
   * travel through the dispatch input, which is the one channel the `Agent` tool
   * does have. What cannot travel is ENFORCEMENT.
   */
  loadBearingAgreement:
    "worktree_manage(prepare) returns a path, and a path is transportable input",
});

/**
 * questions:Q363's resume-by-handle requirement, carried forward so it is not
 * lost between definition and implementation: `prepare` is fresh by default and
 * resumes by OPTIONAL HANDLE when a prior round exists, because
 * `implement/advance.md` §4 mandates same-worktree re-dispatch so a worker sees
 * its prior round's commits. Always-fresh would DISCARD them.
 *
 * On this surface that has a specific consequence: the resumed path arrives
 * through the SAME input property as a fresh one
 * ({@link CLAUDE_WORKTREE_INPUT_PROPERTY}), so a criticism-round re-dispatch is
 * indistinguishable from a first round as far as this protocol is concerned. The
 * round's identity lives in the dispatch input and the idempotency key, not in
 * the placement mechanism.
 */
export const CLAUDE_WORKTREE_RESUME_IS_BY_HANDLE = true;

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/**
 * The shared fetch reading this definition binds to.
 */
export const CLAUDE_FETCH_SEMANTICS_ASSUMED = "one-shot-materialization" as const;

/** The task that implements this protocol against a live Claude child. */
export const CLAUDE_DISPATCH_DEFERRED_TO = "T688" as const;

/** The task that proves the implementation end to end. */
export const CLAUDE_DISPATCH_PROVEN_BY = "T689" as const;

/**
 * What this DEFINITION task deliberately does not do, recorded so none of it is
 * silently assumed done.
 */
export const CLAUDE_DISPATCH_DEFERRED = Object.freeze([
  "launch-a-real-native-subagent-with-an-inline-per-subagent-store-endpoint",
  "spawn-and-intercept-a-real-wrapper-shellout-child",
  "implement-worktree_manage-prepare-and-release",
  "consolidate-the-duplicated-launch-gate-into-the-shared-module",
  "migrate-the-claude-dispatch-fragment-to-the-new-call-shape",
] as const);
