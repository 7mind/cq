/**
 * cont-N — `/plan G<id> <text>` append-increment continuation (Q10).
 *
 * Covers, against a FAKE producer + FAKE PhaseSubagent (deterministic):
 *  - GATE: a planned/done goal proceeds; clarifying/planning/building/abandoned
 *    and an unknown goal are refused with a clear errored lifecycle frame.
 *  - Continuation producer: existing goal + feature → extended description + new
 *    scoped questions under a NEW increment milestone; existing milestones
 *    untouched; status → clarifying.
 *  - Append-only planner: a continuation plan ADDS new milestones/tasks and the
 *    goal's pre-existing (incl. `done`) milestones/tasks are byte-identical
 *    after the continuation plans, across a revise round.
 *  - Full continuation loop: new questions → answer → clarify clear → append →
 *    review → planned, with the original milestones intact.
 *  - Resume mid-continuation: drop+recreate the runtime while a continuation is
 *    clarifying / planning → reconcile resumes correctly.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  GOALS_LEDGER,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  type LedgerStore,
} from "@cq/ledger";
import {
  WorkflowRuntime,
  INCREMENT_MILESTONE_PREFIX,
  SPEC_MILESTONE_TITLE,
  CLARIFY_REVIEW_SPEC,
  CONTINUE_SPEC,
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
  goal: { description: "A local-first encrypted notetaking webapp." },
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

const CLEAR: ClarifyReviewOutput = { clear: true, contradictions: [], newQuestions: [] };
const PLAN: PlanOutput = {
  milestones: [{ title: "Core", description: "the core build" }],
  tasks: [
    { milestoneRef: 0, headline: "Editor", description: "rich text editor", acceptance: "renders markdown" },
    { milestoneRef: 0, headline: "Sync", description: "crdt sync" },
  ],
};
const SATISFIED: PlanReviewOutput = { satisfied: true, findings: [], newQuestions: [] };

const CONT_PRODUCER_OUT: ProducerOutput = {
  goal: { description: "A local-first encrypted notetaking webapp WITH attachment E2E encryption." },
  questions: [{ question: "Which attachment types?", suggestions: ["images", "any"], recommendation: "any" }],
};
const CONT_PLAN: PlanOutput = {
  milestones: [{ title: "Attachment E2E", description: "encrypt attachments end-to-end" }],
  tasks: [{ milestoneRef: 0, headline: "Crypto envelope", description: "per-file key wrap", acceptance: "round-trips" }],
};

/** Drive a fresh goal all the way to `planned`. Returns goalId + milestone snapshot. */
async function planFreshGoal(
  store: LedgerStore,
  phase: FakePhaseSubagent,
  rt: WorkflowRuntime,
  sink: WorkflowEventSink,
): Promise<{ goalId: string }> {
  phase.enqueue(CLARIFY_REVIEW_SPEC, CLEAR).enqueue(PLAN_SPEC, PLAN).enqueue(PLAN_REVIEW_SPEC, SATISFIED);
  const res = await rt.startPlan({ text: "build it", platform: "claude" }, sink);
  if (res.outcome !== "questions_ready") throw new Error("phase 1 failed");
  const goalId = res.goalId;
  const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
  const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
  await rt.submitAnswer(q0, "web");
  await waitForBusyIdle(rt);
  expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
  return { goalId };
}

/** Capture every milestone item + its question/task rows for byte-identity comparison. */
function snapshotMilestones(store: LedgerStore, ids: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const m = store.fetchMilestone(id);
    const grouped = store.listMilestoneItems(id);
    out[id] = {
      title: m.resolved.title,
      description: m.resolved.description,
      status: m.resolved.status,
      questions: (grouped[QUESTIONS_LEDGER] ?? []).map((q) => ({ id: q.id, status: q.status, fields: q.fields })),
      tasks: (grouped[TASKS_LEDGER] ?? []).map((t) => ({ id: t.id, status: t.status, fields: t.fields })),
    };
  }
  return out;
}

function milestoneIds(store: LedgerStore, goalId: string): string[] {
  return store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[];
}

// ─────────────────────────────────────────────────────────────────────────── //
// GATE
// ─────────────────────────────────────────────────────────────────────────── //

describe("continuation gate", () => {
  it("rejects an unknown goal", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const rt = makeRuntime(store, new FakePhaseSubagent());
    const { sink, events } = collector();
    const res = await rt.continueGoal("G99", "add feature", "claude", sink);
    expect(res.outcome).toBe("errored");
    expect(events.at(-1)!.detail).toContain("does not exist");
    await store.dispose();
  });

  it("rejects a goal mid-clarification (clarifying)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    // Phase 1 only → goal is clarifying with an open question.
    const res0 = await rt.startPlan({ text: "x", platform: "claude" }, sink);
    if (res0.outcome !== "questions_ready") throw new Error("phase 1 failed");
    const res = await rt.continueGoal(res0.goalId, "add feature", "claude", sink);
    expect(res.outcome).toBe("errored");
    expect(events.at(-1)!.detail).toContain("still being planned");
    await store.dispose();
  });

  it("rejects a goal mid-planning (planning)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    // Clarify clears, planner writes (→ planning), then the reviewer THROWS so
    // the goal is parked in `planning`.
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, PLAN)
      .setSticky(PLAN_REVIEW_SPEC, () => {
        throw new Error("reviewer crash");
      });
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const res0 = await rt.startPlan({ text: "x", platform: "claude" }, sink);
    if (res0.outcome !== "questions_ready") throw new Error("phase 1 failed");
    const goalId = res0.goalId;
    const specId = milestoneIds(store, goalId)[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    await rt.submitAnswer(q0, "web");
    await waitForBusyIdle(rt);
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");

    const { sink: sink2, events } = collector();
    const res = await rt.continueGoal(goalId, "add feature", "claude", sink2);
    expect(res.outcome).toBe("errored");
    expect(events.at(-1)!.detail).toContain("still being planned");
    await store.dispose();
  });

  it("rejects an abandoned goal", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const rt = makeRuntime(store, new FakePhaseSubagent());
    const { sink } = collector();
    const res0 = await rt.startPlan({ text: "x", platform: "claude" }, sink);
    if (res0.outcome !== "questions_ready") throw new Error("phase 1 failed");
    await store.updateItem(GOALS_LEDGER, res0.goalId, { status: "abandoned" });
    const { sink: sink2, events } = collector();
    const res = await rt.continueGoal(res0.goalId, "add feature", "claude", sink2);
    expect(res.outcome).toBe("errored");
    expect(events.at(-1)!.detail).toContain("abandoned");
    await store.dispose();
  });

  it("rejects a building goal", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const { goalId } = await planFreshGoal(store, phase, rt, sink);
    await store.updateItem(GOALS_LEDGER, goalId, { status: "building" });
    const { sink: sink2, events } = collector();
    const res = await rt.continueGoal(goalId, "add feature", "claude", sink2);
    expect(res.outcome).toBe("errored");
    expect(events.at(-1)!.detail).toContain("building");
    await store.dispose();
  });

  it("proceeds for a planned goal and for a done goal", async () => {
    for (const finalStatus of ["planned", "done"] as const) {
      const store = new InMemoryLedgerStore();
      await store.init();
      const phase = new FakePhaseSubagent();
      const rt = makeRuntime(store, phase);
      const { sink } = collector();
      const { goalId } = await planFreshGoal(store, phase, rt, sink);
      if (finalStatus === "done") {
        await store.updateItem(GOALS_LEDGER, goalId, { status: "done" });
      }
      phase.enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT);
      const { sink: sink2, events } = collector();
      const res = await rt.continueGoal(goalId, "add attachment E2E", "claude", sink2);
      expect(res.outcome).toBe("questions_ready");
      expect(events.map((e) => e.status)).toContain("questions_ready");
      expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");
      await store.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── //
// CONTINUATION PRODUCER
// ─────────────────────────────────────────────────────────────────────────── //

describe("continuation producer", () => {
  it("appends an increment milestone with scoped questions; existing milestones untouched; status→clarifying", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const { goalId } = await planFreshGoal(store, phase, rt, sink);

    const before = milestoneIds(store, goalId);
    const beforeSnap = snapshotMilestones(store, before);
    const beforeDesc = String(store.fetchItem(GOALS_LEDGER, goalId).fields["description"]);

    phase.enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT);
    const res = await rt.continueGoal(goalId, "add attachment E2E", "claude", sink);
    expect(res.outcome).toBe("questions_ready");

    // The continuation producer saw the existing description + milestone titles.
    const contPrompt = phase.prompts.get(CONTINUE_SPEC.toolName)![0]!;
    expect(contPrompt).toContain(beforeDesc);
    expect(contPrompt).toContain("Core"); // existing planner milestone title
    expect(contPrompt).toContain("add attachment E2E"); // feature text

    const after = milestoneIds(store, goalId);
    // Exactly one milestone appended; existing ids preserved in order.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    const incId = after.at(-1)!;
    const incTitle = store.fetchMilestone(incId).resolved.title;
    expect(incTitle.startsWith(INCREMENT_MILESTONE_PREFIX)).toBe(true);

    // New questions filed under the increment milestone (scoped to the feature).
    const incQs = store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [];
    expect(incQs).toHaveLength(1);
    expect(incQs[0]!.fields["question"]).toBe("Which attachment types?");
    expect(incQs[0]!.status).toBe("open");

    // Existing milestones (spec + Core) are byte-identical.
    expect(snapshotMilestones(store, before)).toEqual(beforeSnap);

    // Goal description extended; status back to clarifying.
    const goal = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal.fields["description"]).toBe(CONT_PRODUCER_OUT.goal.description);
    expect(goal.status).toBe("clarifying");

    await store.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────── //
// APPEND-ONLY PLANNER + FULL LOOP
// ─────────────────────────────────────────────────────────────────────────── //

describe("append-only continuation loop", () => {
  it("new questions → answer → clarify clear → append plan → review → planned, originals intact", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = makeRuntime(store, phase);
    const { sink, events } = collector();
    const { goalId } = await planFreshGoal(store, phase, rt, sink);

    // Snapshot the goal's PRE-EXISTING milestones (spec + Core) — these must be
    // byte-identical after the whole continuation completes.
    const original = milestoneIds(store, goalId);
    const originalSnap = snapshotMilestones(store, original);

    // Mark the existing planner milestone `done` to prove a completed milestone
    // is never touched by a continuation.
    const coreId = original[1]!;
    await store.updateItem(MILESTONES_LEDGER, coreId, { status: "done" });
    const originalSnapDone = snapshotMilestones(store, original);

    // Continuation: produce → answer → clarify clear → continuation planner → review.
    phase
      .enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT)
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, CONT_PLAN)
      .enqueue(PLAN_REVIEW_SPEC, SATISFIED);

    const cres = await rt.continueGoal(goalId, "add attachment E2E", "claude", sink);
    expect(cres.outcome).toBe("questions_ready");
    const incId = milestoneIds(store, goalId).at(-1)!;
    const incQ = (store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [])[0]!.id;

    await rt.submitAnswer(incQ, "any");
    await waitForBusyIdle(rt);

    // The continuation planner saw the existing milestones as read-only context.
    const plannerPrompt = phase.prompts.get(PLAN_SPEC.toolName)!.at(-1)!;
    expect(plannerPrompt).toContain("immutable read-only context");
    expect(plannerPrompt).toContain("Core");

    const goal = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal.status).toBe("planned");

    const finalIds = milestoneIds(store, goalId);
    // [spec, Core(done), increment, increment-plan]. Originals are a prefix.
    expect(finalIds.slice(0, original.length)).toEqual(original);
    expect(finalIds.length).toBe(original.length + 2); // increment-spec + increment-plan

    // The NEW increment-plan milestone holds the new task.
    const incPlanId = finalIds.at(-1)!;
    const incPlan = store.fetchMilestone(incPlanId);
    expect(incPlan.resolved.title).toBe("Attachment E2E");
    const incTasks = store.listMilestoneItems(incPlanId)[TASKS_LEDGER] ?? [];
    expect(incTasks).toHaveLength(1);
    expect(incTasks[0]!.fields["headline"]).toBe("Crypto envelope");

    // PROOF of append-only: the pre-existing milestones (incl. the `done` Core
    // with its tasks) are byte-identical to before the continuation.
    expect(snapshotMilestones(store, original)).toEqual(originalSnapDone);
    // And the un-done snapshot differs only by the Core status we set ourselves.
    expect(originalSnap[original[0]!]).toEqual(originalSnapDone[original[0]!]); // spec unchanged either way

    expect(events.map((e) => e.status)).toContain("planned");
    await store.dispose();
  });

  it("a continuation revise round does NOT accumulate increment milestones and never touches originals", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = makeRuntime(store, phase);
    const { sink } = collector();
    const { goalId } = await planFreshGoal(store, phase, rt, sink);

    const original = milestoneIds(store, goalId);
    const originalSnap = snapshotMilestones(store, original);

    const CONT_PLAN_2: PlanOutput = {
      milestones: [{ title: "Attachment E2E v2", description: "with key rotation" }],
      tasks: [{ milestoneRef: 0, headline: "Rotate", description: "rotate keys", acceptance: "rotates" }],
    };
    phase
      .enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT)
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, CONT_PLAN) // first append
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: false, findings: [{ severity: "major", issue: "no rotation", suggestion: "rotate" }], newQuestions: [] })
      .enqueue(PLAN_SPEC, CONT_PLAN_2) // revise → replaces the increment plan (no accumulation)
      .enqueue(PLAN_REVIEW_SPEC, SATISFIED);

    await rt.continueGoal(goalId, "add attachment E2E", "claude", sink);
    const incId = milestoneIds(store, goalId).at(-1)!;
    const incQ = (store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    await rt.submitAnswer(incQ, "any");
    await waitForBusyIdle(rt);

    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    const finalIds = milestoneIds(store, goalId);
    // [spec, Core, increment, increment-plan-v2] — the v1 increment plan is gone.
    expect(finalIds.length).toBe(original.length + 2);
    expect(finalIds.slice(0, original.length)).toEqual(original);
    const incPlanId = finalIds.at(-1)!;
    expect(store.fetchMilestone(incPlanId).resolved.title).toBe("Attachment E2E v2");
    // Originals byte-identical.
    expect(snapshotMilestones(store, original)).toEqual(originalSnap);

    await store.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────── //
// RESUME MID-CONTINUATION
// ─────────────────────────────────────────────────────────────────────────── //

describe("resume mid-continuation", () => {
  it("a continuation clarifying with an open question sits idle, then resumes on answer", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phaseA = new FakePhaseSubagent();
    const rtA = makeRuntime(store, phaseA);
    const { sink } = collector();
    const { goalId } = await planFreshGoal(store, phaseA, rtA, sink);
    phaseA.enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT);
    await rtA.continueGoal(goalId, "add attachment E2E", "claude", sink);

    // Goal is clarifying-an-increment with one open question → awaiting_answers.
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");
    expect(rtA.derivePosition(goalId)).toEqual({ kind: "awaiting_answers" });

    // Drop rtA; new rtB against the same store. reconcile must NOT dispatch
    // (open question) — a continuing goal looks like any clarifying goal.
    const phaseB = new FakePhaseSubagent();
    phaseB.enqueue(CLARIFY_REVIEW_SPEC, CLEAR).enqueue(PLAN_SPEC, CONT_PLAN).enqueue(PLAN_REVIEW_SPEC, SATISFIED);
    const rtB = makeRuntime(store, phaseB);
    const { sink: sinkB } = collector();
    rtB.subscribe(sinkB);
    expect(rtB.derivePosition(goalId)).toEqual({ kind: "awaiting_answers" });
    await rtB.reconcile();
    await Bun.sleep(20);
    expect(phaseB.calls.size).toBe(0); // nothing dispatched

    // Answer the increment question on rtB → clarify gate → append plan → review → planned.
    const original = milestoneIds(store, goalId).slice(0, 2); // spec + Core
    const originalSnap = snapshotMilestones(store, original);
    const incId = milestoneIds(store, goalId).at(-1)!;
    const incQ = (store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    await rtB.submitAnswer(incQ, "any");
    await waitForBusyIdle(rtB);

    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    // Append happened on the resumed runtime; originals intact.
    expect(snapshotMilestones(store, original)).toEqual(originalSnap);

    await store.dispose();
  });

  it("a continuation parked in `planning` (reviewer crashed) resumes via reconcile → review_ready", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phaseA = new FakePhaseSubagent();
    const rtA = makeRuntime(store, phaseA);
    const { sink } = collector();
    const { goalId } = await planFreshGoal(store, phaseA, rtA, sink);

    // Continuation: produce → answer → clarify clear → append plan (→ planning),
    // then the reviewer THROWS, parking the goal in `planning`.
    phaseA
      .enqueue(CONTINUE_SPEC, CONT_PRODUCER_OUT)
      .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
      .enqueue(PLAN_SPEC, CONT_PLAN)
      .setSticky(PLAN_REVIEW_SPEC, () => {
        throw new Error("reviewer crash mid continuation review");
      });
    await rtA.continueGoal(goalId, "add attachment E2E", "claude", sink);
    const incId = milestoneIds(store, goalId).at(-1)!;
    const incQ = (store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    await rtA.submitAnswer(incQ, "any");
    await waitForBusyIdle(rtA);

    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planning");
    const beforeIds = milestoneIds(store, goalId);

    // Drop rtA; rtB with a satisfied reviewer. reconcile → review_ready → planned.
    const phaseB = new FakePhaseSubagent();
    phaseB.setSticky(PLAN_REVIEW_SPEC, SATISFIED);
    const rtB = makeRuntime(store, phaseB);
    const { sink: sinkB } = collector();
    rtB.subscribe(sinkB);
    expect(rtB.derivePosition(goalId)).toEqual({ kind: "review_ready" });
    await rtB.reconcile();
    await waitForBusyIdle(rtB);

    expect(phaseB.calls.get(PLAN_REVIEW_SPEC.toolName)).toBe(1); // resumed once, no double-dispatch
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    // No new milestones created on resume (the reviewer was satisfied with the
    // already-appended plan).
    expect(milestoneIds(store, goalId)).toEqual(beforeIds);

    await store.dispose();
  });
});

/** Wait until the runtime's busy slot clears (the async advance chain settled). */
async function waitForBusyIdle(rt: WorkflowRuntime, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await Bun.sleep(5);
  while (Date.now() < deadline) {
    if (!rt.isBusy()) {
      await Bun.sleep(5);
      if (!rt.isBusy()) return;
    }
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for runtime to go idle");
}

// Reference imports kept meaningful: SPEC_MILESTONE_TITLE asserts the spec
// milestone is the always-first, never-an-increment milestone.
describe("increment milestone is distinct from the spec milestone", () => {
  it("the spec milestone title never carries the increment prefix", () => {
    expect(SPEC_MILESTONE_TITLE.startsWith(INCREMENT_MILESTONE_PREFIX)).toBe(false);
  });
});
