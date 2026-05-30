/**
 * wfhist-3 / wfhist-4 — `/plan` runs recorded in the History tables.
 *
 * A `/plan` run becomes its own workflow-`kind` session + a root `main`
 * invocation, with ONE child invocation per phase dispatch (producer, each
 * clarify/planner/review round, continuation). Rows are written DIRECTLY via the
 * injected Persistence adapter — never via the Bridge — so pool=1 holds.
 *
 * Runs against BOTH persistence adapters via the dual pattern. A FakeProducer +
 * FakePhaseSubagent drive the loop deterministically and fire `onUsage` so the
 * cost/token recording path is exercised.
 */

import { describe, it, expect } from "bun:test";
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
  CONTINUE_SPEC,
  type WorkflowProducer,
  type ProducerOutput,
  type ProduceRequest,
  type WorkflowEventSink,
  type ClarifyReviewOutput,
  type PlanOutput,
  type PlanReviewOutput,
} from "../src/workflow/index";
import type { PhaseUsage } from "../src/workflow/producer";
import type { WorkflowEvent, InvocationRow } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";
import { SqlitePersistence } from "../src/persist/SqlitePersistence.js";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";
import type { Persistence } from "../src/persist/Persistence.js";

const PRODUCER_OUT: ProducerOutput = {
  goal: { title: "Notes app", description: "A local-first encrypted notetaking webapp." },
  questions: [{ question: "Which platforms?", suggestions: ["web", "desktop"], recommendation: "web" }],
};

const PRODUCER_USAGE: PhaseUsage = { model: "claude-producer", costUsd: 0.11, inputTokens: 100, outputTokens: 20 };

/** A producer that fires onUsage (so the producer child row records usage). */
class FakeProducer implements WorkflowProducer {
  produce(req: ProduceRequest): Promise<ProducerOutput> {
    if (req.onUsage !== undefined) req.onUsage(PRODUCER_USAGE);
    return Promise.resolve(PRODUCER_OUT);
  }
}

const CLEAR: ClarifyReviewOutput = { clear: true, contradictions: [], newQuestions: [] };
const PLAN: PlanOutput = {
  milestones: [{ title: "Core", description: "the core build" }],
  tasks: [{ milestoneRef: 0, headline: "Editor", description: "rich text editor", acceptance: "renders" }],
};
const SATISFIED: PlanReviewOutput = { satisfied: true, findings: [], newQuestions: [] };
const PHASE_USAGE: PhaseUsage = { model: "claude-phase", costUsd: 0.07, inputTokens: 50, outputTokens: 10 };

function collector(): { sink: WorkflowEventSink; events: Array<Omit<WorkflowEvent, "seq" | "ts">> } {
  const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
  return { sink: (e) => events.push(e), events };
}

function makeRuntime(
  store: LedgerStore,
  phase: FakePhaseSubagent,
  persistence: Persistence,
  producer: WorkflowProducer = new FakeProducer(),
): WorkflowRuntime {
  return new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => producer,
    selectPhaseSubagent: () => phase,
    persistence,
    cwd: "/tmp/wfhist-test",
  });
}

/** All invocation rows for a session, ordered by startedAt. */
function rowsForSession(p: Persistence, sessionId: string): InvocationRow[] {
  return p.invocations.listForSession(sessionId);
}

function runSuite(label: string, factory: () => Persistence): void {
  describe(`workflow-history (${label})`, () => {
    it("a full /plan run records a workflow session + root + one child per phase", async () => {
      const p = factory();
      try {
        const store = new InMemoryLedgerStore();
        await store.init();
        const phase = new FakePhaseSubagent().fireUsage(PHASE_USAGE);
        phase.enqueue(CLARIFY_REVIEW_SPEC, CLEAR).enqueue(PLAN_SPEC, PLAN).enqueue(PLAN_REVIEW_SPEC, SATISFIED);
        const rt = makeRuntime(store, phase, p);
        const { sink } = collector();

        // Phase 1: producer.
        const res = await rt.startPlan({ text: "build it", platform: "claude", model: "claude-run" }, sink);
        expect(res.outcome).toBe("questions_ready");
        if (res.outcome !== "questions_ready") throw new Error("unreachable");
        const goalId = res.goalId;

        // Exactly ONE workflow session surfaces as a top-level History row.
        const top = p.invocations.list(
          { agentName: "main" },
          { field: "startedAt", dir: "desc" },
          { offset: 0, limit: 50 },
        );
        const workflowMains = top.rows.filter((r) => r.kind === "workflow");
        expect(workflowMains).toHaveLength(1);
        const sessionId = workflowMains[0]!.sessionId;
        // Title became the goal title (was the /plan text placeholder).
        expect(workflowMains[0]!.title).toBe(PRODUCER_OUT.goal.title);

        // goalId → session link persisted.
        const link = p.workflowSessions.getByGoal(goalId);
        expect(link?.sessionId).toBe(sessionId);

        // Producer child recorded with usage; parent = root.
        const rootId = link!.rootInvocationId;
        let rows = rowsForSession(p, sessionId);
        const producerRow = rows.find((r) => r.agentName === "producer");
        expect(producerRow).toBeDefined();
        expect(producerRow!.parentInvocationId).toBe(rootId);
        expect(producerRow!.status).toBe("completed");
        expect(producerRow!.costUsd).toBeCloseTo(PRODUCER_USAGE.costUsd);
        expect(producerRow!.inputTokens).toBe(PRODUCER_USAGE.inputTokens);
        expect(producerRow!.model).toBe(PRODUCER_USAGE.model);

        // Answer the open question → auto-advance drives clarify → plan → review.
        const goal = store.fetchItem(GOALS_LEDGER, goalId);
        const specId = (goal.fields["milestones"] as string[])[0]!;
        const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
        await rt.submitAnswer(q0, "web");
        // Let the auto-advance chain settle.
        await rt.whenDrained();

        rows = rowsForSession(p, sessionId);
        const byAgent = (name: string) => rows.filter((r) => r.agentName.startsWith(name));
        // One of each looping phase (single round here).
        expect(byAgent("clarify-reviewer")).toHaveLength(1);
        expect(byAgent("planner")).toHaveLength(1);
        expect(byAgent("plan-reviewer")).toHaveLength(1);
        // Every child parents to the root + records usage + completed.
        for (const child of rows.filter((r) => r.agentName !== "main")) {
          expect(child.parentInvocationId).toBe(rootId);
          expect(child.status).toBe("completed");
          expect(child.costUsd).toBeGreaterThan(0);
        }

        // The run reached `planned` → root completed + session closed.
        const finalGoal = store.fetchItem(GOALS_LEDGER, goalId);
        expect(finalGoal.status).toBe("planned");
        const root = p.invocations.get(rootId);
        expect(root!.status).toBe("completed");
        const session = p.sessions.get(sessionId);
        expect(session!.endedAt).not.toBeNull();
        expect(session!.endedReason).toBe("planned");
      } finally {
        p.close();
      }
    });

    it("a phase failure marks that child errored and settles the run failed", async () => {
      const p = factory();
      try {
        const store = new InMemoryLedgerStore();
        await store.init();
        const phase = new FakePhaseSubagent();
        // No canned clarify-review output → dispatch rejects (phase failure).
        const rt = makeRuntime(store, phase, p);
        const { sink } = collector();

        const res = await rt.startPlan({ text: "build it", platform: "claude" }, sink);
        if (res.outcome !== "questions_ready") throw new Error("unreachable");
        const goalId = res.goalId;
        const link = p.workflowSessions.getByGoal(goalId)!;

        const goal = store.fetchItem(GOALS_LEDGER, goalId);
        const specId = (goal.fields["milestones"] as string[])[0]!;
        const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
        await rt.submitAnswer(q0, "web");
        await rt.whenDrained();

        const rows = rowsForSession(p, link.sessionId);
        const clarify = rows.find((r) => r.agentName.startsWith("clarify-reviewer"));
        expect(clarify).toBeDefined();
        expect(clarify!.status).toBe("failed");
        // Root settled failed, session closed.
        const root = p.invocations.get(link.rootInvocationId);
        expect(root!.status).toBe("failed");
        expect(p.sessions.get(link.sessionId)!.endedAt).not.toBeNull();
      } finally {
        p.close();
      }
    });

    it("loop rounds each produce one child row (one per round)", async () => {
      const p = factory();
      try {
        const store = new InMemoryLedgerStore();
        await store.init();
        const phase = new FakePhaseSubagent().fireUsage(PHASE_USAGE);
        // clarify clear → plan → review unsatisfied (revise) → plan again → satisfied.
        phase
          .enqueue(CLARIFY_REVIEW_SPEC, CLEAR)
          .enqueue(PLAN_SPEC, PLAN)
          .enqueue(PLAN_REVIEW_SPEC, {
            satisfied: false,
            findings: [{ severity: "major", issue: "thin", suggestion: "add tasks" }],
            newQuestions: [],
          } as PlanReviewOutput)
          // Revise: a DIFFERENT plan so the no-progress guard does not fire.
          .enqueue(PLAN_SPEC, {
            milestones: [{ title: "Core", description: "the core build" }, { title: "Polish", description: "polish" }],
            tasks: [{ milestoneRef: 1, headline: "Theme", description: "dark theme" }],
          } as PlanOutput)
          .enqueue(PLAN_REVIEW_SPEC, SATISFIED);
        const rt = makeRuntime(store, phase, p);
        const { sink } = collector();

        const res = await rt.startPlan({ text: "build it", platform: "claude" }, sink);
        if (res.outcome !== "questions_ready") throw new Error("unreachable");
        const goalId = res.goalId;
        const link = p.workflowSessions.getByGoal(goalId)!;
        const goal = store.fetchItem(GOALS_LEDGER, goalId);
        const specId = (goal.fields["milestones"] as string[])[0]!;
        const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
        await rt.submitAnswer(q0, "web");
        await rt.whenDrained();

        const rows = rowsForSession(p, link.sessionId);
        // Two planner rounds + two plan-reviewer rounds, each its own child.
        expect(rows.filter((r) => r.agentName.startsWith("planner"))).toHaveLength(2);
        expect(rows.filter((r) => r.agentName.startsWith("plan-reviewer"))).toHaveLength(2);
        // Round suffixes are distinct.
        const plannerNames = rows.filter((r) => r.agentName.startsWith("planner")).map((r) => r.agentName).sort();
        expect(plannerNames).toEqual(["planner#1", "planner#2"]);
      } finally {
        p.close();
      }
    });
  });
}

describe("workflow-history dual-adapter", () => {
  runSuite("sqlite", () => new SqlitePersistence(":memory:"));
  runSuite("memory", () => new InMemoryPersistence());
});
