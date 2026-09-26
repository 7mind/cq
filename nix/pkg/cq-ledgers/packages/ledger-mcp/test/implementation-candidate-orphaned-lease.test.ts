import { afterEach, describe, expect, test } from "bun:test";
import {
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  claimParentGateOn,
  completeParentGateOn,
  confirmDispatchCompletionOn,
  type AttestationNamespace,
  type DispatchJSONValue,
} from "@cq/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryImplementationEvidenceStore, type LedgerStore } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";
import {
  ImplementationCandidateCoordinator,
  type ImplementationCandidateCoordinatorOperations,
} from "../src/implementationCandidateQueue.js";
import {
  ImplementationCandidateQueueFixture,
  type PreparedQueueCandidate,
  type PrepareQueueCandidateOptions,
} from "./implementationCandidateQueueFixture.js";

const namespace: AttestationNamespace = {
  backend: "xdg",
  projectKey: "ledger-mcp-orphaned-queue-lease",
};

const defaults = {
  repositoryId: "d".repeat(64),
  integrationRef: "refs/heads/main",
  goalRef: "goals:G6518",
  finalizedManifestDigest: "f".repeat(64),
} as const;

function candidate(taskId: string): PrepareQueueCandidateOptions {
  return { ...defaults, taskId };
}

/** Lease, gate, and confirm one candidate so its dispatch is consumed while its lease stays live. */
async function consumeWithLiveLease(
  subject: ImplementationCandidateQueueFixture,
  staged: PreparedQueueCandidate,
): Promise<void> {
  const qualified = await subject.adapter.qualifyNativeCompletion({
    candidate: staged.candidate,
    ...staged.qualification,
  });
  const lease = await subject.adapter.acquire({
    partitionKey: qualified.queue.partition.partitionKey,
    holderId: "installed-parent",
  });
  if (lease.state !== "leased") throw new Error("expected the first candidate lease");
  const capability = staged.prepared.parentGateCapability;
  if (capability === undefined) throw new Error("managed worker omitted parent gate capability");
  const handle = {
    attestationId: staged.prepared.attestationId,
    generation: staged.prepared.generation,
  };
  const claimed = await claimParentGateOn(
    subject.backend,
    { ...handle, parentGateCapability: capability, queueLease: lease.lease },
    { now: subject.clock.now },
  );
  if (claimed.state !== "gate-running") throw new Error("expected claimed parent gate");
  await completeParentGateOn(
    subject.backend,
    {
      ...handle,
      parentGateCapability: capability,
      queueLease: lease.lease,
      gateEpoch: claimed.gateEpoch,
      output: {
        ...(claimed.output as Readonly<Record<string, DispatchJSONValue>>),
        supervisedGateEvidence: {
          kind: "cq-supervised-gate-evidence",
          version: 1,
          ...handle,
          roleId: "implement-worker",
          roleVersion: staged.prepared.promptProvenance.version,
          surface: "codex",
          promptDigest: staged.prepared.promptProvenance.promptDigest,
          catalogHash: staged.prepared.promptProvenance.catalogHash,
          inputDigest: staged.prepared.promptProvenance.inputDigest,
          taskId: staged.binding.taskId,
          worktreePath: staged.binding.worktreePath,
          branch: staged.binding.branch,
          baseCommit: staged.binding.baseCommit,
          startingCommit: staged.binding.baseCommit,
          resultCommit: staged.candidate.resultCommit,
          clean: true,
          command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
          gateDurationMs: 1,
          capturedAt: subject.clock.now(),
          filesTouchedDigest: "1".repeat(64),
          gitReceiptsDigest: "2".repeat(64),
          mutationTableDigest: "3".repeat(64),
        },
      },
    },
    { now: subject.clock.now },
  );
  await confirmDispatchCompletionOn(
    subject.backend,
    {
      namespace,
      ...handle,
      nativeCompletion: staged.qualification.nativeCompletion,
      expectedProvenance: staged.qualification.expectedProvenance,
      continuationContext: { liveTip: staged.binding.baseCommit, gitReceipts: [] },
    },
    { now: subject.clock.now },
  );
}

function promptArtifacts(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 8,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

/** A tasks ledger whose only knowledge is each task's status; `archived` tasks live behind a pointer. */
function taskStatusLedger(
  active: Record<string, string>,
  archived: Record<string, string>,
): LedgerStore {
  const item = (id: string, status: string) => ({ id, milestoneId: "M1", status, fields: {} });
  return {
    fetch: (ledgerId: string) => {
      if (ledgerId !== "tasks") throw new Error(`unexpected ledger ${ledgerId}`);
      return {
        id: "tasks",
        schema: { terminalStatuses: ["done", "abandoned"] },
        milestones: [
          { id: "M1", items: Object.entries(active).map(([id, status]) => item(id, status)) },
        ],
        archivePointers: Object.keys(archived).length === 0 ? [] : [{ id: "M-ARCHIVED" }],
      };
    },
    fetchArchive: async () => ({
      kind: "group",
      milestone: {
        id: "M-ARCHIVED",
        items: Object.entries(archived).map(([id, status]) => item(id, status)),
      },
    }),
  } as unknown as LedgerStore;
}

function gateCountingOperations(
  settledTasks: ReadonlySet<string>,
  gated: string[],
): ImplementationCandidateCoordinatorOperations {
  return {
    isLeasedFrontOrphaned: async ({ control }) =>
      control.attempt.taskId !== undefined && settledTasks.has(control.attempt.taskId),
    observeProtectedHead: async (control) => control.attempt.observedBaseCommit,
    finalizeQualifiedFront: async ({ lease }) => {
      gated.push(lease.attestationId);
    },
    confirmQualifiedFront: async () => {},
    retireStaleSource: async () => {
      throw new Error("a current front must not be retired");
    },
    rebaseRetiredSource: async () => {
      throw new Error("a current front must not be rebased");
    },
    prepareSuccessor: async () => {
      throw new Error("a current front must not prepare a successor");
    },
  };
}

describe("D588 orphaned implementation-queue lease", () => {
  const backends: InMemoryAttestationBackend[] = [];

  function fixture(): ImplementationCandidateQueueFixture & {
    readonly rows: InMemoryAttestationBackend;
  } {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    backends.push(backend);
    return Object.assign(new ImplementationCandidateQueueFixture(backend), { rows: backend });
  }

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close();
  });

  test("a consumed candidate whose task was settled outside protected completion no longer blocks the partition", async () => {
    const subject = fixture();
    const adopted = await subject.stage(candidate("T6580"));
    await consumeWithLiveLease(subject, adopted);
    const next = await subject.stage(candidate("T2929"));
    const nextQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: next.candidate,
      ...next.qualification,
    });

    const gated: string[] = [];
    const outcome = await new ImplementationCandidateCoordinator(
      subject.adapter,
      gateCountingOperations(new Set(["T6580"]), gated),
    ).run({
      partitionKey: nextQualified.queue.partition.partitionKey,
      holderId: "cq-dispatch-driver",
      expectedCandidate: {
        attestationId: next.prepared.attestationId,
        generation: next.prepared.generation,
      },
    });

    expect(outcome).toMatchObject({
      state: "completed",
      handle: { attestationId: next.prepared.attestationId },
    });
    expect(gated).toEqual([next.prepared.attestationId]);
    const orphan = subject.rows
      .storedRows()
      .find((row) => row.attestationId === adopted.prepared.attestationId);
    expect(orphan?.implementationQueue).toMatchObject({
      state: "released",
      terminal: { reason: "superseded" },
    });
    expect(orphan?.implementationQueue).not.toHaveProperty("lease");
  });

  test("a consumed candidate whose task is still open keeps its lease and blocks the partition", async () => {
    const subject = fixture();
    const awaitingCompletion = await subject.stage(candidate("T6580"));
    await consumeWithLiveLease(subject, awaitingCompletion);
    const next = await subject.stage(candidate("T2929"));
    const nextQualified = await subject.adapter.qualifyNativeCompletion({
      candidate: next.candidate,
      ...next.qualification,
    });

    const gated: string[] = [];
    const outcome = await new ImplementationCandidateCoordinator(
      subject.adapter,
      gateCountingOperations(new Set(), gated),
    ).run({
      partitionKey: nextQualified.queue.partition.partitionKey,
      holderId: "cq-dispatch-driver",
    });

    expect(outcome).toMatchObject({
      state: "blocked",
      frontState: "leased",
      front: { attestationId: awaitingCompletion.prepared.attestationId },
    });
    expect(gated).toEqual([]);
  });

  test("the production predicate releases a lease whose archived task is done and keeps one whose task is wip", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "d588-no-repository-"));
    try {
      for (const [status, released] of [
        ["done", true],
        ["wip", false],
      ] as const) {
        const subject = fixture();
        const orphan = await subject.stage(candidate("T6580"));
        await consumeWithLiveLease(subject, orphan);
        const next = await subject.stage(candidate("T2929"));
        const nextQualified = await subject.adapter.qualifyNativeCompletion({
          candidate: next.candidate,
          ...next.qualification,
        });
        const capability = createDispatchCapability({
          backend: subject.backend,
          promptArtifactStore: promptArtifacts(),
          ledgerStore: taskStatusLedger({ T2929: "wip" }, { T6580: status }),
          implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
          repositoryRoot,
          now: subject.clock.now,
        });
        if (capability.coordinateImplementationCandidate === undefined) {
          throw new Error("implementation candidate coordination is unavailable");
        }
        const coordinated = capability.coordinateImplementationCandidate({
          partitionKey: nextQualified.queue.partition.partitionKey,
          holderId: "cq-dispatch-driver",
        });
        if (released) {
          // The released partition leases T2929; observing its protected head needs a real repository.
          await expect(coordinated).rejects.toThrow("read-only Git observation failed");
        } else {
          await expect(coordinated).resolves.toMatchObject({
            state: "blocked",
            frontState: "leased",
          });
        }
        const row = subject.rows
          .storedRows()
          .find((entry) => entry.attestationId === orphan.prepared.attestationId);
        expect(row?.implementationQueue?.state).toBe(released ? "released" : "leased");
      }
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});
