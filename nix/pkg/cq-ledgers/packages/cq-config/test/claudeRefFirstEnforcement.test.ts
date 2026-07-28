import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AttestationBindingError,
  AttestationContractError,
  AttestationKeyReuseError,
  AttestationNamespaceError,
  AttestationStorageError,
  DispatchAuthorizationError,
  DispatchRefAssemblyError,
  DispatchStateConflictError,
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  InMemoryAttestationStore,
  RESULT_CAPABILITY_OPERATIONS,
  TERMINAL_ENVELOPE_RETENTION_MS,
  TRUSTED_DISPATCH_ACTORS,
  abortDispatch,
  attestationRowDigest,
  buildClaudeCompactNativeLaunch,
  claudeCompletionActor,
  claudeExpectedChild,
  confirmDispatchCompletion,
  createClaudeDispatchMaterializer,
  dispatchPayloadDigest,
  fetchDispatchResult,
  launchClaudePrint,
  prepareDispatch,
  provenanceBindingOf,
  recoverClaudeNativeDispatch,
  resultCapabilityHash,
  resultCapabilityMatches,
  runClaudeNativeDispatch,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  sweepAttestations,
  type AttestationNamespace,
  type AttestationStoreOperation,
  type ClaudeChildCorrelation,
  type ClaudeDispatchRequest,
  type ClaudeNativeLaunchReport,
  type ClaudeNativeLauncher,
  type ClaudeSettleContext,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type PrepareDispatchDeps,
} from "@cq/config";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const T0 = "2026-07-28T12:00:00.000Z";
const ROLE_ID = "implement-worker";
const MODEL = "opus-5[1m]";
const TIMEOUT_MS = 600_000;
const PROMPT_DIGEST = "c".repeat(64);
const CATALOG_HASH = "d".repeat(64);
const RECORDED_ROLE_PROMPT = "T688-ROLE-PROMPT implement-worker T689 enforcement";
const promptDigestOf = (prompt: string): string =>
  new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
const liveClaudeTest = process.env["CQ_T689_LIVE_CLAUDE"] === "1" ? test : test.skip;

const INPUT: DispatchJSONValue = {
  taskId: "T689",
  headline: "Prove Claude ref-first enforcement",
  description: "Exercise the complete trust boundary.",
  acceptance: "No foreign result or unobserved completion can settle this dispatch.",
  worktreePath: "/tmp/cq-worktrees/t689",
  branch: "implement/T689",
  baseCommit: "f91fc407e4aa357c563b432c0d2750ff8dfb584c",
};

const OUTPUT: DispatchJSONValue = {
  taskId: "T689",
  status: "pass",
  resultCommit: "f91fc407e4aa357c563b432c0d2750ff8dfb584c",
  branch: "implement/T689",
  filesTouched: ["packages/cq-config/src/claudeDispatchBridge.ts"],
  gateDurationMs: 1_000,
  checkSummary: "focused tests green",
  summary: "T689-BODY-SENTINEL",
};

interface Harness {
  readonly clock: FakeDispatchClock;
  readonly store: InMemoryAttestationStore;
  readonly service: DispatchServiceDeps;
  readonly prepare: PrepareDispatchDeps;
}

function harness(
  options: {
    readonly namespace?: AttestationNamespace;
    readonly seed?: number;
    readonly fault?: (operation: AttestationStoreOperation) => void;
  } = {},
): Harness {
  const namespace = options.namespace ?? NAMESPACE;
  const clock = new FakeDispatchClock(T0);
  const store =
    options.fault === undefined
      ? new InMemoryAttestationStore(namespace)
      : new InMemoryAttestationStore(namespace, options.fault);
  return {
    clock,
    store,
    service: { store, now: clock.now },
    prepare: {
      store,
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(options.seed ?? 41),
    },
  };
}

function correlation(sessionId: string): ClaudeChildCorrelation {
  return { roleId: ROLE_ID, launchNonce: sessionId, sessionId };
}

function dispatchRequest(
  sessionId: string,
  idempotencyKey: string,
): ClaudeDispatchRequest {
  return {
    namespace: NAMESPACE,
    roleId: ROLE_ID,
    model: MODEL,
    childSessionId: sessionId,
    input: INPUT,
    idempotencyKey,
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
  };
}

function prepare(
  h: Harness,
  sessionId: string,
  idempotencyKey: string,
  overrides: {
    readonly namespace?: AttestationNamespace;
    readonly promptDigest?: string;
    readonly reprepareOf?: DispatchHandle;
  } = {},
): DispatchPrepared {
  const request = dispatchRequest(sessionId, idempotencyKey);
  const outcome = prepareDispatch(
    {
      namespace: overrides.namespace ?? request.namespace,
      roleId: request.roleId,
      surface: "claude",
      input: request.input,
      idempotencyKey: request.idempotencyKey,
      timeoutMs: request.timeoutMs,
      registry: request.registry,
      promptDigest: overrides.promptDigest ?? request.promptDigest,
      catalogHash: request.catalogHash,
      expectedChild: claudeExpectedChild(correlation(sessionId)),
      ...(overrides.reprepareOf === undefined ? {} : { reprepareOf: overrides.reprepareOf }),
    },
    h.prepare,
  );
  if (!outcome.accepted) {
    throw new Error(`expected prepare to succeed, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome.prepared;
}

function handleOf(prepared: DispatchPrepared): DispatchHandle {
  return { attestationId: prepared.attestationId, generation: prepared.generation };
}

function report(
  h: Harness,
  prepared: DispatchPrepared,
  child: ClaudeChildCorrelation,
  overrides: Partial<ClaudeNativeLaunchReport> = {},
): ClaudeNativeLaunchReport {
  return {
    cancelled: false,
    terminal: { subtype: "success", isError: false, terminalReason: "completed", exitStatus: 0 },
    finalMessage: JSON.stringify(handleOf(prepared)),
    observedAt: h.clock.now(),
    correlation: child,
    agentId: child.sessionId,
    parentToolUseId: `toolu_${prepared.attestationId}`,
    resolvedModel: "claude-opus-5",
    ...overrides,
  };
}

function settleContext(
  request: ClaudeDispatchRequest,
  prepared: DispatchPrepared,
  child: ClaudeChildCorrelation,
  launchReport: ClaudeNativeLaunchReport,
): ClaudeSettleContext {
  return {
    request,
    prepared,
    handle: handleOf(prepared),
    correlation: child,
    report: launchReport,
  };
}

function fetchState(h: Harness, prepared: DispatchPrepared): string {
  return fetchDispatchResult(
    { namespace: NAMESPACE, actor: "trusted-parent", ...handleOf(prepared) },
    h.service,
  ).state;
}

function storeDigest(h: Harness): string {
  return h.store
    .snapshot()
    .map((row) => attestationRowDigest(row))
    .join("|");
}

function expectRefusedWithoutWriting(h: Harness, operation: () => unknown): unknown {
  const before = storeDigest(h);
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error("expected operation to be refused");
  expect(storeDigest(h)).toBe(before);
  return thrown;
}

function confirm(
  h: Harness,
  prepared: DispatchPrepared,
  child: ClaudeChildCorrelation,
  completedAt = h.clock.now(),
) {
  const expected = claudeExpectedChild(child);
  return confirmDispatchCompletion(
    {
      namespace: NAMESPACE,
      ...handleOf(prepared),
      nativeCompletion: {
        kind: "native-completion",
        actor: claudeCompletionActor("wrapper-shellout"),
        childId: expected.childId,
        runId: expected.runId,
        completedAt,
      },
      expectedProvenance: provenanceBindingOf(prepared),
    },
    h.service,
  );
}

interface BridgeBehaviour {
  readonly output?: DispatchJSONValue | null;
  readonly cancelled?: boolean;
  readonly finalMessage?: (handle: DispatchHandle) => string;
  readonly correlation?: ClaudeChildCorrelation;
  readonly agentId?: string;
  readonly parentToolUseId?: string;
  readonly resolvedModel?: string;
  readonly exitStatus?: number;
}

function bridgeLauncher(h: Harness, behaviour: BridgeBehaviour = {}): ClaudeNativeLauncher {
  return (context) => {
    const handle = JSON.parse(context.envelope.prompt) as DispatchHandle;
    const output = behaviour.output === undefined ? OUTPUT : behaviour.output;
    const submission =
      output === null
        ? undefined
        : storeDispatchResult(
            { resultCapability: context.resultCapability, output },
            h.service,
          );
    return {
      cancelled: behaviour.cancelled ?? false,
      terminal: {
        subtype: "success",
        isError: false,
        terminalReason: "completed",
        ...(behaviour.exitStatus === undefined ? {} : { exitStatus: behaviour.exitStatus }),
      },
      finalMessage:
        behaviour.finalMessage === undefined
          ? JSON.stringify(handle)
          : behaviour.finalMessage(handle),
      observedAt: h.clock.now(),
      correlation: behaviour.correlation ?? context.expectedCorrelation,
      agentId: behaviour.agentId ?? context.expectedCorrelation.sessionId,
      parentToolUseId: behaviour.parentToolUseId ?? "toolu_T689",
      resolvedModel: behaviour.resolvedModel ?? "claude-opus-5",
      ...(submission === undefined ? {} : { submission }),
    };
  };
}

function runBridge(
  h: Harness,
  sessionId: string,
  idempotencyKey: string,
  behaviour: BridgeBehaviour = {},
) {
  return runClaudeNativeDispatch(dispatchRequest(sessionId, idempotencyKey), {
    ...h.prepare,
    launch: bridgeLauncher(h, behaviour),
  });
}

describe("T689 settlement trust boundaries", () => {
  test("a foreign aborted submission cannot be attributed to the active run", () => {
    const h = harness();
    const firstSession = "1dea1c87-a984-448b-b038-d0078741a669";
    const secondSession = "2f250bd2-e108-41c9-9374-deabca1188ad";
    const first = prepare(h, firstSession, "T689-first");
    const second = prepare(h, secondSession, "T689-second");
    const foreignAbort = storeDispatchResult(
      {
        resultCapability: first.resultCapability,
        output: { taskId: "T689", status: "not-a-status" },
      },
      h.service,
    );
    expect(foreignAbort.state).toBe("aborted");
    if (foreignAbort.state !== "aborted") throw new Error("unreachable");

    const secondChild = correlation(secondSession);
    const attempt = (): unknown =>
      recoverClaudeNativeDispatch(
        settleContext(
          dispatchRequest(secondSession, "T689-second"),
          second,
          secondChild,
          report(h, second, secondChild, { submission: foreignAbort }),
        ),
        h.service,
      );

    expect(attempt).toThrow(AttestationBindingError);
    expect(fetchState(h, second)).toBe("prepared");
  });

  test("missing transport telemetry is refused before confirmation mutates the store", () => {
    const h = harness();
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const prepared = prepare(h, sessionId, "T689-telemetry");
    expect(
      storeDispatchResult(
        { resultCapability: prepared.resultCapability, output: OUTPUT },
        h.service,
      ).state,
    ).toBe("result-stored");
    const child = correlation(sessionId);

    expect(() =>
      recoverClaudeNativeDispatch(
        settleContext(
          dispatchRequest(sessionId, "T689-telemetry"),
          prepared,
          child,
          report(h, prepared, child, { agentId: "" }),
        ),
        h.service,
      ),
    ).toThrow(AttestationContractError);
    expect(fetchState(h, prepared)).toBe("result-stored");
  });
});

describe("T689 recorded and opt-in live Claude process boundaries", () => {
  test("the recorded process observes generated role policy, one scoped tool, run, and model", () => {
    const h = harness({ seed: 73 });
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const prepared = prepare(h, sessionId, "T689-recorded-process", {
      promptDigest: promptDigestOf(RECORDED_ROLE_PROMPT),
    });
    const handle = handleOf(prepared);
    const launch = buildClaudeCompactNativeLaunch({ roleId: ROLE_ID, model: MODEL, handle });
    const launchCorrelation = correlation(sessionId);
    expect(launch.prompt).not.toContain(prepared.resultCapability.token);
    const launchReport = launchClaudePrint(
      {
        envelope: launch,
        preparedProvenance: provenanceBindingOf(prepared),
        expectedCorrelation: launchCorrelation,
        resultCapability: prepared.resultCapability,
        childWindowMs: 30_000,
      },
      {
        claudeExecutable: "bun",
        claudeArgsPrefix: [
          path.join(import.meta.dir, "fixtures", "claude-print-recording.ts"),
        ],
        cwd: import.meta.dir,
        rolePrompt: RECORDED_ROLE_PROMPT,
        storeServer: {
          name: "t688store",
          command: "cq",
          args: ["mcp", "--dispatch-store"],
          cwd: import.meta.dir,
          env: { T689_SCOPE: "one-dispatch" },
          capabilityEnv: "T688_CAPABILITY",
        },
      },
    );
    expect(launchReport.terminal).toEqual({
      subtype: "success",
      isError: false,
      terminalReason: "completed",
      exitStatus: 0,
    });
    expect(launchReport.finalMessage).toBe(JSON.stringify(handle));
    expect(launchReport.correlation).toEqual(launchCorrelation);
    expect(launchReport.agentId).toBe(sessionId);
    expect(launchReport.parentToolUseId).toBe("recorded-tool-use-t688");
    expect(launchReport.resolvedModel).toBe(`recorded-${MODEL}`);
  });

  test("a prompt override is rejected before an executable can start", () => {
    const h = harness({ seed: 79 });
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const prepared = prepare(h, sessionId, "T689-prompt-override", {
      promptDigest: promptDigestOf(RECORDED_ROLE_PROMPT),
    });
    expect(() =>
      launchClaudePrint(
        {
          envelope: buildClaudeCompactNativeLaunch({
            roleId: ROLE_ID,
            model: MODEL,
            handle: handleOf(prepared),
          }),
          preparedProvenance: provenanceBindingOf(prepared),
          expectedCorrelation: correlation(sessionId),
          resultCapability: prepared.resultCapability,
          childWindowMs: 30_000,
        },
        {
          claudeExecutable: "this-must-not-run",
          claudeArgsPrefix: [],
          cwd: import.meta.dir,
          rolePrompt: `${RECORDED_ROLE_PROMPT} OVERRIDDEN`,
          storeServer: {
            name: "t688store",
            command: "cq",
            args: ["mcp", "--dispatch-store"],
            cwd: import.meta.dir,
            env: {},
            capabilityEnv: "T688_CAPABILITY",
          },
        },
      ),
    ).toThrow(/not the prepared digest/);
  });

  liveClaudeTest("ON-DEMAND: live process records role/model/agent and telemetry availability", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "cq-t689-live-"));
    try {
      const sessionId = crypto.randomUUID();
      const liveRolePrompt =
        `T688-ROLE-PROMPT You are the selected ${ROLE_ID}. Read the dispatch handle from the ` +
        `user prompt. Call mcp__t688store__store_result exactly once with output ` +
        `${JSON.stringify(OUTPUT)}. After its acknowledgement, reply with exactly that handle JSON.`;
      const h = harness({ seed: 83 });
      const prepared = prepare(h, sessionId, "T689-live-process", {
        promptDigest: promptDigestOf(liveRolePrompt),
      });
      const handle = handleOf(prepared);
      const capturePath = path.join(scratch, "store-result.json");
      const model = process.env["CQ_T689_LIVE_MODEL"] ?? "haiku";
      const launchReport = launchClaudePrint(
        {
          envelope: buildClaudeCompactNativeLaunch({ roleId: ROLE_ID, model, handle }),
          preparedProvenance: provenanceBindingOf(prepared),
          expectedCorrelation: correlation(sessionId),
          resultCapability: prepared.resultCapability,
          childWindowMs: 180_000,
        },
        {
          claudeExecutable: process.env["CQ_T689_CLAUDE"] ?? "claude",
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
      expect(launchReport.terminal.isError).toBe(false);
      expect(launchReport.terminal.exitStatus).toBe(0);
      expect(launchReport.finalMessage).toBe(JSON.stringify(handle));
      expect(launchReport.correlation.roleId).toBe(ROLE_ID);
      expect(launchReport.agentId.length).toBeGreaterThan(0);
      expect(launchReport.parentToolUseId.length).toBeGreaterThan(0);
      expect(launchReport.resolvedModel.length).toBeGreaterThan(0);
      expect(readFileSync(capturePath, "utf8")).toContain("T689-BODY-SENTINEL");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("T689 capability isolation, theft, replay, role, run, and generation", () => {
  test("the result capability authorizes only store_result and cannot select a handle", () => {
    expect(RESULT_CAPABILITY_OPERATIONS).toEqual(["store_result"]);
    const h = harness();
    const prepared = prepare(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-capability-scope",
    );
    expect(prepared.resultCapability.scope).toBe("store-result");
    expect(JSON.stringify(prepared.resultCapability)).not.toContain(prepared.attestationId);
    expect(
      expectRefusedWithoutWriting(h, () =>
        storeDispatchResult(
          {
            resultCapability: { ...prepared.resultCapability, scope: "fetch" as never },
            output: OUTPUT,
          },
          h.service,
        ),
      ),
    ).toBeInstanceOf(DispatchAuthorizationError);
  });

  test("a stolen or near-miss capability resolves no dispatch", () => {
    const h = harness();
    const prepared = prepare(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-capability-theft",
    );
    const token = prepared.resultCapability.token;
    const replacement = token.endsWith("A") ? "B" : "A";
    const nearMiss = `${token.slice(0, -1)}${replacement}`;
    expect(resultCapabilityMatches(token, resultCapabilityHash(token))).toBe(true);
    expect(resultCapabilityMatches(nearMiss, resultCapabilityHash(token))).toBe(false);
    expect(
      expectRefusedWithoutWriting(h, () =>
        storeDispatchResult(
          {
            resultCapability: { scope: "store-result", token: nearMiss },
            output: OUTPUT,
          },
          h.service,
        ),
      ),
    ).toBeInstanceOf(DispatchAuthorizationError);
    expect(fetchState(h, prepared)).toBe("prepared");
  });

  test("a capability from another project cannot see or mutate this project", () => {
    const otherNamespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: "cq-ledger-suite-foreign",
    };
    const home = harness({ seed: 101 });
    const foreign = harness({ namespace: otherNamespace, seed: 103 });
    const homePrepared = prepare(
      home,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-home",
    );
    const foreignPrepared = prepare(
      foreign,
      "2f250bd2-e108-41c9-9374-deabca1188ad",
      "T689-foreign",
      { namespace: otherNamespace },
    );
    expect(
      expectRefusedWithoutWriting(foreign, () =>
        storeDispatchResult(
          { resultCapability: homePrepared.resultCapability, output: OUTPUT },
          foreign.service,
        ),
      ),
    ).toBeInstanceOf(DispatchAuthorizationError);
    expect(
      fetchDispatchResult(
        {
          namespace: otherNamespace,
          actor: "trusted-parent",
          ...handleOf(foreignPrepared),
        },
        foreign.service,
      ).state,
    ).toBe("prepared");
    expect(fetchState(home, homePrepared)).toBe("prepared");
  });

  test("two live runs cannot address or confirm one another", () => {
    const h = harness({ seed: 107 });
    const firstChild = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const secondChild = correlation("2f250bd2-e108-41c9-9374-deabca1188ad");
    const first = prepare(h, firstChild.sessionId, "T689-run-one");
    const second = prepare(h, secondChild.sessionId, "T689-run-two");
    expect(first.resultCapability.token).not.toBe(second.resultCapability.token);

    expect(
      storeDispatchResult(
        { resultCapability: first.resultCapability, output: OUTPUT },
        h.service,
      ).state,
    ).toBe("result-stored");
    expect(fetchState(h, second)).toBe("prepared");
    expect(
      expectRefusedWithoutWriting(h, () => confirm(h, first, secondChild)),
    ).toBeInstanceOf(AttestationBindingError);
    expect(fetchState(h, first)).toBe("result-stored");
  });

  test("a completion from another role is rejected by the shared binding", () => {
    const h = harness({ seed: 109 });
    const child = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const prepared = prepare(h, child.sessionId, "T689-role");
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    const wrongRole: ClaudeChildCorrelation = { ...child, roleId: "implement-reviewer" };
    expect(
      expectRefusedWithoutWriting(h, () => confirm(h, prepared, wrongRole)),
    ).toBeInstanceOf(AttestationBindingError);
    expect(fetchState(h, prepared)).toBe("result-stored");
  });

  test("an old generation cannot store or confirm the replacement generation", () => {
    const h = harness({ seed: 113 });
    const firstChild = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const first = prepare(h, firstChild.sessionId, "T689-generation-one");
    abortDispatch(
      {
        namespace: NAMESPACE,
        actor: "trusted-parent",
        ...handleOf(first),
        reason: "cancelled",
      },
      h.service,
    );
    const secondChild = correlation("2f250bd2-e108-41c9-9374-deabca1188ad");
    const second = prepare(h, secondChild.sessionId, "T689-generation-two", {
      reprepareOf: handleOf(first),
    });
    expect(second.attestationId).toBe(first.attestationId);
    expect(second.generation).toBe(first.generation + 1);

    expect(
      expectRefusedWithoutWriting(h, () =>
        storeDispatchResult(
          { resultCapability: first.resultCapability, output: OUTPUT },
          h.service,
        ),
      ),
    ).toBeInstanceOf(DispatchStateConflictError);
    storeDispatchResult({ resultCapability: second.resultCapability, output: OUTPUT }, h.service);
    expect(
      expectRefusedWithoutWriting(h, () => confirm(h, second, firstChild)),
    ).toBeInstanceOf(AttestationBindingError);
    expect(confirm(h, second, secondChild).state).toBe("consumed");
    expect(fetchState(h, first)).toBe("aborted");
  });

  test("identical capability replay is idempotent; a different-output retry is rejected", () => {
    const h = harness({ seed: 127 });
    const prepared = prepare(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-result-retry",
    );
    const submission = { resultCapability: prepared.resultCapability, output: OUTPUT };
    const first = storeDispatchResult(submission, h.service);
    const afterFirst = storeDigest(h);
    expect(storeDispatchResult(submission, h.service)).toEqual(first);
    expect(storeDigest(h)).toBe(afterFirst);
    expect(
      expectRefusedWithoutWriting(h, () =>
        storeDispatchResult(
          {
            resultCapability: prepared.resultCapability,
            output: { ...OUTPUT, checkSummary: "different" },
          },
          h.service,
        ),
      ),
    ).toBeInstanceOf(DispatchStateConflictError);
  });
});

describe("T689 lifecycle precedence, races, and malformed evidence", () => {
  function racingHarness(seed: number): {
    readonly h: Harness;
    arm: (interference: () => void) => void;
  } {
    let interference: (() => void) | undefined;
    let fired = false;
    const h = harness({
      seed,
      fault: (operation) => {
        if (operation === "replace" && interference !== undefined && !fired) {
          fired = true;
          interference();
        }
      },
    });
    return {
      h,
      arm(interfere): void {
        interference = interfere;
      },
    };
  }

  test("confirm loses to an abort that commits first", () => {
    const { h, arm } = racingHarness(201);
    const child = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const prepared = prepare(h, child.sessionId, "T689-confirm-race");
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    arm(() => {
      abortDispatch(
        {
          namespace: NAMESPACE,
          actor: "trusted-parent",
          ...handleOf(prepared),
          reason: "cancelled",
        },
        h.service,
      );
    });
    expect(() => confirm(h, prepared, child)).toThrow(AttestationStorageError);
    expect(fetchState(h, prepared)).toBe("aborted");
  });

  test("abort loses to a confirmation that commits first", () => {
    const { h, arm } = racingHarness(203);
    const child = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const prepared = prepare(h, child.sessionId, "T689-abort-race");
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    arm(() => {
      confirm(h, prepared, child);
    });
    expect(() =>
      abortDispatch(
        {
          namespace: NAMESPACE,
          actor: "trusted-parent",
          ...handleOf(prepared),
          reason: "cancelled",
        },
        h.service,
      ),
    ).toThrow(AttestationStorageError);
    expect(fetchState(h, prepared)).toBe("consumed");
  });

  test("double confirmation is idempotent, while a mismatched proof is a conflict", () => {
    const h = harness({ seed: 211 });
    const child = correlation("1dea1c87-a984-448b-b038-d0078741a669");
    const prepared = prepare(h, child.sessionId, "T689-double-confirm");
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    const first = confirm(h, prepared, child);
    const afterFirst = storeDigest(h);
    expect(confirm(h, prepared, child)).toEqual(first);
    expect(storeDigest(h)).toBe(afterFirst);
    expect(
      expectRefusedWithoutWriting(h, () =>
        confirm(h, prepared, child, "2026-07-28T12:01:00.000Z"),
      ),
    ).toBeInstanceOf(DispatchStateConflictError);
  });

  test("cancellation after storage wins and retains no body on the parent result", () => {
    const h = harness({ seed: 223 });
    const result = runBridge(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-cancel-after-store",
      { cancelled: true },
    );
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("T689-BODY-SENTINEL");
    expect(fetchState(h, { ...result.handle } as DispatchPrepared)).toBe("aborted");
  });

  test("a mismatched transport completion aborts instead of confirming", () => {
    const h = harness({ seed: 227 });
    const expectedSession = "1dea1c87-a984-448b-b038-d0078741a669";
    const wrong = correlation("2f250bd2-e108-41c9-9374-deabca1188ad");
    const result = runBridge(h, expectedSession, "T689-mismatched-completion", {
      correlation: wrong,
    });
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("native-failure");
    expect(JSON.stringify(result.abort.details)).toContain("sessionId");
  });

  test("malformed, invalid, and absent output remain distinct failures", () => {
    const malformed = harness({ seed: 229 });
    const malformedPrepared = prepare(
      malformed,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-malformed",
    );
    expect(
      expectRefusedWithoutWriting(malformed, () =>
        storeDispatchResult(
          { resultCapability: malformedPrepared.resultCapability, output: undefined as never },
          malformed.service,
        ),
      ),
    ).toBeInstanceOf(DispatchRefAssemblyError);
    expect(fetchState(malformed, malformedPrepared)).toBe("prepared");

    const invalid = harness({ seed: 233 });
    const invalidResult = runBridge(
      invalid,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-invalid",
      { output: { taskId: "T689", status: "not-a-status" } },
    );
    expect(invalidResult.outcome).toBe("aborted");
    if (invalidResult.outcome !== "aborted") throw new Error("unreachable");
    expect(invalidResult.reason).toBe("invalid-output");

    const absent = harness({ seed: 239 });
    const absentResult = runBridge(
      absent,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-absent",
      { output: null },
    );
    expect(absentResult.outcome).toBe("aborted");
    if (absentResult.outcome !== "aborted") throw new Error("unreachable");
    expect(absentResult.reason).toBe("missing-result");
  });

  test("a full-body echo aborts without copying the body into abort details", () => {
    const h = harness({ seed: 241 });
    const result = runBridge(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-echo",
      { finalMessage: (handle) => JSON.stringify({ ...handle, output: OUTPUT }) },
    );
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") throw new Error("unreachable");
    expect(result.reason).toBe("protocol-violation");
    expect(JSON.stringify(result.abort.details)).toContain("echo");
    expect(JSON.stringify(result.abort.details)).not.toContain("T689-BODY-SENTINEL");
  });

  test("an unavailable store never returns a consumed bridge result", () => {
    let replacements = 0;
    const h = harness({
      seed: 251,
      fault: (operation) => {
        if (operation === "replace") {
          replacements += 1;
          if (replacements === 2) throw new AttestationStorageError("store unavailable");
        }
      },
    });
    let result: unknown;
    expect(() => {
      result = runBridge(
        h,
        "1dea1c87-a984-448b-b038-d0078741a669",
        "T689-unavailable",
      );
    }).toThrow(AttestationStorageError);
    expect(result).toBeUndefined();
    expect(h.store.snapshot()).toHaveLength(1);
    expect(
      fetchDispatchResult(
        {
          namespace: NAMESPACE,
          actor: "trusted-parent",
          attestationId: h.store.snapshot()[0]!.attestationId,
          generation: h.store.snapshot()[0]!.generation,
        },
        h.service,
      ).state,
    ).toBe("result-stored");
  });

  test("fetch is unavailable to untrusted actors and foreign namespaces", () => {
    const h = harness({ seed: 257 });
    const prepared = prepare(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-fetch-auth",
    );
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    confirm(h, prepared, correlation("1dea1c87-a984-448b-b038-d0078741a669"));
    for (const actor of ["", "child", "parent", "constructor", null, undefined]) {
      expect(
        expectRefusedWithoutWriting(h, () =>
          fetchDispatchResult(
            { namespace: NAMESPACE, actor: actor as never, ...handleOf(prepared) },
            h.service,
          ),
        ),
      ).toBeInstanceOf(DispatchAuthorizationError);
    }
    expect(
      expectRefusedWithoutWriting(h, () =>
        fetchDispatchResult(
          {
            namespace: { backend: "xdg", projectKey: "foreign" },
            actor: "trusted-parent",
            ...handleOf(prepared),
          },
          h.service,
        ),
      ),
    ).toBeInstanceOf(AttestationNamespaceError);
    for (const actor of TRUSTED_DISPATCH_ACTORS) {
      expect(
        fetchDispatchResult(
          { namespace: NAMESPACE, actor, ...handleOf(prepared) },
          h.service,
        ).state,
      ).toBe("consumed");
    }
  });
});

describe("T689 idempotency, restart, expiry, and one model-visible materialization", () => {
  test("restart recovery confirms the persisted result without another launch", () => {
    const live = harness({ seed: 307 });
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const child = correlation(sessionId);
    const request = dispatchRequest(sessionId, "T689-restart");
    const prepared = prepare(live, sessionId, request.idempotencyKey);
    const submission = storeDispatchResult(
      { resultCapability: prepared.resultCapability, output: OUTPUT },
      live.service,
    );
    const restartedStore = InMemoryAttestationStore.rehydrate(
      NAMESPACE,
      live.store.snapshot(),
    );
    const restartedService: DispatchServiceDeps = {
      store: restartedStore,
      now: live.clock.now,
    };
    const launchReport = report(live, prepared, child, { submission });
    const context = settleContext(request, prepared, child, launchReport);

    const first = recoverClaudeNativeDispatch(context, restartedService);
    expect(first.outcome).toBe("consumed");
    if (first.outcome !== "consumed") throw new Error("unreachable");
    const digestAfterFirst = restartedStore
      .snapshot()
      .map((row) => attestationRowDigest(row))
      .join("|");
    const retry = recoverClaudeNativeDispatch(context, restartedService);
    expect(retry).toEqual(first);
    expect(
      restartedStore
        .snapshot()
        .map((row) => attestationRowDigest(row))
        .join("|"),
    ).toBe(digestAfterFirst);
  });

  test("parent loss is an explicit idempotent abort from prepared or result-stored", () => {
    for (const state of ["prepared", "result-stored"] as const) {
      const h = harness({ seed: state === "prepared" ? 311 : 313 });
      const prepared = prepare(
        h,
        "1dea1c87-a984-448b-b038-d0078741a669",
        `T689-parent-lost-${state}`,
      );
      if (state === "result-stored") {
        storeDispatchResult(
          { resultCapability: prepared.resultCapability, output: OUTPUT },
          h.service,
        );
      }
      const request = {
        namespace: NAMESPACE,
        actor: "trusted-parent" as const,
        ...handleOf(prepared),
        reason: "parent-lost" as const,
        details: { state },
      };
      const first = abortDispatch(request, h.service);
      const afterFirst = storeDigest(h);
      expect(abortDispatch(request, h.service)).toEqual(first);
      expect(storeDigest(h)).toBe(afterFirst);
      expect(fetchState(h, prepared)).toBe("aborted");
      expect(JSON.stringify(first)).not.toContain("T689-BODY-SENTINEL");
    }
  });

  test("terminal expiry removes the body, capability, and eventually the idempotency hold", () => {
    const h = harness({ seed: 317 });
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const prepared = prepare(h, sessionId, "T689-expiry");
    storeDispatchResult({ resultCapability: prepared.resultCapability, output: OUTPUT }, h.service);
    confirm(h, prepared, correlation(sessionId));
    const terminalAt = h.clock.epochMs;

    h.clock.set(new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
    expect(fetchState(h, prepared)).toBe("terminal-envelope-expired");
    expect(sweepAttestations(h.service).envelopesCollapsed).toEqual([handleOf(prepared)]);
    expect(JSON.stringify(h.store.snapshot())).not.toContain("T689-BODY-SENTINEL");
    expect(() =>
      storeDispatchResult(
        { resultCapability: prepared.resultCapability, output: OUTPUT },
        h.service,
      ),
    ).toThrow(DispatchAuthorizationError);
    expect(() => prepare(h, sessionId, "T689-expiry")).toThrow(AttestationKeyReuseError);

    h.clock.set(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS).toISOString());
    expect(fetchState(h, prepared)).toBe("attestation-not-found");
    const replacement = prepare(h, sessionId, "T689-expiry");
    expect(replacement.attestationId).not.toBe(prepared.attestationId);
  });

  test("the body is absent from every bridge response and materializes once", () => {
    const h = harness({ seed: 331 });
    const result = runBridge(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-materialize",
    );
    expect(result.outcome).toBe("consumed");
    if (result.outcome !== "consumed") throw new Error("unreachable");
    expect(JSON.stringify(result)).not.toContain("T689-BODY-SENTINEL");
    expect(result.completion.outputDigest).toBe(dispatchPayloadDigest(OUTPUT));
    const materializer = createClaudeDispatchMaterializer(
      { namespace: NAMESPACE, ...result.handle },
      h.service,
    );
    expect(materializer.materialize()).toEqual(OUTPUT);
    expect(() => materializer.materialize()).toThrow(/already materialized/);
  });

  test("a failed materialization consumes the local one-use authority too", () => {
    const h = harness({ seed: 337 });
    const result = runBridge(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-materialize-unavailable",
    );
    expect(result.outcome).toBe("consumed");
    if (result.outcome !== "consumed") throw new Error("unreachable");
    const unavailableStore = new InMemoryAttestationStore(
      NAMESPACE,
      () => {
        throw new AttestationStorageError("fetch unavailable");
      },
    );
    const materializer = createClaudeDispatchMaterializer(
      { namespace: NAMESPACE, ...result.handle },
      { store: unavailableStore, now: h.clock.now },
    );
    expect(() => materializer.materialize()).toThrow(AttestationStorageError);
    expect(() => materializer.materialize()).toThrow(/already materialized/);
  });
});

describe("T689 transport provenance and telemetry availability", () => {
  test("completion records the actual bound role, run, agent, tool use, and model", () => {
    const h = harness({ seed: 401 });
    const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
    const result = runBridge(h, sessionId, "T689-telemetry-observed", {
      agentId: "agent-observed-T689",
      parentToolUseId: "toolu_observed_T689",
      resolvedModel: "claude-opus-5-20260715",
      exitStatus: 0,
    });
    expect(result.outcome).toBe("consumed");
    if (result.outcome !== "consumed") throw new Error("unreachable");
    expect(result.completion.nativeCompletion.childId.startsWith(`${ROLE_ID}#`)).toBe(true);
    expect(result.completion.nativeCompletion.runId).toBe(sessionId);
    expect(result.completion.correlationProvenance).toBe("transport-attested");
    expect(result.completion.exitStatusCorroborates).toBe("corroborates");
    expect(result.completion.transportProvenance).toEqual({
      agentId: "agent-observed-T689",
      parentToolUseId: "toolu_observed_T689",
      resolvedModel: "claude-opus-5-20260715",
      correlation: correlation(sessionId),
    });
  });

  test("unavailable exit telemetry is explicit and cannot masquerade as corroboration", () => {
    const h = harness({ seed: 409 });
    const result = runBridge(
      h,
      "1dea1c87-a984-448b-b038-d0078741a669",
      "T689-telemetry-unavailable",
    );
    expect(result.outcome).toBe("consumed");
    if (result.outcome !== "consumed") throw new Error("unreachable");
    expect(result.completion.exitStatusCorroborates).toBe("unavailable");
  });

  for (const field of ["agentId", "parentToolUseId", "resolvedModel"] as const) {
    test(`missing ${field} telemetry cannot promote a stored result`, () => {
      const h = harness({ seed: 419 });
      const sessionId = "1dea1c87-a984-448b-b038-d0078741a669";
      const child = correlation(sessionId);
      const request = dispatchRequest(sessionId, `T689-missing-${field}`);
      const prepared = prepare(h, sessionId, request.idempotencyKey);
      const submission = storeDispatchResult(
        { resultCapability: prepared.resultCapability, output: OUTPUT },
        h.service,
      );
      expect(() =>
        recoverClaudeNativeDispatch(
          settleContext(
            request,
            prepared,
            child,
            report(h, prepared, child, { submission, [field]: "" }),
          ),
          h.service,
        ),
      ).toThrow(AttestationContractError);
      expect(fetchState(h, prepared)).toBe("result-stored");
    });
  }
});
