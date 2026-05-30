/**
 * Pool=1 invariant regression for the Codex workflow lane (codexwf adversarial
 * focus #3).
 *
 * The headless Codex workflow lane must NOT disturb the pool=1 interactive chat
 * session. The headless lane uses its OWN `Codex` instance + thread (via the
 * injected codexFactory) and never touches the interactive `Bridge.active`, so
 * the invariant holds by construction. This test proves it structurally with a
 * FAKE codex thread (no real subprocess):
 *  1. While a Codex workflow producer is held mid-flight, the interactive
 *     Bridge is NOT busy and a chat.start + input runs to completion.
 *  2. After the Codex workflow FAILS, the interactive chat is still usable.
 */

import { describe, it, expect } from "bun:test";
import type { Codex, CodexOptions, Thread, RunStreamedResult, ThreadEvent } from "@openai/codex-sdk";
import { Bridge } from "../src/agent/bridge";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryLedgerStore } from "@cq/ledger";
import {
  WorkflowRuntime,
  WorkflowSubmitProxy,
  CodexProducer,
  CodexPhaseSubagent,
  makeSubmitIdGenerator,
} from "../src/workflow/index";
import {
  noopLogger,
  makeMockQuery,
  makeInitMessage,
  makeAssistantMessage,
  MockWsSocket,
} from "./helpers/mockBridge";

/** A chat-mock query: init + one assistant message + result, then ends. */
function chatScript() {
  return makeMockQuery([
    makeInitMessage(),
    makeAssistantMessage("hello from chat"),
    { type: "result", subtype: "success", result: "hello from chat", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } } as never,
  ]);
}

/** A fake Codex whose thread holds open until `release()` is called, then relays. */
function gatedCodexFactory(
  onRelay: (submitId: string, phase: string, payload: unknown) => void,
  gate: Promise<void>,
  payload: unknown,
): { factory: (o?: CodexOptions) => Promise<Codex> } {
  class GatedThread {
    constructor(private readonly env: Record<string, string>) {}
    get id(): string | null { return "gated"; }
    async runStreamed(): Promise<RunStreamedResult> {
      const env = this.env;
      async function* events(): AsyncGenerator<ThreadEvent> {
        yield { type: "turn.started" } as ThreadEvent;
        await gate; // hold the dispatch mid-flight
        onRelay(env["CQ_WORKFLOW_SUBMIT_ID"]!, env["CQ_WORKFLOW_PHASE"]!, payload);
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as ThreadEvent;
      }
      return { events: events() };
    }
    async run(): Promise<never> { throw new Error("not exercised"); }
  }
  class GatedCodex {
    constructor(private readonly options?: CodexOptions) {}
    private env(): Record<string, string> {
      const cfg = this.options?.config as { mcp_servers?: { cq?: { env?: Record<string, string> } } } | undefined;
      return cfg?.mcp_servers?.cq?.env ?? {};
    }
    startThread(): Thread { return new GatedThread(this.env()) as unknown as Thread; }
    resumeThread(): Thread { return this.startThread(); }
  }
  return { factory: async (o?: CodexOptions): Promise<Codex> => new GatedCodex(o) as unknown as Codex };
}

describe("pool=1 invariant — Codex workflow lane does not disturb interactive chat", () => {
  it("interactive chat works while a Codex workflow is mid-flight, and after it completes", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, cwd: "/tmp", queryFactory: () => chatScript() });

    const submitProxy = new WorkflowSubmitProxy({ logger: noopLogger, sendAck: () => {} });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory } = gatedCodexFactory(
      (submitId, phase, payload) => submitProxy.onSubmit({ submitId, phase: phase as never, payload }),
      gate,
      { goal: { title: "D goal", description: "d" }, questions: [{ question: "q?" }] },
    );

    const codexDeps = {
      logger: noopLogger,
      cwd: "/tmp/codex-pool1",
      submitProxy,
      internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
      internalWsToken: "tok",
      nextSubmitId: makeSubmitIdGenerator(1),
      codexFactory: factory,
      timeoutMs: 30_000,
    };
    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new CodexProducer(codexDeps),
      selectPhaseSubagent: () => new CodexPhaseSubagent(codexDeps),
    });

    const wfEvents: string[] = [];
    const wfPromise = rt.startPlan({ text: "build it", platform: "codex" }, (e) => wfEvents.push(e.status));
    await Bun.sleep(10);
    expect(rt.isBusy()).toBe(true);

    // The interactive Bridge is NOT busy because of the Codex workflow.
    expect(bridge.isBusy()).toBe(false);

    // A chat.start + input runs to completion while the workflow is parked.
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, { type: "chat.start", seq: 0, ts: Date.now() });
    const sessionId = bridge.activeSessionId()!;
    expect(sessionId).not.toBeNull();
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "hi" });
    await ws.waitForFrames("chat.done", 1, 3000);
    expect(ws.framesOfType("chat.done").length).toBeGreaterThanOrEqual(1);

    // Release the workflow; it finishes independently.
    release();
    const wfResult = await wfPromise;
    expect(wfResult.outcome).toBe("questions_ready");

    // After the workflow finishes, the interactive chat still works.
    const ws2 = new MockWsSocket();
    await bridge.handleChatStart(ws2, { type: "chat.start", seq: 2, ts: Date.now() });
    const sid2 = bridge.activeSessionId()!;
    await bridge.handleChatInput(ws2, { type: "chat.input", seq: 3, ts: Date.now(), sessionId: sid2, text: "again" });
    await ws2.waitForFrames("chat.done", 1, 3000);
    expect(ws2.framesOfType("chat.done").length).toBeGreaterThanOrEqual(1);

    await bridge.shutdown();
    await store.dispose();
  }, 15_000);

  it("interactive chat is usable after a Codex workflow FAILS", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, cwd: "/tmp", queryFactory: () => chatScript() });

    const submitProxy = new WorkflowSubmitProxy({ logger: noopLogger, sendAck: () => {} });
    // A codex factory whose thread ends WITHOUT ever relaying → producer fails.
    const failingFactory = async (o?: CodexOptions): Promise<Codex> => {
      class T {
        get id(): string | null { return null; }
        async runStreamed(): Promise<RunStreamedResult> {
          async function* events(): AsyncGenerator<ThreadEvent> {
            yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } } as ThreadEvent;
          }
          return { events: events() };
        }
        async run(): Promise<never> { throw new Error("x"); }
      }
      class C { startThread(): Thread { return new T() as unknown as Thread; } resumeThread(): Thread { return this.startThread(); } }
      void o;
      return new C() as unknown as Codex;
    };

    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () =>
        new CodexProducer({
          logger: noopLogger,
          cwd: "/tmp/codex-pool1-fail",
          submitProxy,
          internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
          internalWsToken: "tok",
          nextSubmitId: makeSubmitIdGenerator(2),
          codexFactory: failingFactory,
          timeoutMs: 2_000,
        }),
      selectPhaseSubagent: () =>
        new CodexPhaseSubagent({
          logger: noopLogger,
          cwd: "/tmp/codex-pool1-fail",
          submitProxy,
          internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
          internalWsToken: "tok",
          nextSubmitId: makeSubmitIdGenerator(2),
          codexFactory: failingFactory,
          timeoutMs: 2_000,
        }),
    });

    const wfResult = await rt.startPlan({ text: "x", platform: "codex" }, () => {});
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
  }, 10_000);
});
