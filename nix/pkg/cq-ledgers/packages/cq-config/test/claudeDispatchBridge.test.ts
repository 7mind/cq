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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AttestationContractError,
  AttestationStorageError,
  CLAUDE_ARTIFACT_INSPECTION_TOKEN,
  CLAUDE_ARTIFACT_VIOLATIONS,
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
  CLAUDE_REF_FIRST_ARTIFACTS,
  DISPATCH_HANDLE_SCHEMA,
  ClaudeUnsupportedModeError,
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationStore,
  assertClaudeBridgeMode,
  assertClaudeRefFirstArtifact,
  assertCompactClaudeLaunchPrompt,
  claudeArtifactViolations,
  scanClaudeRefFirstArtifact,
  buildClaudeCompactNativeLaunch,
  claudeBridgeCorrelation,
  claudeCompactLaunchPrompt,
  claudeExpectedChild,
  fetchDispatchResult,
  invalidOutputDetailsOf,
  launchClaudePrint,
  createClaudeDispatchMaterializer,
  prepareDispatch,
  provenanceBindingOf,
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
  type FetchDispatchInput,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type PrepareDispatchRequest,
} from "@cq/config";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const T0 = "2026-07-28T12:00:00.000Z";
const ROLE_PROMPT = "T688-ROLE-PROMPT implement-worker";
const REVIEWER_ROLE_ID = "implement-reviewer";
const REVIEWER_ROLE_PROMPT = "T688-ROLE-PROMPT implement-reviewer";
const promptDigestOf = (prompt: string): string =>
  new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
const PROMPT_DIGEST = promptDigestOf(ROLE_PROMPT);
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

const liveClaudeTest = process.env["CQ_T688_LIVE_CLAUDE"] === "1" ? test : test.skip;

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
  round: 0,
  startingCommit: "7e3bfd579800a3e0db18dac15d5939ba08edbdb4",
};

function prepared(promptDigest: string = PROMPT_DIGEST): DispatchPrepared {
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
    promptDigest,
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

function preparedReviewer(): DispatchPrepared {
  const clock = new FakeDispatchClock(T0);
  const store = new InMemoryAttestationStore(NAMESPACE);
  const correlation: ClaudeChildCorrelation = {
    roleId: REVIEWER_ROLE_ID,
    launchNonce: SESSION_ID,
    sessionId: SESSION_ID,
  };
  const outcome = prepareDispatch(
    {
      namespace: NAMESPACE,
      roleId: REVIEWER_ROLE_ID,
      surface: "claude",
      input: {
        taskId: "T688",
        headline: "Review the Claude ref-first compact native launch",
        description: "Adversarially review the candidate.",
        acceptance: "Return a bound implementation verdict.",
        worktreePath: WORKTREE_PATH,
        branch: "worktree-agent-a3faf8a32fe197738",
        baseCommit: "7e3bfd579800a3e0db18dac15d5939ba08edbdb4",
        workerResult: {
          resultCommit: "40e58e91268a0ff7dfbd54922fdbf57c4434538c",
          checkSummary: "targeted suites green",
          filesTouched: ["packages/cq-config/src/claudeDispatchBridge.ts"],
        },
        round: 1,
        priorCriticism: [],
      },
      idempotencyKey: "T688-review-round-0",
      timeoutMs: TIMEOUT_MS,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: promptDigestOf(REVIEWER_ROLE_PROMPT),
      catalogHash: CATALOG_HASH,
      expectedChild: claudeExpectedChild(correlation),
    },
    {
      store,
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(31),
    },
  );
  if (!outcome.accepted) {
    throw new Error(
      `expected a prepared reviewer dispatch, got ${outcome.reason}: ${outcome.detail}`,
    );
  }
  return outcome.prepared;
}

function handleOf(value: DispatchPrepared): DispatchHandle {
  return { attestationId: value.attestationId, generation: value.generation };
}

function referenceOf(value: DispatchPrepared): FetchDispatchInput {
  return {
    ...handleOf(value),
    inputCapability: value.inputCapability,
  };
}

function launchOf(
  value: DispatchPrepared,
  roleId: string = ROLE_ID,
  model: string = MODEL,
) {
  return buildClaudeCompactNativeLaunch({
    roleId,
    model,
    handle: handleOf(value),
    inputCapability: value.inputCapability,
  });
}

// ---------------------------------------------------------------------------
// 1. The compact native launch envelope
// ---------------------------------------------------------------------------

describe("T688 §1 — the compact native launch carries the input reference, not a prompt copy", () => {
  test("the envelope pins all five Agent arguments, and the two T687 literals", () => {
    const launch = launchOf(prepared());

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

  test("the launch prompt carries exactly the one-shot input reference", () => {
    const dispatch = prepared();
    const launch = launchOf(dispatch);
    expect(JSON.parse(launch.prompt)).toEqual(referenceOf(dispatch));
  });

  test("the launch prompt is COMPACT by measurement, not by assertion", () => {
    const prompt = claudeCompactLaunchPrompt(referenceOf(prepared()));
    const bytes = new TextEncoder().encode(prompt).length;
    expect(bytes).toBeLessThanOrEqual(CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES);
    // Recorded so a regression in handle width is visible as a number, and so
    // the bound is seen to have real headroom rather than being fitted to it.
    expect(bytes).toBeGreaterThan(40);
    expect(bytes).toBeLessThan(220);
  });

  test("NEGATIVE CONTROL: a dispatched ROLE PROMPT COPY in the launch is refused", () => {
    const reference = referenceOf(prepared());
    // The REAL artifact this mutates is the REAL launch prompt the builder
    // produced, with a REAL role instruction body appended — the pre-T688
    // fragment's "pass the complete task prompt" behaviour.
    const real = claudeCompactLaunchPrompt(reference);
    const withPromptCopy = `${real}\n\n${"You are the implement-flow worker. ".repeat(40)}`;
    expect(new TextEncoder().encode(withPromptCopy).length).toBeGreaterThan(
      CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
    );
    expect(() => assertCompactClaudeLaunchPrompt(withPromptCopy, reference)).toThrow(
      /must not exceed 256 bytes/,
    );
  });

  test("NEGATIVE CONTROL: a SMALL surplus key is caught structurally, under the byte bound", () => {
    const reference = referenceOf(prepared());
    // Under the numeric bound, so only the structural check can catch it. This
    // is why both checks exist: they fail on different mutations.
    const smuggled = JSON.stringify({ ...reference, task: "T688" });
    expect(new TextEncoder().encode(smuggled).length).toBeLessThanOrEqual(
      CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES,
    );
    expect(() => assertCompactClaudeLaunchPrompt(smuggled, reference)).toThrow(
      /must carry exactly the bound handle and input capability/,
    );
  });

  test("NEGATIVE CONTROL: a prompt bound to a DIFFERENT dispatch is refused", () => {
    const reference = referenceOf(prepared());
    const other: FetchDispatchInput = { ...reference, generation: 9 };
    expect(() =>
      assertCompactClaudeLaunchPrompt(claudeCompactLaunchPrompt(other), reference),
    ).toThrow(/must carry exactly the bound handle and input capability/);
  });

  test("NEGATIVE CONTROL: a prompt bound to a DIFFERENT input capability is refused", () => {
    const reference = referenceOf(prepared());
    const other: FetchDispatchInput = {
      ...reference,
      inputCapability: {
        scope: "fetch-input",
        token: `${reference.inputCapability.token.slice(0, -1)}${
          reference.inputCapability.token.endsWith("A") ? "B" : "A"
        }`,
      },
    };
    expect(() =>
      assertCompactClaudeLaunchPrompt(claudeCompactLaunchPrompt(other), reference),
    ).toThrow(/must carry exactly the bound handle and input capability/);
  });

  test("NEGATIVE CONTROL: free-text prose is refused as unparseable, not tolerated", () => {
    const reference = referenceOf(prepared());
    expect(() =>
      assertCompactClaudeLaunchPrompt("Implement T688 end to end in your worktree.", reference),
    ).toThrow(/must be the JSON input reference/);
  });

  test("a missing role or model is refused BEFORE a child exists", () => {
    const dispatch = prepared();
    expect(() => launchOf(dispatch, "", MODEL)).toThrow(AttestationContractError);
    expect(() => launchOf(dispatch, ROLE_ID, "")).toThrow(AttestationContractError);
  });

  test("a malformed handle cannot become a launch", () => {
    const dispatch = prepared();
    expect(() =>
      buildClaudeCompactNativeLaunch({
        roleId: ROLE_ID,
        model: MODEL,
        handle: { attestationId: "", generation: 1 },
        inputCapability: dispatch.inputCapability,
      }),
    ).toThrow(AttestationContractError);
  });
});

describe("T688 §1b — the bridge drives T722's process-boundary mode only", () => {
  test("the bridge's mode is T687's wrapper mode", () => {
    expect(CLAUDE_BRIDGE_MODE).toBe(CLAUDE_CROSS_HARNESS_DELIVERY_MODE);
    expect(assertClaudeBridgeMode(CLAUDE_CROSS_HARNESS_DELIVERY_MODE)).toBe(
      CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
    );
  });

  test("the native mode is refused HERE, distinctly from an unsupported mode", () => {
    expect(() => assertClaudeBridgeMode(CLAUDE_NATIVE_DELIVERY_MODE)).toThrow(
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
    expect(CLAUDE_BRIDGE_DEFERRED).not.toContain(
      "child-side-one-shot-retrieval-of-the-assembled-input-by-handle-T977",
    );
    expect(CLAUDE_BRIDGE_DEFERRED).not.toContain(
      "decide-defects-D188s-fetch-repeatability-divergence-T1142",
    );
  });

  test("the production claude -p launcher binds role, handle, scoped store, run, and model", () => {
    const dispatch = prepared();
    const handle = handleOf(dispatch);
    expect(DISPATCH_HANDLE_SCHEMA.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const correlation: ClaudeChildCorrelation = {
      roleId: ROLE_ID,
      launchNonce: SESSION_ID,
      sessionId: SESSION_ID,
    };
    const report = launchClaudePrint(
      {
        envelope: launchOf(dispatch),
        preparedProvenance: provenanceBindingOf(dispatch),
        expectedCorrelation: correlation,
        resultCapability: dispatch.resultCapability,
        childWindowMs: 30_000,
      },
      {
        claudeExecutable: "bun",
        claudeArgsPrefix: [path.join(import.meta.dir, "fixtures", "claude-print-recording.ts")],
        cwd: import.meta.dir,
        rolePrompt: ROLE_PROMPT,
        storeServer: {
          name: "t688store",
          command: "cq",
          args: ["mcp", "--dispatch-store"],
          cwd: import.meta.dir,
          env: { T688_SCOPE: "one-dispatch" },
          capabilityEnv: "T688_CAPABILITY",
        },
      },
    );
    expect(report.terminal).toEqual({
      subtype: "success",
      isError: false,
      terminalReason: "completed",
      exitStatus: 0,
    });
    expect(report.finalMessage).toBe(JSON.stringify(handle));
    expect(report.correlation).toEqual(correlation);
    expect(report.agentId).toBe(SESSION_ID);
    expect(report.parentToolUseId).toBe("recorded-tool-use-t688");
    expect(report.resolvedModel).toBe(`recorded-${MODEL}`);
  });

  test("NEGATIVE CONTROL: a generated prompt for the wrong role is refused before launch", () => {
    const dispatch = preparedReviewer();
    const handle = handleOf(dispatch);
    const correlation: ClaudeChildCorrelation = {
      roleId: REVIEWER_ROLE_ID,
      launchNonce: SESSION_ID,
      sessionId: SESSION_ID,
    };
    expect(() =>
      launchClaudePrint(
        {
          envelope: buildClaudeCompactNativeLaunch({
            roleId: REVIEWER_ROLE_ID,
            model: MODEL,
            handle,
            inputCapability: dispatch.inputCapability,
          }),
          preparedProvenance: provenanceBindingOf(dispatch),
          expectedCorrelation: correlation,
          resultCapability: dispatch.resultCapability,
          childWindowMs: 30_000,
        },
        {
          claudeExecutable: "bun",
          claudeArgsPrefix: [path.join(import.meta.dir, "fixtures", "claude-print-recording.ts")],
          cwd: import.meta.dir,
          rolePrompt: ROLE_PROMPT,
          storeServer: {
            name: "t688store",
            command: "cq",
            args: ["mcp", "--dispatch-store"],
            cwd: import.meta.dir,
            env: { T688_SCOPE: "one-dispatch" },
            capabilityEnv: "T688_CAPABILITY",
          },
        },
      ),
    ).toThrow(
      /generated role prompt for "implement-reviewer" has digest .* not the prepared digest/,
    );
  });

  test("a malformed claude -p terminal result becomes a typed transport failure", () => {
    const dispatch = prepared();
    const report = launchClaudePrint(
      {
        envelope: launchOf(dispatch),
        preparedProvenance: provenanceBindingOf(dispatch),
        expectedCorrelation: {
          roleId: ROLE_ID,
          launchNonce: SESSION_ID,
          sessionId: SESSION_ID,
        },
        resultCapability: dispatch.resultCapability,
        childWindowMs: 30_000,
      },
      {
        claudeExecutable: "bun",
        claudeArgsPrefix: [
          path.join(import.meta.dir, "fixtures", "claude-print-recording.ts"),
          "--emit-malformed",
        ],
        cwd: import.meta.dir,
        rolePrompt: ROLE_PROMPT,
        storeServer: {
          name: "t688store",
          command: "cq",
          args: ["mcp", "--dispatch-store"],
          cwd: import.meta.dir,
          env: { T688_SCOPE: "one-dispatch" },
          capabilityEnv: "T688_CAPABILITY",
        },
      },
    );
    expect(report.terminal.isError).toBe(true);
    expect(report.terminal.terminalReason).toContain("malformed Claude print terminal result");
    expect(report.finalMessage).toBe("");
  });

  liveClaudeTest("ON-DEMAND: real claude -p submits through the scoped endpoint", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "cq-t688-live-"));
    try {
      const liveRolePrompt =
        `You are the selected implement-worker. Read the dispatch handle from the user prompt. ` +
        `Call mcp__t688store__store_result exactly once with output ${JSON.stringify(OUTPUT)}. ` +
        `After its acknowledgement, reply with exactly that handle JSON and no other text.`;
      const dispatch = prepared(promptDigestOf(liveRolePrompt));
      const handle = handleOf(dispatch);
      const capturePath = path.join(scratch, "store-result.json");
      const model = process.env["CQ_T688_LIVE_MODEL"] ?? "haiku";
      const report = launchClaudePrint(
        {
          envelope: launchOf(dispatch, ROLE_ID, model),
          preparedProvenance: provenanceBindingOf(dispatch),
          expectedCorrelation: {
            roleId: ROLE_ID,
            launchNonce: SESSION_ID,
            sessionId: SESSION_ID,
          },
          resultCapability: dispatch.resultCapability,
          childWindowMs: 180_000,
        },
        {
          claudeExecutable: process.env["CQ_T688_CLAUDE"] ?? "claude",
          claudeArgsPrefix: [],
          cwd: scratch,
          rolePrompt: liveRolePrompt,
          storeServer: {
            name: "t688store",
            command: "bun",
            args: [path.join(import.meta.dir, "fixtures", "claude-print-store-server.ts")],
            cwd: scratch,
            env: {
              T688_HANDLE: JSON.stringify(handle),
              T688_CAPTURE_PATH: capturePath,
            },
            capabilityEnv: "T688_CAPABILITY",
          },
        },
      );
      expect(report.terminal.isError).toBe(false);
      expect(report.finalMessage).toBe(JSON.stringify(handle));
      expect(report.correlation).toEqual({
        roleId: ROLE_ID,
        launchNonce: SESSION_ID,
        sessionId: SESSION_ID,
      });
      expect(report.agentId).toBe(SESSION_ID);
      expect(report.resolvedModel.length).toBeGreaterThan(0);
      expect(readFileSync(capturePath, "utf8")).toContain(BODY_SENTINEL);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
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
  actualWorktreePath: "/tmp/wt-actual",
  filesTouched: ["packages/cq-config/src/claudeDispatchBridge.ts"],
  gateDurationMs: 611_400,
  checkSummary: "3 files, 0 fail",
  summary: `${BODY_SENTINEL} ${"payload ".repeat(600)}`.trim(),
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  },
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
  /** Trusted transport's independently observed correlation. */
  readonly correlation?: ClaudeChildCorrelation;
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
    const reference = JSON.parse(context.envelope.prompt) as FetchDispatchInput;
    const handle: DispatchHandle = {
      attestationId: reference.attestationId,
      generation: reference.generation,
    };
    if (behaviour.submitAfterMs !== undefined) {
      b.clock.advance(behaviour.submitAfterMs);
    }
    const output = behaviour.output === undefined ? OUTPUT : behaviour.output;
    const submission =
      output === null
        ? undefined
        : storeDispatchResult({ resultCapability: context.resultCapability, output }, b.service);
    return {
      cancelled: behaviour.cancelled ?? false,
      terminal: behaviour.terminal ?? TERMINAL_OK,
      finalMessage:
        behaviour.finalMessage === undefined
          ? JSON.stringify(handle)
          : behaviour.finalMessage(handle),
      observedAt: b.clock.now(),
      correlation: behaviour.correlation ?? context.expectedCorrelation,
      agentId: "agent-a3faf8a32fe197738",
      parentToolUseId: "toolu_T688",
      resolvedModel: "claude-opus-5",
      ...(submission === undefined ? {} : { submission }),
    };
  };
}

function dispatchRequest(overrides: Partial<ClaudeDispatchRequest> = {}): ClaudeDispatchRequest {
  return {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    model: MODEL,
    childSessionId: SESSION_ID,
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
    const materializer = createClaudeDispatchMaterializer(
      { namespace: NAMESPACE, ...result.handle },
      b.service,
    );
    const body = materializer.materialize();
    expect(JSON.stringify(body)).toContain(BODY_SENTINEL);
    expect(body).toEqual(OUTPUT);
    expect(() => materializer.materialize()).toThrow(/already materialized/);
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
    expect(result.completion.nativeCompletion.actor).toBe("trusted-extension");
    expect(result.completion.nativeCompletion.childId.startsWith(`${ROLE_ID}#`)).toBe(true);
    expect(result.completion.nativeCompletion.runId).toBe(SESSION_ID);
    expect(result.completion.correlationProvenance).toBe("transport-attested");
    expect(result.completion.handleOnlyEnforcement).toBe("structural");
    expect(result.completion.exitStatusCorroborates).toBe("unavailable");
    expect(result.completion.transportProvenance).toEqual({
      agentId: "agent-a3faf8a32fe197738",
      parentToolUseId: "toolu_T688",
      resolvedModel: "claude-opus-5",
      correlation: {
        roleId: ROLE_ID,
        launchNonce: SESSION_ID,
        sessionId: SESSION_ID,
      },
    });
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
    // The process-boundary bridge consumes the raw child stream before the
    // orchestrator sees it, so this abort preserves containment.
    expect(JSON.stringify(result.abort.details)).toContain('"containedBeforeParentContext":true');
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
    // Drop a still-required field (taskId) so prepare refuses before allocate.
    // D143 made worktreePath optional, so omitting that alone is no longer a
    // rejection signal.
    const { taskId: _dropped, ...withoutTaskId } = INPUT as Record<string, unknown>;
    const result = run(b, {}, { input: withoutTaskId as DispatchJSONValue });
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
    expect([...CLAUDE_DISPATCH_RUN_OUTCOMES].sort()).toEqual(["aborted", "consumed", "rejected"]);
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
      correlation: CORRELATION,
      agentId: "agent-recovered",
      parentToolUseId: "toolu_recovered",
      resolvedModel: "claude-opus-5",
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

  test("a live CORRELATION FAILURE becomes a typed native-failure abort", () => {
    const b = bridge();
    const wrong: ClaudeChildCorrelation = {
      ...CORRELATION,
      sessionId: "2f250bd2-e108-41c9-9374-deabca1188ad",
    };
    const result = run(b, { correlation: wrong });
    if (result.outcome !== "aborted") {
      throw new Error(`expected aborted, got ${result.outcome}`);
    }
    expect(result.reason).toBe("native-failure");
    expect(JSON.stringify(result.abort.details)).toContain("sessionId");
    expect(JSON.stringify(result.abort.details)).toContain(SESSION_ID);
    expect(JSON.stringify(result.abort.details)).toContain(wrong.sessionId);
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
      createClaudeDispatchMaterializer(
        { namespace: NAMESPACE, ...result.handle },
        b.service,
      ).materialize(),
    ).toThrow(/only a consumed dispatch carries an output body/);
  });
});

// ---------------------------------------------------------------------------
// 3. Generated-artifact conformance, over the REAL asset files
// ---------------------------------------------------------------------------

const ASSETS_ROOT = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "nix",
  "pkg",
  "cq-assets",
);

function artifactText(artifact: string): string {
  return readFileSync(path.join(ASSETS_ROOT, artifact), "utf8");
}

describe("T688 §3 — the generated Claude assets are ref-first", () => {
  test("the executable bridge's own launch is ref-first clean", () => {
    // The path T688 actually implements has NONE of the four violations. This is
    // the positive control for the whole detector: it must not fire on conformant
    // material, or its findings below would be worthless.
    const b = bridge();
    run(b);
    const envelope = JSON.stringify(b.launches[0]!.envelope, null, 2);
    expect(scanClaudeRefFirstArtifact("bridge-launch-envelope", envelope)).toEqual([]);
    expect(() => assertClaudeRefFirstArtifact("bridge-launch-envelope", envelope)).not.toThrow();
    // And it pins the two arguments whose wrong values ARE `generic-launcher`.
    expect(envelope).toContain('"isolation": "none"');
    expect(envelope).toContain('"run_in_background": false');
  });

  for (const artifact of CLAUDE_REF_FIRST_ARTIFACTS) {
    test(`${artifact} contains none of the four prohibited patterns`, () => {
      const text = artifactText(artifact);
      expect(claudeArtifactViolations(artifact, text)).toEqual([]);
      expect(() => assertClaudeRefFirstArtifact(artifact, text)).not.toThrow();
    });
  }

  test("every declared violation remains reachable through a mutation of a real artifact", () => {
    const observed = new Set<string>();
    const artifact = "commands/cq/implement/advance.md";
    const real = artifactText(artifact);
    const regressed = `${real}
Pass the complete task prompt with isolation: "worktree".
Then await its result and \`validate_output("implement-worker", output)\`.
`;
    for (const violation of claudeArtifactViolations(artifact, regressed)) {
      observed.add(violation);
    }
    expect([...observed].sort()).toEqual([...CLAUDE_ARTIFACT_VIOLATIONS].sort());
  });

  test("NEGATIVE CONTROL: the REAL detector fires on a REAL artifact mutated to regress", () => {
    // The mutation is applied to the REAL fragment text, and the REAL scanner
    // reads it — not a toy literal standing in for the pipeline.
    const artifact = "fragments/claude/subagent-dispatch.md";
    const real = artifactText(artifact);
    expect(claudeArtifactViolations(artifact, real)).toEqual([]);

    const regressed = `${real}\n> Then await its result and \`validate_output("implement-worker", output)\`.\n`;
    const after = claudeArtifactViolations(artifact, regressed);
    expect(after).toContain("raw-output-completion");
    expect(after).toContain("ordinary-validate-output");
    expect(() => assertClaudeRefFirstArtifact(artifact, regressed)).toThrow(
      AttestationContractError,
    );
  });

  test("NEGATIVE CONTROL: a generic-launcher regression in a real asset is caught", () => {
    const artifact = "fragments/claude/subagent-dispatch.md";
    const regressed = `${artifactText(artifact)}\nLaunch with isolation: "worktree".\n`;
    expect(claudeArtifactViolations(artifact, regressed)).toContain("generic-launcher");
  });

  test("the INSPECTION token exempts a line, and exempts ONLY that line", () => {
    const artifact = "inspection-fixture";
    const exempt = `Debug: \`validate_output("implement-worker", out)\` ${CLAUDE_ARTIFACT_INSPECTION_TOKEN}`;
    expect(scanClaudeRefFirstArtifact(artifact, exempt)).toEqual([]);
    // The NEXT line is not exempt — the token is per-line, not a file-wide opt-out.
    const leaky = `${exempt}\nThen \`validate_output("implement-worker", out)\`.`;
    const findings = scanClaudeRefFirstArtifact(artifact, leaky);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.violation).toBe("ordinary-validate-output");
    expect(findings[0]!.line).toBe(2);
  });

  test("a non-string artifact body is refused rather than scanned as empty", () => {
    expect(() => scanClaudeRefFirstArtifact("bogus", undefined as unknown as string)).toThrow(
      AttestationContractError,
    );
  });
});
