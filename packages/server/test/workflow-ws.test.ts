/**
 * WsSession `/plan` routing tests (PR-wf-3).
 *
 * Drives the real WsSession.message dispatch with a workflow.start frame and
 * a real WorkflowRuntime (InMemoryLedgerStore + FakeProducer). Asserts:
 *  - lifecycle frames stream to the issuing WS connection in order;
 *  - a malformed /plan emits a single errored frame;
 *  - /plan G<id> for an unknown goal errors; for a planned goal it appends an
 *    increment and streams to questions_ready;
 *  - workflow === null emits an errored "no runtime" frame.
 */

import { describe, test, expect } from "bun:test";
import { WsSession, type WsSessionData } from "../src/ws/session.js";
import { InMemoryLedgerStore, GOALS_LEDGER, QUESTIONS_LEDGER, type LedgerStore } from "@cq/ledger";
import {
  WorkflowRuntime,
  CLARIFY_REVIEW_SPEC,
  CONTINUE_SPEC,
  PLAN_SPEC,
  PLAN_REVIEW_SPEC,
  type WorkflowProducer,
  type ProducerOutput,
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
  // Open so the session subscribes its workflow lifecycle sink to the runtime
  // fan-out (mirrors the Bun WS open handler).
  session.open(sock as Parameters<typeof session.open>[0]);
  return sock;
}
function send(wsSession: WsSession, socket: MockSocket, frame: Record<string, unknown>): void {
  wsSession.message(socket as Parameters<typeof wsSession.message>[0], JSON.stringify(frame));
}
function statuses(socket: MockSocket): string[] {
  return socket.sent.filter((f) => f.type === "workflow.event").map((f) => f["status"] as string);
}

const CANNED: ProducerOutput = {
  goal: { description: "desc" },
  questions: [{ question: "q1?" }],
};
class FakeProducer implements WorkflowProducer {
  produce(): Promise<ProducerOutput> {
    return Promise.resolve(CANNED);
  }
}
function makeRuntime(store: LedgerStore): WorkflowRuntime {
  return new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => new FakeProducer(),
    selectPhaseSubagent: () => new FakePhaseSubagent(),
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for predicate");
}

describe("WsSession /plan routing", () => {
  test("new /plan streams started→producing→questions_ready", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ws = new WsSession("conn-1", noopLogger, undefined, null, null, makeRuntime(store));
    const socket = makeMockSocket(ws);

    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));
    expect(statuses(socket)).toEqual(["started", "producing", "questions_ready"]);

    await store.dispose();
  });

  test("malformed /plan emits a single errored frame", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ws = new WsSession("conn-2", noopLogger, undefined, null, null, makeRuntime(store));
    const socket = makeMockSocket(ws);

    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "" });
    expect(statuses(socket)).toEqual(["errored"]);

    await store.dispose();
  });

  test("/plan G<id> for an unknown goal routes to an errored frame", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ws = new WsSession("conn-3", noopLogger, undefined, null, null, makeRuntime(store));
    const socket = makeMockSocket(ws);

    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", goalRef: "G2", text: "add feature" });
    await waitFor(() => statuses(socket).includes("errored"));
    const evts = socket.sent.filter((f) => f.type === "workflow.event");
    expect(evts.at(-1)!["status"]).toBe("errored");
    expect(evts.at(-1)!["detail"]).toContain("does not exist");

    await store.dispose();
  });

  test("/plan G<id> for a planned goal streams the continuation to questions_ready", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new FakeProducer(),
      selectPhaseSubagent: () => phase,
    });
    const ws = new WsSession("conn-3b", noopLogger, undefined, null, null, rt);
    const socket = makeMockSocket(ws);

    // Drive a fresh goal to `planned` first.
    phase.enqueue(CLARIFY_REVIEW_SPEC, { clear: true, contradictions: [], newQuestions: [] });
    phase.enqueue(PLAN_SPEC, { milestones: [{ title: "Core", description: "d" }], tasks: [{ milestoneRef: 0, headline: "T", description: "d" }] });
    phase.enqueue(PLAN_REVIEW_SPEC, { satisfied: true, findings: [], newQuestions: [] });
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));
    const goalId = (store.fetch(GOALS_LEDGER).milestones.flatMap((g) => g.items))[0]!.id;
    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    send(ws, socket, { type: "question.answer", seq: 2, ts: Date.now(), questionId: q0, answer: "web" });
    await waitFor(() => store.fetchItem(GOALS_LEDGER, goalId).status === "planned");

    // Now continue: a new increment batch reaches questions_ready.
    const before = socket.sent.length;
    phase.enqueue(CONTINUE_SPEC, { goal: { description: "extended" }, questions: [{ question: "scope?" }] });
    send(ws, socket, { type: "workflow.start", seq: 3, ts: Date.now(), kind: "plan", goalRef: goalId, text: "add feature", platform: "claude" });
    await waitFor(() => socket.sent.slice(before).some((f) => f.type === "workflow.event" && f["status"] === "questions_ready"));
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("clarifying");
    const ms = store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[];
    expect(ms.at(-1)).not.toBe(specId); // an increment milestone was appended

    await store.dispose();
  });

  test("workflow runtime not wired → errored 'no runtime' frame", () => {
    const ws = new WsSession("conn-4", noopLogger, undefined, null, null, null);
    const socket = makeMockSocket(ws);
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it" });
    const evts = socket.sent.filter((f) => f.type === "workflow.event");
    expect(evts).toHaveLength(1);
    expect(evts[0]!["status"]).toBe("errored");
    expect(evts[0]!["detail"]).toContain("No workflow runtime");
  });

  test("goals.list replies with a goals.snapshot keyed by request seq", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ws = new WsSession("conn-g1", noopLogger, undefined, null, null, makeRuntime(store));
    const socket = makeMockSocket(ws);

    // Empty store → snapshot with no goals, zero badge.
    send(ws, socket, { type: "goals.list", seq: 42, ts: Date.now() });
    const empty = socket.sent.find((f) => f.type === "goals.snapshot")!;
    expect(empty["requestSeq"]).toBe(42);
    expect(empty["goals"]).toEqual([]);
    expect(empty["totalOpenQuestions"]).toBe(0);

    // Produce a goal, then re-request: snapshot reflects it with the open question.
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));
    send(ws, socket, { type: "goals.list", seq: 43, ts: Date.now() });
    const snaps = socket.sent.filter((f) => f.type === "goals.snapshot");
    const latest = snaps[snaps.length - 1]!;
    expect(latest["requestSeq"]).toBe(43);
    const goals = latest["goals"] as Array<Record<string, unknown>>;
    expect(goals).toHaveLength(1);
    expect(goals[0]!["status"]).toBe("clarifying");
    expect(goals[0]!["openQuestionCount"]).toBe(1);
    expect(latest["totalOpenQuestions"]).toBe(1);

    await store.dispose();
  });

  test("workflow.escalation_reply: abandon flips the goal to abandoned", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    phase.enqueue(CLARIFY_REVIEW_SPEC, { clear: true, contradictions: [], newQuestions: [] });
    phase.setSticky(PLAN_SPEC, {
      milestones: [{ title: "C", description: "c" }],
      tasks: [{ milestoneRef: 0, headline: "T", description: "d" }],
    });
    phase.setSticky(PLAN_REVIEW_SPEC, {
      satisfied: false,
      findings: [{ severity: "major", issue: "thin", suggestion: "more" }],
      newQuestions: [],
    });
    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new FakeProducer(),
      selectPhaseSubagent: () => phase,
    });
    const ws = new WsSession("conn-g2", noopLogger, undefined, null, null, rt);
    const socket = makeMockSocket(ws);

    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));
    const goalId = (socket.sent.find((f) => f.type === "workflow.event" && f["goalId"] !== undefined) as ParsedFrame)["goalId"] as string;
    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;
    send(ws, socket, { type: "question.answer", seq: 2, ts: Date.now(), questionId: q0, answer: "web" });
    await waitFor(() => statuses(socket).includes("escalated"));

    send(ws, socket, { type: "workflow.escalation_reply", seq: 3, ts: Date.now(), goalId, choice: "abandon" });
    await waitFor(() => store.fetchItem(GOALS_LEDGER, goalId).status === "abandoned");
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("abandoned");

    await store.dispose();
  });

  test("question.answer writes the answer, flips status, and auto-advances the loop", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const phase = new FakePhaseSubagent();
    phase
      .enqueue(CLARIFY_REVIEW_SPEC, { clear: true, contradictions: [], newQuestions: [] })
      .enqueue(PLAN_SPEC, {
        milestones: [{ title: "Core", description: "c" }],
        tasks: [{ milestoneRef: 0, headline: "T", description: "d" }],
      })
      .enqueue(PLAN_REVIEW_SPEC, { satisfied: true, findings: [], newQuestions: [] });
    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new FakeProducer(),
      selectPhaseSubagent: () => phase,
    });
    const ws = new WsSession("conn-5", noopLogger, undefined, null, null, rt);
    const socket = makeMockSocket(ws);

    // Phase 1 via the socket.
    send(ws, socket, { type: "workflow.start", seq: 1, ts: Date.now(), kind: "plan", text: "build it", platform: "claude" });
    await waitFor(() => statuses(socket).includes("questions_ready"));

    const goalId = (socket.sent.find((f) => f.type === "workflow.event" && f["goalId"] !== undefined) as ParsedFrame)["goalId"] as string;
    const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;

    // Answer the only open question via the WS frame → write + flip + advance.
    send(ws, socket, { type: "question.answer", seq: 2, ts: Date.now(), questionId: q0, answer: "web" });
    await waitFor(() => statuses(socket).includes("planned"));

    // The answer was written and the question flipped to answered.
    const answered = store.fetchItem(QUESTIONS_LEDGER, q0);
    expect(answered.status).toBe("answered");
    expect(answered.fields["answer"]).toBe("web");
    // The loop auto-advanced all the way to planned.
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");
    expect(statuses(socket)).toContain("done");

    await store.dispose();
  });
});
