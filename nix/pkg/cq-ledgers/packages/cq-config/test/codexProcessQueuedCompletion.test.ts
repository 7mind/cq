import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationStore,
  DispatchTransportAdapterRegistry,
  acquireImplementationCandidate,
  claimQualifiedParentGate,
  codexExpectedChild,
  completeQualifiedParentGate,
  confirmDispatchCompletion,
  createCodexProcessDispatchAdapter,
  enqueueImplementationCandidate,
  fetchDispatchResult,
  prepareDispatch,
  provenanceBindingOf,
  qualifyDispatchStagedCompletion,
  runPreparedDispatch,
  sequentialDispatchRandomBytes,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type NativeCompletionProof,
} from "../src/index.js";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "queued-completion" };
const clock = new FakeDispatchClock("2026-09-16T09:00:00.000Z");
const baseCommit = "1".repeat(40);
const resultCommit = "2".repeat(40);
const expectedChild = { childId: "codex-process-child", runId: "codex-process-run" } as const;
const binding: DispatchGitEffectBinding = {
  taskId: "T6519",
  handleToken: "managed-handle-T6519",
  handleFingerprint: "3".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "4".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/T6519",
  branch: "implement/T6519",
  ref: "refs/heads/implement/T6519",
  baseCommit,
};

const output: DispatchJSONValue = {
  taskId: "T6519",
  status: "pass",
  resultCommit,
  branch: binding.branch,
  actualWorktreePath: binding.worktreePath,
  filesTouched: ["candidate.ts"],
  gitReceipts: [],
  checkSummary: "focused checks passed",
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit,
    headCommit: resultCommit,
  },
  summary: "candidate staged",
};

describe("Codex process queued completion [Behavioral-Active, Blackbox-Group]", () => {
  // specified: T6519 — staging plus native completion qualifies, but does not run the gate.
  test("returns a handle-only queued outcome after durable exact qualification", async () => {
    const store = new InMemoryAttestationStore(namespace);
    const deps = { store, now: clock.now };
    const preparedOutcome = prepareDispatch(
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue native completion",
          description: "Qualify the staged bytes before coordinator admission.",
          acceptance: "No gate starts in the child transport.",
          worktreePath: binding.worktreePath,
          branch: binding.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
          validationIntent: "final",
        },
        idempotencyKey: "T6519-process-queued",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "5".repeat(64),
        catalogHash: "6".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
      },
      { store, now: clock.now, randomBytes: sequentialDispatchRandomBytes(6519) },
    );
    if (!preparedOutcome.accepted) throw new Error(preparedOutcome.detail);
    const prepared = preparedOutcome.prepared;
    const nativeCompletion: NativeCompletionProof = {
      kind: "native-completion",
      actor: "trusted-extension",
      childId: expectedChild.childId,
      runId: expectedChild.runId,
      completedAt: clock.now(),
    };
    const registry = new DispatchTransportAdapterRegistry([
      {
        id: "codex:process",
        targetHarness: "codex",
        transport: "process",
        launch: (context) => {
        context.child.materializeInput();
        const staged = context.child.storeResult(output);
        expect(staged.state).toBe("gate-pending");
        return {
          outcome: "completed",
          handle: { attestationId: prepared.attestationId, generation: prepared.generation },
          nativeCompletion,
          handleOnlyEnforcement: "structural",
        };
        },
      },
    ]);
    const request = {
      namespace,
      prepared,
      activeHarness: "claude",
      targetHarness: "codex",
      forceShellout: false,
      resolvedModel: { harness: "codex", model: "gpt-5.6-sol", provider: null, effort: "high" },
      qualifyStagedCompletion: async (observation: {
        readonly stagedOutputDigest: string;
        readonly nativeCompletion: NativeCompletionProof;
      }) => {
        const queue = enqueueImplementationCandidate(
          {
            namespace,
            actor: "trusted-extension",
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            repositoryId: binding.repositoryId,
            integrationRef: "refs/heads/main",
            authority: {
              taskId: binding.taskId,
              goalRef: "goals:G211",
              finalizedManifestDigest: "7".repeat(64),
            },
            observedBaseCommit: baseCommit,
            resultCommit,
            resultTree: "8".repeat(40),
            gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            packagedEnvironmentDigest: "9".repeat(64),
            gitReceipts: [],
            gitEffectBinding: binding,
            stagedOutputDigest: observation.stagedOutputDigest,
          },
          deps,
        );
        return qualifyDispatchStagedCompletion(
          {
            namespace,
            actor: "trusted-extension",
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            partitionKey: queue.partition.partitionKey,
            enrollmentId: queue.enrollment.enrollmentId,
            attemptId: queue.attempt.attemptId,
            stagedOutputDigest: observation.stagedOutputDigest,
            expectedChild,
            expectedProvenance: provenanceBindingOf(prepared),
            nativeCompletion: observation.nativeCompletion,
          },
          deps,
        );
      },
    } as unknown as Parameters<typeof runPreparedDispatch>[0];

    const result = await runPreparedDispatch(request, registry, deps);

    expect(result).toEqual({
      outcome: "queued",
      route: {
        activeHarness: "claude",
        targetHarness: "codex",
        forceShellout: false,
        transport: "process",
        adapterId: "codex:process",
      },
      adapterId: "codex:process",
      handle: { attestationId: prepared.attestationId, generation: prepared.generation },
    });
    const row = store.read({
      attestationId: prepared.attestationId,
      generation: prepared.generation,
    }) as AttestationEnvelope;
    expect(row.state).toBe("gate-pending");
    expect(row.implementationQueue?.state).toBe("qualified");
    expect(row.stagedCompletionQualification?.nativeCompletion).toEqual(nativeCompletion);
  });

  test("real completed process with a nonzero exit terminalizes before qualification", async () => {
    const root = mkdtempSync(join(tmpdir(), "cq-library-nonzero-process-"));
    const initialized = Bun.spawnSync([
      process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
      "init",
      "--quiet",
      root,
    ]);
    if (initialized.exitCode !== 0) throw new Error("nonzero process fixture git init failed");
    const executable = join(root, "codex-nonzero");
    const roleInstructions = "T6519 reject a nonzero process completion";
    const promptDigest = new Bun.CryptoHasher("sha256")
      .update(roleInstructions)
      .digest("hex");
    const correlation = {
      agentType: "implement-worker",
      correlationId: "T6519LibraryNonzeroCorrelation012345",
      threadId: "t6519-parent-nonzero-run",
    } as const;
    const processNamespace: AttestationNamespace = {
      backend: "xdg",
      projectKey: "queued-library-nonzero",
    };
    const processStore = new InMemoryAttestationStore(processNamespace);
    const processClock = new FakeDispatchClock("2026-09-16T10:00:00.000Z");
    const processDeps = { store: processStore, now: processClock.now };
    const preparedOutcome = prepareDispatch(
      {
        namespace: processNamespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Reject a nonzero completion",
          description: "A completed transport with a failed process is not runnable.",
          acceptance: "The row terminalizes before qualification or gate admission.",
          worktreePath: binding.worktreePath,
          branch: binding.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
          validationIntent: "final",
        },
        idempotencyKey: "T6519-library-process-nonzero",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest,
        catalogHash: "6".repeat(64),
        expectedChild: codexExpectedChild(correlation),
        gitEffectBinding: binding,
      },
      {
        store: processStore,
        now: processClock.now,
        randomBytes: sequentialDispatchRandomBytes(6521),
      },
    );
    if (!preparedOutcome.accepted) throw new Error(preparedOutcome.detail);
    const prepared = preparedOutcome.prepared;
    let stagedAcknowledgement: unknown;
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
await Bun.stdin.text();
const stored = ${JSON.stringify({ state: "gate-pending", result: { state: "gate-pending", attestationId: prepared.attestationId, generation: prepared.generation, submittedAt: processClock.now(), outputDigest: "a".repeat(64) } })};
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "generated-library-nonzero-thread" }),
  JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result", result: { content: [{ type: "text", text: JSON.stringify(stored) }] } } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(stored) } }),
  JSON.stringify({ type: "turn.completed", usage: {} }),
].join("\\n"), () => process.exit(17));
`,
    );
    chmodSync(executable, 0o755);
    try {
      const registry = new DispatchTransportAdapterRegistry([
        createCodexProcessDispatchAdapter(
          createStrictInMemoryWorksetEffectAdmissionProvider(),
          (context) => {
            context.child.materializeInput();
            stagedAcknowledgement = context.child.storeResult(output);
            return {
              correlation,
              now: processClock.now,
              boundary: {
                roleInstructions,
                cwd: root,
                ledgerCwd: root,
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                sandboxMode: "danger-full-access",
                promptRoot: root,
                ledgerCommand: "cq-not-used-by-recording",
                codexExecutable: executable,
              },
            };
          },
        ),
      ]);
      const result = await runPreparedDispatch(
        {
          namespace: processNamespace,
          prepared,
          activeHarness: "claude",
          targetHarness: "codex",
          forceShellout: false,
          resolvedModel: {
            harness: "codex",
            model: "gpt-5.6-sol",
            provider: null,
            effort: "high",
          },
          qualifyStagedCompletion: async () => {
            throw new Error("nonzero process completion must not qualify");
          },
        },
        registry,
        processDeps,
      );

      expect(stagedAcknowledgement).toMatchObject({ state: "gate-pending" });
      expect(result).toMatchObject({
        outcome: "aborted",
        abort: { reason: "native-failure" },
      });
      const terminal = processStore.read(prepared) as AttestationEnvelope;
      expect(terminal).toMatchObject({
        state: "aborted",
        abortReason: "native-failure",
      });
      expect(terminal.implementationQueue).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // specified: T6519 — the production adapter process returns before the later trusted gate.
  test(
    "real library adapter process returns queued, then a qualified lease gates, confirms, and fetches",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cq-library-queued-process-"));
      const initialized = Bun.spawnSync([
        process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
        "init",
        "--quiet",
        root,
      ]);
      if (initialized.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(initialized.stderr));
      }
      const executable = join(root, "codex-queued");
      const roleInstructions = "T6519 library process queued completion";
      const promptDigest = new Bun.CryptoHasher("sha256")
        .update(roleInstructions)
        .digest("hex");
      const correlation = {
        agentType: "implement-worker",
        correlationId: "T6519LibraryQueuedCorrelation012345",
        threadId: "t6519-parent-controlled-run",
      } as const;
      const processChild = codexExpectedChild(correlation);
      const processNamespace: AttestationNamespace = {
        backend: "xdg",
        projectKey: "queued-library-process",
      };
      const processStore = new InMemoryAttestationStore(processNamespace);
      const processClock = new FakeDispatchClock("2026-09-16T10:00:00.000Z");
      const processDeps = { store: processStore, now: processClock.now };
      const preparedOutcome = prepareDispatch(
        {
          namespace: processNamespace,
          roleId: "implement-worker",
          surface: "codex",
          input: {
            taskId: "T6519",
            headline: "Queue a real process completion",
            description: "Return before the parent gate is admitted.",
            acceptance: "A later qualified lease owns gate, confirm, and fetch.",
            worktreePath: binding.worktreePath,
            branch: binding.branch,
            baseCommit,
            round: 0,
            startingCommit: baseCommit,
            validationIntent: "final",
          },
          idempotencyKey: "T6519-library-process-queued",
          timeoutMs: 600_000,
          registry: DISPATCH_OVERLAY_REGISTRY,
          promptDigest,
          catalogHash: "6".repeat(64),
          expectedChild: processChild,
          gitEffectBinding: binding,
        },
        {
          store: processStore,
          now: processClock.now,
          randomBytes: sequentialDispatchRandomBytes(6520),
        },
      );
      if (!preparedOutcome.accepted) throw new Error(preparedOutcome.detail);
      const prepared = preparedOutcome.prepared;
      let launchContext:
        | Parameters<Parameters<typeof createCodexProcessDispatchAdapter>[1]>[0]
        | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (launchContext === undefined) return new Response("unbound", { status: 409 });
          const body = (await request.json()) as Readonly<Record<string, unknown>>;
          const url = new URL(request.url);
          if (url.pathname === "/fetch") {
            expect(body).toEqual({
              attestationId: prepared.attestationId,
              generation: prepared.generation,
              inputCapability: prepared.inputCapability,
            });
            return Response.json(launchContext.child.materializeInput());
          }
          if (url.pathname === "/store") {
            expect(body).toEqual({ resultCapability: prepared.resultCapability, output });
            return Response.json(launchContext.child.storeResult(output));
          }
          return new Response("unknown", { status: 404 });
        },
      });
      writeFileSync(
        executable,
        `#!/usr/bin/env bun
const launch = JSON.parse(await Bun.stdin.text());
const endpoint = ${JSON.stringify(`http://127.0.0.1:${String(server.port)}`)};
const input = await fetch(endpoint + "/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attestationId: launch.attestationId, generation: launch.generation, inputCapability: launch.inputCapability }) });
if (!input.ok) throw new Error("fetch failed");
await input.json();
const storedResponse = await fetch(endpoint + "/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resultCapability: launch.resultCapability, output: ${JSON.stringify(output)} }) });
const stored = await storedResponse.json();
if (!storedResponse.ok || stored.state !== "gate-pending") throw new Error("store failed");
const handle = { attestationId: launch.attestationId, generation: launch.generation };
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "t6519-library-child-thread" }),
  JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result", result: { content: [{ type: "text", text: JSON.stringify(stored) }] } } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(stored) } }),
  JSON.stringify({ type: "turn.completed", usage: {} }),
].join("\\n"));
`,
      );
      chmodSync(executable, 0o755);
      try {
        const registry = new DispatchTransportAdapterRegistry([
          createCodexProcessDispatchAdapter(
            createStrictInMemoryWorksetEffectAdmissionProvider(),
            (context) => {
              launchContext = context;
              return {
                correlation,
                now: processClock.now,
                boundary: {
                  roleInstructions,
                  cwd: root,
                  ledgerCwd: root,
                  model: "gpt-5.6-sol",
                  reasoningEffort: "high",
                  sandboxMode: "danger-full-access",
                  promptRoot: root,
                  ledgerCommand: "cq-not-used-by-recording",
                  codexExecutable: executable,
                },
              };
            },
          ),
        ]);
        const result = await runPreparedDispatch(
          {
            namespace: processNamespace,
            prepared,
            activeHarness: "claude",
            targetHarness: "codex",
            forceShellout: false,
            resolvedModel: {
              harness: "codex",
              model: "gpt-5.6-sol",
              provider: null,
              effort: "high",
            },
            qualifyStagedCompletion: async (observation) => {
              const queue = enqueueImplementationCandidate(
                {
                  namespace: processNamespace,
                  actor: "trusted-extension",
                  attestationId: prepared.attestationId,
                  generation: prepared.generation,
                  repositoryId: binding.repositoryId,
                  integrationRef: "refs/heads/main",
                  authority: {
                    taskId: binding.taskId,
                    goalRef: "goals:G211",
                    finalizedManifestDigest: "7".repeat(64),
                  },
                  observedBaseCommit: baseCommit,
                  resultCommit,
                  resultTree: "8".repeat(40),
                  gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
                  packagedEnvironmentDigest: "9".repeat(64),
                  gitReceipts: [],
                  gitEffectBinding: binding,
                  stagedOutputDigest: observation.stagedOutputDigest,
                },
                processDeps,
              );
              return qualifyDispatchStagedCompletion(
                {
                  namespace: processNamespace,
                  actor: "trusted-extension",
                  attestationId: prepared.attestationId,
                  generation: prepared.generation,
                  partitionKey: queue.partition.partitionKey,
                  enrollmentId: queue.enrollment.enrollmentId,
                  attemptId: queue.attempt.attemptId,
                  stagedOutputDigest: observation.stagedOutputDigest,
                  expectedChild: processChild,
                  expectedProvenance: provenanceBindingOf(prepared),
                  nativeCompletion: observation.nativeCompletion,
                },
                processDeps,
              );
            },
          },
          registry,
          processDeps,
        );
        expect(result).toMatchObject({
          outcome: "queued",
          handle: {
            attestationId: prepared.attestationId,
            generation: prepared.generation,
          },
        });
        const qualifiedRow = processStore.read(prepared) as AttestationEnvelope;
        expect(qualifiedRow).toMatchObject({
          state: "gate-pending",
          implementationQueue: { state: "qualified", leaseGeneration: 0 },
        });
        const acquired = acquireImplementationCandidate(
          {
            namespace: processNamespace,
            actor: "trusted-extension",
            partitionKey: qualifiedRow.implementationQueue!.partition.partitionKey,
            holderId: "later-library-coordinator",
          },
          processDeps,
        );
        if (acquired.state !== "leased") throw new Error("qualified process front did not lease");
        const claimed = claimQualifiedParentGate(
          { ...prepared, queueLease: acquired.lease },
          processDeps,
        );
        if (claimed.state !== "gate-running") throw new Error("later gate did not claim");
        const finalOutput = {
          ...(output as Readonly<Record<string, DispatchJSONValue>>),
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            version: 1,
            attestationId: prepared.attestationId,
            generation: prepared.generation,
            roleId: "implement-worker",
            roleVersion: prepared.promptProvenance.version,
            surface: "codex",
            promptDigest: prepared.promptProvenance.promptDigest,
            catalogHash: prepared.promptProvenance.catalogHash,
            inputDigest: prepared.promptProvenance.inputDigest,
            taskId: "T6519",
            worktreePath: binding.worktreePath,
            branch: binding.branch,
            baseCommit,
            startingCommit: baseCommit,
            resultCommit,
            clean: true,
            command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 1,
            capturedAt: processClock.now(),
            filesTouchedDigest: "a".repeat(64),
            gitReceiptsDigest: "b".repeat(64),
            mutationTableDigest: "c".repeat(64),
          },
        } as DispatchJSONValue;
        completeQualifiedParentGate(
          {
            ...prepared,
            queueLease: acquired.lease,
            gateEpoch: claimed.gateEpoch,
            output: finalOutput,
          },
          processDeps,
        );
        const nativeCompletion = qualifiedRow.stagedCompletionQualification?.nativeCompletion;
        if (nativeCompletion === undefined) throw new Error("native completion was not durable");
        const confirmed = confirmDispatchCompletion(
          {
            namespace: processNamespace,
            ...prepared,
            nativeCompletion,
            expectedProvenance: provenanceBindingOf(prepared),
            continuationContext: { liveTip: baseCommit, gitReceipts: [] },
          },
          processDeps,
        );
        expect(confirmed).toMatchObject({
          state: "consumed",
          result: {
            state: "consumed",
            attestationId: prepared.attestationId,
            generation: prepared.generation,
          },
        });
        if (confirmed.state !== "consumed") throw new Error("later confirmation did not consume");
        expect(Object.hasOwn(confirmed.result, "output")).toBe(false);
        expect(
          fetchDispatchResult(
            {
              namespace: processNamespace,
              actor: "trusted-parent",
              ...prepared,
            },
            processDeps,
          ),
        ).toMatchObject({ state: "consumed", output: finalOutput });
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
