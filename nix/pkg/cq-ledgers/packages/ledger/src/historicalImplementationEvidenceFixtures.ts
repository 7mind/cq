import { createHash } from "node:crypto";
import type { DispatchJSONValue } from "@cq/config";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  OPERATOR_ACTIONS_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
} from "./constants.js";
import type {
  PackagedImplementationAuditManifest,
  PackagedImplementationAuditRecord,
} from "./implementationEvidence.js";
import { IMPLEMENTATION_EVIDENCE_ACTIVATION_MANIFEST_V2 } from "./implementationEvidence.js";
import {
  PLAN_FINALIZED_MANIFEST_FIELD,
  PlanPublishedManifestSchema,
  type PlanPublishedManifest,
} from "./planLifecycle.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import type { Item } from "./types.js";
import { readCanonicalOwnership } from "./worksetOwnerEdges.js";

export interface HistoricalImplementationAuditRule {
  readonly defectRef: string;
  readonly finalizedManifestDigest: string;
}

export interface HistoricalImplementationSourceObservation {
  readonly taskRef: string;
  readonly status: string;
  readonly resultCommit: string | null;
  readonly ownLedgerRef: string;
  readonly ownerRefs: readonly string[];
  readonly ownerEdgeRef: string;
  readonly finalizedManifestDigest: string;
}

export interface ImplementationEvidenceActivationTaskObservation {
  readonly taskRef: string;
  readonly ownerGoalRef: string | null;
  readonly ownerEdgeKind: string | null;
  readonly status: string;
  readonly resultCommit: string | null;
  readonly retainedAtBoundary: boolean;
}

export interface HistoricalImplementationFixtureExpectation {
  readonly manifestId: string;
  readonly rule: HistoricalImplementationAuditRule;
  readonly expectedTaskRefs: readonly string[];
  readonly reviewRefs: Readonly<Record<string, string>>;
  readonly abstentionReviewRefs: readonly string[];
  readonly excludedExternalEffects: Readonly<Record<string, string>>;
  readonly requiredResultCommits: Readonly<Record<string, string>>;
}

export interface HistoricalImplementationRepositoryReader {
  readonly repositoryHead: () => Promise<string>;
  readonly readCommitFile: (commit: string, path: string) => Promise<string>;
  readonly diff: (baseCommit: string, resultCommit: string) => Promise<string>;
  readonly isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
}

export interface ReadPackagedImplementationAuditManifestInput {
  readonly store: Pick<LedgerStore, "fetch" | "fetchArchive">;
  readonly repository: HistoricalImplementationRepositoryReader;
  readonly manifestId: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/u;
const TASK_REF = /^tasks:T[0-9]+$/u;

interface SourcedItem {
  readonly item: Item;
  readonly source: "active" | "archive";
  readonly archiveId: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function itemForEvidence(source: SourcedItem): Record<string, unknown> {
  return {
    source: source.source,
    archiveId: source.archiveId,
    item: {
      id: source.item.id,
      milestoneId: source.item.milestoneId,
      status: source.item.status,
      fields: source.item.fields,
      createdAt: source.item.createdAt,
      updatedAt: source.item.updatedAt,
      ...(source.item.author === undefined ? {} : { author: source.item.author }),
      ...(source.item.session === undefined ? {} : { session: source.item.session }),
    },
  };
}

async function allItems(
  reader: Pick<LedgerStore, "fetch" | "fetchArchive">,
  ledgerId: string,
): Promise<readonly SourcedItem[]> {
  const ledger = reader.fetch(ledgerId);
  const items: SourcedItem[] = ledger.milestones.flatMap((group) =>
    group.items.map((item) => ({ item, source: "active" as const, archiveId: null })),
  );
  for (const pointer of ledger.archivePointers) {
    const archive = await reader.fetchArchive(ledgerId, pointer.id);
    const archived = archive.kind === "group" ? archive.milestone.items : [archive.item];
    items.push(
      ...archived.map((item) => ({
        item,
        source: "archive" as const,
        archiveId: pointer.id,
      })),
    );
  }
  return items;
}

function uniqueItem(items: readonly SourcedItem[], ledgerId: string, itemId: string): SourcedItem {
  const matches = items.filter(({ item }) => item.id === itemId);
  if (matches.length !== 1)
    throw new Error(`${ledgerId}:${itemId} resolves to ${String(matches.length)} authority records`);
  return matches[0]!;
}

function parseFinalizedManifest(goal: SourcedItem): {
  readonly raw: string;
  readonly parsed: PlanPublishedManifest;
  readonly digest: string;
} {
  const raw = goal.item.fields[PLAN_FINALIZED_MANIFEST_FIELD];
  if (typeof raw !== "string") throw new Error(`goal ${goal.item.id} has no finalized manifest`);
  const parsed = PlanPublishedManifestSchema.parse(JSON.parse(raw));
  return { raw, parsed, digest: sha256(raw) };
}

function historicalReviewObservation(review: SourcedItem | undefined): DispatchJSONValue | null {
  if (review === undefined) return null;
  return {
    reviewRef: `${REVIEWS_LEDGER}:${review.item.id}`,
    ...itemForEvidence(review),
  } as DispatchJSONValue;
}

function baseCommitFromWip(taskId: string, wip: string): string {
  const fenced = /^```json\n([\s\S]*?)\n```/u.exec(wip);
  if (fenced?.[1] === undefined) throw new Error(`WIP-${taskId}.md has no fenced JSON header`);
  const header = JSON.parse(fenced[1]) as Record<string, unknown>;
  if (header["taskId"] !== taskId || typeof header["baseCommit"] !== "string" ||
    !FULL_SHA.test(header["baseCommit"]))
    throw new Error(`WIP-${taskId}.md does not bind the task and a full base commit`);
  return header["baseCommit"];
}

async function packagedRecord(input: {
  readonly manifestId: string;
  readonly task: SourcedItem;
  readonly ownerGoalRef: string;
  readonly finalizedManifest: string;
  readonly historicalReview: SourcedItem | undefined;
  readonly repositoryHead: string;
  readonly repository: HistoricalImplementationRepositoryReader;
}): Promise<{ readonly record: PackagedImplementationAuditRecord; readonly source: unknown }> {
  const taskId = input.task.item.id;
  const resultCommit = input.task.item.fields["resultCommit"];
  if (input.task.item.status !== "done" || typeof resultCommit !== "string" ||
    !FULL_SHA.test(resultCommit))
    throw new Error(`historical audit task ${taskId} has no completed Git result`);
  if (!(await input.repository.isAncestor(resultCommit, input.repositoryHead)))
    throw new Error(`historical audit task ${taskId} result is not retained`);
  const wipPath = `WIP-${taskId}.md`;
  const wip = await input.repository.readCommitFile(resultCommit, wipPath);
  const baseCommit = baseCommitFromWip(taskId, wip);
  if (!(await input.repository.isAncestor(baseCommit, resultCommit)))
    throw new Error(`historical audit task ${taskId} base is not an ancestor of its result`);
  const diff = await input.repository.diff(baseCommit, resultCommit);
  const wipDigest = sha256(wip);
  const historicalReview = historicalReviewObservation(input.historicalReview);
  return {
    record: {
      recordKey: `${input.manifestId}:${taskId}`,
      taskRef: `${TASKS_LEDGER}:${taskId}`,
      ownerGoalRef: input.ownerGoalRef,
      finalizedManifest: input.finalizedManifest,
      historicalReview,
      baseCommit,
      resultCommit,
      repositoryHead: input.repositoryHead,
      diff,
      acceptance: { text: input.task.item.fields["acceptance"] ?? "" },
      gateObservations: {
        source: "git-wip",
        path: wipPath,
        digest: wipDigest,
        completion: input.task.item.fields["completion"] ?? "",
      },
      requiredObservations: [
        "task-authority",
        "owner-goal-finalized-manifest",
        "base-result-ancestry",
        "result-retained-at-repository-head",
        "diff-and-acceptance",
        "gate-observations",
      ],
    },
    source: {
      task: itemForEvidence(input.task),
      historicalReview,
      wipPath,
      wipDigest,
      baseCommit,
      resultCommit,
      diffDigest: sha256(diff),
    },
  };
}

/**
 * Derive the qualifying Git cohort from active plus advertised archive
 * observations. Expected fixture task ids are deliberately not consulted.
 */
export function deriveHistoricalImplementationAuditTaskRefs(
  observations: readonly HistoricalImplementationSourceObservation[],
  rule: HistoricalImplementationAuditRule,
): readonly string[] {
  const selected = new Map<string, HistoricalImplementationSourceObservation>();
  for (const observation of observations) {
    if (
      !TASK_REF.test(observation.taskRef) ||
      observation.status !== "done" ||
      observation.resultCommit === null ||
      !FULL_SHA.test(observation.resultCommit) ||
      observation.ownLedgerRef !== observation.taskRef ||
      observation.ownerRefs.length !== 1 ||
      observation.ownerRefs[0] !== rule.defectRef ||
      observation.ownerEdgeRef !== rule.defectRef ||
      observation.finalizedManifestDigest !== rule.finalizedManifestDigest
    )
      continue;
    if (selected.has(observation.taskRef))
      throw new Error(`duplicate active/archive authority for ${observation.taskRef}`);
    selected.set(observation.taskRef, observation);
  }
  return [...selected.keys()].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

export const HISTORICAL_IMPLEMENTATION_FIXTURES = {
  D303: {
    manifestId: "d303-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D303", finalizedManifestDigest: "3".repeat(64) },
    expectedTaskRefs: ["tasks:T2096", "tasks:T2109", "tasks:T2110"],
    reviewRefs: {
      "tasks:T2096": "reviews:R1376",
      "tasks:T2109": "reviews:R1419",
      "tasks:T2110": "reviews:R1420",
    },
    abstentionReviewRefs: ["reviews:R1419"],
    excludedExternalEffects: {},
    requiredResultCommits: {
      "tasks:T2096": "a828a90fd0813d28f5f142a2ed80d2709533d0da",
      "tasks:T2109": "09731511f5388b9aa0f3a69105bec07da490c3d1",
      "tasks:T2110": "b53097724281441c55524c9a54a21a750124ebde",
    },
  },
  D340: {
    manifestId: "d340-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D340", finalizedManifestDigest: "4".repeat(64) },
    expectedTaskRefs: [
      "tasks:T2144",
      "tasks:T2145",
      "tasks:T2146",
      "tasks:T2147",
      "tasks:T2151",
    ],
    reviewRefs: {},
    abstentionReviewRefs: [],
    excludedExternalEffects: {},
    requiredResultCommits: {
      "tasks:T2151": "5dee782ebd6a0b2c743286c0f19752801944bac5",
    },
  },
  D343: {
    manifestId: "d343-historical-implementation-evidence-v1",
    rule: { defectRef: "defects:D343", finalizedManifestDigest: "5".repeat(64) },
    expectedTaskRefs: ["tasks:T2228"],
    reviewRefs: { "tasks:T2228": "reviews:R1413" },
    abstentionReviewRefs: [],
    excludedExternalEffects: { "tasks:T2229": "operatorActions:OA2229" },
    requiredResultCommits: {
      "tasks:T2228": "271d9e6e6230012784e7667b6b02ee76b33cc94e",
    },
  },
} as const satisfies Readonly<Record<string, HistoricalImplementationFixtureExpectation>>;

export const D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE = {
  manifestId: "d347-implementation-evidence-activation-v1",
  goalRef: "goals:G176",
  evidenceTaskKey: "t-evidence",
  auditTaskKey: "t-historical-evidence",
  activationTaskKey: "t-activate-evidence",
} as const;

export const D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2 = {
  ...D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  manifestId: IMPLEMENTATION_EVIDENCE_ACTIVATION_MANIFEST_V2,
} as const;

export const D347_REJECTED_PREDECESSOR_PROVENANCE = {
  taskRef: "tasks:T2346",
  requiredAncestorCommit: "00ebe7e4982cbf9d847b5713c65f5fa46b6bda72",
  authorizes: false,
} as const;

const D347_REJECTED_PREDECESSOR_REVIEW_REF = "reviews:R1548";

export const PACKAGED_IMPLEMENTATION_AUDIT_MANIFEST_INVENTORY = [
  ...Object.values(HISTORICAL_IMPLEMENTATION_FIXTURES).map(({ manifestId }) => manifestId),
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE.manifestId,
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2.manifestId,
] as const;

function taskOrder(left: SourcedItem, right: SourcedItem): number {
  return left.item.id.localeCompare(right.item.id, undefined, { numeric: true });
}

function assertExpectedHistoricalCohort(
  fixture: HistoricalImplementationFixtureExpectation,
  taskRefs: readonly string[],
): void {
  if (JSON.stringify(taskRefs) !== JSON.stringify(fixture.expectedTaskRefs))
    throw new Error(
      `${fixture.manifestId} authority-derived cohort changed: ${JSON.stringify(taskRefs)}`,
    );
  for (const [taskRef, resultCommit] of Object.entries(fixture.requiredResultCommits)) {
    if (!taskRefs.includes(taskRef))
      throw new Error(`${fixture.manifestId} is missing required historical task ${taskRef}`);
    if (!FULL_SHA.test(resultCommit))
      throw new Error(`${fixture.manifestId} has a malformed required result commit`);
  }
}

/**
 * Trusted production registry. Membership is discovered from the current
 * active and advertised archive authority, then checked against the reviewed
 * fixture expectation; the expectation is never used to select records.
 */
export async function readPackagedImplementationAuditManifest(
  input: ReadPackagedImplementationAuditManifestInput,
): Promise<PackagedImplementationAuditManifest> {
  const historical = Object.values(HISTORICAL_IMPLEMENTATION_FIXTURES).find(
    (fixture) => fixture.manifestId === input.manifestId,
  );
  const activation =
    input.manifestId === D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE.manifestId
      ? D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE
      : input.manifestId === D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2.manifestId
        ? D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2
        : null;
  if (historical === undefined && activation === null)
    throw new Error(`unknown packaged implementation audit manifest ${input.manifestId}`);

  const [tasks, goals, defects, reviews, operatorActions] = await Promise.all([
    allItems(input.store, TASKS_LEDGER),
    allItems(input.store, GOALS_LEDGER),
    allItems(input.store, DEFECTS_LEDGER),
    allItems(input.store, REVIEWS_LEDGER),
    allItems(input.store, OPERATOR_ACTIONS_LEDGER),
  ]);
  const repositoryHead = await input.repository.repositoryHead();
  if (!FULL_SHA.test(repositoryHead)) throw new Error("packaged audit repository head is malformed");

  let goal: SourcedItem;
  let finalized: ReturnType<typeof parseFinalizedManifest>;
  let selected: readonly SourcedItem[];
  let reviewRefs: Readonly<Record<string, string>> = {};
  const authoritySources: unknown[] = [];

  if (historical !== undefined) {
    const defectId = historical.rule.defectRef.slice(`${DEFECTS_LEDGER}:`.length);
    const defect = uniqueItem(defects, DEFECTS_LEDGER, defectId);
    const ownedGoals = goals.filter(({ item }) => {
      const ownership = readCanonicalOwnership(item);
      return ownership?.ownerRef === historical.rule.defectRef && ownership.edgeKind === "fix-goal";
    });
    if (ownedGoals.length !== 1)
      throw new Error(`${historical.rule.defectRef} has ${String(ownedGoals.length)} sealed fix goals`);
    goal = ownedGoals[0]!;
    const goalRef = `${GOALS_LEDGER}:${goal.item.id}`;
    finalized = parseFinalizedManifest(goal);
    const finalizedTaskIds = new Set(finalized.parsed.tasks.map(({ id }) => id));
    selected = tasks
      .filter(({ item }) => {
        const ownership = readCanonicalOwnership(item);
        return (
          ownership?.ownerRef === goalRef &&
          ownership.edgeKind === "finalized-manifest" &&
          item.status === "done" &&
          typeof item.fields["resultCommit"] === "string" &&
          FULL_SHA.test(item.fields["resultCommit"]) &&
          finalizedTaskIds.has(item.id)
        );
      })
      .sort(taskOrder);
    const taskRefs = selected.map(({ item }) => `${TASKS_LEDGER}:${item.id}`);
    assertExpectedHistoricalCohort(historical, taskRefs);
    reviewRefs = historical.reviewRefs;
    for (const [taskRef, requiredCommit] of Object.entries(historical.requiredResultCommits)) {
      const task = selected.find(({ item }) => `${TASKS_LEDGER}:${item.id}` === taskRef);
      if (task?.item.fields["resultCommit"] !== requiredCommit)
        throw new Error(`${taskRef} result commit differs from the reviewed fixture`);
    }
    for (const [taskRef, actionRef] of Object.entries(historical.excludedExternalEffects)) {
      if (taskRefs.includes(taskRef))
        throw new Error(`${taskRef} must remain exclusively on the external-effect arm`);
      const action = uniqueItem(
        operatorActions,
        OPERATOR_ACTIONS_LEDGER,
        actionRef.slice(`${OPERATOR_ACTIONS_LEDGER}:`.length),
      );
      if (action.item.fields["taskRef"] !== taskRef)
        throw new Error(`${actionRef} does not bind excluded external-effect task ${taskRef}`);
      authoritySources.push(itemForEvidence(action));
    }
    authoritySources.push(itemForEvidence(defect));
  } else {
    if (activation === null) throw new Error("D347 activation rule is unavailable");
    goal = uniqueItem(
      goals,
      GOALS_LEDGER,
      D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE.goalRef.slice(`${GOALS_LEDGER}:`.length),
    );
    finalized = parseFinalizedManifest(goal);
    const mappings = resolveImplementationEvidenceActivationTaskMappings(
      finalized.parsed,
      D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
    );
    const activationTaskId = mappings.activationTaskRef.slice(`${TASKS_LEDGER}:`.length);
    const finalizedTaskIds = new Set(finalized.parsed.tasks.map(({ id }) => id));
    const candidates = tasks
      .filter(({ item }) => {
        const ownership = readCanonicalOwnership(item);
        return (
          item.id !== activationTaskId &&
          finalizedTaskIds.has(item.id) &&
          ownership?.ownerRef === D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE.goalRef &&
          ownership.edgeKind === "finalized-manifest" &&
          item.status === "done" &&
          typeof item.fields["resultCommit"] === "string" &&
          FULL_SHA.test(item.fields["resultCommit"])
        );
      })
      .sort(taskOrder);
    if (activation.manifestId === D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2.manifestId) {
      const freshRefs = [mappings.evidenceTaskRef, mappings.auditTaskRef];
      selected = freshRefs.map((taskRef) => {
        const matches = candidates.filter(
          ({ item }) => `${TASKS_LEDGER}:${item.id}` === taskRef,
        );
        if (matches.length !== 1)
          throw new Error(`fresh D347 v2 cohort has ${String(matches.length)} ${taskRef} records`);
        return matches[0]!;
      }).sort(taskOrder);
    } else {
      const retained: SourcedItem[] = [];
      for (const candidate of candidates) {
        const resultCommit = candidate.item.fields["resultCommit"];
        if (typeof resultCommit !== "string" || !FULL_SHA.test(resultCommit))
          throw new Error("D347 activation candidate has no completed Git result");
        if (await input.repository.isAncestor(resultCommit, repositoryHead)) retained.push(candidate);
      }
      selected = retained;
    }
    for (const candidate of selected) {
      const resultCommit = candidate.item.fields["resultCommit"];
      if (
        typeof resultCommit !== "string" ||
        !FULL_SHA.test(resultCommit) ||
        !(await input.repository.isAncestor(resultCommit, repositoryHead))
      )
        throw new Error("fresh D347 activation result is not retained at the boundary");
    }
    const selectedRefs = selected.map(({ item }) => `${TASKS_LEDGER}:${item.id}`);
    if (!selectedRefs.includes(mappings.evidenceTaskRef) ||
      !selectedRefs.includes(mappings.auditTaskRef))
      throw new Error("D347 authority-derived cohort omits a finalized bootstrap task mapping");
  }

  const recordsAndSources = await Promise.all(
    selected.map(async (task) => {
      const taskRef = `${TASKS_LEDGER}:${task.item.id}`;
      const reviewRef = reviewRefs[taskRef];
      const review = reviewRef === undefined
        ? undefined
        : uniqueItem(reviews, REVIEWS_LEDGER, reviewRef.slice(`${REVIEWS_LEDGER}:`.length));
      return await packagedRecord({
        manifestId: input.manifestId,
        task,
        ownerGoalRef: `${GOALS_LEDGER}:${goal.item.id}`,
        finalizedManifest: finalized.raw,
        historicalReview: review,
        repositoryHead,
        repository: input.repository,
      });
    }),
  );
  authoritySources.push(itemForEvidence(goal));
  let nonAuthorizingProvenance:
    | PackagedImplementationAuditManifest["nonAuthorizingProvenance"]
    | undefined;
  if (activation?.manifestId === D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE_V2.manifestId) {
    const predecessor = uniqueItem(
      tasks,
      TASKS_LEDGER,
      D347_REJECTED_PREDECESSOR_PROVENANCE.taskRef.slice(`${TASKS_LEDGER}:`.length),
    );
    const predecessorReview = uniqueItem(
      reviews,
      REVIEWS_LEDGER,
      D347_REJECTED_PREDECESSOR_REVIEW_REF.slice(`${REVIEWS_LEDGER}:`.length),
    );
    const predecessorReviewRefs = predecessorReview.item.fields["ledgerRefs"];
    if (
      predecessorReview.item.status !== "revise" ||
      !(
        (Array.isArray(predecessorReviewRefs) &&
          predecessorReviewRefs.includes(D347_REJECTED_PREDECESSOR_PROVENANCE.taskRef)) ||
        predecessorReview.item.fields["taskRef"] === D347_REJECTED_PREDECESSOR_PROVENANCE.taskRef
      )
    )
      throw new Error("T2346 must retain one authenticated disapproval as non-authorizing provenance");
    if (
      !(await input.repository.isAncestor(
        D347_REJECTED_PREDECESSOR_PROVENANCE.requiredAncestorCommit,
        repositoryHead,
      ))
    )
      throw new Error("T2346 original implementation ancestry is not retained");
    nonAuthorizingProvenance = [{
      ...D347_REJECTED_PREDECESSOR_PROVENANCE,
      historicalReview: historicalReviewObservation(predecessorReview)!,
    }];
    authoritySources.push({
      predecessor: itemForEvidence(predecessor),
      disapproval: itemForEvidence(predecessorReview),
      requiredAncestorCommit: D347_REJECTED_PREDECESSOR_PROVENANCE.requiredAncestorCommit,
      authorizes: false,
    });
  }
  const sourceDigest = sha256(
    JSON.stringify({
      manifestId: input.manifestId,
      repositoryHead,
      finalizedManifestDigest: finalized.digest,
      authority: authoritySources,
      records: recordsAndSources.map(({ source }) => source),
    }),
  );
  return {
    version: 1,
    manifestId: input.manifestId,
    sourceDigest,
    records: recordsAndSources.map(({ record }) => record),
    activation: activation === null
      ? null
      : {
          goalRef: activation.goalRef,
          finalizedManifestDigest: finalized.digest,
          evidenceTaskKey: activation.evidenceTaskKey,
          auditTaskKey: activation.auditTaskKey,
          activationTaskKey: activation.activationTaskKey,
        },
    ...(nonAuthorizingProvenance === undefined ? {} : { nonAuthorizingProvenance }),
  };
}

export function resolveImplementationEvidenceActivationTaskMappings(
  manifest: PlanPublishedManifest,
  rule: {
    readonly evidenceTaskKey: string;
    readonly auditTaskKey: string;
    readonly activationTaskKey: string;
  },
): { readonly evidenceTaskRef: string; readonly auditTaskRef: string; readonly activationTaskRef: string } {
  const mapping = new Map(manifest.tasks.map(({ key, id }) => [key, id]));
  const evidenceTaskId = mapping.get(rule.evidenceTaskKey);
  const auditTaskId = mapping.get(rule.auditTaskKey);
  const activationTaskId = mapping.get(rule.activationTaskKey);
  if (evidenceTaskId === undefined || auditTaskId === undefined || activationTaskId === undefined)
    throw new Error("finalized manifest omits an implementation evidence bootstrap mapping");
  return {
    evidenceTaskRef: `tasks:${evidenceTaskId}`,
    auditTaskRef: `tasks:${auditTaskId}`,
    activationTaskRef: `tasks:${activationTaskId}`,
  };
}

export function deriveImplementationEvidenceActivationCohort(
  manifest: PlanPublishedManifest,
  rule: {
    readonly goalRef: string;
    readonly evidenceTaskKey: string;
    readonly auditTaskKey: string;
    readonly activationTaskKey: string;
  },
  observations: readonly ImplementationEvidenceActivationTaskObservation[],
): {
  readonly evidenceTaskRef: string;
  readonly auditTaskRef: string;
  readonly activationTaskRef: string;
  readonly taskRefs: readonly string[];
} {
  const mappings = resolveImplementationEvidenceActivationTaskMappings(manifest, rule);
  const finalizedTaskRefs = new Set(manifest.tasks.map(({ id }) => `${TASKS_LEDGER}:${id}`));
  const selected = new Set<string>();
  for (const observation of observations) {
    if (
      observation.taskRef === mappings.activationTaskRef ||
      !finalizedTaskRefs.has(observation.taskRef) ||
      observation.ownerGoalRef !== rule.goalRef ||
      observation.ownerEdgeKind !== "finalized-manifest" ||
      observation.status !== "done" ||
      observation.resultCommit === null ||
      !FULL_SHA.test(observation.resultCommit) ||
      !observation.retainedAtBoundary
    )
      continue;
    if (selected.has(observation.taskRef))
      throw new Error(`duplicate activation authority for ${observation.taskRef}`);
    selected.add(observation.taskRef);
  }
  const taskRefs = [...selected].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  if (!taskRefs.includes(mappings.evidenceTaskRef) || !taskRefs.includes(mappings.auditTaskRef))
    throw new Error("implementation evidence activation cohort omits a finalized bootstrap task");
  return { ...mappings, taskRefs };
}
