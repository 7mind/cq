import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  SqliteAttestationBackend,
  prepareDispatchOn,
  fetchDispatchInputOn,
  storeDispatchResultOn,
  enqueueImplementationCandidateOn,
  qualifyDispatchStagedCompletionOn,
  provenanceBindingOf,
  sequentialDispatchRandomBytes,
  dispatchPayloadDigest,
  type AttestationBackend,
  type DispatchJSONValue,
  type DispatchCohortGitEffectBinding,
  type EnqueueImplementationCandidateRequest,
  type AttestationNamespace,
  type DispatchPrepared,
  type DispatchGitChangeReceipt,
  type ImplementationQueueControl,
  type AttestationEnvelope,
  type CohortEffectEnvelopeV1,
} from "@cq/config";
import { cohortRoleEnvelope, cohortRoleMembers } from "./workCohortRoleFixture.js";

interface CohortQueueFixture {
  readonly namespace: AttestationNamespace;
  readonly backend: AttestationBackend;
  readonly now: () => string;
  readonly cohort: CohortEffectEnvelopeV1;
  readonly binding: DispatchCohortGitEffectBinding;
  readonly prepared: DispatchPrepared;
  readonly receipts: readonly DispatchGitChangeReceipt[];
  readonly request: EnqueueImplementationCandidateRequest;
  readonly output: Readonly<Record<string, DispatchJSONValue>>;
  readonly outputDigest: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly enroll: () => Promise<ImplementationQueueControl>;
  readonly qualify: () => Promise<AttestationEnvelope>;
  readonly close: () => Promise<void>;
}

export async function cohortQueueFixture(kind: "memory" | "sqlite"): Promise<CohortQueueFixture> {
  const root = await mkdtemp(join(tmpdir(), "cq-cohort-queue-"));
  const namespace = { backend: "xdg" as const, projectKey: "cohort-queue-contract" };
  const backend: AttestationBackend =
    kind === "memory"
      ? new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace))
      : new SqliteAttestationBackend({ namespace, dbPath: join(root, "attestation.db") });
  const now = () => "2026-09-22T09:00:00.000Z";
  const cohort = cohortRoleEnvelope();
  const branch = `implement/cohort-${cohort.intent.intentDigest}`;
  const baseCommit = "1".repeat(40);
  const resultCommit = "3".repeat(40);
  const resultTree = "4".repeat(40);
  const binding: DispatchCohortGitEffectBinding = {
    cohort,
    branch,
    handleToken: "cohort-handle",
    handleFingerprint: "5".repeat(64),
    repositoryRoot: "/repo",
    repositoryId: cohort.definition.repository.repositoryId,
    commonDir: "/repo/.git",
    worktreePath: "/repo/cohort",
    ref: `refs/heads/${branch}`,
    baseCommit,
  };
  const input = {
    cohort,
    members: cohortRoleMembers(cohort),
    branch,
    baseCommit,
    startingCommit: baseCommit,
    worktreePath: binding.worktreePath,
    round: 0,
    validationIntent: "final",
  };
  const expectedChild = { childId: "cohort-child", runId: "cohort-run" };
  const outcome = await prepareDispatchOn(
    backend,
    {
      namespace,
      roleId: "implement-worker",
      surface: "codex",
      input: input as unknown as DispatchJSONValue,
      idempotencyKey: "cohort-queue-contract",
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "6".repeat(64),
      catalogHash: "7".repeat(64),
      expectedChild,
      gitEffectBinding: binding,
    },
    {
      mode: "manager-bound",
      now,
      randomBytes: sequentialDispatchRandomBytes(712),
      lineageFenceGuard: async () => null,
      withLineageLock: async (run) => run(),
    },
  );
  if (!outcome.accepted) throw new Error(`cohort preparation rejected: ${outcome.detail}`);
  const prepared = outcome.prepared;
  await fetchDispatchInputOn(
    backend,
    { namespace, ...prepared, inputCapability: prepared.inputCapability },
    { now },
  );
  const receipts = [
    {
      kind: "cq-git-change-receipt" as const,
      version: 2 as const,
      cohort,
      attestationId: prepared.attestationId,
      generation: prepared.generation,
      operationId: "candidate",
      requestDigest: "8".repeat(64),
      oldHead: baseCommit,
      newHead: resultCommit,
      tree: resultTree,
      objectOids: [resultTree],
      paths: ["src/shared.ts"],
      committedAt: now(),
    },
  ];
  const output = {
    cohort,
    memberObservations: cohort.definition.members.map((member) => ({
      memberRef: member.memberRef,
      observation: "Member correction implemented",
    })),
    status: "pass",
    resultCommit,
    branch,
    actualWorktreePath: binding.worktreePath,
    filesTouched: ["src/shared.ts"],
    gitReceipts: receipts,
    checkSummary: "focused checks passed",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit,
      headCommit: resultCommit,
    },
    summary: "one shared correction",
    mutationTable: [],
  };
  const staged = await storeDispatchResultOn(
    backend,
    { resultCapability: prepared.resultCapability, output: output as unknown as DispatchJSONValue },
    { now },
  );
  if (staged.state !== "gate-pending") throw new Error(`cohort staging returned ${staged.state}`);
  const request: EnqueueImplementationCandidateRequest = {
    namespace,
    actor: "trusted-parent",
    ...prepared,
    repositoryId: binding.repositoryId,
    integrationRef: "refs/heads/main",
    authority: { cohort },
    observedBaseCommit: baseCommit,
    resultCommit,
    resultTree,
    gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
    packagedEnvironmentDigest: "9".repeat(64),
    gitReceipts: receipts,
    gitEffectBinding: binding,
    stagedOutputDigest: staged.result.outputDigest,
  };
  const enroll = () => enqueueImplementationCandidateOn(backend, request, { now });
  const qualify = async () => {
    const queue = await enroll();
    const qualified = await qualifyDispatchStagedCompletionOn(
      backend,
      {
        namespace,
        actor: "trusted-parent",
        ...prepared,
        partitionKey: queue.partition.partitionKey,
        enrollmentId: queue.enrollment.enrollmentId,
        attemptId: queue.attempt.attemptId,
        stagedOutputDigest: staged.result.outputDigest,
        expectedChild,
        expectedProvenance: provenanceBindingOf(prepared),
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...expectedChild,
          completedAt: now(),
        },
      },
      { now },
    );
    if (qualified.state !== "qualified")
      throw new Error("cohort completion qualification rejected");
    return backend.transact({ kind: "namespace" }, (store) => {
      const row = store.read(prepared);
      if (row === undefined || row.kind !== "envelope" || row.implementationQueue === undefined)
        throw new Error("qualified cohort row missing");
      return structuredClone(row);
    });
  };
  const outputJson = output as unknown as Readonly<Record<string, DispatchJSONValue>>;
  return {
    namespace,
    backend,
    now,
    cohort,
    binding,
    prepared,
    receipts,
    request,
    output: outputJson,
    baseCommit,
    resultCommit,
    resultTree,
    enroll,
    qualify,
    outputDigest: dispatchPayloadDigest(outputJson),
    close: async () => {
      await backend.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
