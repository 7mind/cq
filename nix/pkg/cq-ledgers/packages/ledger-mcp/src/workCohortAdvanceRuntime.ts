import { createHash } from "node:crypto";
import { managedWorktreeRegistryRoot, projectGateAuthorizationForm } from "@cq/config";
import { realpath } from "node:fs/promises";
import {
  GitCohortLocalRepositoryV1, LedgerWorksetCohortAdmissionObservationSourceV1,
  cohortValueDigestV1 as digest, constructCohortDecisionsV1, createCohortDefinitionIdentityV1,
  createCohortCandidateIntentV1, createCohortEffectEnvelopeV1, createManagedCohortWorktreeGitEffectRunner,
  dependencyTaskSnapshotReaderFromStore, readCohortReadyBoundariesV1, nodeManagedWorktreeGitRunner,
  prepareManagedCohortWorktree, produceCohortAdmissionObservationV1,
  requireWorksetStore, resolveCohortCommandBoundaryV1, resolveCohortDefinitionObservationV1,
  withManagedCohortAuthorityWriterLock,
  assertCohortPrimaryObservationV1,
  readRetainedManagedCohortHandle, retainManagedCohortAuthority,
  withManagedWorktreeEffectLock,
  type CohortAdmissionPlanV1, type CohortAdmissionObservationV1, type CohortAdvanceCapabilityV1, type CohortAdvanceObservationV1,
  type ManagedWorktreeDeps, type ResolvedLedgerStore, type DispatchCapability,
} from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";
import { resolvePreparationAuthority } from "./cohortPreparationJournal.js";

export interface CohortAdvanceRuntimeOptionsV1 {
  readonly resolved: ResolvedLedgerStore;
  readonly promptArtifacts: PromptArtifactStore;
  readonly managedDeps?: ManagedWorktreeDeps;
  readonly dispatch?: DispatchCapability;
}

/** Parent-owned admission; caller proposals are re-derived against the primary workset and Git. */
export async function createCohortAdvanceRuntimeV1(
  options: CohortAdvanceRuntimeOptionsV1,
): Promise<CohortAdvanceCapabilityV1 | undefined> {
  const { resolved } = options;
  if (resolved.backend !== "xdg" || resolved.store.workCohortStore === undefined) return undefined;
  const repositoryRoot = await realpath(resolved.configRoot);
  const common = await nodeManagedWorktreeGitRunner(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0 && common.stderr.includes("not a git repository")) return undefined;
  if (common.code !== 0) throw new Error(`cohort repository identity failed: ${common.stderr}`);
  const commonDir = await realpath(common.stdout.trim());
  const repositoryId = createHash("sha256").update(`${repositoryRoot}\n${commonDir}`).digest("hex");
  const repository = new GitCohortLocalRepositoryV1({ repositoryRoot, repositoryId });
  const cohorts = resolved.store.workCohortStore();
  const workset = requireWorksetStore(resolved.store);
  const deps = options.managedDeps ?? {};
  const source = (plan: CohortAdmissionPlanV1) => {
    const manifest = options.promptArtifacts.readManifest();
    if (manifest.catalogHash === undefined) throw new Error("cohort admission requires the installed prompt catalogue identity");
    const environment = { environmentDigest: digest({ catalogHash: manifest.catalogHash,
      runtime: { executable: process.execPath, bun: Bun.version, platform: process.platform, architecture: process.arch } }) };
    return new LedgerWorksetCohortAdmissionObservationSourceV1({ repository, ledger: resolved.store, workset, plan, environment });
  };
  const assertReady = async (plan: CohortAdmissionPlanV1) => {
    const proposed = plan.members.map(({ memberRef }) => memberRef).sort();
    const boundaries = await readCohortReadyBoundariesV1(resolved.store);
    const boundary = boundaries.find(({ members }) => members.some(({ memberRef }) => memberRef === proposed[0]));
    if (boundary === undefined || boundary.unexamined !== 0 ||
        digest(proposed) !== digest(boundary.members.map(({ memberRef }) => memberRef).sort())) {
      throw new Error("cohort admission requires the complete bounded ready boundary; omitted or unexamined peers cannot become implicit singletons");
    }
    for (const member of plan.members) {
      if (member.memberRef.startsWith("tasks:") && resolved.store.fetchItem("tasks", member.memberRef.slice(6)).status !== "wip") {
        throw new Error("transition the complete ready task boundary to wip through owner-scoped lifecycle writes before observation");
      }
      for (const candidate of member.boundaryCandidates) {
        resolveCohortCommandBoundaryV1(candidate.sharedRegression);
        const fullGate = resolveCohortCommandBoundaryV1(candidate.canonicalFullGate);
        if (digest(fullGate) !== digest(projectGateAuthorizationForm())) {
          throw new Error("cohort admission cannot substitute the canonical full gate");
        }
      }
    }
  };
  const primaryIdentity = (observation: CohortAdmissionObservationV1) => digest({
    workset: observation.workset, manifest: observation.manifest, repository: observation.repository,
    environment: observation.environment,
    members: observation.members.map(({ attestations: _attestations, memberBindingDigest: _binding, ...member }) => member),
  });
  const observe = async (input: { readonly plan: CohortAdmissionPlanV1; readonly operationId: string }): Promise<CohortAdvanceObservationV1> =>
    withManagedCohortAuthorityWriterLock(repositoryRoot, deps, async () => {
    await assertReady(input.plan);
    const observation = await produceCohortAdmissionObservationV1({ memberRefs: input.plan.members.map(({ memberRef }) => memberRef) }, source(input.plan));
    const priorObservations = (await cohorts.snapshot()).portable.observations;
    for (const prior of priorObservations) {
      if (primaryIdentity(prior) !== primaryIdentity(observation)) continue;
      const commonAtoms = prior.atoms.filter(({ atomDigest }) =>
        prior.members.filter(({ attestations }) => attestations.some((entry) => entry.atomDigest === atomDigest)).length > 1);
      for (const member of prior.members) {
        const current = observation.members.find(({ memberRef }) => memberRef === member.memberRef);
        if (current === undefined) throw new Error("cohort primary member identity changed");
        if (commonAtoms.some(({ atomDigest, witness }) => member.attestations.some((entry) => entry.atomDigest === atomDigest) &&
            !current.attestations.some((entry) => observation.atoms.some((atom) =>
              atom.atomDigest === entry.atomDigest && digest(atom.witness) === digest(witness))))) {
          throw new Error("cohort proposal omits a previously observed common boundary on unchanged primary and repository facts");
        }
      }
    }
    await cohorts.recordObservation(`${input.operationId}:observation`, observation);
    const rechecked = await produceCohortAdmissionObservationV1({ memberRefs: input.plan.members.map(({ memberRef }) => memberRef) }, source(input.plan));
    if (observation.observationDigest !== rechecked.observationDigest) throw new Error("cohort observation changed before definition publication; observe again");
    const decisions = constructCohortDecisionsV1(observation);
    const definitions = [];
    for (const decision of decisions) {
      await cohorts.recordDecision(`${input.operationId}:decision:${decision.decisionDigest}`, decision);
      const cohortId = `cohort:${digest(decision.includedMemberRefs)}`;
      const prior = (await cohorts.snapshot()).portable.definitions.findLast((entry) => entry.cohortId === cohortId) ?? null;
      const definition = createCohortDefinitionIdentityV1({ cohortId, observation, decision, prior });
      await cohorts.recordDefinition(`${input.operationId}:definition:${definition.definitionDigest}`, definition);
      definitions.push(definition);
    }
    return { observationDigest: observation.observationDigest, decisions, definitions };
  });
  return {
    observe,
    prepare: async (input) => withManagedCohortAuthorityWriterLock(repositoryRoot, deps, async () => {
      await assertReady(input.plan);
      const state = (await cohorts.snapshot()).portable;
      const definition = state.definitions.find((entry) => entry.definitionDigest === input.definitionDigest);
      if (definition === undefined || definition.phase !== "implementation") throw new Error("cohort prepare requires an observed implementation definition");
      const observed = resolveCohortDefinitionObservationV1({ definition, observations: state.observations, decisions: state.decisions });
      const current = await produceCohortAdmissionObservationV1({ memberRefs: input.plan.members.map(({ memberRef }) => memberRef) }, source(input.plan));
      if (observed.observationDigest !== current.observationDigest) throw new Error("cohort admission changed before worktree preparation; observe again");
      const intent = createCohortCandidateIntentV1(definition, input.operationId);
      const priorIntent = state.candidateIntents.findLast((entry) => entry.definitionDigest === definition.definitionDigest);
      if (priorIntent !== undefined && priorIntent.intentDigest !== intent.intentDigest) {
        throw new Error("cohort preparation already has an exact candidate intent; use its explicit successor transition");
      }
      await cohorts.recordCandidateIntent(`${input.operationId}:intent`, intent);
      await cohorts.transitionReservation(`${input.operationId}:reserve`, {
        reservationId: intent.intentDigest, cohortId: definition.cohortId,
        definitionDigest: definition.definitionDigest, memberRefs: definition.members.map(({ memberRef }) => memberRef), transition: "reserved",
      });
      const cohort = createCohortEffectEnvelopeV1({ definition, observation: current, intent,
        evidenceSubject: null, executionEpoch: (await cohorts.snapshot()).runtime.executionEpoch });
      const authority = await resolvePreparationAuthority({ store: cohorts, envelope: cohort, holderId: input.operationId,
        registryRoot: managedWorktreeRegistryRoot(repositoryRoot, deps.stateDir) });
      const guardedDeps = { ...deps, validateCohortPublication: (envelope: typeof cohort) =>
        assertCohortPrimaryObservationV1(resolved.store, envelope, current) };
      const git = createManagedCohortWorktreeGitEffectRunner({ store: resolved.store,
        repositoryRoot, authority, readOnlyGit: nodeManagedWorktreeGitRunner });
      let worktree = await prepareManagedCohortWorktree({ repositoryRoot, baseCommit: definition.repository.headCommit,
        integrationHead: definition.repository.headCommit, priorResultCommit: null, handle: null,
        dependencyReader: dependencyTaskSnapshotReaderFromStore(resolved.store) }, { ...guardedDeps, git }, authority);
      if (worktree.status === "resume-required") worktree = await prepareManagedCohortWorktree({ repositoryRoot,
        baseCommit: definition.repository.headCommit, integrationHead: definition.repository.headCommit,
        priorResultCommit: null, handle: worktree.handle, dependencyReader: dependencyTaskSnapshotReaderFromStore(resolved.store) }, { ...guardedDeps, git }, authority);
      // A refusal holds no publishable authority, so it must not keep holding the
      // members: recovery needs a fresh observation, whose definition mints a new
      // reservation id that an orphan reservation would reject as an overlap.
      if (worktree.status === "refused") await cohorts.releaseRefusedPreparation(`${input.operationId}:release`, authority.lease, {
        reservationId: intent.intentDigest, cohortId: definition.cohortId,
        definitionDigest: definition.definitionDigest, memberRefs: definition.members.map(({ memberRef }) => memberRef),
      });
      return { cohort, worktree };
    }),
    resume: async (input) => {
      const resumed = await withManagedCohortAuthorityWriterLock(repositoryRoot, deps, async () => {
      await assertReady(input.plan);
      const initial = await cohorts.snapshot();
      const state = initial.portable;
      const definition = state.definitions.find((entry) => entry.definitionDigest === input.definitionDigest);
      const intent = state.candidateIntents.find((entry) => entry.intentDigest === input.intentDigest);
      if (definition === undefined || definition.phase !== "implementation" || intent?.definitionDigest !== definition.definitionDigest ||
          state.definitions.findLast((entry) => entry.cohortId === definition.cohortId)?.definitionDigest !== definition.definitionDigest ||
          state.candidateIntents.findLast((entry) => entry.definitionDigest === definition.definitionDigest)?.intentDigest !== intent.intentDigest) {
        throw new Error("cohort resume requires its exact current definition and candidate intent");
      }
      const observed = resolveCohortDefinitionObservationV1({ definition, observations: state.observations, decisions: state.decisions });
      const current = await produceCohortAdmissionObservationV1({ memberRefs: input.plan.members.map(({ memberRef }) => memberRef) }, source(input.plan));
      if (observed.observationDigest !== current.observationDigest) throw new Error("cohort resume admission changed; existing evidence cannot authorize another definition");
      const attempt = state.candidateAttempts.findLast((entry) => entry.intent.intentDigest === intent.intentDigest);
      const seal = state.candidateSeals.find((entry) => entry.candidateAttemptDigest === attempt?.candidateAttemptDigest);
      const evidenceSubject = state.evidenceSubjects.find((entry) => entry.sealDigest === seal?.sealDigest) ?? null;
      if (attempt !== undefined && evidenceSubject === null) throw new Error("unsealed prepared dispatch requires explicit successor recovery, not preparation resume");
      const handle = await readRetainedManagedCohortHandle(repositoryRoot, intent.intentDigest, deps);
      if (evidenceSubject !== null && (handle === null || seal === undefined)) throw new Error("sealed resume lost its exact managed worktree");
      const before = createCohortEffectEnvelopeV1({ definition, observation: current, intent, evidenceSubject,
        executionEpoch: initial.runtime.executionEpoch });
      const resumeCandidate = async () => {
      if ((await cohorts.snapshot()).revision !== initial.revision) throw new Error("cohort changed while awaiting effect settlement; retry resume from current state");
      assertCohortPrimaryObservationV1(resolved.store, before, current);
      if (seal !== undefined && handle !== null) {
        const tip = await nodeManagedWorktreeGitRunner(handle.absolutePath, ["rev-parse", "HEAD"]);
        const tree = await nodeManagedWorktreeGitRunner(handle.absolutePath, ["rev-parse", "HEAD^{tree}"]);
        const dirty = await nodeManagedWorktreeGitRunner(handle.absolutePath, ["status", "--porcelain"]);
        if (tip.code !== 0 || tree.code !== 0 || dirty.code !== 0 || tip.stdout.trim() !== seal.resultCommit ||
            tree.stdout.trim() !== seal.resultTree || dirty.stdout.trim() !== "") throw new Error("sealed resume candidate changed; a new seal is required");
      }
      if (input.workerDispatch !== undefined && (attempt === undefined ||
          attempt.preparedDispatch.attestationId !== input.workerDispatch.attestationId ||
          attempt.preparedDispatch.generation !== input.workerDispatch.generation || options.dispatch?.renewCohortParentExecution === undefined)) {
        throw new Error("cohort resume parent grant requires the exact producing worker and a local coordinator");
      }
      if (initial.runtime.lease !== null && initial.runtime.lease.semanticSubject !== before.semanticSubject) {
        throw new Error("cohort resume cannot revoke another candidate's live lease");
      }
      const replay = initial.runtime.lease?.holderId === input.operationId && initial.runtime.lease.semanticSubject === before.semanticSubject;
      if (!replay) await cohorts.beginNewExecutionEpoch();
      const cohort = createCohortEffectEnvelopeV1({ definition, observation: current, intent, evidenceSubject,
        executionEpoch: (await cohorts.snapshot()).runtime.executionEpoch });
      if (!replay) {
        if (cohort.state === "sealed") {
          const bridge = state.receiptBridges.find((entry) => entry.sealDigest === cohort.evidenceSubject.sealDigest);
          if (bridge === undefined) throw new Error("sealed resume lost its exact receipt bridge");
          await cohorts.revalidateForResume({ definitionDigest: definition.definitionDigest, sealDigest: cohort.evidenceSubject.sealDigest,
            evidenceSubjectDigest: cohort.evidenceSubject.evidenceSubjectDigest, acceptanceMatrixDigest: definition.acceptanceMatrixDigest,
            environmentDigest: definition.environment.environmentDigest, receiptBridgeDigest: bridge.bridgeDigest });
        } else await cohorts.revalidatePreparationForResume(cohort);
      }
      const authority = await resolvePreparationAuthority({ store: cohorts, envelope: cohort, holderId: input.operationId,
        registryRoot: managedWorktreeRegistryRoot(repositoryRoot, deps.stateDir) });
      const git = createManagedCohortWorktreeGitEffectRunner({ store: resolved.store, repositoryRoot, authority, readOnlyGit: nodeManagedWorktreeGitRunner });
      const guardedDeps = { ...deps, git, validateCohortPublication: (envelope: typeof cohort) =>
        assertCohortPrimaryObservationV1(resolved.store, envelope, current) };
      const worktree = await prepareManagedCohortWorktree({ repositoryRoot, baseCommit: definition.repository.headCommit,
        integrationHead: definition.repository.headCommit, priorResultCommit: seal?.resultCommit ?? null, handle,
        dependencyReader: dependencyTaskSnapshotReaderFromStore(resolved.store) }, guardedDeps, authority);
      if (worktree.status !== "prepared") return { cohort, worktree };
      await retainManagedCohortAuthority(worktree.handle, authority, guardedDeps);
      return { cohort, worktree };
      };
      return handle === null ? resumeCandidate() : withManagedWorktreeEffectLock({ repositoryRoot, handleToken: handle.token }, deps, resumeCandidate);
      });
      if (input.workerDispatch === undefined || resumed.worktree.status !== "prepared") return resumed;
      const renew = options.dispatch?.renewCohortParentExecution;
      if (renew === undefined) throw new Error("cohort parent execution renewal requires the local coordinator");
      return { ...resumed, parentGateCapability: await renew({ workerDispatch: input.workerDispatch, cohort: resumed.cohort }) };
    },
  };
}
