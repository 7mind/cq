import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  PLAN_ACTIVE_CLAIM_FIELD,
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_GENERATION_FIELD,
  PLAN_REVIEW_DRAFT_FIELD,
  PLAN_WAITING_RESEARCHES_FIELD,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  type Item,
  type Ledger,
  type LedgerStore,
  type PlanLifecycleStore,
  type PlanPrivateClaimRecord,
} from "../src/index.js";
import type { InMemoryPlanOperationRecord } from "../src/store/inMemoryPlanLifecycle.js";
import { readInMemoryPlanState } from "../src/store/inMemoryPlanLifecycle.js";
import type { PlanLifecycleSerializationContender } from "../src/store/planLifecycleSerialization.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
  ReferencePublicDefect,
  ReferencePublicGoalState,
  ReferencePublicMilestone,
  ReferencePublicQuestion,
  ReferencePublicResearch,
  ReferencePublicReview,
  ReferencePublicTask,
  SeedDecisionOptions,
  SeedGoalOptions,
  SeedReviewOptions,
  SeedWorkOptions,
} from "./planLifecycleReferenceAdapter.js";
import {
  OneShotSerializationBoundary,
  type SerializationRaceResult,
} from "./planLifecycleSerializationBoundary.js";

const SEED_PROVENANCE = { author: "seed", session: "seed-session" } as const;

interface InMemoryInternals {
  ledgers: Map<string, Ledger>;
  planClaims?: Map<string, PlanPrivateClaimRecord>;
  planOperations?: Map<string, InMemoryPlanOperationRecord>;
  writeLedgerFile?: (ledger: Ledger) => Promise<void>;
}

type LifecycleBackedLedgerStore = LedgerStore & PlanLifecycleStore;

function internals(store: LifecycleBackedLedgerStore): InMemoryInternals {
  return store as unknown as InMemoryInternals;
}

function findMutableItem(
  store: LifecycleBackedLedgerStore,
  ledgerId: string,
  itemId: string,
): Item {
  const source = internals(store).ledgers.get(ledgerId);
  if (source === undefined) throw new Error(`ledger not found: ${ledgerId}`);
  for (const milestone of source.milestones) {
    const item = milestone.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return item;
  }
  throw new Error(`item not found: ${ledgerId}:${itemId}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneLedger(source: Ledger): Ledger {
  return clone(source);
}

function refValues(item: Item, field: string): string[] {
  const value = item.fields[field];
  return Array.isArray(value) ? value : [];
}

function optionalString(item: Item, field: string): string | null {
  const value = item.fields[field];
  return typeof value === "string" ? value : null;
}

function provenance(item: Item): { author: string; session?: string } {
  if (item.author === undefined) throw new Error(`missing author on ${item.id}`);
  return {
    author: item.author,
    ...(item.session === undefined ? {} : { session: item.session }),
  };
}

function goalOwned(items: readonly Item[], goalId: string): Item[] {
  const ref = `${GOALS_LEDGER}:${goalId}`;
  return items.filter((item) => refValues(item, "ledgerRefs").includes(ref));
}

function allItems(store: LedgerStore, ledgerId: string): Item[] {
  return store.fetch(ledgerId).milestones.flatMap(({ items }) => items);
}

function stripInternalRef(ref: string): string {
  for (const ledgerId of [MILESTONES_LEDGER, TASKS_LEDGER]) {
    const prefix = `${ledgerId}:`;
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

function reviewId(item: Item): string {
  const ref = refValues(item, "ledgerRefs").find((value) => value.startsWith(`${REVIEWS_LEDGER}:`));
  if (ref === undefined) throw new Error(`missing review link on ${item.id}`);
  return ref.slice(REVIEWS_LEDGER.length + 1);
}

export abstract class LedgerStorePlanLifecycleFixture<
  Store extends LedgerStore & PlanLifecycleStore,
> implements PlanLifecycleContractFixture {
  constructor(
    readonly store: Store,
    readonly lifecycle: PlanLifecycleStore = store,
    protected readonly persistDirect?: (ledgerIds: readonly string[]) => Promise<void>,
    protected readonly serializationBoundary = new OneShotSerializationBoundary(),
  ) {}

  raceAtSerializationBoundary<Holder, Peer>(
    contender: PlanLifecycleSerializationContender,
    startHolder: () => Promise<Holder>,
    startPeer: () => Promise<Peer>,
  ): Promise<SerializationRaceResult<Holder, Peer>> {
    return this.serializationBoundary.race(contender, startHolder, startPeer);
  }

  protected abstract seedUpdate(
    ledgerId: string,
    itemId: string,
    mutate: (item: Item) => void,
  ): Promise<void>;

  async seedGoal(options: SeedGoalOptions): Promise<void> {
    await this.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: options.goalId,
      status: options.phase,
      fields: {
        title: `goal ${options.goalId}`,
        description: `contract goal ${options.goalId}`,
      },
      ...SEED_PROVENANCE,
    });
    if (options.generation !== null) {
      await this.seedUpdate(GOALS_LEDGER, options.goalId, (goal) => {
        goal.fields[PLAN_GENERATION_FIELD] = String(options.generation);
        goal.fields[PLAN_WAITING_RESEARCHES_FIELD] = [];
      });
      await this.persistDirect?.([GOALS_LEDGER]);
    }
  }

  async seedWork(goalId: string, options: SeedWorkOptions): Promise<void> {
    const milestone = await this.store.createMilestone({
      title: "seeded work",
      ...SEED_PROVENANCE,
    });
    await this.seedUpdate(MILESTONES_LEDGER, milestone.id, (mutableMilestone) => {
      mutableMilestone.author = SEED_PROVENANCE.author;
      mutableMilestone.session = SEED_PROVENANCE.session;
    });
    await this.persistDirect?.([MILESTONES_LEDGER]);
    const taskIds: string[] = [];
    for (const [index, status] of options.taskStatuses.entries()) {
      const task = await this.store.createItem(TASKS_LEDGER, milestone.id, {
        status,
        fields: {
          headline: `seeded task ${index + 1}`,
          ...(index === 0 ? {} : { dependsOn: [taskIds[0]!] }),
        },
        ...SEED_PROVENANCE,
      });
      await this.seedUpdate(TASKS_LEDGER, task.id, (mutableTask) => {
        mutableTask.fields["ledgerRefs"] = [`${GOALS_LEDGER}:${goalId}`];
      });
      await this.persistDirect?.([TASKS_LEDGER]);
      taskIds.push(task.id);
    }
    await this.seedUpdate(GOALS_LEDGER, goalId, (goal) => {
      if (options.register === false) return;
      goal.fields["milestones"] = [milestone.id];
      const currentGeneration = Number(goal.fields[PLAN_GENERATION_FIELD] ?? "1");
      const manifest = {
        revision: 1,
        milestones: [{ key: "seeded_milestone", id: milestone.id }],
        tasks: taskIds.map((id, index) => ({ key: `seeded_task_${index + 1}`, id })),
      };
      const identity = {
        goalId,
        claimId: "seeded_claim",
        generation: currentGeneration,
        revision: 1,
      };
      if (options.legacy) {
        delete goal.fields[PLAN_GENERATION_FIELD];
        delete goal.fields[PLAN_ACTIVE_CLAIM_FIELD];
        delete goal.fields[PLAN_CURRENT_DRAFT_FIELD];
        delete goal.fields[PLAN_FINALIZED_DRAFT_FIELD];
        delete goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
        delete goal.fields[PLAN_WAITING_RESEARCHES_FIELD];
      } else {
        goal.fields[PLAN_CURRENT_DRAFT_FIELD] = JSON.stringify({ identity, manifest });
        goal.fields[PLAN_FINALIZED_DRAFT_FIELD] = JSON.stringify(identity);
        goal.fields[PLAN_FINALIZED_MANIFEST_FIELD] = JSON.stringify(manifest);
        goal.fields[PLAN_WAITING_RESEARCHES_FIELD] = [];
      }
    });
    for (let index = 0; index < options.openQuestionCount; index += 1) {
      await this.store.createItem(QUESTIONS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: {
          question: `seeded question ${index + 1}`,
          ledgerRefs: [`${GOALS_LEDGER}:${goalId}`],
        },
        ...SEED_PROVENANCE,
      });
    }
    await this.persistDirect?.([MILESTONES_LEDGER, TASKS_LEDGER, GOALS_LEDGER]);
  }

  async seedReview(options: SeedReviewOptions): Promise<void> {
    const defectIds = allItems(this.store, DEFECTS_LEDGER)
      .filter((item) =>
        refValues(item, "ledgerRefs").includes(`${REVIEWS_LEDGER}:${options.reviewId}`),
      )
      .map(({ id }) => id);
    await this.store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: options.reviewId,
      status: options.status,
      fields: {
        [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify(options.draft),
        ledgerRefs: [`${GOALS_LEDGER}:${options.goalId}`],
        ...(defectIds.length === 0 ? {} : { defects: defectIds }),
      },
      author: options.provenance.author,
      ...(options.provenance.session === undefined ? {} : { session: options.provenance.session }),
    });
  }

  async seedDecision(options: SeedDecisionOptions): Promise<void> {
    await this.store.createItem(DECISIONS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: options.decisionId,
      status: "locked",
      fields: {
        headline: options.headline,
        ledgerRefs: [`${GOALS_LEDGER}:${options.goalId}`, `${REVIEWS_LEDGER}:${options.reviewId}`],
      },
      author: options.provenance.author,
      ...(options.provenance.session === undefined ? {} : { session: options.provenance.session }),
    });
  }

  async setResearchStatus(
    researchId: string,
    status: "open" | "wip" | "inconclusive" | "concluded" | "abandoned",
  ): Promise<void> {
    const current = this.store.fetchItem(RESEARCHES_LEDGER, researchId).status;
    if (current === status) return;
    if (current === "open" && ["wip", "inconclusive", "concluded"].includes(status)) {
      await this.store.updateItem(RESEARCHES_LEDGER, researchId, { status: "wip" });
      if (status === "wip") return;
    }
    await this.store.updateItem(RESEARCHES_LEDGER, researchId, { status });
  }

  async observe(goalId: string): Promise<ReferencePublicGoalState> {
    let goal: Item;
    try {
      goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    } catch {
      throw new Error(`goal not found: ${goalId}`);
    }
    const plan = readInMemoryPlanState(goal);
    const tasks = goalOwned(allItems(this.store, TASKS_LEDGER), goalId).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const milestoneIds = new Set([
      ...tasks.map(({ milestoneId }) => milestoneId),
      ...refValues(goal, "milestones"),
      ...(plan.currentDraft?.manifest.milestones.map(({ id }) => id) ?? []),
      ...(plan.finalizedManifest?.milestones.map(({ id }) => id) ?? []),
    ]);
    const milestones = [...milestoneIds]
      .map((id) => this.store.fetchItem(MILESTONES_LEDGER, id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item): ReferencePublicMilestone => ({
          id: item.id,
          goalId,
          status: item.status as ReferencePublicMilestone["status"],
          title: optionalString(item, "title") ?? "",
          description: optionalString(item, "description"),
          dependsOn: refValues(item, "dependsOn").map(stripInternalRef),
          blockedBy: refValues(item, "blockedBy").map(stripInternalRef),
        taskIds: tasks.filter(({ milestoneId }) => milestoneId === item.id).map(({ id }) => id),
          provenance: provenance(item),
      }));
    const finalizedTaskIds = new Set(plan.finalizedManifest?.tasks.map(({ id }) => id) ?? []);
    const publicTasks = tasks.map((item): ReferencePublicTask => ({
        id: item.id,
        goalId,
        milestoneId: item.milestoneId,
        status: item.status as ReferencePublicTask["status"],
        headline: optionalString(item, "headline") ?? "",
        description: optionalString(item, "description"),
        acceptance: optionalString(item, "acceptance"),
        suggestedModel: optionalString(item, "suggestedModel"),
      ledgerRefs: refValues(item, "ledgerRefs"),
        sourceRefs: refValues(item, "sourceRefs"),
        tags: refValues(item, "tags"),
        dependsOn: refValues(item, "dependsOn").map(stripInternalRef),
        blockedBy: refValues(item, "blockedBy").map(stripInternalRef),
        executable: finalizedTaskIds.has(item.id),
        provenance: provenance(item),
    }));
    const questions = goalOwned(allItems(this.store, QUESTIONS_LEDGER), goalId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item): ReferencePublicQuestion => ({
          id: item.id,
          goalId,
          status: item.status,
          text: optionalString(item, "question") ?? "",
          context: optionalString(item, "context"),
          suggestions: refValues(item, "suggestions"),
          recommendation: optionalString(item, "recommendation"),
          ledgerRefs: refValues(item, "ledgerRefs"),
          provenance: provenance(item),
      }));
    const researches = goalOwned(allItems(this.store, RESEARCHES_LEDGER), goalId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item): ReferencePublicResearch => ({
          id: item.id,
          goalId,
          status: item.status,
          text: optionalString(item, "question") ?? "",
          scope: optionalString(item, "scope"),
          provenance: provenance(item),
      }));
    const defects = goalOwned(allItems(this.store, DEFECTS_LEDGER), goalId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item): ReferencePublicDefect => ({
          id: item.id,
          goalId,
          status: item.status,
          text: optionalString(item, "headline") ?? "",
          reviewId: reviewId(item),
          severity: optionalString(item, "severity") as ReferencePublicDefect["severity"],
          description: optionalString(item, "description"),
          rootCause: optionalString(item, "rootCause"),
          suggestedFix: optionalString(item, "suggestedFix"),
          sourceRefs: refValues(item, "sourceRefs"),
          tags: refValues(item, "tags"),
          provenance: provenance(item),
      }));
    const reviews = goalOwned(allItems(this.store, REVIEWS_LEDGER), goalId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item): ReferencePublicReview => ({
          id: item.id,
          goalId,
          status: item.status as ReferencePublicReview["status"],
          draft: JSON.parse(optionalString(item, PLAN_REVIEW_DRAFT_FIELD) ?? "null"),
          provenance: provenance(item),
      }));
    const decisions = goalOwned(allItems(this.store, DECISIONS_LEDGER), goalId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        goalId,
        status: item.status,
        text: optionalString(item, "headline") ?? "",
        reviewId: reviewId(item),
        rationale: optionalString(item, "rationale"),
        alternatives: optionalString(item, "alternatives"),
        provenance: provenance(item),
      }));
    const taskStatus = new Map(publicTasks.map(({ id, status }) => [id, status]));
    const readyTaskIds = publicTasks
      .filter(
        (task) =>
          task.executable &&
          task.status === "planned" &&
          task.dependsOn.every((id) => taskStatus.get(id) === "done"),
      )
      .map(({ id }) => id);
    return {
      goalId,
      phase: goal.status as ReferencePublicGoalState["phase"],
      generation: plan.generation,
      activeClaim: plan.activeClaim,
      currentDraft: plan.currentDraft?.identity ?? null,
      finalizedManifest: plan.finalizedManifest,
      milestoneIds: refValues(goal, "milestones"),
      waitingResearches: plan.waitingResearches,
      milestones,
      tasks: publicTasks,
      questions,
      researches,
      defects,
      reviews,
      decisions,
      readyTaskIds,
    };
  }

  abstract restart(): Promise<PlanLifecycleContractFixture>;

  async rawMutateManagedState(goalId: string): Promise<void> {
    await this.store.updateItem(GOALS_LEDGER, goalId, {
      fields: { [PLAN_GENERATION_FIELD]: "999" },
    });
  }

  async startTask(
    taskId: string,
    provenanceValue: { author: string; session?: string },
  ): Promise<void> {
    await this.store.updateItem(TASKS_LEDGER, taskId, {
      status: "wip",
      ...provenanceValue,
    });
  }

  async blockTask(
    taskId: string,
    provenanceValue: { author: string; session?: string },
  ): Promise<void> {
    await this.store.updateItem(TASKS_LEDGER, taskId, {
      status: "blocked",
      ...provenanceValue,
    });
  }

  async seedQuestion(goalId: string, refs: readonly string[]): Promise<{ id: string }> {
    const item = await this.store.createItem(QUESTIONS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: {
        question: `seeded question for ${goalId}`,
        ledgerRefs: [...refs],
      },
      ...SEED_PROVENANCE,
    });
    return { id: item.id };
  }

  async rawReopenTask(taskId: string, toStatus: string): Promise<void> {
    await this.store.reopenItem(TASKS_LEDGER, taskId, toStatus);
  }

  async dispose(): Promise<void> {
    await this.store.dispose();
  }
}

export class InMemoryPlanLifecycleFixture extends LedgerStorePlanLifecycleFixture<LifecycleBackedLedgerStore> {
  constructor(
    store: LifecycleBackedLedgerStore,
    private readonly restartBuilder?: () => Promise<LifecycleBackedLedgerStore>,
    persistDirect?: (ledgerIds: readonly string[]) => Promise<void>,
    serializationBoundary = new OneShotSerializationBoundary(),
  ) {
    super(store, store, persistDirect, serializationBoundary);
  }

  static async create(): Promise<InMemoryPlanLifecycleFixture> {
    const serializationBoundary = new OneShotSerializationBoundary();
    const store = new InMemoryLedgerStore({
      planSerializationBoundaryHook: serializationBoundary.hook,
    });
    await store.init();
    return new InMemoryPlanLifecycleFixture(store, undefined, undefined, serializationBoundary);
  }

  protected async seedUpdate(
    ledgerId: string,
    itemId: string,
    mutate: (item: Item) => void,
  ): Promise<void> {
    mutate(findMutableItem(this.store, ledgerId, itemId));
  }

  async restart(): Promise<PlanLifecycleContractFixture> {
    if (this.restartBuilder !== undefined) {
      const next = await this.restartBuilder();
      return new InMemoryPlanLifecycleFixture(
        next,
        this.restartBuilder,
        this.persistDirect === undefined
          ? undefined
          : async (ledgerIds) => persistDirectLedgers(next, ledgerIds),
        new OneShotSerializationBoundary(),
      );
    }
    const serializationBoundary = new OneShotSerializationBoundary();
    const next = new InMemoryLedgerStore({
      planSerializationBoundaryHook: serializationBoundary.hook,
    });
    await next.init();
    const source = internals(this.store);
    const target = internals(next);
    target.ledgers.clear();
    for (const [key, value] of source.ledgers) target.ledgers.set(key, cloneLedger(value));
    target.planClaims!.clear();
    for (const [key, value] of source.planClaims!) {
      target.planClaims!.set(key, clone(value));
    }
    target.planOperations!.clear();
    for (const [key, value] of source.planOperations!) {
      target.planOperations!.set(key, clone(value));
    }
    return new InMemoryPlanLifecycleFixture(next, undefined, undefined, serializationBoundary);
  }
}

export async function persistDirectLedgers(
  store: LifecycleBackedLedgerStore,
  ledgerIds: readonly string[],
): Promise<void> {
  const state = internals(store);
  if (state.writeLedgerFile === undefined) return;
  for (const ledgerId of new Set(ledgerIds)) {
    const ledger = state.ledgers.get(ledgerId);
    if (ledger === undefined) throw new Error(`ledger not found: ${ledgerId}`);
    await state.writeLedgerFile(ledger);
  }
}

export const inMemoryPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "InMemoryLedgerStore",
  classification: "Behavioral-Active Blackbox-Atomic",
  progression: false,
  build: () => InMemoryPlanLifecycleFixture.create(),
};
