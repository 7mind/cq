/**
 * wfl-2 — loop engine tests against a FAKE PhaseSubagent.
 *
 * Covers: clarify loop (not-clear→new Q→answer→re-run→clear→plan); planner
 * output written with correct milestone/task linkage + goal status `planning`;
 * plan-review loop (not-satisfied→revise→satisfied→`planned`); no-progress
 * guard escalates and does NOT spin; auto-advance fires exactly once on the
 * last answer; lifecycle ordering incl. escalated + done; HARNESS owns writes.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  GOALS_LEDGER,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  type LedgerStore,
} from "@cq/ledger";
import {
  WorkflowRuntime,
  CLARIFY_REVIEW_SPEC,
  PLAN_SPEC,
  PLAN_REVIEW_SPEC,
  type WorkflowProducer,
  type ProducerOutput,
  type WorkflowEventSink,
  type ClarifyReviewOutput,
  type PlanOutput,
  type PlanReviewOutput,
} from "../src/workflow/index";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";

const PRODUCER_OUT: ProducerOutput = {
  goal: { title: "Local-first notes app", description: "A local-first encrypted notetaking webapp." },
  questions: [{ question: "Which platforms?", suggestions: ["web", "desktop"], recommendation: "web" }],
};

class FakeProducer implements WorkflowProducer {
  produce(): Promise<ProducerOutput> {
    return Promise.resolve(PRODUCER_OUT);
  }
}

function collector(): { sink: WorkflowEventSink; events: Array<Omit<WorkflowEvent, "seq" | "ts">> } {
  const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
  return { sink: (e) => events.push(e), events };
}

function makeRuntime(store: LedgerStore, phase: FakePhaseSubagent): WorkflowRuntime {
  return new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => new FakeProducer(),
    selectPhaseSubagent: () => phase,
  });
}

/** Drive phase 1 and return goalId + the still-open question id. */
async function bootstrap(store: LedgerStore, rt: WorkflowRuntime, sink: WorkflowEventSink): Promise<{ goalId: string; q0: string }> {
  const res = await rt.startPlan({ text: "build it", platform: "claude" }, sink);
  if (res.outcome !== "questions_ready") throw new Error("phase 1 failed");
  const goalId = res.goalId;
  const goal = store.fetchItem(GOALS_LEDGER, goalId);
  const specId = (goal.fields["milestones"] as string[])[0]!;
  const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
  return { goalId, q0 };
}

const CLEAR: ClarifyReviewOutput = { clear: true, contradictions: [], newQuestions: [] };
const PLAN: PlanOutput = {
  milestones: [{ title: "Core", description: "the core build" }],
  tasks: [
    { milestoneRef: 0, headline: "Editor", description: "rich text editor", acceptance: "renders markdown" },
    { milestoneRef: 0, headline: "Sync", description: "crdt sync" },
  ],
};
const SATISFIED: PlanReviewOutput = { satisfied: true, findings: [], newQuestions: [] };

describe("clarify loop", () => {
  it("not-clear→new question→answer→re-run→clear→planner→planning", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    // Round 1: not clear, ask one more question. Round 2: clear.
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, { clear: false, contradictions: [], newQuestions: [{ question: "Offline-first?" }] })
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    // Answer the first question → last open → auto-advance clarify-reviewer.
    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt);

    // Clarify-reviewer asked one more question; status is back to questions_ready.
    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName)).toBe(1);
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");
    const goal1 = store.fetchItem(GOALS_LEDGER, goalId);
    const specId = (goal1.fields["milestones"] as string[])[0]!;
    const qs = store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [];
    expect(qs.filter((q) => q.status === "open")).toHaveLength(1);
    const q1 = qs.find((q) => q.status === "open")!.id;

    // Answer the new question → clarify-reviewer says clear → planner runs → planning.
    await rt.submitAnswer(q1, "yes");
    await waitForBusyIdle(rt);

    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName)).toBe(2);
    expect(phase.calls.get(PLAN_SPEC.toolName)).toBe(1);
    const goal2 = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal2.status).toBe("planned"); // planner→review (satisfied)→planned

    // Lifecycle includes a clarifying, a planning, a reviewing, planned, done.
    const statuses = events.map((e) => e.status);
    expect(statuses).toContain("clarifying");
    expect(statuses).toContain("planning");
    expect(statuses).toContain("reviewing");
    expect(statuses).toContain("planned");
    expect(statuses).toContain("done");

    await store.dispose();
  });
});

describe("planner write linkage", () => {
  it("writes planner milestones + tasks under them and sets goal milestones [spec, ...]", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    phase.enqueue(CLARIFY_REVIEW_SPEC, CLEAR).enqueue(PLAN_SPEC, PLAN).enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt);

    const goal = store.fetchItem(GOALS_LEDGER, goalId);
    const ms = goal.fields["milestones"] as string[];
    expect(ms).toHaveLength(2); // spec + 1 planner milestone
    const plannerMilestone = ms[1]!;
    const tasks = store.listMilestoneItems(plannerMilestone)[TASKS_LEDGER] ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.status).toBe("planned");
    expect(tasks[0]!.fields["headline"]).toBe("Editor");
    expect(tasks[0]!.fields["acceptance"]).toBe("renders markdown");
    expect(tasks[1]!.fields["acceptance"]).toBeUndefined();

    await store.dispose();
  });
});

describe("plan-review loop", () => {
  it("not-satisfied (no questions)→revise→satisfied→planned", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const PLAN2: PlanOutput = {
      milestones: [{ title: "Core", description: "v2" }],
      tasks: [{ milestoneRef: 0, headline: "Editor", description: "now with tests", acceptance: "tests pass" }],
    };
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "major", issue: "no tests", suggestion: "add tests" }], newQuestions: [] })
      .enqueue(PLAN_SPEC, PLAN2) // revise (different → progress)
      .enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt);

    expect(phase.calls.get(PLAN_SPEC.toolName)).toBe(2); // initial + revise
    expect(phase.calls.get(PLAN_REVIEW_SPEC.toolName)).toBe(2);
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    // The revise planner prompt folded in the findings.
    const plannerPrompts = phase.prompts.get(PLAN_SPEC.toolName)!;
    expect(plannerPrompts[1]).toContain("no tests");

    expect(events.map((e) => e.status)).toContain("done");

    await store.dispose();
  });

  it("not-satisfied with newQuestions writes questions and waits (clarify gate re-runs on answer)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [], newQuestions: [{ question: "Budget?" }] })
      // After answering, clarify gate runs again then re-plan then satisfied.
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt);

    // Review raised a question; goal moved back to clarifying so the answer
    // re-enters the clarify gate (K-WFL-4). It awaits the answer.
    let goal = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal.status).toBe("clarifying");
    const specId = (goal.fields["milestones"] as string[])[0]!;
    const open = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? []).filter((q) => q.status === "open");
    expect(open).toHaveLength(1);

    // Answer the review's question → clarify gate re-runs → re-plan → satisfied → planned.
    await rt.submitAnswer(open[0]!.id, "small");
    await waitForBusyIdle(rt);
    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName)).toBe(2);
    goal = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal.status).toBe("planned");

    await store.dispose();
  });
});

describe("no-progress liveness guard", () => {
  it("escalates and STOPS when revise rounds produce identical plans with no new questions", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    // A pathological reviewer that is NEVER satisfied and never asks questions,
    // plus a planner that ALWAYS returns the same plan. Without the guard this
    // would spin forever. Sticky outputs give an unbounded supply.
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .setSticky(PLAN_SPEC, PLAN)
      .setSticky(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "meh", suggestion: "improve" }], newQuestions: [] });
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt, 5000);

    // The loop stopped via escalation; the runtime is idle (not spinning).
    const statuses = events.map((e) => e.status);
    expect(statuses).toContain("escalated");
    expect(statuses).not.toContain("planned");
    expect(rt.isBusy()).toBe(false);
    // Goal remains in planning (so a future guidance answer could resume).
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");
    // Planner ran a bounded number of times (initial + 2 revise rounds), NOT unbounded.
    expect(phase.calls.get(PLAN_SPEC.toolName)!).toBeLessThanOrEqual(4);

    await store.dispose();
  });

  it("does NOT escalate while the planner keeps writing a CHANGED plan (no-cap preserved)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    // A never-satisfied reviewer (no questions) but a planner that returns a
    // DIFFERENT plan every round for several rounds, then a satisfied verdict.
    // Each revise round writes a real ledger change → never no-progress; the
    // loop must run all the way to `planned` without escalating.
    let round = 0;
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .setSticky(PLAN_SPEC, () => {
        round += 1;
        return {
          milestones: [{ title: `Core v${round}`, description: `iteration ${round}` }],
          tasks: [{ milestoneRef: 0, headline: `Task ${round}`, description: `work ${round}` }],
        };
      })
      // Unsatisfied for the first 4 reviews (drives 4 revise rounds with distinct
      // plans), then satisfied → planned. Proves a churning planner never trips
      // the guard (it only fires on NO ledger update).
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "a", suggestion: "b" }], newQuestions: [] })
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "a", suggestion: "b" }], newQuestions: [] })
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "a", suggestion: "b" }], newQuestions: [] })
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "a", suggestion: "b" }], newQuestions: [] })
      .setSticky(PLAN_REVIEW_SPEC, SATISFIED);
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt, 5000);

    const statuses = events.map((e) => e.status);
    expect(statuses).not.toContain("escalated");
    expect(statuses).toContain("planned");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    // initial plan + 4 revise rounds = 5 planner dispatches; all distinct plans.
    expect(phase.calls.get(PLAN_SPEC.toolName)).toBe(5);

    await store.dispose();
  });

  it("a no-progress round AFTER a runtime restart still escalates (durable trigger; fingerprint-loss edge gone)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    // Runtime A: drive phase 1 → answer → clarify clear → planner writes the
    // initial PLAN (status planning), then the plan-reviewer THROWS on its first
    // call, simulating a crash mid-review BEFORE any revise round runs. The OLD
    // in-memory fingerprint was only ever seeded INSIDE a revise round, so it is
    // unset here regardless — but the point is that runtime B starts with a cold
    // map and must still detect no-progress purely from the ledger.
    const phaseA = new FakePhaseSubagent();
    phaseA
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .setSticky(PLAN_REVIEW_SPEC, () => {
        throw new Error("simulated crash mid plan-review");
      });
    const rtA = makeRuntime(store, phaseA);
    const { sink: sinkA, events: eventsA } = collector();
    const { goalId, q0 } = await bootstrap(store, rtA, sinkA);
    await rtA.submitAnswer(q0, "web");
    await waitForBusyIdle(rtA, 5000);

    // Runtime A crashed before any verdict; goal is still `planning`, the initial
    // PLAN is on the ledger, no escalation yet.
    expect(eventsA.map((e) => e.status)).not.toContain("escalated");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");

    // Drop A; create B against the SAME store. B has NO in-memory fingerprint
    // (none ever existed). reconcile() resumes review_ready → the reviewer is
    // still unsatisfied + the planner still writes the identical plan → the very
    // FIRST post-resume revise round produces no ledger update → escalate.
    const phaseB = new FakePhaseSubagent();
    phaseB
      .setSticky(PLAN_SPEC, PLAN)
      .setSticky(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "minor", issue: "m", suggestion: "i" }], newQuestions: [] });
    const rtB = makeRuntime(store, phaseB);
    const { sink: sinkB, events: eventsB } = collector();
    rtB.subscribe(sinkB);
    expect(rtB.derivePosition(goalId)).toEqual({ kind: "review_ready" });

    await rtB.reconcile();
    await waitForBusyIdle(rtB, 5000);

    // The durable trigger fires on the FIRST no-update revise round after resume
    // — the concrete win. The OLD in-memory fingerprint needed two identical
    // revise rounds (one to seed, one to match); a cold-map resumed runtime
    // would only seed on its first round and continue, masking the stall. The
    // ledger-diff trigger needs no prior round, so exactly ONE planner dispatch
    // on B suffices to detect and escalate.
    expect(eventsB.map((e) => e.status)).toContain("escalated");
    expect(eventsB.map((e) => e.status)).not.toContain("planned");
    expect(rtB.isBusy()).toBe(false);
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");
    expect(phaseB.calls.get(PLAN_SPEC.toolName)).toBe(1); // one revise round → escalate
    expect(phaseB.calls.get(PLAN_REVIEW_SPEC.toolName)).toBe(1);

    await store.dispose();
  });
});

describe("clarify no-progress guard (degenerate not-clear with no questions)", () => {
  it("escalates when the clarify-reviewer is not-clear but writes no new questions", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    // Degenerate clarify output: not clear, yet zero new questions. Without the
    // guard the goal would sit in `clarifying` with no open question to answer
    // (a silent stall). The guard escalates instead.
    phase.enqueue(CLARIFY_REVIEW_SPEC, { clear: false, contradictions: [], newQuestions: [] });
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId, q0 } = await bootstrap(store, rt, sink);

    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt, 5000);

    const statuses = events.map((e) => e.status);
    expect(statuses).toContain("escalated");
    expect(statuses).not.toContain("planning"); // the planner never ran
    expect(rt.isBusy()).toBe(false);
    // The goal is NOT stranded with a phantom open-question banner.
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");
    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const open = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? []).filter((q) => q.status === "open");
    expect(open).toHaveLength(0);
    // The planner was never dispatched (no false advance).
    expect(phase.calls.get(PLAN_SPEC.toolName) ?? 0).toBe(0);

    await store.dispose();
  });
});

describe("auto-advance fires exactly once", () => {
  it("answering a non-last question does NOT advance; only the last one does", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    phase.enqueue(CLARIFY_REVIEW_SPEC, CLEAR).enqueue(PLAN_SPEC, PLAN).enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    // Producer with TWO questions so the first answer is not the last.
    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => ({
        produce: () =>
          Promise.resolve<ProducerOutput>({
            goal: { title: "G goal", description: "g" },
            questions: [{ question: "Q1?" }, { question: "Q2?" }],
          }),
      }),
      selectPhaseSubagent: () => phase,
    });
    const { sink } = collector();
    const res = await rt.startPlan({ text: "x", platform: "claude" }, sink);
    if (res.outcome !== "questions_ready") throw new Error("phase 1 failed");
    const goalId = res.goalId;
    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const qs = store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [];

    // Answer the first → NOT last → no advance.
    await rt.submitAnswer(qs[0]!.id, "a1");
    await waitForBusyIdle(rt);
    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName) ?? 0).toBe(0);

    // Answer the second (last) → advance exactly once.
    await rt.submitAnswer(qs[1]!.id, "a2");
    await waitForBusyIdle(rt);
    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName)).toBe(1);

    // Re-answering an already-answered question does NOT re-advance.
    await rt.submitAnswer(qs[1]!.id, "a2-again");
    await waitForBusyIdle(rt);
    expect(phase.calls.get(CLARIFY_REVIEW_SPEC.toolName)).toBe(1);

    await store.dispose();
  });
});

describe("resume-on-startup reconcile (closes WF-D02)", () => {
  it("resumes a goal mid-loop from ledger state after the runtime is dropped + recreated", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    // Runtime A: drive phase 1 → answer → clarify clear → planner writes →
    // goal=planning. The plan-reviewer THROWS, simulating a crash mid-review.
    const phaseA = new FakePhaseSubagent();
    phaseA
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .setSticky(PLAN_REVIEW_SPEC, () => {
        throw new Error("simulated crash mid plan-review");
      });
    const rtA = makeRuntime(store, phaseA);
    const { sink: sinkA } = collector();
    const { goalId, q0 } = await bootstrap(store, rtA, sinkA);
    await rtA.submitAnswer(q0, "web");
    await waitForBusyIdle(rtA);

    // Ledger state: goal=planning, all questions answered, planner milestones
    // written, but no review verdict → review_ready on reconcile.
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");
    expect(phaseA.calls.get(PLAN_REVIEW_SPEC.toolName)).toBe(1); // ran once, threw

    // Drop runtime A; create runtime B against the SAME store with a satisfied
    // reviewer. reconcile() must derive review_ready and resume → planned.
    const phaseB = new FakePhaseSubagent();
    phaseB.setSticky(PLAN_REVIEW_SPEC, SATISFIED);
    const rtB = makeRuntime(store, phaseB);
    const { sink: sinkB, events: eventsB } = collector();
    rtB.subscribe(sinkB);

    // Sanity: B derives the resumable position from the ledger alone.
    expect(rtB.derivePosition(goalId)).toEqual({ kind: "review_ready" });

    await rtB.reconcile();
    await waitForBusyIdle(rtB);

    expect(phaseB.calls.get(PLAN_REVIEW_SPEC.toolName)).toBe(1); // resumed, no double-dispatch
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    expect(eventsB.map((e) => e.status)).toContain("planned");

    await store.dispose();
  });

  it("a goal awaiting open questions sits idle on reconcile (no dispatch)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phaseA = new FakePhaseSubagent();
    const rtA = makeRuntime(store, phaseA);
    const { sink } = collector();
    const { goalId } = await bootstrap(store, rtA, sink); // phase 1 only; q0 still open

    // New runtime, reconcile: the goal has an open question → awaiting_answers.
    const phaseB = new FakePhaseSubagent();
    const rtB = makeRuntime(store, phaseB);
    expect(rtB.derivePosition(goalId)).toEqual({ kind: "awaiting_answers" });
    await rtB.reconcile();
    await Bun.sleep(20);
    // No phase dispatched.
    expect(phaseB.calls.size).toBe(0);
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");

    await store.dispose();
  });
});

/** Wait until the runtime's busy slot clears (the async advance chain settled). */
async function waitForBusyIdle(rt: WorkflowRuntime, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Give the fire-and-forget advance a tick to register busy first.
  await Bun.sleep(5);
  while (Date.now() < deadline) {
    if (!rt.isBusy()) {
      // Settle any trailing microtasks.
      await Bun.sleep(5);
      if (!rt.isBusy()) return;
    }
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for runtime to go idle");
}
