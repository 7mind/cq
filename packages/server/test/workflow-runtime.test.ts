/**
 * WorkflowRuntime phase-1 tests (PR-wf-2) against a FAKE producer.
 *
 * Verifies: goal(clarifying) + mandatory spec milestone + questions land with
 * correct linkage/IDs; lifecycle frames are emitted in order; a 2nd /plan
 * while one is active is rejected busy; a producer failure leaves NO
 * half-written ledger state; continuation routes to a not-implemented error.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  GOALS_LEDGER,
  QUESTIONS_LEDGER,
  MILESTONES_LEDGER,
  type LedgerStore,
} from "@cq/ledger";
import {
  WorkflowRuntime,
  SPEC_MILESTONE_TITLE,
  type WorkflowProducer,
  type ProducerOutput,
  type WorkflowEventSink,
} from "../src/workflow/index";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";

const CANNED: ProducerOutput = {
  goal: { description: "A local-first encrypted notetaking webapp." },
  questions: [
    { question: "Which platforms?", context: "desktop/mobile", suggestions: ["web", "desktop"], recommendation: "web" },
    { question: "What encryption scheme?", recommendation: "age" },
  ],
};

class FakeProducer implements WorkflowProducer {
  constructor(private readonly out: ProducerOutput | (() => Promise<ProducerOutput>)) {}
  produce(): Promise<ProducerOutput> {
    return typeof this.out === "function" ? this.out() : Promise.resolve(this.out);
  }
}

function makeRuntime(store: LedgerStore, producer: WorkflowProducer): WorkflowRuntime {
  return new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => producer,
    selectPhaseSubagent: () => new FakePhaseSubagent(),
  });
}

function collector(): { sink: WorkflowEventSink; events: Array<Omit<WorkflowEvent, "seq" | "ts">> } {
  const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
  return { sink: (e) => events.push(e), events };
}

describe("WorkflowRuntime phase 1", () => {
  it("writes goal+spec milestone+questions and emits lifecycle frames in order", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const rt = makeRuntime(store, new FakeProducer(CANNED));
    const { sink, events } = collector();

    const result = await rt.startPlan({ text: "build it", platform: "claude" }, sink);

    expect(result.outcome).toBe("questions_ready");
    if (result.outcome !== "questions_ready") throw new Error("unreachable");

    // Lifecycle order: started → producing → questions_ready.
    expect(events.map((e) => e.status)).toEqual(["started", "producing", "questions_ready"]);
    expect(events[2]!.goalId).toBe(result.goalId);
    expect(events[2]!.detail).toContain("2 questions");

    // Spec milestone exists with the mandatory title. In the milestones
    // ledger, milestones are ITEMS in the single `active` group; the title
    // lives in `fields.title`.
    const milestones = store.fetch(MILESTONES_LEDGER);
    const specItem = milestones.milestones
      .flatMap((g) => g.items)
      .find((i) => i.fields["title"] === SPEC_MILESTONE_TITLE);
    expect(specItem).toBeDefined();
    const specId = specItem!.id;

    // Goal: status=clarifying, description set, milestones=[specId].
    const goal = store.fetchItem(GOALS_LEDGER, result.goalId);
    expect(goal.status).toBe("clarifying");
    expect(goal.fields["description"]).toBe(CANNED.goal.description);
    expect(goal.fields["milestones"]).toEqual([specId]);
    expect(goal.milestoneId).toBe(specId);

    // Questions: 2 rows under the spec milestone, fields mapped through.
    const grouped = store.listMilestoneItems(specId);
    const qs = grouped[QUESTIONS_LEDGER] ?? [];
    expect(qs).toHaveLength(2);
    expect(qs[0]!.status).toBe("open");
    expect(qs[0]!.fields["question"]).toBe("Which platforms?");
    expect(qs[0]!.fields["suggestions"]).toEqual(["web", "desktop"]);
    expect(qs[0]!.fields["recommendation"]).toBe("web");
    // Second question has no context/suggestions — optional fields omitted.
    expect(qs[1]!.fields["question"]).toBe("What encryption scheme?");
    expect(qs[1]!.fields["context"]).toBeUndefined();

    await store.dispose();
  });

  it("rejects a second /plan while one is active (busy)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    // Gate the first producer so it stays active while we fire the second.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowProducer = new FakeProducer(async () => {
      await gate;
      return CANNED;
    });
    const rt = makeRuntime(store, slowProducer);
    const { sink } = collector();

    const first = rt.startPlan({ text: "first", platform: "claude" }, sink);
    // Yield so the first run registers as active before the second starts.
    await Bun.sleep(10);

    const { sink: sink2, events: events2 } = collector();
    const second = await rt.startPlan({ text: "second", platform: "claude" }, sink2);
    expect(second.outcome).toBe("busy");
    expect(events2.map((e) => e.status)).toEqual(["errored"]);
    expect(events2[0]!.detail).toContain("already running");

    release();
    const firstResult = await first;
    expect(firstResult.outcome).toBe("questions_ready");

    await store.dispose();
  });

  it("leaves NO ledger state when the producer fails", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const failing = new FakeProducer(() => Promise.reject(new Error("producer boom")));
    const rt = makeRuntime(store, failing);
    const { sink, events } = collector();

    const result = await rt.startPlan({ text: "x", platform: "claude" }, sink);
    expect(result.outcome).toBe("errored");
    if (result.outcome === "errored") expect(result.reason).toContain("producer boom");

    // started → producing → errored; no questions_ready.
    expect(events.map((e) => e.status)).toEqual(["started", "producing", "errored"]);

    // No goals, no questions, no spec milestone written.
    const goals = store.fetch(GOALS_LEDGER);
    expect(goals.milestones.flatMap((m) => m.items)).toHaveLength(0);
    const questions = store.fetch(QUESTIONS_LEDGER);
    expect(questions.milestones.flatMap((m) => m.items)).toHaveLength(0);
    const milestones = store.fetch(MILESTONES_LEDGER);
    const specItem = milestones.milestones
      .flatMap((g) => g.items)
      .find((i) => i.fields["title"] === SPEC_MILESTONE_TITLE);
    expect(specItem).toBeUndefined();

    // Runtime is no longer busy — a subsequent /plan can run.
    expect(rt.isBusy()).toBe(false);

    await store.dispose();
  });

  it("rejects /plan G<id> continuation when the goal does not exist", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const rt = makeRuntime(store, new FakeProducer(CANNED));
    const { sink, events } = collector();

    const result = await rt.continueGoal("G1", "add encryption", "claude", sink);
    expect(result.outcome).toBe("errored");
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("errored");
    expect(events[0]!.detail).toContain("does not exist");

    await store.dispose();
  });
});

describe("WorkflowRuntime.whenDrained — subprocess teardown awaitable (WFL-D02)", () => {
  it("resolves immediately when nothing is in flight", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const rt = makeRuntime(store, new FakeProducer(CANNED));
    // No dispatch has run → no pending teardown, no active slot.
    await rt.whenDrained();
    await store.dispose();
  });

  it("blocks until a dispatch's registered teardown promise settles", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    // A producer that resolves its output (submit-time) but registers a teardown
    // promise we control — modelling query().close() reaping the subprocess
    // strictly AFTER produce() resolves.
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((res) => { releaseTeardown = res; });
    let teardownRegistered = false;
    const producer: WorkflowProducer = {
      produce: (req) => {
        req.registerTeardown?.(teardownGate);
        teardownRegistered = true;
        return Promise.resolve(CANNED);
      },
    };

    const rt = makeRuntime(store, producer);
    const { sink } = collector();
    const result = await rt.startPlan({ text: "build it", platform: "claude" }, sink);
    expect(result.outcome).toBe("questions_ready");
    expect(teardownRegistered).toBe(true);

    // whenDrained must NOT resolve while the teardown is still pending.
    let drained = false;
    const drainPromise = rt.whenDrained().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(drained).toBe(false);

    // Release the (simulated) subprocess exit → whenDrained resolves.
    releaseTeardown();
    await drainPromise;
    expect(drained).toBe(true);

    await store.dispose();
  });
});
