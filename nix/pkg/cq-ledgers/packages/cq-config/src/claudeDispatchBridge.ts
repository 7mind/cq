/**
 * T688 — the EXECUTABLE Claude-surface bridge for the ref-first dispatch
 * protocol tasks:T687 defined.
 *
 * T687's {@link ./claudeDispatchProtocol} is inert by design: it classifies,
 * correlates, gates and decides, but it launches nothing and drives no
 * lifecycle. This module is the part that RUNS — it composes T687's decisions
 * with the REAL shared service in {@link ./dispatchAttestation}
 * (`prepareDispatch` / `storeDispatchResult` / `confirmDispatchCompletion` /
 * `abortDispatch` / `fetchDispatchResult`) and re-implements NONE of it.
 *
 * ## What "compact native launch" means, mechanically
 *
 * A native `Agent` call has exactly one text channel — `prompt`. The pre-T688
 * Claude fragment told the orchestrator to "pass the complete task prompt"
 * through it, which is tasks:T975's defect: the parent renders and carries a full
 * role prompt whose copy launches nothing. Two already-landed facts remove the
 * need for it entirely:
 *
 *  1. **Role instructions** reach the child at its OWN system boundary, because
 *     `bun run gen-agents` bakes the role prompt into `agents/<role>.md` and the
 *     harness injects it when `subagent_type` selects that agent. T978 recorded
 *     this as {@link NATIVE_CLAUDE_CHILD_RETRIEVAL}'s
 *     `rolePromptInjectionBoundary`, with BOTH ends' role-prompt retrieval sets
 *     asserted EMPTY.
 *  2. **The role input** is assembled SERVER-SIDE from refs
 *     ({@link assembleDispatchInput}) and retrieved by the child BY HANDLE —
 *     `childRetrievesAssembledInputByHandle`.
 *
 * So the only thing the parent must put in `prompt` is the HANDLE. That is what
 * {@link buildClaudeCompactNativeLaunch} produces, and the property is not
 * merely documented: the launch prompt is required to classify as
 * {@link classifyClaudeFinalMessage}'s `handle-only` against the very handle it
 * carries — the SAME predicate the child's reply must satisfy. A prompt with a
 * role-prompt copy, a task narrative, or any surplus key fails that check for
 * the same reason an echoing reply does.
 *
 * ## What this module does NOT own
 *
 * - The child-side one-shot retrieval of the assembled input
 *   ({@link DISPATCH_REF_ASSEMBLY_DEFERRED}, tasks:T977). The bridge names the
 *   handle the child retrieves BY; it does not implement the retrieval.
 *   {@link CLAUDE_BRIDGE_DEFERRED} records this.
 * - Fetch repeatability. defects:D188 owns the cross-surface divergence and
 *   goals:G123's tasks:T1142 makes the shared fetch one-shot. This module
 *   performs EXACTLY ONE fetch per dispatch and therefore does not depend on
 *   repeat-fetch behaviour in either direction —
 *   {@link CLAUDE_BRIDGE_FETCH_COUNT} pins that.
 */

import {
  CLAUDE_NATIVE_DELIVERY_MODE,
  CLAUDE_NATIVE_ISOLATION_ARGUMENT,
  CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  assertClaudeChildCorrelation,
  assertSupportedClaudeDeliveryMode,
  classifyClaudeFinalMessage,
  claudeExpectedChild,
  claudeLaunchGate,
  decideClaudeCompletion,
  mintClaudeLaunchNonce,
  type ClaudeChildCorrelation,
  type ClaudeCorrelationProvenance,
  type ClaudeDeliveryMode,
  type ClaudeEnforcementStrength,
  type ClaudeExitCorroboration,
  type ClaudeLaunchRefusal,
  type ClaudeTerminalSignal,
} from "./claudeDispatchProtocol.js";
import {
  AttestationContractError,
  abortDispatch,
  assertDispatchHandle,
  confirmDispatchCompletion,
  fetchDispatchResult,
  prepareDispatch,
  provenanceBindingOf,
  type DispatchServiceDeps,
  type PrepareDispatchDeps,
  type StoreDispatchResultOutcome,
} from "./dispatchAttestation.js";
import type { AttestationNamespace } from "./dispatchAttestation.js";
import type { DispatchOverlayRegistry } from "./dispatchOverlays.js";
import type { DispatchPreLaunchRejection } from "./dispatchInputValidation.js";
import type {
  AbortedDispatchResult,
  DispatchAbortReason,
  DispatchOverlayApplication,
  DispatchHandle,
  DispatchJSONValue,
  DispatchPrepared,
  NativeCompletionProof,
  ResultCapability,
} from "./compactDispatchProtocol.js";

// ---------------------------------------------------------------------------
// 1. The compact native launch envelope
// ---------------------------------------------------------------------------

/**
 * The EXACT argument set a ref-first native dispatch passes to the `Agent` tool.
 *
 * Snake-cased because these are the tool's own parameter names, not this
 * codebase's style — the value of this interface is that it is the call, so a
 * reader can compare it to the tool signature without translating. The `Agent`
 * tool accepts `subagent_type`, `prompt`, `model`, `isolation`,
 * `run_in_background` and NO path parameter (tasks:T722 §8.1b enumerates the
 * whole field table); every one of those five is pinned here, and there is
 * nothing else to pass.
 *
 * `isolation` and `run_in_background` are LITERAL types rather than widened
 * ones, so a launcher that allocated a harness worktree or backgrounded the
 * child cannot type-check. Both literals come from T687, where each has its
 * measured justification.
 */
export interface ClaudeNativeLaunchEnvelope {
  /**
   * The dispatched role. This is the ONLY channel through which role
   * instructions reach the child — the harness injects the gen-agents-baked
   * `agents/<role>.md` for the selected `subagent_type`. A launcher that also
   * put instructions in `prompt` would be sending them twice.
   */
  readonly subagent_type: string;
  /**
   * The compact ref launch: EXACTLY the dispatch handle, as JSON. Required to
   * classify `handle-only`.
   */
  readonly prompt: string;
  readonly model: string;
  /** `"none"` — keeps the harness out of worktree allocation (defects:D119). */
  readonly isolation: typeof CLAUDE_NATIVE_ISOLATION_ARGUMENT;
  /** `false` explicitly, against the harness default (T722 §4.1/§5.3). */
  readonly run_in_background: typeof CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT;
}

/**
 * A hard upper bound on the compact launch prompt, in bytes.
 *
 * A handle is an attestation id plus a small integer, so its JSON is ~80 bytes;
 * 256 leaves room for a longer id without leaving room for narrative. The point
 * of a NUMERIC bound alongside the structural `handle-only` check is that the
 * two fail on different mutations: a bound catches bulk that happens to be
 * valid JSON, and the structural check catches a small surplus key.
 *
 * For scale, tasks:T722 measured a single dispatched role prompt at 2,689 B of
 * visible completion when unconstrained; a pre-T688 parent carried the whole
 * rendered role prompt, which for `implement-worker` is several kilobytes.
 */
export const CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES = 256;

export interface ClaudeCompactLaunchRequest {
  /** The dispatched role, which becomes `subagent_type`. */
  readonly roleId: string;
  /** The resolved model class for this dispatch. */
  readonly model: string;
  /** The handle `prepare_dispatch` returned. */
  readonly handle: DispatchHandle;
}

/** Render the compact launch prompt: the handle, and nothing else. */
export function claudeCompactLaunchPrompt(handle: DispatchHandle): string {
  const resolved = assertDispatchHandle(handle, "handle");
  // Key order fixed and explicit so the rendering is stable across callers.
  return JSON.stringify({
    attestationId: resolved.attestationId,
    generation: resolved.generation,
  });
}

/**
 * Build the native launch envelope, and REFUSE to build one that is not compact.
 *
 * The two checks are deliberately both applied to the value that will actually
 * be sent, not to an intermediate: a caller cannot pass the structural check by
 * constructing the prompt one way and shipping another.
 */
export function buildClaudeCompactNativeLaunch(
  request: ClaudeCompactLaunchRequest,
): ClaudeNativeLaunchEnvelope {
  const roleId: unknown = request?.roleId;
  if (typeof roleId !== "string" || roleId.trim() === "") {
    throw new AttestationContractError(
      "launch.subagent_type",
      `expected the dispatched role id to select the child's baked instructions, got "${String(roleId)}"`,
    );
  }
  const model: unknown = request.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new AttestationContractError(
      "launch.model",
      `expected a resolved model, got "${String(model)}"`,
    );
  }
  const handle = assertDispatchHandle(request.handle, "launch.handle");
  const prompt = claudeCompactLaunchPrompt(handle);
  assertCompactClaudeLaunchPrompt(prompt, handle);
  return Object.freeze({
    subagent_type: roleId,
    prompt,
    model,
    isolation: CLAUDE_NATIVE_ISOLATION_ARGUMENT,
    run_in_background: CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  });
}

/**
 * Assert that a launch prompt carries EXACTLY the handle — the same predicate
 * the child's reply must satisfy, applied to the parent's own message.
 *
 * This is the detector behind "generated Claude artifacts contain no dispatched
 * prompt copy": a role prompt, a task narrative, or a `{handle, task}` envelope
 * each fail it, and each failure names which of the two bounds it broke.
 */
export function assertCompactClaudeLaunchPrompt(prompt: string, handle: DispatchHandle): void {
  if (typeof prompt !== "string") {
    throw new AttestationContractError(
      "launch.prompt",
      `expected a compact launch prompt string, got "${String(prompt)}"`,
    );
  }
  const bytes = new TextEncoder().encode(prompt).length;
  if (bytes > CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES) {
    throw new AttestationContractError(
      "launch.prompt",
      `a compact native launch carries the handle only, so its prompt must not exceed ` +
        `${CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES} bytes; got ${bytes} bytes — a dispatched prompt ` +
        "copy belongs at the child's own system boundary (gen-agents), not in the launch",
    );
  }
  const verdict = classifyClaudeFinalMessage(prompt, handle);
  if (verdict.verdict !== "handle-only") {
    throw new AttestationContractError(
      "launch.prompt",
      `a compact native launch prompt must carry exactly the dispatch handle, but classified as ` +
        `"${verdict.verdict}"`,
    );
  }
}

/**
 * The delivery mode this bridge drives. Native only: decisions:K170's
 * cross-harness wrapper path belongs to a codex/pi dispatcher, not to a Claude
 * parent, and T687 declares no fallback between them.
 */
export const CLAUDE_BRIDGE_MODE: ClaudeDeliveryMode = CLAUDE_NATIVE_DELIVERY_MODE;

/**
 * Assert that `mode` is the one this bridge implements. Distinguishes "not a
 * Claude mode at all" (T687's {@link assertSupportedClaudeDeliveryMode} throws)
 * from "a supported mode this bridge is not the implementation of".
 */
export function assertClaudeBridgeMode(mode: string): ClaudeDeliveryMode {
  const supported = assertSupportedClaudeDeliveryMode(mode);
  if (supported !== CLAUDE_BRIDGE_MODE) {
    throw new AttestationContractError(
      "mode",
      `this bridge drives "${CLAUDE_BRIDGE_MODE}"; "${supported}" is dispatched by a ` +
        "codex or pi parent and has its own transport",
    );
  }
  return supported;
}

/** Validate the correlation this bridge will bind, and freeze it. */
export function claudeBridgeCorrelation(
  correlation: ClaudeChildCorrelation,
): ClaudeChildCorrelation {
  return assertClaudeChildCorrelation(correlation, "launch.expectedChild");
}

// ---------------------------------------------------------------------------
// 2. The launcher seam
// ---------------------------------------------------------------------------

/**
 * What a launcher is HANDED. Everything here is parent-side; nothing comes back
 * through it.
 */
export interface ClaudeNativeLaunchContext {
  readonly envelope: ClaudeNativeLaunchEnvelope;
  /**
   * The per-dispatch capability, delivered to the child through an INLINE
   * per-subagent `mcpServers` entry whose server `env` holds it — tasks:T722
   * §8.1a's measured mechanism, in which the PARENT's own tool set reported
   * `hasStoreTool=false`. It is passed to the launcher, never to the child's
   * prompt, because a prompt-carried capability would be readable by the model
   * turn that composed it.
   */
  readonly resultCapability: ResultCapability;
  /**
   * The CONSERVATIVE window, in milliseconds, from T687's launch gate — time
   * remaining until `responseStoreNow`, not until `childCancelAt`. A DURATION,
   * never an instant, so a child with an offset clock still stops on time.
   */
  readonly childWindowMs: number;
}

/**
 * What the transport OBSERVED about the child's turn.
 *
 * Note what is ABSENT: `roleId`, `launchNonce` and `sessionId`. The bridge fills
 * those from the launch IT made, so a launcher — and a fortiori a child — has no
 * field through which to assert its own identity. tasks:T713's constraint is
 * therefore structural on this seam rather than checked after the fact.
 */
export interface ClaudeNativeLaunchReport {
  /** Whether the PARENT cancelled. A parent-side fact about the run. */
  readonly cancelled: boolean;
  readonly terminal: ClaudeTerminalSignal;
  /** The child's last message. Checked for handle-only shape, never for identity. */
  readonly finalMessage: string;
  readonly observedAt: string;
  /**
   * What the child's capability-bound submission produced AT THE PER-DISPATCH
   * ENDPOINT — which is bridge-side infrastructure, so this is an observation,
   * not a child claim. `undefined` means the child never submitted, and the
   * bridge does NOT convert that into a failure itself: it lets
   * `confirm_dispatch_completion` return the authoritative `missing-result`
   * abort, keeping defects:D179's rule where it belongs.
   */
  readonly submission?: StoreDispatchResultOutcome;
}

export type ClaudeNativeLauncher = (
  context: ClaudeNativeLaunchContext,
) => ClaudeNativeLaunchReport;

// ---------------------------------------------------------------------------
// 3. The parent-visible outcome — HANDLE-ONLY on every branch
// ---------------------------------------------------------------------------

/**
 * The promotion acknowledgement the ORCHESTRATOR receives. It carries the
 * handle, the digest, the native proof, and the two per-mode strengths — and NO
 * `output` property, on purpose: defects:D173 removed the body from confirm
 * after measuring a 45,833-byte payload returned on a 46,510-byte confirm
 * response. The body arrives on {@link materializeClaudeDispatchOutput} and
 * nowhere else.
 *
 * `nativeCompletion` is retained because it is what makes RESTART RECOVERY
 * possible: a parent that lost its in-memory state re-derives the same proof
 * from the correlation and re-confirms idempotently.
 */
export interface ClaudeParentCompletion {
  readonly state: "consumed";
  readonly attestationId: string;
  readonly generation: number;
  readonly consumedAt: string;
  readonly outputDigest: string;
  readonly nativeCompletion: NativeCompletionProof;
  readonly correlationProvenance: ClaudeCorrelationProvenance;
  readonly handleOnlyEnforcement: ClaudeEnforcementStrength;
  readonly exitStatusCorroborates: ClaudeExitCorroboration;
}

/**
 * Compile-time proof that the parent completion carries no body. Adding an
 * `output` property to {@link ClaudeParentCompletion} breaks `tsc`, not just a
 * test — the same technique `PreLaunchRejectionOutcomeIsNotALifecycleState` uses.
 */
type NeverOnly<T extends never> = T;
export type ClaudeParentCompletionCarriesNoBody = NeverOnly<
  Extract<keyof ClaudeParentCompletion, "output">
>;

export const CLAUDE_DISPATCH_RUN_OUTCOMES = ["rejected", "aborted", "consumed"] as const;

export type ClaudeDispatchRunOutcome = (typeof CLAUDE_DISPATCH_RUN_OUTCOMES)[number];

/** Nothing was allocated: the launch envelope or the role input failed validation. */
export interface ClaudeDispatchRejected {
  readonly outcome: "rejected";
  readonly rejection: DispatchPreLaunchRejection;
  readonly launched: false;
}

/** A terminal abort. `refusal` is present only when the LAUNCH GATE refused. */
export interface ClaudeDispatchAborted {
  readonly outcome: "aborted";
  readonly handle: DispatchHandle;
  readonly reason: DispatchAbortReason;
  readonly abort: AbortedDispatchResult;
  readonly launched: boolean;
  readonly refusal?: ClaudeLaunchRefusal;
}

export interface ClaudeDispatchConsumed {
  readonly outcome: "consumed";
  readonly handle: DispatchHandle;
  readonly completion: ClaudeParentCompletion;
  readonly launched: true;
}

export type ClaudeDispatchRun =
  | ClaudeDispatchRejected
  | ClaudeDispatchAborted
  | ClaudeDispatchConsumed;

// ---------------------------------------------------------------------------
// 4. The sequencer
// ---------------------------------------------------------------------------

export interface ClaudeDispatchRequest {
  readonly namespace: AttestationNamespace;
  readonly roleId: string;
  /** The resolved model class handed to the `Agent` call. */
  readonly model: string;
  /**
   * The DISPATCHING PARENT's own session id. A native `Agent` child's session
   * cannot be pre-assigned (the tool has no session parameter), so T687 binds
   * the parent's — `parent-constructed` provenance, stated rather than averaged.
   */
  readonly parentSessionId: string;
  /** The assembled role input. Assembled elsewhere (T978); bound here. */
  readonly input: DispatchJSONValue;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly registry: DispatchOverlayRegistry;
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly reprepareOf?: DispatchHandle;
}

export interface ClaudeBridgeDeps extends PrepareDispatchDeps {
  readonly launch: ClaudeNativeLauncher;
}

function serviceDeps(deps: ClaudeBridgeDeps): DispatchServiceDeps {
  return { store: deps.store, now: deps.now };
}

/**
 * Drive ONE native ref-first dispatch end to end: prepare → gate → launch →
 * decide → confirm. It does NOT fetch — see {@link CLAUDE_BRIDGE_FETCH_COUNT}
 * and {@link materializeClaudeDispatchOutput}.
 *
 * Every lifecycle write goes through the shared service. Storage and transport
 * failures are deliberately NOT caught: an unavailable store must fail the
 * protocol, because returning any non-error outcome would let a caller book the
 * ref-first saving on a dispatch whose result was never recorded.
 *
 * The routing, and where each verdict comes from:
 *
 * | observed | routed to | decided by |
 * |---|---|---|
 * | invalid role input / launch envelope | `rejected`, nothing allocated | `prepareDispatch` |
 * | launch budget or response window lapsed | `aborted` `deadline-exceeded` | `claudeLaunchGate` |
 * | launch instant off the prepare clock | `aborted` `protocol-violation` | `claudeLaunchGate` |
 * | child stored INVALID output | `aborted` `invalid-output` | `storeDispatchResult`, atomically |
 * | child stored past `childCancelAt` | `aborted` `deadline-exceeded` | `storeDispatchResult`, atomically |
 * | parent cancelled | `aborted` `cancelled` | `decideClaudeCompletion` |
 * | native/API error turn | `aborted` `native-failure` | `decideClaudeCompletion` |
 * | wrong child completed | `aborted` `native-failure` | `decideClaudeCompletion` |
 * | echoed / malformed final message | `aborted` `protocol-violation` | `decideClaudeCompletion` |
 * | nothing stored | `aborted` `missing-result` | `confirmDispatchCompletion` |
 * | conformant | `consumed`, handle-only | `confirmDispatchCompletion` |
 */
export function runClaudeNativeDispatch(
  request: ClaudeDispatchRequest,
  deps: ClaudeBridgeDeps,
): ClaudeDispatchRun {
  const correlation = claudeBridgeCorrelation({
    roleId: request.roleId,
    launchNonce: mintClaudeLaunchNonce(deps.randomBytes),
    sessionId: request.parentSessionId,
  });
  const prepareOutcome = prepareDispatch(
    {
      namespace: request.namespace,
      roleId: request.roleId,
      surface: "claude",
      input: request.input,
      idempotencyKey: request.idempotencyKey,
      timeoutMs: request.timeoutMs,
      registry: request.registry,
      promptDigest: request.promptDigest,
      catalogHash: request.catalogHash,
      expectedChild: claudeExpectedChild(correlation),
      ...(request.overlays === undefined ? {} : { overlays: request.overlays }),
      ...(request.reprepareOf === undefined ? {} : { reprepareOf: request.reprepareOf }),
    },
    deps,
  );
  if (!prepareOutcome.accepted) {
    return Object.freeze({
      outcome: "rejected" as const,
      rejection: prepareOutcome,
      launched: false as const,
    });
  }
  const prepared = prepareOutcome.prepared;
  const handle: DispatchHandle = Object.freeze({
    attestationId: prepared.attestationId,
    generation: prepared.generation,
  });

  const gate = claudeLaunchGate(prepared, deps.now());
  if (!gate.launch) {
    const abort = abortDispatch(
      {
        namespace: request.namespace,
        actor: "trusted-parent",
        ...handle,
        reason: gate.abortReason,
        details: Object.freeze({ refusal: gate.refusal, detail: gate.detail }),
      },
      serviceDeps(deps),
    );
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: false,
      refusal: gate.refusal,
    });
  }

  const report = deps.launch(
    Object.freeze({
      envelope: buildClaudeCompactNativeLaunch({
        roleId: request.roleId,
        model: request.model,
        handle,
      }),
      resultCapability: prepared.resultCapability,
      childWindowMs: gate.childWindowMs,
    }),
  );
  return settleClaudeNativeDispatch(
    { request, prepared, handle, correlation, report },
    serviceDeps(deps),
  );
}

interface ClaudeSettleContext {
  readonly request: ClaudeDispatchRequest;
  readonly prepared: DispatchPrepared;
  readonly handle: DispatchHandle;
  readonly correlation: ClaudeChildCorrelation;
  readonly report: ClaudeNativeLaunchReport;
}

/**
 * Settle a launched dispatch. Split out from {@link runClaudeNativeDispatch} so
 * that RESTART RECOVERY has an entry point: a parent that lost its state, and
 * re-reads the prepared record plus the correlation it minted, settles through
 * exactly this function and reaches exactly the same terminal state.
 */
function settleClaudeNativeDispatch(
  context: ClaudeSettleContext,
  deps: DispatchServiceDeps,
): ClaudeDispatchRun {
  const { request, prepared, handle, correlation, report } = context;

  // The submission is already TERMINAL when the service aborted it atomically
  // (invalid output, or a store past `childCancelAt`). Nothing the parent decides
  // afterwards can move a terminal record, and trying would be a typed conflict
  // rather than a re-route — so this branch is read FIRST.
  if (report.submission?.state === "aborted") {
    const abort = report.submission.result;
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: true,
    });
  }

  const decision = decideClaudeCompletion({
    handle,
    expectedChild: correlation,
    observation: {
      source: "transport",
      mode: CLAUDE_BRIDGE_MODE,
      // Filled from the launch the PARENT made — never from the report.
      roleId: correlation.roleId,
      launchNonce: correlation.launchNonce,
      sessionId: correlation.sessionId,
      cancelled: report.cancelled,
      terminal: report.terminal,
      finalMessage: report.finalMessage,
      observedAt: report.observedAt,
    },
  });
  if (decision.action === "abort") {
    const abort = abortDispatch(
      {
        namespace: request.namespace,
        actor: "trusted-parent",
        ...handle,
        reason: decision.reason,
        details: decision.details,
      },
      deps,
    );
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: true,
    });
  }

  const confirmed = confirmDispatchCompletion(
    {
      namespace: request.namespace,
      ...handle,
      nativeCompletion: decision.nativeCompletion,
      expectedProvenance: provenanceBindingOf(prepared),
    },
    deps,
  );
  if (confirmed.state === "aborted") {
    // `missing-result`: a native completion with nothing stored is not a success,
    // and this module never pretends otherwise from Claude evidence alone.
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: confirmed.result.reason,
      abort: confirmed.result,
      launched: true,
    });
  }
  return Object.freeze({
    outcome: "consumed" as const,
    handle,
    launched: true as const,
    completion: Object.freeze({
      state: "consumed" as const,
      attestationId: confirmed.result.attestationId,
      generation: confirmed.result.generation,
      consumedAt: confirmed.result.consumedAt,
      outputDigest: confirmed.result.outputDigest,
      nativeCompletion: decision.nativeCompletion,
      correlationProvenance: decision.correlationProvenance,
      handleOnlyEnforcement: decision.handleOnlyEnforcement,
      exitStatusCorroborates: decision.exitStatusCorroborates,
    }),
  });
}

/**
 * Re-settle a dispatch after the parent lost its state — questions:Q363's
 * restart case, and the one path on which the bridge does not launch.
 *
 * Idempotency is the shared service's, not this module's: an identical
 * confirmation retry is idempotent there, so a recovered parent that re-derives
 * the same correlation reaches the same `consumed` record without a second
 * child and without a second promotion.
 */
export function recoverClaudeNativeDispatch(
  context: ClaudeSettleContext,
  deps: DispatchServiceDeps,
): ClaudeDispatchRun {
  return settleClaudeNativeDispatch(context, deps);
}

export type { ClaudeSettleContext };

/**
 * THE one body-materialising call. Separate from the run on purpose: the run's
 * result type has no place to put a body, so a caller that never invokes this
 * never sees one, and a caller that invokes it twice is visibly doing so.
 *
 * This performs EXACTLY ONE fetch, which is why defects:D188's repeatability
 * divergence does not reach this bridge in either direction.
 */
export function materializeClaudeDispatchOutput(
  request: { readonly namespace: AttestationNamespace } & DispatchHandle,
  deps: DispatchServiceDeps,
): DispatchJSONValue {
  const handle = assertDispatchHandle(request, "fetch");
  const result = fetchDispatchResult(
    { namespace: request.namespace, actor: "trusted-parent", ...handle },
    deps,
  );
  if (result.state !== "consumed") {
    throw new AttestationContractError(
      "fetch.state",
      `only a consumed dispatch carries an output body; attestation ` +
        `"${handle.attestationId}" is "${result.state}"`,
    );
  }
  return result.output;
}

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/** The task that defines the protocol this module implements. */
export const CLAUDE_BRIDGE_DEFINED_BY = "T687" as const;

/** The task that proves this implementation end to end against a live child. */
export const CLAUDE_BRIDGE_PROVEN_BY = "T689" as const;

/**
 * Exactly how many times one dispatch's body crosses into the parent. ONE, on
 * fetch. Pinned as a number so the sequencer's fetch count is asserted rather
 * than reviewed, and so this bridge is independent of defects:D188's
 * repeatability ruling.
 */
export const CLAUDE_BRIDGE_FETCH_COUNT = 1;

/**
 * What T688 deliberately leaves to another owner, so none of it is silently
 * assumed done.
 */
export const CLAUDE_BRIDGE_DEFERRED = Object.freeze([
  "child-side-one-shot-retrieval-of-the-assembled-input-by-handle-T977",
  "spawn-and-intercept-a-real-wrapper-shellout-child-cross-harness",
  "implement-worktree_manage-prepare-and-release",
  "consolidate-the-duplicated-launch-gate-into-the-shared-module",
  "decide-defects-D188s-fetch-repeatability-divergence-T1142",
] as const);
