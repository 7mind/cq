import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  HARNESSES,
  InMemoryAttestationStore,
  DispatchTransportAbort,
  DispatchTransportAdapterRegistry,
  DispatchTransportRoutingError,
  createClaudeProcessDispatchAdapter,
  createCodexProcessDispatchAdapter,
  createNativeDispatchAdapter,
  createPiProcessDispatchAdapter,
  fetchDispatchResult,
  interceptCodexRoleBoundaryResult,
  prepareDispatch,
  routeDispatchTransport,
  runPreparedDispatch,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type DispatchAdapterLaunchResult,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type Harness,
  type NativeCompletionProof,
} from "@cq/config";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "T1631-router" };
const T0 = "2026-08-02T18:45:00.000Z";
const OUTPUT: DispatchJSONValue = {
  taskId: "T1631",
  status: "pass",
  resultCommit: "a".repeat(40),
  branch: "implement/T1631",
  filesTouched: [],
  checkSummary: "focused router suite passed",
  summary: "shared transport router implemented",
  gateDurationMs: 1,
};

interface PreparedFixture {
  readonly prepared: DispatchPrepared;
  readonly deps: DispatchServiceDeps;
  readonly expectedCompletion: NativeCompletionProof;
}

function preparedFixture(targetHarness: Harness, sequence = 1): PreparedFixture {
  const clock = new FakeDispatchClock(T0);
  const store = new InMemoryAttestationStore(NAMESPACE);
  const expectedChild = {
    childId: `${targetHarness}-child`,
    runId: `${targetHarness}-run`,
  };
  const outcome = prepareDispatch(
    {
      namespace: NAMESPACE,
      roleId: "implement-worker",
      surface: targetHarness,
      input: {
        taskId: "T1631",
        headline: "Implement the shared transport router",
        description: "Route three harnesses through one lifecycle.",
        acceptance: "All 18 routing cells select the declared adapter.",
        worktreePath: "/tmp/T1631",
        branch: "implement/T1631",
        baseCommit: "2fe2c7d5",
      },
      idempotencyKey: `T1631-${targetHarness}-${sequence}`,
      timeoutMs: 60_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "a".repeat(64),
      catalogHash: "b".repeat(64),
      expectedChild,
    },
    { store, now: clock.now, randomBytes: sequentialDispatchRandomBytes(sequence) },
  );
  if (!outcome.accepted) throw new Error(`prepare failed: ${outcome.reason}: ${outcome.detail}`);
  return {
    prepared: outcome.prepared,
    deps: { store, now: clock.now },
    expectedCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      childId: expectedChild.childId,
      runId: expectedChild.runId,
      completedAt: T0,
    },
  };
}

function handleOf(prepared: DispatchPrepared): DispatchHandle {
  return { attestationId: prepared.attestationId, generation: prepared.generation };
}

function successfulLaunch(
  completion: NativeCompletionProof,
  counts: { input: number; store: number },
): (
  context: Parameters<ReturnType<typeof createNativeDispatchAdapter>["launch"]>[0],
) => DispatchAdapterLaunchResult {
  return (context) => {
    counts.input += 1;
    context.child.materializeInput();
    counts.store += 1;
    const stored = context.child.storeResult(OUTPUT);
    if (stored.state === "aborted") {
      return {
        outcome: "aborted",
        reason: stored.result.reason,
        ...(stored.result.details === undefined ? {} : { details: stored.result.details }),
      };
    }
    return {
      outcome: "completed",
      handle: handleOf(context.prepared),
      nativeCompletion: completion,
      handleOnlyEnforcement:
        context.route.transport === "process" ? "structural" : "prompt-best-effort",
    };
  };
}

describe("T1631 shared three-harness transport router", () => {
  test("enumerates all 18 routing decisions and selects native iff same-harness and not forced", () => {
    const decisions = HARNESSES.flatMap((activeHarness) =>
      HARNESSES.flatMap((targetHarness) =>
        [false, true].map((forceShellout) =>
          routeDispatchTransport({ activeHarness, targetHarness, forceShellout }),
        ),
      ),
    );

    expect(decisions).toHaveLength(18);
    expect(
      decisions.map(
        ({ activeHarness, targetHarness, forceShellout, transport, adapterId }) =>
          `${activeHarness}->${targetHarness}:${String(forceShellout)}:${transport}:${adapterId}`,
      ),
    ).toEqual([
      "claude->claude:false:native:claude:native",
      "claude->claude:true:process:claude:process",
      "claude->codex:false:process:codex:process",
      "claude->codex:true:process:codex:process",
      "claude->pi:false:process:pi:process",
      "claude->pi:true:process:pi:process",
      "codex->claude:false:process:claude:process",
      "codex->claude:true:process:claude:process",
      "codex->codex:false:native:codex:native",
      "codex->codex:true:process:codex:process",
      "codex->pi:false:process:pi:process",
      "codex->pi:true:process:pi:process",
      "pi->claude:false:process:claude:process",
      "pi->claude:true:process:claude:process",
      "pi->codex:false:process:codex:process",
      "pi->codex:true:process:codex:process",
      "pi->pi:false:native:pi:native",
      "pi->pi:true:process:pi:process",
    ]);
  });

  test("fails closed before launch when a selected native or process adapter is unavailable", () => {
    let launches = 0;
    const registry = new DispatchTransportAdapterRegistry([
      createClaudeProcessDispatchAdapter(() => {
        launches += 1;
        throw new Error("must not launch");
      }),
    ]);
    const missingNative = routeDispatchTransport({
      activeHarness: "codex",
      targetHarness: "codex",
      forceShellout: false,
    });
    const missingPiProcess = routeDispatchTransport({
      activeHarness: "claude",
      targetHarness: "pi",
      forceShellout: false,
    });

    expect(() => registry.resolve(missingNative)).toThrow(DispatchTransportRoutingError);
    expect(() => registry.resolve(missingPiProcess)).toThrow(DispatchTransportRoutingError);
    expect(launches).toBe(0);
  });

  test("rejects duplicate adapter registrations", () => {
    const launch = () => {
      throw new Error("must not launch");
    };
    expect(
      () =>
        new DispatchTransportAdapterRegistry([
          createCodexProcessDispatchAdapter(launch),
          createCodexProcessDispatchAdapter(launch),
        ]),
    ).toThrow(/registered more than once/);
  });

  test("rejects a prepared surface that does not match the target before launch", async () => {
    const fixture = preparedFixture("claude", 9);
    let launched = false;
    const registry = new DispatchTransportAdapterRegistry([
      createCodexProcessDispatchAdapter(() => {
        launched = true;
        throw new Error("must not launch");
      }),
    ]);
    await expect(
      runPreparedDispatch(
        {
          namespace: NAMESPACE,
          prepared: fixture.prepared,
          activeHarness: "claude",
          targetHarness: "codex",
          forceShellout: true,
        },
        registry,
        fixture.deps,
      ),
    ).rejects.toThrow(/prepared surface/);
    expect(launched).toBe(false);
  });

  for (const targetHarness of HARNESSES) {
    test(`${targetHarness} process adapter uses the authoritative one-shot lifecycle`, async () => {
      const fixture = preparedFixture(targetHarness, HARNESSES.indexOf(targetHarness) + 10);
      const counts = { input: 0, store: 0 };
      const launch = successfulLaunch(fixture.expectedCompletion, counts);
      const adapter =
        targetHarness === "claude"
          ? createClaudeProcessDispatchAdapter(launch)
          : targetHarness === "codex"
            ? createCodexProcessDispatchAdapter(launch)
            : createPiProcessDispatchAdapter(launch);
      const registry = new DispatchTransportAdapterRegistry([adapter]);
      const result = await runPreparedDispatch(
        {
          namespace: NAMESPACE,
          prepared: fixture.prepared,
          activeHarness: targetHarness === "claude" ? "codex" : "claude",
          targetHarness,
          forceShellout: false,
        },
        registry,
        fixture.deps,
      );

      expect(result).toMatchObject({
        outcome: "consumed",
        adapterId: `${targetHarness}:process`,
        output: OUTPUT,
      });
      expect(counts).toEqual({ input: 1, store: 1 });
      expect(
        fetchDispatchResult(
          { namespace: NAMESPACE, actor: "trusted-parent", ...handleOf(fixture.prepared) },
          fixture.deps,
        ).state,
      ).toBe("output-already-materialized");
    });
  }

  test("recorded cq-codex-role JSONL releases only the prepared handle", async () => {
    const fixture = preparedFixture("codex", 20);
    const counts = { input: 0, store: 0 };
    const handle = handleOf(fixture.prepared);
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "recorded-codex-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(handle) },
      }),
    ].join("\n");
    const registry = new DispatchTransportAdapterRegistry([
      createCodexProcessDispatchAdapter((context) => {
        counts.input += 1;
        context.child.materializeInput();
        counts.store += 1;
        context.child.storeResult(OUTPUT);
        return {
          outcome: "completed",
          handle: interceptCodexRoleBoundaryResult(jsonl, handle),
          nativeCompletion: fixture.expectedCompletion,
          handleOnlyEnforcement: "structural",
        };
      }),
    ]);

    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result.outcome).toBe("consumed");
    expect(counts).toEqual({ input: 1, store: 1 });
  });

  test("recorded Claude process completion remains structurally handle-only", async () => {
    const fixture = preparedFixture("claude", 21);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createClaudeProcessDispatchAdapter(successfulLaunch(fixture.expectedCompletion, counts)),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "pi",
        targetHarness: "claude",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "consumed", adapterId: "claude:process" });
    expect(counts).toEqual({ input: 1, store: 1 });
  });

  const transportFailures: readonly [string, DispatchTransportAbort, string][] = [
    [
      "timeout",
      new DispatchTransportAbort("deadline-exceeded", { source: "timeout" }),
      "deadline-exceeded",
    ],
    ["cancellation", new DispatchTransportAbort("cancelled", { source: "parent" }), "cancelled"],
    [
      "malformed final output",
      new DispatchTransportAbort("protocol-violation", { source: "final-message" }),
      "protocol-violation",
    ],
  ];
  for (const [label, failure, expectedReason] of transportFailures) {
    test(`maps ${label} to a typed authoritative abort`, async () => {
      const fixture = preparedFixture(
        "codex",
        30 + transportFailures.findIndex(([name]) => name === label),
      );
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(() => {
          throw failure;
        }),
      ]);
      const result = await runPreparedDispatch(
        {
          namespace: NAMESPACE,
          prepared: fixture.prepared,
          activeHarness: "claude",
          targetHarness: "codex",
          forceShellout: false,
        },
        registry,
        fixture.deps,
      );
      expect(result).toMatchObject({ outcome: "aborted", abort: { reason: expectedReason } });
    });
  }

  test("maps a malformed adapter result to a typed protocol abort", async () => {
    const fixture = preparedFixture("codex", 39);
    const registry = new DispatchTransportAdapterRegistry([
      createCodexProcessDispatchAdapter(
        () => ({ outcome: "unexpected", output: OUTPUT }) as unknown as DispatchAdapterLaunchResult,
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "protocol-violation" } });
  });

  test("invalid structured output aborts through capability-scoped storage", async () => {
    const fixture = preparedFixture("claude", 40);
    const registry = new DispatchTransportAdapterRegistry([
      createClaudeProcessDispatchAdapter((context) => {
        context.child.materializeInput();
        const stored = context.child.storeResult({ not: "an implement-worker result" });
        if (stored.state !== "aborted") throw new Error("invalid output unexpectedly stored");
        return {
          outcome: "aborted",
          reason: stored.result.reason,
          ...(stored.result.details === undefined ? {} : { details: stored.result.details }),
        };
      }),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "codex",
        targetHarness: "claude",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "invalid-output" } });
  });

  test("rejects raw-body echo from a process adapter", async () => {
    const fixture = preparedFixture("codex", 41);
    const counts = { input: 0, store: 0 };
    const launch = successfulLaunch(fixture.expectedCompletion, counts);
    const registry = new DispatchTransportAdapterRegistry([
      createCodexProcessDispatchAdapter(
        (context) =>
          ({
            ...launch(context),
            output: OUTPUT,
          }) as unknown as DispatchAdapterLaunchResult,
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "protocol-violation" } });
  });

  test("maps a completion-correlation mismatch to a typed native-failure abort", async () => {
    const fixture = preparedFixture("codex", 42);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createCodexProcessDispatchAdapter(
        successfulLaunch({ ...fixture.expectedCompletion, childId: "wrong-child" }, counts),
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "native-failure" } });
  });

  test("preserves prompt-best-effort only for same-harness native adapters", async () => {
    const fixture = preparedFixture("claude", 50);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createNativeDispatchAdapter("claude", successfulLaunch(fixture.expectedCompletion, counts)),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "claude",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "consumed", adapterId: "claude:native" });
    expect(counts).toEqual({ input: 1, store: 1 });
  });
});
