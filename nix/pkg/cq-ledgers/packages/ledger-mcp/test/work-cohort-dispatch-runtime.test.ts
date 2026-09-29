import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_CORRELATION_SEPARATOR, InMemoryAttestationBackend, InMemoryAttestationStore, SqliteAttestationBackend, implementWorkerSidecar, implementConflictResolverSidecar,
  type AttestationBackend, type DispatchJSONValue, type DispatchPrepared } from "@cq/config";
import { cohortValueDigestV1, createCohortCommandBoundaryV1, createInMemoryImplementationEvidenceStore, resolveRetainedManagedCohortAuthority,
  createCohortEffectEnvelopeV1, observeManagedWorktreeConflictState } from "@cq/ledger";
import { prepareManagedCohortRebaseSuccessor, resumeManagedCohortRebaseSuccessor, parseWorkCohortPortableStateV1, createInMemoryWorkCohortStore,
  workCohortHasPendingSealedCandidateV1 } from "@cq/ledger";
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
  for (const mode of ["initial", "renewed", "revoked-before-result", "final-with-focused", "aborted-after-seal", "stale", "stale-started", "conflict", "crash", "epoch-recovery", "correction", "correction-retry", "correction-fail", "correction-changed", "correction-abandoned", "gate-rejected", "gate-interrupted", "initial-aborted", "branch-switched", "integration-rewritten"] as const) {
  const renewed = mode === "renewed";
  const conflict = mode === "conflict";
  const epochRecovery = mode === "epoch-recovery";
  const crash = mode === "crash" || epochRecovery;
  // D589: the server's driver prepares the successor under a fresh child, as a Claude launch requires.
  const started = mode === "stale-started";
  const stale = mode === "stale" || started || conflict || crash;
  const successorChild = started
    ? { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}successor-child`, runId: "successor-run" }
    : { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}cohort-child`, runId: "cohort-run" };
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
        ...(started
          ? { implementationSuccessorStarter: async ({ prepare }) => {
              const successor = await prepare({ expectedChild: successorChild });
              if (!successor.accepted) return successor;
              successorLaunches.push(successor.prepared);
              return successor;
            } }
          : { implementationSuccessorLauncher: async ({ prepared }) => { successorLaunches.push(prepared); } }),
        cohortCommandRunner: { run: async (request) => {
          commands.push(request.command.argv.join(" "));
          return { executionId: `focused:${commands.length}`, outputDigest: cohortValueDigestV1(request.command),
            gateExitCode: 0, passCount: 1, failCount: 0, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "1 pass" };
        } },
        supervisedWorkerGateRunner: { run: async () => {
          commands.push("bun run check");
          if (mode === "gate-rejected" && commands.filter((command) => command === "bun run check").length === 1) {
            return { gateExitCode: 1, passCount: 2, failCount: 1, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "(fail) contended\n 1 fail" };
          }
          if (mode === "gate-interrupted" && commands.filter((command) => command === "bun run check").length === 1) {
            throw new Error("supervised worker gate exceeded its host execution deadline");
          }
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
      if (mode === "initial-aborted") {
        // D587: the first cohort worker committed through its broker and then
        // died; a correction round continues its exact broker-proven work.
        await capability.abort({ ...prepared.handle, reason: "parent-lost", details: { source: "test" } });
        const ready = await capability.prepareCohortCorrectionSuccessor!({ workerDispatch: prepared.handle });
        expect(ready.input).toMatchObject({ baseCommit: fixture.baseCommit, startingCommit: receipt.newHead, priorResultCommit: receipt.newHead, round: 1 });
        const retryChild = { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}resume-child`, runId: "resume-run" };
        const retry = await capability.prepare({ roleId: "implement-worker", idempotencyKey: "cohort-resume", timeoutMs: 600_000,
          expectedChild: retryChild, input: ready.input as unknown as DispatchJSONValue, reprepareOf: ready.reprepareOf, guardedRebase: ready.guardedRebase });
        expect(retry).toMatchObject({ accepted: true });
        if (!retry.accepted) throw new Error(JSON.stringify(retry));
        const next = retry.prepared;
        await capability.fetchInput({ ...next, inputCapability: next.inputCapability });
        const nextRow = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
        const nextBinding = nextRow?.kind === "envelope" ? nextRow.gitEffectBinding : undefined;
        if (nextBinding?.cohort === undefined || nextBinding.guardedRebaseBridge === undefined) throw new Error("resumed worker lost its bridge");
        const bridge = nextBinding.guardedRebaseBridge;
        const finish = await capability.gitCommit!({ ...next, gitChangeCapability: next.gitChangeCapability!,
          ...await cohortChangeRequest({ ...fixture.authorization, ...nextBinding }, "finish", "b", "base b\n", "finished member b\n") });
        await capability.storeResult({ ...next, resultCapability: next.resultCapability, output: {
          cohort: nextBinding.cohort, memberObservations: nextBinding.cohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Resumed" })),
          status: "pass", resultCommit: finish.newHead, branch: nextBinding.branch, actualWorktreePath: nextBinding.worktreePath,
          filesTouched: ["a.txt", "b.txt"], gitReceipts: [finish], checkSummary: "Awaiting resumed ladder", summary: "Resumed after an abort",
          gitLineage: { kind: "guarded-rebase", guardedRebase: bridge.guardedRebase, ontoCommit: bridge.ontoCommit, rebasedStartCommit: bridge.rebasedStartCommit, exactTip: bridge.exactTip },
          baseVerification: { status: "verified", relation: "descendant", baseCommit: fixture.baseCommit, headCommit: finish.newHead },
        } as unknown as DispatchJSONValue });
        await capability.qualifyImplementationCandidate!({ ...next, roleId: "implement-worker", correlationId: "resume-child",
          childThreadId: "resume-thread", expectedRunId: retryChild.runId,
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
        const resumed = await capability.coordinateImplementationCandidate!({ ...next, holderId: "cohort-resume-front", parentGateCapability: next.parentGateCapability! });
        expect(resumed.state).toBe("completed");
        expect((await fixture.store.snapshot()).portable.candidateSeals).toHaveLength(1);
        return;
      }
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
      if (mode === "final-with-focused") {
        // D592: the parent gate refused this at claim time, after the worker had
        // exited and its candidate was queued; storage now refuses it outright.
        const refused = await capability.storeResult({ ...resultInput, output: { ...(resultInput.output as Record<string, DispatchJSONValue>),
          focusedChecks: [{ command: "bun test a.test.ts", exitCode: 0, passCount: 1, failCount: 0 }] } });
        expect(refused).toMatchObject({ state: "aborted", result: { reason: "invalid-output",
          details: { summary: expect.stringContaining("final validation cannot substitute child-authored focused-only evidence") } } });
        expect(commands).toHaveLength(0);
        return;
      }
      const stored = await capability.storeResult(resultInput);
      expect(stored.state).toBe("gate-pending");
      if (capability.finalizeParentGate === undefined || prepared.prepared.parentGateCapability === undefined) throw new Error("parent gate capability missing");
      await expect(capability.finalizeParentGate({ ...prepared.prepared,
        parentGateCapability: prepared.prepared.parentGateCapability })).rejects.toThrow("cohort acceptance requires the qualified queue-front ladder");
      if (capability.qualifyImplementationCandidate === undefined) throw new Error("cohort qualification missing");
      if (mode === "integration-rewritten") {
        // D602: a recorded integration branch rewritten to unrelated history no
        // longer contains the candidate's base; refuse instead of retargeting.
        await cohortBrokerGit(fixture.root, ["checkout", "-q", "--orphan", "unrelated"]);
        await cohortBrokerGit(fixture.root, ["commit", "-q", "--allow-empty", "-m", "unrelated history"]);
        await cohortBrokerGit(fixture.root, ["branch", "-f", "main", "HEAD"]);
        await expect(capability.qualifyImplementationCandidate({ ...prepared.prepared,
          roleId: "implement-worker", correlationId: "cohort-child", childThreadId: "cohort-thread", expectedRunId: "cohort-run",
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) }))
          .rejects.toThrow("integration ref refs/heads/main does not contain the candidate base");
        return;
      }
      if (mode === "branch-switched") {
        // D602: the primary checkout's live branch is not the integration
        // branch once an operator switches to unrelated history.
        await cohortBrokerGit(fixture.root, ["checkout", "-q", "--orphan", "unrelated"]);
        await cohortBrokerGit(fixture.root, ["commit", "-q", "--allow-empty", "-m", "unrelated history"]);
        const queued = await capability.qualifyImplementationCandidate({ ...prepared.prepared,
          roleId: "implement-worker", correlationId: "cohort-child", childThreadId: "cohort-thread", expectedRunId: "cohort-run",
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
        expect(queued.state).toBe("queued");
        const queuedRow = await backend.transact({ kind: "handle", handle: prepared.handle }, (store) => store.read(prepared.handle));
        // The ref recorded at preparation, not the checkout's live branch.
        expect(queuedRow?.kind === "envelope" ? queuedRow.implementationQueue?.partition.integrationRef : undefined).toBe("refs/heads/main");
        return;
      }
      const qualified = await capability.qualifyImplementationCandidate({ ...prepared.prepared,
        roleId: "implement-worker", correlationId: "cohort-child", childThreadId: "cohort-thread", expectedRunId: "cohort-run",
        outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
      expect(qualified.state).toBe("queued");
      if (qualified.state !== "queued") throw new Error("expected a qualified cohort candidate");
      const cohorts = await fixture.store.snapshot();
      expect(cohorts.portable.candidateSeals).toHaveLength(1);
      expect(cohorts.runtime.lease?.semanticSubject).toBe(cohorts.portable.evidenceSubjects[0]!.evidenceSubjectDigest);
      if (mode === "aborted-after-seal") {
        // D592: a sealed candidate whose only dispatch aborted can never
        // complete, so its seal no longer protects anything; abandonment must
        // release the preparation instead of refusing it forever.
        // The fixture keeps its cohort state beside, not inside, its ledger.
        const ledgerWithCohorts = new Proxy(fixture.ledger, { get: (target, key) => {
          if (key === "workCohortStore") return () => fixture.store;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        } });
        const advance = await createCohortAdvanceRuntimeV1({ resolved: { backend: "xdg",
          store: ledgerWithCohorts, configRoot: fixture.root, branch: "cq-ledger" },
          promptArtifacts: cohortPromptStore(), managedDeps: fixture.deps, dispatch: capability });
        if (advance === undefined) throw new Error("cohort advance runtime unavailable");
        const abandon = { definitionDigest: cohorts.portable.definitions[0]!.definitionDigest,
          intentDigest: cohort.intent.intentDigest, operationId: "abandon-sealed" };
        // D576: production observation requires the members in `wip`.
        for (const taskId of ["T1", "T2"]) await fixture.ledger.updateItem("tasks", taskId, { status: "wip" });
        await expect(advance.releaseAbandonedPreparation(abandon)).rejects.toThrow("owns live evidence");
        await capability.abort({ ...prepared.handle, reason: "native-failure", details: { source: "test" } });
        // D593: the members stay reserved under the id that first reserved them
        // (here the fixture's; in production the original candidate intent),
        // while rebase successors mint new intents. Abandonment releases the
        // definition's active reservation, whichever intent names the attempt.
        const reservationId = (await fixture.store.snapshot()).portable.reservationTransitions[0]!.reservationId;
        expect(reservationId).not.toBe(abandon.intentDigest);
        await advance.releaseAbandonedPreparation(abandon);
        const released = await fixture.store.snapshot();
        expect(released.portable.reservationTransitions.at(-1)).toMatchObject({ reservationId, transition: "released" });
        // D594: after sealing, the lease is re-bound to the evidence subject under a
        // capability no journal retains, and a dead seal still counted as pending.
        // Either left every later cohort unable to acquire authority.
        expect(released.runtime.lease).toBeNull();
        expect(workCohortHasPendingSealedCandidateV1(released.portable)).toBe(false);
        // D576: the release also returns every member it held to the queue.
        expect(["T1", "T2"].map((taskId) => fixture.ledger.fetchItem("tasks", taskId).status)).toEqual(["planned", "planned"]);
        // A repeat after the reservation is already surrendered (production
        // reached that state through an earlier partial abandonment) succeeds.
        await advance.releaseAbandonedPreparation({ ...abandon, operationId: "abandon-sealed-again" });
        expect((await fixture.store.snapshot()).runtime.lease).toBeNull();
        return;
      }
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
      if (mode === "gate-rejected" || mode === "gate-interrupted") {
        // D598: a red queue-front gate leaves the sealed candidate a correction
        // round in its own worktree, like a reviewer's disapproval. D607: so does
        // an interrupted gate, which must terminalize durably as parent-lost.
        await capability.coordinateImplementationCandidate({ ...prepared.prepared, holderId: "cohort-front", parentGateCapability }).catch(() => undefined);
        const rejectedRow = await backend.transact({ kind: "handle", handle: prepared.handle }, (store) => store.read(prepared.handle));
        expect(rejectedRow?.kind === "envelope" ? [rejectedRow.state, rejectedRow.abortReason] : undefined)
          .toEqual(["aborted", mode === "gate-rejected" ? "gate-rejected" : "parent-lost"]);
        if (mode === "gate-interrupted") {
          // D607: the interrupted candidate outlives its execution epoch; an explicit
          // trusted renewal re-grants its parent before the correction round.
          const { retainManagedCohortAuthority, withManagedCohortAuthorityWriterLock, withManagedWorktreeEffectLock } = await import("@cq/ledger");
          const state = (await fixture.store.snapshot()).portable;
          const definition = state.definitions[0]!;
          const subject = state.evidenceSubjects[0]!;
          await fixture.store.beginNewExecutionEpoch();
          await fixture.store.revalidateForResume({ definitionDigest: definition.definitionDigest,
            sealDigest: state.candidateSeals[0]!.sealDigest, evidenceSubjectDigest: subject.evidenceSubjectDigest,
            acceptanceMatrixDigest: definition.acceptanceMatrixDigest,
            environmentDigest: definition.environment.environmentDigest, receiptBridgeDigest: state.receiptBridges[0]!.bridgeDigest });
          const renewed = createCohortEffectEnvelopeV1({ definition, observation: fixture.observation,
            intent: fixture.intent, evidenceSubject: subject, executionEpoch: (await fixture.store.snapshot()).runtime.executionEpoch });
          await expect(capability.prepareCohortCorrectionSuccessor!({ workerDispatch: prepared.handle }))
            .rejects.toThrow("cohort parent execution grant has expired");
          const lease = await fixture.store.acquireLease({ holderId: "renewed-parent", semanticSubject: renewed.semanticSubject });
          await withManagedCohortAuthorityWriterLock(fixture.root, fixture.deps, () =>
            withManagedWorktreeEffectLock(fixture.authorization, fixture.deps, () =>
              retainManagedCohortAuthority(fixture.prepared.handle, { store: fixture.store, lease, envelope: renewed }, fixture.deps)));
          await capability.renewCohortParentExecution!({ workerDispatch: prepared.handle, cohort: renewed });
        }
        const ready = await capability.prepareCohortCorrectionSuccessor!({ workerDispatch: prepared.handle });
        expect(ready.input).toMatchObject({ baseCommit: fixture.baseCommit, startingCommit: receipt.newHead, round: 1 });
        const retryChild = { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}regate-child`, runId: "regate-run" };
        const retry = await capability.prepare({ roleId: "implement-worker", idempotencyKey: "cohort-regate", timeoutMs: 600_000,
          expectedChild: retryChild, input: { ...(ready.input as Record<string, DispatchJSONValue>), priorCriticism: ["unrelated contended gate failure"] },
          reprepareOf: ready.reprepareOf, guardedRebase: ready.guardedRebase });
        expect(retry).toMatchObject({ accepted: true });
        if (!retry.accepted) throw new Error(JSON.stringify(retry));
        const next = retry.prepared;
        await capability.fetchInput({ ...next, inputCapability: next.inputCapability });
        const nextRow = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
        const nextBinding = nextRow?.kind === "envelope" ? nextRow.gitEffectBinding : undefined;
        if (nextBinding?.cohort === undefined || nextBinding.guardedRebaseBridge === undefined) throw new Error("gate correction lost its bridge");
        const bridge = nextBinding.guardedRebaseBridge;
        await capability.storeResult({ ...next, resultCapability: next.resultCapability, output: {
          cohort: nextBinding.cohort, memberObservations: nextBinding.cohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Unchanged" })),
          status: "pass", resultCommit: bridge.rebasedStartCommit, branch: nextBinding.branch, actualWorktreePath: nextBinding.worktreePath,
          filesTouched: ["a.txt"], gitReceipts: [], checkSummary: "A/B-proven unrelated gate failure", summary: "Unchanged candidate re-gated",
          gitLineage: { kind: "guarded-rebase", guardedRebase: bridge.guardedRebase, ontoCommit: bridge.ontoCommit, rebasedStartCommit: bridge.rebasedStartCommit, exactTip: bridge.exactTip },
          baseVerification: { status: "verified", relation: "descendant", baseCommit: fixture.baseCommit, headCommit: bridge.rebasedStartCommit },
        } as unknown as DispatchJSONValue });
        await capability.qualifyImplementationCandidate!({ ...next, roleId: "implement-worker", correlationId: "regate-child",
          childThreadId: "regate-thread", expectedRunId: retryChild.runId,
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
        const regated = await capability.coordinateImplementationCandidate!({ ...next, holderId: "cohort-regate-front", parentGateCapability: next.parentGateCapability! });
        expect(regated.state).toBe("completed");
        expect((await fixture.store.snapshot()).portable.candidateSeals).toHaveLength(2);
        return;
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
        expect(successor.expectedChild).toEqual(successorChild);
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
          roleId: "implement-worker", correlationId: started ? "successor-child" : "cohort-child", childThreadId: "cohort-thread-successor",
          expectedRunId: successorChild.runId,
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
      if (mode === "correction" || mode === "correction-retry" || mode === "correction-fail" || mode === "correction-changed" || mode === "correction-abandoned") {
        // D598: a reviewer disapproved the gate-green candidate; its correction
        // round continues in the same managed worktree under a new intent.
        const tool = createLedgerMcpToolSpecifications(fixture.ledger, undefined, undefined, undefined, undefined,
          capability, undefined, createTrustedWorksetManagementAuthority(), undefined, true, undefined, undefined,
          await createCohortAdvanceRuntimeV1({ resolved: { backend: "xdg", store: fixture.ledger, configRoot: fixture.root, branch: "cq-ledger" },
            promptArtifacts: cohortPromptStore(), managedDeps: fixture.deps, dispatch: capability }))
          .find(({ name }) => name === "cohort_advance");
        if (tool === undefined) throw new Error("public cohort correction tool unavailable");
        const request = { operation: "correction-successor", operation_id: "correct-r1", worker_dispatch: prepared.handle };
        const response = await tool.handler(request, null);
        const content = response.content[0];
        if (response.isError || content?.type !== "text") throw new Error(JSON.stringify(response));
        const ready = JSON.parse(content.text) as { state: string; reprepareOf: typeof prepared.handle; guardedRebase: string;
          input: Record<string, DispatchJSONValue> };
        expect(ready.state).toBe("correction-ready");
        expect(ready.reprepareOf).toEqual(prepared.handle);
        const replayed = await tool.handler({ ...request, operation_id: "correct-r1-replay" }, null);
        expect(replayed.content[0]?.type === "text" ? JSON.parse(replayed.content[0].text) : undefined).toEqual(ready);
        const successorCohortOf = (input: Record<string, DispatchJSONValue>) => input["cohort"] as unknown as typeof cohort;
        const successorCohort = successorCohortOf(ready.input);
        expect(successorCohort.intent.intentDigest).not.toBe(cohort.intent.intentDigest);
        expect(ready.input).toMatchObject({ worktreePath: fixture.prepared.handle.absolutePath, baseCommit: fixture.baseCommit,
          startingCommit: receipt.newHead, priorResultCommit: receipt.newHead, round: 1, validationIntent: "final" });
        let correctionChild = { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}correction-child`, runId: "correction-run" };
        let correlationId = "correction-child";
        const correctionInput = { ...ready.input, priorCriticism: ["member b lacks its focused acceptance"] };
        const successor = await capability.prepare({ roleId: "implement-worker", idempotencyKey: "cohort-correction", timeoutMs: 600_000,
          expectedChild: correctionChild, input: correctionInput, reprepareOf: ready.reprepareOf, guardedRebase: ready.guardedRebase });
        expect(successor).toMatchObject({ accepted: true });
        if (!successor.accepted) throw new Error(JSON.stringify(successor));
        const source = await backend.transact({ kind: "handle", handle: prepared.handle }, (store) => store.read(prepared.handle));
        expect(source?.kind === "envelope" ? source.implementationQueue?.state : "missing").toBe("staged-rebase-retired");
        await expect(capability.prepareCohortCorrectionSuccessor!({ workerDispatch: prepared.handle })).rejects.toThrow("unretired cohort worker");
        let next = successor.prepared;
        await capability.fetchInput({ ...next, inputCapability: next.inputCapability });
        let retryStart = receipt.newHead;
        if (mode === "correction-abandoned") {
          // D608: the reviewed generation stays consumed after its correction retired it; once the
          // correction itself dies, nothing is left to protect and abandonment must release it.
          await capability.abort({ ...next, reason: "native-failure", details: { source: "test-abandoned" } });
          const ledgerWithCohorts = new Proxy(fixture.ledger, { get: (target, key) => {
            if (key === "workCohortStore") return () => fixture.store;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          } });
          const advance = await createCohortAdvanceRuntimeV1({ resolved: { backend: "xdg",
            store: ledgerWithCohorts, configRoot: fixture.root, branch: "cq-ledger" },
            promptArtifacts: cohortPromptStore(), managedDeps: fixture.deps, dispatch: capability });
          if (advance === undefined) throw new Error("cohort advance runtime unavailable");
          for (const taskId of ["T1", "T2"]) await fixture.ledger.updateItem("tasks", taskId, { status: "wip" });
          await advance.releaseAbandonedPreparation({ definitionDigest: (await fixture.store.snapshot()).portable.definitions[0]!.definitionDigest,
            intentDigest: successorCohort.intent.intentDigest, operationId: "abandon-corrected" });
          expect((await fixture.store.snapshot()).runtime.lease).toBeNull();
          expect(["T1", "T2"].map((taskId) => fixture.ledger.fetchItem("tasks", taskId).status)).toEqual(["planned", "planned"]);
          return;
        }
        if (mode === "correction-retry" || mode === "correction-fail" || mode === "correction-changed") {
          // D598: the correction worker failed without a change; a further round
          // continues from the same tip under yet another fresh intent.
          await expect(capability.prepareCohortCorrectionSuccessor!({ workerDispatch: next })).rejects.toThrow("or one failed pre-seal worker");
          if (mode === "correction-retry") {
            await capability.abort({ ...next, reason: "native-failure", details: { source: "test" } });
          } else if (mode === "correction-changed") {
            // D598: the correction committed through its broker, then died; its
            // proven receipts carry the partial work into the next round.
            const abortedRow = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
            const abortedBinding = abortedRow?.kind === "envelope" ? abortedRow.gitEffectBinding : undefined;
            if (abortedBinding?.cohort === undefined) throw new Error("changed correction lost its binding");
            const partial = await capability.gitCommit!({ ...next, gitChangeCapability: next.gitChangeCapability!,
              ...await cohortChangeRequest({ ...fixture.authorization, ...abortedBinding }, "partial", "b", "base b\n", "partial member b\n") });
            retryStart = partial.newHead;
            await capability.abort({ ...next, reason: "native-failure", details: { source: "test-changed" } });
            // An unbrokered commit is not the failed link's own work.
            await writeFile(join(abortedBinding.worktreePath, "b.txt"), "raw member b\n");
            await cohortBrokerGit(abortedBinding.worktreePath, ["commit", "-qam", "raw"]);
            await expect(capability.prepareCohortCorrectionSuccessor!({ workerDispatch: next })).rejects.toThrow("durable broker receipts do not form one complete commit chain");
            await cohortBrokerGit(abortedBinding.worktreePath, ["reset", "-q", "--hard", partial.newHead]);
          } else {
            // D600: a typed refusal whose filesTouched omits the prior round's
            // work settles as a consumed fail and keeps its blockedReason.
            const failedRow = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
            const failedBinding = failedRow?.kind === "envelope" ? failedRow.gitEffectBinding : undefined;
            if (failedBinding?.cohort === undefined || failedBinding.guardedRebaseBridge === undefined) throw new Error("failed correction lost its bridge");
            const failedBridge = failedBinding.guardedRebaseBridge;
            await capability.storeResult({ ...next, resultCapability: next.resultCapability, output: {
              cohort: failedBinding.cohort, memberObservations: failedBinding.cohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Refused" })),
              status: "fail", resultCommit: null, branch: failedBinding.branch, actualWorktreePath: failedBinding.worktreePath,
              filesTouched: [], gitReceipts: [], checkSummary: "No candidate", summary: "Refused the round",
              gitLineage: { kind: "guarded-rebase", guardedRebase: failedBridge.guardedRebase, ontoCommit: failedBridge.ontoCommit,
                rebasedStartCommit: failedBridge.rebasedStartCommit, exactTip: failedBridge.exactTip },
              baseVerification: { status: "verified", relation: "descendant", baseCommit: fixture.baseCommit, headCommit: receipt.newHead },
              blockedReason: "contradictory dispatch",
            } as unknown as DispatchJSONValue });
            await capability.qualifyImplementationCandidate!({ ...next, roleId: "implement-worker", correlationId: "correction-child",
              childThreadId: "correction-thread", expectedRunId: correctionChild.runId,
              outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
            const settled = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
            expect(settled?.kind === "envelope" ? [settled.state, (settled.output as Record<string, unknown>)["blockedReason"]] : undefined)
              .toEqual(["consumed", "contradictory dispatch"]);
          }
          const retryReady = await capability.prepareCohortCorrectionSuccessor!({ workerDispatch: { attestationId: next.attestationId, generation: next.generation } });
          expect(retryReady.reprepareOf).toEqual({ attestationId: next.attestationId, generation: next.generation });
          const retryInput = retryReady.input as Record<string, DispatchJSONValue>;
          expect((retryInput["cohort"] as unknown as typeof cohort).intent.intentDigest).not.toBe(successorCohortOf(ready.input).intent.intentDigest);
          expect(retryInput).toMatchObject({ baseCommit: fixture.baseCommit, startingCommit: retryStart, priorResultCommit: retryStart, round: 2 });
          expect(await capability.prepareCohortCorrectionSuccessor!({ workerDispatch: next })).toEqual(retryReady);
          correctionChild = { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}retry-child`, runId: "retry-run" };
          correlationId = "retry-child";
          const retry = await capability.prepare({ roleId: "implement-worker", idempotencyKey: "cohort-correction-retry", timeoutMs: 600_000,
            expectedChild: correctionChild, input: { ...retryInput, priorCriticism: ["member b lacks its focused acceptance"] },
            reprepareOf: retryReady.reprepareOf, guardedRebase: retryReady.guardedRebase });
          expect(retry).toMatchObject({ accepted: true });
          if (!retry.accepted) throw new Error(JSON.stringify(retry));
          next = retry.prepared;
          await capability.fetchInput({ ...next, inputCapability: next.inputCapability });
        }
        const successorRow = await backend.transact({ kind: "handle", handle: next }, (store) => store.read(next));
        const successorBinding = successorRow?.kind === "envelope" ? successorRow.gitEffectBinding : undefined;
        if (successorBinding?.cohort === undefined || successorBinding.guardedRebaseBridge === undefined) throw new Error("correction successor lost its bridge");
        const bridge = successorBinding.guardedRebaseBridge;
        const fix = await capability.gitCommit!({ ...next, gitChangeCapability: next.gitChangeCapability!,
          ...await cohortChangeRequest({ ...fixture.authorization, ...successorBinding }, "correction", "b",
            mode === "correction-changed" ? "partial member b\n" : "base b\n", "corrected member b\n") });
        await capability.storeResult({ ...next, resultCapability: next.resultCapability, output: {
          cohort: successorBinding.cohort, memberObservations: successorCohort.definition.members.map((member) => ({ memberRef: member.memberRef, observation: "Criticism addressed" })),
          status: "pass", resultCommit: fix.newHead, branch: successorBinding.branch, actualWorktreePath: successorBinding.worktreePath,
          filesTouched: ["a.txt", "b.txt"], gitReceipts: [fix], checkSummary: "Awaiting correction ladder", summary: "Reviewer criticism addressed",
          gitLineage: { kind: "guarded-rebase", guardedRebase: bridge.guardedRebase, ontoCommit: bridge.ontoCommit, rebasedStartCommit: bridge.rebasedStartCommit,
            exactTip: bridge.exactTip },
          baseVerification: { status: "verified", relation: "descendant", baseCommit: fixture.baseCommit, headCommit: fix.newHead },
        } as unknown as DispatchJSONValue });
        await capability.qualifyImplementationCandidate!({ ...next, roleId: "implement-worker", correlationId,
          childThreadId: "correction-thread", expectedRunId: correctionChild.runId,
          outcome: "completed", exitStatus: 0, observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
        const corrected = await capability.coordinateImplementationCandidate!({ ...next, holderId: "cohort-correction-front",
          parentGateCapability: next.parentGateCapability! });
        expect(corrected.state).toBe("completed");
        expect((await fixture.store.snapshot()).portable.candidateSeals).toHaveLength(2);
        return;
      }
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
