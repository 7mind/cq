import { expect, test } from "bun:test";
import {
  CohortAcceptanceRunnerV1,
  CohortAcceptanceRejectedError,
  type AuthorizedCohortCommandExecutionV1,
} from "../src/workCohortAcceptance.js";
import { WorkCohortStaleAuthorityError, type WorkCohortStore } from "../src/workCohortStore.js";
import { observationFor, sha256 } from "./workCohortFixture.js";
import { createCohortCandidateIntentV1 } from "../src/workCohort.js";
import type { DispatchJSONValue } from "@cq/config";
import { CohortG213GateAuthenticatorV1, readAuthorizedCohortG213GateV1, type AuthorizedCohortG213GateV1 } from "../src/workCohortGate.js";
import { ManualCohortAcceptanceHost } from "./workCohortAcceptanceFixture.js";
import { prepareWorkCohortStore, workCohortStoreFixtureFromObservation } from "./workCohortStoreContract.js";
import { readCohortAdvanceStatusV1 } from "../src/workCohortAdvance.js";

export function workCohortAcceptanceContract(label: string, create: () => Promise<{
  readonly store: WorkCohortStore; readonly close: () => Promise<void>;
}>): void {
  async function fixture(sharedFocused: boolean) {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ command: "first" }] },
      { ref: "tasks:T2", atoms: [{ command: sharedFocused ? "first" : "second" }] },
    ]);
    const opened = await create();
    const prepared = await workCohortStoreFixtureFromObservation(observation, "acceptance", 1);
    await prepareWorkCohortStore(opened.store, prepared);
    await opened.store.transitionReservation("reserve:acceptance", {
      reservationId: "reservation:acceptance", cohortId: prepared.definition.cohortId,
      definitionDigest: prepared.definition.definitionDigest,
      memberRefs: prepared.definition.members.map((member) => member.memberRef), transition: "reserved",
    });
    const sealed = await opened.store.sealCandidate("seal", prepared.request);
    const lease = await opened.store.acquireLease({ holderId: "acceptance-runner",
      semanticSubject: sealed.evidenceSubject.evidenceSubjectDigest });
    const host = new ManualCohortAcceptanceHost(null);
    return { ...opened, prepared, sealed, lease, host, runner: new CohortAcceptanceRunnerV1(opened.store, host) };
  }

  test(`${label}: acceptance cannot execute after its all-member reservation is released`, async () => {
    const f = await fixture(false);
    try {
      await f.store.transitionReservation("release:acceptance", {
        reservationId: "reservation:acceptance", cohortId: f.prepared.definition.cohortId,
        definitionDigest: f.prepared.definition.definitionDigest,
        memberRefs: f.prepared.definition.members.map((member) => member.memberRef), transition: "released",
      });
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toThrow("all-member reservation");
      expect(f.host.commands).toHaveLength(0);
      expect(f.host.gates).toHaveLength(0);
    } finally { await f.close(); }
  });

  test(`${label}: every distinct focused plan precedes shared regression and one canonical gate`, async () => {
    const f = await fixture(false);
    try {
      const result = await f.runner.run(f.lease, new AbortController().signal);
      expect(result).toMatchObject({ focusedExecutions: 2, focusedDeduplications: 0,
        sharedExecutions: 1, sharedReuses: 0, fullGateExecutions: 1, persistedReuses: 0 });
      expect(result.evidence.map((entry) => entry.evidenceKind)).toEqual([
        "focused", "focused", "shared-regression", "full-gate",
      ]);
      expect(f.host.commands).toHaveLength(3);
      expect(f.host.gates).toHaveLength(1);
      const completion = await f.store.finalize("complete", {
        definitionDigest: f.prepared.definition.definitionDigest,
        evidenceSubjectDigest: f.sealed.evidenceSubject.evidenceSubjectDigest,
      });
      expect(completion.focusedEvidenceDigests).toHaveLength(2);
      expect(completion.fullGateEvidenceDigest).not.toBeNull();
      const repeated = await f.runner.run(f.lease, new AbortController().signal);
      expect(repeated).toMatchObject({ focusedExecutions: 0, sharedExecutions: 0,
        fullGateExecutions: 0, persistedReuses: 4 });
      expect(repeated.evidence).toEqual(result.evidence);
      expect(f.host.gates).toHaveLength(1);
    } finally { await f.close(); }
  });

  test(`${label}: exact commands deduplicate across members and shared regression`, async () => {
    const f = await fixture(true);
    try {
      f.host.sharedCommand = { argv: ["bun", "test", "packages/ledger/test/first.test.ts"],
        cwd: "nix/pkg/cq-ledgers", environment: [] };
      const result = await f.runner.run(f.lease, new AbortController().signal);
      expect(result).toMatchObject({ focusedExecutions: 1, focusedDeduplications: 1,
        sharedExecutions: 0, sharedReuses: 1, fullGateExecutions: 1 });
      const [focused, shared] = result.evidence;
      expect(focused?.execution?.memberPlanDigests).toHaveLength(2);
      expect(shared?.execution?.outcome.executionId).toBe(focused?.execution?.outcome.executionId);
      expect(f.host.commands).toHaveLength(1);
      expect(f.host.gates).toHaveLength(1);
      await f.runner.run(f.lease, new AbortController().signal);
      const status = await readCohortAdvanceStatusV1(f.store);
      expect(status.counters).toMatchObject({ focusedExecutions: 1, focusedDeduplications: 2,
        sharedExecutions: 0, sharedReuses: 1, fullGateExecutions: 1, persistedEvidenceReuses: 3 });
    } finally { await f.close(); }
  });

  test(`${label}: focused red retains diagnostics and never reaches the canonical gate`, async () => {
    const f = await fixture(false);
    try {
      f.host.exitCode = 1;
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(CohortAcceptanceRejectedError);
      expect(f.host.commands).toHaveLength(1);
      expect(f.host.gates).toHaveLength(0);
      const evidence = (await f.store.snapshot()).portable.commandEvidence;
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.execution?.outcome.exitCode).toBe(1);
      expect(evidence[0]?.execution?.outcome.outputTail).toBe("command exit 1");
      await expect(f.store.finalize("red", { definitionDigest: f.prepared.definition.definitionDigest,
        evidenceSubjectDigest: f.sealed.evidenceSubject.evidenceSubjectDigest })).rejects.toThrow("runner-owned");
      f.host.exitCode = 0;
      expect(await f.runner.run(f.lease, new AbortController().signal)).toMatchObject({ fullGateExecutions: 1 });
      expect((await readCohortAdvanceStatusV1(f.store)).counters).toMatchObject({
        focusedExecutions: 3, focusedAttempts: 3, fullGateExecutions: 1, acceptanceFailures: 1,
        acceptanceFinalizationAttempts: 1, finalizationAttempts: 1,
      });
    } finally { await f.close(); }
  });

  test(`${label}: shared red stops before full gate and retry preserves green member evidence`, async () => {
    const f = await fixture(false);
    try {
      f.host.afterCommand = async () => {
        if (f.host.commands.at(-1)?.argv.includes("shared.test.ts")) f.host.exitCode = 1;
      };
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(CohortAcceptanceRejectedError);
      expect(f.host.gates).toHaveLength(0);
      expect(f.host.commands).toHaveLength(3);
      f.host.afterCommand = null;
      f.host.exitCode = 0;
      expect(await f.runner.run(f.lease, new AbortController().signal)).toMatchObject({
        focusedExecutions: 0, persistedReuses: 2, sharedExecutions: 1, fullGateExecutions: 1,
      });
      expect((await readCohortAdvanceStatusV1(f.store)).counters).toMatchObject({
        focusedExecutions: 2, sharedExecutions: 2, sharedAttempts: 2, sharedRejections: 1,
        persistedEvidenceReuses: 2, acceptanceFailures: 1, fullGateExecutions: 1,
      });
    } finally { await f.close(); }
  });

  test(`${label}: full-gate red retries only the full gate and zero-test green is rejected`, async () => {
    const f = await fixture(false);
    try {
      f.host.gateExitCode = 1;
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(CohortAcceptanceRejectedError);
      expect(f.host.commands).toHaveLength(3);
      expect(f.host.gates).toHaveLength(1);
      f.host.gateExitCode = 0;
      f.host.gatePassCount = 0;
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toThrow("canonical green supervised evidence");
      expect(f.host.commands).toHaveLength(3);
      f.host.gatePassCount = 1;
      expect(await f.runner.run(f.lease, new AbortController().signal)).toMatchObject({
        focusedExecutions: 0, sharedExecutions: 0, fullGateExecutions: 1, persistedReuses: 3,
      });
      expect((await readCohortAdvanceStatusV1(f.store)).counters).toMatchObject({
        focusedExecutions: 2, sharedExecutions: 1, fullGateAttempts: 3, fullGateExecutions: 2,
        acceptanceFailures: 2, persistedEvidenceReuses: 6,
      });
    } finally { await f.close(); }
  });

  test(`${label}: full-gate reuse requires the exact surviving G213 completion`, async () => {
    const f = await fixture(false);
    try {
      const result = await f.runner.run(f.lease, new AbortController().signal);
      const gate = result.evidence.at(-1)?.execution?.canonicalGate;
      expect(gate?.attemptId).toBe(f.prepared.staged.g213.attemptId);
      expect(() => readAuthorizedCohortG213GateV1({ receipt: () => gate } as unknown as AuthorizedCohortG213GateV1))
        .toThrow("authenticated G213 completion");
      const authenticator = new CohortG213GateAuthenticatorV1(f.host.gateStore);
      expect(() => authenticator.authenticate({ ...f.prepared.staged,
        g213: { ...f.prepared.staged.g213, attemptId: "foreign" } }, f.sealed.seal))
        .toThrow("sealed G213 attempt");
      const row = f.host.gateStore.read(f.prepared.staged.preparedDispatch);
      if (row === undefined || row.kind !== "envelope") throw new Error("missing dummy gate completion");
      f.host.gateStore.replace(row, { ...row, state: "gate-pending" });
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toThrow("exact completed G213 row");
      expect(f.host.gates).toHaveLength(1);
      expect((await readCohortAdvanceStatusV1(f.store)).counters).toMatchObject({ evidenceRejections: 1, fullGateExecutions: 1 });
    } finally { await f.close(); }
  });

  test(`${label}: G213 rejects substituted mutation evidence, staged bytes, provenance, and child identity`, async () => {
    const f = await fixture(false);
    try {
      await f.runner.run(f.lease, new AbortController().signal);
      const row = f.host.gateStore.read(f.prepared.staged.preparedDispatch);
      if (row === undefined || row.kind !== "envelope") throw new Error("missing dummy gate completion");
      const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
      const gate = output["supervisedGateEvidence"] as Readonly<Record<string, DispatchJSONValue>>;
      const authenticator = new CohortG213GateAuthenticatorV1(f.host.gateStore);
      for (const mode of ["mutation", "staged", "provenance", "child"] as const) {
        const changedOutput = { ...output,
          ...(mode === "mutation" ? { mutationTable: [{ substituted: true }] } : {}),
          ...(mode === "staged" ? { summary: "substituted staged evidence" } : {}),
          ...(mode === "provenance" ? { supervisedGateEvidence: { ...gate, promptDigest: sha256("foreign prompt") } } : {}),
        };
        const changed = { ...row, output: changedOutput, outputDigest: sha256(changedOutput),
          ...(mode === "provenance" ? { promptProvenance: { ...row.promptProvenance, promptDigest: sha256("foreign prompt") } } : {}),
          ...(mode === "child" ? { expectedChild: { ...row.expectedChild, childId: "foreign-child" } } : {}),
        };
        f.host.gateStore.replace(row, changed);
        expect(() => authenticator.authenticate(f.prepared.staged, f.sealed.seal), mode).toThrow();
        f.host.gateStore.replace(changed, row);
      }
    } finally { await f.close(); }
  });

  test(`${label}: unchanged restart renews effects and reuses all exact green command receipts`, async () => {
    const f = await fixture(false);
    try {
      const before = await f.runner.run(f.lease, new AbortController().signal);
      await f.store.beginNewExecutionEpoch();
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
      await f.store.revalidateForResume({ definitionDigest: f.prepared.definition.definitionDigest,
        sealDigest: f.sealed.seal.sealDigest, evidenceSubjectDigest: f.sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: f.prepared.definition.acceptanceMatrixDigest,
        environmentDigest: f.prepared.definition.environment.environmentDigest,
        receiptBridgeDigest: f.sealed.receiptBridge.bridgeDigest });
      const lease = await f.store.acquireLease({ holderId: "after-restart", semanticSubject: f.lease.semanticSubject });
      expect(lease.executionEpoch).not.toBe(f.lease.executionEpoch);
      const host = new ManualCohortAcceptanceHost(f.host.gateStore);
      const after = await new CohortAcceptanceRunnerV1(f.store, host).run(lease, new AbortController().signal);
      expect(after.evidence).toEqual(before.evidence);
      expect(after.persistedReuses).toBe(4);
      expect(host.commands).toHaveLength(0);
      expect(host.gates).toHaveLength(0);
      expect((await readCohortAdvanceStatusV1(f.store)).counters).toMatchObject({
        executionEpochRenewals: 1, executionEpochRejections: 1, persistedEvidenceReuses: 4,
        focusedExecutions: 2, sharedExecutions: 1, fullGateExecutions: 1,
      });
      const settled = await f.store.snapshot();
      await f.store.assertLiveAcceptanceAuthority(lease);
      expect(await f.store.snapshot()).toEqual(settled);
    } finally { await f.close(); }
  });

  test(`${label}: changed candidate and epoch during execution cannot write acceptance`, async () => {
    for (const mode of ["candidate", "epoch"] as const) {
      const f = await fixture(false);
      try {
        f.host.afterCommand = async () => {
          if (mode === "candidate") f.host.candidateChanged = true;
          else await f.store.beginNewExecutionEpoch();
        };
        await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toThrow(
          mode === "candidate" ? "candidate changed" : "execution epoch",
        );
        expect((await f.store.snapshot()).portable.commandEvidence).toHaveLength(0);
        expect(f.host.gates).toHaveLength(0);
      } finally { await f.close(); }
    }
  });

  test(`${label}: intent replacement during a command or at receipt entry rejects stale acceptance`, async () => {
    for (const mode of ["command", "receipt-entry"] as const) {
      const f = await fixture(false);
      const original = f.store.recordProtectedCommandEvidence.bind(f.store);
      try {
        const replace = async () => {
          await f.store.recordCandidateIntent("replacement", createCohortCandidateIntentV1(f.prepared.definition, "replacement"));
        };
        if (mode === "command") f.host.afterCommand = replace;
        else f.store.recordProtectedCommandEvidence = async (operationId, lease, execution) => {
          await replace();
          return original(operationId, lease, execution);
        };
        await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
        expect((await f.store.snapshot()).portable.commandEvidence).toHaveLength(0);
        expect(f.host.gates).toHaveLength(0);
      } finally { f.store.recordProtectedCommandEvidence = original; await f.close(); }
    }
  });

  test(`${label}: epoch rotation at receipt transaction entry rejects the stale write`, async () => {
    const f = await fixture(false);
    const original = f.store.recordProtectedCommandEvidence.bind(f.store);
    try {
      f.store.recordProtectedCommandEvidence = async (operationId, lease, execution) => {
        await f.store.beginNewExecutionEpoch();
        return original(operationId, lease, execution);
      };
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toBeInstanceOf(WorkCohortStaleAuthorityError);
      expect((await f.store.snapshot()).portable.commandEvidence).toHaveLength(0);
      expect(f.host.gates).toHaveLength(0);
    } finally {
      f.store.recordProtectedCommandEvidence = original;
      await f.close();
    }
  });

  test(`${label}: caller-copied execution objects do not mint protected evidence`, async () => {
    const f = await fixture(false);
    try {
      const result = await f.runner.run(f.lease, new AbortController().signal);
      const execution = result.evidence[0]?.execution;
      expect(() => f.store.recordProtectedCommandEvidence("forged", f.lease,
        { receipt: () => execution } as unknown as AuthorizedCohortCommandExecutionV1,
      )).toThrow("runner-issued");
    } finally { await f.close(); }
  });

  test(`${label}: command substitutions cannot inherit an unchanged boundary identity`, async () => {
    const f = await fixture(false);
    try {
      await f.runner.run(f.lease, new AbortController().signal);
      f.host.sharedCommand = { argv: ["bun", "test", "other.test.ts"],
        cwd: "nix/pkg/cq-ledgers", environment: [] };
      await expect(f.runner.run(f.lease, new AbortController().signal)).rejects.toThrow("boundary command changed");
      expect(f.host.gates).toHaveLength(1);
    } finally { await f.close(); }
  });
}
