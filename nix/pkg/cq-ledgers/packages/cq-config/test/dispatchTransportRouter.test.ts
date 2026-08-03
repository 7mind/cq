import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWorktreeGate,
  closeWorktreeGate,
  isRegisteredProcessGroupAlive,
  launchRegisteredGateCommand,
  type WorktreeGateLease,
} from "@cq/process-control";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  HARNESSES,
  IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
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
  type AttestationRow,
  type ClaudeChildCorrelation,
  type CodexChildCorrelation,
  type DispatchAdapterLaunchContext,
  type DispatchAdapterLaunchResult,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type DispatchTransportAdapter,
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
  threadId: "parent-controlled-codex-run",
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

const REVIEWER_OUTPUT: DispatchJSONValue = {
  taskId: "T1696",
  verdict: "disapprove",
  criticism: ["Recorded transport fixture disapproval."],
  questions: [],
  defects: [],
  rationale: "The transport fixture intentionally stores a non-exhaustion disapproval.",
  gateReRan: false,
  resultCommitVerified: false,
  gateReRanReason: "transport-fixture-does-not-run-gate",
};

const REVIEWER_EXHAUSTION_OUTPUT: DispatchJSONValue = {
  taskId: "T1696",
  verdict: "disapprove",
  criticism: [IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM],
  questions: [],
  defects: [],
  rationale: IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM,
  gateReRan: false,
  resultCommitVerified: false,
  gateReRanReason: "phase-budget-exhausted-before-result-commit-verification",
};

interface CodexRecordingFixture {
  readonly root: string;
  readonly executable: string;
  readonly capturePath: string;
  readonly endpoint: RecordedCapabilityEndpoint;
}

interface RecordedCapabilityEndpoint {
  readonly url: string;
  readonly counts: { input: number; store: number };
  bind(context: DispatchAdapterLaunchContext): void;
  stop(): void;
}

function createRecordedCapabilityEndpoint(): RecordedCapabilityEndpoint {
  let context: DispatchAdapterLaunchContext | undefined;
  const counts = { input: 0, store: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      try {
        if (context === undefined) throw new Error("recorded capability endpoint was not bound");
        const body = (await request.json()) as Readonly<Record<string, unknown>>;
        const expectedHandle = handleOf(context.prepared);
        if (new URL(request.url).pathname === "/fetch") {
          if (
            JSON.stringify(body) !==
            JSON.stringify({
              ...expectedHandle,
              inputCapability: context.prepared.inputCapability,
            })
          ) {
            throw new Error("recorded child sent the wrong fetch capability request");
          }
          counts.input += 1;
          return Response.json(context.child.materializeInput());
        }
        if (new URL(request.url).pathname === "/store") {
          if (
            JSON.stringify(body) !==
            JSON.stringify({
              resultCapability: context.prepared.resultCapability,
              output: OUTPUT,
            })
          ) {
            throw new Error("recorded child sent the wrong store capability request");
          }
          counts.store += 1;
          return Response.json(context.child.storeResult(OUTPUT));
        }
        throw new Error("recorded child requested an unknown capability operation");
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    counts,
    bind: (boundContext) => {
      if (context !== undefined) throw new Error("recorded capability endpoint bound twice");
      context = boundContext;
    },
    stop: () => server.stop(true),
  };
}

function createCodexRecordingFixture(
  mode: "echo" | "failed-outcome" | "malformed" | "success" | "unused-capabilities" | "wait",
): CodexRecordingFixture {
  const endpoint = createRecordedCapabilityEndpoint();
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
  process.env["CQ_T1631_CAPABILITY_ENDPOINT"] = endpoint.url;
  return { root, executable, capturePath, endpoint };
}

function removeCodexRecordingFixture(fixture: CodexRecordingFixture): void {
  delete process.env["CQ_T1631_CODEX_MODE"];
  delete process.env["CQ_T1631_CODEX_CAPTURE"];
  delete process.env["CQ_T1631_CAPABILITY_ENDPOINT"];
  fixture.endpoint.stop();
  rmSync(fixture.root, { recursive: true, force: true });
}

interface PreparedFixture {
  readonly prepared: DispatchPrepared;
  readonly deps: DispatchServiceDeps;
  readonly expectedCompletion: NativeCompletionProof;
  readonly store: RecordingAttestationStore;
  readonly clock: FakeDispatchClock;
}

interface RecordedReplacement {
  readonly from: string;
  readonly to: string;
  readonly materializedOutput: boolean;
}

function rowState(row: AttestationRow): string {
  return row.kind === "envelope" ? row.state : `tombstone:${row.terminalKind}`;
}

class RecordingAttestationStore extends InMemoryAttestationStore {
  readonly replacements: RecordedReplacement[] = [];

  override replace(expected: AttestationRow, next: AttestationRow): void {
    this.replacements.push({
      from: rowState(expected),
      to: rowState(next),
      materializedOutput: next.kind === "envelope" && next.outputMaterializedAt !== undefined,
    });
    super.replace(expected, next);
  }
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
  const store = new RecordingAttestationStore(NAMESPACE);
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
        round: 0,
        startingCommit: "2".repeat(40),
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
    store,
    clock,
    expectedCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      childId: expectedChild.childId,
      runId: expectedChild.runId,
      completedAt: now,
    },
  };
}

function preparedReviewerFixture(targetHarness: Harness, sequence: number): PreparedFixture {
  const clock = new FakeDispatchClock(T0);
  const store = new RecordingAttestationStore(NAMESPACE);
  const expectedChild = {
    childId: `${targetHarness}-reviewer-child-${sequence}`,
    runId: `${targetHarness}-reviewer-run-${sequence}`,
  };
  const outcome = prepareDispatch(
    {
      namespace: NAMESPACE,
      roleId: "implement-reviewer",
      surface: targetHarness,
      input: {
        taskId: "T1696",
        acceptance: "Every transport delivers the original absolute review phase window.",
        worktreePath: "/tmp/T1696",
        branch: "implement/T1696",
        baseCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
        workerResult: {
          resultCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
          checkSummary: "REAL_CHECK_EXIT=0",
          filesTouched: [],
        },
        round: 1,
      },
      idempotencyKey: `T1696-${targetHarness}-${sequence}`,
      timeoutMs: IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
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
    store,
    clock,
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

function claudeRecordingResolver(
  endpoint: RecordedCapabilityEndpoint,
  extraArgs: readonly string[] = [],
): Parameters<typeof createClaudeProcessDispatchAdapter>[0] {
  return (context) => {
    endpoint.bind(context);
    return {
      correlation: CLAUDE_CORRELATION,
      model: "recorded-claude-model",
      now: () => T0,
      launchOptions: {
        claudeExecutable: process.execPath,
        claudeArgsPrefix: ["run", CLAUDE_RECORDING_FIXTURE, ...extraArgs],
        cwd: import.meta.dir,
        rolePrompt: CLAUDE_ROLE_PROMPT,
        storeServer: {
          name: "t688store",
          command: "cq-not-called-by-recording",
          args: ["mcp", "--dispatch-store"],
          cwd: import.meta.dir,
          env: {
            T688_SCOPE: "one-dispatch",
            CQ_T1631_CAPABILITY_ENDPOINT: endpoint.url,
          },
          capabilityEnv: "T688_CAPABILITY",
        },
      },
    };
  };
}

function codexRecordingResolver(
  fixture: CodexRecordingFixture,
  options?: {
    readonly correlation?: CodexChildCorrelation;
    readonly cwd?: string;
    readonly now?: string;
  },
): Parameters<typeof createCodexProcessDispatchAdapter>[0] {
  return (context) => {
    fixture.endpoint.bind(context);
    return {
      correlation: options?.correlation ?? CODEX_CORRELATION,
      now: () => options?.now ?? T0,
      boundary: {
        roleInstructions: CLAUDE_ROLE_PROMPT,
        cwd: options?.cwd ?? import.meta.dir,
        ledgerCwd: options?.cwd ?? import.meta.dir,
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

  test("all native and process transports consume the fetched absolute reviewer deadlines [BG]", async () => {
    const observed: Array<{ readonly adapterId: string; readonly input: DispatchJSONValue }> = [];
    const adapters = HARNESSES.flatMap((targetHarness) =>
      (["native", "process"] as const).map((transport): DispatchTransportAdapter => ({
        id: `${targetHarness}:${transport}`,
        targetHarness,
        transport,
        launch: (context) => {
          const input = context.child.materializeInput().input;
          observed.push({ adapterId: context.route.adapterId, input });
          const stored = context.child.storeResult(REVIEWER_OUTPUT);
          if (stored.state === "aborted") {
            return { outcome: "aborted", reason: stored.result.reason };
          }
          return {
            outcome: "completed",
            handle: handleOf(context.prepared),
            nativeCompletion: {
              kind: "native-completion",
              actor:
                context.route.transport === "process" || context.route.targetHarness === "pi"
                  ? "trusted-extension"
                  : "trusted-parent",
              childId: `${targetHarness}-reviewer-child-${HARNESSES.indexOf(targetHarness)}`,
              runId: `${targetHarness}-reviewer-run-${HARNESSES.indexOf(targetHarness)}`,
              completedAt: T0,
            },
            handleOnlyEnforcement:
              context.route.transport === "process" ? "structural" : "prompt-best-effort",
          };
        },
      })),
    );
    const registry = new DispatchTransportAdapterRegistry(adapters);

    for (const [sequence, targetHarness] of HARNESSES.entries()) {
      for (const transport of ["native", "process"] as const) {
        const fixture = preparedReviewerFixture(targetHarness, sequence);
        const result = await runPreparedDispatch(
          {
            namespace: NAMESPACE,
            prepared: fixture.prepared,
            activeHarness: targetHarness,
            targetHarness,
            forceShellout: transport === "process",
          },
          registry,
          fixture.deps,
        );
        expect(result.outcome).toBe("consumed");
      }
    }

    expect(observed.map(({ adapterId }) => adapterId).sort()).toEqual(
      HARNESSES.flatMap((target) => [`${target}:native`, `${target}:process`]).sort(),
    );
    for (const { input } of observed) {
      expect(input).toMatchObject({
        responseStoreNow: "2026-08-02T18:47:00.000Z",
        gateCompleteBy: "2026-08-02T18:46:00.000Z",
        synthesisStoreReserveMs: 60_000,
      });
    }
  });

  test("a reviewer launched one millisecond before launch cutoff exhausts only at gateCompleteBy [BG]", async () => {
    const fixture = preparedReviewerFixture("codex", 3);
    fixture.clock.advance(59_999);
    const exhaustionStates: boolean[] = [];
    const registry = new DispatchTransportAdapterRegistry([
      createNativeDispatchAdapter("codex", (context) => {
        const materialized = context.child.materializeInput();
        const input = materialized.input as Readonly<Record<string, DispatchJSONValue>>;
        const gateCompleteBy = input["gateCompleteBy"];
        if (typeof gateCompleteBy !== "string") throw new Error("missing gateCompleteBy");
        exhaustionStates.push(Date.parse(fixture.clock.peek()) >= Date.parse(gateCompleteBy));
        fixture.clock.advance(1);
        exhaustionStates.push(Date.parse(fixture.clock.peek()) >= Date.parse(gateCompleteBy));
        const stored = context.child.storeResult(REVIEWER_EXHAUSTION_OUTPUT);
        if (stored.state === "aborted") {
          return { outcome: "aborted", reason: stored.result.reason };
        }
        return {
          outcome: "completed",
          handle: handleOf(context.prepared),
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-parent",
            childId: "codex-reviewer-child-3",
            runId: "codex-reviewer-run-3",
            completedAt: fixture.clock.peek(),
          },
          handleOnlyEnforcement: "prompt-best-effort",
        };
      }),
    ]);
    const result = await runPreparedDispatch(
      {
        namespace: NAMESPACE,
        prepared: fixture.prepared,
        activeHarness: "codex",
        targetHarness: "codex",
        forceShellout: false,
      },
      registry,
      fixture.deps,
    );
    expect(result.outcome).toBe("consumed");
    expect(exhaustionStates).toEqual([false, true]);
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
    const endpoint = createRecordedCapabilityEndpoint();
    const fixture = preparedFixture("claude", 20, {
      expectedChild: claudeExpectedChild(CLAUDE_CORRELATION),
      promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
    });
    try {
      const registry = new DispatchTransportAdapterRegistry([
        createClaudeProcessDispatchAdapter(claudeRecordingResolver(endpoint)),
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
      expect(endpoint.counts).toEqual({ input: 1, store: 1 });
      expect(
        fetchDispatchResult(
          { namespace: NAMESPACE, actor: "trusted-parent", ...handleOf(fixture.prepared) },
          fixture.deps,
        ).state,
      ).toBe("output-already-materialized");
    } finally {
      endpoint.stop();
    }
  });

  test("a Claude child that uses neither scoped capability cannot complete", async () => {
    const endpoint = createRecordedCapabilityEndpoint();
    const fixture = preparedFixture("claude", 26, {
      expectedChild: claudeExpectedChild(CLAUDE_CORRELATION),
      promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
    });
    try {
      const registry = new DispatchTransportAdapterRegistry([
        createClaudeProcessDispatchAdapter(
          claudeRecordingResolver(endpoint, ["--skip-capabilities"]),
        ),
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
      expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "missing-result" } });
      expect(endpoint.counts).toEqual({ input: 0, store: 0 });
    } finally {
      endpoint.stop();
    }
  });

  test("Codex process adapter launches and records the production boundary plan", async () => {
    const processFixture = createCodexRecordingFixture("success");
    try {
      const fixture = preparedFixture("codex", 21, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture)),
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
      expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 1 });
      const capture = JSON.parse(readFileSync(processFixture.capturePath, "utf8")) as {
        readonly argv: readonly string[];
        readonly correlationId: string;
        readonly launch: Readonly<Record<string, unknown>>;
      };
      expect(capture.argv).toContain("--ignore-user-config");
      expect(capture.argv).toContain("--strict-config");
      expect(capture.correlationId).toBe(CODEX_CORRELATION.correlationId);
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

  test("a stored Codex handle with a live owned gate aborts before confirm or fetch", async () => {
    const processFixture = createCodexRecordingFixture("success");
    const ownedWorktree = join(processFixture.root, "owned-worktree");
    const unrelatedWorktree = join(processFixture.root, "unrelated-worktree");
    mkdirSync(ownedWorktree);
    mkdirSync(unrelatedWorktree);
    for (const worktree of [ownedWorktree, unrelatedWorktree]) {
      const initialized = Bun.spawnSync(["git", "init", "--quiet"], {
        cwd: worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (initialized.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(initialized.stderr));
      }
    }
    let ownedLease: WorktreeGateLease | undefined;
    let unrelatedLease: WorktreeGateLease | undefined;
    try {
      ownedLease = await acquireWorktreeGate({
        worktree: ownedWorktree,
        commandCwd: ownedWorktree,
      });
      unrelatedLease = await acquireWorktreeGate({
        worktree: unrelatedWorktree,
        commandCwd: unrelatedWorktree,
      });
      const ownedCommand = await launchRegisteredGateCommand(ownedLease, [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      const unrelatedCommand = await launchRegisteredGateCommand(unrelatedLease, [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      expect(await isRegisteredProcessGroupAlive(ownedCommand.registration)).toBe(true);
      expect(await isRegisteredProcessGroupAlive(unrelatedCommand.registration)).toBe(true);

      const fixture = preparedFixture("codex", 27, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          codexRecordingResolver(processFixture, { cwd: ownedWorktree }),
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
        abort: { reason: "protocol-violation" },
      });
      expect(result).not.toHaveProperty("output");
      expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 1 });
      expect(await isRegisteredProcessGroupAlive(ownedCommand.registration)).toBe(false);
      expect(await isRegisteredProcessGroupAlive(unrelatedCommand.registration)).toBe(true);
      expect(fixture.store.replacements.filter(({ to }) => to === "aborted")).toHaveLength(1);
      expect(fixture.store.replacements.filter(({ to }) => to === "consumed")).toHaveLength(0);
      expect(
        fixture.store.replacements.filter(({ materializedOutput }) => materializedOutput),
      ).toHaveLength(0);
      const row = fixture.store.rows()[0];
      expect(row).toMatchObject({
        kind: "envelope",
        state: "aborted",
        abortReason: "protocol-violation",
      });
      if (row?.kind !== "envelope") throw new Error("expected one live attestation envelope");
      expect(row.nativeCompletion).toBeUndefined();
      expect(row.outputMaterializedAt).toBeUndefined();
    } finally {
      if (unrelatedLease !== undefined) await closeWorktreeGate(unrelatedLease);
      if (ownedLease !== undefined) await closeWorktreeGate(ownedLease);
      removeCodexRecordingFixture(processFixture);
    }
  });

  for (const [mode, sequence] of [["failed-outcome", 28]] as const) {
    test(`Codex process adapter rejects the recorded ${mode} observation`, async () => {
      const processFixture = createCodexRecordingFixture(mode);
      try {
        const fixture = preparedFixture("codex", sequence, {
          expectedChild: codexExpectedChild(CODEX_CORRELATION),
          promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
        });
        const registry = new DispatchTransportAdapterRegistry([
          createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture)),
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
        expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 1 });
      } finally {
        removeCodexRecordingFixture(processFixture);
      }
    });
  }

  test("a Codex child that uses neither scoped capability cannot complete", async () => {
    const processFixture = createCodexRecordingFixture("unused-capabilities");
    try {
      const fixture = preparedFixture("codex", 29, {
        expectedChild: codexExpectedChild(CODEX_CORRELATION),
        promptDigest: promptDigestOf(CLAUDE_ROLE_PROMPT),
      });
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture)),
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
      expect(result).toMatchObject({ outcome: "aborted", abort: { reason: "missing-result" } });
      expect(processFixture.endpoint.counts).toEqual({ input: 0, store: 0 });
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
        const registry = new DispatchTransportAdapterRegistry([
          createCodexProcessDispatchAdapter(codexRecordingResolver(processFixture)),
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
        expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 1 });
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
      const wrongCorrelation: CodexChildCorrelation = {
        ...CODEX_CORRELATION,
        correlationId: "T1631WrongCorrelation0123456789abcdef",
      };
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          codexRecordingResolver(processFixture, { correlation: wrongCorrelation }),
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
      expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 1 });
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
      const launchAt = new Date(
        Date.parse(fixture.prepared.responseStoreNow) - 1_000,
      ).toISOString();
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          codexRecordingResolver(processFixture, { now: launchAt }),
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
      expect(processFixture.endpoint.counts).toEqual({ input: 1, store: 0 });
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

  const malformedCompletionProofs: readonly [string, unknown][] = [
    [
      "missing kind",
      {
        actor: "trusted-extension",
        childId: "pi-child",
        runId: "pi-run",
        completedAt: T0,
      },
    ],
    [
      "non-string child id",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: 7,
        runId: "pi-run",
        completedAt: T0,
      },
    ],
    [
      "missing actor",
      {
        kind: "native-completion",
        childId: "pi-child",
        runId: "pi-run",
        completedAt: T0,
      },
    ],
    [
      "non-string actor",
      {
        kind: "native-completion",
        actor: 7,
        childId: "pi-child",
        runId: "pi-run",
        completedAt: T0,
      },
    ],
    [
      "empty child id",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "",
        runId: "pi-run",
        completedAt: T0,
      },
    ],
    [
      "missing run id",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        completedAt: T0,
      },
    ],
    [
      "non-string run id",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        runId: 7,
        completedAt: T0,
      },
    ],
    [
      "empty run id",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        runId: "",
        completedAt: T0,
      },
    ],
    [
      "non-string completion instant",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        runId: "pi-run",
        completedAt: 7,
      },
    ],
    [
      "invalid completion instant",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        runId: "pi-run",
        completedAt: "not-an-instant",
      },
    ],
    [
      "surplus field",
      {
        kind: "native-completion",
        actor: "trusted-extension",
        childId: "pi-child",
        runId: "pi-run",
        completedAt: T0,
        output: OUTPUT,
      },
    ],
  ];
  for (const [label, nativeCompletion] of malformedCompletionProofs) {
    test(`maps malformed ${label} completion proof to a typed protocol abort`, async () => {
      const fixture = preparedFixture(
        "pi",
        60 + malformedCompletionProofs.findIndex(([name]) => name === label),
      );
      const registry = new DispatchTransportAdapterRegistry([
        createPiProcessDispatchAdapter((context) => {
          context.child.materializeInput();
          context.child.storeResult(OUTPUT);
          return {
            outcome: "completed",
            handle: handleOf(context.prepared),
            nativeCompletion,
            handleOnlyEnforcement: "structural",
          } as unknown as DispatchAdapterLaunchResult;
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
      expect(result).toMatchObject({
        outcome: "aborted",
        abort: {
          reason: "protocol-violation",
          details: { violation: "malformed-native-completion-proof" },
        },
      });
    });
  }

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

  for (const [label, sequence, malformedHandle] of [
    ["missing nested handle field", 70, { attestationId: "replaced below" }],
    [
      "surplus nested handle field",
      71,
      { attestationId: "replaced below", generation: 1, output: OUTPUT },
    ],
  ] as const) {
    test(`rejects a completion with a ${label}`, async () => {
      const fixture = preparedFixture("pi", sequence);
      const handle = {
        ...malformedHandle,
        attestationId: fixture.prepared.attestationId,
        ...(Object.hasOwn(malformedHandle, "generation")
          ? { generation: fixture.prepared.generation }
          : {}),
      };
      const registry = new DispatchTransportAdapterRegistry([
        createPiProcessDispatchAdapter((context) => {
          context.child.materializeInput();
          context.child.storeResult(OUTPUT);
          return {
            outcome: "completed",
            handle,
            nativeCompletion: {
              ...fixture.expectedCompletion,
              actor: "trusted-extension",
            },
            handleOnlyEnforcement: "structural",
          } as unknown as DispatchAdapterLaunchResult;
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
      expect(result).toMatchObject({
        outcome: "aborted",
        abort: {
          reason: "protocol-violation",
          details: { violation: "malformed-adapter-completion-handle" },
        },
      });
    });
  }

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
