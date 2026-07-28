/**
 * T690 — the CODEX-surface binding of the compact dispatch protocol:
 * `prepare_dispatch → child store_result → confirm_dispatch_completion →
 * fetch_dispatch_result`.
 *
 * The lifecycle itself is surface-agnostic and already lives in
 * {@link ./dispatchAttestation} (T685/T686/T720). NOTHING here re-implements it.
 * What Codex needs, and what no other surface needs, is the answer to three
 * questions the shared service deliberately does not answer:
 *
 *  1. **WHICH Codex child-delivery mode can carry a role prompt to a child
 *     without materialising it in the parent's context, and which modes cannot?**
 *     Answered by {@link CODEX_DELIVERY_MODES} — a classification whose every
 *     entry cites a MEASUREMENT (researches:RS10, researches:RS11, tasks:T713,
 *     defects:D178), not a reading of upstream documentation.
 *  2. **WHAT counts as proof that the exact child the parent launched is the one
 *     that completed?** Answered by {@link CodexChildCorrelation} plus
 *     {@link decideCodexCompletion}. Codex hands the parent opaque ids, and
 *     tasks:T713 recorded the rule this module enforces: an opaque id does not
 *     prove provenance. Correlation is therefore PARENT-MINTED before prepare
 *     and read back off the TRANSPORT, never off the child's own message.
 *  3. **WHEN may the parent promote `result-stored → consumed`?** Answered by
 *     {@link decideCodexCompletion}: on a captured, stored, handle-only reply.
 *     A process exit status only CORROBORATES (defects:D179 / hypothesis:H177 —
 *     a sibling extension's teardown race makes a child exit non-zero AFTER a
 *     correct reply, so a non-zero exit must not be authoritative).
 *
 * ## Scope boundary, stated explicitly (defects:D186's lesson)
 *
 * This module DEFINES the protocol and is inert: it renders no asset, spawns no
 * child, and changes no deployed instruction. It deliberately does NOT edit
 * `nix/lib/codex-command-skills.nix`, because defects:D178's remediation is a
 * PAIR (see {@link CODEX_ROLE_DELIVERY_PREREQUISITES}) and researches:RS11
 * measured that shipping the first half alone leaves every child un-roled:
 * suppressing the reference advertisement removes the leak AND removes the only
 * mechanism by which a child currently (accidentally) obtains its role. The pair
 * lands together in tasks:T691, which owns spawn wiring and asset generation.
 * {@link CODEX_ROLE_DELIVERY_PREREQUISITES_ARE_ATOMIC} exists so that claim is
 * machine-checkable rather than a comment.
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
 * A Codex delivery mode that cannot satisfy tasks:T713's handle-only /
 * correlation contract was named on a launch path.
 *
 * This is an AUTHORING defect, not a lifecycle outcome: an unsupported mode must
 * be refused before a child exists, so it can never become an abort reason and
 * can never be mistaken for a child failure.
 */
export class CodexUnsupportedModeError extends Error {
  readonly mode: string;
  readonly evidence: string;

  constructor(mode: string, evidence: string) {
    super(`Codex delivery mode "${mode}" cannot satisfy the ref-first contract: ${evidence}`);
    this.name = "CodexUnsupportedModeError";
    this.mode = mode;
    this.evidence = evidence;
  }
}

/**
 * An observation was presented whose provenance is not the native transport.
 *
 * Separate from {@link CodexUnsupportedModeError} because it is the one failure
 * that a MALICIOUS or merely confused child could otherwise cause: a bridge that
 * accepted child-reported correlation would let any child claim to be any other.
 */
export class CodexObservationProvenanceError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Codex completion observation ${field}: ${detail}`);
    this.name = "CodexObservationProvenanceError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// 1. Delivery-mode classification
// ---------------------------------------------------------------------------

/**
 * Every Codex mechanism that has been PROPOSED or OBSERVED as a way to get a
 * dispatched role's prompt to a Codex child. Exactly two are supported; the rest
 * are enumerated so an unsupported one is refused by name rather than silently
 * attempted (tasks:T690's "Codex modes unable to satisfy T713's handle-only /
 * correlation contract are explicitly unsupported").
 */
export const CODEX_DELIVERY_MODE_IDS = [
  "native-agent",
  "exec-intercepted",
  "skill-reference",
  "project-agents-dir",
  "agents-config-file",
  "profile-selected",
  "no-tools-exec",
  "raw-exec-stdout",
] as const;

export type CodexDeliveryMode = (typeof CODEX_DELIVERY_MODE_IDS)[number];

/**
 * One mode's verdict. `evidence` is the measurement or upstream defect that
 * DECIDED the verdict — every entry below is traceable to a live run or to an
 * open upstream issue, never to an inference from documentation.
 */
export interface CodexDeliveryModeVerdict {
  readonly mode: CodexDeliveryMode;
  readonly supported: boolean;
  /** Who issues `confirm_dispatch_completion` in this mode (supported modes only). */
  readonly completionActor?: TrustedDispatchActor;
  readonly evidence: string;
}

const MODE_VERDICTS: readonly CodexDeliveryModeVerdict[] = Object.freeze([
  Object.freeze({
    mode: "native-agent" as const,
    supported: true,
    completionActor: "trusted-parent" as const,
    evidence:
      "researches:RS11 ARM 3-real, N=3 against the REAL 43,567 B closure: a standalone GLOBAL " +
      "$CODEX_HOME/agents/<name>.toml carrying name/description/developer_instructions, dispatched " +
      "as spawn_agent({agent_type}), gave ROLEBODY 0/3 in the parent stream AND the parent rollout, " +
      "CHILDSAW 3/3 with the body arriving as the child's first `role: developer` message and ZERO " +
      "child tool calls (so delivery is genuine, not self-service), agent_type advertised 3/3 vs " +
      "0/6 elsewhere, the parent shown only the one-line `description`, and input_tokens 124-164K " +
      "against the 183-259K baseline.",
  }),
  Object.freeze({
    mode: "exec-intercepted" as const,
    supported: true,
    completionActor: "trusted-extension" as const,
    evidence:
      "The fallback: a `codex exec --json` child spawned by trusted parent-side code that INTERCEPTS " +
      "the stream, so no child output reaches a parent model turn. Admissible only WITH the " +
      "interceptor: tasks:T713 recorded that `item.completed` carries bodies inline and no flag " +
      "suppresses them, which is why the un-intercepted variant (`raw-exec-stdout`) is refused.",
  }),
  Object.freeze({
    mode: "skill-reference" as const,
    supported: false,
    evidence:
      "defects:D178, root cause CORRECTED by researches:RS10 and confirmed at real scale by " +
      "researches:RS11: advertising a role name -> path mapping in the generated SKILL.md's " +
      "`## Workflow references` block makes the PARENT batch-read the role file before it dispatches " +
      "anything (ROLEBODY 1,1,1 in the control). Measured 0 of 110,553 B kept out of parent context " +
      "against ~111 KB on claude and pi. The leak is caused by ADVERTISING the path, not by any " +
      "imperative to read it, and it pulls in EVERY advertised role body rather than only the " +
      "dispatched one (RS11's EXPBODY 1,1,1).",
  }),
  Object.freeze({
    mode: "project-agents-dir" as const,
    supported: false,
    evidence:
      "A project-scoped `.codex/agents/` declaration is ADVERTISED but UNSPAWNABLE on codex-cli " +
      "0.145.0 — openai/codex#26408, still OPEN. researches:RS10 and RS11 therefore both used the " +
      "GLOBAL $CODEX_HOME/agents/ dir; see `native-agent`.",
  }),
  Object.freeze({
    mode: "agents-config-file" as const,
    supported: false,
    evidence:
      "`agents.<name>.config_file` is not the mechanism: the `[agents]` table is GLOBAL-SETTINGS " +
      "only (researches:RS10), so it cannot carry a per-role developer_instructions body.",
  }),
  Object.freeze({
    mode: "profile-selected" as const,
    supported: false,
    evidence:
      "tasks:T713 verdicted role selection by `codex exec --profile <name>` NATIVE-SELECTABLE but " +
      "FAIL-OPEN: an UNKNOWN profile name is SILENTLY IGNORED — no error, no warning, the run " +
      "proceeds on the base config — and `--strict-config` does not close it. A dispatch whose role " +
      "selection can silently fall through to a default role cannot correlate a child to a role.",
  }),
  Object.freeze({
    mode: "no-tools-exec" as const,
    supported: false,
    evidence:
      "tasks:T713: `--no-tools` is INCOMPATIBLE with a ref-first Codex child, which must be able to " +
      "call store_result. A child with no tools cannot submit a result, so the only reply it can " +
      "give is the body itself — the echo this protocol exists to prevent.",
  }),
  Object.freeze({
    mode: "raw-exec-stdout" as const,
    supported: false,
    evidence:
      "tasks:T713: never pipe raw `codex exec` stdout into a parent model turn — `item.completed` " +
      "carries bodies inline and no flag suppresses them. Structurally equivalent to a body-returning " +
      "parent surface, which is exactly what defects:D173 removed from confirm.",
  }),
]);

/** Every mode's verdict, keyed by mode. A Map, so no prototype name resolves. */
export const CODEX_DELIVERY_MODES: ReadonlyMap<CodexDeliveryMode, CodexDeliveryModeVerdict> =
  new Map(MODE_VERDICTS.map((verdict) => [verdict.mode, verdict] as const));

/** The modes a launch path may name. */
export const SUPPORTED_CODEX_DELIVERY_MODES: readonly CodexDeliveryMode[] = Object.freeze(
  MODE_VERDICTS.filter((verdict) => verdict.supported).map((verdict) => verdict.mode),
);

/** The modes refused by name, each with its measured or upstream reason. */
export const UNSUPPORTED_CODEX_DELIVERY_MODES: readonly CodexDeliveryMode[] = Object.freeze(
  MODE_VERDICTS.filter((verdict) => !verdict.supported).map((verdict) => verdict.mode),
);

/**
 * The mode used when the parent runs INSIDE a Codex session and dispatches with
 * the native collaboration transport. This is the primary mode; it is the one
 * researches:RS11 measured at ROLEBODY 0 / CHILDSAW 3/3.
 */
export const CODEX_NATIVE_DELIVERY_MODE: CodexDeliveryMode = "native-agent";

/**
 * The mode used when a trusted non-model process spawns the child out of session
 * and intercepts its stream. The FALLBACK: it keeps the contract but costs a
 * subprocess and gives the parent no `agent_type` advertisement.
 */
export const CODEX_FALLBACK_DELIVERY_MODE: CodexDeliveryMode = "exec-intercepted";

/** Whether `mode` may be named on a launch path. */
export function isSupportedCodexDeliveryMode(mode: string): mode is CodexDeliveryMode {
  const verdict = CODEX_DELIVERY_MODES.get(mode as CodexDeliveryMode);
  return verdict !== undefined && verdict.supported;
}

/**
 * Refuse an unsupported or unknown mode BEFORE a child exists. Returns the mode
 * so it can be used inline.
 */
export function assertSupportedCodexDeliveryMode(mode: string): CodexDeliveryMode {
  const verdict = CODEX_DELIVERY_MODES.get(mode as CodexDeliveryMode);
  if (verdict === undefined) {
    throw new CodexUnsupportedModeError(
      String(mode),
      `unknown mode (expected one of ${[...CODEX_DELIVERY_MODE_IDS].join(", ")})`,
    );
  }
  if (!verdict.supported) {
    throw new CodexUnsupportedModeError(verdict.mode, verdict.evidence);
  }
  return verdict.mode;
}

/** Who issues the completion confirmation in a supported mode. */
export function codexCompletionActor(mode: string): TrustedDispatchActor {
  const supported = assertSupportedCodexDeliveryMode(mode);
  const actor = CODEX_DELIVERY_MODES.get(supported)?.completionActor;
  if (actor === undefined) {
    throw new AttestationContractError(
      "mode.completionActor",
      `supported mode "${supported}" declares no completion actor`,
    );
  }
  return actor;
}

// ---------------------------------------------------------------------------
// 2. Parent-minted child correlation
// ---------------------------------------------------------------------------

/**
 * The two-part remediation defects:D178 requires, in the order it must be
 * applied. Both entries land in ONE change; see
 * {@link CODEX_ROLE_DELIVERY_PREREQUISITES_ARE_ATOMIC}.
 */
export const CODEX_ROLE_DELIVERY_PREREQUISITES = Object.freeze([
  "suppress-dispatched-role-reference-lines",
  "declare-dispatched-roles-as-global-native-agents",
] as const);

/**
 * The pair above is INSEPARABLE, and this is the measured reason rather than a
 * style preference: researches:RS11 recommendation #1 — "Never ship (a) alone —
 * it removes the leak and leaves children un-roled". RS11 also measured what
 * un-roled costs at real scale: in the 4 non-compliant runs the uninstructed
 * child read the skill index, executed the 43.5 KB ORCHESTRATOR workflow, and
 * then FAILED trying to spawn its own subagent.
 */
export const CODEX_ROLE_DELIVERY_PREREQUISITES_ARE_ATOMIC = true;

/** The task that applies both prerequisites and wires spawn. */
export const CODEX_ROLE_DELIVERY_MIGRATION_OWNER = "T691" as const;

/** The GLOBAL agents directory the native mode requires, relative to `$CODEX_HOME`. */
export const CODEX_GLOBAL_AGENTS_DIR = "agents" as const;

/** The keys a native agent declaration must carry (researches:RS11 ARM 3-real). */
export const CODEX_NATIVE_AGENT_DECLARATION_KEYS = Object.freeze([
  "name",
  "description",
  "developer_instructions",
] as const);

/** Entropy drawn for a correlation nonce. Same width as an attestation id. */
export const CODEX_CORRELATION_ENTROPY_BYTES = ATTESTATION_ID_ENTROPY_BYTES;

/** Separates the role identity from the parent-minted nonce inside a childId. */
export const CODEX_CORRELATION_SEPARATOR = "#" as const;

const CORRELATION_ID_RE = /^[A-Za-z0-9_-]{32,}$/;
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
 * The identity of the child a Codex parent is about to launch, fixed BEFORE
 * prepare so prepare can bind it.
 *
 * `agentType` is the dispatched role id — on the native transport it is
 * literally `spawn_agent({agent_type})`, which is why an unknown role must be
 * refused here (it is also what closes tasks:T713's FAIL-OPEN `--profile`
 * selection: this module never lets an unknown role name fall through to a
 * default). `correlationId` is a PARENT-MINTED nonce carried into the launch, so
 * two children of the same role in the same thread are distinguishable and a
 * replayed child cannot present a matching identity. `threadId` is the parent's
 * own Codex thread / rollout id.
 */
export interface CodexChildCorrelation {
  readonly agentType: string;
  readonly correlationId: string;
  readonly threadId: string;
}

/** Mint the parent-side correlation nonce. */
export function mintCodexCorrelationId(randomBytes: DispatchRandomBytes): string {
  const bytes = randomBytes(CODEX_CORRELATION_ENTROPY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== CODEX_CORRELATION_ENTROPY_BYTES) {
    throw new AttestationContractError(
      "correlationId",
      `expected ${CODEX_CORRELATION_ENTROPY_BYTES} bytes of entropy`,
    );
  }
  const id = base64url(bytes);
  if (!CORRELATION_ID_RE.test(id)) {
    throw new AttestationContractError("correlationId", `minted a malformed nonce "${id}"`);
  }
  return id;
}

const DISPATCHED_ROLE_ID_SET: ReadonlySet<string> = new Set(DISPATCHED_ROLE_IDS);

/**
 * Validate a correlation. An unknown `agentType` is refused HERE, before a
 * child exists — the structural answer to tasks:T713's fail-open selection.
 */
export function assertCodexChildCorrelation(
  correlation: CodexChildCorrelation,
  path = "expectedChild",
): CodexChildCorrelation {
  const agentType: unknown = correlation?.agentType;
  // Set membership, never `in` / property access: the value can arrive from a
  // stored row or an untyped boundary, so "constructor" must not resolve.
  if (typeof agentType !== "string" || !DISPATCHED_ROLE_ID_SET.has(agentType)) {
    throw new AttestationContractError(
      `${path}.agentType`,
      `expected a dispatched role id, got "${String(agentType)}"`,
    );
  }
  const correlationId: unknown = correlation.correlationId;
  if (typeof correlationId !== "string" || !CORRELATION_ID_RE.test(correlationId)) {
    throw new AttestationContractError(
      `${path}.correlationId`,
      `expected a parent-minted nonce of at least 32 base64url characters, got "${String(correlationId)}"`,
    );
  }
  const threadId: unknown = correlation.threadId;
  if (typeof threadId !== "string" || threadId.trim() === "") {
    throw new AttestationContractError(
      `${path}.threadId`,
      "expected a non-empty Codex thread id",
    );
  }
  return Object.freeze({ agentType, correlationId, threadId });
}

/**
 * Project a correlation onto the shared {@link NativeChildIdentity} that
 * `prepare_dispatch` binds and `confirm_dispatch_completion` checks.
 *
 * The role identity is folded INTO `childId` deliberately: the shared service
 * compares `childId`/`runId` for equality, so binding the role there makes
 * "a child of a different role completed" a binding failure at the store, not
 * merely a check this module happens to perform.
 */
export function codexExpectedChild(correlation: CodexChildCorrelation): NativeChildIdentity {
  const resolved = assertCodexChildCorrelation(correlation);
  return Object.freeze({
    childId: `${resolved.agentType}${CODEX_CORRELATION_SEPARATOR}${resolved.correlationId}`,
    runId: resolved.threadId,
  });
}

// ---------------------------------------------------------------------------
// 3. The launch gate: budget, remaining child window, and clock skew
// ---------------------------------------------------------------------------

/** Why a launch was refused. */
export const CODEX_LAUNCH_REFUSALS = [
  "launch-budget-lapsed",
  "response-window-lapsed",
  "child-window-lapsed",
  "clock-skew",
] as const;

export type CodexLaunchRefusal = (typeof CODEX_LAUNCH_REFUSALS)[number];

export interface CodexLaunchApproved {
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

export interface CodexLaunchRefused {
  readonly launch: false;
  readonly refusal: CodexLaunchRefusal;
  /** The abort the parent must write instead of launching. */
  readonly abortReason: DispatchAbortReason;
  readonly detail: string;
}

export type CodexLaunchVerdict = CodexLaunchApproved | CodexLaunchRefused;

/**
 * Decide whether to launch, and for how long, from the AUTHORITATIVE deadlines
 * `prepare_dispatch` established.
 *
 * ## The skew rule, which is the point of this function
 *
 * `at` MUST come from the same injected clock the attestation service uses. The
 * child's clock never appears: the parent hands the child a DURATION
 * ({@link CodexLaunchApproved.childWindowMs}), never an absolute instant, so a
 * child whose clock is offset still stops at the right time, and every lifecycle
 * decision (deadline-exceeded, retention, sweep) is taken by the service clock
 * alone. An `at` that PRECEDES the prepare instant means the caller is reading a
 * different clock from the one that prepared; that is refused as `clock-skew`
 * rather than silently granting a larger window than prepare authorised.
 *
 * The prepare instant is recovered exactly, not estimated:
 * `launchDeadline - LAUNCH_DEADLINE_MS` is how `prepare_dispatch` computed it.
 */
export function codexLaunchGate(deadlines: DispatchDeadlines, at: string): CodexLaunchVerdict {
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
  if (atMs >= cancelMs) {
    return Object.freeze({
      launch: false as const,
      refusal: "child-window-lapsed" as const,
      abortReason: "deadline-exceeded" as const,
      detail: `childCancelAt ${deadlines.childCancelAt} has passed at ${at}`,
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
export const CODEX_FINAL_MESSAGE_VERDICTS = [
  "handle-only",
  "echo",
  "wrong-handle",
  "unparseable",
] as const;

export type CodexFinalMessageVerdictKind = (typeof CODEX_FINAL_MESSAGE_VERDICTS)[number];

export type CodexFinalMessageVerdict =
  | { readonly verdict: "handle-only"; readonly handle: DispatchHandle }
  | { readonly verdict: "echo"; readonly extraKeys: readonly string[] }
  | { readonly verdict: "wrong-handle"; readonly claimed: DispatchHandle }
  | { readonly verdict: "unparseable"; readonly detail: string };

const HANDLE_KEYS: readonly string[] = Object.freeze(["attestationId", "generation"]);
const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

/**
 * Classify a child's final message against the handle it was supposed to
 * return, and NOTHING else.
 *
 * ## Why this lives on the parent side
 *
 * defects:D175 (found by the tasks:T713 probe): echo is undetectable by the
 * store BY CONSTRUCTION — `store_result` sees a valid submission and has no
 * visibility into what the child additionally said in its own reply — and no
 * parent-side handle-only check existed on any surface. This is that check for
 * Codex. It is a PURE function of the message text: it performs no store read,
 * so it cannot be satisfied by a child that stored correctly and then echoed.
 */
export function classifyCodexFinalMessage(
  message: string,
  expected: DispatchHandle,
): CodexFinalMessageVerdict {
  if (typeof message !== "string") {
    return Object.freeze({
      verdict: "unparseable" as const,
      detail: `expected a final message string, got "${String(message)}"`,
    });
  }
  const trimmed = message.trim();
  const fenced = FENCE_RE.exec(trimmed);
  const body = (fenced === null ? trimmed : fenced[1]!).trim();
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

/** What the native transport reported about the child's own termination. */
export const CODEX_CHILD_OUTCOMES = ["completed", "cancelled", "transport-failed"] as const;

export type CodexChildOutcome = (typeof CODEX_CHILD_OUTCOMES)[number];

/** How much weight a process exit status carries. Never decisive. */
export const CODEX_EXIT_CORROBORATIONS = ["corroborates", "contradicts", "unavailable"] as const;

export type CodexExitCorroboration = (typeof CODEX_EXIT_CORROBORATIONS)[number];

/**
 * What the parent OBSERVED about one child, read off the TRANSPORT.
 *
 * `source` is a literal, not a boolean, so a `"child-reported"` value cannot
 * type-check and is refused at runtime too. tasks:T713's constraint, verbatim:
 * "do not assume opaque ids prove provenance". `agentType`, `correlationId` and
 * `threadId` must come from the `spawn_agent` call the parent made (native
 * mode) or from the subprocess the interceptor spawned (fallback mode) — NEVER
 * from the child's own message, which the child controls.
 */
export interface CodexCompletionObservation {
  readonly source: "transport";
  readonly mode: CodexDeliveryMode;
  readonly agentType: string;
  readonly correlationId: string;
  readonly threadId: string;
  readonly outcome: CodexChildOutcome;
  /** The child's last message. Checked for handle-only shape, never trusted for identity. */
  readonly finalMessage: string;
  readonly observedAt: string;
  /** Present only in `exec-intercepted`. CORROBORATING evidence only (defects:D179). */
  readonly exitStatus?: number;
}

export interface CodexConfirmDecision {
  readonly action: "confirm";
  readonly nativeCompletion: NativeCompletionProof;
  /**
   * Whether the observed exit status agrees with the confirmation. Recorded, and
   * deliberately NOT a precondition: defects:D179 / hypothesis:H177 measured a
   * sibling extension's teardown race making the child process exit non-zero
   * AFTER a correct reply was already written, so a non-zero exit with a stored
   * result still consumes.
   */
  readonly exitStatusCorroborates: CodexExitCorroboration;
}

export interface CodexAbortDecision {
  readonly action: "abort";
  readonly reason: DispatchAbortReason;
  readonly details: DispatchJSONValue;
}

export type CodexCompletionDecision = CodexConfirmDecision | CodexAbortDecision;

const CHILD_OUTCOME_SET: ReadonlySet<string> = new Set(CODEX_CHILD_OUTCOMES);

function assertObservation(observation: CodexCompletionObservation): CodexCompletionObservation {
  if (observation?.source !== "transport") {
    throw new CodexObservationProvenanceError(
      "source",
      `expected "transport", got "${String(observation?.source)}" — correlation read from a ` +
        "child-controlled message cannot prove which child completed",
    );
  }
  const outcome: unknown = observation.outcome;
  if (typeof outcome !== "string" || !CHILD_OUTCOME_SET.has(outcome)) {
    throw new AttestationContractError(
      "observation.outcome",
      `unknown child outcome "${String(outcome)}"`,
    );
  }
  attestationInstantMs(observation.observedAt, "observation.observedAt");
  const exitStatus: unknown = observation.exitStatus;
  if (exitStatus !== undefined && !Number.isInteger(exitStatus)) {
    throw new AttestationContractError(
      "observation.exitStatus",
      `expected an integer exit status or none, got "${String(exitStatus)}"`,
    );
  }
  return observation;
}

/** The correlation fields on which the observation disagrees with the expectation. */
function correlationMismatches(
  expected: CodexChildCorrelation,
  observation: CodexCompletionObservation,
): readonly string[] {
  const fields: string[] = [];
  if (observation.agentType !== expected.agentType) fields.push("agentType");
  if (observation.correlationId !== expected.correlationId) fields.push("correlationId");
  if (observation.threadId !== expected.threadId) fields.push("threadId");
  return Object.freeze(fields);
}

export interface CodexCompletionRequest {
  /** The handle the child was told to return, and nothing more. */
  readonly handle: DispatchHandle;
  readonly expectedChild: CodexChildCorrelation;
  readonly observation: CodexCompletionObservation;
}

/**
 * Decide, from Codex-specific evidence ALONE, whether the parent may confirm.
 *
 * This function never reads the store, and that is deliberate: it must not be
 * able to turn "nothing was stored" into a success, and it must not be able to
 * turn a stored result into a failure. `missing-result` therefore stays where it
 * belongs — `confirm_dispatch_completion` aborts it when the record is still
 * `prepared` — which is exactly defects:D179's rule expressed structurally:
 * PROMOTION KEYS ON WHETHER A VALID STRUCTURED RESULT WAS CAPTURED AND STORED,
 * and the transport's opinion (including a process exit status) only corroborates.
 *
 * Rule order, and why:
 *  1. An unsupported mode THROWS. It is an authoring defect and must never
 *     become an abort reason that reads like a child failure.
 *  2. A non-transport observation THROWS, for the same reason.
 *  3. `cancelled` aborts `cancelled` — and it does so even when a result was
 *     already stored, because abort WINS in the shared lifecycle. A cancellation
 *     is a parent-observed fact about the run, not a verdict on the payload.
 *  4. `transport-failed` aborts `native-failure`.
 *  5. A correlation mismatch aborts `native-failure`: what completed is not what
 *     this parent launched. It is classified as a NATIVE failure rather than a
 *     protocol violation because the child may have behaved perfectly — the
 *     transport delivered the wrong child.
 *  6. A final message that is not handle-only aborts `protocol-violation`, with
 *     the verdict in `details`. This is the defects:D175 check.
 *  7. Only then: confirm, recording the exit status as corroboration.
 */
export function decideCodexCompletion(request: CodexCompletionRequest): CodexCompletionDecision {
  const observation = assertObservation(request.observation);
  const mode = assertSupportedCodexDeliveryMode(observation.mode);
  const expected = assertCodexChildCorrelation(request.expectedChild);

  if (observation.outcome === "cancelled") {
    return Object.freeze({
      action: "abort" as const,
      reason: "cancelled" as const,
      details: Object.freeze({
        mode,
        observedAt: observation.observedAt,
        agentType: observation.agentType,
      }),
    });
  }
  if (observation.outcome === "transport-failed") {
    return Object.freeze({
      action: "abort" as const,
      reason: "native-failure" as const,
      details: Object.freeze({
        mode,
        observedAt: observation.observedAt,
        transport: "the Codex collaboration transport reported a failed child",
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
        expected: Object.freeze({ ...expected }),
        observed: Object.freeze({
          agentType: observation.agentType,
          correlationId: observation.correlationId,
          threadId: observation.threadId,
        }),
      }),
    });
  }

  const message = classifyCodexFinalMessage(observation.finalMessage, request.handle);
  if (message.verdict !== "handle-only") {
    return Object.freeze({
      action: "abort" as const,
      reason: "protocol-violation" as const,
      details: Object.freeze({
        mode,
        finalMessageVerdict: message.verdict,
        ...(message.verdict === "echo" ? { extraKeys: message.extraKeys } : {}),
        ...(message.verdict === "wrong-handle"
          ? { claimed: Object.freeze({ ...message.claimed }) }
          : {}),
        ...(message.verdict === "unparseable" ? { detail: message.detail } : {}),
      }),
    });
  }

  const child = codexExpectedChild(expected);
  return Object.freeze({
    action: "confirm" as const,
    nativeCompletion: Object.freeze({
      kind: "native-completion" as const,
      actor: codexCompletionActor(mode),
      childId: child.childId,
      runId: child.runId,
      completedAt: observation.observedAt,
    }),
    exitStatusCorroborates: codexExitCorroboration(observation.exitStatus),
  });
}

/**
 * Classify an observed exit status. `unavailable` is the honest answer for the
 * native mode, which has no subprocess and therefore no exit status at all —
 * distinguishing it from `corroborates` matters, because "we saw a clean exit"
 * and "there was nothing to see" are different pieces of evidence.
 */
export function codexExitCorroboration(exitStatus: number | undefined): CodexExitCorroboration {
  if (exitStatus === undefined) return "unavailable";
  return exitStatus === 0 ? "corroborates" : "contradicts";
}

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/** The task that implements this protocol against a live Codex child. */
export const CODEX_DISPATCH_DEFERRED_TO = CODEX_ROLE_DELIVERY_MIGRATION_OWNER;

/**
 * What this DEFINITION task deliberately does not do, recorded so none of it is
 * silently assumed done. Every entry lands in
 * {@link CODEX_DISPATCH_DEFERRED_TO}.
 */
export const CODEX_DISPATCH_DEFERRED = Object.freeze([
  "suppress-the-dispatched-role-reference-lines-in-the-generated-skill",
  "generate-the-global-native-agent-declarations",
  "spawn-and-intercept-a-real-codex-child",
  "migrate-the-codex-dispatch-fragment-to-the-new-call-shape",
  "frontier-model-read-batching-remeasurement",
] as const);
