import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_CORRELATION_SEPARATOR, InMemoryAttestationBackend, InMemoryAttestationStore, SqliteAttestationBackend, implementWorkerSidecar, implementConflictResolverSidecar,
  type AttestationBackend, type DispatchJSONValue, type DispatchPrepared } from "@cq/config";
import { cohortValueDigestV1, createCohortCommandBoundaryV1, createInMemoryImplementationEvidenceStore, resolveRetainedManagedCohortAuthority,
  createCohortEffectEnvelopeV1, observeManagedWorktreeConflictState } from "@cq/ledger";
import { prepareManagedCohortRebaseSuccessor, resumeManagedCohortRebaseSuccessor, parseWorkCohortPortableStateV1, createInMemoryWorkCohortStore } from "@cq/ledger";
import { createLedgerMcpToolSpecifications, createTrustedWorksetManagementAuthority } from "@cq/ledger";
import { cohortBrokerGit, cohortChangeRequest, cohortGitBrokerFixture, rawDigest } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { createCohortAdvanceRuntimeV1 } from "../src/workCohortAdvanceRuntime.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

function cohortPromptStore(): PromptArtifactStore {
  const metadata = { roleId: "implement-worker", roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md", sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const, promptDigest: "a".repeat(64), schemaVersion: implementWorkerSidecar.version };
  const resolver = { ...metadata, roleId: "implement-conflict-resolver", artifactPath: "roles/implement-conflict-resolver.md",
    sidecarSchemaRoleId: "implement-conflict-resolver", schemaVersion: implementConflictResolverSidecar.version };
  return {
    readManifest: () => ({ bytes: new Uint8Array(), roles: [metadata, resolver], promptSurface: "codex", catalogHash: "b".repeat(64) }),
    readRole: (roleId) => ({ metadata: roleId === resolver.roleId ? resolver : metadata, bytes: new Uint8Array([1]) }),
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  for (const mode of ["initial", "renewed", "revoked-before-result", "stale", "conflict", "crash", "epoch-recovery"] as const) {
  const renewed = mode === "renewed";
  const conflict = mode === "conflict";
  const epochRecovery = mode === "epoch-recovery";
  const crash = mode === "crash" || epochRecovery;
  const stale = mode === "stale" || conflict || crash;
  test(`cohort production dispatch runs the exact ladder (${kind}, ${mode}) [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const fixture = await cohortGitBrokerFixture(kind, {
      sharedRegression: createCohortCommandBoundaryV1({ argv: ["bun", "test", "shared.test.ts"], cwd: "nix/pkg/cq-ledgers", environment: [] }),
      canonicalFullGate: createCohortCommandBoundaryV1({ argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] }),
    });
    const namespace = { backend: "xdg" as const, projectKey: "cohort-production-dispatch" };
    let backend: AttestationBackend = kind === "memory"
      ? new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace))
      : new SqliteAttestationBackend({ namespace, dbPath: `${fixture.root}/.state/attestation.db` });
    try {
      const cohort = fixture.authority.envelope;
      const commands: string[] = [];
      const implementationEvidenceStore = createInMemoryImplementationEvidenceStore();
      const successorLaunches: DispatchPrepared[] = [];
      const runtime = () => createDispatchCapability({
        backend, promptArtifactStore: cohortPromptStore(), repositoryRoot: fixture.root,
        worktreeStateDir: fixture.deps.stateDir, ledgerStore: fixture.ledger,
        implementationEvidenceStore,
        cohortStore: fixture.store,
        implementationSuccessorLauncher: async ({ prepared }) => { successorLaunches.push(prepared); },
        cohortCommandRunner: { run: async (request) => {
          commands.push(request.command.argv.join(" "));
          return { executionId: `focused:${commands.length}`, outputDigest: cohortValueDigestV1(request.command),
            gateExitCode: 0, passCount: 1, failCount: 0, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "1 pass" };
        } },
        supervisedWorkerGateRunner: { run: async () => {
          commands.push("bun run check");
          return { gateExitCode: 0, passCount: 3, failCount: 0, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "3 pass" };
        } },
      });
      let capability = runtime();
      const prepared = await capability.prepare({ roleId: "implement-worker", idempotencyKey: "cohort-prepare", timeoutMs: 600_000,
        expectedChild: { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}cohort-child`, runId: "cohort-run" }, input: {
          cohort, members: cohort.definition.members.map((member) => ({ memberRef: member.memberRef,
            headline: member.memberRef, description: "Shared correction", acceptance: "Focused member acceptance" })),
          branch: fixture.prepared.handle.branch, worktreePath: fixture.prepared.handle.absolutePath,
          baseCommit: fixture.baseCommit, startingCommit: fixture.baseCommit, round: 0, validationIntent: "final",
        } as unknown as DispatchJSONValue });
      expect(prepared).toMatchObject({ accepted: true });
      if (!prepared.accepted) throw new Error(JSON.stringify(prepared));
      const row = await backend.transact({ kind: "handle", handle: prepared.prepared }, (store) => store.read(prepared.prepared));
      if (row?.kind !== "envelope") throw new Error("prepared cohort dispatch disappeared");
      expect(row.gitEffectBinding?.cohort).toEqual(cohort);
      expect(row.gitEffectBinding).not.toHaveProperty("taskId");
      await capability.fetchInput({ ...prepared.prepared, inputCapability: prepared.prepared.inputCapability });
      if (capability.gitCommit === undefined || prepared.prepared.gitChangeCapability === undefined) throw new Error("cohort Git capability missing");
      const change = await cohortChangeRequest(fixture.authorization, "shared-change", "a", "base a\n", "cohort correction\n");
      const receipt = await capability.gitCommit({ ...prepared.prepared, gitChangeCapability: prepared.prepared.gitChangeCapability,
        operationId: change.operationId, expectedHead: change.expectedHead, message: change.message, changes: change.changes });
      expect(receipt.version).toBe(2);
      expect(receipt).not.toHaveProperty("taskId");
      const resultInput = { ...prepared.prepared, resultCapability: prepared.prepared.resultCapability,
        output: { cohort, memberObservations: cohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Shared correction" })),
          status: "pass", resultCommit: receipt.newHead, branch: fixture.prepared.handle.branch, actualWorktreePath: fixture.prepared.handle.absolutePath,
          filesTouched: receipt.paths, gitReceipts: [receipt], checkSummary: "Awaiting canonical ladder", summary: "All members implemented",
          baseVerification: { status: "verified", relation: "descendant", baseCommit: fixture.baseCommit, headCommit: receipt.newHead },
        } as unknown as DispatchJSONValue };
      if (mode === "revoked-before-result") {
        await fixture.store.beginNewExecutionEpoch();
        await expect(capability.storeResult(resultInput)).rejects.toThrow();
        const unchanged = await backend.transact({ kind: "handle", handle: prepared.prepared }, (store) => store.read(prepared.prepared));
        expect(unchanged?.kind === "envelope" ? unchanged.state : "missing").toBe("prepared");
        expect(commands).toHaveLength(0);
        return;
      }
      const stored = await capability.storeResult(resultInput);
      expect(stored.state).toBe("gate-pending");
      if (capability.finalizeParentGate === undefined || prepared.prepared.parentGateCapability === undefined) throw new Error("parent gate capability missing");
      await expect(capability.finalizeParentGate({ ...prepared.prepared,
        parentGateCapability: prepared.prepared.parentGateCapability })).rejects.toThrow("cohort acceptance requires the qualified queue-front ladder");
      if (capability.qualifyImplementationCandidate === undefined) throw new Error("cohort qualification missing");
      const qualified = await capability.qualifyImplementationCandidate({ ...prepared.prepared,
        roleId: "implement-worker", correlationId: "cohort-child", childThreadId: "cohort-thread", expectedRunId: "cohort-run",
        outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
      expect(qualified.state).toBe("queued");
      if (qualified.state !== "queued") throw new Error("expected a qualified cohort candidate");
      const cohorts = await fixture.store.snapshot();
      expect(cohorts.portable.candidateSeals).toHaveLength(1);
      expect(cohorts.runtime.lease?.semanticSubject).toBe(cohorts.portable.evidenceSubjects[0]!.evidenceSubjectDigest);
      if (capability.coordinateImplementationCandidate === undefined || prepared.prepared.parentGateCapability === undefined) throw new Error("cohort queue-front capability missing");
      let parentGateCapability = prepared.prepared.parentGateCapability;
      let resumedSuccessor: Awaited<ReturnType<NonNullable<typeof capability.resumeCohortRebaseSuccessor>>> | undefined;
      if (stale) {
        const integrationPath = conflict ? "a.txt" : "integration.txt";
        await writeFile(join(fixture.root, integrationPath), "new integration head\n");
        await cohortBrokerGit(fixture.root, ["add", integrationPath]);
        await cohortBrokerGit(fixture.root, ["commit", "-qm", "advance integration"]);
      }
      if (renewed) {
        const { createCohortEffectEnvelopeV1, retainManagedCohortAuthority,
          withManagedCohortAuthorityWriterLock, withManagedWorktreeEffectLock } = await import("@cq/ledger");
        const state = (await fixture.store.snapshot()).portable;
        const definition = state.definitions[0]!;
        const seal = state.candidateSeals[0]!;
        const subject = state.evidenceSubjects[0]!;
        await fixture.store.beginNewExecutionEpoch();
        await fixture.store.revalidateForResume({ definitionDigest: definition.definitionDigest,
          sealDigest: seal.sealDigest, evidenceSubjectDigest: subject.evidenceSubjectDigest,
          acceptanceMatrixDigest: definition.acceptanceMatrixDigest,
          environmentDigest: definition.environment.environmentDigest, receiptBridgeDigest: state.receiptBridges[0]!.bridgeDigest });
        const envelope = createCohortEffectEnvelopeV1({ definition, observation: fixture.observation,
          intent: fixture.intent, evidenceSubject: subject, executionEpoch: (await fixture.store.snapshot()).runtime.executionEpoch });
        const lease = await fixture.store.acquireLease({ holderId: "renewed-parent", semanticSubject: envelope.semanticSubject });
        await withManagedCohortAuthorityWriterLock(fixture.root, fixture.deps, () =>
          withManagedWorktreeEffectLock(fixture.authorization, fixture.deps, () =>
            retainManagedCohortAuthority(fixture.prepared.handle, { store: fixture.store, lease, envelope }, fixture.deps)));
        await expect(capability.coordinateImplementationCandidate({ ...prepared.prepared, holderId: "stale-parent",
          parentGateCapability })).rejects.toThrow("cohort parent execution grant has expired");
        expect(commands).toHaveLength(0);
        if (capability.renewCohortParentExecution === undefined) throw new Error("trusted parent renewal unavailable");
        parentGateCapability = await capability.renewCohortParentExecution({ workerDispatch: prepared.prepared, cohort: envelope });
        if (kind === "sqlite") {
          await backend.close();
          backend = new SqliteAttestationBackend({ namespace, dbPath: `${fixture.root}/.state/attestation.db` });
          capability = runtime();
          const restored = await backend.transact({ kind: "handle", handle: prepared.prepared }, (store) => store.read(prepared.prepared));
          if (restored?.kind !== "envelope") throw new Error("renewed parent grant was not durable");
          expect(restored.cohortParentExecutionEpoch).toBe(envelope.executionEpoch);
          expect(restored.gitEffectBinding?.cohort).toEqual(cohort);
        }
        if (capability.coordinateImplementationCandidate === undefined) throw new Error("restored coordinator unavailable");
        await expect(capability.coordinateImplementationCandidate({ ...prepared.prepared, holderId: "stale-parent",
          parentGateCapability: prepared.prepared.parentGateCapability })).rejects.toThrow("parent authority is invalid");
        expect(commands).toHaveLength(0);
      }
      if (crash) {
        const transition = fixture.store.transitionLeaseToSuccessor.bind(fixture.store);
        fixture.store.transitionLeaseToSuccessor = (lease, source, successor, publish) => transition(lease, source, successor, (nextLease) => {
          publish(nextLease);
          throw new Error("interrupted after successor registry publication");
        });
        try {
          await expect(capability.coordinateImplementationCandidate({ ...prepared.prepared,
            holderId: "cohort-interrupted-front", parentGateCapability })).rejects.toThrow("interrupted after successor registry publication");
        } finally { fixture.store.transitionLeaseToSuccessor = transition; }
        expect((await fixture.store.snapshot()).runtime.lease?.semanticSubject).toBe(cohorts.runtime.lease!.semanticSubject);
        expect(commands).toHaveLength(0);
        if (epochRecovery) {
          await fixture.store.beginNewExecutionEpoch();
          const source = await backend.transact({ kind: "handle", handle: prepared.handle }, (store) => store.read(prepared.handle));
          if (source?.kind !== "envelope" || source.gitEffectBinding?.cohort === undefined || source.stagedRebaseSourceBinding === undefined) throw new Error("retired cohort source missing");
          const checkpoint = source.stagedRebaseSourceBinding;
          const request = { source: prepared.handle, prior: source.gitEffectBinding,
            guardedRebase: checkpoint.guardedRebase, ontoCommit: checkpoint.ontoCommit, priorResultCommit: checkpoint.sourceResultCommit };
          await expect(prepareManagedCohortRebaseSuccessor(request, fixture.store, fixture.ledger, fixture.deps)).rejects.toThrow("execution epoch");
          const changedPath = join(source.gitEffectBinding.worktreePath, "a.txt");
          const expectedContent = await readFile(changedPath, "utf8");
          await writeFile(changedPath, "unrelated uncommitted edit\n");
          await expect(resumeManagedCohortRebaseSuccessor(request, "explicit-transfer-resume", fixture.store, fixture.ledger, fixture.deps)).rejects.toThrow("exact clean rebased tip");
          expect((await fixture.store.snapshot()).runtime.lease).toBeNull();
          await writeFile(changedPath, expectedContent);
          fixture.store.transitionLeaseToSuccessor = async () => { throw new Error("interrupted after private transfer renewal"); };
          try {
            await expect(resumeManagedCohortRebaseSuccessor(request, "explicit-transfer-resume", fixture.store, fixture.ledger, fixture.deps)).rejects.toThrow("interrupted after private transfer renewal");
          } finally { fixture.store.transitionLeaseToSuccessor = transition; }
          await expect(resolveRetainedManagedCohortAuthority(fixture.root, fixture.store, source.gitEffectBinding.cohort, fixture.deps, false)).rejects.toThrow();
          const resumed = await resumeManagedCohortRebaseSuccessor(request, "explicit-transfer-resume", fixture.store, fixture.ledger, fixture.deps);
          await fixture.store.assertLiveCohortAuthority(resumed.authority.lease, resumed.authority.envelope);
          expect(resumed.authority.envelope.executionEpoch).toBe((await fixture.store.snapshot()).runtime.executionEpoch);
          expect(resumed.bridge.cohort.executionEpoch).toBe(cohort.executionEpoch);
          expect(resumed.authority.envelope.intent.intentDigest).not.toBe(cohort.intent.intentDigest);
          expect((await resumeManagedCohortRebaseSuccessor(request, "explicit-transfer-resume", fixture.store, fixture.ledger, fixture.deps)).binding).toEqual(resumed.binding);
          expect((await fixture.store.snapshot()).portable.candidateIntents).toHaveLength(2);
          await expect(capability.coordinateImplementationCandidate({ partitionKey: qualified.partitionKey, holderId: "expired-parent" })).rejects.toThrow("cohort parent execution grant has expired");
          expect(commands).toHaveLength(0);
          if (capability.resumeCohortRebaseSuccessor === undefined) throw new Error("trusted source checkpoint recovery unavailable");
          await expect(capability.resumeCohortRebaseSuccessor({ source: prepared.handle, guardedRebase: checkpoint.guardedRebase,
            ontoCommit: fixture.baseCommit, priorResultCommit: checkpoint.sourceResultCommit, holderId: "explicit-resume" })).rejects.toThrow("exact retired checkpoint");
          const resumeInput = { source: prepared.handle, guardedRebase: checkpoint.guardedRebase,
            ontoCommit: checkpoint.ontoCommit, priorResultCommit: checkpoint.sourceResultCommit, holderId: "explicit-resume" };
          const advance = await createCohortAdvanceRuntimeV1({ resolved: { backend: "xdg",
            store: fixture.ledger, configRoot: fixture.root, branch: "cq-ledger" },
            promptArtifacts: cohortPromptStore(), managedDeps: fixture.deps, dispatch: capability });
          const tool = createLedgerMcpToolSpecifications(fixture.ledger, undefined, undefined, undefined, undefined,
            capability, undefined, createTrustedWorksetManagementAuthority(), undefined, true, undefined, undefined, advance)
            .find(({ name }) => name === "cohort_advance");
          if (tool === undefined) throw new Error("public cohort recovery tool unavailable");
          const response = await tool.handler({ operation: "rebase-successor", operation_id: resumeInput.holderId,
            rebase: { source_dispatch: resumeInput.source, guarded_rebase: resumeInput.guardedRebase,
              onto_commit: resumeInput.ontoCommit, prior_result_commit: resumeInput.priorResultCommit } }, null);
          const content = response.content[0];
          if (response.isError || content?.type !== "text") throw new Error(JSON.stringify(response));
          resumedSuccessor = JSON.parse(content.text) as Awaited<ReturnType<NonNullable<typeof capability.resumeCohortRebaseSuccessor>>>;
          expect(Object.keys(resumedSuccessor).sort()).toEqual(["source", "state", "successor"]);
          expect(await capability.resumeCohortRebaseSuccessor(resumeInput)).toEqual(resumedSuccessor);
        }
        capability = runtime();
        if (capability.coordinateImplementationCandidate === undefined) throw new Error("cohort restored coordinator unavailable");
      }
      let coordinated = resumedSuccessor ?? await capability.coordinateImplementationCandidate(crash ? { partitionKey: qualified.partitionKey, holderId: "cohort-resumed-front" } : {
        ...prepared.prepared, holderId: "cohort-front", parentGateCapability });
      if (conflict) {
        expect(coordinated.state).toBe("blocked");
        if (coordinated.state !== "blocked") throw new Error("expected parked cohort conflict");
        const partitionKey = coordinated.partitionKey;
        expect(commands).toHaveLength(0);
        const snapshot = await fixture.store.snapshot();
        const sealed = createCohortEffectEnvelopeV1({ definition: cohort.definition, observation: fixture.observation,
          intent: cohort.intent, evidenceSubject: snapshot.portable.evidenceSubjects[0]!, executionEpoch: snapshot.runtime.executionEpoch });
        const retained = await resolveRetainedManagedCohortAuthority(fixture.root, fixture.store, sealed, fixture.deps, true);
        const conflictState = await observeManagedWorktreeConflictState(retained.binding, { ...fixture.deps, cohortAuthority: retained.authority });
        const resolver = await capability.prepare({ roleId: "implement-conflict-resolver", idempotencyKey: "cohort-resolver", timeoutMs: 600_000,
          expectedChild: { childId: `implement-conflict-resolver${CODEX_CORRELATION_SEPARATOR}resolver-child`, runId: "resolver-run" }, input: {
            cohort: sealed, members: cohort.definition.members.map((member) => ({ memberRef: member.memberRef, headline: member.memberRef,
              description: "Preserve the shared correction", acceptance: "Both member intents remain present" })),
            branch: retained.binding.branch, worktreePath: retained.binding.worktreePath, baseCommit: retained.binding.baseCommit,
            validationIntent: "focused-only", conflictingFiles: ["a.txt"], conflictState,
          } as unknown as DispatchJSONValue });
        expect(resolver).toMatchObject({ accepted: true });
        if (!resolver.accepted) throw new Error(JSON.stringify(resolver));
        await capability.fetchInput({ ...resolver.prepared, inputCapability: resolver.prepared.inputCapability });
        const resolution = "integration + cohort correction\n";
        await writeFile(join(retained.binding.worktreePath, "a.txt"), resolution);
        const continued = await capability.gitResolveContinue!({ ...resolver.prepared, gitConflictCapability: resolver.prepared.gitConflictCapability!,
          operationId: "resolve-cohort", expectedState: conflictState,
          resolutions: [{ kind: "regular", path: "a.txt", newState: { mode: "100644", digest: rawDigest(resolution) } }] });
        await capability.storeResult({ ...resolver.prepared, resultCapability: resolver.prepared.resultCapability, output: {
          cohort: sealed, memberObservations: cohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Both changes preserved" })),
          status: "pass", resultCommit: continued.newHead, branch: retained.binding.branch, actualWorktreePath: retained.binding.worktreePath,
          filesResolved: ["a.txt"], conflictReceipts: [continued], checkSummary: "Focused resolution passed", summary: "Shared correction preserved",
          focusedChecks: [{ command: "test member preservation", exitCode: 0, passCount: 2, failCount: 0 }],
        } as unknown as DispatchJSONValue });
        coordinated = await capability.coordinateImplementationCandidate({ partitionKey, holderId: "cohort-resolved-front" });
      }
      if (stale) {
        expect(coordinated.state).toBe("successor-queued");
        if (coordinated.state !== "successor-queued") throw new Error("expected real cohort successor");
        const successor = await backend.transact({ kind: "handle", handle: coordinated.successor }, (store) => store.read(coordinated.successor));
        if (successor?.kind !== "envelope" || successor.gitEffectBinding?.cohort === undefined) throw new Error("successor lost cohort authority");
        expect(successor.gitEffectBinding.cohort.intent.intentDigest).not.toBe(cohort.intent.intentDigest);
        expect(successor.gitEffectBinding.worktreePath).toBe(fixture.prepared.handle.absolutePath);
        expect(successor.gitEffectBinding.guardedRebaseBridge?.version).toBe(2);
        expect(commands).toHaveLength(0);
        expect((await fixture.store.snapshot()).portable.candidateSeals).toHaveLength(1);
        expect((await fixture.store.snapshot()).portable.candidateAttempts.filter((attempt) => attempt.state === "pending")).toHaveLength(2);
        const successorPrepared = successorLaunches[0]!;
        const successorBinding = successor.gitEffectBinding;
        const successorCohort = successorBinding.cohort!;
        const bridge = successorBinding.guardedRebaseBridge!;
        if (row.gitEffectBinding?.cohort === undefined) throw new Error("source cohort binding disappeared");
        const transitionInput = { source: prepared.handle, prior: row.gitEffectBinding, guardedRebase: bridge.guardedRebase,
          ontoCommit: bridge.ontoCommit, priorResultCommit: receipt.newHead };
        const replayed = await prepareManagedCohortRebaseSuccessor(transitionInput, fixture.store, fixture.ledger, fixture.deps);
        expect(replayed.binding.handleFingerprint).toBe(successorBinding.handleFingerprint);
        await expect(prepareManagedCohortRebaseSuccessor({ ...transitionInput, ontoCommit: fixture.baseCommit }, fixture.store, fixture.ledger, fixture.deps)).rejects.toThrow("durable transition intent");
        expect((await fixture.store.snapshot()).portable.candidateIntents).toHaveLength(2);
        await capability.fetchInput({ ...successorPrepared, inputCapability: successorPrepared.inputCapability });
        const correction = conflict ? await capability.gitCommit!({ ...successorPrepared, gitChangeCapability: successorPrepared.gitChangeCapability!,
          ...await cohortChangeRequest({ ...fixture.authorization, ...successorBinding }, "post-conflict", "b", "base b\n", "verified member b\n") }) : undefined;
        await capability.storeResult({ ...successorPrepared, resultCapability: successorPrepared.resultCapability, output: {
          cohort: successorCohort, memberObservations: successorCohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Rebased shared correction" })),
          status: "pass", resultCommit: correction?.newHead ?? bridge.rebasedStartCommit, branch: successorBinding.branch, actualWorktreePath: successorBinding.worktreePath,
          filesTouched: conflict ? ["a.txt", "b.txt"] : ["a.txt"], gitReceipts: correction === undefined ? [] : [correction], checkSummary: "Awaiting successor ladder", summary: "All member edits preserved by rebase",
          gitLineage: { kind: "guarded-rebase", guardedRebase: bridge.guardedRebase, ontoCommit: bridge.ontoCommit, rebasedStartCommit: bridge.rebasedStartCommit,
            exactTip: bridge.exactTip },
          baseVerification: { status: "verified", relation: "descendant", baseCommit: bridge.ontoCommit, headCommit: correction?.newHead ?? bridge.rebasedStartCommit },
        } as unknown as DispatchJSONValue });
        await capability.qualifyImplementationCandidate!({ ...successorPrepared,
          roleId: "implement-worker", correlationId: "cohort-child", childThreadId: "cohort-thread-successor", expectedRunId: "cohort-run",
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
        const final = await capability.coordinateImplementationCandidate({ ...successorPrepared,
          holderId: "cohort-successor-front", parentGateCapability: successorPrepared.parentGateCapability! });
        expect(final.state).toBe("completed");
        expect((await fixture.store.snapshot()).portable.candidateSeals).toHaveLength(2);
        expect(commands).toHaveLength(4);
        const exported = await fixture.store.exportPortableState();
        const restored = createInMemoryWorkCohortStore();
        await restored.restorePortableState(parseWorkCohortPortableStateV1(exported));
        expect((await restored.snapshot()).portable.candidateSeals).toEqual((await fixture.store.snapshot()).portable.candidateSeals);
        return;
      }
      expect(coordinated.state).toBe("completed");
      expect(commands.slice(0, 2).sort()).toEqual(["bun test packages/ledger/test/tasks:T1.test.ts", "bun test packages/ledger/test/tasks:T2.test.ts"]);
      expect(commands.slice(2)).toEqual(["bun test shared.test.ts", "bun run check"]);
      const replay = await capability.coordinateImplementationCandidate({ ...prepared.prepared,
        holderId: "cohort-front", parentGateCapability });
      expect(replay.state).toBe("empty");
      expect(commands).toHaveLength(4);
      expect((await fixture.store.snapshot()).portable.commandEvidence).toHaveLength(4);
      expect((await fixture.store.snapshot()).portable.completionReceipts).toHaveLength(1);
    } finally { await backend.close(); await fixture.close(); }
  }, 30_000);
  }
}
