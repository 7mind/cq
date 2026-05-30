/**
 * activity-ws.test.ts — WsSession ↔ AggregateActivityTracker integration
 * (ACTIVITY-01).
 *
 * Drives the REAL WsSession with a real WorkflowRuntime + AggregateActivityTracker
 * wired exactly as server.ts wires them (the tracker reads the workflow lane's
 * activeDispatchCount + is notified via onActivityChange; the chat lane is a
 * mock isBusy closure here). Asserts:
 *   - an `activity.status{running:0}` frame is pushed on connect (open);
 *   - `running` rises to 1 while a workflow phase is dispatching and falls back
 *     to 0 on settle, pushed to the connection on each transition;
 *   - a parked workflow (questions_ready) leaves running at 0;
 *   - the chat lane contributes 1 when busy (aggregate with workflow → 2).
 */

import { describe, test, expect } from "bun:test";
import { WsSession, type WsSessionData } from "../src/ws/session.js";
import { AggregateActivityTracker } from "../src/ws/activityTracker.js";
import { InMemoryLedgerStore, type LedgerStore } from "@cq/ledger";
import {
  WorkflowRuntime,
  type WorkflowProducer,
  type ProducerOutput,
  type ProduceRequest,
} from "../src/workflow/index.js";
import { noopLogger } from "./helpers/mockBridge.js";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent.js";

interface ParsedFrame {
  type: string;
  [key: string]: unknown;
}
interface MockSocket {
  sent: ParsedFrame[];
  send(data: string): void;
  close(): void;
  data: WsSessionData;
}
function makeMockSocket(session: WsSession): MockSocket {
  const sock: MockSocket = {
    sent: [],
    send(data: string) {
      sock.sent.push(JSON.parse(data) as ParsedFrame);
    },
    close() {},
    data: { sessionId: session.sessionId, session },
  };
  session.open(sock as Parameters<typeof session.open>[0]);
  return sock;
}
function send(wsSession: WsSession, socket: MockSocket, frame: Record<string, unknown>): void {
  wsSession.message(socket as Parameters<typeof wsSession.message>[0], JSON.stringify(frame));
}
function activityRunning(socket: MockSocket): number[] {
  return socket.sent.filter((f) => f.type === "activity.status").map((f) => f["running"] as number);
}
function statuses(socket: MockSocket): string[] {
  return socket.sent.filter((f) => f.type === "workflow.event").map((f) => f["status"] as string);
}

const CANNED: ProducerOutput = {
  goal: { title: "Notes app", description: "A notes app." },
  questions: [{ question: "Which platforms?" }],
};

class GatedProducer implements WorkflowProducer {
  private resolveGate!: () => void;
  readonly gate: Promise<void>;
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

/** Wire a tracker to a workflow lane + a mutable chat-busy flag, server-style. */
function wireTracker(
  workflow: WorkflowRuntime,
  chatBusy: { value: boolean },
): AggregateActivityTracker {
  const tracker = new AggregateActivityTracker({
    isChatBusy: () => chatBusy.value,
    workflowActiveDispatchCount: () => workflow.activeDispatchCount(),
  });
  workflow.onActivityChange(() => tracker.onLaneChange());
  return tracker;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for predicate");
}

describe("WsSession activity.status (ACTIVITY-01)", () => {
  test("pushes activity.status{running:0} on connect", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const chatBusy = { value: false };
    const workflow = makeRuntime(store, { produce: () => Promise.resolve(CANNED) });
    const tracker = wireTracker(workflow, chatBusy);
    const ws = new WsSession("conn-1", noopLogger, undefined, null, null, workflow, tracker);
    const socket = makeMockSocket(ws);

    // Initial state on connect.
    expect(activityRunning(socket)).toEqual([0]);

    await store.dispose();
  });

  test("running rises to 1 while a workflow phase dispatches, then falls to 0 on settle", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const chatBusy = { value: false };
    const producer = new GatedProducer();
    const workflow = makeRuntime(store, producer);
    const tracker = wireTracker(workflow, chatBusy);
    const ws = new WsSession("conn-2", noopLogger, undefined, null, null, workflow, tracker);
    const socket = makeMockSocket(ws);

    expect(activityRunning(socket)).toEqual([0]); // initial

    // Start a /plan run; the gated producer holds the phase dispatch open.
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await producer.started;
    await waitFor(() => activityRunning(socket).includes(1));
    // The badge must show BUSY (1) while the phase is dispatching.
    expect(activityRunning(socket)).toEqual([0, 1]);

    // Release → settle → back to 0, pushed.
    producer.release();
    await waitFor(() => statuses(socket).includes("questions_ready"));
    await waitFor(() => activityRunning(socket).at(-1) === 0);
    expect(activityRunning(socket)).toEqual([0, 1, 0]);

    await store.dispose();
  });

  test("a parked workflow (questions_ready, no dispatch) leaves running at 0", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const chatBusy = { value: false };
    const workflow = makeRuntime(store, { produce: () => Promise.resolve(CANNED) });
    const tracker = wireTracker(workflow, chatBusy);
    const ws = new WsSession("conn-3", noopLogger, undefined, null, null, workflow, tracker);
    const socket = makeMockSocket(ws);

    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));
    // Parked on answers: the final pushed running value is 0 (phase settled).
    expect(activityRunning(socket).at(-1)).toBe(0);

    await store.dispose();
  });

  test("chat-busy + a concurrent workflow phase aggregate to running=2", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const chatBusy = { value: false };
    const producer = new GatedProducer();
    const workflow = makeRuntime(store, producer);
    const tracker = wireTracker(workflow, chatBusy);
    const ws = new WsSession("conn-4", noopLogger, undefined, null, null, workflow, tracker);
    const socket = makeMockSocket(ws);

    // Simulate a chat turn starting (chat lane busy) — the chat lane's
    // onBusyChange is wired to tracker.onLaneChange in production; here we call
    // it directly to model the chat backend's busy transition.
    chatBusy.value = true;
    tracker.onLaneChange();
    expect(activityRunning(socket).at(-1)).toBe(1);

    // Now a workflow phase dispatches concurrently → 2.
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await producer.started;
    await waitFor(() => activityRunning(socket).includes(2));
    expect(activityRunning(socket).at(-1)).toBe(2);

    producer.release();
    await waitFor(() => activityRunning(socket).at(-1) === 1);
    // Workflow settled but chat still busy → 1.
    expect(activityRunning(socket).at(-1)).toBe(1);

    await store.dispose();
  });
});
