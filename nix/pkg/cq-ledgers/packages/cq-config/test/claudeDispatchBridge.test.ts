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
  AttestationBindingError,
  AttestationContractError,
  AttestationStorageError,
  CLAUDE_BRIDGE_DEFERRED,
  CLAUDE_BRIDGE_FETCH_COUNT,
  CLAUDE_BRIDGE_MODE,
  CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
  CLAUDE_COMPLETED_TERMINAL_REASON,
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
  CLAUDE_DISPATCH_RUN_OUTCOMES,
  CLAUDE_NATIVE_DELIVERY_MODE,
  CLAUDE_NATIVE_ISOLATION_ARGUMENT,
  CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  ClaudeUnsupportedModeError,
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationStore,
  assertClaudeBridgeMode,
  assertCompactClaudeLaunchPrompt,
  buildClaudeCompactNativeLaunch,
  claudeBridgeCorrelation,
  claudeCompactLaunchPrompt,
  claudeExpectedChild,
  classifyClaudeFinalMessage,
  fetchDispatchResult,
  invalidOutputDetailsOf,
  materializeClaudeDispatchOutput,
  prepareDispatch,
  recoverClaudeNativeDispatch,
  runClaudeNativeDispatch,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  type AttestationNamespace,
  type ClaudeChildCorrelation,
  type ClaudeDispatchRequest,
  type ClaudeDispatchRun,
  type ClaudeNativeLaunchContext,
  type ClaudeNativeLaunchReport,
  type ClaudeNativeLauncher,
  type ClaudeSettleContext,
  type ClaudeTerminalSignal,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
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

// ---------------------------------------------------------------------------
// 2. The sequencer, over the REAL lifecycle
// ---------------------------------------------------------------------------

/**
 * The sentinel whose LOCATION is the measurement. tasks:T722 proved ref-first by
 * showing a distinctive marker absent from the orchestrator transcript and
 * present only after one authorized fetch; §2 makes the same measurement over
 * the bridge's own return values.
 */
const BODY_SENTINEL = "T688-BODY-SENTINEL";

/**
 * A large, distinctive implement-worker result. `gateDurationMs` is REQUIRED on a
 * `status: "pass"` result (T894) — without it the REAL store would reject this as
 * `invalid-output` and every happy-path fixture would abort. `filesTouched` names
 * only the source module here: adding a test path would make `mutationTable`
 * required too, which the INVALID fixture below relies on.
 */
const OUTPUT: DispatchJSONValue = {
  taskId: "T688",
  status: "pass",
  resultCommit: "7e3bfd579800a3e0db18dac15d5939ba08edbdb4",
  branch: "implement/T688",
  filesTouched: ["packages/cq-config/src/claudeDispatchBridge.ts"],
  gateDurationMs: 611_400,
  checkSummary: "3 files, 0 fail",
  summary: `${BODY_SENTINEL} ${"payload ".repeat(600)}`.trim(),
};

const INVALID_OUTPUT: DispatchJSONValue = { taskId: "T688", status: "not-a-status" };

const TERMINAL_OK: ClaudeTerminalSignal = {
  subtype: "success",
  isError: false,
  terminalReason: CLAUDE_COMPLETED_TERMINAL_REASON,
};

/**
 * tasks:T722 §7.1 #4, verbatim: a bogus model produced
 * `{"subtype":"success","is_error":true,…,"terminal_reason":"api_error"}`.
 */
const TERMINAL_API_ERROR: ClaudeTerminalSignal = {
  subtype: "success",
  isError: true,
  terminalReason: "api_error",
};

interface Bridge {
  readonly clock: FakeDispatchClock;
  readonly store: InMemoryAttestationStore;
  readonly service: DispatchServiceDeps;
  /** Every launch context the sequencer handed the launcher, in order. */
  readonly launches: ClaudeNativeLaunchContext[];
}

function bridge(options: { readonly fault?: (operation: string) => void } = {}): Bridge {
  const clock = new FakeDispatchClock(T0);
  const store =
    options.fault === undefined
      ? new InMemoryAttestationStore(NAMESPACE)
      : new InMemoryAttestationStore(NAMESPACE, options.fault as never);
  return { clock, store, service: { store, now: clock.now }, launches: [] };
}

interface ChildBehaviour {
  /** What the child submits through its capability. `null` means it never submits. */
  readonly output?: DispatchJSONValue | null;
  readonly cancelled?: boolean;
  readonly terminal?: ClaudeTerminalSignal;
  /** Override the child's final message — the echo/malformed-reply fixtures. */
  readonly finalMessage?: (handle: DispatchHandle) => string;
  /** Advance the clock by this many ms before the child submits. */
  readonly submitAfterMs?: number;
}

/**
 * A launcher standing in for the real `Agent` call. It performs the child's
 * `store_result` through the REAL {@link storeDispatchResult} using the REAL
 * capability the bridge handed it — the per-subagent inline endpoint's role — so
 * the store path in these fixtures is the production one, not a simulation of it.
 */
function child(b: Bridge, behaviour: ChildBehaviour = {}): ClaudeNativeLauncher {
  return (context) => {
    b.launches.push(context);
    const handle: DispatchHandle = JSON.parse(context.envelope.prompt) as DispatchHandle;
    if (behaviour.submitAfterMs !== undefined) {
      b.clock.advance(behaviour.submitAfterMs);
    }
    const output = behaviour.output === undefined ? OUTPUT : behaviour.output;
    const submission =
      output === null
        ? undefined
        : storeDispatchResult(
            { resultCapability: context.resultCapability, output },
            b.service,
          );
    return {
      cancelled: behaviour.cancelled ?? false,
      terminal: behaviour.terminal ?? TERMINAL_OK,
      finalMessage:
        behaviour.finalMessage === undefined
          ? JSON.stringify(handle)
          : behaviour.finalMessage(handle),
      observedAt: b.clock.now(),
      ...(submission === undefined ? {} : { submission }),
    };
  };
}

function dispatchRequest(
  overrides: Partial<ClaudeDispatchRequest> = {},
): ClaudeDispatchRequest {
  return {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    model: MODEL,
    parentSessionId: SESSION_ID,
    input: INPUT,
    idempotencyKey: "T688-round-0",
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
    ...overrides,
  };
}

function run(
  b: Bridge,
  behaviour: ChildBehaviour = {},
  overrides: Partial<ClaudeDispatchRequest> = {},
): ClaudeDispatchRun {
  return runClaudeNativeDispatch(dispatchRequest(overrides), {
    store: b.store,
    now: b.clock.now,
    randomBytes: sequentialDispatchRandomBytes(23),
    launch: child(b, behaviour),
  });
}

describe("T688 §2 — prepare -> gate -> launch -> confirm, driving the real service", () => {
  test("a conformant dispatch reaches `consumed`, and the parent sees NO body", () => {
    const b = bridge();
    const result = run(b);
    if (result.outcome !== "consumed") {
      throw new Error(`expected consumed, got ${result.outcome}`);
    }
    expect(result.launched).toBe(true);
    expect(result.completion.state).toBe("consumed");
    // Handle-only, structurally: there is no `output` key to inspect.
    expect(Object.keys(result.completion)).not.toContain("output");
    // THE MEASUREMENT: the distinctive body is absent from EVERYTHING the
    // orchestrator receives, including the abort/detail channels.
    expect(JSON.stringify(result)).not.toContain(BODY_SENTINEL);
    // And the digest binds the promotion to the payload without materialising it.
    expect(result.completion.outputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the body arrives on ONE fetch, and only there", () => {
    const b = bridge();
    const result = run(b);
    if (result.outcome !== "consumed") {
      throw new Error(`expected consumed, got ${result.outcome}`);
    }
    expect(CLAUDE_BRIDGE_FETCH_COUNT).toBe(1);
    const body = materializeClaudeDispatchOutput(
      { namespace: NAMESPACE, ...result.handle },
      b.service,
    );
    expect(JSON.stringify(body)).toContain(BODY_SENTINEL);
    expect(body).toEqual(OUTPUT);
  });

  test("the launch selects the role and carries the capability OUT of the prompt", () => {
    const b = bridge();
    run(b);
    expect(b.launches).toHaveLength(1);
    const context = b.launches[0]!;
    // Role instructions: `subagent_type` and nothing else.
    expect(context.envelope.subagent_type).toBe(ROLE_ID);
    expect(context.envelope.model).toBe(MODEL);
    // T722 §8.1a: the capability travels in the per-subagent server `env`, so it
    // must NOT be readable in the prompt the model turn composed.
    expect(context.resultCapability.scope).toBe("store-result");
    expect(context.envelope.prompt).not.toContain(context.resultCapability.token);
    // The child is handed a DURATION, never an instant, and a CONSERVATIVE one:
    // the window to `responseStoreNow`, which is 30s short of `childCancelAt`.
    expect(context.childWindowMs).toBe(TIMEOUT_MS - 30_000);
  });

  test("the input NARRATIVE never appears in the launch either", () => {
    const b = bridge();
    run(b);
    const context = b.launches[0]!;
    // The child retrieves its assembled input BY HANDLE (T978/T977). The launch
    // therefore carries neither the worktree path nor the task narrative.
    expect(context.envelope.prompt).not.toContain(WORKTREE_PATH);
    expect(context.envelope.prompt).not.toContain("Implement Claude ref-first");
  });

  test("provenance records the ACTUAL model and agent, and binds the digests", () => {
    const b = bridge();
    const result = run(b);
    if (result.outcome !== "consumed") {
      throw new Error(`expected consumed, got ${result.outcome}`);
    }
    // The confirmation names the actual child/run it launched, role folded in.
    expect(result.completion.nativeCompletion.kind).toBe("native-completion");
    expect(result.completion.nativeCompletion.actor).toBe("trusted-parent");
    expect(result.completion.nativeCompletion.childId.startsWith(`${ROLE_ID}#`)).toBe(true);
    expect(result.completion.nativeCompletion.runId).toBe(SESSION_ID);
    // Native: parent-constructed identity, best-effort handle-only, no exit status.
    expect(result.completion.correlationProvenance).toBe("parent-constructed");
    expect(result.completion.handleOnlyEnforcement).toBe("prompt-best-effort");
    expect(result.completion.exitStatusCorroborates).toBe("unavailable");
    // And the model actually passed to the launch is the requested one.
    expect(b.launches[0]!.envelope.model).toBe(MODEL);
  });
});

describe("T688 §2b — every failure is routed to a TYPED terminal state", () => {
  test("ECHO in the final message aborts `protocol-violation`", () => {
    const b = bridge();
    const result = run(b, {
      finalMessage: (handle) => JSON.stringify({ ...handle, output: OUTPUT }),
    });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("protocol-violation");
    expect(JSON.stringify(result.abort.details)).toContain("echo");
    // The lifecycle is sound — nothing was promoted — but on the NATIVE mode the
    // abort is a remedy, not containment: T687 records that distinction, and the
    // detail says so rather than implying a saving that did not happen.
    expect(JSON.stringify(result.abort.details)).toContain(
      '"containedBeforeParentContext":false',
    );
  });

  test("INVALID OUTPUT aborts `invalid-output`, decided atomically by the store", () => {
    const b = bridge();
    const result = run(b, { output: INVALID_OUTPUT });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("invalid-output");
    expect(result.launched).toBe(true);
    // The typed validation details come from the REAL store, not from here.
    const details = invalidOutputDetailsOf(result.abort);
    expect(details?.roleId).toBe(ROLE_ID);
    expect(details?.errors.length).toBeGreaterThan(0);
  });

  test("CANCELLATION aborts `cancelled`, outranking a stored result", () => {
    const b = bridge();
    const result = run(b, { cancelled: true });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("cancelled");
    // The result WAS stored, and is still not consumable: abort wins.
    const state = fetchDispatchResult(
      { namespace: NAMESPACE, actor: "trusted-parent", ...result.handle },
      b.service,
    );
    expect(state.state).toBe("aborted");
  });

  test("a NATIVE/API error turn aborts `native-failure` despite subtype success", () => {
    const b = bridge();
    const result = run(b, { terminal: TERMINAL_API_ERROR });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("native-failure");
    expect(JSON.stringify(result.abort.details)).toContain("api_error");
  });

  test("NOTHING STORED aborts `missing-result` — the SERVICE's verdict, not ours", () => {
    const b = bridge();
    const result = run(b, { output: null });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("missing-result");
  });

  test("a STORE PAST the cancel deadline aborts `deadline-exceeded`", () => {
    const b = bridge();
    const result = run(b, { submitAfterMs: TIMEOUT_MS + 1_000 });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("deadline-exceeded");
  });

  test("invalid ROLE INPUT is rejected and allocates NOTHING", () => {
    const b = bridge();
    // T687 §6's derivation: `worktreePath` is REQUIRED, so a dispatch without it
    // is UNPREPARABLE — the composition where the child prepares its own tree
    // cannot even be launched.
    const { worktreePath: _dropped, ...withoutPath } = INPUT as Record<string, unknown>;
    const result = run(b, {}, { input: withoutPath as DispatchJSONValue });
    if (result.outcome !== "rejected") {
      throw new Error(`expected rejected, got ${result.outcome}`);
    }
    expect(result.rejection.reason).toBe("invalid-role-input");
    expect(result.rejection.allocated).toBe(false);
    expect(result.launched).toBe(false);
    // No child was launched, and no record exists.
    expect(b.launches).toHaveLength(0);
  });

  test("a LAPSED launch budget aborts `deadline-exceeded` without launching", () => {
    const b = bridge();
    // The gate reads the clock AFTER prepare, so advancing the clock inside the
    // launcher is too late — the delay must precede the gate. A launcher that is
    // never called proves the refusal happened before any child existed.
    const clock = b.clock;
    const result = runClaudeNativeDispatch(dispatchRequest(), {
      store: b.store,
      now: () => {
        const at = clock.now();
        clock.advance(61_000);
        return at;
      },
      randomBytes: sequentialDispatchRandomBytes(23),
      launch: child(b),
    });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("deadline-exceeded");
    expect(result.refusal).toBe("launch-budget-lapsed");
    expect(result.launched).toBe(false);
    expect(b.launches).toHaveLength(0);
  });

  test("every declared run outcome is REACHABLE, and the abort reasons are the service's", () => {
    // A closed vocabulary that some input cannot produce is defects:D186's dead
    // declaration, so each is witnessed above and re-asserted as a set here.
    expect([...CLAUDE_DISPATCH_RUN_OUTCOMES].sort()).toEqual([
      "aborted",
      "consumed",
      "rejected",
    ]);
    const b = bridge();
    expect(run(b).outcome).toBe("consumed");
    expect(run(bridge(), { cancelled: true }).outcome).toBe("aborted");
  });
});

describe("T688 §2c — correlation, idempotency, restart, and an unavailable store", () => {
  /** Prepare directly, so a test holds the prepared record a restart would re-read. */
  function preparedRun(b: Bridge, correlation: ClaudeChildCorrelation = CORRELATION) {
    const outcome = prepareDispatch(
      {
        namespace: NAMESPACE,
        roleId: ROLE_ID,
        surface: "claude",
        input: INPUT,
        idempotencyKey: "T688-restart",
        timeoutMs: TIMEOUT_MS,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: PROMPT_DIGEST,
        catalogHash: CATALOG_HASH,
        expectedChild: claudeExpectedChild(correlation),
      },
      { store: b.store, now: b.clock.now, randomBytes: sequentialDispatchRandomBytes(31) },
    );
    if (!outcome.accepted) {
      throw new Error(`expected a prepared dispatch, got ${outcome.reason}`);
    }
    return outcome.prepared;
  }

  function settleContext(
    b: Bridge,
    prepared: DispatchPrepared,
    correlation: ClaudeChildCorrelation,
    report: ClaudeNativeLaunchReport,
  ): ClaudeSettleContext {
    return {
      request: dispatchRequest({ idempotencyKey: "T688-restart" }),
      prepared,
      handle: handleOf(prepared),
      correlation,
      report,
    };
  }

  function storedReport(b: Bridge, prepared: DispatchPrepared): ClaudeNativeLaunchReport {
    const submission = storeDispatchResult(
      { resultCapability: prepared.resultCapability, output: OUTPUT },
      b.service,
    );
    return {
      cancelled: false,
      terminal: TERMINAL_OK,
      finalMessage: JSON.stringify(handleOf(prepared)),
      observedAt: b.clock.now(),
      submission,
    };
  }

  test("RESTART RECOVERY: a parent that lost its state settles to the same `consumed`", () => {
    const b = bridge();
    const prepared = preparedRun(b);
    const report = storedReport(b, prepared);
    const first = recoverClaudeNativeDispatch(
      settleContext(b, prepared, CORRELATION, report),
      b.service,
    );
    if (first.outcome !== "consumed") {
      throw new Error(`expected consumed, got ${first.outcome}`);
    }
    // TERMINAL IDEMPOTENCY: re-settling with the same proof does not re-promote,
    // does not launch a second child, and returns the same record.
    const again = recoverClaudeNativeDispatch(
      settleContext(b, prepared, CORRELATION, report),
      b.service,
    );
    if (again.outcome !== "consumed") {
      throw new Error(`expected consumed, got ${again.outcome}`);
    }
    expect(again.completion.consumedAt).toBe(first.completion.consumedAt);
    expect(again.completion.outputDigest).toBe(first.completion.outputDigest);
    expect(JSON.stringify(again)).not.toContain(BODY_SENTINEL);
  });

  test("CORRELATION FAILURE is UNREPRESENTABLE on the live path, by construction", () => {
    const b = bridge();
    run(b);
    // The launch report has no `roleId`, `launchNonce` or `sessionId` field at
    // all: the bridge fills the observation from the launch IT made. So a
    // launcher — and a fortiori a child — has nothing through which to assert an
    // identity, and `decideClaudeCompletion`'s mismatch abort cannot be provoked
    // from this seam. tasks:T713's constraint is structural here, not checked.
    const reportKeys = Object.keys(
      run(bridge()) as unknown as Record<string, unknown>,
    );
    expect(reportKeys).not.toContain("roleId");
    const context = b.launches[0]!;
    // Nor does the launcher receive the correlation to echo back.
    expect(Object.keys(context).sort()).toEqual([
      "childWindowMs",
      "envelope",
      "resultCapability",
    ]);
  });

  test("a RECOVERED parent that mis-derives its correlation is REFUSED by the store", () => {
    const b = bridge();
    const prepared = preparedRun(b);
    const report = storedReport(b, prepared);
    const wrong: ClaudeChildCorrelation = {
      ...CORRELATION,
      launchNonce: "d3Jvbmdub25jZWZpeHR1cmV3cm9uZ25vbmNl",
    };
    // The store refuses because the role AND the nonce are folded into `childId`
    // — this is the shared service's binding check, not one this module performs.
    //
    // It THROWS rather than aborting, and that is the correct routing: a parent's
    // own bookkeeping error is not a verdict on the child. Aborting here would
    // destroy a dispatch whose real child may still be about to complete
    // correctly — the same reasoning by which T687 makes an unsupported mode
    // throw instead of becoming an abort reason.
    expect(() =>
      recoverClaudeNativeDispatch(settleContext(b, prepared, wrong, report), b.service),
    ).toThrow(AttestationBindingError);
    // Load-bearing: the record SURVIVES, still consumable by a correct recovery.
    const state = fetchDispatchResult(
      { namespace: NAMESPACE, actor: "trusted-parent", ...handleOf(prepared) },
      b.service,
    );
    expect(state.state).toBe("result-stored");
    const recovered = recoverClaudeNativeDispatch(
      settleContext(b, prepared, CORRELATION, report),
      b.service,
    );
    expect(recovered.outcome).toBe("consumed");
  });

  test("an UNAVAILABLE STORE fails the protocol; it never books a ref-first saving", () => {
    // The fault fires on the write that promotes to `consumed`. A bridge that
    // swallowed it would hand back a completion for a dispatch whose promotion
    // never persisted — precisely "silently claiming ref-first savings".
    let promotions = 0;
    const b = bridge({
      fault: (operation) => {
        if (operation === "replace") {
          promotions += 1;
          // The child's store_result is also a `replace`; fail only the confirm.
          if (promotions >= 2) throw new AttestationStorageError("store offline");
        }
      },
    });
    let outcome: ClaudeDispatchRun | undefined;
    expect(() => {
      outcome = run(b);
    }).toThrow(AttestationStorageError);
    expect(outcome).toBeUndefined();
  });

  test("materializing a NON-consumed dispatch is refused rather than returning nothing", () => {
    const b = bridge();
    const result = run(b, { cancelled: true });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(() =>
      materializeClaudeDispatchOutput({ namespace: NAMESPACE, ...result.handle }, b.service),
    ).toThrow(/only a consumed dispatch carries an output body/);
  });
});
