import { describe, expect, test } from "bun:test";
import { CohortCompletionCoordinatorV1, createCohortCompletionBatchV1, createCohortCompletionHandoffV1,
  readAuthorizedCohortCompletionHandoffV1, type CohortCompletionBatchV1, type CohortCompletionHandoffV1,
  type CohortCompletionHostV1, type CohortDeploymentIdentityV1, type CohortDeploymentProbeV1 } from "../src/workCohortCompletion.js";
import type { LedgerStore } from "../src/store/LedgerStore.js";
import type { PlanLifecycleStore } from "../src/planLifecycle.js";
import type { WorksetOwnedWriteTx } from "../src/worksetOwnedLifecycle.js";
import type { OwnedMutationContext } from "../src/store/directOwnedMutation.js";
import type { DirectOwnedMutation, DirectOwnedWriteTx } from "../src/store/directOwnedMutation.js";
import { createWorksetOwnedGuardedLedger } from "../src/worksetOwnedLifecycle.js";
import { createTrustedWorksetManagementAuthority } from "../src/worksetInvocationAuthority.js";
import { cohortValueDigestV1, createCohortEffectEnvelopeV1 } from "../src/workCohort.js";
import { parseGoalFinalizedManifest } from "../src/worksetGraph.js";
import { observationFor, sha256 } from "./workCohortFixture.js";
import { prepareWorkCohortStore, workCohortStoreFixtureFromObservation } from "./workCohortStoreContract.js";
import { recordFixtureCohortAcceptance } from "./workCohortAcceptanceFixture.js";
import { ledgerItemRevisionV1 } from "../src/itemRevision.js";
import { createInMemoryWorkCohortStore } from "../src/workCohortStore.js";
import { readCohortAdvanceStatusV1 } from "../src/workCohortAdvance.js";

type CompletionLedger = LedgerStore & PlanLifecycleStore & {
  runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T, context: OwnedMutationContext): Promise<T>;
};

export async function prepareCohortPrimaryFixture(store: LedgerStore) {
  const primary = store as CompletionLedger;
  if (primary.worksetStore === undefined) throw new Error("completion fixture requires primary workset store");
  const provenance = { author: "cohort-contract", session: "T6562" };
  try { primary.fetchItem("goals", "G1"); }
  catch { await primary.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "cohort", description: "cohort" } }); }
  const claimed = await primary.claimPlan({ goalId: "G1", purpose: "initial", claimRequestId: "cohort-claim",
    ownerFenceToken: "cohort-completion-fence-123456789", expectedGeneration: null, ...provenance });
  if (!claimed.ok) throw new Error(claimed.conflict.code);
  const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: claimed.acknowledgement.generation,
    ownerFenceToken: claimed.acknowledgement.ownerFenceToken, ...provenance };
  const published = await primary.publishPlanDraft({ ...identity, operationId: "publish", manifest: {
    milestones: [{ key: "delivery", title: "delivery" }],
    tasks: ["one", "two"].map((key) => ({ key, milestoneKey: "delivery", headline: key })),
  } });
  if (!published.ok) throw new Error(published.conflict.code);
  const guarded = createWorksetOwnedGuardedLedger({ rawStore: primary, worksetStore: primary.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => primary.runAtomicOwnedMutation(mutate, context) });
  const review = await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
    ledgerId: "reviews", status: "go-ahead", fields: { summary: "plan accepted", planDraft: JSON.stringify({ goalId: "G1",
      claimId: identity.claimId, generation: identity.generation, revision: published.acknowledgement.manifest.revision }) }, ...provenance,
  } });
  const finalized = await primary.finalizePlan({ ...identity, operationId: "finalize", reviewId: review.child.id,
    draftRevision: published.acknowledgement.manifest.revision, decision: { headline: "proceed" } });
  if (!finalized.ok) throw new Error(finalized.conflict.code);
  await primary.updateItem("goals", "G1", { status: "building" });
  const taskIds = published.acknowledgement.manifest.tasks.map(({ id }) => id);
  for (const id of taskIds) await primary.updateItem("tasks", id, { status: "wip", fields: { ledgerRefs: ["goals:G1", "defects:D1", "defects:D2"] } });
  await primary.createItem("defects", "M-AMBIENT", { id: "D1", status: "root-caused", fields: {
    headline: "fully covered", severity: "high", dependsOn: taskIds.map((id) => `tasks:${id}`),
  } });
  await primary.createItem("tasks", "M-AMBIENT", { id: "T900", status: "wip", fields: { headline: "external fix", ledgerRefs: ["defects:D2"] } });
  await primary.createItem("defects", "M-AMBIENT", { id: "D2", status: "root-caused", fields: {
    headline: "external owner remains", severity: "high", dependsOn: [...taskIds.map((id) => `tasks:${id}`), "tasks:T900"],
  } });
  const manifest = parseGoalFinalizedManifest(primary.fetchItem("goals", "G1"));
  if (manifest === null) throw new Error("fixture finalized manifest missing");
  return { primary, provenance, taskIds, manifest };
}

async function prepare(store: LedgerStore) {
  const { primary, provenance, taskIds, manifest } = await prepareCohortPrimaryFixture(store);
  const observation = await observationFor(taskIds.map((id) => ({ ref: `tasks:${id}`,
    revision: cohortValueDigestV1({ ref: `tasks:${id}`, item: primary.fetchItem("tasks", id) }) })), {
    manifestRevision: cohortValueDigestV1({ goalRef: "goals:G1", manifest }),
  });
  const fixture = await workCohortStoreFixtureFromObservation(observation, "completion", 1);
  const cohorts = primary.workCohortStore === undefined ? createInMemoryWorkCohortStore() : primary.workCohortStore();
  await prepareWorkCohortStore(cohorts, fixture);
  const sealed = await cohorts.sealCandidate("seal", fixture.request);
  await recordFixtureCohortAcceptance(cohorts, sealed.evidenceSubject.evidenceSubjectDigest);
  const acceptance = await cohorts.finalize("accept", { definitionDigest: fixture.definition.definitionDigest,
    evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest });
  const envelope = createCohortEffectEnvelopeV1({ definition: fixture.definition, observation, intent: fixture.pending.intent,
    evidenceSubject: sealed.evidenceSubject, executionEpoch: (await cohorts.snapshot()).runtime.executionEpoch });
  if (envelope.state !== "sealed") throw new Error("fixture envelope is not sealed");
  const lease = await cohorts.acquireLease({ holderId: "completion", semanticSubject: envelope.semanticSubject });
  const atom = (await cohorts.snapshot()).portable.commonAtoms.find(({ atomDigest }) => atomDigest === fixture.definition.selectedAtomDigest);
  if (atom === undefined) throw new Error("fixture common atom missing");
  const batch = createCohortCompletionBatchV1({ operationId: "complete", envelope, acceptance,
    resultCommit: fixture.request.resultCommit, members: taskIds.map((id) => ({ taskRef: `tasks:${id}`, completion: `completed ${id}`,
      reviewAttemptRefs: [`review-attempt:${id}`], logPaths: [`logs/${id}.md`] })),
    deploymentPlan: { kind: "cq-cohort-deployment-plan", version: 1, deploymentClass: atom.deploymentClass.digest,
      packagedBuildIdentity: { packageIdentity: "cq", sourceCommit: fixture.request.resultCommit },
      members: taskIds.map((id) => ({ taskRef: `tasks:${id}`, argv: ["cq", "status"], cwd: ".", environment: {} })) },
    sweep: { archiveCompletedMembers: false, terminalItems: [], milestones: [], summary: "cohort delivery" }, ...provenance });
  return { primary, cohorts, lease, batch, taskIds, milestoneId: manifest.milestones[0]!.id,
    deploymentClass: atom.deploymentClass.digest, observation, intent: fixture.pending.intent };
}

export { prepare as prepareCohortCompletionFixture };

class CompletionHost implements CohortCompletionHostV1 {
  merges = 0;
  probeRefs: string[] = [];
  failRef: string | null = null;
  settleFailure = false;
  build = "build-one";
  primaryAdmissionActive = false;
  primaryAdmissionCount = 0;
  afterProbes: (() => Promise<void>) | null = null;
  readonly issuedProbes = new Map<string, CohortDeploymentProbeV1>();
  constructor(readonly deploymentClass: string) {}
  async authenticateReviews(): Promise<void> {}
  async operatorSettlement(): Promise<null> { return null; }
  async withPrimaryAdmission<T>(_batch: CohortCompletionBatchV1, effect: () => Promise<T>): Promise<T> {
    if (this.primaryAdmissionActive) throw new Error("nested primary completion admission");
    this.primaryAdmissionActive = true;
    this.primaryAdmissionCount++;
    try { return await effect(); }
    finally { this.primaryAdmissionActive = false; }
  }
  async authenticateHandoff(_batch: CohortCompletionBatchV1, handoff: CohortCompletionHandoffV1): Promise<void> {
    if (handoff.phase !== "prepared" && (this.merges === 0 || handoff.mergeReceiptDigest !== sha256("merge"))) throw new Error("unauthenticated retained merge");
    for (const probe of handoff.probes) {
      const issued = this.issuedProbes.get(probe.receiptDigest);
      if (issued === undefined || cohortValueDigestV1(issued) !== cohortValueDigestV1(probe)) throw new Error("unauthenticated retained deployment probe");
    }
  }
  async merge(batch: CohortCompletionBatchV1) {
    this.merges++;
    return { sealDigest: batch.acceptance.sealDigest, resultCommit: batch.resultCommit, receiptDigest: sha256("merge") };
  }
  async deployment(batch: CohortCompletionBatchV1): Promise<CohortDeploymentIdentityV1> {
    return { deploymentClass: this.deploymentClass, operatorActionRef: "operatorActions:OA1", packagedBuildDigest: sha256(this.build),
      startupBuildCommit: batch.resultCommit, probeEpoch: this.build };
  }
  async probe(batch: CohortCompletionBatchV1, deployment: CohortDeploymentIdentityV1, taskRef: string) {
    this.probeRefs.push(taskRef);
    if (taskRef === batch.members.at(-1)!.taskRef && this.afterProbes !== null) await this.afterProbes();
    const probe = { taskRef, sealDigest: batch.acceptance.sealDigest, packagedBuildDigest: deployment.packagedBuildDigest,
      startupBuildCommit: deployment.startupBuildCommit, probeEpoch: deployment.probeEpoch, passed: taskRef !== this.failRef,
      receiptDigest: sha256({ taskRef, build: this.build }) };
    this.issuedProbes.set(probe.receiptDigest, probe);
    return probe;
  }
  async settle(): Promise<void> { if (this.settleFailure) throw new Error("settlement interrupted"); }
}

export function workCohortCompletionAsyncYieldContract(create: () => Promise<{ store: LedgerStore; dispose(): Promise<void> }>): void {
  test("memory completion authority rotation during its final transaction yield rolls back every member [Behavioral-Active Blackbox-Group]", async () => {
    const opened = await create();
    try {
      const f = await prepare(opened.store);
      const write = f.primary.runAtomicOwnedMutation.bind(f.primary);
      let rotation: Promise<void> | null = null;
      f.primary.runAtomicOwnedMutation = (mutate, context) => write((tx) => {
        const result = mutate(tx);
        if (context !== null && "direct" in context && context.direct.kind === "cohort-completion") rotation = f.cohorts.beginNewExecutionEpoch();
        return result;
      }, context);
      await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, new CompletionHost(f.deploymentClass)).run(f.batch, f.lease)).rejects.toThrow();
      await rotation;
      expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
      expect(f.primary.fetchItem("defects", "D1").status).toBe("root-caused");
    } finally { await opened.dispose(); }
  });
}

export function workCohortCompletionContract(label: string, create: () => Promise<{ store: LedgerStore; dispose(): Promise<void> }>): void {
  describe(`cohort completion ${label}`, () => {
    for (const changedBuild of [false, true]) test(`uncommitted recording retry ${changedBuild ? "reprobes a changed build" : "reuses the exact build probes"} without merging again [Behavioral-Active Blackbox]`, async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const write = f.primary.runAtomicOwnedMutation.bind(f.primary);
        let interrupted = false;
        f.primary.runAtomicOwnedMutation = async (mutate, context) => {
          if (!interrupted && context !== null && "direct" in context && context.direct.kind === "cohort-completion") {
            interrupted = true;
            throw new Error("primary transaction interrupted before commit");
          }
          return write(mutate, context);
        };
        const host = new CompletionHost(f.deploymentClass);
        const coordinator = new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host);
        await expect(coordinator.run(f.batch, f.lease)).rejects.toThrow("before commit");
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
        expect((await f.cohorts.snapshot()).portable.completionHandoffs.at(-1)?.phase).toBe("ledger-recording");
        if (changedBuild) host.build = "build-two";
        const result = await coordinator.run(f.batch, f.lease);
        expect(result.phase).toBe("released");
        expect(result.deployment?.probeEpoch).toBe(changedBuild ? "build-two" : "build-one");
        expect(host.probeRefs).toHaveLength(changedBuild ? 4 : 2);
        expect(host.merges).toBe(1);
      } finally { await opened.dispose(); }
    });

    test("restored released history cannot replace protected primary completion bindings [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const write = f.primary.runAtomicOwnedMutation.bind(f.primary);
        f.primary.runAtomicOwnedMutation = async (mutate, context) => {
          if (context !== null && "direct" in context && context.direct.kind === "cohort-completion") throw new Error("primary not committed");
          return write(mutate, context);
        };
        const host = new CompletionHost(f.deploymentClass);
        await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host).run(f.batch, f.lease)).rejects.toThrow("primary not committed");
        f.primary.runAtomicOwnedMutation = write;
        const before = await f.cohorts.snapshot();
        const recording = before.portable.completionHandoffs.at(-1)!;
        const { kind: _kind, version: _version, handoffDigest: _digest, ...body } = recording;
        const ledgerResult = { batchDigest: f.batch.batchDigest,
          reviews: f.taskIds.map((id, index) => ({ taskRef: `tasks:${id}`, reviewRef: `reviews:R${900 + index}` })),
          resolvedDefectRefs: [], readyForUserClosureGoalRefs: [], archivedRefs: [], archivedMilestoneIds: [], operatorHandoffRef: null };
        const forged = ["ledger-recorded", "released"].map((phase) => createCohortCompletionHandoffV1({
          ...body, phase: phase as "ledger-recorded" | "released", ledgerResult,
        }));
        await f.cohorts.restorePortableState({ ...before.portable, completionHandoffs: [...before.portable.completionHandoffs, ...forged] });
        await f.cohorts.revalidateForResume({ definitionDigest: f.batch.acceptance.definitionDigest,
          sealDigest: f.batch.acceptance.sealDigest, evidenceSubjectDigest: f.batch.acceptance.evidenceSubjectDigest,
          acceptanceMatrixDigest: f.batch.envelope.definition.acceptanceMatrixDigest,
          environmentDigest: f.batch.envelope.definition.environment.environmentDigest,
          receiptBridgeDigest: before.portable.receiptBridges[0]!.bridgeDigest });
        const envelope = createCohortEffectEnvelopeV1({ definition: f.batch.envelope.definition,
          observation: f.observation, intent: f.intent, evidenceSubject: f.batch.envelope.evidenceSubject,
          executionEpoch: (await f.cohorts.snapshot()).runtime.executionEpoch });
        if (envelope.state !== "sealed") throw new Error("restored fixture must remain sealed");
        const { kind: _batchKind, version: _batchVersion, batchDigest: _batchDigest, ...batchBody } = f.batch;
        const batch = createCohortCompletionBatchV1({ ...batchBody, envelope });
        const lease = await f.cohorts.acquireLease({ holderId: "restored", semanticSubject: envelope.semanticSubject });
        await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host).run(batch, lease))
          .rejects.toThrow("no protected primary completion binding");
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
        expect(host.merges).toBe(1);
        expect(host.probeRefs).toHaveLength(2);
      } finally { await opened.dispose(); }
    });

    test("authority rotation immediately before the primary transaction cannot leave completed members [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const write = f.primary.runAtomicOwnedMutation.bind(f.primary);
        f.primary.runAtomicOwnedMutation = async (mutate, context) => {
          if (context !== null && "direct" in context && context.direct.kind === "cohort-completion") await f.cohorts.beginNewExecutionEpoch();
          return write(mutate, context);
        };
        await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, new CompletionHost(f.deploymentClass)).run(f.batch, f.lease))
          .rejects.toThrow();
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
      } finally { await opened.dispose(); }
    });
    test("caller mutation after review authentication cannot substitute the recorded review receipt [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const host = new CompletionHost(f.deploymentClass);
        host.afterProbes = async () => { (f.batch.members[0]!.reviewAttemptRefs as string[])[0] = "review-attempt:UNAUTHENTICATED"; };
        const result = await new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host).run(f.batch, f.lease);
        const reviewRef = result.ledgerResult!.reviews[0]!.reviewRef;
        expect(f.primary.fetchItem("reviews", reviewRef.slice("reviews:".length)).fields.sourceRefs).toEqual(["review-attempt:T1"]);
      } finally { await opened.dispose(); }
    });
    test("whole milestone archive refuses an unrelated terminal review outside the admitted inventory [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        await f.primary.createItem("reviews", f.milestoneId, { id: "R900", status: "go-ahead", fields: { summary: "unrelated plan review" } });
        const { kind: _kind, version: _version, batchDigest: _digest, ...input } = f.batch;
        const batch = createCohortCompletionBatchV1({ ...input, sweep: { archiveCompletedMembers: true, terminalItems: [],
          milestones: [{ id: f.milestoneId, expectedItemDigest: ledgerItemRevisionV1(`milestones:${f.milestoneId}`, f.primary.fetchItem("milestones", f.milestoneId)) }], summary: "cohort archive" } });
        await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, new CompletionHost(f.deploymentClass)).run(batch, f.lease))
          .rejects.toThrow("not wholly admitted");
        expect(f.primary.fetchItem("reviews", "R900").fields.summary).toBe("unrelated plan review");
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
      } finally { await opened.dispose(); }
    });
    test("lost recording acknowledgement replays the same archived tasks, reviews, and batch [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const { kind: _kind, version: _version, batchDigest: _digest, ...input } = f.batch;
        const batch = createCohortCompletionBatchV1({ ...input, sweep: { ...input.sweep, archiveCompletedMembers: true } });
        const write = f.cohorts.recordCompletionHandoff.bind(f.cohorts);
        let fail = true;
        f.cohorts.recordCompletionHandoff = async (operationId, lease, envelope, authority) => {
          if (readAuthorizedCohortCompletionHandoffV1(authority).phase === "ledger-recorded" && fail) {
            fail = false;
            throw new Error("recording acknowledgement lost");
          }
          return write(operationId, lease, envelope, authority);
        };
        const host = new CompletionHost(f.deploymentClass);
        const coordinator = new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host);
        await expect(coordinator.run(batch, f.lease)).rejects.toThrow("acknowledgement lost");
        expect((await f.cohorts.snapshot()).portable.completionHandoffs.at(-1)?.phase).toBe("ledger-recording");
        const before = await f.primary.fetchArchive("reviews", f.milestoneId);
        expect((await coordinator.run(batch, f.lease)).phase).toBe("released");
        expect(await f.primary.fetchArchive("reviews", f.milestoneId)).toEqual(before);
        expect(host.merges).toBe(1);
        expect(host.probeRefs).toHaveLength(2);
      } finally { await opened.dispose(); }
    });

    test("exact partial sweep merges an existing archive and preserves unselected terminal siblings [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        await f.primary.createItem("reviews", f.milestoneId, { id: "R900", status: "go-ahead", fields: { summary: "unrelated retained review" } });
        for (const id of ["D3", "D4"]) await f.primary.createItem("defects", "M-AMBIENT", {
          id, status: "resolved", fields: { headline: id, severity: "low", fix: "historical" },
        });
        const selected = f.primary.fetchItem("defects", "D1");
        const direct: DirectOwnedMutation = { direct: { kind: "cohort-completion", fence: null, operatorSettlement: null, sweep: {
          archiveCompletedMembers: false, terminalItems: [{ id: "prior", action: "archive-terminal-item", version: 1,
            targetId: "defects:D3", expectedMilestoneId: "M-AMBIENT", expectedUpdatedAt: "unused", expectedItemDigest: sha256("unused"), summary: "prior" }], milestones: [], summary: "prior" },
          members: f.taskIds.map((taskId) => ({ kind: "implementation-completion", taskId, ownerGoalId: "G1",
            reviewInit: { status: "go-ahead", fields: { summary: "unused" } }, taskPatch: {}, defectPatch: {} })),
        } };
        await (f.primary as unknown as { runAtomicOwnedMutation<T>(mutate: (tx: DirectOwnedWriteTx) => T, context: DirectOwnedMutation): Promise<T> })
          .runAtomicOwnedMutation((tx) => tx.completionArchive.archiveTerminalItems(["defects"], "prior", "fail-on-active-gate", ["defects:D3"]), direct);
        const { kind: _kind, version: _version, batchDigest: _digest, ...input } = f.batch;
        const batch = createCohortCompletionBatchV1({ ...input, sweep: { archiveCompletedMembers: true, milestones: [], summary: "cohort",
          terminalItems: [{ id: "selected", action: "archive-terminal-item", version: 1, targetId: "defects:D1",
            expectedMilestoneId: selected.milestoneId, expectedUpdatedAt: selected.updatedAt,
            expectedItemDigest: ledgerItemRevisionV1("defects:D1", selected), summary: "selected" }],
        } });
        const result = await new CohortCompletionCoordinatorV1(f.cohorts, f.primary, new CompletionHost(f.deploymentClass)).run(batch, f.lease);
        expect(result.phase).toBe("released");
        expect(f.primary.fetchItem("defects", "D4").status).toBe("resolved");
        expect(f.primary.fetchItem("defects", "D2").status).toBe("root-caused");
        const archive = await f.primary.fetchArchive("defects", "M-AMBIENT");
        expect(archive.kind).toBe("group");
        if (archive.kind !== "group") throw new Error("wrong archive kind");
        expect(archive.milestone.items.map(({ id }) => id).sort()).toEqual(["D1", "D3"]);
        expect(f.primary.fetchItem("milestones", "M-AMBIENT").status).toBe("open");
        expect(f.primary.fetchItem("reviews", "R900").fields.summary).toBe("unrelated retained review");
        expect((await f.primary.ftsSearch("covered", { includeArchived: true })).some(({ item }) => item.id === "D1")).toBe(true);
        expect((await f.primary.ftsSearch("covered")).some(({ item }) => item.id === "D1")).toBe(false);
      } finally { await opened.dispose(); }
    });
    test("one merge and deployment complete every task/review atomically, preserving external defects and goals [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const host = new CompletionHost(f.deploymentClass);
        const primaryWrite = f.primary.runAtomicOwnedMutation.bind(f.primary);
        let primaryEntries = 0;
        f.primary.runAtomicOwnedMutation = (mutate, context) => {
          if (context !== null && "direct" in context && context.direct.kind === "cohort-completion" && primaryEntries++ === 0 && !host.primaryAdmissionActive) {
            throw new Error("primary transaction escaped cohort admission");
          }
          return primaryWrite(mutate, context);
        };
        const handoffWrite = f.cohorts.recordCompletionHandoff.bind(f.cohorts);
        f.cohorts.recordCompletionHandoff = (operationId, lease, envelope, authority) => {
          if (readAuthorizedCohortCompletionHandoffV1(authority).phase === "ledger-recorded" && !host.primaryAdmissionActive) {
            throw new Error("primary acknowledgement escaped cohort admission");
          }
          return handoffWrite(operationId, lease, envelope, authority);
        };
        const coordinator = new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host);
        const result = await coordinator.run(f.batch, f.lease);
        expect(result.phase).toBe("released");
        expect(result.ledgerResult?.reviews).toHaveLength(2);
        expect(result.ledgerResult?.resolvedDefectRefs).toEqual(["defects:D1"]);
        expect(result.ledgerResult?.readyForUserClosureGoalRefs).toEqual([]);
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["done", "done"]);
        expect(f.primary.fetchItem("defects", "D2").status).toBe("root-caused");
        expect(f.primary.fetchItem("goals", "G1").status).toBe("building");
        expect(host.primaryAdmissionCount).toBe(1);
        expect(host.primaryAdmissionActive).toBe(false);
        expect(await coordinator.run(f.batch, f.lease)).toEqual(result);
        expect(host.merges).toBe(1);
        expect(host.probeRefs).toHaveLength(2);
      } finally { await opened.dispose(); }
    });

    test("failed shared deployment records diagnostics without a terminal subset; changed build retries probes without a gate [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const host = new CompletionHost(f.deploymentClass);
        host.failRef = "tasks:T2";
        const coordinator = new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host);
        await expect(coordinator.run(f.batch, f.lease)).rejects.toThrow("deployment probe failed");
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
        const before = (await f.cohorts.snapshot()).portable;
        expect(before.completionHandoffs.at(-1)?.probes.at(-1)?.passed).toBe(false);
        host.failRef = null;
        host.build = "build-two";
        expect((await coordinator.run(f.batch, f.lease)).phase).toBe("released");
        expect(host.merges).toBe(1);
        expect(host.probeRefs).toHaveLength(4);
        expect((await f.cohorts.snapshot()).portable.commandEvidence).toEqual(before.commandEvidence);
        expect((await readCohortAdvanceStatusV1(f.cohorts)).counters).toMatchObject({
          deploymentEpochs: 2, deploymentProbeExecutions: 4, deploymentProbeRejections: 1,
          primaryFinalizationAttempts: 2, primaryFinalizations: 1,
        });
      } finally { await opened.dispose(); }
    });

    test("a stale last member rolls back earlier task, review, and binding writes [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const beforeReviews = f.primary.fetch("reviews").milestones.flatMap(({ items }) => items);
        const host = new CompletionHost(f.deploymentClass);
        host.afterProbes = () => f.primary.updateItem("tasks", "T2", { fields: { headline: "changed after seal" } }).then(() => undefined);
        await expect(new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host).run(f.batch, f.lease)).rejects.toThrow("sealed task authority changed");
        expect(f.taskIds.map((id) => f.primary.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
        expect(f.primary.fetch("reviews").milestones.flatMap(({ items }) => items)).toEqual(beforeReviews);
        expect(f.primary.fetchItem("defects", "D1").status).toBe("root-caused");
      } finally { await opened.dispose(); }
    });

    test("owned whole milestone archives atomically and settlement replay never closes its goal [Behavioral-Active Blackbox]", async () => {
      const opened = await create();
      try {
        const f = await prepare(opened.store);
        const { kind: _kind, version: _version, batchDigest: _digest, ...input } = f.batch;
        const batch = createCohortCompletionBatchV1({ ...input, sweep: { archiveCompletedMembers: true, terminalItems: [],
          milestones: [{ id: f.milestoneId, expectedItemDigest: ledgerItemRevisionV1(`milestones:${f.milestoneId}`, f.primary.fetchItem("milestones", f.milestoneId)) }], summary: "cohort archive" } });
        const host = new CompletionHost(f.deploymentClass);
        host.settleFailure = true;
        const coordinator = new CohortCompletionCoordinatorV1(f.cohorts, f.primary, host);
        await expect(coordinator.run(batch, f.lease)).rejects.toThrow("settlement interrupted");
        expect((await f.cohorts.snapshot()).portable.completionHandoffs.at(-1)?.phase).toBe("ledger-recorded");
        expect(() => f.primary.fetchItem("tasks", "T1")).toThrow();
        expect(f.primary.fetchItem("goals", "G1").status).toBe("building");
        host.settleFailure = false;
        expect((await coordinator.run(batch, f.lease)).phase).toBe("released");
        expect(host.merges).toBe(1);
        expect(host.probeRefs).toHaveLength(2);
        const counters = (await readCohortAdvanceStatusV1(f.cohorts)).counters;
        expect(counters).toMatchObject({ milestoneArchives: 1, primaryFinalizations: 1, primaryFinalizationAttempts: 2 });
        const result = (await coordinator.run(batch, f.lease)).ledgerResult!;
        expect((await readCohortAdvanceStatusV1(f.cohorts)).counters).toMatchObject({
          itemSweeps: new Set(result.archivedRefs).size, milestoneArchives: 1, primaryFinalizations: 1,
          primaryFinalizationAttempts: 3,
        });
      } finally { await opened.dispose(); }
    });
  });
}
