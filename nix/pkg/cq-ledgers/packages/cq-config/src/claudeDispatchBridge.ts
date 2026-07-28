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
  type ClaudeChildCorrelation,
  type ClaudeDeliveryMode,
} from "./claudeDispatchProtocol.js";
import { AttestationContractError, assertDispatchHandle } from "./dispatchAttestation.js";
import type { DispatchHandle } from "./compactDispatchProtocol.js";

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
