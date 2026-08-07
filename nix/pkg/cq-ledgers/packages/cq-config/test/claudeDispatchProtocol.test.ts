/**
 * T687 — the Claude `prepare → child store_result → parent confirm → fetch`
 * protocol, exercised as a FIXTURE MATRIX over both supported delivery modes
 * (`native-subagent` for same-harness dispatch, `wrapper-shellout` for
 * cross-harness), mirroring its Codex sibling's structure deliberately.
 *
 * Three design choices about what is asserted here:
 *
 *  - The lifecycle is the SHARED service's (T685/T686/T720). These fixtures drive
 *    the real `prepareDispatch` / `storeDispatchResult` /
 *    `confirmDispatchCompletion` / `abortDispatch` / `fetchDispatchResult`
 *    against the strict in-memory store, so a Claude-specific claim is only
 *    believable if the shared lifecycle actually produces it. Nothing is
 *    re-implemented or stubbed on the lifecycle side.
 *  - Every Claude-specific decision is a PURE function of transport evidence, so
 *    each row is a deterministic assertion rather than a live Claude run. The
 *    live evidence justifying the design lives in tasks:T722, and §1's mode
 *    classification quotes its measurements.
 *  - §3 carries a DIFFERENTIAL guard against the Codex surface's launch gate, and
 *    §6 carries the decisions:K170 × questions:Q363 reconciliation as a
 *    DERIVATION through the real prepare rather than as prose.
 */

import { describe, expect, test } from "bun:test";
import {
  AttestationBindingError,
  AttestationContractError,
  AttestationStorageError,
  AttestationTransportError,
  CLAUDE_ACCEPTED_RESIDUALS,
  CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY,
  CLAUDE_NATIVE_REGISTRATION_POLICY,
  CLAUDE_CHILD_OUTCOMES,
  CLAUDE_COMPLETED_TERMINAL_REASON,
  CLAUDE_CONTAINMENT_PROFILES,
  CLAUDE_CORRELATION_ENTROPY_BYTES,
  CLAUDE_CORRELATION_PROVENANCES,
  CLAUDE_CORRELATION_SEPARATOR,
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
  CLAUDE_DELIVERY_MODES,
  CLAUDE_DELIVERY_MODE_IDS,
  CLAUDE_DISPATCHER_CLASSES,
  CLAUDE_DISPATCH_DEFERRED,
  CLAUDE_DISPATCH_DEFERRED_TO,
  CLAUDE_DISPATCH_PROVEN_BY,
  CLAUDE_ENFORCEMENT_STRENGTHS,
  CLAUDE_EXIT_CORROBORATIONS,
  CLAUDE_FETCH_SEMANTICS_ASSUMED,
  CLAUDE_FINAL_MESSAGE_VERDICTS,
  CLAUDE_LAUNCH_REFUSALS,
  CLAUDE_MODE_WORKTREE_PLACEMENTS,
  CLAUDE_NATIVE_DELIVERY_MODE,
  CLAUDE_NATIVE_ENFORCEMENT_GAP,
  CLAUDE_NATIVE_ISOLATION_ARGUMENT,
  CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  CLAUDE_RESIDUAL_ACCEPTANCE_QUOTE,
  CLAUDE_WORKTREE_ADDRESSING,
  CLAUDE_WORKTREE_INPUT_PROPERTY,
  CLAUDE_WORKTREE_PLACEMENTS,
  CLAUDE_WORKTREE_RECONCILIATION,
  CLAUDE_WORKTREE_RESUME_IS_BY_HANDLE,
  ClaudeObservationProvenanceError,
  ClaudeUnsupportedModeError,
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
  SUPPORTED_CLAUDE_DELIVERY_MODES,
  TERMINAL_ENVELOPE_RETENTION_MS,
  UNSUPPORTED_CLAUDE_DELIVERY_MODES,
  abortDispatch,
  assertClaudeChildCorrelation,
  assertSupportedClaudeDeliveryMode,
  classifyClaudeFinalMessage,
  claudeChildOutcome,
  claudeCompletionActor,
  claudeContainmentProfile,
  claudeCorrelationProvenance,
  claudeDeliveryModeFor,
  claudeExitCorroboration,
  claudeExpectedChild,
  claudeLaunchGate,
  claudeTerminalOutcome,
  claudeWorktreePlacement,
  codexLaunchGate,
  confirmDispatchCompletion,
  decideClaudeCompletion,
  fetchDispatchResult,
  isSupportedClaudeDeliveryMode,
  mintClaudeLaunchNonce,
  prepareDispatch,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  sweepAttestations,
  type AbortedDispatchResult,
  type AttestationNamespace,
  type AttestationStoreOperation,
  type ClaudeChildCorrelation,
  type ClaudeCompletionObservation,
  type ClaudeContainmentProfile,
  type ClaudeDeliveryMode,
  type ClaudeLaunchRefusal,
  type ClaudeLaunchVerdict,
  type ClaudeTerminalSignal,
  type DispatchDeadlines,
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
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const TIMEOUT_MS = 600_000;
const ROLE_ID = "implement-worker";
/** A UUID, the only shape `claude --session-id` accepts. */
const SESSION_ID = "1dea1c87-a984-448b-b038-d0078741a669";
/** A 32-char base64url nonce, the shape `mintClaudeLaunchNonce` produces. */
const LAUNCH_NONCE = "Y2xhdWRlbGF1bmNobm9uY2VmaXh0dXJl";

const CORRELATION: ClaudeChildCorrelation = {
  roleId: ROLE_ID,
  launchNonce: LAUNCH_NONCE,
  sessionId: SESSION_ID,
};

/** The orchestrator-prepared worktree from questions:Q363 — a UUID-named fresh tree. */
const WORKTREE_PATH = "/tmp/cq-worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";

const INPUT: DispatchJSONValue = {
  taskId: "T687",
  headline: "Define the Claude ref-first prepare -> store -> confirm -> fetch protocol",
  description: "Bind the shared compact-dispatch lifecycle to the Claude child boundary.",
  acceptance: "Native/wrapper fixtures cover the full matrix and the fetch states.",
  worktreePath: WORKTREE_PATH,
  branch: "implement/T687",
  baseCommit: "936bfa146d99b9dc42da116d94420c1d23921bae",
  round: 0,
  startingCommit: "936bfa146d99b9dc42da116d94420c1d23921bae",
};

/**
 * A DISTINCTIVE, large structured output. Its size is the point: the acceptance
 * requires that it and the store arguments stay outside orchestrator context
 * until ONE fetch, so §5 measures where the sentinel does and does not appear.
 *
 * `gateDurationMs` is REQUIRED on a `status: "pass"` implement-worker result
 * (T894); without it the store would reject this payload as `invalid-output` and
 * every §5 fixture would abort instead of reaching `result-stored`.
 * `filesTouched` deliberately names only the SOURCE module — adding this test
 * file would match T894's TEST_GUARD_GLOBS and make `mutationTable` required.
 */
const OUTPUT: DispatchJSONValue = {
  taskId: "T687",
  status: "pass",
  resultCommit: "936bfa146d99b9dc42da116d94420c1d23921bae",
  branch: "implement/T687",
  actualWorktreePath: "/tmp/wt-actual",
  filesTouched: ["packages/cq-config/src/claudeDispatchProtocol.ts"],
  gateDurationMs: 512_300,
  checkSummary: "matrix green",
  summary: `CLAUDE-BODY-SENTINEL ${"payload ".repeat(600)}`.trim(),
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  },
};

const INVALID_OUTPUT: DispatchJSONValue = { taskId: "T687", status: "not-a-status" };

/** The terminal signal a healthy child's turn produces. */
const TERMINAL_OK: ClaudeTerminalSignal = {
  subtype: "success",
  isError: false,
  terminalReason: CLAUDE_COMPLETED_TERMINAL_REASON,
};

/**
 * tasks:T722 §7.1 #4, verbatim: a bogus model produced
 * `{"subtype":"success","is_error":true,…,"terminal_reason":"api_error"}` with
 * exit code 1. The whole point of `claudeTerminalOutcome` is that this is a
 * FAILURE despite `subtype: "success"`.
 */
const TERMINAL_API_ERROR: ClaudeTerminalSignal = {
  subtype: "success",
  isError: true,
  terminalReason: "api_error",
  exitStatus: 1,
};

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
      randomBytes: sequentialDispatchRandomBytes(options.seed ?? 11),
    },
  };
}

function prepareRequest(
  overrides: Readonly<Record<string, unknown>> = {},
  correlation: ClaudeChildCorrelation = CORRELATION,
): PrepareDispatchRequest {
  return {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    surface: "claude",
    input: INPUT,
    idempotencyKey: "T687-round-0",
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
    expectedChild: claudeExpectedChild(correlation),
    ...overrides,
  } as PrepareDispatchRequest;
}

/**
 * Prepare through the REAL service, with `expectedChild` derived from the Claude
 * correlation — which is the whole point of `claudeExpectedChild`: the shared
 * store, not just this module, is what refuses a mismatched child.
 */
function prepareClaude(
  h: Harness,
  overrides: Readonly<Record<string, unknown>> = {},
  correlation: ClaudeChildCorrelation = CORRELATION,
): DispatchPrepared {
  const outcome = prepareDispatch(prepareRequest(overrides, correlation), h.prepareDeps);
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
  mode: ClaudeDeliveryMode,
  handle: DispatchHandle,
  overrides: Partial<ClaudeCompletionObservation> = {},
): ClaudeCompletionObservation {
  return {
    source: "transport",
    mode,
    roleId: CORRELATION.roleId,
    launchNonce: CORRELATION.launchNonce,
    sessionId: CORRELATION.sessionId,
    cancelled: false,
    // The wrapper path has a subprocess and therefore an exit status; the native
    // path has neither, which `claudeExitCorroboration` reports as `unavailable`.
    terminal:
      mode === CLAUDE_CROSS_HARNESS_DELIVERY_MODE ? { ...TERMINAL_OK, exitStatus: 0 } : TERMINAL_OK,
    finalMessage: handleOnlyReply(handle),
    observedAt: "2026-07-28T12:04:00.000Z",
    ...overrides,
  };
}

/** Both supported modes, so every §5 fixture runs on native AND wrapper. */
const MODES: readonly ClaudeDeliveryMode[] = [
  CLAUDE_NATIVE_DELIVERY_MODE,
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
];

// ---------------------------------------------------------------------------
// 1. Delivery-mode classification and the decisions:K170 harness axis
// ---------------------------------------------------------------------------

describe("T687 §1 — which Claude delivery modes can satisfy the contract", () => {
  test("exactly two modes are supported, and the classification is total", () => {
    expect([...CLAUDE_DELIVERY_MODES.keys()].sort()).toEqual([...CLAUDE_DELIVERY_MODE_IDS].sort());
    expect([...SUPPORTED_CLAUDE_DELIVERY_MODES]).toEqual(["native-subagent", "wrapper-shellout"]);
    expect([...UNSUPPORTED_CLAUDE_DELIVERY_MODES]).toEqual([
      "background-native-subagent",
      "inherited-mcp-tool",
      "raw-print-stdout",
      "post-tool-use-rewrite",
      "setting-sources-isolated",
    ]);
    // Total: every declared id has a verdict, and every verdict a declared id.
    expect(CLAUDE_DELIVERY_MODES.size).toBe(CLAUDE_DELIVERY_MODE_IDS.length);
  });

  test("every mode's verdict cites the tasks:T722 measurement that decided it", () => {
    for (const mode of CLAUDE_DELIVERY_MODE_IDS) {
      const verdict = CLAUDE_DELIVERY_MODES.get(mode);
      expect(verdict).toBeDefined();
      if (verdict === undefined) throw new Error("unreachable");
      expect(verdict.mode).toBe(mode);
      // Substantive, and traceable to an item rather than to an opinion.
      expect(verdict.evidence.length).toBeGreaterThan(120);
      expect(verdict.evidence).toMatch(/tasks:T\d+|decisions:K\d+|defects:D\d+|questions:Q\d+/);
    }
  });

  test("THE HARNESS AXIS (decisions:K170): the dispatcher's harness picks the transport", () => {
    // Same harness -> native, no shellout.
    expect(claudeDeliveryModeFor("claude")).toBe(CLAUDE_NATIVE_DELIVERY_MODE);
    // Cross harness -> wrapper shellout.
    for (const dispatcher of ["codex", "pi"]) {
      expect(claudeDeliveryModeFor(dispatcher)).toBe(CLAUDE_CROSS_HARNESS_DELIVERY_MODE);
    }
    // And the two modes declare the dispatcher class that selects them, so the
    // axis is readable off the classification and not only off the selector.
    expect(CLAUDE_DELIVERY_MODES.get(CLAUDE_NATIVE_DELIVERY_MODE)?.dispatcherClass).toBe(
      "same-harness",
    );
    expect(CLAUDE_DELIVERY_MODES.get(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)?.dispatcherClass).toBe(
      "cross-harness",
    );
    expect([...CLAUDE_DISPATCHER_CLASSES].sort()).toEqual(["cross-harness", "same-harness"]);
  });

  test("K170: there is NO shellout fallback for the same-harness path", () => {
    // The selector is TOTAL on the claude dispatcher: no input to it, and no
    // containment outcome, can turn a same-harness dispatch into a shellout.
    // Falling back would silently reverse a user decision.
    expect(claudeDeliveryModeFor("claude")).not.toBe(CLAUDE_CROSS_HARNESS_DELIVERY_MODE);
    const profile = claudeContainmentProfile(CLAUDE_NATIVE_DELIVERY_MODE);
    expect(profile.handleOnlyOutput).toBe("prompt-best-effort");
    // Even with the weakest profile, the mode for a claude dispatcher is native.
    expect(claudeDeliveryModeFor("claude")).toBe(CLAUDE_NATIVE_DELIVERY_MODE);
  });

  test("only supported modes declare an actor/class/containment, and each is the right one", () => {
    for (const mode of CLAUDE_DELIVERY_MODE_IDS) {
      const verdict = CLAUDE_DELIVERY_MODES.get(mode);
      if (verdict?.supported === true) {
        expect(verdict.completionActor).toBeDefined();
        expect(verdict.dispatcherClass).toBeDefined();
        expect(verdict.containment).toBeDefined();
      } else {
        expect(verdict?.completionActor).toBeUndefined();
        expect(verdict?.dispatcherClass).toBeUndefined();
        expect(verdict?.containment).toBeUndefined();
      }
    }
    // A native child is confirmed by the parent itself; a wrapper child by the
    // trusted non-model process that read its stream.
    expect(claudeCompletionActor(CLAUDE_NATIVE_DELIVERY_MODE)).toBe("trusted-parent");
    expect(claudeCompletionActor(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)).toBe("trusted-extension");
  });

  test("each unsupported mode is refused BY NAME, with its reason, before any child exists", () => {
    for (const mode of UNSUPPORTED_CLAUDE_DELIVERY_MODES) {
      expect(isSupportedClaudeDeliveryMode(mode)).toBe(false);
      let raised: unknown;
      try {
        assertSupportedClaudeDeliveryMode(mode);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(ClaudeUnsupportedModeError);
      const error = raised as ClaudeUnsupportedModeError;
      expect(error.mode).toBe(mode);
      const verdict = CLAUDE_DELIVERY_MODES.get(mode);
      // Fail loudly rather than comparing against `undefined`: an unsupported
      // mode with no verdict would make the next assertion vacuously true.
      if (verdict === undefined) throw new Error(`mode "${mode}" declares no verdict`);
      // The refusal carries the measured reason, not a bare rejection.
      expect(error.evidence).toBe(verdict.evidence);
      expect(error.message).toContain(mode);
    }
  });

  test("an unknown mode name is refused too, and prototype names are not modes", () => {
    for (const bogus of ["", "constructor", "toString", "__proto__", "native", "claude"]) {
      expect(isSupportedClaudeDeliveryMode(bogus)).toBe(false);
      expect(() => assertSupportedClaudeDeliveryMode(bogus)).toThrow(ClaudeUnsupportedModeError);
    }
  });

  test("an unsupported mode can never be reported as an abort reason", () => {
    // The distinction that matters operationally: a mode failure is an AUTHORING
    // defect and must not read like a child failure.
    for (const mode of [...UNSUPPORTED_CLAUDE_DELIVERY_MODES, "nonsense"]) {
      expect(DISPATCH_ABORT_REASONS as readonly string[]).not.toContain(mode);
    }
    expect(DISPATCH_ABORT_REASONS as readonly string[]).not.toContain("unsupported-mode");
  });

  test("BACKGROUND is unsupported, and the native mode pins the two launch arguments", () => {
    // The genuinely new derived constraint: background is the harness DEFAULT, so
    // a native ref-first dispatch must opt out of it explicitly.
    expect(isSupportedClaudeDeliveryMode("background-native-subagent")).toBe(false);
    expect(CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT).toBe(false);
    // And it must keep the harness OUT of worktree allocation (defects:D119).
    expect(CLAUDE_NATIVE_ISOLATION_ARGUMENT).toBe("none");
    expect(CLAUDE_NATIVE_ISOLATION_ARGUMENT).not.toBe("worktree");
  });

  test("the native enforcement gap is recorded WITH its flip condition", () => {
    // Not a complaint: a specific upstream change, so T688/T689 can re-test on a
    // version bump instead of rediscovering the boundary.
    expect(CLAUDE_NATIVE_ENFORCEMENT_GAP.missing).toBe("per-subagent-output-schema");
    expect(CLAUDE_NATIVE_ENFORCEMENT_GAP.probedVersion).toBe("2.1.220");
    expect(CLAUDE_NATIVE_ENFORCEMENT_GAP.flipCondition).toContain("re-test");
    expect(CLAUDE_NATIVE_ENFORCEMENT_GAP.evidence).toContain("tasks:T722");
  });
});

// ---------------------------------------------------------------------------
// 1b. The containment profiles and the decisions:K170 accepted residual
// ---------------------------------------------------------------------------

describe("T687 §1b — containment strength is per-mode, and the residual is named", () => {
  test("the strength vocabulary is closed and the store path is structural on BOTH modes", () => {
    expect([...CLAUDE_ENFORCEMENT_STRENGTHS]).toEqual(["structural", "prompt-best-effort"]);
    for (const mode of SUPPORTED_CLAUDE_DELIVERY_MODES) {
      // The invariant: the capability path never depends on child compliance.
      // tasks:T722 §8.1a measured it natively; §6.2 measured it on the wrapper.
      expect(claudeContainmentProfile(mode).resultStorage).toBe("structural");
    }
  });

  test("the WRAPPER path is structural on both containment properties", () => {
    const profile = claudeContainmentProfile(CLAUDE_CROSS_HARNESS_DELIVERY_MODE);
    expect(profile.handleOnlyOutput).toBe("structural");
    expect(profile.worktreeConfinement).toBe("structural");
  });

  test("the NATIVE path is best-effort on both; K170 accepted ONLY handleOnlyOutput", () => {
    const profile = claudeContainmentProfile(CLAUDE_NATIVE_DELIVERY_MODE);
    expect(profile.handleOnlyOutput).toBe("prompt-best-effort");
    expect(profile.worktreeConfinement).toBe("prompt-best-effort");
    // K170 acceptance quote covers handle-only output, NOT write confinement.
    expect(CLAUDE_RESIDUAL_ACCEPTANCE_QUOTE).toBe("on Q366, the tradeoff is acceptable");
    expect([...CLAUDE_ACCEPTED_RESIDUALS]).toEqual(["native-subagent.handleOnlyOutput"]);
    expect([...CLAUDE_ACCEPTED_RESIDUALS]).not.toContain("native-subagent.worktreeConfinement");
    // D263 tracks write confinement as an OPEN incompatibility, not a K170 residual.
    expect(CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY.k170AcceptedWriteConfinement).toBe(
      false,
    );
    expect(CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY.coordinate).toBe(
      "native-subagent.worktreeConfinement",
    );
    expect(CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY.defect).toBe("D263");
    expect(CLAUDE_NATIVE_REGISTRATION_POLICY).toBe(
      "positive-only-harness-owned-worktree-manage",
    );
  });

  test("THE GUARD: K170 accepted residuals are a STRICT SUBSET of best-effort coordinates", () => {
    // K170 does NOT accept every best-effort coordinate. Write confinement is
    // best-effort as a measured fact but is D263's open incompatibility.
    const derived = derivedResiduals(CLAUDE_CONTAINMENT_PROFILES);
    expect(derived).toEqual([
      "native-subagent.handleOnlyOutput",
      "native-subagent.worktreeConfinement",
    ]);
    expect([...CLAUDE_ACCEPTED_RESIDUALS].sort()).toEqual(["native-subagent.handleOnlyOutput"]);
    for (const accepted of CLAUDE_ACCEPTED_RESIDUALS) {
      expect(derived).toContain(accepted);
    }
    // No test may claim K170 accepted write-confinement residual.
    expect(JSON.stringify(CLAUDE_ACCEPTED_RESIDUALS)).not.toMatch(/worktreeConfinement/i);
    expect(JSON.stringify(CLAUDE_ACCEPTED_RESIDUALS)).not.toMatch(/write.?confinement/i);
  });

  test("the guard is not a no-op: the DERIVATION reads the profiles it is given", () => {
    // NEGATIVE CONTROL. Two mutants, each of which the real guard must reject —
    // this exercises `derivedResiduals`, rather than asserting a string on a
    // literal.
    const weakenedWrapper = new Map<ClaudeDeliveryMode, ClaudeContainmentProfile>([
      [CLAUDE_NATIVE_DELIVERY_MODE, claudeContainmentProfile(CLAUDE_NATIVE_DELIVERY_MODE)],
      [
        CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
        {
          ...claudeContainmentProfile(CLAUDE_CROSS_HARNESS_DELIVERY_MODE),
          handleOnlyOutput: "prompt-best-effort",
        },
      ],
    ]);
    expect(derivedResiduals(weakenedWrapper)).toEqual([
      "native-subagent.handleOnlyOutput",
      "native-subagent.worktreeConfinement",
      "wrapper-shellout.handleOnlyOutput",
    ]);
    // Weakened wrapper still differs from the K170-accepted set (handleOnly only).
    expect(derivedResiduals(weakenedWrapper)).not.toEqual([...CLAUDE_ACCEPTED_RESIDUALS].sort());
    expect([...CLAUDE_ACCEPTED_RESIDUALS]).not.toContain("wrapper-shellout.handleOnlyOutput");

    const strengthenedNative = new Map<ClaudeDeliveryMode, ClaudeContainmentProfile>([
      [
        CLAUDE_NATIVE_DELIVERY_MODE,
        {
          ...claudeContainmentProfile(CLAUDE_NATIVE_DELIVERY_MODE),
          handleOnlyOutput: "structural",
          worktreeConfinement: "structural",
        },
      ],
      [
        CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
        claudeContainmentProfile(CLAUDE_CROSS_HARNESS_DELIVERY_MODE),
      ],
    ]);
    // The flip condition's shape: no residuals left to accept.
    expect(derivedResiduals(strengthenedNative)).toEqual([]);
  });
});

/**
 * Every `<mode>.<property>` coordinate whose strength is `prompt-best-effort`,
 * derived from a profile map. Kept parameterised precisely so the negative
 * control above can feed it mutants.
 */
function derivedResiduals(
  profiles: ReadonlyMap<ClaudeDeliveryMode, ClaudeContainmentProfile>,
): readonly string[] {
  const out: string[] = [];
  for (const [mode, profile] of profiles) {
    for (const property of ["handleOnlyOutput", "worktreeConfinement"] as const) {
      if (profile[property] === "prompt-best-effort") out.push(`${mode}.${property}`);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 2. Correlation is parent-minted and transport-read
// ---------------------------------------------------------------------------

describe("T687 §2 — correlation is parent-minted, and its provenance differs by mode", () => {
  test("a minted nonce is a well-formed launch nonce of the declared width", () => {
    const nonce = mintClaudeLaunchNonce(sequentialDispatchRandomBytes(3));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(CLAUDE_CORRELATION_ENTROPY_BYTES).toBe(24);
    // Distinct draws give distinct nonces, so two children of the same role in
    // one session are distinguishable.
    const other = mintClaudeLaunchNonce(sequentialDispatchRandomBytes(4));
    expect(other).not.toBe(nonce);
  });

  test("a short-changed entropy source is refused rather than producing a weak nonce", () => {
    expect(() => mintClaudeLaunchNonce(() => new Uint8Array(4))).toThrow(AttestationContractError);
    expect(() => mintClaudeLaunchNonce(() => "not-bytes" as unknown as Uint8Array)).toThrow(
      AttestationContractError,
    );
  });

  test("an unknown roleId is refused HERE, before any child exists", () => {
    for (const roleId of ["", "not-a-dispatched-role", "constructor", "orchestrator"]) {
      expect(() => assertClaudeChildCorrelation({ ...CORRELATION, roleId })).toThrow(
        AttestationContractError,
      );
    }
    // Every real dispatched role is accepted, so the refusal is a membership
    // check and not an accidental allowlist of one.
    for (const roleId of DISPATCHED_ROLE_IDS) {
      expect(assertClaudeChildCorrelation({ ...CORRELATION, roleId }).roleId).toBe(roleId);
    }
  });

  test("a weak nonce and a NON-UUID session id are refused", () => {
    for (const launchNonce of [
      "",
      "short",
      "a".repeat(31),
      "has spaces in it and is long enough",
    ]) {
      expect(() => assertClaudeChildCorrelation({ ...CORRELATION, launchNonce })).toThrow(
        AttestationContractError,
      );
    }
    // The UUID rule is load-bearing: `claude --session-id` accepts only a UUID,
    // so a non-UUID identity could never be PRE-ASSIGNED on the wrapper path.
    for (const sessionId of [
      "",
      "not-a-uuid",
      "1DEA1C87-A984-448B-B038-D0078741A669", // uppercase
      "1dea1c87a984448bb038d0078741a669", // unhyphenated
    ]) {
      expect(() => assertClaudeChildCorrelation({ ...CORRELATION, sessionId })).toThrow(
        AttestationContractError,
      );
    }
    expect(assertClaudeChildCorrelation(CORRELATION).sessionId).toBe(SESSION_ID);
  });

  test("the childId binds BOTH the role and the nonce, so the STORE refuses a wrong-role child", () => {
    const child = claudeExpectedChild(CORRELATION);
    expect(child.childId).toBe(`${ROLE_ID}${CLAUDE_CORRELATION_SEPARATOR}${LAUNCH_NONCE}`);
    expect(child.runId).toBe(SESSION_ID);
    // Same nonce, different role => different childId. That is what makes "a
    // child of a different role completed" a STORE-level binding failure.
    const reviewer = claudeExpectedChild({ ...CORRELATION, roleId: "implement-reviewer" });
    expect(reviewer.childId).not.toBe(child.childId);
    expect(reviewer.runId).toBe(child.runId);
  });

  test("provenance is transport-attested on the wrapper and parent-constructed natively", () => {
    expect([...CLAUDE_CORRELATION_PROVENANCES].sort()).toEqual([
      "parent-constructed",
      "transport-attested",
    ]);
    // The wrapper pre-assigns `--session-id` and the terminal event echoes it
    // (tasks:T722 §6.3, whose negative control refused a self-identified child).
    expect(claudeCorrelationProvenance(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)).toBe(
      "transport-attested",
    );
    // The `Agent` tool has no session parameter, so nothing can be pre-assigned.
    expect(claudeCorrelationProvenance(CLAUDE_NATIVE_DELIVERY_MODE)).toBe("parent-constructed");
    // An unsupported mode has no provenance at all — it throws rather than
    // defaulting to the weaker answer.
    expect(() => claudeCorrelationProvenance("raw-print-stdout")).toThrow(
      ClaudeUnsupportedModeError,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The launch gate, plus the differential guard against the Codex surface
// ---------------------------------------------------------------------------

describe("T687 §3 — the launch gate", () => {
  function deadlines(h: Harness): DispatchDeadlines {
    return prepareClaude(h);
  }

  test("a prompt launch is approved for the CONSERVATIVE remaining window", () => {
    const h = harness({ seed: 21 });
    const prepared = deadlines(h);
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    expect(verdict.launch).toBe(true);
    if (!verdict.launch) throw new Error("unreachable");
    // The child is given until responseStoreNow, NOT until childCancelAt: a
    // child told to work until the cancel instant has no budget left to store.
    expect(verdict.childWindowMs).toBe(TIMEOUT_MS - RESPONSE_STORE_LEAD_MS);
    expect(verdict.cancelWindowMs).toBe(TIMEOUT_MS);
    expect(verdict.childWindowMs).toBeLessThan(verdict.cancelWindowMs);
  });

  test("a DELAYED launch gets a correspondingly SMALLER window, not the original timeout", () => {
    const h = harness({ seed: 23 });
    const prepared = deadlines(h);
    h.clock.advance(30_000);
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    expect(verdict.launch).toBe(true);
    if (!verdict.launch) throw new Error("unreachable");
    expect(verdict.childWindowMs).toBe(TIMEOUT_MS - RESPONSE_STORE_LEAD_MS - 30_000);
  });

  test("delayed prepare -> REFUSAL once the launch budget has lapsed", () => {
    const h = harness({ seed: 25 });
    const prepared = deadlines(h);
    h.clock.advance(LAUNCH_DEADLINE_MS);
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("launch-budget-lapsed");
    expect(verdict.abortReason).toBe("deadline-exceeded");
  });

  test("a launch instant PRECEDING the prepare instant is clock-skew, not a bigger window", () => {
    const h = harness({ seed: 27 });
    const prepared = deadlines(h);
    const verdict = claudeLaunchGate(prepared, new Date(T0_MS - 1).toISOString());
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("clock-skew");
    expect(verdict.abortReason).toBe("protocol-violation");
  });

  test("skew CANNOT change a lifecycle outcome: the child gets a duration, never an instant", () => {
    // The gate returns DURATIONS only. Nothing absolute crosses to the child, so
    // a skewed child clock cannot move any lifecycle decision.
    const h = harness({ seed: 29 });
    const prepared = deadlines(h);
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    if (!verdict.launch) throw new Error("unreachable");
    const fields = Object.keys(verdict).sort();
    expect(fields).toEqual(["cancelWindowMs", "childWindowMs", "launch"]);
    for (const value of [verdict.childWindowMs, verdict.cancelWindowMs]) {
      expect(Number.isInteger(value)).toBe(true);
      // A duration, not a parseable instant.
      expect(Number.isNaN(Date.parse(String(value)))).toBe(true);
    }
  });

  test("a response window too small to store in is its OWN refusal, distinct from the budget", () => {
    const h = harness({ seed: 31 });
    // At the minimum timeout, responseStoreNow (prepared + 30s) precedes
    // launchDeadline (prepared + 60s). So there is a real interval in which the
    // launch budget is STILL OPEN while the remaining window can no longer
    // accommodate a store — which is exactly why this is a separate refusal and
    // not a shade of `launch-budget-lapsed`.
    const prepared = prepareClaude(h, { timeoutMs: DISPATCH_TIMEOUT_MIN_MS });
    h.clock.advance(DISPATCH_TIMEOUT_MIN_MS - RESPONSE_STORE_LEAD_MS);
    expect(h.clock.peek()).toBe(prepared.responseStoreNow);
    expect(Date.parse(h.clock.peek())).toBeLessThan(Date.parse(prepared.launchDeadline));
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    expect(verdict.launch).toBe(false);
    if (verdict.launch) throw new Error("unreachable");
    expect(verdict.refusal).toBe("response-window-lapsed");
    expect(verdict.abortReason).toBe("deadline-exceeded");
  });

  test("when BOTH windows have lapsed the launch budget is read FIRST", () => {
    // The branch ORDER, pinned separately from the branch above. A late launch
    // must be reported as a lapsed budget rather than as a too-small window,
    // because the budget is the outer constraint.
    const h = harness({ seed: 32 });
    const prepared = prepareClaude(h, { timeoutMs: DISPATCH_TIMEOUT_MIN_MS });
    h.clock.advance(DISPATCH_TIMEOUT_MIN_MS);
    // Both instants are now in the past...
    expect(Date.parse(h.clock.peek())).toBeGreaterThanOrEqual(
      Date.parse(prepared.responseStoreNow),
    );
    expect(Date.parse(h.clock.peek())).toBeGreaterThanOrEqual(Date.parse(prepared.launchDeadline));
    const verdict = claudeLaunchGate(prepared, h.clock.peek());
    if (verdict.launch) throw new Error("unreachable");
    // ...and the budget wins.
    expect(verdict.refusal).toBe("launch-budget-lapsed");
  });

  test("EVERY declared refusal is REACHABLE by a witness input", () => {
    // The defects:D186 discipline: a refusal no input can produce is a dead
    // declaration. Each is produced here by construction.
    const seen = new Set<ClaudeLaunchRefusal>();
    for (const [at, prepared] of launchWitnesses()) {
      const verdict = claudeLaunchGate(prepared, at);
      if (!verdict.launch) seen.add(verdict.refusal);
    }
    expect([...seen].sort()).toEqual([...CLAUDE_LAUNCH_REFUSALS].sort());
  });

  test("NO cancel-window refusal is declared, because prepare cannot order the deadlines that way", () => {
    // `DISPATCH_TIMEOUT_MIN_MS === LAUNCH_DEADLINE_MS`, so childCancelAt is never
    // earlier than launchDeadline for any dispatch the system can construct —
    // `at >= childCancelAt` therefore implies `at >= launchDeadline`, and the
    // cancel window can only lapse via launch-budget-lapsed.
    expect(DISPATCH_TIMEOUT_MIN_MS).toBe(LAUNCH_DEADLINE_MS);
    expect([...CLAUDE_LAUNCH_REFUSALS]).not.toContain("child-window-lapsed");
    const h = harness({ seed: 33 });
    const prepared = prepareClaude(h, { timeoutMs: DISPATCH_TIMEOUT_MIN_MS });
    expect(Date.parse(prepared.childCancelAt)).toBeGreaterThanOrEqual(
      Date.parse(prepared.launchDeadline),
    );
  });

  test("a refused launch has allocated nothing beyond the prepared record", () => {
    const h = harness({ seed: 35 });
    const prepared = prepareClaude(h);
    h.clock.advance(LAUNCH_DEADLINE_MS);
    expect(claudeLaunchGate(prepared, h.clock.peek()).launch).toBe(false);
    // The gate is pure: it writes nothing.
    expect(h.store.snapshot()).toHaveLength(1);
  });
});

/**
 * One witness per declared refusal plus two approvals, as
 * `[instant, deadlines]` pairs built from a REAL prepare. Shared by the
 * reachability test and the cross-surface differential guard below.
 */
function launchWitnesses(): readonly (readonly [string, DispatchDeadlines])[] {
  const long = prepareClaude(harness({ seed: 91 }));
  const short = prepareClaude(harness({ seed: 93 }), { timeoutMs: DISPATCH_TIMEOUT_MIN_MS });
  return Object.freeze([
    // approvals
    Object.freeze([T0, long] as const),
    Object.freeze([new Date(T0_MS + 30_000).toISOString(), long] as const),
    // clock-skew
    Object.freeze([new Date(T0_MS - 1).toISOString(), long] as const),
    Object.freeze([new Date(T0_MS - 5 * 60_000).toISOString(), short] as const),
    // launch-budget-lapsed
    Object.freeze([new Date(T0_MS + LAUNCH_DEADLINE_MS).toISOString(), long] as const),
    Object.freeze([new Date(T0_MS + 3 * 60 * 60 * 1000).toISOString(), long] as const),
    // response-window-lapsed needs childCancelAt > launchDeadline AND the store
    // instant already passed while the launch budget has not: only reachable when
    // responseStoreNow precedes launchDeadline, i.e. at the minimum timeout.
    Object.freeze([
      new Date(T0_MS + DISPATCH_TIMEOUT_MIN_MS - RESPONSE_STORE_LEAD_MS).toISOString(),
      short,
    ] as const),
  ]);
}

describe("T687 §3b — the launch gate must NOT diverge from the Codex surface's", () => {
  /**
   * The gate reads nothing surface-specific, so `claudeLaunchGate` and
   * `codexLaunchGate` are necessarily the same function. defects:D188 is what
   * happens when two surfaces drift apart on one clause, so the duplication is
   * held equivalent by comparison rather than by hope. Consolidation into the
   * shared module is deferred (CLAUDE_DISPATCH_DEFERRED) because T687 must not
   * edit tasks:T690's just-landed file.
   */
  function compare(gate: (d: DispatchDeadlines, at: string) => ClaudeLaunchVerdict): unknown[] {
    return launchWitnesses().map(([at, deadlines]) => gate(deadlines, at));
  }

  test("both surfaces return IDENTICAL verdicts over the whole witness matrix", () => {
    expect(compare(claudeLaunchGate)).toEqual(
      compare(
        codexLaunchGate as unknown as (d: DispatchDeadlines, at: string) => ClaudeLaunchVerdict,
      ),
    );
    // And the matrix is not trivially all-approve or all-refuse: it must actually
    // exercise both branches, or the equality above would prove nothing.
    const verdicts = compare(claudeLaunchGate) as readonly ClaudeLaunchVerdict[];
    expect(verdicts.filter((v) => v.launch)).not.toHaveLength(0);
    expect(verdicts.filter((v) => !v.launch)).not.toHaveLength(0);
  });

  test("the comparison is DISCRIMINATING: three mutant gates are each caught", () => {
    // NEGATIVE CONTROL for the guard above. Each mutant differs from the real
    // gate in exactly one clause; all three must be detected, or an equality that
    // passes tells us nothing.
    const baseline = compare(claudeLaunchGate);

    // (1) hands the child the CANCEL window instead of the conservative one.
    const overGenerous = (d: DispatchDeadlines, at: string): ClaudeLaunchVerdict => {
      const verdict = claudeLaunchGate(d, at);
      return verdict.launch ? { ...verdict, childWindowMs: verdict.cancelWindowMs } : verdict;
    };
    expect(compare(overGenerous)).not.toEqual(baseline);

    // (2) silently tolerates clock skew instead of refusing it.
    const skewTolerant = (d: DispatchDeadlines, at: string): ClaudeLaunchVerdict => {
      const verdict = claudeLaunchGate(d, at);
      return !verdict.launch && verdict.refusal === "clock-skew"
        ? claudeLaunchGate(
            d,
            new Date(Date.parse(d.launchDeadline) - LAUNCH_DEADLINE_MS).toISOString(),
          )
        : verdict;
    };
    expect(compare(skewTolerant)).not.toEqual(baseline);

    // (3) misclassifies the response-window refusal as a budget refusal.
    const mislabelled = (d: DispatchDeadlines, at: string): ClaudeLaunchVerdict => {
      const verdict = claudeLaunchGate(d, at);
      return !verdict.launch && verdict.refusal === "response-window-lapsed"
        ? { ...verdict, refusal: "launch-budget-lapsed" }
        : verdict;
    };
    expect(compare(mislabelled)).not.toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// 4. The parent-side handle-only check (defects:D175)
// ---------------------------------------------------------------------------

describe("T687 §4 — the parent-side handle-only check", () => {
  const HANDLE: DispatchHandle = { attestationId: "att_" + "x".repeat(32), generation: 1 };

  test("the four verdicts are the whole classification", () => {
    expect([...CLAUDE_FINAL_MESSAGE_VERDICTS]).toEqual([
      "handle-only",
      "echo",
      "wrong-handle",
      "unparseable",
    ]);
  });

  test("a conformant reply carries exactly the handle — bare, fenced, or wrapper-tagged", () => {
    const bare = JSON.stringify(HANDLE);
    // All three envelopes were OBSERVED carrying a conformant handle in T722; the
    // `<dispatch>` tag is verbatim from its §6.2 orchestrator transcript.
    for (const message of [
      bare,
      `  ${bare}  `,
      "```json\n" + bare + "\n```",
      "```\n" + bare + "\n```",
      `<dispatch>${bare}</dispatch>`,
      `<dispatch>\n\`\`\`json\n${bare}\n\`\`\`\n</dispatch>`,
    ]) {
      const verdict = classifyClaudeFinalMessage(message, HANDLE);
      expect(verdict.verdict).toBe("handle-only");
      if (verdict.verdict !== "handle-only") throw new Error("unreachable");
      expect(verdict.handle).toEqual(HANDLE);
    }
  });

  test("ECHO: any surplus key is the echo, and the surplus keys are named", () => {
    const verdict = classifyClaudeFinalMessage(
      JSON.stringify({ ...HANDLE, summary: "CLAUDE-BODY-SENTINEL", status: "pass" }),
      HANDLE,
    );
    expect(verdict.verdict).toBe("echo");
    if (verdict.verdict !== "echo") throw new Error("unreachable");
    expect([...verdict.extraKeys]).toEqual(["status", "summary"]);
  });

  test("ECHO: a raw body with no handle at all is also an echo", () => {
    const verdict = classifyClaudeFinalMessage(JSON.stringify(OUTPUT), HANDLE);
    expect(verdict.verdict).toBe("echo");
  });

  test("a handle for a DIFFERENT dispatch is wrong-handle, distinct from echo", () => {
    const other: DispatchHandle = { attestationId: "att_" + "y".repeat(32), generation: 1 };
    const verdict = classifyClaudeFinalMessage(JSON.stringify(other), HANDLE);
    expect(verdict.verdict).toBe("wrong-handle");
    if (verdict.verdict !== "wrong-handle") throw new Error("unreachable");
    expect(verdict.claimed).toEqual(other);
    // A right id at the wrong generation is equally refused.
    expect(
      classifyClaudeFinalMessage(JSON.stringify({ ...HANDLE, generation: 2 }), HANDLE).verdict,
    ).toBe("wrong-handle");
  });

  test("prose, an array, a scalar, and a malformed handle are unparseable", () => {
    for (const message of [
      "Done! I stored the result.",
      JSON.stringify([HANDLE]),
      JSON.stringify(42),
      JSON.stringify(null),
      JSON.stringify({ attestationId: 7, generation: 1 }),
      JSON.stringify({ attestationId: HANDLE.attestationId, generation: "1" }),
      `Here you go: ${JSON.stringify(HANDLE)}`,
      "" as string,
    ]) {
      expect(classifyClaudeFinalMessage(message, HANDLE).verdict).toBe("unparseable");
    }
    expect(classifyClaudeFinalMessage(undefined as unknown as string, HANDLE).verdict).toBe(
      "unparseable",
    );
  });

  test("the check is PURE: it never consults the store, so storing well cannot excuse an echo", () => {
    // defects:D175's core. A store that would throw on ANY access is handed to
    // nobody — the classifier takes only text — so a correct-store-plus-echo
    // child is still caught.
    const h = harness({
      seed: 41,
      fault: () => {
        throw new AttestationStorageError("the classifier must not touch the store");
      },
    });
    const echoed = JSON.stringify({ ...HANDLE, summary: "CLAUDE-BODY-SENTINEL" });
    expect(classifyClaudeFinalMessage(echoed, HANDLE).verdict).toBe("echo");
    // The fault store is untouched, proving the classifier read nothing from it.
    expect(() => h.store.read(HANDLE)).toThrow(AttestationStorageError);
  });
});

// ---------------------------------------------------------------------------
// 4b. The completion decision keys on evidence, never on `subtype` or exit
// ---------------------------------------------------------------------------

describe("T687 §4b — the completion decision", () => {
  test("the outcome and corroboration vocabularies are closed", () => {
    expect([...CLAUDE_CHILD_OUTCOMES]).toEqual(["completed", "cancelled", "transport-failed"]);
    expect([...CLAUDE_EXIT_CORROBORATIONS]).toEqual(["corroborates", "contradicts", "unavailable"]);
  });

  test('T722 §7.1 #4: `subtype:"success"` with `is_error:true` is a FAILURE', () => {
    // The measured shape, verbatim from the probe. A bridge keying on `subtype`
    // would call this a successful dispatch.
    expect(TERMINAL_API_ERROR.subtype).toBe("success");
    expect(claudeTerminalOutcome(TERMINAL_API_ERROR)).toBe("failed");
    expect(claudeTerminalOutcome(TERMINAL_OK)).toBe("completed");
  });

  test("`subtype` is IGNORED in both directions — the discriminating control", () => {
    // NEGATIVE CONTROL for the claim above: flipping ONLY `subtype` must change
    // nothing, in either direction. If the predicate secretly read it, one of
    // these four would move.
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, subtype: "error_max_turns" })).toBe("completed");
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, subtype: "anything at all" })).toBe("completed");
    expect(claudeTerminalOutcome({ ...TERMINAL_API_ERROR, subtype: "error" })).toBe("failed");
    expect(claudeTerminalOutcome({ ...TERMINAL_API_ERROR, subtype: "success" })).toBe("failed");
    // Whereas flipping either AUTHORITATIVE term does move the verdict.
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, isError: true })).toBe("failed");
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, terminalReason: "api_error" })).toBe("failed");
  });

  test("D179: the EXIT STATUS is not in the success predicate at all", () => {
    // This deliberately NARROWS T722's measured wrapper predicate, which had
    // `exit==0` in it: defects:D179 measured a teardown race making a correct
    // child exit non-zero AFTER a valid reply. So a non-zero exit must not be
    // able to destroy a valid dispatch.
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, exitStatus: 1 })).toBe("completed");
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, exitStatus: 137 })).toBe("completed");
    expect(claudeTerminalOutcome({ ...TERMINAL_OK, exitStatus: 0 })).toBe("completed");
    // It is RECORDED as corroboration instead, with `unavailable` distinct from
    // `corroborates`: "we saw a clean exit" and "there was nothing to see" are
    // different evidence.
    expect(claudeExitCorroboration(0)).toBe("corroborates");
    expect(claudeExitCorroboration(1)).toBe("contradicts");
    expect(claudeExitCorroboration(undefined)).toBe("unavailable");
  });

  test("a malformed terminal signal is a contract error, not a silent default", () => {
    for (const bad of [
      { ...TERMINAL_OK, isError: "no" as unknown as boolean },
      { ...TERMINAL_OK, terminalReason: "" },
      { ...TERMINAL_OK, terminalReason: 7 as unknown as string },
      { ...TERMINAL_OK, subtype: null as unknown as string },
      { ...TERMINAL_OK, exitStatus: 1.5 },
    ]) {
      expect(() => claudeTerminalOutcome(bad)).toThrow(AttestationContractError);
    }
  });

  test("the derived outcome is total, and cancellation OUTRANKS the terminal signal", () => {
    const handle: DispatchHandle = { attestationId: "att_" + "z".repeat(32), generation: 1 };
    for (const mode of MODES) {
      expect(claudeChildOutcome(observation(mode, handle))).toBe("completed");
      expect(claudeChildOutcome(observation(mode, handle, { terminal: TERMINAL_API_ERROR }))).toBe(
        "transport-failed",
      );
      // Cancelled wins even when the turn itself reported success: cancellation
      // is a parent-observed fact about the RUN, not a verdict on the payload.
      expect(claudeChildOutcome(observation(mode, handle, { cancelled: true }))).toBe("cancelled");
      expect(
        claudeChildOutcome(
          observation(mode, handle, { cancelled: true, terminal: TERMINAL_API_ERROR }),
        ),
      ).toBe("cancelled");
    }
  });

  test("there is NO caller-supplied outcome to launder a failure through", () => {
    // The observation carries `cancelled` + the raw terminal signal, and the
    // outcome is DERIVED. So a caller cannot assert "completed" over an
    // api_error turn: the signal is re-judged every time.
    const handle: DispatchHandle = { attestationId: "att_" + "q".repeat(32), generation: 1 };
    const laundered = {
      ...observation(CLAUDE_NATIVE_DELIVERY_MODE, handle, { terminal: TERMINAL_API_ERROR }),
      outcome: "completed",
    } as ClaudeCompletionObservation;
    expect(claudeChildOutcome(laundered)).toBe("transport-failed");
    const decision = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: laundered,
    });
    expect(decision.action).toBe("abort");
    if (decision.action !== "abort") throw new Error("unreachable");
    expect(decision.reason).toBe("native-failure");
  });

  test("T713: correlation read from a CHILD-CONTROLLED message is refused, not trusted", () => {
    const handle: DispatchHandle = { attestationId: "att_" + "w".repeat(32), generation: 1 };
    for (const source of ["child-reported", "child", "", undefined]) {
      const forged = {
        ...observation(CLAUDE_NATIVE_DELIVERY_MODE, handle),
        source,
      } as unknown as ClaudeCompletionObservation;
      expect(() =>
        decideClaudeCompletion({ handle, expectedChild: CORRELATION, observation: forged }),
      ).toThrow(ClaudeObservationProvenanceError);
    }
  });

  test("an unsupported mode on an observation THROWS rather than aborting", () => {
    const handle: DispatchHandle = { attestationId: "att_" + "v".repeat(32), generation: 1 };
    for (const mode of UNSUPPORTED_CLAUDE_DELIVERY_MODES) {
      expect(() =>
        decideClaudeCompletion({
          handle,
          expectedChild: CORRELATION,
          observation: observation(mode, handle),
        }),
      ).toThrow(ClaudeUnsupportedModeError);
    }
  });

  test("a MISMATCHED child aborts `native-failure` and names the mismatched fields", () => {
    const handle: DispatchHandle = { attestationId: "att_" + "u".repeat(32), generation: 1 };
    const decision = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_NATIVE_DELIVERY_MODE, handle, {
        roleId: "implement-reviewer",
        sessionId: "2f250bd2-e108-41c9-9374-deabca1188ad",
      }),
    });
    expect(decision.action).toBe("abort");
    if (decision.action !== "abort") throw new Error("unreachable");
    // NATIVE failure, not protocol violation: the child may have behaved
    // perfectly and the transport delivered the wrong one.
    expect(decision.reason).toBe("native-failure");
    const details = decision.details as Record<string, unknown>;
    expect(details["mismatchedFields"]).toEqual(["roleId", "sessionId"]);
    expect(details["provenance"]).toBe("parent-constructed");
  });

  test("ECHO and every other non-handle-only reply abort `protocol-violation`", () => {
    const h = harness({ seed: 43 });
    const prepared = prepareClaude(h);
    const handle = handleOf(prepared);
    for (const mode of MODES) {
      for (const finalMessage of [
        JSON.stringify({ ...handle, summary: "CLAUDE-BODY-SENTINEL" }),
        JSON.stringify(OUTPUT),
        "I finished the task.",
        JSON.stringify({ attestationId: "att_" + "n".repeat(32), generation: 1 }),
      ]) {
        const decision = decideClaudeCompletion({
          handle,
          expectedChild: CORRELATION,
          observation: observation(mode, handle, { finalMessage }),
        });
        expect(decision.action).toBe("abort");
        if (decision.action !== "abort") throw new Error("unreachable");
        expect(decision.reason).toBe("protocol-violation");
        const details = decision.details as Record<string, unknown>;
        // THE HONEST FIELD: on the native path the body already reached parent
        // context, so the abort is a lifecycle remedy and not containment.
        expect(details["containedBeforeParentContext"]).toBe(
          mode === CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
        );
      }
    }
  });

  test("a confirmation RECORDS what it rests on: provenance and enforcement strength", () => {
    const h = harness({ seed: 45 });
    const prepared = prepareClaude(h);
    const handle = handleOf(prepared);

    const native = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_NATIVE_DELIVERY_MODE, handle),
    });
    expect(native.action).toBe("confirm");
    if (native.action !== "confirm") throw new Error("unreachable");
    expect(native.correlationProvenance).toBe("parent-constructed");
    expect(native.handleOnlyEnforcement).toBe("prompt-best-effort");
    expect(native.exitStatusCorroborates).toBe("unavailable");
    expect(native.nativeCompletion.actor).toBe("trusted-parent");

    const wrapper = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_CROSS_HARNESS_DELIVERY_MODE, handle),
    });
    if (wrapper.action !== "confirm") throw new Error("unreachable");
    expect(wrapper.correlationProvenance).toBe("transport-attested");
    expect(wrapper.handleOnlyEnforcement).toBe("structural");
    expect(wrapper.exitStatusCorroborates).toBe("corroborates");
    expect(wrapper.nativeCompletion.actor).toBe("trusted-extension");
  });

  test("D179: a NON-ZERO exit after a correct reply still confirms, and records the contradiction", () => {
    const h = harness({ seed: 47 });
    const prepared = prepareClaude(h);
    const handle = handleOf(prepared);
    const decision = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_CROSS_HARNESS_DELIVERY_MODE, handle, {
        terminal: { ...TERMINAL_OK, exitStatus: 1 },
      }),
    });
    expect(decision.action).toBe("confirm");
    if (decision.action !== "confirm") throw new Error("unreachable");
    expect(decision.exitStatusCorroborates).toBe("contradicts");
  });

  test("the decision NEVER reads the store — `missing-result` stays the service's verdict", () => {
    // A store that throws on every access. The decision still reaches `confirm`,
    // which proves it consults no store; and the SERVICE is what turns "nothing
    // stored" into `missing-result` (exercised in §5).
    const faulted = harness({
      seed: 49,
      fault: () => {
        throw new AttestationStorageError("decideClaudeCompletion must not read the store");
      },
    });
    const handle: DispatchHandle = { attestationId: "att_" + "m".repeat(32), generation: 1 };
    const decision = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_NATIVE_DELIVERY_MODE, handle),
    });
    expect(decision.action).toBe("confirm");
    expect(() => faulted.store.read(handle)).toThrow(AttestationStorageError);
    // And `missing-result` is not something this module can produce.
    expect(JSON.stringify(decision)).not.toContain("missing-result");
  });

  test("cancellation and transport failure OUTRANK the message check", () => {
    const handle: DispatchHandle = { attestationId: "att_" + "k".repeat(32), generation: 1 };
    // Even a perfectly echoing child is aborted `cancelled`, not
    // `protocol-violation`: the run's fate is decided before the payload's.
    const cancelled = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_NATIVE_DELIVERY_MODE, handle, {
        cancelled: true,
        finalMessage: JSON.stringify(OUTPUT),
      }),
    });
    if (cancelled.action !== "abort") throw new Error("unreachable");
    expect(cancelled.reason).toBe("cancelled");

    const failed = decideClaudeCompletion({
      handle,
      expectedChild: CORRELATION,
      observation: observation(CLAUDE_CROSS_HARNESS_DELIVERY_MODE, handle, {
        terminal: TERMINAL_API_ERROR,
        finalMessage: JSON.stringify(OUTPUT),
      }),
    });
    if (failed.action !== "abort") throw new Error("unreachable");
    expect(failed.reason).toBe("native-failure");
    const details = failed.details as Record<string, unknown>;
    // Both terms recorded, so a reader sees `subtype` said success while the
    // authoritative pair said otherwise.
    expect(details["subtype"]).toBe("success");
    expect(details["isError"]).toBe(true);
    expect(details["terminalReason"]).toBe("api_error");
  });
});

// ---------------------------------------------------------------------------
// 5. The end-to-end matrix, run identically on BOTH supported modes
// ---------------------------------------------------------------------------

/** The sentinel that must appear in exactly ONE protocol response: the fetch. */
const BODY_SENTINEL = "CLAUDE-BODY-SENTINEL";

function fetchRequest(handle: DispatchHandle, actor: "trusted-parent" | "trusted-extension") {
  return { ...handle, namespace: NAMESPACE, actor } as const;
}

/** Drive the happy path to `result-stored`, returning everything the rest needs. */
function storeVia(
  h: Harness,
  prepared: DispatchPrepared,
  output: DispatchJSONValue = OUTPUT,
): ReturnType<typeof storeDispatchResult> {
  return storeDispatchResult({ resultCapability: prepared.resultCapability, output }, h.deps);
}

function confirmVia(h: Harness, prepared: DispatchPrepared, mode: ClaudeDeliveryMode) {
  const decision = decideClaudeCompletion({
    handle: handleOf(prepared),
    expectedChild: CORRELATION,
    observation: observation(mode, handleOf(prepared), { observedAt: h.clock.peek() }),
  });
  if (decision.action !== "confirm") {
    throw new Error(`expected a confirm decision, got abort ${decision.reason}`);
  }
  return confirmDispatchCompletion(
    {
      namespace: NAMESPACE,
      ...handleOf(prepared),
      nativeCompletion: decision.nativeCompletion,
      expectedProvenance: provenanceBindingOf(prepared),
    },
    h.deps,
  );
}

for (const mode of MODES) {
  const actor = claudeCompletionActor(mode);

  describe(`T687 §5 [${mode}] — prepare → store → confirm → fetch`, () => {
    test("the happy path reaches `consumed`, and the BODY appears on the fetch ALONE", () => {
      const h = harness({ seed: 201 });
      const prepared = prepareClaude(h);
      expect(claudeLaunchGate(prepared, h.clock.peek()).launch).toBe(true);

      const stored = storeVia(h, prepared);
      expect(stored.state).toBe("result-stored");
      const confirmed = confirmVia(h, prepared, mode);
      expect(confirmed.state).toBe("consumed");

      const fetched = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(fetched.state).toBe("consumed");
      if (fetched.state !== "consumed") throw new Error("unreachable");
      expect(fetched.output).toEqual(OUTPUT);

      // The acceptance's central clause, measured per surface rather than
      // asserted: the distinctive payload and the store arguments stay outside
      // every response until ONE fetch (defects:D173).
      for (const payload of [prepared, stored, confirmed]) {
        expect(JSON.stringify(payload)).not.toContain(BODY_SENTINEL);
      }
      expect(JSON.stringify(fetched)).toContain(BODY_SENTINEL);
      // And the handle-only responses really are small next to the body.
      expect(JSON.stringify(confirmed).length).toBeLessThan(JSON.stringify(fetched).length / 4);
    });

    test("RESULT-STORED BEFORE COMPLETION is the normal order, and fetch shows it", () => {
      const h = harness({ seed: 203 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      // Between store and confirm the record is `result-stored` and the body is
      // NOT yet reachable as `consumed` output.
      const midway = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(midway.state).toBe("result-stored");
      expect(JSON.stringify(midway)).not.toContain(BODY_SENTINEL);
      expect(confirmVia(h, prepared, mode).state).toBe("consumed");
    });

    test("a valid store BEFORE the deadline stores; AT the deadline still stores", () => {
      const before = harness({ seed: 205 });
      const p1 = prepareClaude(before);
      before.clock.advance(TIMEOUT_MS - RESPONSE_STORE_LEAD_MS);
      expect(storeVia(before, p1).state).toBe("result-stored");

      // The boundary is INCLUSIVE: `childCancelAt` itself is still in time.
      const at = harness({ seed: 207 });
      const p2 = prepareClaude(at);
      at.clock.advance(TIMEOUT_MS);
      expect(at.clock.peek()).toBe(p2.childCancelAt);
      expect(storeVia(at, p2).state).toBe("result-stored");
    });

    test("a valid store AFTER the deadline aborts `deadline-exceeded`, storing nothing", () => {
      const h = harness({ seed: 209 });
      const prepared = prepareClaude(h);
      h.clock.advance(TIMEOUT_MS + 1);
      const outcome = storeVia(h, prepared);
      expect(outcome.state).toBe("aborted");
      if (outcome.state !== "aborted") throw new Error("unreachable");
      expect(outcome.result.reason).toBe("deadline-exceeded");
      // The late payload is NOT retained: a late child cannot smuggle a body in.
      const fetched = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(JSON.stringify(fetched)).not.toContain(BODY_SENTINEL);
    });

    test("an INVALID store before the deadline aborts `invalid-output` with typed details", () => {
      const h = harness({ seed: 211 });
      const prepared = prepareClaude(h);
      const outcome = storeVia(h, prepared, INVALID_OUTPUT);
      expect(outcome.state).toBe("aborted");
      if (outcome.state !== "aborted") throw new Error("unreachable");
      expect(outcome.result.reason).toBe("invalid-output");
      expect(outcome.result.details).toBeDefined();
    });

    test("an INVALID store AT the deadline is `invalid-output` — in time, then judged on merit", () => {
      const h = harness({ seed: 213 });
      const prepared = prepareClaude(h);
      h.clock.advance(TIMEOUT_MS);
      expect(h.clock.peek()).toBe(prepared.childCancelAt);
      const outcome = storeVia(h, prepared, INVALID_OUTPUT);
      expect(outcome.state).toBe("aborted");
      if (outcome.state !== "aborted") throw new Error("unreachable");
      expect(outcome.result.reason).toBe("invalid-output");
    });

    test("an INVALID store AFTER the deadline is `deadline-exceeded` — the deadline is read first", () => {
      // Ordering matters: a late submission must not be re-classified by the
      // quality of its payload, or a late child could choose its abort reason.
      const h = harness({ seed: 215 });
      const prepared = prepareClaude(h);
      h.clock.advance(TIMEOUT_MS + 1);
      const outcome = storeVia(h, prepared, INVALID_OUTPUT);
      expect(outcome.state).toBe("aborted");
      if (outcome.state !== "aborted") throw new Error("unreachable");
      expect(outcome.result.reason).toBe("deadline-exceeded");
    });

    test("PREPARE itself refuses a bad launch envelope, allocating nothing", () => {
      const h = harness({ seed: 217 });
      for (const overrides of [
        { timeoutMs: 1 },
        { idempotencyKey: "" },
        { roleId: "not-a-dispatched-role" },
        { surface: "not-a-surface" },
        { input: { taskId: "T687" } as DispatchJSONValue },
      ]) {
        expect(prepareDispatch(prepareRequest(overrides), h.prepareDeps).accepted).toBe(false);
      }
      expect(h.store.snapshot()).toHaveLength(0);
    });

    test("a child instant WILDLY skewed from the service clock changes nothing", () => {
      // §3's skew rule, end to end: the child is given a duration, and the
      // lifecycle is decided by the service clock alone. Here the child claims to
      // have completed two hours in the future; the outcome is identical.
      const h = harness({ seed: 219 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      const skewed = decideClaudeCompletion({
        handle: handleOf(prepared),
        expectedChild: CORRELATION,
        observation: observation(mode, handleOf(prepared), {
          observedAt: new Date(T0_MS + 2 * 60 * 60 * 1000).toISOString(),
        }),
      });
      expect(skewed.action).toBe("confirm");
      if (skewed.action !== "confirm") throw new Error("unreachable");
      const outcome = confirmDispatchCompletion(
        {
          namespace: NAMESPACE,
          ...handleOf(prepared),
          nativeCompletion: skewed.nativeCompletion,
          expectedProvenance: provenanceBindingOf(prepared),
        },
        h.deps,
      );
      expect(outcome.state).toBe("consumed");
      if (outcome.state !== "consumed") throw new Error("unreachable");
      // `consumedAt` is the SERVICE clock, not the child's claim.
      expect(outcome.result.consumedAt).toBe(T0);
    });

    test("COMPLETION BEFORE STORAGE (nothing stored) aborts `missing-result`", () => {
      const h = harness({ seed: 221 });
      const prepared = prepareClaude(h);
      const outcome = confirmVia(h, prepared, mode);
      expect(outcome.state).toBe("aborted");
      if (outcome.state !== "aborted") throw new Error("unreachable");
      expect(outcome.result.reason).toBe("missing-result");
    });

    test("a MISMATCHED completion cannot consume, even with a result stored", () => {
      const h = harness({ seed: 223 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      // A forged proof that skips this module's correlation check is still
      // refused by the STORE, because the role and nonce are bound into childId.
      expect(() =>
        confirmDispatchCompletion(
          {
            namespace: NAMESPACE,
            ...handleOf(prepared),
            nativeCompletion: {
              kind: "native-completion",
              actor,
              childId: claudeExpectedChild({ ...CORRELATION, roleId: "implement-reviewer" })
                .childId,
              runId: SESSION_ID,
              completedAt: h.clock.peek(),
            },
            expectedProvenance: provenanceBindingOf(prepared),
          },
          h.deps,
        ),
      ).toThrow(AttestationBindingError);
      // Still `result-stored`: a refused confirmation is not a terminal state.
      expect(fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps).state).toBe(
        "result-stored",
      );
    });

    test("T722 §6.3's control: a child the parent did not launch STORED and is still refused", () => {
      // "Storing is not completing." The unassigned child's session id differs,
      // so its completion cannot bind — the payload's validity is irrelevant.
      const h = harness({ seed: 225 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      const foreign = decideClaudeCompletion({
        handle: handleOf(prepared),
        expectedChild: CORRELATION,
        observation: observation(mode, handleOf(prepared), {
          sessionId: "faff5847-20d1-40cb-95bb-b445d38030ca",
          observedAt: h.clock.peek(),
        }),
      });
      expect(foreign.action).toBe("abort");
      if (foreign.action !== "abort") throw new Error("unreachable");
      expect(foreign.reason).toBe("native-failure");
    });

    test("FULL-BODY ECHO: the lifecycle stays sound, and containment differs by mode", () => {
      // T722 measured 2,689 B of body in a real native reply. Here the echo is
      // aborted, so no echoed body is ever promoted to `consumed`...
      const h = harness({ seed: 227 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      const decision = decideClaudeCompletion({
        handle: handleOf(prepared),
        expectedChild: CORRELATION,
        observation: observation(mode, handleOf(prepared), {
          finalMessage: JSON.stringify({ ...handleOf(prepared), ...(OUTPUT as object) }),
          observedAt: h.clock.peek(),
        }),
      });
      expect(decision.action).toBe("abort");
      if (decision.action !== "abort") throw new Error("unreachable");
      expect(decision.reason).toBe("protocol-violation");
      const aborted = abortDispatch(
        {
          namespace: NAMESPACE,
          ...handleOf(prepared),
          actor,
          reason: decision.reason,
          details: decision.details,
        },
        h.deps,
      );
      expect(aborted.state).toBe("aborted");
      // ...and the stored body is unreachable through the aborted record.
      const fetched = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(fetched.state).toBe("aborted");
      expect(JSON.stringify(fetched)).not.toContain(BODY_SENTINEL);
      // ...but on the native path the echo had ALREADY reached parent context, so
      // the abort is a lifecycle remedy, NOT containment. decisions:K170 accepted
      // exactly this, and the decision says so rather than implying otherwise.
      const details = decision.details as Record<string, unknown>;
      expect(details["containedBeforeParentContext"]).toBe(
        mode === CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
      );
      expect(claudeContainmentProfile(mode).handleOnlyOutput).toBe(
        mode === CLAUDE_CROSS_HARNESS_DELIVERY_MODE ? "structural" : "prompt-best-effort",
      );
    });

    test("NATIVE ERROR: an api_error turn aborts `native-failure`, never consumes", () => {
      const h = harness({ seed: 229 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      const decision = decideClaudeCompletion({
        handle: handleOf(prepared),
        expectedChild: CORRELATION,
        observation: observation(mode, handleOf(prepared), {
          terminal: TERMINAL_API_ERROR,
          observedAt: h.clock.peek(),
        }),
      });
      if (decision.action !== "abort") throw new Error("unreachable");
      expect(decision.reason).toBe("native-failure");
      abortDispatch(
        {
          namespace: NAMESPACE,
          ...handleOf(prepared),
          actor,
          reason: decision.reason,
          details: decision.details,
        },
        h.deps,
      );
      // And a later well-formed completion cannot resurrect it.
      expect(() => confirmVia(h, prepared, mode)).toThrow(DispatchStateConflictError);
    });

    test("CANCELLATION AFTER STORAGE: the abort wins and the stored result is never consumed", () => {
      const h = harness({ seed: 231 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");

      const decision = decideClaudeCompletion({
        handle: handleOf(prepared),
        expectedChild: CORRELATION,
        observation: observation(mode, handleOf(prepared), {
          cancelled: true,
          observedAt: h.clock.peek(),
        }),
      });
      expect(decision.action).toBe("abort");
      if (decision.action !== "abort") throw new Error("unreachable");
      const aborted = abortDispatch(
        {
          namespace: NAMESPACE,
          ...handleOf(prepared),
          actor,
          reason: decision.reason,
          details: decision.details,
        },
        h.deps,
      );
      expect(aborted.reason).toBe("cancelled");

      // A late completion cannot resurrect it.
      expect(() => confirmVia(h, prepared, mode)).toThrow(DispatchStateConflictError);
      const fetched = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(fetched.state).toBe("aborted");
      expect(JSON.stringify(fetched)).not.toContain(BODY_SENTINEL);
    });

    test("EXACTLY ONE terminal state persists: consumed excludes abort, aborted excludes consume", () => {
      const consumed = harness({ seed: 233 });
      const p1 = prepareClaude(consumed);
      expect(storeVia(consumed, p1).state).toBe("result-stored");
      expect(confirmVia(consumed, p1, mode).state).toBe("consumed");
      expect(() =>
        abortDispatch(
          { namespace: NAMESPACE, ...handleOf(p1), actor, reason: "cancelled" },
          consumed.deps,
        ),
      ).toThrow(DispatchStateConflictError);
      expect(consumed.store.snapshot()).toHaveLength(1);

      const abandoned = harness({ seed: 235 });
      const p2 = prepareClaude(abandoned);
      expect(storeVia(abandoned, p2).state).toBe("result-stored");
      abortDispatch(
        { namespace: NAMESPACE, ...handleOf(p2), actor, reason: "native-failure" },
        abandoned.deps,
      );
      expect(() => confirmVia(abandoned, p2, mode)).toThrow(DispatchStateConflictError);
      expect(abandoned.store.snapshot()).toHaveLength(1);
    });

    test("IDENTICAL retries are idempotent at every stage", () => {
      const h = harness({ seed: 237 });
      const prepared = prepareClaude(h);
      const first = storeVia(h, prepared);
      const second = storeVia(h, prepared);
      expect(second).toEqual(first);

      const confirmedOnce = confirmVia(h, prepared, mode);
      const confirmedTwice = confirmVia(h, prepared, mode);
      expect(confirmedTwice).toEqual(confirmedOnce);
      expect(h.store.snapshot()).toHaveLength(1);
    });

    test("CONFLICTING retries are typed conflicts, never a second terminal state", () => {
      const h = harness({ seed: 239 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      // A different body under the same capability.
      expect(() =>
        storeVia(h, prepared, {
          ...(OUTPUT as object),
          checkSummary: "different",
        } as DispatchJSONValue),
      ).toThrow(DispatchStateConflictError);
      expect(confirmVia(h, prepared, mode).state).toBe("consumed");
      // A different completion proof for an already-consumed record.
      expect(() =>
        confirmDispatchCompletion(
          {
            namespace: NAMESPACE,
            ...handleOf(prepared),
            nativeCompletion: {
              kind: "native-completion",
              actor,
              childId: claudeExpectedChild(CORRELATION).childId,
              runId: SESSION_ID,
              completedAt: "2026-07-28T23:59:59.000Z",
            },
            expectedProvenance: provenanceBindingOf(prepared),
          },
          h.deps,
        ),
      ).toThrow(DispatchStateConflictError);
    });

    test("a STALE generation cannot be confirmed, and an unallocated one is not-found", () => {
      const h = harness({ seed: 241 });
      const first = prepareClaude(h);
      abortDispatch(
        { namespace: NAMESPACE, ...handleOf(first), actor, reason: "parent-lost" },
        h.deps,
      );
      const second = prepareClaude(h, {
        idempotencyKey: "T687-round-1",
        reprepareOf: handleOf(first),
      });
      expect(second.generation).toBe(2);
      expect(second.attestationId).toBe(first.attestationId);
      // The stale generation is terminal and refuses promotion...
      expect(() => confirmVia(h, first, mode)).toThrow(DispatchStateConflictError);
      // ...its capability is stale too...
      expect(() => storeVia(h, first)).toThrow(DispatchStateConflictError);
      // ...and a generation that was never allocated is a lifecycle answer.
      expect(
        fetchDispatchResult(
          fetchRequest({ attestationId: second.attestationId, generation: 3 }, actor),
          h.deps,
        ).state,
      ).toBe("attestation-not-found");
      // The live generation still works.
      expect(storeVia(h, second).state).toBe("result-stored");
      expect(confirmVia(h, second, mode).state).toBe("consumed");
    });

    test("PARENT LOSS then RESTART: the result survives and the new parent confirms it", () => {
      const h = harness({ seed: 243 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");

      // The parent dies here. Everything it held in memory is gone; the handle is
      // the only thing a restarted parent needs. ONE rehydrated store, so the
      // fetch and the confirmation below really do see the same rows.
      const store = InMemoryAttestationStore.rehydrate(NAMESPACE, h.store.snapshot());
      const restarted: Harness = {
        clock: h.clock,
        store,
        deps: { store, now: h.clock.now },
        prepareDeps: { store, now: h.clock.now, randomBytes: sequentialDispatchRandomBytes(245) },
      };
      expect(
        fetchDispatchResult(fetchRequest(handleOf(prepared), actor), restarted.deps).state,
      ).toBe("result-stored");
      expect(confirmVia(restarted, prepared, mode).state).toBe("consumed");
      const fetched = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), restarted.deps);
      expect(fetched.state).toBe("consumed");
      if (fetched.state !== "consumed") throw new Error("unreachable");
      expect(fetched.output).toEqual(OUTPUT);
    });

    test("a parent that is NOT coming back aborts `parent-lost`, keeping one terminal state", () => {
      const h = harness({ seed: 247 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      const aborted: AbortedDispatchResult = abortDispatch(
        {
          namespace: NAMESPACE,
          ...handleOf(prepared),
          actor,
          reason: "parent-lost",
          details: { mode },
        },
        h.deps,
      );
      expect(aborted.reason).toBe("parent-lost");
      expect(h.store.snapshot()).toHaveLength(1);
    });

    test("AUTH failures: a forged capability and an untrusted fetch actor both fail closed", () => {
      const h = harness({ seed: 249 });
      const prepared = prepareClaude(h);
      // A stolen/forged capability resolves nothing — lookup is BY STORED HASH.
      expect(() =>
        storeDispatchResult(
          {
            resultCapability: { scope: "store-result", token: `cq_result_${"Z".repeat(43)}` },
            output: OUTPUT,
          },
          h.deps,
        ),
      ).toThrow(DispatchAuthorizationError);
      // And an untrusted reader cannot materialise the body (defects:D174).
      expect(() =>
        fetchDispatchResult(
          { ...handleOf(prepared), namespace: NAMESPACE, actor: "child" as never },
          h.deps,
        ),
      ).toThrow(DispatchAuthorizationError);
    });

    test("STORE and BACKEND failures stay errors — neither becomes a lifecycle state", () => {
      const storeFault = harness({
        seed: 251,
        fault: (operation) => {
          if (operation === "replace") throw new AttestationStorageError("write refused");
        },
      });
      const p1 = prepareClaude(storeFault);
      expect(() => storeVia(storeFault, p1)).toThrow(AttestationStorageError);

      const backendFault = harness({
        seed: 253,
        fault: (operation) => {
          if (operation === "read") throw new AttestationTransportError("backend unreachable");
        },
      });
      const p2 = prepareClaude(backendFault);
      expect(() =>
        fetchDispatchResult(fetchRequest(handleOf(p2), actor), backendFault.deps),
      ).toThrow(AttestationTransportError);
      // Neither error name appears in the lifecycle vocabulary.
      for (const name of ["storage-failure", "transport-failure", "backend-failure"]) {
        expect(DISPATCH_ABORT_REASONS as readonly string[]).not.toContain(name);
      }
    });

    test("EXPIRY and SWEEP walk the two retention boundaries in order", () => {
      const h = harness({ seed: 255 });
      const prepared = prepareClaude(h);
      expect(storeVia(h, prepared).state).toBe("result-stored");
      expect(confirmVia(h, prepared, mode).state).toBe("consumed");

      // Within the 24h envelope the body is still fetchable.
      h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS - 1);
      expect(fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps).state).toBe(
        "consumed",
      );

      // At 24h the envelope has expired — BEFORE any sweep runs.
      h.clock.advance(1);
      const expired = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(expired.state).toBe("terminal-envelope-expired");
      if (expired.state !== "terminal-envelope-expired") throw new Error("unreachable");
      expect(expired.terminalKind).toBe("consumed");
      expect(JSON.stringify(expired)).not.toContain(BODY_SENTINEL);

      // The sweep collapses it to a tombstone and drops the body irrecoverably.
      const collapse = sweepAttestations(h.deps);
      expect(collapse.envelopesCollapsed).toHaveLength(1);
      expect(JSON.stringify(h.store.snapshot())).not.toContain(BODY_SENTINEL);
      expect(fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps).state).toBe(
        "terminal-envelope-expired",
      );

      // At the 30d horizon the record is gone and the key is reusable.
      h.clock.advance(IDEMPOTENCY_HORIZON_MS);
      expect(fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps).state).toBe(
        "attestation-not-found",
      );
      const drop = sweepAttestations(h.deps);
      expect(drop.tombstonesRemoved).toHaveLength(1);
      expect(drop.rowsRemaining).toBe(0);
    });

    test("all SEVEN typed fetch states are reachable on this mode", () => {
      const seen = new Set<string>();

      const live = harness({ seed: 257 });
      const p1 = prepareClaude(live);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);
      storeVia(live, p1);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);
      confirmVia(live, p1, mode);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);
      live.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);
      live.clock.advance(IDEMPOTENCY_HORIZON_MS);
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p1), actor), live.deps).state);

      const stopped = harness({ seed: 259 });
      const p2 = prepareClaude(stopped);
      abortDispatch(
        { namespace: NAMESPACE, ...handleOf(p2), actor, reason: "cancelled" },
        stopped.deps,
      );
      seen.add(fetchDispatchResult(fetchRequest(handleOf(p2), actor), stopped.deps).state);

      expect([...seen].sort()).toEqual([
        "aborted",
        "attestation-not-found",
        "consumed",
        "output-already-materialized",
        "prepared",
        "result-stored",
        "terminal-envelope-expired",
      ]);
    });

    test("REPEAT fetch returns output-already-materialized — the shared defects:D188 ruling", () => {
      expect(CLAUDE_FETCH_SEMANTICS_ASSUMED).toBe("one-shot-materialization");
      const h = harness({ seed: 261 });
      const prepared = prepareClaude(h);
      storeVia(h, prepared);
      confirmVia(h, prepared, mode);
      const first = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      const second = fetchDispatchResult(fetchRequest(handleOf(prepared), actor), h.deps);
      expect(first.state).toBe("consumed");
      expect(JSON.stringify(first)).toContain(BODY_SENTINEL);
      expect(second.state).toBe("output-already-materialized");
      expect(JSON.stringify(second)).not.toContain(BODY_SENTINEL);
    });
  });
}

// ---------------------------------------------------------------------------
// 6. Reconciling decisions:K170 with questions:Q363 — worktree placement
// ---------------------------------------------------------------------------

describe("T687 §6 — the K170 x Q363 worktree reconciliation", () => {
  test("the placement vocabulary is closed and the two modes differ on it", () => {
    expect([...CLAUDE_WORKTREE_PLACEMENTS].sort()).toEqual(["input-path-absolute", "wrapper-cwd"]);
    // The wrapper is a separate PROCESS rooted in the prepared tree.
    expect(claudeWorktreePlacement(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)).toBe("wrapper-cwd");
    // A native child shares the parent's process, so only DATA can reach it.
    expect(claudeWorktreePlacement(CLAUDE_NATIVE_DELIVERY_MODE)).toBe("input-path-absolute");
    expect(CLAUDE_MODE_WORKTREE_PLACEMENTS.size).toBe(SUPPORTED_CLAUDE_DELIVERY_MODES.length);
    expect(() => claudeWorktreePlacement("background-native-subagent")).toThrow(
      ClaudeUnsupportedModeError,
    );
  });

  test("placement STRENGTH tracks placement MECHANISM, and is not asserted separately", () => {
    // The point of the whole section: `wrapper-cwd` is structural BECAUSE the
    // process is rooted there, and `input-path-absolute` is best-effort BECAUSE
    // data cannot confine. So the two maps must agree, mode by mode.
    for (const mode of SUPPORTED_CLAUDE_DELIVERY_MODES) {
      const expected =
        claudeWorktreePlacement(mode) === "wrapper-cwd" ? "structural" : "prompt-best-effort";
      expect(claudeContainmentProfile(mode).worktreeConfinement).toBe(expected);
    }
  });

  test("D143: worktreePath is OPTIONAL advisory; prepare succeeds without it", () => {
    // After D143 the input path is advisory. A dispatch without worktreePath is
    // still preparable — the worker reports actualWorktreePath on output. The
    // composition remains "orchestrator prepares and passes path when it can".
    expect(CLAUDE_WORKTREE_INPUT_PROPERTY).toBe("worktreePath");
    const h = harness({ seed: 301 });
    const { worktreePath: _omitted, ...withoutPath } = INPUT as Record<string, unknown>;
    const accepted = prepareDispatch(
      prepareRequest({ input: withoutPath as DispatchJSONValue }),
      h.prepareDeps,
    );
    expect(accepted.accepted).toBe(true);
    expect(h.store.snapshot()).toHaveLength(1);
  });

  test("the derivation is DISCRIMINATING: the SAME prepare succeeds WITH the path", () => {
    // NEGATIVE CONTROL for the test above. Without this, `invalid-role-input`
    // could be coming from anything else in the fixture.
    const h = harness({ seed: 303 });
    const accepted = prepareDispatch(prepareRequest(), h.prepareDeps);
    expect(accepted.accepted).toBe(true);
    expect(h.store.snapshot()).toHaveLength(1);
    // And the path that travelled is the orchestrator-prepared UUID-named tree
    // questions:Q363 specified, carried as ordinary input data — the one channel
    // the `Agent` tool does have.
    expect(WORKTREE_PATH).toContain("/cq-worktrees/");
    expect(CLAUDE_WORKTREE_RECONCILIATION.loadBearingAgreement).toContain("transportable input");
  });

  test("a prepared tree is addressable under EITHER branch naming, so Q363 needs no schema change", () => {
    // Q363 replaces the harness's allocate-or-reuse tree with a prepared one. The
    // input contract already accepts the `implement/<taskId>` branch a prepared
    // tree carries, as well as the legacy native-isolation `worktree-agent-<hex>`
    // name (D77) — so the composition costs no sidecar edit, which matters
    // because T894/T895's sidecars are out of T687's scope.
    const h = harness({ seed: 305 });
    for (const branch of ["implement/T687", "worktree-agent-abfed599d0ac7c8fe"]) {
      const outcome = prepareDispatch(
        prepareRequest({
          input: { ...(INPUT as object), branch } as DispatchJSONValue,
          idempotencyKey: `T687-branch-${branch}`,
        }),
        h.prepareDeps,
      );
      expect(outcome.accepted).toBe(true);
    }
  });

  test("the two locked decisions are both cited, and neither is silently dropped", () => {
    const reconciliation = JSON.stringify(CLAUDE_WORKTREE_RECONCILIATION);
    // K170's side (native, no shellout) and Q363's side (prepared trees) must
    // BOTH appear, along with the defect Q363 eliminated.
    expect(reconciliation).toContain("questions:Q363");
    expect(reconciliation).toContain("decisions:K170");
    expect(reconciliation).toContain("defects:D119");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosen).toBe(
      "orchestrator-prepares-via-worktree_manage-and-binds-path",
    );
  });

  test("EVERY option is priced — including the chosen one", () => {
    // The instruction this section answers: "whichever you propose, name what it
    // costs". A rejected option with no stated cost is an unexamined option.
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost.length).toBeGreaterThan(200);
    // Chosen cost names the MEASURED best-effort fact, refuses to attribute it to
    // K170, and names D263 + positive-only registration + compensators.
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("PROMPT-BEST-EFFORT");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("D263");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("NOT an authorized");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("worktree_manage");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).not.toMatch(
      /K170 already accepted.*write/i,
    );
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("resultCommitVerified");
    expect(CLAUDE_WORKTREE_RECONCILIATION.rejected).toHaveLength(3);
    const options = CLAUDE_WORKTREE_RECONCILIATION.rejected.map((entry) => entry.option);
    expect(options).toEqual([
      "child-calls-worktree_manage(prepare)-as-its-first-act",
      "restrict-native-dispatch-to-roles-needing-no-worktree",
      "relax-the-prepared-worktree-requirement-for-native-dispatch",
    ]);
    for (const entry of CLAUDE_WORKTREE_RECONCILIATION.rejected) {
      expect(entry.cost.length).toBeGreaterThan(120);
    }
  });

  test("the CD-does-not-persist constraint is recorded, with the mode it applies to", () => {
    // A one-time `cd` is the obvious implementation and it silently stops holding
    // after the child's first tool call — T722 §6.2 caught the harness saying
    // `Shell cwd was reset to …` in the measured transcript.
    expect(CLAUDE_WORKTREE_ADDRESSING).toBe("absolute-paths");
    // It bites precisely on the mode whose process cwd is NOT the prepared tree.
    expect(claudeWorktreePlacement(CLAUDE_NATIVE_DELIVERY_MODE)).toBe("input-path-absolute");
    expect(CLAUDE_WORKTREE_RECONCILIATION.chosenCost).toContain("ABSOLUTE PATH");
  });

  test("Q363's resume-by-handle survives the composition", () => {
    // §4's criticism-round re-dispatch needs the SAME tree, so `prepare` is fresh
    // by default and resumes by handle. On this surface the resumed path arrives
    // through the same input property as a fresh one, so a re-dispatch is
    // indistinguishable to this protocol — the round lives in the input and the
    // idempotency key, not in the placement mechanism.
    expect(CLAUDE_WORKTREE_RESUME_IS_BY_HANDLE).toBe(true);
    const h = harness({ seed: 307 });
    const round0 = prepareClaude(h, { idempotencyKey: "T687-resume-round-0" });
    abortDispatch(
      {
        namespace: NAMESPACE,
        ...handleOf(round0),
        actor: "trusted-parent",
        reason: "native-failure",
      },
      h.deps,
    );
    // Round 1 re-dispatches into the SAME prepared tree, and differs only by key.
    const round1 = prepareClaude(h, {
      idempotencyKey: "T687-resume-round-1",
      reprepareOf: handleOf(round0),
      input: {
        ...(INPUT as object),
        priorCriticism: ["the gate was not re-run"],
      } as DispatchJSONValue,
    });
    expect(round1.generation).toBe(2);
    expect(round1.promptProvenance.inputDigest).not.toBe(round0.promptProvenance.inputDigest);
  });
});

// ---------------------------------------------------------------------------
// 7. This task's boundary
// ---------------------------------------------------------------------------

describe("T687 §7 — what this DEFINITION task deliberately does not do", () => {
  test("the deferred work names its owners", () => {
    expect(CLAUDE_DISPATCH_DEFERRED_TO).toBe("T688");
    expect(CLAUDE_DISPATCH_PROVEN_BY).toBe("T689");
    expect(CLAUDE_DISPATCH_DEFERRED.length).toBeGreaterThanOrEqual(3);
    // The two that matter most for not being silently assumed done.
    // Q383(b)/K238 removed structural path-scoped registration requirement.
    expect(CLAUDE_DISPATCH_DEFERRED).not.toContain(
      "prove-structural-path-scoped-confinement-for-claude-native-registration",
    );
    expect(CLAUDE_DISPATCH_DEFERRED).toContain(
      "consolidate-the-duplicated-launch-gate-into-the-shared-module",
    );
    expect(CLAUDE_DISPATCH_DEFERRED.join(" ")).not.toContain("D188");
  });

  test("this module is INERT: it spawns nothing and renders no asset", () => {
    // The defects:D186 lesson, checked rather than promised: the module's whole
    // export surface is data and pure functions over data. If it ever needed a
    // process or a filesystem, this suite could not run it on a fault store that
    // throws on every operation — which §4/§4b already do.
    const source = Bun.file(new URL("../src/claudeDispatchProtocol.ts", import.meta.url).pathname);
    const text = source.text();
    return text.then((body) => {
      for (const forbidden of ["node:fs", "node:child_process", "Bun.spawn", "execSync"]) {
        expect(body).not.toContain(forbidden);
      }
    });
  });
});
