/**
 * goals-2 — WorkflowRuntime.buildGoalsSnapshot + submitEscalationReply.
 *
 * buildGoalsSnapshot: a goal with milestones/questions/tasks nests correctly,
 * openQuestionCount derives from ledger open-question state, totalOpenQuestions
 * sums across goals, and answered questions surface with their answer + status.
 *
 * submitEscalationReply: proceed → planned + done; abandon → abandoned;
 * guidance → planner re-dispatched with the guidance text, loop resumes to
 * planned. Idempotent against a terminal goal (no-op).
 */

import { describe, test, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  GOALS_LEDGER,
  QUESTIONS_LEDGER,
  type LedgerStore,
} from "@cq/ledger";
import {
  WorkflowRuntime,
  CLARIFY_REVIEW_SPEC,
  PLAN_SPEC,
  PLAN_REVIEW_SPEC,
  type WorkflowProducer,
  type ProducerOutput,
} from "../src/workflow/index.js";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge.js";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent.js";

const CANNED: ProducerOutput = {
  goal: { description: "A notes app." },
  questions: [
    { question: "Which platforms?", context: "scope", suggestions: ["web", "desktop"], recommendation: "web" },
  ],
};
class FakeProducer implements WorkflowProducer {
  produce(): Promise<ProducerOutput> {
    return Promise.resolve(CANNED);
  }
}

function makeRuntime(store: LedgerStore, phase: FakePhaseSubagent, events: Array<Omit<WorkflowEvent, "seq" | "ts">>): WorkflowRuntime {
  const rt = new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => new FakeProducer(),
    selectPhaseSubagent: () => phase,
  });
  rt.subscribe((e) => events.push(e));
  return rt;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for predicate");
}

/** Run a goal to phase-1 (goal + spec milestone + 1 open question). */
async function seedClarifyingGoal(rt: WorkflowRuntime): Promise<string> {
  const res = await rt.startPlan({ text: "build a notes app", platform: "claude" }, () => {});
  if (res.outcome !== "questions_ready") throw new Error(`unexpected outcome ${res.outcome}`);
  return res.goalId;
}

describe("buildGoalsSnapshot", () => {
  test("nests milestones/questions/tasks; openQuestionCount + totalOpenQuestions derive from the ledger", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const rt = makeRuntime(store, phase, events);

    const goalId = await seedClarifyingGoal(rt);

    // Snapshot 1: clarifying, one open question, no tasks.
    const snap1 = rt.buildGoalsSnapshot();
    expect(snap1.goals).toHaveLength(1);
    expect(snap1.totalOpenQuestions).toBe(1);
    const g1 = snap1.goals[0]!;
    expect(g1.id).toBe(goalId);
    expect(g1.description).toBe("A notes app.");
    expect(g1.status).toBe("clarifying");
    expect(g1.openQuestionCount).toBe(1);
    expect(g1.milestones).toHaveLength(1);
    const specM = g1.milestones[0]!;
    expect(specM.title).toBe("produce an actionable specification");
    expect(specM.questions).toHaveLength(1);
    const q = specM.questions[0]!;
    expect(q.question).toBe("Which platforms?");
    expect(q.context).toBe("scope");
    expect(q.suggestions).toEqual(["web", "desktop"]);
    expect(q.recommendation).toBe("web");
    expect(q.status).toBe("open");
    expect(q.answer).toBeUndefined();
    expect(specM.tasks).toHaveLength(0);

    // Drive the loop to planned via answering: clarify(clear)→plan→review(ok).
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, { clear: true, contradictions: [], newQuestions: [] })
      .enqueue(PLAN_SPEC, {
        milestones: [{ title: "Core build", description: "the core" }],
        tasks: [{ milestoneRef: 0, headline: "Editor", description: "editor", acceptance: "renders" }],
      })
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: true, findings: [], newQuestions: [] });

    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    await rt.submitAnswer(q0, "web");
    await waitFor(() => store.fetchItem(GOALS_LEDGER, goalId).status === "planned");

    // Snapshot 2: planned, zero open questions, the question answered, a task.
    const snap2 = rt.buildGoalsSnapshot();
    expect(snap2.totalOpenQuestions).toBe(0);
    const g2 = snap2.goals[0]!;
    expect(g2.status).toBe("planned");
    expect(g2.openQuestionCount).toBe(0);
    // spec milestone + planner milestone
    expect(g2.milestones).toHaveLength(2);
    const answeredQ = g2.milestones[0]!.questions[0]!;
    expect(answeredQ.status).toBe("answered");
    expect(answeredQ.answer).toBe("web");
    const plannerM = g2.milestones[1]!;
    expect(plannerM.title).toBe("Core build");
    expect(plannerM.tasks).toHaveLength(1);
    expect(plannerM.tasks[0]!.headline).toBe("Editor");
    expect(plannerM.tasks[0]!.status).toBe("planned");

    await store.dispose();
  });

  test("totalOpenQuestions sums across multiple goals", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const rt = makeRuntime(store, phase, events);

    await seedClarifyingGoal(rt);
    await seedClarifyingGoal(rt);

    const snap = rt.buildGoalsSnapshot();
    expect(snap.goals).toHaveLength(2);
    expect(snap.totalOpenQuestions).toBe(2);

    await store.dispose();
  });
});

/**
 * Drive a goal into the `escalated` position: producer→answer→clarify(clear)→
 * planner→reviewer(unsatisfied,no questions)→revise(identical plan) twice
 * trips the no-progress guard. Returns the goalId once escalated is observed.
 */
async function seedEscalatedGoal(
  store: LedgerStore,
  events: Array<Omit<WorkflowEvent, "seq" | "ts">>,
): Promise<{ rt: WorkflowRuntime; phase: FakePhaseSubagent; goalId: string }> {
  const phase = new FakePhaseSubagent();
  // clarify clears once; planner always returns the SAME structural plan;
  // reviewer is always unsatisfied with no new questions → revise loop →
  // identical fingerprint on the 2nd revise → escalate.
  phase.enqueue(CLARIFY_REVIEW_SPEC, { clear: true, contradictions: [], newQuestions: [] });
  const samePlan = {
    milestones: [{ title: "Core", description: "c" }],
    tasks: [{ milestoneRef: 0, headline: "T", description: "d" }],
  };
  phase.setSticky(PLAN_SPEC, samePlan);
  phase.setSticky(PLAN_REVIEW_SPEC, {
    satisfied: false,
    findings: [{ severity: "major", issue: "thin", suggestion: "expand" }],
    newQuestions: [],
  });

  const rt = new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => new FakeProducer(),
    selectPhaseSubagent: () => phase,
  });
  rt.subscribe((e) => events.push(e));

  const res = await rt.startPlan({ text: "x", platform: "claude" }, () => {});
  if (res.outcome !== "questions_ready") throw new Error("seed failed");
  const goalId = res.goalId;
  const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
  const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
  await rt.submitAnswer(q0, "web");
  await waitFor(() => events.some((e) => e.status === "escalated"), 3000);
  return { rt, phase, goalId };
}

describe("submitEscalationReply", () => {
  test("proceed → planned + done", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const { rt, goalId } = await seedEscalatedGoal(store, events);

    const result = await rt.submitEscalationReply(goalId, "proceed");
    expect(result).toBe("planned");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    // The planned + done lifecycle pair was emitted after escalation.
    const afterEscalation = events.slice(events.findIndex((e) => e.status === "escalated"));
    expect(afterEscalation.map((e) => e.status)).toContain("planned");
    expect(afterEscalation.map((e) => e.status)).toContain("done");

    await store.dispose();
  });

  test("abandon → abandoned", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const { rt, goalId } = await seedEscalatedGoal(store, events);

    const result = await rt.submitEscalationReply(goalId, "abandon");
    expect(result).toBe("abandoned");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("abandoned");

    await store.dispose();
  });

  test("guidance → planner re-dispatched with the guidance text; loop resumes to planned", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const { rt, phase, goalId } = await seedEscalatedGoal(store, events);

    // After guidance the next planner round should produce a DIFFERENT plan and
    // the reviewer should now be satisfied → planned. Override the sticky
    // outputs for the post-guidance round.
    phase.enqueue(PLAN_SPEC, {
      milestones: [{ title: "Guided core", description: "uses SQLite per guidance" }],
      tasks: [{ milestoneRef: 0, headline: "DB", description: "sqlite", acceptance: "persists" }],
    });
    phase.enqueue(PLAN_REVIEW_SPEC, { satisfied: true, findings: [], newQuestions: [] });

    const callsBefore = phase.calls.get(PLAN_SPEC.toolName) ?? 0;
    const result = await rt.submitEscalationReply(goalId, "guidance", "use SQLite for storage");
    expect(result).toBe("dispatched");

    await waitFor(() => store.fetchItem(GOALS_LEDGER, goalId).status === "planned", 3000);

    // The planner was dispatched again with the guidance folded into its prompt.
    const planPrompts = phase.prompts.get(PLAN_SPEC.toolName) ?? [];
    expect(phase.calls.get(PLAN_SPEC.toolName)!).toBeGreaterThan(callsBefore);
    expect(planPrompts.at(-1)).toContain("use SQLite for storage");

    await store.dispose();
  });

  test("guidance with blank text is rejected", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const { rt, goalId } = await seedEscalatedGoal(store, events);

    await expect(rt.submitEscalationReply(goalId, "guidance", "   ")).rejects.toThrow();

    await store.dispose();
  });

  test("reply to an already-terminal goal is a no-op", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    const { rt, goalId } = await seedEscalatedGoal(store, events);

    expect(await rt.submitEscalationReply(goalId, "abandon")).toBe("abandoned");
    expect(await rt.submitEscalationReply(goalId, "proceed")).toBe("noop");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("abandoned");

    await store.dispose();
  });
});
