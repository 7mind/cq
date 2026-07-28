/**
 * T688 — the Claude ref-first COMPACT NATIVE LAUNCH bridge, exercised against
 * the REAL shared lifecycle.
 *
 * tasks:T687's suite proves the DEFINITION. This suite proves the
 * IMPLEMENTATION, and its standard is the one T687 set: nothing here
 * re-implements `prepareDispatch` / `storeDispatchResult` /
 * `confirmDispatchCompletion` / `abortDispatch` / `fetchDispatchResult`, and
 * every lifecycle claim is made by driving them.
 *
 * Each guard carries a NEGATIVE CONTROL (decisions:K166): the REAL detector is
 * run over a REAL mutated artifact and observed to fail. Where the mutation is a
 * source edit rather than a value, the control mutates the value the detector
 * actually reads, never a toy literal standing in for it.
 */

import { describe, expect, test } from "bun:test";
import {
  AttestationContractError,
  CLAUDE_BRIDGE_DEFERRED,
  CLAUDE_BRIDGE_FETCH_COUNT,
  CLAUDE_BRIDGE_MODE,
  CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
  CLAUDE_NATIVE_DELIVERY_MODE,
  CLAUDE_NATIVE_ISOLATION_ARGUMENT,
  CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  ClaudeUnsupportedModeError,
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationStore,
  assertCompactClaudeLaunchPrompt,
  buildClaudeCompactNativeLaunch,
  claudeBridgeCorrelation,
  claudeCompactLaunchPrompt,
  claudeExpectedChild,
  assertClaudeBridgeMode,
  classifyClaudeFinalMessage,
  prepareDispatch,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type ClaudeChildCorrelation,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type PrepareDispatchRequest,
} from "@cq/config";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const T0 = "2026-07-28T12:00:00.000Z";
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const TIMEOUT_MS = 600_000;
const ROLE_ID = "implement-worker";
const MODEL = "opus-5[1m]";
const SESSION_ID = "1dea1c87-a984-448b-b038-d0078741a669";
const LAUNCH_NONCE = "Y2xhdWRlbGF1bmNobm9uY2VmaXh0dXJl";

const CORRELATION: ClaudeChildCorrelation = {
  roleId: ROLE_ID,
  launchNonce: LAUNCH_NONCE,
  sessionId: SESSION_ID,
};

/** The orchestrator-prepared worktree from questions:Q363 — a UUID-named fresh tree. */
const WORKTREE_PATH = "/tmp/cq-worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";

const INPUT: DispatchJSONValue = {
  taskId: "T688",
  headline: "Implement Claude ref-first compact native launch",
  description: "Drive T687's protocol against the real shared lifecycle.",
  acceptance: "The launch carries the handle only and the body arrives on one fetch.",
  worktreePath: WORKTREE_PATH,
  branch: "implement/T688",
  baseCommit: "7e3bfd579800a3e0db18dac15d5939ba08edbdb4",
};

function prepared(): DispatchPrepared {
  const clock = new FakeDispatchClock(T0);
  const store = new InMemoryAttestationStore(NAMESPACE);
  const request: PrepareDispatchRequest = {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    surface: "claude",
    input: INPUT,
    idempotencyKey: "T688-round-0",
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
    expectedChild: claudeExpectedChild(CORRELATION),
  };
  const outcome = prepareDispatch(request, {
    store,
    now: clock.now,
    randomBytes: sequentialDispatchRandomBytes(11),
  });
  if (!outcome.accepted) {
    throw new Error(`expected a prepared dispatch, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome.prepared;
}

function handleOf(value: DispatchPrepared): DispatchHandle {
  return { attestationId: value.attestationId, generation: value.generation };
}

// ---------------------------------------------------------------------------
// 1. The compact native launch envelope
// ---------------------------------------------------------------------------

describe("T688 §1 — the compact native launch carries the HANDLE, not a prompt copy", () => {
  test("the envelope pins all five Agent arguments, and the two T687 literals", () => {
    const handle = handleOf(prepared());
    const launch = buildClaudeCompactNativeLaunch({ roleId: ROLE_ID, model: MODEL, handle });

    // `subagent_type` is the ONLY role-instruction channel: the harness injects
    // the gen-agents-baked agents/<role>.md for the selected agent.
    expect(launch.subagent_type).toBe(ROLE_ID);
    expect(launch.model).toBe(MODEL);
    // T687: "none" keeps the harness out of worktree allocation (D119), and
    // background dispatch has no correlatable transport field (T722 §4.1/§5.3).
    expect(launch.isolation).toBe(CLAUDE_NATIVE_ISOLATION_ARGUMENT);
    expect(launch.isolation).toBe("none");
    expect(launch.run_in_background).toBe(CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT);
    expect(launch.run_in_background).toBe(false);
    // Exactly five keys — the Agent tool's whole field set, nothing smuggled.
    expect(Object.keys(launch).sort()).toEqual([
      "isolation",
      "model",
      "prompt",
      "run_in_background",
      "subagent_type",
    ]);
  });

  test("the launch prompt satisfies the SAME handle-only predicate as the child's reply", () => {
    const handle = handleOf(prepared());
    const launch = buildClaudeCompactNativeLaunch({ roleId: ROLE_ID, model: MODEL, handle });
    // The parent's message and the child's are held to one standard. That is the
    // whole content of "no dispatched prompt copy" — not a phrase ban.
    const verdict = classifyClaudeFinalMessage(launch.prompt, handle);
    expect(verdict.verdict).toBe("handle-only");
    expect(JSON.parse(launch.prompt)).toEqual({
      attestationId: handle.attestationId,
      generation: handle.generation,
    });
  });

  test("the launch prompt is COMPACT by measurement, not by assertion", () => {
    const handle = handleOf(prepared());
    const prompt = claudeCompactLaunchPrompt(handle);
    const bytes = new TextEncoder().encode(prompt).length;
    expect(bytes).toBeLessThanOrEqual(CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES);
    // Recorded so a regression in handle width is visible as a number, and so
    // the bound is seen to have real headroom rather than being fitted to it.
    expect(bytes).toBeGreaterThan(40);
    expect(bytes).toBeLessThan(120);
  });

  test("NEGATIVE CONTROL: a dispatched ROLE PROMPT COPY in the launch is refused", () => {
    const handle = handleOf(prepared());
    // The REAL artifact this mutates is the REAL launch prompt the builder
    // produced, with a REAL role instruction body appended — the pre-T688
    // fragment's "pass the complete task prompt" behaviour.
    const real = claudeCompactLaunchPrompt(handle);
    const withPromptCopy = `${real}\n\n${"You are the implement-flow worker. ".repeat(40)}`;
    expect(new TextEncoder().encode(withPromptCopy).length).toBeGreaterThan(
      CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
    );
    expect(() => assertCompactClaudeLaunchPrompt(withPromptCopy, handle)).toThrow(
      /must not exceed 256 bytes/,
    );
  });

  test("NEGATIVE CONTROL: a SMALL surplus key is caught structurally, under the byte bound", () => {
    const handle = handleOf(prepared());
    // Under the numeric bound, so only the structural check can catch it. This
    // is why both checks exist: they fail on different mutations.
    const smuggled = JSON.stringify({ ...handle, task: "T688" });
    expect(new TextEncoder().encode(smuggled).length).toBeLessThanOrEqual(
      CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
    );
    expect(() => assertCompactClaudeLaunchPrompt(smuggled, handle)).toThrow(
      /must carry exactly the dispatch handle, but classified as "echo"/,
    );
  });

  test("NEGATIVE CONTROL: a prompt bound to a DIFFERENT dispatch is refused", () => {
    const handle = handleOf(prepared());
    const other: DispatchHandle = { attestationId: handle.attestationId, generation: 9 };
    expect(() => assertCompactClaudeLaunchPrompt(claudeCompactLaunchPrompt(other), handle)).toThrow(
      /classified as "wrong-handle"/,
    );
  });

  test("NEGATIVE CONTROL: free-text prose is refused as unparseable, not tolerated", () => {
    const handle = handleOf(prepared());
    expect(() =>
      assertCompactClaudeLaunchPrompt("Implement T688 end to end in your worktree.", handle),
    ).toThrow(/classified as "unparseable"/);
  });

  test("a missing role or model is refused BEFORE a child exists", () => {
    const handle = handleOf(prepared());
    expect(() => buildClaudeCompactNativeLaunch({ roleId: "", model: MODEL, handle })).toThrow(
      AttestationContractError,
    );
    expect(() => buildClaudeCompactNativeLaunch({ roleId: ROLE_ID, model: "", handle })).toThrow(
      AttestationContractError,
    );
  });

  test("a malformed handle cannot become a launch", () => {
    expect(() =>
      buildClaudeCompactNativeLaunch({
        roleId: ROLE_ID,
        model: MODEL,
        handle: { attestationId: "", generation: 1 },
      }),
    ).toThrow(AttestationContractError);
  });
});

describe("T688 §1b — the bridge drives the NATIVE mode only", () => {
  test("the bridge's mode is T687's native mode", () => {
    expect(CLAUDE_BRIDGE_MODE).toBe(CLAUDE_NATIVE_DELIVERY_MODE);
    expect(assertClaudeBridgeMode(CLAUDE_NATIVE_DELIVERY_MODE)).toBe(CLAUDE_NATIVE_DELIVERY_MODE);
  });

  test("the CROSS-HARNESS mode is refused HERE, distinctly from an unsupported mode", () => {
    // Supported by T687, but dispatched by a codex/pi parent — not this bridge.
    // K170 declares no fallback between the two, so conflating them would be a
    // silent reversal of a user decision.
    expect(() => assertClaudeBridgeMode(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)).toThrow(
      AttestationContractError,
    );
    // An unsupported mode fails EARLIER, with T687's own error type.
    expect(() => assertClaudeBridgeMode("background-native-subagent")).toThrow(
      ClaudeUnsupportedModeError,
    );
  });

  test("the correlation the bridge binds is T687-validated, and frozen", () => {
    const resolved = claudeBridgeCorrelation(CORRELATION);
    expect(resolved).toEqual(CORRELATION);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => claudeBridgeCorrelation({ ...CORRELATION, sessionId: "not-a-uuid" })).toThrow(
      AttestationContractError,
    );
  });

  test("the deferred set names its owners and does not claim T977's retrieval", () => {
    expect(CLAUDE_BRIDGE_FETCH_COUNT).toBe(1);
    expect(CLAUDE_BRIDGE_DEFERRED).toContain(
      "child-side-one-shot-retrieval-of-the-assembled-input-by-handle-T977",
    );
    expect(CLAUDE_BRIDGE_DEFERRED).toContain(
      "decide-defects-D188s-fetch-repeatability-divergence-T1142",
    );
  });
});
