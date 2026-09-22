import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  reserveImplementationCompletionLease, releaseImplementationCompletionLease,
  type AttestationBackend, type DispatchHandle, type ImplementWorkerSupervisedGateEvidence,
} from "@cq/config";
import {
  CohortCompletionCoordinatorV1, CohortReviewAuthenticatorV1, CohortG213GateAuthenticatorV1,
  ProtectedCohortCompletionJournalV1, cohortValueDigestV1 as digest, readAuthorizedCohortReviewV1,
  assertCohortCompletionBatchV1, createCohortWorksetEffectAdmissionProvider,
  createNodeSupervisedWorkerCommandRunner, materializeCohortOperatorAction, recordOperatorActionEvidence,
  operatorActionRevision, requireWorksetStore, resolveRetainedManagedCohortAuthority, ledgerItemRevisionV1,
  parseGoalFinalizedManifest,
  releaseCompletedManagedCohortWorktree,
  nodeManagedWorktreeGitRunner, validateCohortExecutionBindingV1,
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS, SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  createCohortActivityV1,
  type CohortCompletionBatchV1, type CohortCompletionCapabilityV1,
  type CohortCompletionHostV1, type CohortDeploymentIdentityV1, type CohortDeploymentProbeReceiptV1,
  type CohortEffectEnvelopeV1, type CohortReviewRoleContractV1, type CohortReviewReceiptV1, type ManagedCohortWorktreeAuthority,
  type ResolvedLedgerStore, type WorkCohortStore,
  type ManagedWorktreeFaultInjector,
  cohortEffectTargetRefV1, runWorksetGitEffectGate, settleProcessGroups, settleWorktreeGateCommands, type MergeEffectBinding,
} from "@cq/ledger";
import { implementationEvidenceBuildCommit } from "./buildProvenance.js";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

export interface CohortCompletionRuntimeOptionsV1 {
  readonly resolved: ResolvedLedgerStore;
  readonly backend: AttestationBackend;
  readonly promptArtifacts: PromptArtifactStore;
  readonly cancellationSignal: AbortSignal;
  readonly stateDir?: string;
  readonly trustedSourceWorkspaceBuildCommit?: string;
  readonly trustedSourceWorkspaceArtifactIdentity?: string;
  readonly managedWorktreeFaultInjector?: ManagedWorktreeFaultInjector;
}

class CohortDeploymentRequiredError extends Error {
  constructor(readonly operatorActionRef: string) { super(`cohort deployment requires ${operatorActionRef}`); }
}

function reviewerRole(artifacts: PromptArtifactStore): CohortReviewRoleContractV1 {
  const role = artifacts.readRole("implement-reviewer").metadata;
  const manifest = artifacts.readManifest();
  if (role.schemaVersion === undefined || role.schemaVersion === null || role.schemaDigest === undefined ||
      role.schemaDigest === null || role.promptDigest === undefined || role.promptSurface === undefined || manifest.catalogHash === undefined) {
    throw new Error("cohort review requires an attested installed reviewer contract");
  }
  return { version: role.schemaVersion, schemaDigest: role.schemaDigest, promptDigest: role.promptDigest,
    surface: role.promptSurface, catalogHash: manifest.catalogHash };
}

async function acceptedCandidate(cohorts: WorkCohortStore, backend: AttestationBackend, envelope: CohortEffectEnvelopeV1) {
  if (envelope.state !== "sealed") throw new Error("completion requires a sealed cohort");
  const state = (await cohorts.snapshot()).portable;
  const seal = state.candidateSeals.find((entry) => entry.sealDigest === envelope.evidenceSubject.sealDigest);
  const acceptance = state.completionReceipts.find((entry) => entry.evidenceSubjectDigest === envelope.evidenceSubject.evidenceSubjectDigest);
  const attempt = state.candidateAttempts.find((entry) => entry.candidateAttemptDigest === seal?.candidateAttemptDigest);
  const matrix = state.frozenMatrices.find((entry) => entry.matrixDigest === envelope.definition.acceptanceMatrixDigest);
  if (seal === undefined || acceptance === undefined || attempt?.state !== "staged" || matrix === undefined) {
    throw new Error("completion lacks durable all-member focused/shared/full-gate acceptance");
  }
  const candidate = { definition: envelope.definition, seal, attempt, matrix,
    evidenceSubjectDigest: envelope.evidenceSubject.evidenceSubjectDigest };
  let gate: ImplementWorkerSupervisedGateEvidence | null = null;
  for (const evidenceDigest of [...acceptance.focusedEvidenceDigests, acceptance.sharedRegressionEvidenceDigest, acceptance.fullGateEvidenceDigest]) {
    const evidence = state.commandEvidence.find((entry) => entry.evidenceDigest === evidenceDigest);
    if (evidence === undefined || !evidence.passed || evidence.execution === null) throw new Error("completion rejects unprotected acceptance evidence");
    validateCohortExecutionBindingV1(evidence.execution, candidate);
    if (evidence.evidenceKind === "full-gate") {
      const receipt = evidence.execution.canonicalGate;
      if (receipt === null) throw new Error("completion lacks authenticated canonical gate");
      await backend.transact({ kind: "namespace" }, (store) => new CohortG213GateAuthenticatorV1(store).revalidate(attempt, seal, receipt));
      gate = receipt.gate;
    }
  }
  if (gate === null) throw new Error("completion lacks its authenticated full gate");
  return { candidate, acceptance, gate };
}

export function createCohortCompletionRuntimeV1(options: CohortCompletionRuntimeOptionsV1): CohortCompletionCapabilityV1 | undefined {
  const { resolved, backend } = options;
  if (resolved.backend !== "xdg" || resolved.implementationEvidenceStore === undefined || resolved.store.workCohortStore === undefined) return undefined;
  const ledger = resolved.store;
  const cohorts = resolved.store.workCohortStore();
  const journal = new ProtectedCohortCompletionJournalV1(resolved.implementationEvidenceStore);
  const repositoryRoot = resolved.configRoot;
  const managerDeps = { ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.managedWorktreeFaultInjector === undefined ? {} : { faultInjector: options.managedWorktreeFaultInjector }) };
  const workset = requireWorksetStore(ledger);
  const commands = createNodeSupervisedWorkerCommandRunner({ settleProcessGroups, settleWorktreeGateCommands });
  const now = () => new Date().toISOString();
  const retained = (envelope: CohortEffectEnvelopeV1) => resolveRetainedManagedCohortAuthority(repositoryRoot, cohorts, envelope, managerDeps, false);
  const git = async (args: readonly string[]) => {
    const result = await nodeManagedWorktreeGitRunner(repositoryRoot, args);
    if (result.code !== 0) throw new Error(`cohort completion Git observation failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const build = async () => {
    const startupBuildCommit = implementationEvidenceBuildCommit(options.trustedSourceWorkspaceBuildCommit);
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const packagePath = /^\/nix\/store\/[^/]+/u.exec(modulePath)?.[0];
    const artifact = packagePath ?? options.trustedSourceWorkspaceArtifactIdentity;
    if (artifact === undefined || artifact.length === 0) throw new Error("cohort deployment lacks an authenticated immutable runtime artifact identity");
    return { startupBuildCommit, packagedBuildDigest: digest({ startupBuildCommit, artifact }) };
  };
  const status = async ({ operationId }: { readonly operationId: string }) => ({ executor: "local-xdg" as const,
    handoff: (await cohorts.snapshot()).portable.completionHandoffs.findLast((entry) => entry.operationId === operationId) ?? null });
  const authenticateReview = async (reviewerDispatch: DispatchHandle, envelope: CohortEffectEnvelopeV1, resultCommit: string,
    gateEvidence: ImplementWorkerSupervisedGateEvidence, recording: CohortReviewReceiptV1["recording"]) =>
    backend.transact({ kind: "namespace" }, (store) => new CohortReviewAuthenticatorV1(store).authenticate({
      reviewerDispatch, envelope, resultCommit, gateEvidence, recording, role: reviewerRole(options.promptArtifacts) }));

  function host(authority: ManagedCohortWorktreeAuthority | null): CohortCompletionHostV1 {
    const requireAuthority = () => {
      if (authority === null) throw new Error("terminal completion replay has no live effect authority");
      return authority;
    };
    const assertLive = () => { const live = requireAuthority(); return cohorts.assertLiveCohortAuthority(live.lease, live.envelope); };
    const assertEffectMembers = async (batch: CohortCompletionBatchV1) => {
      await assertLive();
      for (const member of batch.envelope.memberAuthorities) {
        const task = ledger.fetchItem("tasks", member.taskRef.slice("tasks:".length));
        const goal = ledger.fetchItem("goals", member.goalRef.slice("goals:".length));
        const manifest = parseGoalFinalizedManifest(goal);
        if (task.status !== "wip" || digest({ ref: member.taskRef, item: task }) !== member.taskRevision ||
            task.fields["worksetOwnerRef"] !== member.goalRef || task.fields["worksetOwnerEdgeKind"] !== "finalized-manifest" ||
            manifest === null || digest({ goalRef: member.goalRef, manifest }) !== member.finalizedManifestDigest ||
            !manifest.tasks.some(({ id }) => id === task.id)) throw new Error(`cohort effect member authority changed for ${member.taskRef}`);
      }
    };
    const provider = { acquire: (input: Parameters<ReturnType<typeof createCohortWorksetEffectAdmissionProvider>["acquire"]>[0]) =>
      createCohortWorksetEffectAdmissionProvider(requireAuthority(), workset).acquire(input) };
    const withPrimaryAdmission = async <T>(batch: CohortCompletionBatchV1, effect: () => Promise<T>): Promise<T> => {
      await assertLive();
      const admission = await workset.admitLedgerMutation({ kind: "owned-write", targets: batch.members.map(({ taskRef }) => taskRef) });
      try { await assertLive(); return await effect(); } finally { await admission.acknowledge(); }
    };
    const queueCompletion = async (batch: CohortCompletionBatchV1, release: boolean) => {
      const { candidate } = await acceptedCandidate(cohorts, backend, batch.envelope);
      const record = await journal.read(batch);
      await backend.transact({ kind: "namespace" }, (store) => {
        const row = store.read(candidate.attempt.preparedDispatch);
        if (row === undefined || row.kind !== "envelope" || row.implementationQueue === undefined) throw new Error("cohort completion queue row disappeared");
        const queue = row.implementationQueue;
        const detail = { batchDigest: batch.batchDigest, sealDigest: batch.acceptance.sealDigest, completionRef: record.completionRef };
        if (release && queue.state === "released" && queue.terminal?.detailsDigest === digest(detail)) return;
        if (queue.state !== "leased" || queue.lease === undefined || queue.qualification === undefined) throw new Error("cohort completion requires its retained queue-front lease");
        const request = { namespace: backend.namespace, actor: "trusted-parent" as const,
          attestationId: row.attestationId, generation: row.generation, partitionKey: queue.partition.partitionKey,
          enrollmentId: queue.enrollment.enrollmentId, attemptId: queue.attempt.attemptId,
          holderId: queue.lease.holderId, leaseGeneration: queue.lease.generation, expectedPartitionRevision: queue.partitionRevision,
          operationId: `cohort-completion-${batch.batchDigest}`, cohort: { envelope: batch.envelope,
            batchDigest: batch.batchDigest, sealDigest: batch.acceptance.sealDigest, memberRefs: batch.members.map(({ taskRef }) => taskRef) },
          completionRef: record.completionRef, mergeOperationId: record.mergeOperationId, resultCommit: batch.resultCommit,
          qualificationDigest: queue.qualification.qualificationDigest, detail };
        if (release) releaseImplementationCompletionLease(request, { store, now });
        else reserveImplementationCompletionLease(request, { store, now });
      });
    };
    return {
      withPrimaryAdmission,
      authenticateReviews: async (batch) => {
        const accepted = await acceptedCandidate(cohorts, backend, batch.envelope);
        if (digest(accepted.acceptance) !== digest(batch.acceptance)) throw new Error("completion acceptance changed");
        for (const receipt of await journal.reviews(batch)) {
          const current = readAuthorizedCohortReviewV1(await authenticateReview(receipt.reviewerDispatch, receipt.envelope, batch.resultCommit, accepted.gate, receipt.recording));
          if (digest(current) !== digest(receipt)) throw new Error("retained cohort review differs from its consumed dispatch");
        }
      },
      authenticateHandoff: async (batch, handoff) => {
        if (handoff.phase === "prepared") return;
        const record = await journal.read(batch);
        if (record.mergeReceiptDigest === null || record.mergeReceiptDigest !== handoff.mergeReceiptDigest) throw new Error("cohort handoff lacks its protected merge journal");
        if (handoff.phase === "released") {
          if (record.state !== "released" || record.ledgerResult === null) throw new Error("cohort terminal replay lacks completed protected journal settlement");
          const { candidate } = await acceptedCandidate(cohorts, backend, batch.envelope);
          await backend.transact({ kind: "namespace" }, (store) => {
            const row = store.read(candidate.attempt.preparedDispatch);
            const detail = { batchDigest: batch.batchDigest, sealDigest: batch.acceptance.sealDigest, completionRef: record.completionRef };
            if (row === undefined || row.kind !== "envelope" || row.implementationQueue?.state !== "released" ||
                row.implementationQueue.terminal?.detailsDigest !== digest(detail)) throw new Error("cohort terminal replay lacks exact released queue evidence");
          });
        }
        await git(["merge-base", "--is-ancestor", batch.resultCommit, "HEAD"]);
        if (handoff.deployment !== null && !record.deployments.some((entry) => digest(entry) === digest(handoff.deployment))) throw new Error("cohort handoff substituted its deployment identity");
        for (const probe of handoff.probes) if (!record.probes.some((entry) => digest(entry) === digest(probe))) throw new Error("cohort handoff lacks its protected probe receipt");
        if (record.ledgerResult !== null && handoff.ledgerResult !== null && digest(record.ledgerResult) !== digest(handoff.ledgerResult)) throw new Error("cohort handoff substituted its recorded result");
      },
      merge: async (batch) => {
        await assertEffectMembers(batch);
        const head = await git(["rev-parse", "HEAD"]);
        if ((await git(["status", "--porcelain"])).length !== 0) throw new Error("cohort integration worktree is not clean");
        let record = await journal.prepare(batch, head);
        if (record.state !== "merged") {
          await queueCompletion(batch, false);
          await journal.mergeStarted(batch, head);
          const expected: MergeEffectBinding = { kind: "merge", targetRef: cohortEffectTargetRefV1(batch.envelope),
            repositoryRoot, cohort: batch.envelope, commit: batch.resultCommit, completionRef: record.completionRef,
            mergeOperationId: record.mergeOperationId };
          const result = await runWorksetGitEffectGate({ expected, provider, resolve: async () => {
            await assertEffectMembers(batch);
            await journal.mergeStarted(batch, await git(["rev-parse", "HEAD"]));
            return expected;
          } });
          if (result.code !== 0) throw new Error(`guarded cohort ff-only merge failed: ${result.stderr}`);
          record = await journal.merged(batch, await git(["rev-parse", "HEAD"]));
        }
        if (record.mergeReceiptDigest === null) throw new Error("cohort merge receipt is absent");
        return { sealDigest: batch.acceptance.sealDigest, resultCommit: batch.resultCommit, receiptDigest: record.mergeReceiptDigest };
      },
      deployment: async (batch) => {
        if (batch.deploymentPlan === null) return null;
        await assertEffectMembers(batch);
        const action = (await withPrimaryAdmission(batch, async () => materializeCohortOperatorAction(ledger, await journal.authorizeDeployment(batch)))).action;
        const operatorActionRef = `operatorActions:${action.id}`;
        if (action.status !== "acknowledged" && action.status !== "verified") throw new CohortDeploymentRequiredError(operatorActionRef);
        const current = await build();
        if (current.startupBuildCommit !== batch.resultCommit || action.fields["acknowledgedOutputIdentity"] !== digest(batch.deploymentPlan.packagedBuildIdentity)) throw new CohortDeploymentRequiredError(operatorActionRef);
        const epoch = action.fields["acknowledgementEpoch"];
        if (typeof epoch !== "string" || epoch.length === 0) throw new Error("cohort operator acknowledgement lacks its epoch");
        const identity: CohortDeploymentIdentityV1 = { ...current, operatorActionRef, deploymentClass: batch.deploymentPlan.deploymentClass,
          probeEpoch: digest({ sealDigest: batch.acceptance.sealDigest, acknowledgementEpoch: epoch, ...current }) };
        await journal.deployment(batch, identity);
        return identity;
      },
      probe: async (batch, deployment, taskRef) => {
        await assertEffectMembers(batch);
        const current = await build();
        if (current.startupBuildCommit !== deployment.startupBuildCommit || current.packagedBuildDigest !== deployment.packagedBuildDigest) throw new Error("cohort deployment changed before its member probe");
        const plan = batch.deploymentPlan;
        if (plan === null) throw new Error("cohort member has no deployment plan");
        const command = plan.members.find((entry) => entry.taskRef === taskRef);
        if (command === undefined) throw new Error("cohort member has no explicit deployment smoke command");
        const result = await commands.run({ worktreePath: repositoryRoot, command,
          admissionTimeoutMs: SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS, executionTimeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
          cancellationSignal: options.cancellationSignal, effectAdmission: { provider, targetRef: cohortEffectTargetRefV1(batch.envelope) } });
        const actionId = deployment.operatorActionRef.slice("operatorActions:".length);
        const action = ledger.fetchItem("operatorActions", actionId);
        if (action.status === "acknowledged") await withPrimaryAdmission(batch, () => recordOperatorActionEvidence(ledger, actionId, operatorActionRevision(action), {
          command: JSON.stringify(command), stdout: result.outputTail, stderr: "", exitCode: result.gateExitCode,
          outputIdentity: digest(plan.packagedBuildIdentity), observedAt: result.capturedAt,
        }, { author: batch.author, session: batch.session }));
        else if (action.status !== "verified") throw new CohortDeploymentRequiredError(deployment.operatorActionRef);
        const payload = { taskRef, sealDigest: batch.acceptance.sealDigest, packagedBuildDigest: current.packagedBuildDigest,
          startupBuildCommit: current.startupBuildCommit, probeEpoch: deployment.probeEpoch, passed: result.gateExitCode === 0,
          command, execution: { executionId: result.executionId, outputDigest: result.outputDigest,
            outputTail: result.outputTail, capturedAt: result.capturedAt, exitCode: result.gateExitCode } };
        const probe: CohortDeploymentProbeReceiptV1 = { ...payload, receiptDigest: digest(payload) };
        await journal.probe(batch, probe);
        return probe;
      },
      operatorSettlement: async (batch, handoff) => {
        if (batch.deploymentPlan === null) return null;
        if (handoff.deployment === null) throw new Error("cohort operator settlement lacks its deployment identity");
        const current = await build();
        if (current.startupBuildCommit !== handoff.deployment.startupBuildCommit ||
            current.packagedBuildDigest !== handoff.deployment.packagedBuildDigest) throw new Error("cohort deployment changed before primary recording");
        const deployed = await materializeCohortOperatorAction(ledger, await journal.authorizeDeployment(batch));
        if (deployed.state !== "existing" || deployed.action.status !== "verified" ||
            handoff.deployment.operatorActionRef !== `operatorActions:${deployed.action.id}` ||
            handoff.probes.length !== batch.members.length || handoff.probes.some((probe) => !probe.passed ||
              probe.probeEpoch !== handoff.deployment!.probeEpoch)) throw new Error("cohort operator settlement lacks verified all-member deployment");
        return { actionId: deployed.action.id, actionRevision: ledgerItemRevisionV1(`operatorActions:${deployed.action.id}`, deployed.action),
          handoffId: deployed.handoff.id, handoffRevision: ledgerItemRevisionV1(`handoffs:${deployed.handoff.id}`, deployed.handoff) };
      },
      settle: async (batch, result) => {
        await assertLive();
        await journal.ledgerRecorded(batch, result);
        await queueCompletion(batch, true);
        await journal.released(batch);
      },
    };
  }
  return {
    status,
    recordReview: async (value) => {
      const input = structuredClone(value);
      const { authority } = await retained(input.envelope);
      const { candidate, gate } = await acceptedCandidate(cohorts, backend, input.envelope);
      let authenticated: Awaited<ReturnType<typeof authenticateReview>>;
      try {
        authenticated = await authenticateReview(input.reviewerDispatch, input.envelope, candidate.seal.resultCommit, gate,
          { operationId: input.operationId, author: input.author, session: input.session });
      } catch (error) {
        await cohorts.recordActivity(createCohortActivityV1({ semanticSubject: input.envelope.semanticSubject,
          executionEpoch: input.envelope.executionEpoch, executions: [], measurements: [{ measurement: "reviewRejections", value: 1 }] }));
        throw error;
      }
      const admission = await workset.admitLedgerMutation({ kind: "owned-write", targets: input.envelope.memberAuthorities.map(({ taskRef }) => taskRef) });
      try {
        await cohorts.assertLiveCohortAuthority(authority.lease, authority.envelope);
        const receipt = await journal.recordReview(authenticated);
        await cohorts.recordActivity(createCohortActivityV1({ semanticSubject: input.envelope.semanticSubject,
          executionEpoch: input.envelope.executionEpoch, executions: [{ purpose: "review", executionId: receipt.reviewRef }], measurements: [] }));
        return { reviewRef: receipt.reviewRef, memberRefs: receipt.memberObservations.map(({ memberRef }) => memberRef) };
      } finally { await admission.acknowledge(); }
    },
    complete: async ({ batch: value }) => {
      const batch = structuredClone(value);
      assertCohortCompletionBatchV1(batch);
      const prior = (await status({ operationId: batch.operationId })).handoff;
      const authority = prior?.phase === "released" ? null : (await retained(batch.envelope)).authority;
      try {
        const coordinator = new CohortCompletionCoordinatorV1(cohorts, ledger, host(authority));
        const handoff = await coordinator.run(batch, authority === null ? null : authority.lease);
        const release = await releaseCompletedManagedCohortWorktree({ repositoryRoot, ledger,
          authority: await coordinator.authorizeTerminalRelease(batch) }, managerDeps);
        if (release.status !== "released") throw new Error(`cohort completion cleanup pending (${release.reason}): ${release.detail}`);
        return { state: "complete", handoff };
      } catch (error) {
        if (!(error instanceof CohortDeploymentRequiredError)) throw error;
        const handoff = (await status({ operationId: batch.operationId })).handoff;
        if (handoff === null) throw new Error("cohort deployment request lacks its durable merged handoff");
        return { state: "deployment-required", operatorActionRef: error.operatorActionRef, handoff };
      }
    },
  };
}
