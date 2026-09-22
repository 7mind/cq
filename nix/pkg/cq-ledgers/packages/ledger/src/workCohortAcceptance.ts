import {
  cohortValueDigestV1 as digest,
  createCohortEffectEnvelopeV1,
  resolveCohortDefinitionObservationV1,
  type CohortAcceptanceMatrixV1,
  type CohortBoundaryIdentityV1,
  type CohortCandidateSealV1,
  type CohortDefinitionIdentityV1,
  type MemberAcceptancePlanV1,
  type StagedCohortCandidateAttemptV1,
} from "./workCohort.js";
import type {
  CohortCommandEvidenceV1,
  WorkCohortLeaseV1,
  WorkCohortStore,
} from "./workCohortStore.js";
import { redactSecrets } from "./store/logRedaction.js";
import { createCohortActivityV1, type CohortActivityV1, type CohortActivityMeasurementV1 } from "./workCohortActivity.js";
import {
  readAuthorizedCohortG213GateV1,
  validateCohortG213GateReceiptV1,
  type AuthorizedCohortG213GateV1,
  type CohortG213GateReceiptV1,
} from "./workCohortGate.js";

const COMMAND_DIAGNOSTIC_CHARACTER_LIMIT = 2048;
const COMMAND_BOUNDARY_PREFIX = "cq-cohort-command:v1:";

export interface CohortCommandV1 {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
}

export interface CohortCommandOutcomeV1 {
  readonly executionId: string;
  readonly exitCode: number;
  readonly outputDigest: string;
  readonly outputTail: string;
}

export interface CohortCommandExecutionV1 {
  readonly kind: "cq-cohort-command-execution";
  readonly version: 1;
  readonly evidenceSubjectDigest: string;
  readonly acceptanceMatrixDigest: string;
  readonly atomDigest: string;
  readonly environmentDigest: string;
  readonly authorizingExecutionEpoch: string;
  readonly purpose: "focused" | "shared-regression" | "full-gate";
  readonly command: CohortCommandV1;
  readonly commandDigest: string;
  readonly memberPlanDigests: readonly string[];
  readonly boundaryDigest: string | null;
  readonly outcome: CohortCommandOutcomeV1;
  readonly canonicalGate: CohortG213GateReceiptV1 | null;
  readonly receiptDigest: string;
}

class IssuedCohortCommandExecutionV1 {
  readonly #receipt: CohortCommandExecutionV1;

  constructor(receipt: CohortCommandExecutionV1) {
    this.#receipt = structuredClone(receipt);
  }

  receipt(): CohortCommandExecutionV1 {
    return structuredClone(this.#receipt);
  }
}

export type AuthorizedCohortCommandExecutionV1 = IssuedCohortCommandExecutionV1;

export function readAuthorizedCohortCommandExecutionV1(
  value: AuthorizedCohortCommandExecutionV1,
): CohortCommandExecutionV1 {
  if (!(value instanceof IssuedCohortCommandExecutionV1)) {
    throw new Error("cohort command evidence requires a runner-issued receipt");
  }
  return value.receipt();
}

export interface CohortAcceptanceCandidateV1 {
  readonly definition: CohortDefinitionIdentityV1;
  readonly seal: CohortCandidateSealV1;
  readonly attempt: StagedCohortCandidateAttemptV1;
  readonly evidenceSubjectDigest: string;
  readonly matrix: CohortAcceptanceMatrixV1;
}

export interface CohortAcceptanceHostV1 {
  withCandidateLock<T>(candidate: CohortAcceptanceCandidateV1, run: () => Promise<T>): Promise<T>;
  revalidateCandidate(candidate: CohortAcceptanceCandidateV1): Promise<void>;
  resolveBoundaryCommand(boundary: CohortBoundaryIdentityV1): Promise<CohortCommandV1>;
  runCommand(command: CohortCommandV1, signal: AbortSignal): Promise<CohortCommandOutcomeV1>;
  runCanonicalQueueGate(candidate: CohortAcceptanceCandidateV1, command: CohortCommandV1,
    signal: AbortSignal): Promise<{ readonly outcome: CohortCommandOutcomeV1; readonly gate: AuthorizedCohortG213GateV1 | null }>;
  revalidateCanonicalGate(candidate: CohortAcceptanceCandidateV1, receipt: CohortG213GateReceiptV1): Promise<void>;
}

export class CohortAcceptanceRejectedError extends Error {
  readonly evidence: CohortCommandEvidenceV1;

  constructor(evidence: CohortCommandEvidenceV1) {
    super(`cohort ${evidence.evidenceKind} rejected its exact candidate`);
    this.name = "CohortAcceptanceRejectedError";
    this.evidence = evidence;
  }
}

function commandOf(plan: CohortCommandV1): CohortCommandV1 {
  if (plan.argv.length === 0 || plan.argv.some((arg) => arg.length === 0 || arg.includes("\0")) ||
      plan.cwd.length === 0 || plan.cwd.includes("\0") || plan.cwd.startsWith("/") ||
      plan.cwd.split(/[\\/]/).includes("..")) {
    throw new Error("cohort command requires exact argv and a repository-relative cwd");
  }
  const environment = [...plan.environment].sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(environment.map(({ name }) => name)).size !== environment.length ||
      environment.some(({ name, value }) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0"))) {
    throw new Error("cohort command environment must have distinct valid names");
  }
  return { argv: [...plan.argv], cwd: plan.cwd, environment };
}

export function createCohortCommandBoundaryV1(command: CohortCommandV1): CohortBoundaryIdentityV1 {
  const normalized = commandOf(command);
  return { identity: `${COMMAND_BOUNDARY_PREFIX}${JSON.stringify(normalized)}`, digest: digest(normalized) };
}

export function resolveCohortCommandBoundaryV1(boundary: CohortBoundaryIdentityV1): CohortCommandV1 {
  if (!boundary.identity.startsWith(COMMAND_BOUNDARY_PREFIX)) throw new Error("cohort command boundary lacks an explicit frozen command");
  const value: unknown = JSON.parse(boundary.identity.slice(COMMAND_BOUNDARY_PREFIX.length));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("cohort command boundary must contain a closed command");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join(",") !== "argv,cwd,environment" ||
      !Array.isArray(record["argv"]) || !record["argv"].every((entry) => typeof entry === "string") ||
      typeof record["cwd"] !== "string" || !Array.isArray(record["environment"]) ||
      !record["environment"].every((entry: unknown) => typeof entry === "object" && entry !== null &&
        Object.keys(entry).sort().join(",") === "name,value" &&
        typeof (entry as Record<string, unknown>)["name"] === "string" && typeof (entry as Record<string, unknown>)["value"] === "string")) {
    throw new Error("cohort command boundary must contain exact argv, cwd, and environment");
  }
  const command = commandOf(value as CohortCommandV1);
  if (digest(command) !== boundary.digest || createCohortCommandBoundaryV1(command).identity !== boundary.identity) {
    throw new Error("cohort command boundary digest or canonical declaration changed");
  }
  return command;
}

export function validateCohortCommandExecutionV1(receipt: CohortCommandExecutionV1): void {
  const { receiptDigest, ...payload } = receipt;
  if (receipt.kind !== "cq-cohort-command-execution" || receipt.version !== 1 ||
      digest(payload) !== receiptDigest || digest(commandOf(receipt.command)) !== receipt.commandDigest ||
      receipt.outcome.executionId.length === 0 || !Number.isInteger(receipt.outcome.exitCode) ||
      receipt.outcome.exitCode < 0 || !/^[0-9a-f]{64}$/.test(receipt.outcome.outputDigest) ||
      typeof receipt.outcome.outputTail !== "string" ||
      receipt.outcome.outputTail.length > COMMAND_DIAGNOSTIC_CHARACTER_LIMIT) {
    throw new Error("cohort command execution receipt is inconsistent");
  }
}

export function validateCohortExecutionBindingV1(
  receipt: CohortCommandExecutionV1,
  candidate: CohortAcceptanceCandidateV1,
): void {
  validateCohortCommandExecutionV1(receipt);
  if (receipt.evidenceSubjectDigest !== candidate.evidenceSubjectDigest ||
      receipt.acceptanceMatrixDigest !== candidate.matrix.matrixDigest ||
      receipt.atomDigest !== candidate.definition.selectedAtomDigest ||
      receipt.environmentDigest !== candidate.definition.environment.environmentDigest) {
    throw new Error("cohort command execution differs from the sealed candidate binding");
  }
  if (receipt.purpose === "focused") {
    const commandClass = candidate.matrix.normalizedCommandClasses.find(
      (entry) => entry.normalizedCommandDigest === receipt.commandDigest,
    );
    const expectedPlans = candidate.matrix.members.filter(
      (member) => commandClass !== undefined && commandClass.memberRefs.includes(member.memberRef),
    ).map((member) => member.focusedPlanDigest).sort();
    if (expectedPlans.length === 0 || digest(expectedPlans) !== digest(receipt.memberPlanDigests) ||
        receipt.boundaryDigest !== null) {
      throw new Error("cohort focused receipt omits or substitutes frozen member plans");
    }
  } else {
    const boundary = receipt.purpose === "shared-regression"
      ? candidate.matrix.sharedRegression : candidate.matrix.canonicalFullGate;
    if (receipt.memberPlanDigests.length !== 0 || receipt.boundaryDigest !== boundary.digest) {
      throw new Error("cohort boundary receipt differs from the frozen matrix");
    }
  }
  if (receipt.purpose === "full-gate" && receipt.outcome.exitCode === 0) {
    const gate = receipt.canonicalGate;
    if (gate === null || gate.candidateAttemptDigest !== candidate.attempt.candidateAttemptDigest ||
        gate.sealDigest !== candidate.seal.sealDigest || gate.attemptId !== candidate.attempt.g213.attemptId) {
      throw new Error("cohort full gate receipt lacks authenticated candidate completion");
    }
    validateCohortG213GateReceiptV1(gate, candidate.attempt, candidate.seal);
  } else if (receipt.canonicalGate !== null) {
    throw new Error("only a green canonical full gate may carry G213 completion");
  }
}

/** The host supplies the existing managed lock and G213 front-gate service, never a second queue. */
export class CohortAcceptanceRunnerV1 {
  readonly #store: WorkCohortStore;
  readonly #host: CohortAcceptanceHostV1;

  constructor(store: WorkCohortStore, host: CohortAcceptanceHostV1) {
    this.#store = store;
    this.#host = host;
  }

  async run(lease: WorkCohortLeaseV1, signal: AbortSignal): Promise<{
    readonly evidence: readonly CohortCommandEvidenceV1[];
    readonly focusedExecutions: number;
    readonly focusedDeduplications: number;
    readonly sharedExecutions: number;
    readonly sharedReuses: number;
    readonly fullGateExecutions: number;
    readonly persistedReuses: number;
  }> {
    await this.#store.assertLiveAcceptanceAuthority(lease);
    const state = (await this.#store.snapshot()).portable;
    const subject = state.evidenceSubjects.find((entry) => entry.evidenceSubjectDigest === lease.semanticSubject);
    const definition = state.definitions.find((entry) => entry.definitionDigest === subject?.definitionDigest);
    const seal = state.candidateSeals.find((entry) => entry.sealDigest === subject?.sealDigest);
    const matrix = state.frozenMatrices.find((entry) => entry.matrixDigest === definition?.acceptanceMatrixDigest);
    const attempt = state.candidateAttempts.find((entry) => entry.candidateAttemptDigest === seal?.candidateAttemptDigest);
    if (subject === undefined || definition === undefined || seal === undefined || matrix === undefined ||
        attempt === undefined || attempt.state !== "staged" || definition.phase !== "implementation") {
      throw new Error("cohort acceptance requires a sealed implementation candidate");
    }
    const candidate: CohortAcceptanceCandidateV1 = {
      definition, seal, attempt, matrix, evidenceSubjectDigest: subject.evidenceSubjectDigest,
    };
    const observation = resolveCohortDefinitionObservationV1({ definition, decisions: state.decisions, observations: state.observations });
    const effectEnvelope = createCohortEffectEnvelopeV1({ definition, observation, intent: attempt.intent,
      evidenceSubject: subject, executionEpoch: lease.executionEpoch });
    const plans = matrix.members.map((member) => {
      const plan = state.observations.flatMap((observation) => observation.members)
        .flatMap((entry) => entry.attestations)
        .find((entry) => entry.atomDigest === matrix.atomDigest &&
          entry.acceptancePlan.planDigest === member.focusedPlanDigest)?.acceptancePlan;
      if (plan === undefined || plan.memberRef !== member.memberRef ||
          plan.memberRevision !== member.memberRevision || digest(commandOf(plan)) !== plan.normalizedCommandDigest) {
        throw new Error("cohort matrix lacks its exact frozen focused plan");
      }
      const { planDigest, ...payload } = plan;
      if (digest(payload) !== planDigest) throw new Error("cohort focused plan digest is inconsistent");
      return plan;
    });
    const classes = new Map<string, string[]>();
    for (const plan of plans) {
      const members = classes.get(plan.normalizedCommandDigest) ?? [];
      members.push(plan.memberRef);
      classes.set(plan.normalizedCommandDigest, members);
    }
    const expectedClasses = [...classes.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([normalizedCommandDigest, memberRefs]) => ({ normalizedCommandDigest, memberRefs: memberRefs.sort() }));
    if (digest(expectedClasses) !== digest(matrix.normalizedCommandClasses)) {
      throw new Error("cohort matrix command classes omit or substitute member plans");
    }
    return this.#host.withCandidateLock(candidate, async () => {
      const evidence: CohortCommandEvidenceV1[] = [];
      const counters = { focusedExecutions: 0, focusedDeduplications: 0, sharedExecutions: 0,
        sharedReuses: 0, fullGateExecutions: 0, persistedReuses: 0 };
      const executions: CohortActivityV1["executions"] = [];
      const measured: Partial<Record<CohortActivityMeasurementV1, number>> = {};
      const measure = (measurement: CohortActivityMeasurementV1) => { measured[measurement] = (measured[measurement] ?? 0) + 1; };
      try {
      const revalidate = async () => {
        signal.throwIfAborted();
        await this.#store.assertLiveCohortAuthority(lease, effectEnvelope);
        await this.#host.revalidateCandidate(candidate);
      };
      await revalidate();
      const execute = async (
        purpose: CohortCommandExecutionV1["purpose"], command: CohortCommandV1,
        memberPlans: readonly MemberAcceptancePlanV1[], boundaryDigest: string | null,
      ) => {
        await revalidate();
        const commandDigest = digest(command);
        if (purpose === "full-gate" && commandDigest !== digest({
          argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [],
        })) throw new Error("cohort full gate must use the fixed canonical command");
        const memberPlanDigests = memberPlans.map((plan) => plan.planDigest).sort();
        const records = (await this.#store.snapshot()).portable.commandEvidence;
        if (boundaryDigest !== null && records.some((entry) => entry.execution !== null &&
            entry.evidenceSubjectDigest === subject.evidenceSubjectDigest &&
            entry.execution.purpose === purpose && entry.execution.boundaryDigest === boundaryDigest &&
            entry.execution.commandDigest !== commandDigest)) {
          measure("evidenceRejections");
          throw new Error("cohort boundary command changed without a new definition");
        }
        let reusable: CohortCommandEvidenceV1 | undefined;
        try {
        reusable = records.findLast((entry) => {
          const execution = entry.execution;
          if (execution === null || entry.evidenceSubjectDigest !== subject.evidenceSubjectDigest ||
              execution.purpose !== purpose || execution.commandDigest !== commandDigest ||
              digest(execution.memberPlanDigests) !== digest(memberPlanDigests) ||
              execution.boundaryDigest !== boundaryDigest) return false;
          validateCohortExecutionBindingV1(execution, candidate);
          if (entry.receiptDigest !== execution.receiptDigest || entry.evidenceKind !== execution.purpose ||
              entry.passed !== (execution.outcome.exitCode === 0)) {
            throw new Error("cohort evidence differs from its runner receipt");
          }
          return true;
        });
        } catch (error) { measure("evidenceRejections"); throw error; }
        if (reusable !== undefined && reusable.passed) {
          if (purpose === "full-gate") {
            const gate = reusable.execution?.canonicalGate;
            if (gate === undefined || gate === null) throw new Error("cohort full gate reuse lacks G213 authority");
            try { await this.#host.revalidateCanonicalGate(candidate, gate); }
            catch (error) { measure("evidenceRejections"); throw error; }
          }
          counters.persistedReuses += 1;
          evidence.push(reusable);
          return;
        }
        const focusedReuse = purpose === "shared-regression" ? evidence.find((entry) =>
          entry.passed && entry.execution !== null && entry.execution.purpose === "focused" &&
          entry.execution.commandDigest === commandDigest) : undefined;
        let outcome: CohortCommandOutcomeV1;
        let canonicalGate: CohortG213GateReceiptV1 | null = null;
        if (focusedReuse?.execution !== undefined && focusedReuse.execution !== null) {
          validateCohortExecutionBindingV1(focusedReuse.execution, candidate);
          outcome = focusedReuse.execution.outcome;
          counters.sharedReuses += 1;
        } else if (purpose === "full-gate") {
          measure("fullGateAttempts");
          const completed = await this.#host.runCanonicalQueueGate(candidate, command, signal);
          outcome = completed.outcome;
          executions.push({ purpose, executionId: outcome.executionId });
          if (outcome.exitCode === 0) {
            if (completed.gate === null) throw new Error("cohort full gate requires authenticated G213 completion");
            canonicalGate = readAuthorizedCohortG213GateV1(completed.gate);
            await this.#host.revalidateCanonicalGate(candidate, canonicalGate);
          }
          counters.fullGateExecutions += 1;
        } else {
          measure(purpose === "focused" ? "focusedAttempts" : "sharedAttempts");
          outcome = await this.#host.runCommand(command, signal);
          executions.push({ purpose, executionId: outcome.executionId });
          if (purpose === "focused") counters.focusedExecutions += 1;
          else counters.sharedExecutions += 1;
        }
        await revalidate();
        const payload = {
          kind: "cq-cohort-command-execution" as const, version: 1 as const,
          evidenceSubjectDigest: subject.evidenceSubjectDigest,
          acceptanceMatrixDigest: matrix.matrixDigest, atomDigest: matrix.atomDigest,
          environmentDigest: definition.environment.environmentDigest,
          authorizingExecutionEpoch: lease.executionEpoch,
          purpose, command, commandDigest, memberPlanDigests, boundaryDigest, canonicalGate,
          outcome: { ...outcome, outputTail: redactSecrets(outcome.outputTail).slice(-COMMAND_DIAGNOSTIC_CHARACTER_LIMIT) },
        };
        const receipt = { ...payload, receiptDigest: digest(payload) };
        validateCohortExecutionBindingV1(receipt, candidate);
        const stored = await this.#store.recordProtectedCommandEvidence(
          `command:${receipt.receiptDigest}`, lease, new IssuedCohortCommandExecutionV1(receipt),
        );
        evidence.push(stored);
        if (!stored.passed) throw new CohortAcceptanceRejectedError(stored);
      };
      for (const commandClass of matrix.normalizedCommandClasses) {
        const members = plans.filter((plan) => commandClass.memberRefs.includes(plan.memberRef));
        const first = members[0];
        if (first === undefined || members.some((plan) => plan.normalizedCommandDigest !== commandClass.normalizedCommandDigest)) {
          throw new Error("cohort focused command class differs from its member plans");
        }
        counters.focusedDeduplications += members.length - 1;
        await execute("focused", commandOf(first), members, null);
      }
      await execute("shared-regression", commandOf(await this.#host.resolveBoundaryCommand(matrix.sharedRegression)),
        [], matrix.sharedRegression.digest);
      await execute("full-gate", commandOf(await this.#host.resolveBoundaryCommand(matrix.canonicalFullGate)),
        [], matrix.canonicalFullGate.digest);
      await revalidate();
      return { evidence, ...counters };
      } catch (error) {
        measure("acceptanceFailures");
        if (error instanceof CohortAcceptanceRejectedError && error.evidence.evidenceKind === "shared-regression") measure("sharedRejections");
        throw error;
      } finally {
        measured.focusedDeduplications = counters.focusedDeduplications;
        measured.sharedReuses = counters.sharedReuses;
        measured.persistedEvidenceReuses = counters.persistedReuses;
        const measurements = (Object.entries(measured) as [CohortActivityMeasurementV1, number][])
          .filter(([, value]) => value > 0).map(([measurement, value]) => ({ measurement, value }));
        if (executions.length > 0 || measurements.length > 0) await this.#store.recordActivity(createCohortActivityV1({
          semanticSubject: subject.evidenceSubjectDigest, executionEpoch: lease.executionEpoch, executions, measurements,
        }));
      }
    });
  }
}
