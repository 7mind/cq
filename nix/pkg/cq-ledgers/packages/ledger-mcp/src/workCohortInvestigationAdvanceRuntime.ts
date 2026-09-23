import { createHash } from "node:crypto";
import { projectGateAuthorizationForm } from "@cq/ledger";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DISPATCH_PREPARED_SCHEMA, assertDispatchHandle, validateAgainstSchema, type AttestationBackend, type DispatchPrepared, type DispatchHandle } from "@cq/config";
import { assertInvestigationCohortLaunchBindingV1, type InvestigationCohortLaunchBindingV1, type WorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  COHORT_INVESTIGATION_ADVANCE_SCHEMA, InvestigationCohortRunnerV1,
  GitCohortLocalRepositoryV1, LedgerWorksetCohortAdmissionObservationSourceV1,
  cohortValueDigestV1 as digest, createInvestigationCohortPlanV1, createNodeSupervisedWorkerCommandRunner,
  nodeManagedWorktreeGitRunner, parseCohortAdmissionPlanV1, redactSecrets, requireWorksetStore,
  settleProcessGroups, settleWorktreeGateCommands,
  resolveCohortDefinitionObservationV1, withManagedCohortAuthorityWriterLock,
  produceCohortAdmissionObservationV1, resolveCohortCommandBoundaryV1,
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS, SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  type CohortAdmissionObservationSourceV1, type CohortAdmissionPlanV1,
  type CohortInvestigationAdvanceCapabilityV1, type CohortInvestigationAdvanceInputV1,
  type CohortInvestigationAdvanceResultV1, type DispatchCapability, type InvestigationCohortPlanV1,
  type InvestigationCohortRunV1, type InvestigationMemberAdjudicationV1,
  type InvestigationPreparedDispatchV1, type ResolvedLedgerStore,
  type InvestigationProbeReceiptV1, type InvestigationRoleV1,
  type InvestigationCorrectionCandidateV1, type InvestigationCorrectionEligibilityV1,
  type SupervisedWorkerCommandRunner, type WorkCohortLeaseV1, type WorkCohortStore, type WorksetStore,
} from "@cq/ledger";
import { z } from "zod";
import { publishPrivateCohortJournalV1 } from "./cohortPreparationJournal.js";
import { DispatchInvestigationCohortHostV1, createRepositoryInvestigationCitationResolverV1, readInvestigationRoleContractV1 } from "./workCohortInvestigationRuntime.js";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

type ProbeInput = Extract<CohortInvestigationAdvanceInputV1, { operation: "probe" }>;
interface PrivateInvestigationJournal {
  readonly version: 1;
  readonly admissionPlan: CohortAdmissionPlanV1;
  readonly plan: InvestigationCohortPlanV1;
  lease: WorkCohortLeaseV1 | null;
  readonly launches: { readonly investigation: InvestigationPreparedDispatchV1; readonly prepared: DispatchPrepared }[];
  readonly adjudications: { readonly defectRef: string; readonly evidenceDigest: string; readonly adjudication: InvestigationMemberAdjudicationV1 }[];
  readonly probes: InvestigationProbeReceiptV1[];
  correctionProposal?: CohortAdmissionPlanV1;
  correctionEligibility?: InvestigationCorrectionEligibilityV1;
}
const journalSchema = z.object({ version: z.literal(1), admissionPlan: z.unknown(), plan: z.unknown(),
  lease: z.object({ holderId: z.string().min(1), semanticSubject: z.string().min(1), executionEpoch: z.string().min(1), capability: z.string().min(1) }).strict().nullable(),
  launches: z.array(z.object({ investigation: z.unknown(), prepared: z.unknown() }).strict()),
  adjudications: z.array(z.unknown()), probes: z.array(z.unknown()),
  correctionProposal: z.unknown().optional(), correctionEligibility: z.unknown().optional(),
}).strict();

export interface CohortInvestigationAdvanceRuntimeOptionsV1 {
  readonly resolved: ResolvedLedgerStore;
  readonly backend: AttestationBackend;
  readonly dispatch: DispatchCapability;
  readonly promptArtifacts: PromptArtifactStore;
  readonly cancellationSignal: AbortSignal;
  readonly stateDir?: string;
  readonly trustedCommandRunner?: SupervisedWorkerCommandRunner;
}

export interface InvestigationAdvanceDependenciesV1 {
  readonly cohorts: WorkCohortStore;
  readonly backend: AttestationBackend;
  readonly dispatch: DispatchCapability;
  readonly promptArtifacts: PromptArtifactStore;
  readonly repositoryRoot: string;
  readonly journalRoot: string;
  readonly cancellationSignal: AbortSignal;
  readonly commands: SupervisedWorkerCommandRunner;
  readonly workset: WorksetStore;
  readonly source: (plan: CohortAdmissionPlanV1) => CohortAdmissionObservationSourceV1;
  readonly hypothesisStatement: (ref: string) => string;
}

export interface InvestigationLaunchAuthorityV1 {
  readonly binding: InvestigationCohortLaunchBindingV1;
  readonly roleId: InvestigationRoleV1;
  readonly memberRef: string;
  readonly planDigest: string;
  readonly preparedDigest: string;
  readonly executionEpoch: string;
  readonly members: readonly Pick<InvestigationCohortPlanV1["members"][number], "defectRef" | "defectRevision" | "hypothesisRef" | "hypothesisRevision">[];
  readonly expectedChild: InvestigationPreparedDispatchV1["expectedChild"];
  readonly targetRef: string;
  readonly provider: WorksetEffectAdmissionProvider;
}
export interface CohortInvestigationAdvanceRuntimeV1 extends CohortInvestigationAdvanceCapabilityV1 {
  resolveLaunchAuthority(handle: DispatchHandle): Promise<InvestigationLaunchAuthorityV1 | null>;
}

function evidenceDigest(run: InvestigationCohortRunV1, index: number): string {
  const member = run.members[index]!;
  return digest({ planDigest: run.plan.planDigest, member: run.plan.members[index],
    results: [member.explorerResult, member.proberResult], citations: member.citations });
}

function nativeLaunchBinding(journal: PrivateInvestigationJournal, launch: InvestigationPreparedDispatchV1): InvestigationCohortLaunchBindingV1 {
  if (journal.lease === null) throw new Error("investigation native launch lacks a retained execution lease");
  const binding: InvestigationCohortLaunchBindingV1 = { kind: "cq-investigation-cohort-launch", version: 1,
    handle: launch.handle, roleId: launch.binding.role.roleId, memberRef: launch.binding.member.defectRef,
    planDigest: journal.plan.planDigest, preparedDigest: launch.preparedDigest, executionEpoch: journal.lease.executionEpoch,
    members: journal.plan.members.map(({ defectRef, defectRevision, hypothesisRef, hypothesisRevision }) => ({ defectRef, defectRevision, hypothesisRef, hypothesisRevision })),
    expectedChild: launch.expectedChild };
  assertInvestigationCohortLaunchBindingV1(binding);
  return binding;
}

/** The parent supplies judgment, never native-result or command-execution proof. */
export function createInvestigationAdvanceCapabilityV1(options: InvestigationAdvanceDependenciesV1): CohortInvestigationAdvanceRuntimeV1 {
  const journalPath = (planDigest: string) => join(options.journalRoot, "cohort-investigations", `${planDigest}.json`);
  const launchIndexPath = (handle: DispatchHandle) => join(options.journalRoot, "cohort-investigation-dispatches", `${digest(handle)}.json`);
  const publish = (journal: PrivateInvestigationJournal) => publishPrivateCohortJournalV1(journalPath(journal.plan.planDigest), journal);
  const read = (planDigest: string): PrivateInvestigationJournal => {
    const parsed = journalSchema.parse(JSON.parse(readFileSync(journalPath(planDigest), "utf8")));
    const journal = { ...parsed, admissionPlan: parseCohortAdmissionPlanV1(parsed.admissionPlan) } as PrivateInvestigationJournal;
    if (journal.plan.planDigest !== planDigest) throw new Error("investigation private journal names another plan");
    const { planDigest: retainedDigest, ...payload } = journal.plan;
    if (digest(payload) !== retainedDigest) throw new Error("investigation private plan binding changed");
    for (const launch of journal.launches) {
      if (!validateAgainstSchema(DISPATCH_PREPARED_SCHEMA, launch.prepared).ok ||
        launch.investigation.binding.planDigest !== planDigest ||
        launch.prepared.attestationId !== launch.investigation.handle.attestationId ||
        launch.prepared.generation !== launch.investigation.handle.generation) throw new Error("invalid private investigation launch");
    }
    return journal;
  };
  const correctionCandidates = async (journal: PrivateInvestigationJournal, run: InvestigationCohortRunV1): Promise<readonly InvestigationCorrectionCandidateV1[]> => {
    if (journal.correctionProposal === undefined) return [];
    if (run.members.some((member) => member.explorerResult === null || member.citations.length === 0 ||
        (member.explorerResult.output.probeRequest !== undefined && member.proberResult === null))) {
      throw new Error("correction proposal requires separately consumed complete evidence for every member");
    }
    const proposal = parseCohortAdmissionPlanV1(journal.correctionProposal);
    if (proposal.members.length !== run.plan.members.length || proposal.members.some((member, index) =>
      member.memberRef !== run.plan.members[index]!.defectRef || member.investigationHypothesisRef !== run.plan.members[index]!.hypothesisRef)) {
      throw new Error("correction proposal must preserve the exact ordered defect and hypothesis members");
    }
    for (const member of proposal.members) for (const boundary of member.boundaryCandidates) {
      if (boundary.witness.kind !== "repository-node") throw new Error("correction proposal requires current repository witness applicability for each member");
      resolveCohortCommandBoundaryV1(boundary.sharedRegression);
      const fullGate = resolveCohortCommandBoundaryV1(boundary.canonicalFullGate);
      if (digest(fullGate) !== digest(projectGateAuthorizationForm())) {
        throw new Error("correction proposal cannot substitute the canonical implementation full gate");
      }
    }
    const observation = await produceCohortAdmissionObservationV1({ memberRefs: run.plan.members.map((member) => member.defectRef) }, options.source(proposal));
    if (observation.members.length !== run.plan.members.length || observation.members.some((member, index) => {
      const expected = run.plan.members[index]!;
      return member.phase !== "investigation" || member.defectRef !== expected.defectRef || member.defectRevision !== expected.defectRevision ||
        member.hypothesisRef !== expected.hypothesisRef || member.hypothesisRevision !== expected.hypothesisRevision;
    })) throw new Error("correction proposal member revisions differ from the consumed investigation");
    const proposalDigest = digest(proposal);
    const memberEvidence = run.plan.members.map((member, index) => ({ defectRef: member.defectRef, evidenceDigest: evidenceDigest(run, index) }));
    return observation.atoms.flatMap((source) => {
      const applicability = observation.members.map((member) => member.attestations.find((entry) => entry.atomDigest === source.atomDigest));
      if (source.witness.kind !== "repository-node" || applicability.some((entry) => entry === undefined)) return [];
      const payload = { kind: "cq-cohort-common-boundary-atom" as const, version: 1 as const, phase: "implementation" as const,
        witness: { kind: "repository-node" as const, witnessDigest: digest({ kind: "cq-investigation-correction-source", planDigest: run.plan.planDigest,
          proposalDigest, sourceWitness: source.witness, memberEvidence }) },
        sharedRegression: source.sharedRegression, canonicalFullGate: source.canonicalFullGate, reviewerClass: source.reviewerClass,
        deploymentClass: source.deploymentClass, finalizationClass: source.finalizationClass, repository: source.repository,
        environment: source.environment, splitConditions: source.splitConditions };
      const atom = { ...payload, atomDigest: digest(payload) };
      const candidate = { proposalDigest, observationDigest: observation.observationDigest, atom, memberEvidence,
        applicability: applicability.map((entry) => entry!) };
      return [{ ...candidate, correctionBoundaryDigest: digest({ kind: "cq-investigation-correction-boundary", ...candidate }) }];
    });
  };
  const hostFor = (journal: PrivateInvestigationJournal) => {
    const resolver = createRepositoryInvestigationCitationResolverV1(options.repositoryRoot, {
      read: async (prepared, citation) => {
        const receipt = journal.probes.find((entry) => entry.preparedDigest === prepared.preparedDigest && entry.citation === citation);
        if (receipt === undefined) throw new Error("command evidence unavailable: execute the explicit parent-approved probe first");
        if (receipt.completeOutput === null) throw new Error("command evidence unavailable range: retained diagnostic tail is not complete output");
        return { citation, text: receipt.completeOutput, sourceDigest: digest(receipt) };
      },
    });
    const host = new DispatchInvestigationCohortHostV1({
      store: options.cohorts, backend: options.backend, dispatch: options.dispatch,
      promptArtifacts: options.promptArtifacts, observationSource: options.source(journal.admissionPlan),
      timeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
      launcher: { launch: async () => { throw new Error("parent must launch prepared investigation roles through the native bridge"); } },
      resolveCitation: resolver,
      adjudicate: async (member, results, citations) => {
        const binding = digest({ planDigest: journal.plan.planDigest, member,
          results: [results[0] ?? null, results[1] ?? null], citations });
        const decision = journal.adjudications.find((entry) => entry.defectRef === member.defectRef);
        if (decision === undefined) return null;
        if (decision.evidenceDigest !== binding) throw new Error("parent adjudication no longer matches exact consumed evidence and citations");
        return decision.adjudication;
      },
      validateCorrectionBoundary: async (plan, causes, atomDigest) => {
        await host.assertCurrent(plan);
        const state = (await options.cohorts.snapshot()).portable;
        const run = state.investigationRuns.findLast((entry) => entry.plan.planDigest === plan.planDigest);
        if (run === undefined) throw new Error("correction boundary lacks its durable member evidence");
        const candidate = (await correctionCandidates(journal, run)).find((entry) => entry.atom.atomDigest === atomDigest);
        if (candidate === undefined || candidate.atom.phase !== "implementation" || causes.length !== plan.members.length ||
          causes.some((cause, index) => digest(cause) !== digest(run.members[index]!.confirmedCause) ||
            cause.correctionBoundaryDigest !== candidate.correctionBoundaryDigest)) {
          throw new Error("correction boundary lacks one authenticated implementation proposal with separate confirmed member causes");
        }
        const payload = { kind: "cq-investigation-correction-eligibility" as const, version: 1 as const,
          planDigest: plan.planDigest, candidate, confirmedCauses: causes };
        const receipt = { ...payload, receiptDigest: digest(payload) };
        if (journal.correctionEligibility !== undefined && digest(journal.correctionEligibility) !== digest(receipt)) {
          throw new Error("retained implementation correction eligibility changed on revalidation");
        }
        journal.correctionEligibility = receipt;
        publish(journal);
      },
    });
    const prepare = host.prepare.bind(host);
    host.prepare = async (binding) => {
      const retained = journal.launches.find((launch) => launch.investigation.binding.bindingDigest === binding.bindingDigest);
      if (retained !== undefined) return retained.investigation;
      const investigation = await prepare(binding);
      journal.launches.push({ investigation, prepared: host.preparedLaunch(investigation) });
      publish(journal);
      publishPrivateCohortJournalV1(launchIndexPath(investigation.handle), { planDigest: journal.plan.planDigest, preparedDigest: investigation.preparedDigest });
      return investigation;
    };
    host.execute = async () => undefined;
    return host;
  };
  const result = async (journal: PrivateInvestigationJournal, run: InvestigationCohortRunV1): Promise<CohortInvestigationAdvanceResultV1> => {
    const launches = run.members.flatMap((member) => [
      ...(member.explorer !== null && member.explorerResult === null ? [member.explorer] : []),
      ...(member.prober !== null && member.proberResult === null ? [member.prober] : []),
    ]).map((prepared) => {
      const launch = journal.launches.find((entry) => entry.investigation.preparedDigest === prepared.preparedDigest);
      if (launch === undefined) throw new Error("durable investigation dispatch lost its private launch reference");
      const indexPath = launchIndexPath(prepared.handle);
      const index = { planDigest: journal.plan.planDigest, preparedDigest: prepared.preparedDigest };
      if (!existsSync(indexPath)) publishPrivateCohortJournalV1(indexPath, index);
      else if (digest(JSON.parse(readFileSync(indexPath, "utf8"))) !== digest(index)) throw new Error("private native launch index names another prepared investigation");
      return { ...launch, nativeBinding: nativeLaunchBinding(journal, launch.investigation) };
    });
    const adjudicationRequests = run.members.flatMap((member, index) => member.adjudication === null && member.explorerResult !== null &&
      (member.explorerResult.output.probeRequest === undefined || member.proberResult !== null)
      ? [{ defectRef: run.plan.members[index]!.defectRef, evidenceDigest: evidenceDigest(run, index) }] : []);
    return structuredClone({ planDigest: journal.plan.planDigest, run, launches, adjudicationRequests, probeEvidence: journal.probes,
      correctionCandidates: run.state === "split" ? [] : await correctionCandidates(journal, run), correctionEligibility: journal.correctionEligibility ?? null,
      state: run.state === "split" || run.state === "correction-ready" ? run.state : launches.length > 0 ? "awaiting-launch" : adjudicationRequests.length > 0 ? "awaiting-adjudication" : "awaiting-evidence" });
  };
  return {
    resolveLaunchAuthority: async (input) => {
      const handle = assertDispatchHandle(input);
      const path = launchIndexPath(handle);
      if (!existsSync(path)) return null;
      const index = z.object({ planDigest: z.string().regex(/^[a-f0-9]{64}$/u), preparedDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(JSON.parse(readFileSync(path, "utf8")));
      const journal = read(index.planDigest);
      const launch = journal.launches.find((entry) => entry.investigation.preparedDigest === index.preparedDigest && digest(entry.investigation.handle) === digest(handle));
      if (launch === undefined || journal.lease === null) throw new Error("native investigation launch lacks exact private preparation authority");
      const host = hostFor(journal);
      const assertCurrent = async () => { await options.cohorts.assertLiveAuthority(journal.lease!); await host.assertCurrent(journal.plan); };
      await assertCurrent();
      const targetRef = `cq-cohort-effect:v1:${journal.plan.planDigest}`;
      return { binding: nativeLaunchBinding(journal, launch.investigation), roleId: launch.investigation.binding.role.roleId, memberRef: launch.investigation.binding.member.defectRef,
        planDigest: journal.plan.planDigest, preparedDigest: launch.investigation.preparedDigest,
        executionEpoch: journal.lease.executionEpoch, members: journal.plan.members.map(({ defectRef, defectRevision, hypothesisRef, hypothesisRevision }) => ({ defectRef, defectRevision, hypothesisRef, hypothesisRevision })),
        expectedChild: launch.investigation.expectedChild, targetRef,
        provider: investigationAdmissionProvider(options.workset, journal.plan, assertCurrent) };
    },
    advance: async (raw) => {
    const input = COHORT_INVESTIGATION_ADVANCE_SCHEMA.parse(raw);
    return withManagedCohortAuthorityWriterLock(options.repositoryRoot, { stateDir: options.journalRoot }, async () => {
      let journal: PrivateInvestigationJournal;
      if (input.operation === "prepare") {
        const state = (await options.cohorts.snapshot()).portable;
        const definition = state.definitions.find((value) => value.definitionDigest === input.definitionDigest);
        if (definition === undefined || definition.phase !== "investigation") throw new Error("investigation prepare requires an observed investigation definition");
        const observation = resolveCohortDefinitionObservationV1({ definition, observations: state.observations, decisions: state.decisions });
        const admissionPlan = parseCohortAdmissionPlanV1(input.admissionPlan);
        const plan = createInvestigationCohortPlanV1({ definition, observation,
          explorer: readInvestigationRoleContractV1(options.promptArtifacts, "investigate-explorer"),
          prober: readInvestigationRoleContractV1(options.promptArtifacts, "investigate-prober"),
          members: input.members.map((member) => {
            const observed = observation.members.find((entry) => entry.memberRef === member.defectRef);
            if (observed === undefined || observed.phase !== "investigation") throw new Error("investigation member is outside its observed definition");
            return { ...member, defectRevision: observed.defectRevision, hypothesisRef: observed.hypothesisRef,
              hypothesisRevision: observed.hypothesisRevision, statement: options.hypothesisStatement(observed.hypothesisRef) };
          }),
        });
        journal = existsSync(journalPath(plan.planDigest)) ? read(plan.planDigest) : { version: 1, admissionPlan,
          plan, lease: null, launches: [], adjudications: [], probes: [] };
        if (digest(journal.admissionPlan) !== digest(admissionPlan)) throw new Error("investigation preparation changed its admission proposal");
      } else journal = read(input.planDigest);
      const host = hostFor(journal);
      const runner = new InvestigationCohortRunnerV1(options.cohorts, host);
      await host.assertCurrent(journal.plan);
      const state = await options.cohorts.snapshot();
      if (input.operation === "resume") {
        if (state.runtime.lease !== null) throw new Error("investigation resume cannot replace a live execution lease");
        await runner.revalidateForResume(journal.plan);
        journal.lease = null;
      } else if (state.runtime.resumeRequired || (journal.lease !== null && journal.lease.executionEpoch !== state.runtime.executionEpoch)) {
        throw new Error("investigation execution epoch changed; explicit resume is required");
      }
      let lease: WorkCohortLeaseV1;
      if (state.runtime.lease !== null) {
        if (journal.lease === null) throw new Error("investigation lacks its retained private lease");
        await options.cohorts.assertLiveAuthority(journal.lease);
        lease = journal.lease;
      } else lease = await options.cohorts.acquireLeaseAndPublish({ holderId: `investigation:${journal.plan.planDigest}`, semanticSubject: journal.plan.planDigest }, (fresh) => {
        journal.lease = fresh; publish(journal); return undefined;
      });
      try {
        if (input.operation === "propose-correction") {
          const run = (await options.cohorts.snapshot()).portable.investigationRuns.findLast((entry) => entry.plan.planDigest === journal.plan.planDigest);
          if (run === undefined || run.state === "split" || journal.adjudications.length > 0) throw new Error("propose correction after collection and before adjudication");
          const proposal = parseCohortAdmissionPlanV1(input.proposal);
          if (journal.correctionProposal !== undefined && digest(journal.correctionProposal) !== digest(proposal)) throw new Error("retained correction proposal cannot be substituted");
          const proposed = { ...journal, correctionProposal: proposal };
          if ((await correctionCandidates(proposed, run)).length === 0) throw new Error("correction proposal has no common implementation boundary");
          journal.correctionProposal = proposal;
          publish(journal);
        }
        if (input.operation === "adjudicate") {
          const run = (await options.cohorts.snapshot()).portable.investigationRuns.findLast((entry) => entry.plan.planDigest === journal.plan.planDigest);
          if (run === undefined) throw new Error("investigation has no consumed evidence to adjudicate");
          if (new Set(input.members.map((member) => member.defectRef)).size !== input.members.length) throw new Error("duplicate member adjudication");
          for (const decision of input.members) {
            const index = run.plan.members.findIndex((member) => member.defectRef === decision.defectRef);
            const member = run.members[index];
            if (member === undefined || member.explorerResult === null ||
              (member.explorerResult.output.probeRequest !== undefined && member.proberResult === null) ||
              decision.evidenceDigest !== evidenceDigest(run, index)) throw new Error("adjudication requires exact complete member evidence");
            const prior = journal.adjudications.find((entry) => entry.defectRef === decision.defectRef);
            if (prior !== undefined && digest(prior) !== digest(decision)) throw new Error("parent adjudication changed; record a new hypothesis/definition");
            if (prior === undefined) journal.adjudications.push(decision);
          }
          publish(journal);
        }
        if (input.operation === "probe") await runProbe(options, journal, lease, host, input, publish);
        return await result(journal, await runner.run(lease, journal.plan));
      } finally {
        const pending = await Promise.all(journal.launches.map(async (launch) => await host.authenticate(launch.investigation) === null));
        if (!pending.some(Boolean)) await options.cohorts.releaseLease(lease);
      }
    });
  } };
}

async function runProbe(options: InvestigationAdvanceDependenciesV1, journal: PrivateInvestigationJournal, lease: WorkCohortLeaseV1,
  host: DispatchInvestigationCohortHostV1, input: ProbeInput, publish: (journal: PrivateInvestigationJournal) => void): Promise<void> {
  const launch = journal.launches.find((entry) => entry.investigation.preparedDigest === input.preparedDigest);
  if (launch === undefined || launch.investigation.binding.role.roleId !== "investigate-prober") throw new Error("probe must name its exact prepared investigation prober");
  const prior = journal.probes.find((entry) => entry.preparedDigest === input.preparedDigest && entry.citation === input.citation);
  if (prior !== undefined) {
    if (digest(prior.command) !== digest(input.command)) throw new Error("probe citation already binds another normalized command");
    return;
  }
  const root = await realpath(options.repositoryRoot);
  const cwd = await realpath(resolve(root, input.command.cwd));
  const contained = relative(root, cwd);
  if (isAbsolute(input.command.cwd) || contained === ".." || contained.startsWith("../")) throw new Error("probe cwd escapes the repository");
  const assertCurrent = async () => { await options.cohorts.assertLiveAuthority(lease); await host.assertCurrent(journal.plan); };
  const targetRef = `cq-cohort-effect:v1:${journal.plan.planDigest}`;
  const provider = investigationAdmissionProvider(options.workset, journal.plan, assertCurrent);
  const execution = await options.commands.run({ command: input.command, worktreePath: root,
    admissionTimeoutMs: SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS, executionTimeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
    cancellationSignal: options.cancellationSignal, effectAdmission: { provider, targetRef } });
  await assertCurrent();
  journal.probes.push({ preparedDigest: input.preparedDigest, citation: input.citation, command: input.command,
    executionId: execution.executionId, outputDigest: execution.outputDigest, outputTail: redactSecrets(execution.outputTail),
    completeOutput: execution.completeOutput === undefined ? null : redactSecrets(execution.completeOutput),
    capturedAt: execution.capturedAt, exitCode: execution.gateExitCode });
  publish(journal);
}

function investigationAdmissionProvider(workset: WorksetStore, plan: InvestigationCohortPlanV1, assertCurrent: () => Promise<void>): WorksetEffectAdmissionProvider {
  const targetRef = `cq-cohort-effect:v1:${plan.planDigest}`;
  return { acquire: async (request) => {
    if (request.kind !== "child-dispatch" || request.targetRef !== targetRef) throw new Error("investigation probe changed its effect target");
    await assertCurrent();
    const admission = await workset.admitExternalEffect({ kind: request.kind, targetRef, cohortTargets: plan.members.map((member) => member.defectRef) });
    try { await assertCurrent(); } catch (error) { await admission.abandonBeforeRegistration(); throw error; }
    return { id: admission.id, epoch: admission.epoch, kind: admission.kind, targetRef,
      registerProcessGroup: async (group) => { await assertCurrent(); await admission.registerProcessGroup(group); },
      shareWithGuardian: async (group) => { await assertCurrent(); await admission.shareWithGuardian(group); },
      markSettled: () => admission.markSettled(), releaseAfterSettlement: () => admission.releaseAfterSettlement(),
      abandonBeforeRegistration: () => admission.abandonBeforeRegistration() };
  } };
}

export async function createCohortInvestigationAdvanceRuntimeV1(options: CohortInvestigationAdvanceRuntimeOptionsV1): Promise<CohortInvestigationAdvanceRuntimeV1 | undefined> {
  const { resolved } = options;
  if (resolved.backend !== "xdg" || resolved.store.workCohortStore === undefined || resolved.dbPath === undefined) return undefined;
  const repositoryRoot = await realpath(resolved.configRoot);
  const common = await nodeManagedWorktreeGitRunner(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0 && common.stderr.includes("not a git repository")) return undefined;
  if (common.code !== 0) throw new Error(`investigation repository identity failed: ${common.stderr}`);
  const commonDir = await realpath(common.stdout.trim());
  const repositoryId = createHash("sha256").update(`${repositoryRoot}\n${commonDir}`).digest("hex");
  const repository = new GitCohortLocalRepositoryV1({ repositoryRoot, repositoryId });
  const workset = requireWorksetStore(resolved.store);
  return createInvestigationAdvanceCapabilityV1({ cohorts: resolved.store.workCohortStore(), backend: options.backend,
    dispatch: options.dispatch, promptArtifacts: options.promptArtifacts, repositoryRoot,
    journalRoot: options.stateDir ?? dirname(resolved.dbPath), cancellationSignal: options.cancellationSignal,
    commands: options.trustedCommandRunner ?? createNodeSupervisedWorkerCommandRunner({ settleProcessGroups, settleWorktreeGateCommands }), workset,
    source: (plan) => {
      const catalogHash = options.promptArtifacts.readManifest().catalogHash;
      if (catalogHash === undefined) throw new Error("investigation requires the installed prompt catalogue identity");
      const environment = { environmentDigest: digest({ catalogHash,
        runtime: { executable: process.execPath, bun: Bun.version, platform: process.platform, architecture: process.arch } }) };
      return new LedgerWorksetCohortAdmissionObservationSourceV1({ repository, ledger: resolved.store, workset, plan, environment });
    },
    hypothesisStatement: (ref) => {
      const item = resolved.store.fetchItem("hypothesis", ref.slice("hypothesis:".length));
      const statement = item.fields["headline"];
      if (typeof statement !== "string" || statement.trim() === "") throw new Error(`${ref} lacks its canonical hypothesis statement`);
      return statement;
    },
  });
}
