/**
 * T690 — the Codex `prepare → child store_result → parent confirm → fetch`
 * protocol, exercised as a FIXTURE MATRIX over both supported delivery modes
 * (`native-agent` and the `exec-intercepted` fallback).
 *
 * Two deliberate design choices about what is asserted here:
 *
 *  - The lifecycle is the SHARED service's (T685/T686/T720). These fixtures
 *    drive the real `prepareDispatch` / `storeDispatchResult` /
 *    `confirmDispatchCompletion` / `abortDispatch` / `fetchDispatchResult`
 *    against the strict in-memory store, so a Codex-specific claim is only
 *    believable if the shared lifecycle actually produces it. Nothing is
 *    re-implemented or stubbed on the lifecycle side.
 *  - Every Codex-specific decision is a PURE function of transport evidence, so
 *    each row of the matrix is a deterministic assertion rather than a live
 *    Codex run. The live evidence that justifies the design lives in
 *    researches:RS10 / researches:RS11 / tasks:T713, and the mode
 *    classification quotes it.
 *
 * Section 6 is the anti-coupling guard defects:D186 asks for, pointed at the
 * codex surface BEFORE the coupling can be created.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  AttestationBindingError,
  AttestationContractError,
  AttestationStorageError,
  AttestationTransportError,
  CODEX_CHILD_OUTCOMES,
  CODEX_CORRELATION_ENTROPY_BYTES,
  CODEX_CORRELATION_SEPARATOR,
  CODEX_DELIVERY_MODES,
  CODEX_DELIVERY_MODE_IDS,
  CODEX_DISPATCH_DEFERRED,
  CODEX_DISPATCH_DEFERRED_TO,
  CODEX_EXIT_CORROBORATIONS,
  CODEX_FALLBACK_DELIVERY_MODE,
  CODEX_FINAL_MESSAGE_VERDICTS,
  CODEX_GLOBAL_AGENTS_DIR,
  CODEX_LAUNCH_REFUSALS,
  CODEX_NATIVE_AGENT_DECLARATION_KEYS,
  CODEX_NATIVE_DELIVERY_MODE,
  CODEX_ROLE_DELIVERY_MIGRATION_OWNER,
  CODEX_ROLE_DELIVERY_PREREQUISITES,
  CODEX_ROLE_DELIVERY_PREREQUISITES_ARE_ATOMIC,
  CodexObservationProvenanceError,
  CodexUnsupportedModeError,
  DISPATCHED_ROLE_IDS,
  DISPATCH_ABORT_REASONS,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_TIMEOUT_MIN_MS,
  DispatchAuthorizationError,
  DispatchStateConflictError,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  InMemoryAttestationStore,
  LAUNCH_DEADLINE_MS,
  RESPONSE_STORE_LEAD_MS,
  SUPPORTED_CODEX_DELIVERY_MODES,
  TERMINAL_ENVELOPE_RETENTION_MS,
  UNSUPPORTED_CODEX_DELIVERY_MODES,
  abortDispatch,
  assertCodexChildCorrelation,
  assertSupportedCodexDeliveryMode,
  classifyCodexFinalMessage,
  codexCompletionActor,
  codexExitCorroboration,
  codexExpectedChild,
  codexLaunchGate,
  confirmDispatchCompletion,
  decideCodexCompletion,
  fetchDispatchResult,
  isSupportedCodexDeliveryMode,
  mintCodexCorrelationId,
  prepareDispatch,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  sweepAttestations,
  type AbortedDispatchResult,
  type AttestationNamespace,
  type AttestationStoreOperation,
  type CodexChildCorrelation,
  type CodexCompletionObservation,
  type CodexDeliveryMode,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type PrepareDispatchDeps,
  type PrepareDispatchRequest,
} from "@cq/config";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const T0 = "2026-07-28T12:00:00.000Z";
const T0_MS = Date.parse(T0);
const PROMPT_DIGEST = "c".repeat(64);
const CATALOG_HASH = "d".repeat(64);
const TIMEOUT_MS = 600_000;
const ROLE_ID = "implement-worker";
const THREAD_ID = "codex-thread-01K9QF";
/** A 32-char base64url nonce, the shape `mintCodexCorrelationId` produces. */
const CORRELATION_ID = "Zm9vYmFyYmF6cXV1eGNvcnJlbGF0aW9u";

const CORRELATION: CodexChildCorrelation = {
  agentType: ROLE_ID,
  correlationId: CORRELATION_ID,
  threadId: THREAD_ID,
};

const INPUT: DispatchJSONValue = {
  taskId: "T690",
  headline: "Define the Codex prepare -> child store -> parent confirm -> fetch protocol",
  description: "Bind the shared compact-dispatch lifecycle to the Codex child boundary.",
  acceptance: "Native/fallback fixtures cover the full matrix and the fetch states.",
  worktreePath: "/tmp/wt-T690",
  branch: "implement/T690",
  baseCommit: "695c9f89d5bba3f11681534ab9ecddc70d36f571",
};

/**
 * A DISTINCTIVE, large structured output — tasks:T713's probe shape. Its size is
 * the point: `fetch_dispatch_result` must be the only surface that ever renders
 * it, so section 5 measures where it does and does not appear.
 */
const OUTPUT: DispatchJSONValue = {
  taskId: "T690",
  status: "pass",
  resultCommit: "695c9f89d5bba3f11681534ab9ecddc70d36f571",
  branch: "implement/T690",
  filesTouched: ["packages/cq-config/src/codexDispatchProtocol.ts"],
  checkSummary: "matrix green",
  summary: `CODEX-BODY-SENTINEL ${"payload ".repeat(600)}`.trim(),
};

const INVALID_OUTPUT: DispatchJSONValue = { taskId: "T690", status: "not-a-status" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly clock: FakeDispatchClock;
  readonly store: InMemoryAttestationStore;
  readonly deps: DispatchServiceDeps;
  readonly prepareDeps: PrepareDispatchDeps;
}

function harness(
  options: {
    readonly start?: string;
    readonly fault?: (operation: AttestationStoreOperation) => void;
    readonly seed?: number;
  } = {},
): Harness {
  const clock = new FakeDispatchClock(options.start ?? T0);
  const store =
    options.fault === undefined
      ? new InMemoryAttestationStore(NAMESPACE)
      : new InMemoryAttestationStore(NAMESPACE, options.fault);
  return {
    clock,
    store,
    deps: { store, now: clock.now },
    prepareDeps: {
      store,
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(options.seed ?? 7),
    },
  };
}

/**
 * Prepare through the REAL service, with `expectedChild` derived from the Codex
 * correlation — which is the whole point of `codexExpectedChild`: the shared
 * store, not just this module, is what refuses a mismatched child.
 */
function prepareCodex(
  h: Harness,
  overrides: Readonly<Record<string, unknown>> = {},
  correlation: CodexChildCorrelation = CORRELATION,
): DispatchPrepared {
  const request = {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    surface: "codex",
    input: INPUT,
    idempotencyKey: "T690-round-0",
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
    expectedChild: codexExpectedChild(correlation),
    ...overrides,
  } as PrepareDispatchRequest;
  const outcome = prepareDispatch(request, h.prepareDeps);
  if (!outcome.accepted) {
    throw new Error(`expected a prepared dispatch, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome.prepared;
}

function handleOf(prepared: DispatchPrepared): DispatchHandle {
  return { attestationId: prepared.attestationId, generation: prepared.generation };
}

/** The handle-only reply a conformant child emits, as JSON text. */
function handleOnlyReply(handle: DispatchHandle): string {
  return JSON.stringify({ attestationId: handle.attestationId, generation: handle.generation });
}

function observation(
  mode: CodexDeliveryMode,
  handle: DispatchHandle,
  overrides: Partial<CodexCompletionObservation> = {},
): CodexCompletionObservation {
  return {
    source: "transport",
    mode,
    agentType: CORRELATION.agentType,
    correlationId: CORRELATION.correlationId,
    threadId: CORRELATION.threadId,
    outcome: "completed",
    finalMessage: handleOnlyReply(handle),
    observedAt: "2026-07-28T12:04:00.000Z",
    ...(mode === CODEX_FALLBACK_DELIVERY_MODE ? { exitStatus: 0 } : {}),
    ...overrides,
  };
}

/** Both supported modes, so every fixture below runs on native AND fallback. */
const MODES: readonly CodexDeliveryMode[] = [
  CODEX_NATIVE_DELIVERY_MODE,
  CODEX_FALLBACK_DELIVERY_MODE,
];

// ---------------------------------------------------------------------------
// 1. Delivery-mode classification
// ---------------------------------------------------------------------------

describe("T690 §1 — which Codex delivery modes can satisfy the contract", () => {
  test("exactly two modes are supported, and the classification is total", () => {
    expect([...CODEX_DELIVERY_MODES.keys()].sort()).toEqual([...CODEX_DELIVERY_MODE_IDS].sort());
    expect([...SUPPORTED_CODEX_DELIVERY_MODES]).toEqual(["native-agent", "exec-intercepted"]);
    expect([...UNSUPPORTED_CODEX_DELIVERY_MODES]).toEqual([
      "skill-reference",
      "project-agents-dir",
      "agents-config-file",
      "profile-selected",
      "no-tools-exec",
      "raw-exec-stdout",
    ]);
    expect(
      SUPPORTED_CODEX_DELIVERY_MODES.length + UNSUPPORTED_CODEX_DELIVERY_MODES.length,
    ).toBe(CODEX_DELIVERY_MODE_IDS.length);
  });

  test("every mode's verdict cites the measurement or upstream defect that decided it", () => {
    // A verdict without evidence is an opinion. defects:D178's FIRST root cause
    // was refuted by measurement, so "cites its evidence" is the guard that
    // stops the same class of unmeasured claim landing again.
    for (const mode of CODEX_DELIVERY_MODE_IDS) {
      const verdict = CODEX_DELIVERY_MODES.get(mode)!;
      expect(verdict.mode).toBe(mode);
      expect(verdict.evidence.length).toBeGreaterThan(80);
      expect(verdict.evidence).toMatch(
        /researches:RS1[01]|tasks:T713|defects:D17[358]|openai\/codex#26408/,
      );
    }
  });

  test("only supported modes declare a completion actor, and each is the right one", () => {
    // native-agent: the Codex parent session itself confirms.
    expect(codexCompletionActor("native-agent")).toBe("trusted-parent");
    // exec-intercepted: the trusted interceptor process confirms, not a model turn.
    expect(codexCompletionActor("exec-intercepted")).toBe("trusted-extension");
    for (const mode of UNSUPPORTED_CODEX_DELIVERY_MODES) {
      expect(CODEX_DELIVERY_MODES.get(mode)!.completionActor).toBeUndefined();
    }
  });

  test("each unsupported mode is refused BY NAME, with its reason, before any child exists", () => {
    for (const mode of UNSUPPORTED_CODEX_DELIVERY_MODES) {
      expect(isSupportedCodexDeliveryMode(mode)).toBe(false);
      let thrown: unknown;
      try {
        assertSupportedCodexDeliveryMode(mode);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CodexUnsupportedModeError);
      const failure = thrown as CodexUnsupportedModeError;
      expect(failure.mode).toBe(mode);
      expect(failure.evidence).toBe(CODEX_DELIVERY_MODES.get(mode)!.evidence);
    }
  });

  test("an unknown mode name is refused too, and prototype names are not modes", () => {
    for (const name of ["", "spawn_agent", "constructor", "toString", "__proto__"]) {
      expect(isSupportedCodexDeliveryMode(name)).toBe(false);
      expect(() => assertSupportedCodexDeliveryMode(name)).toThrow(CodexUnsupportedModeError);
    }
  });

  test("an unsupported mode can never be reported as an abort reason", () => {
    // The classification is a REFUSAL, not a lifecycle outcome: a mode failure
    // must not read like a child failure. Nothing in the abort vocabulary names
    // a delivery mode.
    for (const mode of CODEX_DELIVERY_MODE_IDS) {
      expect(DISPATCH_ABORT_REASONS as readonly string[]).not.toContain(mode);
    }
  });

  test("the native mode's requirements match what researches:RS11 measured", () => {
    // The GLOBAL agents dir, never project-scoped (openai/codex#26408 is OPEN).
    expect(CODEX_GLOBAL_AGENTS_DIR).toBe("agents");
    expect([...CODEX_NATIVE_AGENT_DECLARATION_KEYS]).toEqual([
      "name",
      "description",
      "developer_instructions",
    ]);
    const projectScoped = CODEX_DELIVERY_MODES.get("project-agents-dir")!;
    expect(projectScoped.supported).toBe(false);
    expect(projectScoped.evidence).toContain("openai/codex#26408");
  });
});

// ---------------------------------------------------------------------------
// 2. Parent-minted correlation
// ---------------------------------------------------------------------------

describe("T690 §2 — correlation is parent-minted and transport-read", () => {
  test("a minted nonce is a well-formed correlation id of the declared width", () => {
    const id = mintCodexCorrelationId(sequentialDispatchRandomBytes(3));
    expect(CODEX_CORRELATION_ENTROPY_BYTES).toBe(24);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(() =>
      assertCodexChildCorrelation({ ...CORRELATION, correlationId: id }),
    ).not.toThrow();
  });

  test("a short-changed entropy source is refused rather than producing a weak nonce", () => {
    expect(() => mintCodexCorrelationId(() => new Uint8Array(4))).toThrow(
      AttestationContractError,
    );
  });

  test("an unknown agentType is refused HERE — the structural answer to T713's fail-open --profile", () => {
    // tasks:T713: `codex exec --profile <unknown>` is SILENTLY IGNORED and
    // proceeds on the base config, and --strict-config does not close it. This
    // module never lets an unknown role name reach a launch.
    for (const agentType of ["", "not-a-role", "constructor", "toString", "plan/advance"]) {
      expect(() => assertCodexChildCorrelation({ ...CORRELATION, agentType })).toThrow(
        AttestationContractError,
      );
    }
    // ...while every real dispatched role id is accepted.
    for (const roleId of DISPATCHED_ROLE_IDS) {
      expect(assertCodexChildCorrelation({ ...CORRELATION, agentType: roleId }).agentType).toBe(
        roleId,
      );
    }
  });

  test("a weak or absent nonce and an empty thread id are refused", () => {
    expect(() => assertCodexChildCorrelation({ ...CORRELATION, correlationId: "short" })).toThrow(
      AttestationContractError,
    );
    expect(() => assertCodexChildCorrelation({ ...CORRELATION, threadId: "  " })).toThrow(
      AttestationContractError,
    );
  });

  test("the childId binds BOTH the role and the nonce, so the STORE refuses a wrong-role child", () => {
    const child = codexExpectedChild(CORRELATION);
    expect(child.childId).toBe(`${ROLE_ID}${CODEX_CORRELATION_SEPARATOR}${CORRELATION_ID}`);
    expect(child.runId).toBe(THREAD_ID);
    // Two children of the same role in the same thread are distinguishable...
    const sibling = codexExpectedChild({
      ...CORRELATION,
      correlationId: mintCodexCorrelationId(sequentialDispatchRandomBytes(11)),
    });
    expect(sibling.childId).not.toBe(child.childId);
    // ...and so are two roles sharing a nonce.
    expect(codexExpectedChild({ ...CORRELATION, agentType: "implement-reviewer" }).childId).not.toBe(
      child.childId,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The launch gate: delayed prepare, refusal, skew, remaining window
// ---------------------------------------------------------------------------

describe("T690 §3 — the launch gate", () => {
  const h = harness();
  const prepared = prepareCodex(h);

  test("a prompt launch is approved for the CONSERVATIVE remaining window", () => {
    const verdict = codexLaunchGate(prepared, T0);
    expect(verdict.launch).toBe(true);
    if (!verdict.launch) throw new Error("unreachable");
    // The child is given until responseStoreNow, NOT until childCancelAt: a
    // child told to work to the cancel instant has no budget left to store in.
    expect(verdict.childWindowMs).toBe(TIMEOUT_MS - RESPONSE_STORE_LEAD_MS);
    expect(verdict.cancelWindowMs).toBe(TIMEOUT_MS);
    expect(verdict.childWindowMs).toBeLessThan(verdict.cancelWindowMs);
  });

  test("a DELAYED launch gets a correspondingly SMALLER window, not the original timeout", () => {
    const delayMs = 45_000;
    const verdict = codexLaunchGate(prepared, new Date(T0_MS + delayMs).toISOString());
    expect(verdict.launch).toBe(true);
    if (!verdict.launch) throw new Error("unreachable");
    expect(verdict.childWindowMs).toBe(TIMEOUT_MS - RESPONSE_STORE_LEAD_MS - delayMs);
  });

  test("delayed prepare → REFUSAL once the launch budget has lapsed", () => {
    const atOrAfter = new Date(T0_MS + LAUNCH_DEADLINE_MS).toISOString();
    const verdict = codexLaunchGate(prepared, atOrAfter);
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("launch-budget-lapsed");
    expect(verdict.abortReason).toBe("deadline-exceeded");
    // Exactly AT the deadline already refuses — the boundary is inclusive.
    expect(codexLaunchGate(prepared, new Date(T0_MS + LAUNCH_DEADLINE_MS - 1).toISOString()).launch).toBe(
      true,
    );
  });

  test("a launch instant PRECEDING the prepare instant is clock-skew, not a bigger window", () => {
    const verdict = codexLaunchGate(prepared, new Date(T0_MS - 1).toISOString());
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("clock-skew");
    expect(verdict.abortReason).toBe("protocol-violation");
    expect(verdict.detail).toContain("must be evaluated on the clock that prepared");
  });

  test("skew CANNOT change a lifecycle outcome: the child gets a duration, never an instant", () => {
    // The approved verdict carries only DURATIONS. A child whose clock is hours
    // off still stops after the right elapsed time, and every lifecycle decision
    // is taken on the service clock — which is why §4's fixtures can hand
    // `store_result` a wildly skewed child instant without changing anything.
    const verdict = codexLaunchGate(prepared, T0);
    if (!verdict.launch) throw new Error("unreachable");
    expect(Object.keys(verdict).sort()).toEqual(["cancelWindowMs", "childWindowMs", "launch"]);
    for (const value of [verdict.childWindowMs, verdict.cancelWindowMs]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  test("a response window too small to store in is refused before the cancel window lapses", () => {
    // Minimum timeout: responseStoreNow and launchDeadline coincide at +30s/+60s,
    // so there is a real interval in which launching is pointless.
    const short = harness({ seed: 21 });
    const p = prepareCodex(short, { timeoutMs: DISPATCH_TIMEOUT_MIN_MS, idempotencyKey: "T690-min" });
    const atMs = T0_MS + DISPATCH_TIMEOUT_MIN_MS - RESPONSE_STORE_LEAD_MS;
    const verdict = codexLaunchGate(p, new Date(atMs).toISOString());
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("response-window-lapsed");
    expect(verdict.abortReason).toBe("deadline-exceeded");
  });

  test("every declared refusal maps to a real abort reason", () => {
    expect([...CODEX_LAUNCH_REFUSALS]).toEqual([
      "launch-budget-lapsed",
      "response-window-lapsed",
      "child-window-lapsed",
      "clock-skew",
    ]);
    const seen = new Set<string>();
    for (const at of [
      new Date(T0_MS - 1).toISOString(),
      new Date(T0_MS + LAUNCH_DEADLINE_MS).toISOString(),
    ]) {
      const verdict = codexLaunchGate(prepared, at);
      if (verdict.launch) throw new Error("unreachable");
      expect(DISPATCH_ABORT_REASONS as readonly string[]).toContain(verdict.abortReason);
      seen.add(verdict.refusal);
    }
    expect(seen.size).toBe(2);
  });

  test("a refused launch has allocated nothing beyond the prepared record", () => {
    // The refusal is a decision, not a mutation: the gate is pure.
    const before = h.store.snapshot().length;
    codexLaunchGate(prepared, new Date(T0_MS + LAUNCH_DEADLINE_MS).toISOString());
    expect(h.store.snapshot().length).toBe(before);
    expect(fetchDispatchResult(
      { ...handleOf(prepared), namespace: NAMESPACE, actor: "trusted-parent" },
      h.deps,
    ).state).toBe("prepared");
  });
});
