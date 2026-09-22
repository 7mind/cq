import { beforeAll, describe, expect, test } from "bun:test";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createWorksetGuardedPlanLifecycleStore,
  createWorksetOwnedGuardedLedger,
  implementationCompletionMergeAdmissionProviderFromStore,
  recordProtectedImplementationCompletion,
  worksetMemberRefSet,
} from "../src/index.js";
import {
  IMPLEMENTATION_RESULT,
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

const FORWARD_DEFECT_ID = "D1";
const REVERSE_DEFECT_ID = "D2";
const ALL_DONE_DEFECT_ID = "D3";
const ADVISORY_DEFECT_ID = "D4";

interface ProbeResult {
  readonly statuses: Readonly<Record<string, string>>;
  readonly unfinishedTaskStatus: string;
  readonly fixGoalRef: string;
  readonly beforeClosure: readonly string[];
  readonly afterClosure: readonly string[];
}

async function runProbe(): Promise<ProbeResult> {
  const ledger = new InMemoryLedgerStore();
  await ledger.init();
  const milestone = await ledger.createMilestone({
    title: "implementation completion reconciliation",
  });
  const fixMilestone = await ledger.createMilestone({ title: "reverse-linked defect fixes" });
  await ledger.createItem(GOALS_LEDGER, milestone.id, {
    id: "G1",
    status: "building",
    fields: { title: "implementation", description: "implementation" },
  });
  await ledger.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2345",
    status: "wip",
    fields: {
      headline: "completing fix",
      ledgerRefs: [
        `defects:${FORWARD_DEFECT_ID}`,
        `defects:${REVERSE_DEFECT_ID}`,
        `defects:${ALL_DONE_DEFECT_ID}`,
        `defects:${ADVISORY_DEFECT_ID}`,
      ],
    },
  });
  await ledger.createItem(TASKS_LEDGER, fixMilestone.id, {
    id: "T2346",
    status: "wip",
    fields: {
      headline: "unfinished sibling fix",
      ledgerRefs: [`defects:${REVERSE_DEFECT_ID}`],
    },
  });
  await ledger.updateMilestone(fixMilestone.id, { dependsOn: ["tasks:T2346"] });
  await ledger.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: REVERSE_DEFECT_ID,
    status: "root-caused",
    fields: { headline: "reverse-linked partial fix", severity: "high" },
  });

  const worksetStore = ledger.worksetStore();
  const guarded = createWorksetOwnedGuardedLedger({
    rawStore: ledger,
    worksetStore,
    runOwnedTransaction: async (mutate, context) =>
      await ledger.runAtomicOwnedMutation(mutate, context),
  });
  const { goal: fixGoal } = await guarded.bundles.bootstrapDefectToFixGoal({
    defectId: REVERSE_DEFECT_ID,
    goal: {
      title: "finish every reverse-linked fix",
      description: "T2346 remains required",
      fields: { sourceRefs: [`defects:${REVERSE_DEFECT_ID}`] },
    },
  });
  await ledger.updateItem(GOALS_LEDGER, fixGoal.id, {
    fields: { milestones: [fixMilestone.id] },
    author: "probe",
  });
  const plan = createWorksetGuardedPlanLifecycleStore({
    rawStore: ledger,
    worksetStore,
    runOwnedTransaction: async (mutate, context) =>
      await ledger.runAtomicOwnedMutation(mutate, context),
    runPlanLifecycleTransaction: async (context, mutate) =>
      await ledger.runAtomicWorksetPlanLifecycleMutation(context, mutate),
  });
  const claim = await plan.claimPlan({
    goalId: fixGoal.id,
    purpose: "initial",
    claimRequestId: "claim-d520-reconciliation",
    ownerFenceToken: "d520reconciliationtoken",
    expectedGeneration: null,
    author: "probe",
  });
  if (!claim.ok) throw new Error(`fix-goal claim failed: ${claim.conflict.code}`);
  if (!claim.acknowledgement.adoptedManifest.taskIds.includes("T2346")) {
    throw new Error("fix-goal claim did not adopt T2346");
  }
  await ledger.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2347",
    status: "done",
    fields: { headline: "finished sibling fix" },
  });
  await ledger.createItem(TASKS_LEDGER, milestone.id, {
    id: "T2348",
    status: "wip",
    fields: {
      headline: "advisory consumer",
      sourceRefs: [`defects:${ADVISORY_DEFECT_ID}`],
    },
  });
  await ledger.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: FORWARD_DEFECT_ID,
    status: "root-caused",
    fields: {
      headline: "forward-linked partial fix",
      severity: "high",
      dependsOn: ["tasks:T2345", "tasks:T2346"],
    },
  });
  await ledger.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: ALL_DONE_DEFECT_ID,
    status: "root-caused",
    fields: {
      headline: "all declared fixes done",
      severity: "high",
      dependsOn: ["tasks:T2345", "tasks:T2347"],
    },
  });
  await ledger.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: ADVISORY_DEFECT_ID,
    status: "root-caused",
    fields: {
      headline: "advisory consumer is not a fix owner",
      severity: "high",
      dependsOn: ["tasks:T2345"],
    },
  });
  const closure = (): string[] =>
    [
      ...worksetMemberRefSet(
        closeWorkset([`defects:${REVERSE_DEFECT_ID}`], buildActiveStateFromLedgerStore(ledger)),
      ),
    ].sort();
  const beforeClosure = closure();

  const evidence = await createImplementationEvidenceFixture(undefined, {
    recordLedgerCompletion: async ({ task, completion, author, session }) =>
      await recordProtectedImplementationCompletion(ledger, task, completion, {
        author,
        ...(session === undefined ? {} : { session }),
      }),
  });
  const completion = await prepareImplementationCompletion(
    evidence,
    "prepare-reconciliation-probe",
  );
  const binding = {
    kind: "merge" as const,
    targetRef: "tasks:T2345",
    repositoryRoot: "/repo",
    commit: IMPLEMENTATION_RESULT,
    completionRef: completion.completionRef,
    mergeOperationId: "merge-t2345",
  };
  const provider = await implementationCompletionMergeAdmissionProviderFromStore({
    provider: createStrictInMemoryWorksetEffectAdmissionProvider(),
    store: evidence.store,
    binding,
    repositoryHead: async () => evidence.getHead(),
  });
  const admission = await provider.acquire({ kind: "merge", targetRef: "tasks:T2345" });
  await admission.registerProcessGroup({ pgid: 520, leaderPid: 520 });
  await admission.shareWithGuardian({ pgid: 520, leaderPid: 520 });
  evidence.setHead(IMPLEMENTATION_RESULT);
  await admission.markSettled();
  await admission.releaseAfterSettlement();
  await evidence.service.recordCompletion({
    taskRef: "tasks:T2345",
    expectedRepositoryHead: IMPLEMENTATION_RESULT,
    operationId: "record-reconciliation-probe",
    author: "probe",
  });

  return {
    statuses: Object.fromEntries(
      [FORWARD_DEFECT_ID, REVERSE_DEFECT_ID, ALL_DONE_DEFECT_ID, ADVISORY_DEFECT_ID].map(
        (defectId) => [defectId, ledger.fetchItem(DEFECTS_LEDGER, defectId).status],
      ),
    ),
    unfinishedTaskStatus: ledger.fetchItem(TASKS_LEDGER, "T2346").status,
    fixGoalRef: `goals:${fixGoal.id}`,
    beforeClosure,
    afterClosure: closure(),
  };
}

// regression: D520 — completion must reconcile the union of forward and reverse fix-task links.
describe("implementation completion fix reconciliation [Progression-Blackbox-Group]", () => {
  let result: ProbeResult;

  beforeAll(async () => {
    result = await runProbe();
  });

  test("resolves all-done and advisory-only controls", () => {
    expect(result.statuses[ALL_DONE_DEFECT_ID]).toBe("resolved");
    expect(result.statuses[ADVISORY_DEFECT_ID]).toBe("resolved");
    expect(result.unfinishedTaskStatus).toBe("wip");
  });

  test("retains partial forward- and reverse-linked defects", () => {
    expect({
      forward: result.statuses[FORWARD_DEFECT_ID],
      reverse: result.statuses[REVERSE_DEFECT_ID],
    }).toEqual({ forward: "root-caused", reverse: "root-caused" });
  });

  test("retains the reverse defect's sealed fix goal and unfinished fix task in its workset", () => {
    expect(result.beforeClosure).toContain(result.fixGoalRef);
    expect(result.beforeClosure).toContain("tasks:T2346");
    expect(result.afterClosure).toEqual(result.beforeClosure);
  });
});
