import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  claudeExpectedChild,
  codexExpectedChild,
  fetchDispatchResult,
  prepareDispatch,
  routeDispatchTransport,
  runPreparedDispatch,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type ClaudeChildCorrelation,
  type CodexChildCorrelation,
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
const CLAUDE_SESSION_ID = "1dea1c87-a984-448b-b038-d0078741a669";
const CLAUDE_ROLE_PROMPT = "T688-ROLE-PROMPT implement-worker";
const CLAUDE_RECORDING_FIXTURE = fileURLToPath(
  new URL("fixtures/claude-print-recording.ts", import.meta.url),
);
const CODEX_RECORDING_FIXTURE = fileURLToPath(
  new URL("fixtures/codex-role-recording.ts", import.meta.url),
);
const CLAUDE_CORRELATION: ClaudeChildCorrelation = {
  roleId: "implement-worker",
  launchNonce: CLAUDE_SESSION_ID,
  sessionId: CLAUDE_SESSION_ID,
};
const CODEX_CORRELATION: CodexChildCorrelation = {
  agentType: "implement-worker",
  correlationId: "T1631CodexCorrelation0123456789abcd",
  threadId: "recorded-codex-thread",
};
const promptDigestOf = (prompt: string): string =>
  new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
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

interface CodexRecordingFixture {
  readonly root: string;
  readonly executable: string;
  readonly capturePath: string;
}

function createCodexRecordingFixture(
  mode: "echo" | "malformed" | "success" | "wait",
): CodexRecordingFixture {
  const root = mkdtempSync(join(tmpdir(), "cq-t1631-codex-"));
  const executable = join(root, "codex-recording");
  const capturePath = join(root, "launch.json");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CODEX_RECORDING_FIXTURE)} "$@"\n`,
  );
  chmodSync(executable, 0o700);
  process.env["CQ_T1631_CODEX_MODE"] = mode;
  process.env["CQ_T1631_CODEX_CAPTURE"] = capturePath;
  return { root, executable, capturePath };
}

function removeCodexRecordingFixture(fixture: CodexRecordingFixture): void {
  delete process.env["CQ_T1631_CODEX_MODE"];
  delete process.env["CQ_T1631_CODEX_CAPTURE"];
  rmSync(fixture.root, { recursive: true, force: true });
}

interface PreparedFixture {
  readonly prepared: DispatchPrepared;
  readonly deps: DispatchServiceDeps;
  readonly expectedCompletion: NativeCompletionProof;
}

interface PreparedFixtureOptions {
  readonly expectedChild?: { readonly childId: string; readonly runId: string };
  readonly now?: string;
  readonly promptDigest?: string;
  readonly timeoutMs?: number;
}

function preparedFixture(
  targetHarness: Harness,
  sequence: number,
  options?: PreparedFixtureOptions,
): PreparedFixture {
  const now = options?.now ?? T0;
  const clock = new FakeDispatchClock(now);
  const store = new InMemoryAttestationStore(NAMESPACE);
  const expectedChild = options?.expectedChild ?? {
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
      timeoutMs: options?.timeoutMs ?? 60_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: options?.promptDigest ?? "a".repeat(64),
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
      completedAt: now,
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

function storeRecordedOutput(
  context: Parameters<ReturnType<typeof createNativeDispatchAdapter>["launch"]>[0],
  counts: { input: number; store: number },
): void {
  counts.input += 1;
  context.child.materializeInput();
  counts.store += 1;
  const stored = context.child.storeResult(OUTPUT);
  if (stored.state === "aborted") {
    throw new Error(`recorded child store aborted: ${stored.result.reason}`);
  }
}

function claudeRecordingResolver(counts: {
  input: number;
  store: number;
}): Parameters<typeof createClaudeProcessDispatchAdapter>[0] {
  return (context) => {
    storeRecordedOutput(context, counts);
    return {
      correlation: CLAUDE_CORRELATION,
      model: "recorded-claude-model",
      now: () => T0,
      launchOptions: {
        claudeExecutable: process.execPath,
        claudeArgsPrefix: ["run", CLAUDE_RECORDING_FIXTURE],
        cwd: import.meta.dir,
        rolePrompt: CLAUDE_ROLE_PROMPT,
        storeServer: {
          name: "t688store",
          command: "cq-not-called-by-recording",
          args: ["mcp", "--dispatch-store"],
          cwd: import.meta.dir,
          env: { T688_SCOPE: "one-dispatch" },
          capabilityEnv: "T688_CAPABILITY",
        },
      },
    };
  };
}

function codexRecordingResolver(
  fixture: CodexRecordingFixture,
  counts: { input: number; store: number },
  options?: {
    readonly correlation?: CodexChildCorrelation;
    readonly now?: string;
    readonly storeResult?: boolean;
  },
): Parameters<typeof createCodexProcessDispatchAdapter>[0] {
  return (context) => {
    counts.input += 1;
    context.child.materializeInput();
    if (options?.storeResult !== false) {
      counts.store += 1;
      const stored = context.child.storeResult(OUTPUT);
      if (stored.state === "aborted") {
        throw new Error(`recorded child store aborted: ${stored.result.reason}`);
      }
    }
    return {
      correlation: options?.correlation ?? CODEX_CORRELATION,
      now: () => options?.now ?? T0,
      boundary: {
        roleInstructions: CLAUDE_ROLE_PROMPT,
        cwd: import.meta.dir,
        ledgerCwd: import.meta.dir,
        model: "recorded-codex-model",
        reasoningEffort: "high",
        sandboxMode: "danger-full-access",
        promptRoot: import.meta.dir,
        ledgerCommand: "cq-not-called-by-recording",
        codexExecutable: fixture.executable,
      },
    };
  };
}

describe("T1631 shared three-harness transport router", () => {
  test("production process adapters bind the existing Claude and Codex boundaries", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/dispatchTransportRouter.ts", import.meta.url)),
      "utf8",
    );
    for (const requiredBinding of [
      "launchClaudePrint",
      "createCodexRoleBoundaryPlan",
      "executeCodexRoleBoundary",
    ]) {
      expect(source, requiredBinding).toContain(requiredBinding);
    }
  });

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
      createPiProcessDispatchAdapter(() => {
        launches += 1;
        throw new Error("must not launch");
      }),
    ]);
    const missingNative = routeDispatchTransport({
      activeHarness: "codex",
      targetHarness: "codex",
      forceShellout: false,
    });
    const missingClaudeProcess = routeDispatchTransport({
      activeHarness: "codex",
      targetHarness: "claude",
      forceShellout: false,
    });

    expect(() => registry.resolve(missingNative)).toThrow(DispatchTransportRoutingError);
    expect(() => registry.resolve(missingClaudeProcess)).toThrow(DispatchTransportRoutingError);
    expect(launches).toBe(0);
  });

  test("rejects duplicate adapter registrations", () => {
    const launch = () => {
      throw new Error("must not launch");
    };
    expect(
      () =>
        new DispatchTransportAdapterRegistry([
          createPiProcessDispatchAdapter(launch),
          createPiProcessDispatchAdapter(launch),
        ]),
    ).toThrow(/registered more than once/);
  });

  test("rejects a prepared surface that does not match the target before launch", async () => {
    const fixture = preparedFixture("claude", 9);
    let launched = false;
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter(() => {
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

  test("Pi process seam uses the authoritative one-shot lifecycle", async () => {
    const fixture = preparedFixture("pi", 12);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter(
        successfulLaunch({ ...fixture.expectedCompletion, actor: "trusted-extension" }, counts),
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "pi",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "consumed", adapterId: "pi:process", output: OUTPUT });
    expect(counts).toEqual({ input: 1, store: 1 });
  });

  test("Claude process adapter launches the recorded production boundary", async () => {
    const fixture = preparedFixture("claude", 20, {
      expectedChild: claudeExpectedChild(CLAUDE_CORRELATION),
      promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
    });
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createClaudeProcessDispatchAdapter(claudeRecordingResolver(counts)),
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
    expect(result).toMatchObject({
      outcome: "consumed",
      adapterId: "claude:process",
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

  test("Codex process adapter launches and records the production boundary plan", async () => {
    const processFixture = createCodexRecordingFixture("success");
    try {
      const fixture = preparedFixture("codex", 21, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const counts = { input: 0, store: 0 };
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture, counts)),
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

      expect(result).toMatchObject({
        outcome: "consumed",
        adapterId: "codex:process",
        output: OUTPUT,
      });
      expect(counts).toEqual({ input: 1, store: 1 });
      const capture = JSON.parse(readFileSync(processFixture.capturePath, "utf8")) as {
        readonly argv: readonly string[];
        readonly launch: Readonly<Record<string, unknown>>;
      };
      expect(capture.argv).toContain("--ignore-user-config");
      expect(capture.argv).toContain("--strict-config");
      expect(capture.launch).toEqual({
        attestationId: fixture.prepared.attestationId,
        generation: fixture.prepared.generation,
        inputCapability: fixture.prepared.inputCapability,
        resultCapability: fixture.prepared.resultCapability,
      });
      expect(
        fetchDispatchResult(
          { namespace: NAMESPACE, actor: "trusted-parent", ...handleOf(fixture.prepared) },
          fixture.deps,
        ).state,
      ).toBe("output-already-materialized");
    } finally {
      removeCodexRecordingFixture(processFixture);
    }
  });

  for (const mode of ["malformed", "echo"] as const) {
    test(`Codex production boundary maps ${mode} final output to protocol-violation`, async () => {
      const processFixture = createCodexRecordingFixture(mode);
      try {
        const fixture = preparedFixture("codex", mode === "malformed" ? 22 : 23, {
          expectedChild: codexExpectedChild(CODEX_CORRELATION),
          promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
        });
        const counts = { input: 0, store: 0 };
        const registry = new DispatchTransportAdapterRegistry([
          createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture, counts)),
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
        expect(result).toMatchObject({
          outcome: "aborted",
          abort: { reason: "protocol-violation" },
        });
        expect(counts).toEqual({ input: 1, store: 1 });
      } finally {
        removeCodexRecordingFixture(processFixture);
      }
    });
  }

  test("Codex process correlation mismatch aborts before result materialization", async () => {
    const processFixture = createCodexRecordingFixture("success");
    try {
      const fixture = preparedFixture("codex", 24, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const counts = { input: 0, store: 0 };
      const wrongCorrelation: CodexChildCorrelation = {
        ...CODEX_CORRELATION,
        correlationId: "T1631WrongCorrelation0123456789abcdef",
      };
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          codexRecordingResolver(processFixture, counts, { correlation: wrongCorrelation }),
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
      expect(counts).toEqual({ input: 1, store: 1 });
    } finally {
      removeCodexRecordingFixture(processFixture);
    }
  });

  test("Codex process timeout becomes the authoritative deadline-exceeded abort", async () => {
    const processFixture = createCodexRecordingFixture("wait");
    try {
      const fixture = preparedFixture("codex", 25, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const launchAt = new Date(Date.parse(fixture.prepared.responseStoreNow) - 100).toISOString();
      const counts = { input: 0, store: 0 };
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          codexRecordingResolver(processFixture, counts, {
            now: launchAt,
            storeResult: false,
          }),
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
      expect(result).toMatchObject({
        outcome: "aborted",
        abort: { reason: "deadline-exceeded" },
      });
      expect(counts).toEqual({ input: 1, store: 0 });
    } finally {
      removeCodexRecordingFixture(processFixture);
    }
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
        "pi",
        30 + transportFailures.findIndex(([name]) => name === label),
      );
      const registry = new DispatchTransportAdapterRegistry([
        createPiProcessDispatchAdapter(() => {
          throw failure;
        }),
      ]);
      const result = await runPreparedDispatch(
        {
          namespace: NAMESPACE,
          prepared: fixture.prepared,
          activeHarness: "claude",
          targetHarness: "pi",
          forceShellout: false,
        },
        registry,
        fixture.deps,
      );
      expect(result).toMatchObject({ outcome: "aborted", abort: { reason: expectedReason } });
    });
  }

  test("maps a malformed adapter result to a typed protocol abort", async () => {
    const fixture = preparedFixture("pi", 39);
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter(
        () => ({ outcome: "unexpected", output: OUTPUT }) as unknown as DispatchAdapterLaunchResult,
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "pi",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "protocol-violation" } });
  });

  test("invalid structured output aborts through capability-scoped storage", async () => {
    const fixture = preparedFixture("pi", 40);
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter((context) => {
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
        activeHarness: "claude",
        targetHarness: "pi",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "invalid-output" } });
  });

  test("rejects raw-body echo from a process adapter", async () => {
    const fixture = preparedFixture("pi", 41);
    const counts = { input: 0, store: 0 };
    const launch = successfulLaunch(fixture.expectedCompletion, counts);
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter(
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
        targetHarness: "pi",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "protocol-violation" } });
  });

  test("maps a Pi completion-correlation mismatch to a typed native-failure abort", async () => {
    const fixture = preparedFixture("pi", 42);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createPiProcessDispatchAdapter(
        successfulLaunch(
          {
            ...fixture.expectedCompletion,
            actor: "trusted-extension",
            childId: "wrong-child",
          },
          counts,
        ),
      ),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "claude",
        targetHarness: "pi",
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
