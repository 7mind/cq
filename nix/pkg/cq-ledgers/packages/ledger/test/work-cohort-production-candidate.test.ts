import { describe, expect, test } from "bun:test";
import {
  acquireImplementationCandidateOn,
  claimParentGateOn,
  completeParentGateOn,
  type DispatchJSONValue,
  type ImplementCohortWorkerSupervisedGateEvidence,
} from "@cq/config";
import { cohortValueDigestV1 as digest } from "@cq/process-control";
import { cohortQueueFixture } from "../../cq-config/test/workCohortQueueFixture.js";
import {
  G213CandidateAuthenticatorV1,
  createPendingCohortCandidateAttemptV1,
  materializeCohortCandidateSealV1,
  createCohortEvidenceSubjectV1,
} from "../src/workCohort.js";
import {
  CohortG213GateAuthenticatorV1,
  readAuthorizedCohortG213GateV1,
  validateCohortG213GateReceiptV1,
} from "../src/workCohortGate.js";

for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} cohort production candidate [Blackbox-GoodCommunication]`, () => {
    test("authenticates and seals the actual full-member queue attempt, then binds a V2 gate to its evidence subject", async () => {
      const f = await cohortQueueFixture(backend);
      try {
        const qualified = await f.qualify();
        const wholeDiff = [
          {
            path: "src/shared.ts",
            mode: "100644" as const,
            blobDigest: digest("shared correction"),
          },
        ];
        const pending = createPendingCohortCandidateAttemptV1(
          f.cohort.definition,
          {
            attestationId: f.prepared.attestationId,
            generation: f.prepared.generation,
            cohort: f.cohort,
            branch: f.binding.branch,
            startingCommit: f.baseCommit,
          },
          f.cohort.intent,
        );
        const attempt = await f.backend.transact({ kind: "namespace" }, async (store) => {
          const auth = new G213CandidateAuthenticatorV1({
            store,
            repository: { resolveWholeDiff: async () => wholeDiff },
          });
          const row = await auth.resolve(f.prepared);
          return auth.stage(pending, { row });
        });
        expect(attempt.preparedDispatch.cohort).toEqual(f.cohort);
        expect(Object.hasOwn(attempt.preparedDispatch, "taskId")).toBe(false);
        const seal = materializeCohortCandidateSealV1({
          definition: f.cohort.definition,
          attempt,
          baseCommit: f.baseCommit,
          resultCommit: f.resultCommit,
          resultTree: f.resultTree,
          wholeDiff,
          gitReceipts: f.receipts,
        });
        const evidenceSubject = createCohortEvidenceSubjectV1(f.cohort.definition, seal);
        const queue = qualified.implementationQueue!;
        const acquired = await acquireImplementationCandidateOn(
          f.backend,
          {
            namespace: f.namespace,
            actor: "trusted-parent",
            partitionKey: queue.partition.partitionKey,
            holderId: "candidate-gate",
          },
          { now: f.now },
        );
        if (acquired.state !== "leased") throw new Error("qualified cohort was not queue front");
        const claim = await claimParentGateOn(
          f.backend,
          {
            ...f.prepared,
            parentGateCapability: f.prepared.parentGateCapability!,
            queueLease: acquired.lease,
          },
          { now: f.now },
        );
        if (claim.state !== "gate-running") throw new Error("cohort gate was not claimed");
        const provenance = qualified.promptProvenance;
        const gate: ImplementCohortWorkerSupervisedGateEvidence = {
          kind: "cq-supervised-gate-evidence",
          version: 2,
          evidenceSubject,
          attestationId: f.prepared.attestationId,
          generation: f.prepared.generation,
          roleId: "implement-worker",
          roleVersion: provenance.version,
          surface: "codex",
          promptDigest: provenance.promptDigest,
          catalogHash: provenance.catalogHash,
          inputDigest: provenance.inputDigest,
          worktreePath: f.binding.worktreePath,
          branch: f.binding.branch,
          baseCommit: f.baseCommit,
          startingCommit: f.baseCommit,
          resultCommit: f.resultCommit,
          clean: true,
          command: queue.attempt.gateCommand,
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
          gateDurationMs: 1,
          capturedAt: f.now(),
          filesTouchedDigest: digest(f.output.filesTouched),
          gitReceiptsDigest: digest(f.receipts),
          mutationTableDigest: digest(f.output.mutationTable),
        };
        await completeParentGateOn(
          f.backend,
          {
            ...f.prepared,
            parentGateCapability: f.prepared.parentGateCapability!,
            queueLease: acquired.lease,
            gateEpoch: claim.gateEpoch,
            output: { ...f.output, supervisedGateEvidence: gate } as unknown as DispatchJSONValue,
          },
          { now: f.now },
        );
        const receipt = await f.backend.transact({ kind: "namespace" }, (store) =>
          readAuthorizedCohortG213GateV1(
            new CohortG213GateAuthenticatorV1(store).authenticate(attempt, seal),
          ),
        );
        expect(receipt.gate.version).toBe(2);
        expect(receipt.gate.evidenceSubject).toEqual(evidenceSubject);
        expect(() => validateCohortG213GateReceiptV1(receipt, attempt, seal)).not.toThrow();
        const foreignSubjectPayload = { ...evidenceSubject, sealDigest: "e".repeat(64) };
        const { evidenceSubjectDigest: _old, ...subjectPayload } = foreignSubjectPayload;
        const foreignGate = {
          ...gate,
          evidenceSubject: { ...subjectPayload, evidenceSubjectDigest: digest(subjectPayload) },
        };
        const { receiptDigest: _receiptDigest, ...payload } = receipt;
        const altered = { ...payload, gate: foreignGate };
        expect(() =>
          validateCohortG213GateReceiptV1(
            { ...altered, receiptDigest: digest(altered) },
            attempt,
            seal,
          ),
        ).toThrow();
        expect(() =>
          createPendingCohortCandidateAttemptV1(
            f.cohort.definition,
            {
              attestationId: f.prepared.attestationId,
              generation: f.prepared.generation,
              branch: f.binding.branch,
              startingCommit: f.baseCommit,
              cohort: { ...f.cohort, executionEpoch: "substituted" },
            },
            f.cohort.intent,
          ),
        ).toThrow();
      } finally {
        await f.close();
      }
    });
  });
