import {
  CohortAcceptanceRunnerV1,
  type CohortAcceptanceCandidateV1,
  type CohortAcceptanceHostV1,
  type CohortCommandOutcomeV1,
  type CohortCommandV1,
} from "../src/workCohortAcceptance.js";
import type { CohortBoundaryIdentityV1 } from "../src/workCohort.js";
import type { WorkCohortStore } from "../src/workCohortStore.js";
import { cohortStagedOutputFixture, qualifiedQueue, sha256 } from "./workCohortFixture.js";
import { InMemoryAttestationStore, type AttestationEnvelope, type ImplementWorkerSupervisedGateEvidence } from "@cq/config";
import { CohortG213GateAuthenticatorV1, type CohortG213GateReceiptV1 } from "../src/workCohortGate.js";

export class ManualCohortAcceptanceHost implements CohortAcceptanceHostV1 {
  readonly gateStore: InMemoryAttestationStore;
  readonly commands: CohortCommandV1[] = [];
  readonly gates: CohortCommandV1[] = [];
  sharedCommand: CohortCommandV1 | null = null;
  exitCode = 0;
  gateExitCode = 0;
  gatePassCount = 1;
  afterCommand: (() => Promise<void>) | null = null;
  candidateChanged = false;
  #locked = false;

  constructor(gateStore: InMemoryAttestationStore | null) {
    this.gateStore = gateStore ?? new InMemoryAttestationStore({ backend: "xdg", projectKey: "cohort-gate-dummy" });
  }

  async withCandidateLock<T>(_candidate: CohortAcceptanceCandidateV1, run: () => Promise<T>): Promise<T> {
    if (this.#locked) throw new Error("candidate lock already held");
    this.#locked = true;
    try { return await run(); } finally { this.#locked = false; }
  }

  async revalidateCandidate(_candidate: CohortAcceptanceCandidateV1): Promise<void> {
    if (!this.#locked) throw new Error("candidate lock is not held");
    if (this.candidateChanged) throw new Error("sealed candidate changed");
  }

  async resolveBoundaryCommand(boundary: CohortBoundaryIdentityV1): Promise<CohortCommandV1> {
    if (boundary.identity.startsWith("regression:")) {
      return this.sharedCommand ?? { argv: ["bun", "test", "shared.test.ts"],
        cwd: "nix/pkg/cq-ledgers", environment: [] };
    }
    return { argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] };
  }

  async runCommand(command: CohortCommandV1, signal: AbortSignal): Promise<CohortCommandOutcomeV1> {
    signal.throwIfAborted();
    if (!this.#locked) throw new Error("command escaped candidate lock");
    this.commands.push(command);
    if (this.afterCommand !== null) await this.afterCommand();
    return { executionId: `command:${this.commands.length}`, exitCode: this.exitCode,
      outputDigest: sha256({ command, exitCode: this.exitCode }), outputTail: `command exit ${this.exitCode}` };
  }

  async runCanonicalQueueGate(candidate: CohortAcceptanceCandidateV1, command: CohortCommandV1,
    signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.#locked) throw new Error("gate escaped candidate lock");
    this.gates.push(command);
    const outcome = { executionId: `g213:gate:${this.gates.length}`, exitCode: this.gateExitCode,
      outputDigest: sha256({ command, exitCode: this.gateExitCode }), outputTail: `gate exit ${this.gateExitCode}` };
    if (this.gateExitCode !== 0) return { outcome, gate: null };
    const { attempt, seal } = candidate;
    const dispatch = attempt.preparedDispatch;
    if (dispatch.cohort !== undefined) throw new Error("legacy acceptance fixture requires its explicit task arm");
    const stagedOutput = cohortStagedOutputFixture({ taskId: dispatch.taskId, branch: dispatch.branch,
      resultCommit: seal.resultCommit, receipts: seal.gitReceipts, wholeDiff: seal.wholeDiff });
    const binding = { taskId: dispatch.taskId, handleToken: "worktree-token",
      handleFingerprint: sha256(`worktree-fingerprint:${attempt.g213.attemptId}`),
      repositoryRoot: "/repo", repositoryId: "repository:test", commonDir: "/repo/.git",
      worktreePath: "/repo/.claude/worktrees/test", branch: dispatch.branch,
      ref: `refs/heads/${dispatch.branch}`, baseCommit: seal.baseCommit };
    const queue = qualifiedQueue({ taskId: dispatch.taskId, base: seal.baseCommit, result: seal.resultCommit,
      tree: seal.resultTree, receipts: seal.gitReceipts, attempt: attempt.g213.attemptId,
      managedWorktreeBindingDigest: sha256(binding), outputDigest: sha256(stagedOutput) });
    const provenance = { roleId: "implement-worker", version: 10, promptDigest: sha256("prompt"),
      catalogHash: sha256("catalog"), inputDigest: sha256("input") };
    const filesTouched = seal.wholeDiff.map((entry) => entry.path);
    const gate: ImplementWorkerSupervisedGateEvidence = {
      kind: "cq-supervised-gate-evidence", version: 1, attestationId: dispatch.attestationId,
      generation: dispatch.generation, roleId: "implement-worker", roleVersion: 10, surface: "codex",
      promptDigest: provenance.promptDigest, catalogHash: provenance.catalogHash, inputDigest: provenance.inputDigest,
      taskId: dispatch.taskId, branch: dispatch.branch, worktreePath: binding.worktreePath,
      baseCommit: seal.baseCommit, startingCommit: dispatch.startingCommit, resultCommit: seal.resultCommit,
      clean: true, command: queue.attempt.gateCommand, gateExitCode: 0, passCount: this.gatePassCount,
      failCount: 0, gateDurationMs: 1, capturedAt: "2026-09-22T00:00:00.000Z",
      filesTouchedDigest: sha256(filesTouched), gitReceiptsDigest: seal.gitReceiptBridgeDigest,
      mutationTableDigest: sha256(stagedOutput.mutationTable),
    };
    const output = { ...stagedOutput, supervisedGateEvidence: gate };
    const row = { kind: "envelope", namespace: this.gateStore.namespace, ...dispatch,
      state: "result-stored", promptProvenance: provenance, expectedChild: { childId: "child", runId: "run" },
      gitEffectBinding: binding, implementationQueue: { ...queue, state: "leased",
        lease: { holderId: "queue-front", generation: 1, acquiredAt: "2026-09-22T00:00:00.000Z" } },
      stagedCompletionQualification: queue.qualification, gateSubmittedOutputDigest: attempt.g213.qualifiedOutputDigest,
      output, outputDigest: sha256(output),
    } as unknown as AttestationEnvelope;
    const prior = this.gateStore.read(dispatch);
    if (prior === undefined) this.gateStore.insert(row);
    else this.gateStore.replace(prior, row);
    return { outcome, gate: new CohortG213GateAuthenticatorV1(this.gateStore).authenticate(attempt, seal) };
  }

  async revalidateCanonicalGate(candidate: CohortAcceptanceCandidateV1, receipt: CohortG213GateReceiptV1): Promise<void> {
    new CohortG213GateAuthenticatorV1(this.gateStore).revalidate(candidate.attempt, candidate.seal, receipt);
  }
}

export async function recordFixtureCohortAcceptance(store: WorkCohortStore, subject: string): Promise<void> {
  const state = (await store.snapshot()).portable;
  const evidence = state.evidenceSubjects.find((value) => value.evidenceSubjectDigest === subject);
  const definition = state.definitions.find((value) => value.definitionDigest === evidence?.definitionDigest);
  if (definition === undefined) throw new Error("storage fixture lacks its definition");
  if (!state.reservationTransitions.some((value) => value.definitionDigest === definition.definitionDigest && value.transition === "reserved")) {
    await store.transitionReservation("reserve:storage-acceptance", {
      reservationId: "reservation:storage-acceptance", cohortId: definition.cohortId,
      definitionDigest: definition.definitionDigest, memberRefs: definition.members.map((member) => member.memberRef),
      transition: "reserved",
    });
  }
  const lease = await store.acquireLease({ holderId: "storage-contract-runner", semanticSubject: subject });
  try {
    await new CohortAcceptanceRunnerV1(store, new ManualCohortAcceptanceHost(null)).run(lease, new AbortController().signal);
  } finally {
    await store.releaseLease(lease);
  }
}
