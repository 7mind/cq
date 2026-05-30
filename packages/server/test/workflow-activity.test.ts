/**
 * workflow-activity.test.ts — WorkflowRuntime.activeDispatchCount + onActivityChange
 * (ACTIVITY-01).
 *
 * `activeDispatchCount()` is 1 while a phase is dispatching (the `active` slot is
 * occupied, between dispatch-start and submit/settle) and 0 when settled or
 * parked. `onActivityChange` fires on dispatch START and END. We gate the
 * producer/phase dispatch on a promise so the test can observe the mid-flight
 * value deterministically, then release and observe the settle.
 *
 * Justification (why `active`, not `pendingTeardowns`): `active` clears at
 * submit/settle — when the model is done. `pendingTeardowns` tracks post-submit
 * subprocess reap; counting it would over-report. These tests assert the count
 * tracks `active` exactly.
 */

import { describe, it, expect } from "bun:test";
import { InMemoryLedgerStore, type LedgerStore } from "@cq/ledger";
import {
  WorkflowRuntime,
  type WorkflowProducer,
  type ProducerOutput,
  type ProduceRequest,
  type WorkflowEventSink,
} from "../src/workflow/index";
import { noopLogger } from "./helpers/mockBridge";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";

const CANNED: ProducerOutput = {
  goal: { title: "Notes app", description: "A local notes app." },
  questions: [{ question: "Which platforms?" }],
};

/** A producer whose `produce()` blocks on an external gate until released. */
class GatedProducer implements WorkflowProducer {
  released = false;
  private resolveGate!: () => void;
  readonly gate: Promise<void>;
  /** Resolves once `produce()` has actually started (active slot is occupied). */
  started!: Promise<void>;
  private resolveStarted!: () => void;

  constructor() {
    this.gate = new Promise<void>((r) => {
      this.resolveGate = r;
    });
    this.started = new Promise<void>((r) => {
      this.resolveStarted = r;
    });
  }

  async produce(_req: ProduceRequest): Promise<ProducerOutput> {
    this.resolveStarted();
    await this.gate;
    return CANNED;
  }

  release(): void {
    this.released = true;
    this.resolveGate();
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

function collector(): WorkflowEventSink {
  return () => {};
}

describe("WorkflowRuntime.activeDispatchCount", () => {
  it("is 1 while a phase is dispatching and 0 once settled", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const producer = new GatedProducer();
    const rt = makeRuntime(store, producer);

    // Idle before any dispatch.
    expect(rt.activeDispatchCount()).toBe(0);
    expect(rt.isBusy()).toBe(false);

    // Start a /plan run; the gated producer holds the dispatch open.
    const runPromise = rt.startPlan({ text: "build it", platform: "claude" }, collector());
    await producer.started;

    // Mid-flight: the model is working → count is 1.
    expect(rt.activeDispatchCount()).toBe(1);
    expect(rt.isBusy()).toBe(true);

    // Release → the dispatch settles, the slot frees.
    producer.release();
    await runPromise;

    expect(rt.activeDispatchCount()).toBe(0);
    expect(rt.isBusy()).toBe(false);

    await store.dispose();
  });

  it("is 0 when the workflow is PARKED waiting on answers (no dispatch in flight)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    // A normal (non-gated) producer: phase-1 completes and parks on the
    // question batch (status=clarifying, open questions). No phase is dispatching.
    const producer: WorkflowProducer = {
      produce: () => Promise.resolve(CANNED),
    };
    const rt = makeRuntime(store, producer);

    const result = await rt.startPlan({ text: "build it", platform: "claude" }, collector());
    expect(result.outcome).toBe("questions_ready");

    // Parked on answers: the model is NOT computing → 0.
    expect(rt.activeDispatchCount()).toBe(0);
    expect(rt.isBusy()).toBe(false);

    await store.dispose();
  });

  it("onActivityChange fires on dispatch START and END", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const producer = new GatedProducer();
    const rt = makeRuntime(store, producer);

    // Record the count observed at each activity-change notification.
    const observed: number[] = [];
    const unsub = rt.onActivityChange(() => observed.push(rt.activeDispatchCount()));

    const runPromise = rt.startPlan({ text: "build it", platform: "claude" }, collector());
    await producer.started;
    // After START: the listener fired once with count 1.
    expect(observed).toEqual([1]);

    producer.release();
    await runPromise;
    // After END: the listener fired again with count 0.
    expect(observed).toEqual([1, 0]);

    unsub();

    await store.dispose();
  });

  it("onActivityChange unsubscribe stops further notifications", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const producer: WorkflowProducer = { produce: () => Promise.resolve(CANNED) };
    const rt = makeRuntime(store, producer);

    let calls = 0;
    const unsub = rt.onActivityChange(() => {
      calls++;
    });
    unsub();

    await rt.startPlan({ text: "build it", platform: "claude" }, collector());
    expect(calls).toBe(0);

    await store.dispose();
  });
});
