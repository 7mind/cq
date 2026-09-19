import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  dispatchPayloadDigest,
  fetchDispatchInputOn,
  prepareDispatchOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  upgradeLiveImplementationQueueRows,
  type AttestationEnvelope,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
  type DispatchPrepared,
  type EnqueueImplementationCandidateRequest,
  type GatePendingResultView,
} from "@cq/config";

const namespace: AttestationNamespace = { backend: "xdg", projectKey: "queue-upgrade" };
const store = new InMemoryAttestationStore(namespace);
const backend = new InMemoryAttestationBackend(store);
let instant = Date.parse("2026-09-19T08:00:00.000Z");
const now = () => new Date(instant).toISOString();

interface StagedRow {
  readonly prepared: DispatchPrepared;
  readonly pending: GatePendingResultView;
  readonly binding: DispatchGitEffectBinding;
}

async function stage(taskId: string, seed: number): Promise<StagedRow> {
  const baseCommit = seed.toString(16).padStart(40, "0");
  const resultCommit = (seed + 1).toString(16).padStart(40, "0");
  const binding: DispatchGitEffectBinding = {
    taskId,
    handleToken: `managed-${taskId}`,
    handleFingerprint: seed.toString(16).padStart(64, "0"),
    repositoryRoot: "/repo",
    repositoryId: "a".repeat(64),
    commonDir: "/repo/.git",
    worktreePath: `/repo/.claude/worktrees/${taskId}`,
    branch: `implement/${taskId}`,
    ref: `refs/heads/implement/${taskId}`,
    baseCommit,
  };
  const input: DispatchJSONValue = {
    taskId,
    headline: `Upgrade ${taskId}`,
    description: "Legacy gate-pending queue row.",
    acceptance: "Adopt without inventing completion evidence.",
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    baseCommit,
    round: 0,
    startingCommit: baseCommit,
  };
  const prepared = await prepareDispatchOn(
    backend,
    {
      namespace,
      roleId: "implement-worker",
      surface: "codex",
      input,
      idempotencyKey: `upgrade-${taskId}`,
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "b".repeat(64),
      catalogHash: "c".repeat(64),
      expectedChild: { childId: `child-${taskId}`, runId: `run-${taskId}` },
      gitEffectBinding: binding,
    },
    {
      mode: "manager-bound",
      now,
      randomBytes: sequentialDispatchRandomBytes(seed),
      lineageFenceGuard: async () => null,
      withLineageLock: async (operation) => await operation(),
    },
  );
  if (!prepared.accepted) throw new Error(prepared.detail);
  await fetchDispatchInputOn(
    backend,
    {
      namespace,
      ...prepared.prepared,
      inputCapability: prepared.prepared.inputCapability,
    },
    { now },
  );
  const stored = await storeDispatchResultOn(
    backend,
    {
      resultCapability: prepared.prepared.resultCapability,
      output: {
        taskId,
        status: "pass",
        resultCommit,
        branch: binding.branch,
        actualWorktreePath: binding.worktreePath,
        filesTouched: [],
        gitReceipts: [],
        checkSummary: "focused checks passed",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit,
          headCommit: resultCommit,
        },
        summary: "legacy staged candidate",
      },
    },
    { now },
  );
  if (stored.state !== "gate-pending") throw new Error(`expected gate-pending, got ${stored.state}`);
  return { prepared: prepared.prepared, pending: stored.result, binding };
}

function replaceRow(taskId: string, change: (row: AttestationEnvelope) => AttestationEnvelope): void {
  const row = store
    .rows()
    .find(
      (candidate): candidate is AttestationEnvelope =>
        candidate.kind === "envelope" && candidate.gitEffectBinding?.taskId === taskId,
    );
  if (row === undefined) throw new Error(`missing ${taskId}`);
  store.replace(row, Object.freeze(change(row)));
}

describe("live attestation queue rollout [Behavioral-Active Blackbox-Group]", () => {
  test("orders adoption, protects worktrees, and never invents qualification", async () => {
    const unqualified = await stage("T65211", 101);
    instant += 1_000;
    const uncertain = await stage("T65212", 102);
    replaceRow("T65212", (row) => ({
      ...row,
      state: "gate-running",
      gateClaimedAt: now(),
      gateEpoch: 1,
    }));
    instant += 1_000;
    const qualified = await stage("T65213", 103);
    instant += 1_000;
    await stage("T65214", 104);

    const protectedTasks: string[] = [];
    const summary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      protectManagedWorktree: async (binding) => {
        protectedTasks.push(binding.taskId);
      },
      resolve: async (row) => {
        const taskId = row.gitEffectBinding!.taskId;
        if (taskId === "T65214") {
          return { state: "incompatible" as const, detail: { reason: "legacy-output-shape" } };
        }
        const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
        const candidate: Omit<
          EnqueueImplementationCandidateRequest,
          "namespace" | "actor" | "attestationId" | "generation" | "rollout"
        > = {
          repositoryId: row.gitEffectBinding!.repositoryId,
          integrationRef: "refs/heads/main",
          authority: {
            taskId,
            goalRef: "goals:G213",
            finalizedManifestDigest: "d".repeat(64),
          },
          observedBaseCommit: row.gitEffectBinding!.baseCommit,
          resultCommit: output["resultCommit"] as string,
          resultTree: "e".repeat(40),
          gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          packagedEnvironmentDigest: "f".repeat(64),
          gitReceipts: [],
          gitEffectBinding: row.gitEffectBinding!,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
        };
        return taskId !== "T65213"
          ? { state: "compatible" as const, candidate }
          : {
              state: "compatible" as const,
              candidate,
              completion: {
                stagedOutputDigest: qualified.pending.outputDigest,
                expectedChild: row.expectedChild,
                expectedProvenance: provenanceBindingOf(qualified.prepared),
                nativeCompletion: {
                  kind: "native-completion" as const,
                  actor: "trusted-parent" as const,
                  childId: row.expectedChild.childId,
                  runId: row.expectedChild.runId,
                  completedAt: now(),
                },
              },
            };
      },
    });

    expect(summary).toMatchObject({
      contract: "g213-t4",
      version: 1,
      considered: 4,
      adoptedUnqualified: 1,
      adoptedQualified: 1,
      adoptedCompletedGreen: 0,
      parkedIncompatible: 1,
      executionUncertain: 1,
    });
    expect(summary.orderedHandles).toEqual([
      `${unqualified.prepared.attestationId}#1`,
      `${uncertain.prepared.attestationId}#1`,
      `${qualified.prepared.attestationId}#1`,
      `${store.rows().find((row) => row.kind === "envelope" && row.gitEffectBinding?.taskId === "T65214")!.attestationId}#1`,
    ]);
    expect(protectedTasks).toEqual(["T65211", "T65212", "T65213", "T65214"]);

    const byTask = new Map(
      store.rows().flatMap((row) =>
        row.kind === "envelope" && row.gitEffectBinding !== undefined
          ? [[row.gitEffectBinding.taskId, row] as const]
          : [],
      ),
    );
    expect(byTask.get("T65211")?.implementationQueue?.state).toBe("enqueued");
    expect(byTask.get("T65211")?.stagedCompletionQualification).toBeUndefined();
    expect(byTask.get("T65213")?.implementationQueue?.state).toBe("qualified");
    expect(byTask.get("T65213")?.implementationQueueRollout?.disposition).toBe(
      "adopted-qualified",
    );
    expect(byTask.get("T65212")?.implementationQueue).toBeUndefined();
    expect(byTask.get("T65212")?.implementationQueueRollout?.disposition).toBe(
      "execution-uncertain",
    );
    expect(byTask.get("T65214")?.implementationQueueRollout?.disposition).toBe(
      "parked-incompatible",
    );
  });

  test("accepts completed green evidence only when every durable binding is exact", async () => {
    instant += 1_000;
    await stage("T65215", 105);
    const supervisedGateEvidence = {
      kind: "cq-supervised-gate-evidence",
      version: 1,
      command: "bun run check",
      exitCode: 0,
      completedAt: now(),
    } as const;
    replaceRow("T65215", (row) => {
      const output = {
        ...(row.output as Readonly<Record<string, DispatchJSONValue>>),
        supervisedGateEvidence,
      } as DispatchJSONValue;
      return {
        ...row,
        state: "result-stored",
        output,
        outputDigest: dispatchPayloadDigest(output),
        storedAt: now(),
      };
    });
    const completed = store.rows().find(
      (row): row is AttestationEnvelope =>
        row.kind === "envelope" && row.gitEffectBinding?.taskId === "T65215",
    )!;

    const summary = await upgradeLiveImplementationQueueRows({
      backend,
      now,
      protectManagedWorktree: async () => undefined,
      resolve: async (row) => ({
        state: "completed-green",
        evidence: {
          outputDigest: row.outputDigest!,
          resultCommit: (row.output as Readonly<Record<string, DispatchJSONValue>>)[
            "resultCommit"
          ] as string,
          managedWorktreeBindingDigest: dispatchPayloadDigest(
            row.gitEffectBinding as unknown as DispatchJSONValue,
          ),
          supervisedGateEvidenceDigest: dispatchPayloadDigest(
            supervisedGateEvidence as unknown as DispatchJSONValue,
          ),
        },
      }),
    });
    expect(summary.adoptedCompletedGreen).toBe(1);
    const migrated = store.read(completed)! as AttestationEnvelope;
    expect(migrated.implementationQueue).toBeUndefined();
    expect(migrated.implementationQueueRollout?.disposition).toBe("adopted-completed-green");
  });
});
