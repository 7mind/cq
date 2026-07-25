import { createHash } from "node:crypto";
import {
  PlanClaimInputSchema,
  PlanClaimResultSchema,
  PlanFinalizeInputSchema,
  PlanFinalizeResultSchema,
  PlanPrivateClaimRecordSchema,
  PlanPublishDraftInputSchema,
  PlanPublishDraftResultSchema,
  PlanReleaseInputSchema,
  PlanReleaseResultSchema,
  replayPlanClaim,
  resolvePlanClaimPhase,
  resolvePlanFinalizeDraftBinding,
  resolvePlanOperationReplay,
  type PlanClaimInput,
  type PlanClaimResult,
  type PlanConflict,
  type PlanDraftIdentity,
  type PlanDraftReference,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanIdAllocation,
  type PlanLifecycleStore,
  type PlanOperationReplayRecord,
  type PlanPrivateClaimRecord,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanPublishedManifest,
  type PlanReleaseInput,
  type PlanReleaseResult,
  type PlanReviewDefectBatch,
  type PlanWriteProvenance,
} from "../src/index.js";

export type ReferenceGoalPhase =
  | "clarifying"
  | "planning"
  | "planned"
  | "building"
  | "done"
  | "abandoned";

export interface ReferencePublicClaim {
  readonly goalId: string;
  readonly claimId: string;
  readonly generation: number;
  readonly purpose: "initial" | "follow-up";
}

export interface ReferencePublicMilestone {
  readonly id: string;
  readonly goalId: string;
  readonly status: "open" | "postponed";
  readonly title: string;
  readonly description: string | null;
  readonly dependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly taskIds: readonly string[];
  readonly provenance: PlanWriteProvenance;
}

export interface ReferencePublicTask {
  readonly id: string;
  readonly goalId: string;
  readonly milestoneId: string;
  readonly status: "planned" | "wip" | "blocked" | "done" | "abandoned";
  readonly headline: string;
  readonly description: string | null;
  readonly acceptance: string | null;
  readonly suggestedModel: string | null;
  readonly sourceRefs: readonly string[];
  readonly tags: readonly string[];
  readonly dependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly executable: boolean;
  readonly provenance: PlanWriteProvenance;
}

export interface ReferencePublicEffectItem {
  readonly id: string;
  readonly goalId: string;
  readonly status: string;
  readonly text: string;
  readonly provenance: PlanWriteProvenance;
}

export interface ReferencePublicQuestion extends ReferencePublicEffectItem {
  readonly context: string | null;
  readonly suggestions: readonly string[];
  readonly recommendation: string | null;
}

export interface ReferencePublicResearch extends ReferencePublicEffectItem {
  readonly scope: string | null;
}

export interface ReferencePublicDefect extends ReferencePublicEffectItem {
  readonly reviewId: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly description: string | null;
  readonly rootCause: string | null;
  readonly suggestedFix: string | null;
  readonly sourceRefs: readonly string[];
  readonly tags: readonly string[];
}

export interface ReferencePublicReview {
  readonly id: string;
  readonly goalId: string;
  readonly status: "go-ahead" | "revise";
  readonly draft: PlanDraftIdentity;
  readonly provenance: PlanWriteProvenance;
}

export interface ReferencePublicDecision extends ReferencePublicEffectItem {
  readonly reviewId: string;
  readonly rationale: string | null;
  readonly alternatives: string | null;
}

export interface ReferencePublicGoalState {
  readonly goalId: string;
  readonly phase: ReferenceGoalPhase;
  readonly generation: number | null;
  readonly activeClaim: ReferencePublicClaim | null;
  readonly currentDraft: PlanDraftIdentity | null;
  readonly finalizedManifest: PlanPublishedManifest | null;
  readonly milestoneIds: readonly string[];
  readonly waitingResearches: readonly string[];
  readonly milestones: readonly ReferencePublicMilestone[];
  readonly tasks: readonly ReferencePublicTask[];
  readonly questions: readonly ReferencePublicQuestion[];
  readonly researches: readonly ReferencePublicResearch[];
  readonly defects: readonly ReferencePublicDefect[];
  readonly reviews: readonly ReferencePublicReview[];
  readonly decisions: readonly ReferencePublicDecision[];
  readonly readyTaskIds: readonly string[];
}

export interface SeedGoalOptions {
  readonly goalId: string;
  readonly phase: ReferenceGoalPhase;
  readonly generation: number | null;
}

export interface SeedWorkOptions {
  readonly taskStatuses: readonly ReferencePublicTask["status"][];
  readonly openQuestionCount: number;
  readonly legacy: boolean;
}

export interface SeedReviewOptions {
  readonly reviewId: string;
  readonly goalId: string;
  readonly status: "go-ahead" | "revise";
  readonly draft: PlanDraftIdentity;
  readonly provenance: PlanWriteProvenance;
}

export interface PlanLifecycleContractFixture {
  readonly lifecycle: PlanLifecycleStore;
  seedGoal(options: SeedGoalOptions): Promise<void>;
  seedWork(goalId: string, options: SeedWorkOptions): Promise<void>;
  seedReview(options: SeedReviewOptions): Promise<void>;
  setResearchStatus(
    researchId: string,
    status: "open" | "wip" | "inconclusive" | "concluded" | "abandoned",
  ): Promise<void>;
  observe(goalId: string): Promise<ReferencePublicGoalState>;
  restart(): Promise<PlanLifecycleContractFixture>;
  rawMutateManagedState(goalId: string): Promise<void>;
  startTask(taskId: string, provenance: PlanWriteProvenance): Promise<void>;
  dispose(): Promise<void>;
}

export interface PlanLifecycleContractFactory {
  readonly name: string;
  readonly classification:
    | "Behavioral-Active Blackbox-Atomic"
    | "Behavioral-Active Blackbox-GoodCommunication"
    | "Behavioral-Progression Blackbox-GoodCommunication";
  readonly progression: boolean;
  build(): Promise<PlanLifecycleContractFixture>;
}

interface MutableMilestone {
  id: string;
  goalId: string;
  status: "open" | "postponed";
  title: string;
  description: string | null;
  dependsOn: string[];
  blockedBy: string[];
  taskIds: string[];
  provenance: PlanWriteProvenance;
}

interface MutableTask {
  id: string;
  goalId: string;
  milestoneId: string;
  status: ReferencePublicTask["status"];
  headline: string;
  description: string | null;
  acceptance: string | null;
  suggestedModel: string | null;
  sourceRefs: string[];
  tags: string[];
  dependsOn: string[];
  blockedBy: string[];
  executable: boolean;
  provenance: PlanWriteProvenance;
}

interface MutableEffectItem {
  id: string;
  goalId: string;
  status: string;
  text: string;
  provenance: PlanWriteProvenance;
}

interface MutableQuestion extends MutableEffectItem {
  context: string | null;
  suggestions: string[];
  recommendation: string | null;
}

interface MutableResearch extends MutableEffectItem {
  scope: string | null;
}

interface MutableDefect extends MutableEffectItem {
  reviewId: string;
  severity: ReferencePublicDefect["severity"];
  description: string | null;
  rootCause: string | null;
  suggestedFix: string | null;
  sourceRefs: string[];
  tags: string[];
}

interface MutableReview {
  id: string;
  goalId: string;
  status: ReferencePublicReview["status"];
  draft: PlanDraftIdentity;
  provenance: PlanWriteProvenance;
}

interface MutableDecision extends MutableEffectItem {
  reviewId: string;
  rationale: string | null;
  alternatives: string | null;
}

interface MutableDraft {
  identity: PlanDraftIdentity;
  manifest: PlanPublishedManifest;
}

interface MutableGoal {
  goalId: string;
  phase: ReferenceGoalPhase;
  generation: number | null;
  activeClaimId: string | null;
  currentDraft: MutableDraft | null;
  finalizedDraft: PlanDraftIdentity | null;
  finalizedManifest: PlanPublishedManifest | null;
  milestoneIds: string[];
  waitingResearches: string[];
  legacyMetadataAbsent: boolean;
}

interface RecordedOperation {
  readonly replay: PlanOperationReplayRecord;
  readonly acknowledgement: unknown;
}

class ReferenceMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class ReferencePlanLifecycleBackend {
  readonly mutex = new ReferenceMutex();
  readonly goals = new Map<string, MutableGoal>();
  readonly claims = new Map<string, PlanPrivateClaimRecord>();
  readonly operations = new Map<string, RecordedOperation>();
  readonly milestones = new Map<string, MutableMilestone>();
  readonly tasks = new Map<string, MutableTask>();
  readonly questions = new Map<string, MutableQuestion>();
  readonly researches = new Map<string, MutableResearch>();
  readonly defects = new Map<string, MutableDefect>();
  readonly reviews = new Map<string, MutableReview>();
  readonly decisions = new Map<string, MutableDecision>();
  claimCounter = 0;
  milestoneCounter = 0;
  taskCounter = 0;
  questionCounter = 0;
  researchCounter = 0;
  defectCounter = 0;
  decisionCounter = 0;
}

interface SerializedReferencePlanLifecycleBackend {
  readonly goals: readonly (readonly [string, MutableGoal])[];
  readonly claims: readonly (readonly [string, PlanPrivateClaimRecord])[];
  readonly operations: readonly (readonly [string, RecordedOperation])[];
  readonly milestones: readonly (readonly [string, MutableMilestone])[];
  readonly tasks: readonly (readonly [string, MutableTask])[];
  readonly questions: readonly (readonly [string, MutableQuestion])[];
  readonly researches: readonly (readonly [string, MutableResearch])[];
  readonly defects: readonly (readonly [string, MutableDefect])[];
  readonly reviews: readonly (readonly [string, MutableReview])[];
  readonly decisions: readonly (readonly [string, MutableDecision])[];
  readonly counters: {
    readonly claim: number;
    readonly milestone: number;
    readonly task: number;
    readonly question: number;
    readonly research: number;
    readonly defect: number;
    readonly decision: number;
  };
}

function serializeBackend(backend: ReferencePlanLifecycleBackend): string {
  const state: SerializedReferencePlanLifecycleBackend = {
    goals: [...backend.goals.entries()],
    claims: [...backend.claims.entries()],
    operations: [...backend.operations.entries()],
    milestones: [...backend.milestones.entries()],
    tasks: [...backend.tasks.entries()],
    questions: [...backend.questions.entries()],
    researches: [...backend.researches.entries()],
    defects: [...backend.defects.entries()],
    reviews: [...backend.reviews.entries()],
    decisions: [...backend.decisions.entries()],
    counters: {
      claim: backend.claimCounter,
      milestone: backend.milestoneCounter,
      task: backend.taskCounter,
      question: backend.questionCounter,
      research: backend.researchCounter,
      defect: backend.defectCounter,
      decision: backend.decisionCounter,
    },
  };
  return JSON.stringify(state);
}

function deserializeBackend(serialized: string): ReferencePlanLifecycleBackend {
  const state = JSON.parse(serialized) as SerializedReferencePlanLifecycleBackend;
  const backend = new ReferencePlanLifecycleBackend();
  for (const [key, value] of state.goals) backend.goals.set(key, value);
  for (const [key, value] of state.claims) backend.claims.set(key, value);
  for (const [key, value] of state.operations) backend.operations.set(key, value);
  for (const [key, value] of state.milestones) backend.milestones.set(key, value);
  for (const [key, value] of state.tasks) backend.tasks.set(key, value);
  for (const [key, value] of state.questions) backend.questions.set(key, value);
  for (const [key, value] of state.researches) backend.researches.set(key, value);
  for (const [key, value] of state.defects) backend.defects.set(key, value);
  for (const [key, value] of state.reviews) backend.reviews.set(key, value);
  for (const [key, value] of state.decisions) backend.decisions.set(key, value);
  backend.claimCounter = state.counters.claim;
  backend.milestoneCounter = state.counters.milestone;
  backend.taskCounter = state.counters.task;
  backend.questionCounter = state.counters.question;
  backend.researchCounter = state.counters.research;
  backend.defectCounter = state.counters.defect;
  backend.decisionCounter = state.counters.decision;
  return backend;
}

const SEED_PROVENANCE = {
  author: "t847-seed",
  session: "t847-seed-session",
} as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function verifier(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function payloadVerifier(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function sameDraftIdentity(
  left: PlanDraftIdentity | null,
  right: PlanDraftIdentity,
): boolean {
  return (
    left !== null &&
    left.goalId === right.goalId &&
    left.claimId === right.claimId &&
    left.generation === right.generation &&
    left.revision === right.revision
  );
}

function claimScope(goalId: string, claimRequestId: string): string {
  return `${goalId}\u0000${claimRequestId}`;
}

function operationScope(
  goalId: string,
  claimId: string,
  generation: number,
  operation: "publish-draft" | "release" | "finalize",
  operationId: string,
): string {
  return [goalId, claimId, generation, operation, operationId].join("\u0000");
}

function materializeReferences(
  references: readonly PlanDraftReference[] | undefined,
  milestoneAllocations: ReadonlyMap<string, string>,
  taskAllocations: ReadonlyMap<string, string>,
): string[] {
  return (references ?? []).map((reference) => {
    if (reference.kind === "ledger") return reference.ref;
    const allocation =
      reference.kind === "draft-milestone"
        ? milestoneAllocations.get(reference.key)
        : taskAllocations.get(reference.key);
    if (allocation === undefined) {
      throw new Error(`reference allocation missing: ${reference.key}`);
    }
    return allocation;
  });
}

function publicClaim(record: PlanPrivateClaimRecord): ReferencePublicClaim {
  return {
    goalId: record.goalId,
    claimId: record.claimId,
    generation: record.generation,
    purpose: record.purpose,
  };
}

function idAllocations(
  batch: PlanReviewDefectBatch | undefined,
  backend: ReferencePlanLifecycleBackend,
  goalId: string,
  provenance: PlanWriteProvenance,
): PlanIdAllocation[] {
  if (batch === undefined) return [];
  const allocations: PlanIdAllocation[] = [];
  for (const defect of batch.defects) {
    const id = `D${++backend.defectCounter}`;
    backend.defects.set(id, {
      id,
      goalId,
      reviewId: batch.reviewId,
      status: "open",
      text: defect.headline,
      severity: defect.severity,
      description: defect.description ?? null,
      rootCause: defect.rootCause ?? null,
      suggestedFix: defect.suggestedFix ?? null,
      sourceRefs: [...(defect.sourceRefs ?? [])],
      tags: [...(defect.tags ?? [])],
      provenance: clone(provenance),
    });
    allocations.push({ key: defect.key, id });
  }
  return allocations;
}

function claimConflict(
  code: "claim-not-active",
  goalId: string,
  claimId: string,
  generation: number,
): PlanConflict {
  return { code, goalId, claimId, generation };
}

export class ReferencePlanLifecycleAdapter
  implements PlanLifecycleStore, PlanLifecycleContractFixture
{
  readonly lifecycle: PlanLifecycleStore = this;

  constructor(private readonly backend: ReferencePlanLifecycleBackend) {}

  async seedGoal(options: SeedGoalOptions): Promise<void> {
    await this.backend.mutex.run(() => {
      if (this.backend.goals.has(options.goalId)) {
        throw new Error(`goal already exists: ${options.goalId}`);
      }
      this.backend.goals.set(options.goalId, {
        goalId: options.goalId,
        phase: options.phase,
        generation: options.generation,
        activeClaimId: null,
        currentDraft: null,
        finalizedDraft: null,
        finalizedManifest: null,
        milestoneIds: [],
        waitingResearches: [],
        legacyMetadataAbsent: options.generation === null,
      });
    });
  }

  async seedWork(goalId: string, options: SeedWorkOptions): Promise<void> {
    await this.backend.mutex.run(() => {
      const goal = this.requireGoal(goalId);
      const milestoneId = `M${++this.backend.milestoneCounter}`;
      const taskIds: string[] = [];
      this.backend.milestones.set(milestoneId, {
        id: milestoneId,
        goalId,
        status: "open",
        title: "seeded work",
        description: null,
        dependsOn: [],
        blockedBy: [],
        taskIds,
        provenance: SEED_PROVENANCE,
      });
      for (const [index, status] of options.taskStatuses.entries()) {
        const id = `T${++this.backend.taskCounter}`;
        const dependsOn = index === 0 ? [] : [taskIds[0]!];
        taskIds.push(id);
        this.backend.tasks.set(id, {
          id,
          goalId,
          milestoneId,
          status,
          headline: `seeded task ${index + 1}`,
          description: null,
          acceptance: null,
          suggestedModel: null,
          sourceRefs: [],
          tags: [],
          dependsOn,
          blockedBy: [],
          executable: true,
          provenance: SEED_PROVENANCE,
        });
      }
      goal.milestoneIds = [milestoneId];
      const revision = 1;
      const priorClaimId = "seeded_claim";
      const manifest = {
        revision,
        milestones: [{ key: "seeded_milestone", id: milestoneId }],
        tasks: taskIds.map((id, index) => ({ key: `seeded_task_${index + 1}`, id })),
      };
      const identity = {
        goalId,
        claimId: priorClaimId,
        generation: goal.generation ?? 1,
        revision,
      };
      goal.currentDraft = {
        identity,
        manifest,
      };
      goal.finalizedDraft = clone(identity);
      goal.finalizedManifest = manifest;
      goal.legacyMetadataAbsent = options.legacy;
      for (let index = 0; index < options.openQuestionCount; index += 1) {
        const id = `Q${++this.backend.questionCounter}`;
        this.backend.questions.set(id, {
          id,
          goalId,
          status: "open",
          text: `seeded question ${index + 1}`,
          context: null,
          suggestions: [],
          recommendation: null,
          provenance: SEED_PROVENANCE,
        });
      }
    });
  }

  async seedReview(options: SeedReviewOptions): Promise<void> {
    await this.backend.mutex.run(() => {
      this.requireGoal(options.goalId);
      this.backend.reviews.set(options.reviewId, {
        id: options.reviewId,
        goalId: options.goalId,
        status: options.status,
        draft: clone(options.draft),
        provenance: clone(options.provenance),
      });
    });
  }

  async setResearchStatus(
    researchId: string,
    status: "open" | "wip" | "inconclusive" | "concluded" | "abandoned",
  ): Promise<void> {
    await this.backend.mutex.run(() => {
      const research = this.backend.researches.get(researchId);
      if (research === undefined) throw new Error(`research not found: ${researchId}`);
      research.status = status;
    });
  }

  async observe(goalId: string): Promise<ReferencePublicGoalState> {
    return this.backend.mutex.run(() => {
      const goal = this.requireGoal(goalId);
      const claim =
        goal.activeClaimId === null
          ? null
          : [...this.backend.claims.values()].find(
              (record) =>
                record.goalId === goalId &&
                record.claimId === goal.activeClaimId &&
                record.state === "active",
            ) ?? null;
      const tasks = [...this.backend.tasks.values()]
        .filter((task) => task.goalId === goalId)
        .sort((left, right) => left.id.localeCompare(right.id));
      const readyTaskIds = tasks
        .filter(
          (task) =>
            task.executable &&
            task.status === "planned" &&
            task.dependsOn.every(
              (dependencyId) => this.backend.tasks.get(dependencyId)?.status === "done",
            ),
        )
        .map(({ id }) => id);
      return clone({
        goalId,
        phase: goal.phase,
        generation: goal.generation,
        activeClaim: claim === null ? null : publicClaim(claim),
        currentDraft: goal.currentDraft?.identity ?? null,
        finalizedManifest: goal.finalizedManifest,
        milestoneIds: goal.milestoneIds,
        waitingResearches: goal.waitingResearches,
        milestones: [...this.backend.milestones.values()]
          .filter((milestone) => milestone.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        tasks,
        questions: [...this.backend.questions.values()]
          .filter((question) => question.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        researches: [...this.backend.researches.values()]
          .filter((research) => research.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        defects: [...this.backend.defects.values()]
          .filter((defect) => defect.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        reviews: [...this.backend.reviews.values()]
          .filter((review) => review.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        decisions: [...this.backend.decisions.values()]
          .filter((decision) => decision.goalId === goalId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        readyTaskIds,
      });
    });
  }

  async restart(): Promise<PlanLifecycleContractFixture> {
    return this.backend.mutex.run(
      () => new ReferencePlanLifecycleAdapter(deserializeBackend(serializeBackend(this.backend))),
    );
  }

  async rawMutateManagedState(goalId: string): Promise<void> {
    await this.backend.mutex.run(() => {
      this.requireGoal(goalId);
      throw new Error("managed plan state may mutate only through PlanLifecycleStore");
    });
  }

  async startTask(taskId: string, provenance: PlanWriteProvenance): Promise<void> {
    await this.backend.mutex.run(() => {
      const task = this.backend.tasks.get(taskId);
      if (task === undefined) throw new Error(`task not found: ${taskId}`);
      if (!task.executable) {
        throw new Error("task belongs to a draft or superseded manifest");
      }
      if (task.status !== "planned") {
        throw new Error(`task is not startable from status ${task.status}`);
      }
      if (
        task.dependsOn.some(
          (dependencyId) => this.backend.tasks.get(dependencyId)?.status !== "done",
        )
      ) {
        throw new Error("task dependencies are not satisfied");
      }
      task.status = "wip";
      task.provenance = clone(provenance);
    });
  }

  async dispose(): Promise<void> {}

  async claimPlan(rawInput: PlanClaimInput): Promise<PlanClaimResult> {
    const input = PlanClaimInputSchema.parse(rawInput);
    return this.backend.mutex.run(() => {
      const existing = this.backend.claims.get(
        claimScope(input.goalId, input.claimRequestId),
      );
      if (existing !== undefined) return replayPlanClaim(existing, input);

      const goal = this.backend.goals.get(input.goalId);
      if (goal === undefined) {
        return PlanClaimResultSchema.parse({
          ok: false,
          conflict: { code: "goal-not-found", goalId: input.goalId },
        });
      }
      if (goal.activeClaimId !== null) {
        const current = [...this.backend.claims.values()].find(
          (record) =>
            record.goalId === input.goalId &&
            record.claimId === goal.activeClaimId &&
            record.state === "active",
        );
        if (current === undefined) throw new Error("active claim record is absent");
        return PlanClaimResultSchema.parse({
          ok: false,
          conflict: {
            code: "claim-active",
            goalId: current.goalId,
            claimId: current.claimId,
            generation: current.generation,
          },
        });
      }
      const phase = resolvePlanClaimPhase(input.goalId, input.purpose, goal.phase);
      if (!phase.ok) {
        return PlanClaimResultSchema.parse({ ok: false, conflict: phase.conflict });
      }
      if (goal.generation !== input.expectedGeneration) {
        return PlanClaimResultSchema.parse({
          ok: false,
          conflict: {
            code: "stale-generation",
            goalId: input.goalId,
            expectedGeneration: input.expectedGeneration,
            currentGeneration: goal.generation,
          },
        });
      }
      const activeResearchIds = goal.waitingResearches.filter((id) => {
        const status = this.backend.researches.get(id)?.status;
        return status === "open" || status === "wip" || status === "inconclusive";
      });
      if (activeResearchIds.length > 0) {
        return PlanClaimResultSchema.parse({
          ok: false,
          conflict: {
            code: "research-wait-active",
            goalId: input.goalId,
            researchIds: activeResearchIds,
          },
        });
      }

      if (input.purpose === "follow-up") {
        const activeTasks = this.goalTasks(goal).filter(
          ({ status }) => status === "wip" || status === "blocked",
        );
        if (activeTasks.length > 0) {
          return PlanClaimResultSchema.parse({
            ok: false,
            conflict: {
              code: "implementation-active",
              goalId: input.goalId,
              tasks: activeTasks.map(({ id, status }) => ({
                taskId: id,
                status,
              })),
            },
          });
        }
      }

      const adoptedManifest = goal.legacyMetadataAbsent
        ? {
            milestoneIds: [...goal.milestoneIds],
            taskIds: this.goalTasks(goal).map(({ id }) => id),
          }
        : { milestoneIds: [], taskIds: [] };
      if (input.purpose === "follow-up") this.applyFollowUpCleanup(goal);

      const priorGeneration = goal.generation;
      const generation = (goal.generation ?? 0) + 1;
      const claimId = `claim_${++this.backend.claimCounter}`;
      goal.generation = generation;
      goal.activeClaimId = claimId;
      goal.phase = phase.goalPhase;
      goal.waitingResearches = [];
      goal.legacyMetadataAbsent = false;

      const record = PlanPrivateClaimRecordSchema.parse({
        goalId: input.goalId,
        claimId,
        generation,
        purpose: input.purpose,
        claimRequestId: input.claimRequestId,
        ownerFenceTokenVerifier: verifier(input.ownerFenceToken),
        expectedGeneration: input.expectedGeneration,
        priorGeneration,
        previousGoalPhase: phase.previousGoalPhase,
        goalPhase: phase.goalPhase,
        legacyAdopted: adoptedManifest.milestoneIds.length > 0,
        adoptedManifest,
        waitingResearches: [],
        author: input.author,
        session: input.session,
        state: "active",
      });
      this.backend.claims.set(claimScope(input.goalId, input.claimRequestId), record);
      return PlanClaimResultSchema.parse({
        ok: true,
        replayed: false,
        acknowledgement: {
          goalId: input.goalId,
          claimId,
          generation,
          purpose: input.purpose,
          claimRequestId: input.claimRequestId,
          ownerFenceToken: input.ownerFenceToken,
          previousGoalPhase: phase.previousGoalPhase,
          goalPhase: phase.goalPhase,
          legacyAdopted: adoptedManifest.milestoneIds.length > 0,
          adoptedManifest,
          waitingResearches: [],
        },
      });
    });
  }

  async publishPlanDraft(
    rawInput: PlanPublishDraftInput,
  ): Promise<PlanPublishDraftResult> {
    const input = PlanPublishDraftInputSchema.parse(rawInput);
    return this.backend.mutex.run(() => {
      const replay = this.replayOperation(input, "publish-draft", true);
      if (replay !== null) return PlanPublishDraftResultSchema.parse(replay);
      const conflict = this.ownerConflict(input);
      if (conflict !== null) {
        return PlanPublishDraftResultSchema.parse({ ok: false, conflict });
      }
      const goal = this.requireGoal(input.goalId);
      if (goal.phase !== "planning") {
        return PlanPublishDraftResultSchema.parse({
          ok: false,
          conflict: {
            code: "goal-phase-conflict",
            goalId: input.goalId,
            status: goal.phase,
            allowed: ["planning"],
          },
        });
      }

      const replacedManifest = goal.currentDraft?.manifest ?? null;
      if (
        goal.currentDraft !== null &&
        !sameDraftIdentity(goal.finalizedDraft, goal.currentDraft.identity)
      ) {
        this.supersedeDraft(goal.currentDraft.manifest);
      }
      const revision = (goal.currentDraft?.identity.revision ?? 0) + 1;
      const manifest = this.materializeManifest(input, revision);
      const identity = {
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        revision,
      };
      goal.currentDraft = { identity, manifest };
      const reviewDefectAllocations = idAllocations(
        input.reviewDefects,
        this.backend,
        input.goalId,
        input,
      );
      const acknowledgement = {
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        operationId: input.operationId,
        manifest,
        replacedManifest,
        reviewDefects: reviewDefectAllocations,
      };
      this.recordOperation(input, "publish-draft", acknowledgement);
      return PlanPublishDraftResultSchema.parse({
        ok: true,
        replayed: false,
        acknowledgement,
      });
    });
  }

  async releasePlanClaim(rawInput: PlanReleaseInput): Promise<PlanReleaseResult> {
    const input = PlanReleaseInputSchema.parse(rawInput);
    return this.backend.mutex.run(() => {
      const replay = this.replayOperation(input, "release", input.kind === "pause");
      if (replay !== null) return PlanReleaseResultSchema.parse(replay);
      const conflict =
        input.kind === "pause"
          ? this.ownerConflict(input)
          : this.publicAbandonConflict(input);
      if (conflict !== null) {
        return PlanReleaseResultSchema.parse({ ok: false, conflict });
      }
      const goal = this.requireGoal(input.goalId);
      const reviewDefectAllocations = idAllocations(
        input.reviewDefects,
        this.backend,
        input.goalId,
        input,
      );
      let acknowledgement;
      if (input.kind === "pause") {
        if (input.effect.kind === "questions") {
          const questions = input.effect.questions.map((question) => {
            const id = `Q${++this.backend.questionCounter}`;
            this.backend.questions.set(id, {
              id,
              goalId: input.goalId,
              status: "open",
              text: question.question,
              context: question.context ?? null,
              suggestions: [...(question.suggestions ?? [])],
              recommendation: question.recommendation ?? null,
              provenance: { author: input.author, session: input.session },
            });
            return { key: question.key, id };
          });
          goal.phase = "clarifying";
          goal.waitingResearches = [];
          acknowledgement = {
            kind: "questions",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
            operationId: input.operationId,
            reviewDefects: reviewDefectAllocations,
            questions,
            researches: [],
            waitingResearches: [],
            goalPhase: "clarifying",
          } as const;
        } else {
          const researches = input.effect.researches.map((research) => {
            const id = `RS${++this.backend.researchCounter}`;
            this.backend.researches.set(id, {
              id,
              goalId: input.goalId,
              status: "open",
              text: research.question,
              scope: research.scope ?? null,
              provenance: { author: input.author, session: input.session },
            });
            return { key: research.key, id };
          });
          goal.phase = "planning";
          goal.waitingResearches = researches.map(({ id }) => id);
          acknowledgement = {
            kind: "researches",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
            operationId: input.operationId,
            reviewDefects: reviewDefectAllocations,
            questions: [],
            researches,
            waitingResearches: [...goal.waitingResearches],
            goalPhase: "planning",
          } as const;
        }
      } else {
        goal.phase = "planning";
        goal.waitingResearches = [];
        acknowledgement = {
          kind: "abandon",
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
          operationId: input.operationId,
          reviewDefects: reviewDefectAllocations,
          questions: [],
          researches: [],
          waitingResearches: [],
          goalPhase: "planning",
        } as const;
      }
      this.releaseClaim(goal, input.claimId, "released");
      this.recordOperation(input, "release", acknowledgement);
      return PlanReleaseResultSchema.parse({
        ok: true,
        replayed: false,
        acknowledgement,
      });
    });
  }

  async finalizePlan(rawInput: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    const input = PlanFinalizeInputSchema.parse(rawInput);
    return this.backend.mutex.run(() => {
      const replay = this.replayOperation(input, "finalize", true);
      if (replay !== null) return PlanFinalizeResultSchema.parse(replay);
      const conflict = this.ownerConflict(input);
      if (conflict !== null) return PlanFinalizeResultSchema.parse({ ok: false, conflict });
      const goal = this.requireGoal(input.goalId);
      if (goal.currentDraft === null) {
        return PlanFinalizeResultSchema.parse({
          ok: false,
          conflict: {
            code: "draft-not-found",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
          },
        });
      }
      const review = this.backend.reviews.get(input.reviewId);
      if (review === undefined) {
        return PlanFinalizeResultSchema.parse({
          ok: false,
          conflict: {
            code: "review-not-found",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
            reviewId: input.reviewId,
          },
        });
      }
      if (review.status !== "go-ahead") {
        return PlanFinalizeResultSchema.parse({
          ok: false,
          conflict: {
            code: "review-not-approved",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
            reviewId: input.reviewId,
            status: "revise",
          },
        });
      }
      const binding = resolvePlanFinalizeDraftBinding(
        input,
        goal.currentDraft.identity,
        { reviewId: review.id, draft: review.draft },
      );
      if (!binding.ok) {
        return PlanFinalizeResultSchema.parse({
          ok: false,
          conflict: binding.conflict,
        });
      }

      const decisionId = `K${++this.backend.decisionCounter}`;
      this.backend.decisions.set(decisionId, {
        id: decisionId,
        goalId: input.goalId,
        reviewId: input.reviewId,
        status: "locked",
        text: input.decision.headline,
        rationale: input.decision.rationale ?? null,
        alternatives: input.decision.alternatives ?? null,
        provenance: { author: input.author, session: input.session },
      });
      const reviewDefectAllocations = idAllocations(
        input.reviewDefects,
        this.backend,
        input.goalId,
        input,
      );
      goal.phase = "planned";
      goal.finalizedDraft = clone(goal.currentDraft.identity);
      goal.finalizedManifest = clone(goal.currentDraft.manifest);
      goal.milestoneIds = goal.currentDraft.manifest.milestones.map(({ id }) => id);
      for (const { id } of goal.currentDraft.manifest.tasks) {
        const task = this.requireTask(id);
        task.executable = true;
      }
      const acknowledgement = {
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
        operationId: input.operationId,
        reviewId: input.reviewId,
        draft: binding.draft,
        decisionId,
        manifest: goal.currentDraft.manifest,
        reviewDefects: reviewDefectAllocations,
        goalPhase: "planned",
      } as const;
      this.releaseClaim(goal, input.claimId, "finalized");
      this.recordOperation(input, "finalize", acknowledgement);
      return PlanFinalizeResultSchema.parse({
        ok: true,
        replayed: false,
        acknowledgement,
      });
    });
  }

  private requireGoal(goalId: string): MutableGoal {
    const goal = this.backend.goals.get(goalId);
    if (goal === undefined) throw new Error(`goal not found: ${goalId}`);
    return goal;
  }

  private requireTask(taskId: string): MutableTask {
    const task = this.backend.tasks.get(taskId);
    if (task === undefined) throw new Error(`task not found: ${taskId}`);
    return task;
  }

  private goalTasks(goal: MutableGoal): MutableTask[] {
    return [...this.backend.tasks.values()].filter((task) => task.goalId === goal.goalId);
  }

  private applyFollowUpCleanup(goal: MutableGoal): void {
    const supersededIds = new Set<string>(goal.milestoneIds);
    for (const task of this.goalTasks(goal)) {
      task.executable = false;
      if (task.status === "planned") {
        task.status = "abandoned";
        supersededIds.add(task.id);
      }
    }
    this.removeSupersededReferences(supersededIds);
    for (const milestoneId of goal.milestoneIds) {
      const milestone = this.backend.milestones.get(milestoneId);
      if (milestone !== undefined) milestone.status = "postponed";
    }
    for (const question of this.backend.questions.values()) {
      if (question.goalId === goal.goalId && question.status === "open") {
        question.status = "withdrawn";
      }
    }
    goal.milestoneIds = [];
    goal.currentDraft = null;
    goal.finalizedDraft = null;
    goal.finalizedManifest = null;
  }

  private supersedeDraft(manifest: PlanPublishedManifest): void {
    const supersededIds = new Set([
      ...manifest.milestones.map(({ id }) => id),
      ...manifest.tasks.map(({ id }) => id),
    ]);
    for (const { id } of manifest.tasks) {
      const task = this.backend.tasks.get(id);
      if (task !== undefined) {
        task.executable = false;
        if (task.status === "planned") task.status = "abandoned";
      }
    }
    for (const { id } of manifest.milestones) {
      const milestone = this.backend.milestones.get(id);
      if (milestone !== undefined) milestone.status = "postponed";
    }
    this.removeSupersededReferences(supersededIds);
  }

  private removeSupersededReferences(supersededIds: ReadonlySet<string>): void {
    for (const milestone of this.backend.milestones.values()) {
      milestone.dependsOn = milestone.dependsOn.filter((id) => !supersededIds.has(id));
      milestone.blockedBy = milestone.blockedBy.filter((id) => !supersededIds.has(id));
    }
    for (const task of this.backend.tasks.values()) {
      task.dependsOn = task.dependsOn.filter((id) => !supersededIds.has(id));
      task.blockedBy = task.blockedBy.filter((id) => !supersededIds.has(id));
    }
  }

  private materializeManifest(
    input: PlanPublishDraftInput,
    revision: number,
  ): PlanPublishedManifest {
    const milestoneAllocations = new Map<string, string>();
    const taskAllocations = new Map<string, string>();
    for (const milestone of input.manifest.milestones) {
      milestoneAllocations.set(milestone.key, `M${++this.backend.milestoneCounter}`);
    }
    for (const task of input.manifest.tasks) {
      taskAllocations.set(task.key, `T${++this.backend.taskCounter}`);
    }
    for (const milestone of input.manifest.milestones) {
      const id = milestoneAllocations.get(milestone.key);
      if (id === undefined) throw new Error("milestone allocation missing");
      const taskIds = input.manifest.tasks
        .filter(({ milestoneKey }) => milestoneKey === milestone.key)
        .map(({ key }) => {
          const taskId = taskAllocations.get(key);
          if (taskId === undefined) throw new Error("task allocation missing");
          return taskId;
        });
      this.backend.milestones.set(id, {
        id,
        goalId: input.goalId,
        status: "open",
        title: milestone.title,
        description: milestone.description ?? null,
        dependsOn: materializeReferences(
          milestone.dependsOn,
          milestoneAllocations,
          taskAllocations,
        ),
        blockedBy: materializeReferences(
          milestone.blockedBy,
          milestoneAllocations,
          taskAllocations,
        ),
        taskIds,
        provenance: { author: input.author, session: input.session },
      });
    }
    for (const task of input.manifest.tasks) {
      const id = taskAllocations.get(task.key);
      const milestoneId = milestoneAllocations.get(task.milestoneKey);
      if (id === undefined || milestoneId === undefined) {
        throw new Error("task or milestone allocation missing");
      }
      this.backend.tasks.set(id, {
        id,
        goalId: input.goalId,
        milestoneId,
        status: "planned",
        headline: task.headline,
        description: task.description ?? null,
        acceptance: task.acceptance ?? null,
        suggestedModel: task.suggestedModel ?? null,
        sourceRefs: [...(task.sourceRefs ?? [])],
        tags: [...(task.tags ?? [])],
        dependsOn: materializeReferences(
          task.dependsOn,
          milestoneAllocations,
          taskAllocations,
        ),
        blockedBy: materializeReferences(
          task.blockedBy,
          milestoneAllocations,
          taskAllocations,
        ),
        executable: false,
        provenance: { author: input.author, session: input.session },
      });
    }
    return {
      revision,
      milestones: input.manifest.milestones.map(({ key }) => ({
        key,
        id: milestoneAllocations.get(key)!,
      })),
      tasks: input.manifest.tasks.map(({ key }) => ({
        key,
        id: taskAllocations.get(key)!,
      })),
    };
  }

  private activeClaim(goal: MutableGoal): PlanPrivateClaimRecord | null {
    if (goal.activeClaimId === null) return null;
    return (
      [...this.backend.claims.values()].find(
        (record) =>
          record.goalId === goal.goalId &&
          record.claimId === goal.activeClaimId &&
          record.state === "active",
      ) ?? null
    );
  }

  private ownerConflict(
    input: PlanPublishDraftInput | Extract<PlanReleaseInput, { kind: "pause" }> | PlanFinalizeInput,
  ): PlanConflict | null {
    const goal = this.backend.goals.get(input.goalId);
    if (goal === undefined) return { code: "goal-not-found", goalId: input.goalId };
    const current = this.activeClaim(goal);
    if (current === null) {
      return claimConflict(
        "claim-not-active",
        input.goalId,
        input.claimId,
        input.generation,
      );
    }
    if (current.claimId !== input.claimId) {
      return {
        code: "stale-claim",
        goalId: input.goalId,
        suppliedClaimId: input.claimId,
        currentClaimId: current.claimId,
        currentGeneration: current.generation,
      };
    }
    if (current.generation !== input.generation) {
      return {
        code: "stale-generation",
        goalId: input.goalId,
        expectedGeneration: input.generation,
        currentGeneration: current.generation,
      };
    }
    if (current.ownerFenceTokenVerifier !== verifier(input.ownerFenceToken)) {
      return {
        code: "owner-fence-mismatch",
        goalId: input.goalId,
        claimId: input.claimId,
        generation: input.generation,
      };
    }
    return null;
  }

  private publicAbandonConflict(
    input: Extract<PlanReleaseInput, { kind: "abandon" }>,
  ): PlanConflict | null {
    const goal = this.backend.goals.get(input.goalId);
    if (goal === undefined) return { code: "goal-not-found", goalId: input.goalId };
    const current = this.activeClaim(goal);
    if (current === null) {
      return claimConflict(
        "claim-not-active",
        input.goalId,
        input.claimId,
        input.generation,
      );
    }
    if (current.claimId !== input.claimId) {
      return {
        code: "stale-claim",
        goalId: input.goalId,
        suppliedClaimId: input.claimId,
        currentClaimId: current.claimId,
        currentGeneration: current.generation,
      };
    }
    if (current.generation !== input.generation) {
      return {
        code: "stale-generation",
        goalId: input.goalId,
        expectedGeneration: input.generation,
        currentGeneration: current.generation,
      };
    }
    return null;
  }

  private replayOperation(
    input: PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
    operation: "publish-draft" | "release" | "finalize",
    requiresOwner: boolean,
  ): { readonly ok: true; readonly replayed: true; readonly acknowledgement: unknown } | {
    readonly ok: false;
    readonly conflict: PlanConflict;
  } | null {
    const key = operationScope(
      input.goalId,
      input.claimId,
      input.generation,
      operation,
      input.operationId,
    );
    const recorded = this.backend.operations.get(key);
    if (recorded === undefined) return null;
    if (requiresOwner) {
      const ownerInput = input as
        | PlanPublishDraftInput
        | Extract<PlanReleaseInput, { kind: "pause" }>
        | PlanFinalizeInput;
      const claim = [...this.backend.claims.values()].find(
        (candidate) =>
          candidate.goalId === input.goalId &&
          candidate.claimId === input.claimId &&
          candidate.generation === input.generation,
      );
      if (
        claim === undefined ||
        claim.ownerFenceTokenVerifier !== verifier(ownerInput.ownerFenceToken)
      ) {
        return {
          ok: false,
          conflict: {
            code: "owner-fence-mismatch",
            goalId: input.goalId,
            claimId: input.claimId,
            generation: input.generation,
          },
        };
      }
    }
    const attempted: PlanOperationReplayRecord = {
      goalId: input.goalId,
      claimId: input.claimId,
      generation: input.generation,
      operationId: input.operationId,
      operation,
      requestPayloadVerifier: payloadVerifier(input),
    };
    const resolution = resolvePlanOperationReplay(recorded.replay, attempted);
    if (resolution.kind === "conflict") {
      return { ok: false, conflict: resolution.conflict };
    }
    if (resolution.kind !== "exact-replay") {
      throw new Error("operation replay lookup returned an independent scope");
    }
    return {
      ok: true,
      replayed: true,
      acknowledgement: clone(recorded.acknowledgement),
    };
  }

  private recordOperation(
    input: PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput,
    operation: "publish-draft" | "release" | "finalize",
    acknowledgement: unknown,
  ): void {
    this.backend.operations.set(
      operationScope(
        input.goalId,
        input.claimId,
        input.generation,
        operation,
        input.operationId,
      ),
      {
        replay: {
          goalId: input.goalId,
          claimId: input.claimId,
          generation: input.generation,
          operationId: input.operationId,
          operation,
          requestPayloadVerifier: payloadVerifier(input),
        },
        acknowledgement: clone(acknowledgement),
      },
    );
  }

  private releaseClaim(
    goal: MutableGoal,
    claimId: string,
    state: "released" | "finalized",
  ): void {
    const entry = [...this.backend.claims.entries()].find(
      ([, record]) =>
        record.goalId === goal.goalId &&
        record.claimId === claimId &&
        record.generation === goal.generation,
    );
    if (entry === undefined) throw new Error("claim record missing during release");
    this.backend.claims.set(entry[0], { ...entry[1], state });
    goal.activeClaimId = null;
  }
}

export const referencePlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "hand-written durable reference adapter",
  classification: "Behavioral-Active Blackbox-Atomic",
  progression: false,
  async build(): Promise<PlanLifecycleContractFixture> {
    return new ReferencePlanLifecycleAdapter(new ReferencePlanLifecycleBackend());
  },
};
