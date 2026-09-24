import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  HARNESSES,
  IMPLEMENT_REVIEWER_PHASE_EXHAUSTION_CRITICISM,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
  InMemoryAttestationStore,
  DISPATCH_ABORT_REASONS,
  DispatchTransportAbort,
  DispatchTransportAdapterRegistry,
  DispatchTransportRoutingError,
  createClaudeProcessDispatchAdapter,
  createNativeDispatchAdapter,
  createPiProcessDispatchAdapter,
  claudeExpectedChild,
  dispatchEffectTargetRef,
  fetchDispatchResult,
  prepareDispatch,
  routeDispatchTransport,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type AttestationRow,
  type AbortedDispatchResult,
  type ClaudeChildCorrelation,
  type DispatchAdapterLaunchContext,
  type DispatchAdapterLaunchResult,
  type DispatchAbortReason,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type DispatchTransportAdapter,
  type Harness,
  type NativeCompletionProof,
  type ReviewerToken,
} from "@cq/config";
import { withClaudeRoleFrontmatter } from "./fixtures/claudeRoleFrontmatter.js";
import { runPreparedDispatchOverService } from "./fixtures/routedDispatchOverService.js";
import {
  attestationServiceSettlement,
  runPreparedDispatch as runPreparedDispatchBound,
  type DispatchSettlementPort,
} from "../src/dispatchTransportRouter.js";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "T1631-router" };
const T0 = "2026-08-02T18:45:00.000Z";
const CLAUDE_SESSION_ID = "1dea1c87-a984-448b-b038-d0078741a669";
const CLAUDE_ROLE_PROMPT = withClaudeRoleFrontmatter("implement-worker", "Agent", "T688-ROLE-PROMPT implement-worker");
const CLAUDE_RECORDING_FIXTURE = fileURLToPath(
  new URL("fixtures/claude-print-recording.ts", import.meta.url),
);
const CLAUDE_CORRELATION: ClaudeChildCorrelation = {
  roleId: "implement-worker",
  launchNonce: CLAUDE_SESSION_ID,
  sessionId: CLAUDE_SESSION_ID,
};
const RESOLVED_MODELS: Readonly<Record<Harness, ReviewerToken>> = Object.freeze({
  claude: { harness: "claude", model: "recorded-claude-model", provider: null, effort: "high" },
  codex: { harness: "codex", model: "recorded-codex-model", provider: null, effort: "high" },
  pi: {
    harness: "pi",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    effort: "xhigh",
  },
});
const promptDigestOf = (prompt: string): string =>
  new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
const OUTPUT: DispatchJSONValue = {
  taskId: "T1631",
  status: "pass",
  resultCommit: "a".repeat(40),
  branch: "implement/T1631",
  actualWorktreePath: "/tmp/wt-actual",
  filesTouched: [],
  checkSummary: "focused router suite passed",
  summary: "shared transport router implemented",
  gateDurationMs: 1,
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  },
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
  resultCommitEvidence: {
    status: "unresolvable",
    reason: "worktree-unresolvable",
    resultCommit: null,
    branchTip: null,
  },
  baseAncestry: {
    status: "unresolvable",
    reason: "result-commit-missing",
    baseCommit: null,
    resultCommit: null,
    mergeBase: null,
  },
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
  resultCommitEvidence: {
    status: "unresolvable",
    reason: "worktree-unresolvable",
    resultCommit: null,
    branchTip: null,
  },
  baseAncestry: {
    status: "unresolvable",
    reason: "result-commit-missing",
    baseCommit: null,
    resultCommit: null,
    mergeBase: null,
  },
};

interface RecordedCapabilityEndpoint {
  readonly url: string;
  readonly counts: { input: number; store: number };
  bind(context: DispatchAdapterLaunchContext): void;
  bindAbort(abort: (reason: DispatchAbortReason) => AbortedDispatchResult): void;
  stop(): void;
}

function isDispatchAbortReason(value: unknown): value is DispatchAbortReason {
  return DISPATCH_ABORT_REASONS.some((candidate) => candidate === value);
}

function createRecordedCapabilityEndpoint(): RecordedCapabilityEndpoint {
  let context: DispatchAdapterLaunchContext | undefined;
  let abort: ((reason: DispatchAbortReason) => AbortedDispatchResult) | undefined;
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
          return Response.json(await context.child.materializeInput());
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
          return Response.json(await context.child.storeResult(OUTPUT));
        }
        if (new URL(request.url).pathname === "/abort") {
          const reason = body["reason"];
          if (
            body["attestationId"] !== expectedHandle.attestationId ||
            body["generation"] !== expectedHandle.generation ||
            !isDispatchAbortReason(reason) ||
            abort === undefined
          ) {
            throw new Error("recorded child sent an invalid abort acknowledgement request");
          }
          counts.store += 1;
          return Response.json({ state: "aborted", result: abort(reason) });
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
    bindAbort: (boundAbort) => {
      if (abort !== undefined) throw new Error("recorded capability abort bound twice");
      abort = boundAbort;
    },
    stop: () => server.stop(true),
  };
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
        baseCommit: "2fe2c7d5".padEnd(40, "0"),
        round: 0,
        startingCommit: "2".repeat(40),
        validationIntent: "final",
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

function runPreparedDispatch(
  request: Omit<Parameters<typeof runPreparedDispatchOverService>[0], "resolvedModel">,
  registry: Parameters<typeof runPreparedDispatchOverService>[1],
  deps: Parameters<typeof runPreparedDispatchOverService>[2],
): ReturnType<typeof runPreparedDispatchOverService> {
  return runPreparedDispatchOverService(
    { ...request, resolvedModel: RESOLVED_MODELS[request.targetHarness] },
    registry,
    deps,
  );
}

function successfulLaunch(
  completion: NativeCompletionProof,
  counts: { input: number; store: number },
): (
  context: Parameters<ReturnType<typeof createNativeDispatchAdapter>["launch"]>[0],
) => Promise<DispatchAdapterLaunchResult> {
  return async (context) => {
    counts.input += 1;
    await context.child.materializeInput();
    counts.store += 1;
    const stored = await context.child.storeResult(OUTPUT);
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
): Parameters<typeof createClaudeProcessDispatchAdapter>[1] {
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

describe("T1631 shared three-harness transport router", () => {
  test("the production Claude process adapter binds the existing print boundary", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/dispatchTransportRouter.ts", import.meta.url)),
      "utf8",
    );
    for (const requiredBinding of ["launchClaudePrint"]) {
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

  test("T2045 binds the resolved model and effort through every one of the 18 lifecycle cells [BA]", async () => {
    const counts = { input: 0, store: 0 };
    const adapters: DispatchTransportAdapter[] = HARNESSES.flatMap((targetHarness) =>
      (["native", "process"] as const).map((transport) => ({
        id: `${targetHarness}:${transport}`,
        targetHarness,
        transport,
        launch: async (context: DispatchAdapterLaunchContext): Promise<DispatchAdapterLaunchResult> => {
          expect(context.resolvedModel).toEqual(RESOLVED_MODELS[targetHarness]);
          expect(Object.keys(context.route).sort()).toEqual([
            "activeHarness",
            "adapterId",
            "forceShellout",
            "targetHarness",
            "transport",
          ]);
          expect(context.prepared.promptProvenance).toMatchObject({
            roleId: "implement-worker",
            surface: targetHarness,
          });
          expect(context.effectTargetRef).toBe("tasks:T1631");
          expect(Date.parse(context.prepared.launchDeadline)).toBeGreaterThan(Date.parse(T0));
          counts.input += 1;
          const materialized = await context.child.materializeInput();
          expect(materialized).toMatchObject({
            attestationId: context.prepared.attestationId,
            generation: context.prepared.generation,
            state: "input-materialized",
            input: {
              taskId: "T1631",
              worktreePath: "/tmp/T1631",
              branch: "implement/T1631",
            },
          });
          counts.store += 1;
          const stored = await context.child.storeResult(OUTPUT);
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
              childId: `${targetHarness}-child`,
              runId: `${targetHarness}-run`,
              completedAt: T0,
            },
            handleOnlyEnforcement:
              context.route.transport === "process" ? "structural" : "prompt-best-effort",
          };
        },
      })),
    );
    const registry = new DispatchTransportAdapterRegistry(adapters);
    let sequence = 200;

    for (const activeHarness of HARNESSES) {
      for (const targetHarness of HARNESSES) {
        for (const forceShellout of [false, true] as const) {
          const fixture = preparedFixture(targetHarness, sequence++);
          const result = await runPreparedDispatchOverService(
            {
              namespace: NAMESPACE,
              prepared: fixture.prepared,
              activeHarness,
              targetHarness,
              forceShellout,
              resolvedModel: RESOLVED_MODELS[targetHarness],
            },
            registry,
            fixture.deps,
          );
          expect(result.outcome).toBe("consumed");
          expect(result.route).toEqual(
            routeDispatchTransport({ activeHarness, targetHarness, forceShellout }),
          );
          expect(result).toMatchObject({
            adapterId: `${targetHarness}:${result.route.transport}`,
            handle: handleOf(fixture.prepared),
            output: OUTPUT,
          });
        }
      }
    }

    expect(counts).toEqual({ input: 18, store: 18 });
  });

  test("rejects a model bound to another harness before adapter or capability access [BA]", async () => {
    const fixture = preparedFixture("codex", 219);
    let launches = 0;
    const registry = new DispatchTransportAdapterRegistry([
      createNativeDispatchAdapter("codex", () => {
        launches += 1;
        throw new Error("mismatched model reached adapter");
      }),
    ]);

    await expect(
      runPreparedDispatchOverService(
        {
          namespace: NAMESPACE,
          prepared: fixture.prepared,
          activeHarness: "codex",
          targetHarness: "codex",
          forceShellout: false,
          resolvedModel: RESOLVED_MODELS.claude,
        },
        registry,
        fixture.deps,
      ),
    ).rejects.toThrow('resolved model harness "claude" does not match target "codex"');
    expect(launches).toBe(0);
    expect(rowState(fixture.store.read(handleOf(fixture.prepared))!)).toBe("prepared");
  });

  test("rejects a divergent process model before launching the child [BA]", async () => {
    const fixture = preparedFixture("claude", 220);
    const endpoint = createRecordedCapabilityEndpoint();
    const registry = new DispatchTransportAdapterRegistry([
      createClaudeProcessDispatchAdapter(
        createStrictInMemoryWorksetEffectAdmissionProvider(),
        claudeRecordingResolver(endpoint),
      ),
    ]);
    try {
      await expect(
        runPreparedDispatchOverService(
          {
            namespace: NAMESPACE,
            prepared: fixture.prepared,
            activeHarness: "pi",
            targetHarness: "claude",
            forceShellout: false,
            resolvedModel: {
              ...RESOLVED_MODELS.claude,
              model: "different-claude-model",
            },
          },
          registry,
          fixture.deps,
        ),
      ).rejects.toThrow("does not match resolved model");
      expect(endpoint.counts).toEqual({ input: 0, store: 0 });
      expect(rowState(fixture.store.read(handleOf(fixture.prepared))!)).toBe("prepared");
    } finally {
      endpoint.stop();
    }
  });

  test("binds the exact prepared task ref into the trusted launch context [BA]", async () => {
    const fixture = preparedFixture("codex", 61);
    const observedTargets: Array<string | undefined> = [];
    const registry = new DispatchTransportAdapterRegistry([
      createNativeDispatchAdapter("codex", async (context) => {
        observedTargets.push(context.effectTargetRef);
        await context.child.materializeInput();
        const stored = await context.child.storeResult(OUTPUT);
        if (stored.state === "aborted") {
          return { outcome: "aborted", reason: stored.result.reason };
        }
        return {
          outcome: "completed",
          handle: handleOf(context.prepared),
          nativeCompletion: fixture.expectedCompletion,
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
    expect(observedTargets).toEqual(["tasks:T1631"]);
  });

  test("derives one canonical flow target and rejects absent, ambiguous, or malformed ids [BA]", () => {
    expect(
      [
        { taskId: "T7" },
        { goalId: "G8" },
        { defectId: "D9" },
        { researchId: "RS10" },
      ].map((input) => dispatchEffectTargetRef(input)),
    ).toEqual(["tasks:T7", "goals:G8", "defects:D9", "researches:RS10"]);
    expect(
      dispatchEffectTargetRef({ defectId: "D9", hypothesisId: "H11" }),
    ).toBe("defects:D9");
    expect(() => dispatchEffectTargetRef({ hypothesisId: "H11" })).toThrow(
      /exactly one effect target id, found 0/,
    );
    expect(() => dispatchEffectTargetRef({})).toThrow(/exactly one effect target id, found 0/);
    expect(() => dispatchEffectTargetRef({ taskId: "T7", goalId: "G8" })).toThrow(
      /exactly one effect target id, found 2/,
    );
    expect(() => dispatchEffectTargetRef({ researchId: "R10" })).toThrow(
      /researchId is not a canonical researches id/,
    );
  });

  test("all native and process transports consume the fetched absolute reviewer deadlines [BG]", async () => {
    const observed: Array<{ readonly adapterId: string; readonly input: DispatchJSONValue }> = [];
    const adapters = HARNESSES.flatMap((targetHarness) =>
      (["native", "process"] as const).map((transport): DispatchTransportAdapter => ({
        id: `${targetHarness}:${transport}`,
        targetHarness,
        transport,
        launch: async (context) => {
          const input = (await context.child.materializeInput()).input;
          observed.push({ adapterId: context.route.adapterId, input });
          const stored = await context.child.storeResult(REVIEWER_OUTPUT);
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
      createNativeDispatchAdapter("codex", async (context) => {
        const materialized = await context.child.materializeInput();
        const input = materialized.input as Readonly<Record<string, DispatchJSONValue>>;
        const gateCompleteBy = input["gateCompleteBy"];
        if (typeof gateCompleteBy !== "string") throw new Error("missing gateCompleteBy");
        exhaustionStates.push(Date.parse(fixture.clock.peek()) >= Date.parse(gateCompleteBy));
        fixture.clock.advance(1);
        exhaustionStates.push(Date.parse(fixture.clock.peek()) >= Date.parse(gateCompleteBy));
        const stored = await context.child.storeResult(REVIEWER_EXHAUSTION_OUTPUT);
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

  describe("G224 settlement port", () => {
    function recordingSettlement(
      inner: DispatchSettlementPort,
      calls: string[],
    ): DispatchSettlementPort {
      return {
        readEnvelope: async (handle) => (calls.push("readEnvelope"), await inner.readEnvelope(handle)),
        materializeInput: async (handle, capability) => (
          calls.push("materializeInput"), await inner.materializeInput(handle, capability)
        ),
        storeResult: async (capability, output) => (
          calls.push("storeResult"), await inner.storeResult(capability, output)
        ),
        confirm: async (input) => (calls.push("confirm"), await inner.confirm(input)),
        abort: async (input) => (calls.push("abort"), await inner.abort(input)),
        fetch: async (handle) => (calls.push("fetch"), await inner.fetch(handle)),
      };
    }

    test("a consumed dispatch performs every transition through the port, in order [BA]", async () => {
      const fixture = preparedFixture("claude", 91);
      const calls: string[] = [];
      const registry = new DispatchTransportAdapterRegistry([
        createNativeDispatchAdapter(
          "claude",
          successfulLaunch(fixture.expectedCompletion, { input: 0, store: 0 }),
        ),
      ]);
      const result = await runPreparedDispatchBound(
        {
          prepared: fixture.prepared,
          resolvedModel: RESOLVED_MODELS.claude,
          activeHarness: "claude",
          targetHarness: "claude",
          forceShellout: false,
          materializeOutput: true,
        },
        registry,
        recordingSettlement(attestationServiceSettlement(NAMESPACE, fixture.deps), calls),
      );
      expect(result.outcome).toBe("consumed");
      expect(calls).toEqual([
        "readEnvelope",
        "materializeInput",
        "storeResult",
        "readEnvelope",
        "confirm",
        "fetch",
      ]);
    });

    test("a run that does not materialize leaves the single fetch to the parent [BA]", async () => {
      const fixture = preparedFixture("claude", 94);
      const calls: string[] = [];
      const registry = new DispatchTransportAdapterRegistry([
        createNativeDispatchAdapter(
          "claude",
          successfulLaunch(fixture.expectedCompletion, { input: 0, store: 0 }),
        ),
      ]);
      const settlement = attestationServiceSettlement(NAMESPACE, fixture.deps);
      const result = await runPreparedDispatchBound(
        {
          prepared: fixture.prepared,
          resolvedModel: RESOLVED_MODELS.claude,
          activeHarness: "claude",
          targetHarness: "claude",
          forceShellout: false,
          materializeOutput: false,
        },
        registry,
        recordingSettlement(settlement, calls),
      );
      expect(result).toMatchObject({ outcome: "consumed" });
      expect("output" in result).toBe(false);
      expect(calls).not.toContain("fetch");
      const parentFetch = await settlement.fetch(result.handle);
      expect(parentFetch).toMatchObject({ state: "consumed", output: OUTPUT });
    });

    test("an adapter abort settles through the port's abort, and nothing else [BA]", async () => {
      const fixture = preparedFixture("claude", 92);
      const calls: string[] = [];
      const registry = new DispatchTransportAdapterRegistry([
        createNativeDispatchAdapter("claude", () => ({
          outcome: "aborted",
          reason: "native-failure",
          details: { source: "g224-settlement-port" },
        })),
      ]);
      const result = await runPreparedDispatchBound(
        {
          prepared: fixture.prepared,
          resolvedModel: RESOLVED_MODELS.claude,
          activeHarness: "claude",
          targetHarness: "claude",
          forceShellout: false,
          materializeOutput: true,
        },
        registry,
        recordingSettlement(attestationServiceSettlement(NAMESPACE, fixture.deps), calls),
      );
      expect(result).toMatchObject({
        outcome: "aborted",
        abort: { state: "aborted", reason: "native-failure" },
      });
      // The second read is the settled-state check: the child left no abort of its own.
      expect(calls).toEqual(["readEnvelope", "readEnvelope", "abort"]);
    });

    for (const [label, launcherOutcome] of [
      ["an adapter abort", "aborted"],
      ["an adapter completion", "completed"],
    ] as const) {
      test(`D546: ${label} after the child's own store aborted returns that abort without a second transition`, async () => {
        const fixture = preparedFixture("claude", launcherOutcome === "aborted" ? 95 : 96);
        const calls: string[] = [];
        const registry = new DispatchTransportAdapterRegistry([
          createNativeDispatchAdapter("claude", async (context) => {
            const stored = await context.child.storeResult({ notTheRoleResult: true });
            expect(stored.state).toBe("aborted");
            return launcherOutcome === "aborted"
              ? { outcome: "aborted", reason: "native-failure", details: { source: "d546" } }
              : {
                  outcome: "completed",
                  handle: handleOf(fixture.prepared),
                  nativeCompletion: fixture.expectedCompletion,
                  handleOnlyEnforcement: "structural",
                };
          }),
        ]);
        const result = await runPreparedDispatchBound(
          {
            prepared: fixture.prepared,
            resolvedModel: RESOLVED_MODELS.claude,
            activeHarness: "claude",
            targetHarness: "claude",
            forceShellout: false,
            materializeOutput: false,
          },
          registry,
          recordingSettlement(attestationServiceSettlement(NAMESPACE, fixture.deps), calls),
        );
        expect(result).toMatchObject({ outcome: "aborted", abort: { state: "aborted", reason: "invalid-output" } });
        expect(calls).not.toContain("abort");
        expect(calls).not.toContain("confirm");
      });
    }

    test("a port that reports no live envelope refuses before any launch", async () => {
      const fixture = preparedFixture("claude", 93);
      let launched = false;
      const registry = new DispatchTransportAdapterRegistry([
        createNativeDispatchAdapter("claude", () => {
          launched = true;
          throw new Error("must not launch");
        }),
      ]);
      const inner = attestationServiceSettlement(NAMESPACE, fixture.deps);
      await expect(
        runPreparedDispatchBound(
          {
            prepared: fixture.prepared,
            resolvedModel: RESOLVED_MODELS.claude,
            activeHarness: "claude",
            targetHarness: "claude",
            forceShellout: false,
            materializeOutput: true,
          },
          registry,
          { ...inner, readEnvelope: async () => undefined },
        ),
      ).rejects.toThrow(/has no live envelope/);
      expect(launched).toBe(false);
    });
  });

  test("D431: a claude:native completion carrying trusted-extension is refused", async () => {
    // The matching positive case is covered by the full route matrix above,
    // which derives the actor from the route. This pins the REFUSAL, so an
    // adapter that regresses to the process/pi actor on a same-harness Claude
    // route fails here rather than silently aborting every dispatch.
    const fixture = preparedFixture("claude", 77);
    const counts = { input: 0, store: 0 };
    const registry = new DispatchTransportAdapterRegistry([
      createNativeDispatchAdapter(
        "claude",
        successfulLaunch({ ...fixture.expectedCompletion, actor: "trusted-extension" }, counts),
      ),
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
    expect(result).toMatchObject({
      outcome: "aborted",
      adapterId: "claude:native",
      abort: {
        state: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "completion-actor-does-not-match-transport",
          expected: "trusted-parent",
          observed: "trusted-extension",
        },
      },
    });
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
        createClaudeProcessDispatchAdapter(
          createStrictInMemoryWorksetEffectAdmissionProvider(),
          claudeRecordingResolver(endpoint),
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
          createStrictInMemoryWorksetEffectAdmissionProvider(),
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
        createPiProcessDispatchAdapter(async (context) => {
          await context.child.materializeInput();
          await context.child.storeResult(OUTPUT);
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
      createPiProcessDispatchAdapter(async (context) => {
        await context.child.materializeInput();
        const stored = await context.child.storeResult({ not: "an implement-worker result" });
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
        createPiProcessDispatchAdapter(async (context) => {
          await context.child.materializeInput();
          await context.child.storeResult(OUTPUT);
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
