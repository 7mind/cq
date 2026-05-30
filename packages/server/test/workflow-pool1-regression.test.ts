/**
 * Pool=1 invariant regression (PR-wf-2 adversarial focus #1).
 *
 * The headless workflow lane must NOT disturb the pool=1 interactive chat
 * session. This test proves, structurally:
 *  1. While a workflow is mid-flight (producer held open), the interactive
 *     Bridge is NOT busy and a chat.start succeeds (Bridge.active is the
 *     interactive session, untouched by the workflow lane).
 *  2. After a workflow FAILS, the interactive chat is still usable.
 *
 * The workflow uses a FakeProducer (no real subprocess), so this isolates the
 * lane-separation invariant from SDK behaviour: the WorkflowRuntime never
 * calls into the Bridge, so the Bridge cannot be perturbed.
 */

import { describe, it, expect } from "bun:test";
import { Bridge } from "../src/agent/bridge";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryLedgerStore, type LedgerStore } from "@cq/ledger";
import { WorkflowRuntime, type WorkflowProducer, type ProducerOutput } from "../src/workflow/index";
import {
  noopLogger,
  makeMockQuery,
  makeInitMessage,
  makeAssistantMessage,
  MockWsSocket,
} from "./helpers/mockBridge";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";

const CANNED: ProducerOutput = { goal: { title: "D goal", description: "d" }, questions: [{ question: "q?" }] };

function makeRuntime(store: LedgerStore, producer: WorkflowProducer): WorkflowRuntime {
  return new WorkflowRuntime({
    logger: noopLogger,
    store,
    selectProducer: () => producer,
    selectPhaseSubagent: () => new FakePhaseSubagent(),
  });
}

/** A chat-mock query: init + one assistant message + result, then ends. */
function chatScript() {
  return makeMockQuery([
    makeInitMessage(),
    makeAssistantMessage("hello from chat"),
    { type: "result", subtype: "success", result: "hello from chat", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } } as never,
  ]);
}

describe("pool=1 invariant — workflow lane does not disturb interactive chat", () => {
  it("interactive chat works while a workflow is mid-flight, and after it completes", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, cwd: "/tmp", queryFactory: () => chatScript() });

    // Hold the producer open so the workflow stays mid-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: WorkflowProducer = { produce: async () => { await gate; return CANNED; } };
    const rt = makeRuntime(store, slow);

    // Start a workflow; it parks in produce().
    const wfEvents: string[] = [];
    const wfPromise = rt.startPlan({ text: "build it", platform: "claude" }, (e) => wfEvents.push(e.status));
    await Bun.sleep(10);
    expect(rt.isBusy()).toBe(true);

    // The interactive Bridge is NOT busy because of the workflow.
    expect(bridge.isBusy()).toBe(false);

    // A chat.start + input runs to completion while the workflow is parked.
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, { type: "chat.start", seq: 0, ts: Date.now() });
    const sessionId = bridge.activeSessionId()!;
    expect(sessionId).not.toBeNull();
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "hi" });
    await ws.waitForFrames("chat.done", 1, 3000);
    const done = ws.framesOfType("chat.done");
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done[0]!["reason"]).toBe("completed");

    // Release the workflow; it finishes independently.
    release();
    const wfResult = await wfPromise;
    expect(wfResult.outcome).toBe("questions_ready");
    expect(wfEvents).toEqual(["started", "producing", "questions_ready"]);

    // After the workflow finishes, the interactive chat still works (new turn).
    const ws2 = new MockWsSocket();
    await bridge.handleChatStart(ws2, { type: "chat.start", seq: 2, ts: Date.now() });
    const sid2 = bridge.activeSessionId()!;
    await bridge.handleChatInput(ws2, { type: "chat.input", seq: 3, ts: Date.now(), sessionId: sid2, text: "again" });
    await ws2.waitForFrames("chat.done", 1, 3000);
    expect(ws2.framesOfType("chat.done").length).toBeGreaterThanOrEqual(1);

    await bridge.shutdown();
    await store.dispose();
  });

  it("interactive chat is usable after a workflow FAILS", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, cwd: "/tmp", queryFactory: () => chatScript() });
    const failing: WorkflowProducer = { produce: () => Promise.reject(new Error("boom")) };
    const rt = makeRuntime(store, failing);

    const wfResult = await rt.startPlan({ text: "x", platform: "claude" }, () => {});
    expect(wfResult.outcome).toBe("errored");
    expect(bridge.isBusy()).toBe(false);

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, { type: "chat.start", seq: 0, ts: Date.now() });
    const sessionId = bridge.activeSessionId()!;
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "hi" });
    await ws.waitForFrames("chat.done", 1, 3000);
    expect(ws.framesOfType("chat.done").length).toBeGreaterThanOrEqual(1);

    await bridge.shutdown();
    await store.dispose();
  });
});
