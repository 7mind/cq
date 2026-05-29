/**
 * ask-question.test.ts — PR-31-D02: AskUserQuestion via toolAliases + SDK-MCP.
 *
 * Test cases:
 *  1. AskBroker unit: ask/reply round-trip resolves the output correctly.
 *  2. AskBroker unit: rejectAll() rejects a pending promise.
 *  3. AskBroker unit: stale reply (no pending ask) returns false.
 *  4. Bridge.handleChatQuestionReply routes via askBroker (MockQuery-backed).
 *  5. Real-SDK spike: toolAliases + MCP server routes AskUserQuestion to the
 *     in-process handler; broker resolves on chat.question_reply; confirmation
 *     assistant message received.
 *
 * The real-SDK spike (test 5) drives the bundled CLI binary against
 * MockAnthropicHTTP and confirms the end-to-end flow without synthetic
 * SDKUserMessage injection.
 */

import { describe, it, expect } from "bun:test";
import { AskBroker, createAskUserQuestionMcpServer } from "../src/agent/askUserQuestion";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import {
  noopLogger,
  MockWsSocket,
  makeInitMessage,
  type ParsedFrame,
} from "./helpers/mockBridge";

// ---------------------------------------------------------------------------
// MockQuery factory (hangs until resolveHang called; yields init message first)
// ---------------------------------------------------------------------------

type HangingQueryResult = {
  queryFactory: QueryFactory;
  resolveHang: () => void;
};

function makeHangingQueryFactory(): HangingQueryResult {
  let resolveHang!: () => void;

  const queryFactory: QueryFactory = ({ prompt }) => {
    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });

    // Drain the prompt iterable so queue push doesn't deadlock.
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of prompt) { /* discard */ }
    })();

    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangPromise;
    })();

    const obj: Query = Object.assign(gen as unknown as Query, {
      interrupt: async () => { resolveHang(); },
      close: () => { resolveHang(); },
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      applyFlagSettings: async () => {},
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
      reconnectMcpServer: async () => {},
      toggleMcpServer: async () => {},
      seedReadState: async () => {},
      readFile: async () => null,
      getContextUsage: async () => { throw new Error("not implemented"); },
      initializationResult: async () => { throw new Error("not implemented"); },
      reloadPlugins: async () => { throw new Error("not implemented"); },
      accountInfo: async () => { throw new Error("not implemented"); },
      rewindFiles: async () => { throw new Error("not implemented"); },
      setMcpServers: async () => { throw new Error("not implemented"); },
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
    });
    return obj;
  };

  return { queryFactory, resolveHang: () => resolveHang?.() };
}

function makeChatStart(): import("@cq/shared").ChatStart {
  return { type: "chat.start", seq: 0, ts: Date.now() };
}

// ---------------------------------------------------------------------------
// Unit tests: AskBroker
// ---------------------------------------------------------------------------

describe("AskBroker (unit)", () => {
  it("ask/reply round-trip resolves with normalised answers", async () => {
    const broker = new AskBroker();
    const questions = [{ question: "Which option?", header: "Q1", options: ["A", "B"] }];

    const promise = broker.ask("tu-001", questions);

    // Simulate WS reply with string values.
    const replied = broker.reply("tu-001", { "Which option?": "A" });
    expect(replied).toBe(true);

    const output = await promise;
    expect(output.questions).toEqual(questions);
    expect(output.answers).toEqual({ "Which option?": "A" });
  });

  it("multi-select answer (string[]) is comma-joined", async () => {
    const broker = new AskBroker();
    const questions = [{ question: "Which features?", header: "Q2", options: ["X", "Y", "Z"] }];

    const promise = broker.ask("tu-002", questions);
    broker.reply("tu-002", { "Which features?": ["X", "Z"] });

    const output = await promise;
    expect(output.answers["Which features?"]).toBe("X, Z");
  });

  it("free-text custom answer (AskCard 'Other…') passes through unchanged", async () => {
    // The AskCard 'Other…' affordance carries the user's typed text as a plain
    // string in the labels array. It must reach the model byte-identically to
    // the cq-mcp (Codex) broker — both join string[] with ", " and pass strings
    // through. See packages/cq-mcp/test/askBroker.test.ts for the lockstep case.
    const broker = new AskBroker();
    const questions = [{ question: "Editor?", header: "Q3", options: ["Markdown editor"] }];

    const promise = broker.ask("tu-003", questions);
    broker.reply("tu-003", { Editor: ["Markdown editor", "a bespoke WYSIWYG editor"] });

    const output = await promise;
    expect(output.answers["Editor"]).toBe("Markdown editor, a bespoke WYSIWYG editor");
  });

  it("stale reply (no pending ask) returns false", () => {
    const broker = new AskBroker();
    const replied = broker.reply("tu-stale", { "Q?": "A" });
    expect(replied).toBe(false);
  });

  it("rejectAll() rejects the pending promise", async () => {
    const broker = new AskBroker();
    const questions = [{ question: "Foo?", header: "H", options: ["A", "B"] }];

    const promise = broker.ask("tu-003", questions);
    expect(broker.hasPending()).toBe(true);

    broker.rejectAll();
    expect(broker.hasPending()).toBe(false);

    await expect(promise).rejects.toThrow("session ended");
  });

  it("createAskUserQuestionMcpServer returns a McpSdkServerConfigWithInstance", () => {
    const broker = new AskBroker();
    const server = createAskUserQuestionMcpServer(broker);
    // The SDK returns an object with a `type` property and an `instance` property.
    expect(server).toBeDefined();
    expect(typeof server).toBe("object");
    expect("instance" in server).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration test: Bridge.handleChatQuestionReply routes via askBroker
// ---------------------------------------------------------------------------

describe("Bridge.handleChatQuestionReply routes via askBroker (integration)", () => {
  it("reply resolves the broker's pending promise", async () => {
    const { queryFactory } = makeHangingQueryFactory();

    const broker = new AskBroker();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      askBroker: broker,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;
    const invocationId = startedFrame!.invocationId as string;

    // Park an ask on the broker directly (simulates MCP handler calling broker.ask).
    const questions = [{ question: "Pick one?", header: "PQ", options: ["A", "B"] }];
    const answerPromise = broker.ask("tu-bridge-001", questions);

    // Now simulate the WS reply.
    bridge.handleChatQuestionReply(ws, {
      type: "chat.question_reply",
      seq: 1,
      ts: Date.now(),
      sessionId,
      invocationId,
      toolUseId: "tu-bridge-001",
      answers: { "Pick one?": "A" },
    });

    const output = await answerPromise;
    expect(output.answers["Pick one?"]).toBe("A");

    await bridge.shutdown();
  });

  it("stale reply (wrong sessionId) is silently ignored", async () => {
    const { queryFactory } = makeHangingQueryFactory();

    const broker = new AskBroker();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      askBroker: broker,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started");

    // No ask is pending. A stale reply must not throw.
    bridge.handleChatQuestionReply(ws, {
      type: "chat.question_reply",
      seq: 1,
      ts: Date.now(),
      sessionId: "00000000-0000-0000-0000-deadbeef0000",
      invocationId: "00000000-0000-0000-0000-deadbeef0001",
      toolUseId: "tu-stale",
      answers: { "0": ["X"] },
    });

    // No pending promise → reply returns false; broker has nothing pending.
    expect(broker.hasPending()).toBe(false);

    await bridge.shutdown();
  });

  it("Bridge.handleChatQuestionReply (correct session, no pending ask) is a no-op", async () => {
    const { queryFactory } = makeHangingQueryFactory();

    const broker = new AskBroker();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      askBroker: broker,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;
    const invocationId = startedFrame!.invocationId as string;

    // No ask pending — should not throw.
    bridge.handleChatQuestionReply(ws, {
      type: "chat.question_reply",
      seq: 1,
      ts: Date.now(),
      sessionId,
      invocationId,
      toolUseId: "tu-no-pending",
      answers: { "0": ["X"] },
    });

    expect(broker.hasPending()).toBe(false);

    await bridge.shutdown();
  });
});

// ---------------------------------------------------------------------------
// toolAliases + MCP spike — AskUserQuestion via REAL SDK subprocess (PR-31-D02)
//
// This test drives the REAL SDK subprocess (no MockQuery / queryFactory) against
// MockAnthropicHTTP. The mock is scripted to:
//   1. First /v1/messages (small preflight call on startup): return simple text.
//   2. Second /v1/messages (main user prompt, body >= 5 kB): return an assistant
//      message containing an AskUserQuestion tool_use.
//   3. Third+ /v1/messages (after tool_result from MCP handler): return a
//      confirmation assistant message whose text includes "Option B".
//
// The test then:
//   a. Waits for the bridge to surface the AskUserQuestion tool_use in a chat.event.
//   b. Calls bridge.handleChatQuestionReply() to resolve the broker promise.
//   c. The MCP handler returns CallToolResult; the SDK sends the tool_result in
//      the next API call.
//   d. Asserts a subsequent chat.event carries an assistant message with "Option B".
//   e. Verifies chat.done reason=completed.
//
// Compared to Candidate-A (PR-31-D01): no synthetic SDKUserMessage is pushed
// onto the queue; the broker Promise resolves the MCP handler natively.
// ---------------------------------------------------------------------------

import * as fsNode from "node:fs/promises";
import * as osNode from "node:os";
import * as pathNode from "node:path";
import {
  startMockAnthropic,
  ASK_USER_QUESTION_SSE_EVENTS,
  ASK_USER_QUESTION_CONFIRM_SSE_EVENTS,
  ASK_USER_QUESTION_TOOL_USE_ID,
} from "./helpers/MockAnthropicHTTP";

class RealSdkMockWsSocket implements WsSocket {
  readonly sent: ParsedFrame[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ParsedFrame);
  }

  close(): void {}

  framesOfType(type: string): ParsedFrame[] {
    return this.sent.filter((f) => f.type === type);
  }

  async waitForFrames(type: string, count = 1, timeoutMs = 25000): Promise<ParsedFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frames = this.framesOfType(type);
      if (frames.length >= count) return frames;
      await Bun.sleep(50);
    }
    throw new Error(
      `Timed out waiting for ${count} frame(s) of type '${type}'; got ${this.framesOfType(type).length}; ` +
      `all seen: ${[...new Set(this.sent.map(f => f.type))].join(", ")}`,
    );
  }
}

describe("toolAliases + SDK-MCP spike — AskUserQuestion via REAL SDK subprocess (PR-31-D02)", () => {
  it(
    "real subprocess: AskUserQuestion tool_use → MCP handler → broker.reply → confirmation assistant message",
    async () => {
      const tmpHome = await fsNode.mkdtemp(pathNode.join(osNode.tmpdir(), "cq-ask-mcp-"));
      await fsNode.mkdir(pathNode.join(tmpHome, ".claude"), { recursive: true });

      let mock: import("./helpers/MockAnthropicHTTP").MockAnthropicHTTP | null = null;

      try {
        let askSent = false;
        const simpleSseBody = (() => {
          const simpleEvents = [
            {
              event: "message_start",
              data: { type: "message_start", message: { id: "msg_simple", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
            },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } } },
            { event: "message_stop", data: { type: "message_stop" } },
          ] as import("./helpers/MockAnthropicHTTP").SSEEvent[];
          return simpleEvents
            .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
            .join("");
        })();

        mock = await startMockAnthropic({
          scriptedResponder: async (body: string) => {
            const hasToolResult = body.includes("tool_result");
            if (hasToolResult) {
              // After MCP handler returns: tool_result in conversation → confirmation.
              return ASK_USER_QUESTION_CONFIRM_SSE_EVENTS;
            }
            if (!askSent && body.length >= 5000) {
              // Main prompt: return AskUserQuestion tool_use.
              askSent = true;
              return ASK_USER_QUESTION_SSE_EVENTS;
            }
            // Preflight / small requests: return simple text.
            return new Response(simpleSseBody, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          },
        });

        process.env["ANTHROPIC_BASE_URL"] = mock.url;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
        process.env["HOME"] = tmpHome;

        // Bridge with NO queryFactory — real SDK subprocess.
        // The bridge creates a fresh AskBroker and wires it via toolAliases.
        const registry = new SessionRegistry();
        const bridge = new Bridge({
          logger: noopLogger,
          registry,
          cwd: tmpHome,
          home: tmpHome,
        });

        const ws = new RealSdkMockWsSocket();
        await bridge.handleChatStart(ws, { type: "chat.start", seq: 0, ts: Date.now() });

        const sessionId = bridge.activeSessionId()!;

        await bridge.handleChatInput(ws, {
          type: "chat.input",
          seq: 1,
          ts: Date.now(),
          sessionId,
          text: "ask me something",
        });

        // Wait for chat.started.
        const [startedFrame] = await ws.waitForFrames("chat.started", 1, 25000);
        expect(startedFrame!.type).toBe("chat.started");
        const invocationId = startedFrame!.invocationId as string;

        // Wait for the AskUserQuestion tool_use to surface as a chat.event.
        let toolUseId: string | null = null;
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const events = ws.framesOfType("chat.event");
          for (const evt of events) {
            const sdkEvt = evt.sdkEvent as Record<string, unknown>;
            if (sdkEvt.type === "assistant") {
              const msg = sdkEvt.message as { content?: Array<{ type: string; name?: string; id?: string }> };
              const toolUse = (msg.content ?? []).find(
                (c) => c.type === "tool_use" && c.name === "AskUserQuestion",
              );
              if (toolUse) {
                toolUseId = toolUse.id ?? ASK_USER_QUESTION_TOOL_USE_ID;
                break;
              }
            }
          }
          if (toolUseId !== null) break;
          await Bun.sleep(50);
        }

        expect(toolUseId).not.toBeNull();
        expect(typeof toolUseId).toBe("string");

        // Verify toolAliases and mcpServers are reflected in the SDK options.
        // The bridge always sets toolAliases.AskUserQuestion = 'mcp__cq__ask_user_question'
        // and mcpServers.cq = the in-process MCP server.
        // We confirm by verifying the broker exists on the bridge.
        expect(bridge.askBroker).toBeInstanceOf(AskBroker);

        // Resolve the broker: simulate the user answering the question via WS.
        bridge.handleChatQuestionReply(ws, {
          type: "chat.question_reply",
          seq: 2,
          ts: Date.now(),
          sessionId,
          invocationId,
          toolUseId: toolUseId!,
          answers: { "Which option do you prefer?": "Option B" },
        });

        // Wait for a subsequent chat.event with an assistant message containing "Option B".
        const confirmDeadline = Date.now() + 25000;
        let confirmed = false;
        while (Date.now() < confirmDeadline) {
          const events = ws.framesOfType("chat.event");
          for (const evt of events) {
            const sdkEvt = evt.sdkEvent as Record<string, unknown>;
            if (sdkEvt.type === "assistant") {
              const msg = sdkEvt.message as { content?: Array<{ type: string; text?: string }> };
              const textBlock = (msg.content ?? []).find((c) => c.type === "text");
              if (textBlock?.text?.includes("Option B")) {
                confirmed = true;
                break;
              }
            }
          }
          if (confirmed) break;
          await Bun.sleep(50);
        }

        expect(confirmed).toBe(true);

        // At least 2 API requests: one for the AskUserQuestion, one for the confirmation.
        expect(mock.requestCount()).toBeGreaterThanOrEqual(2);

        await bridge.shutdown();

        const [doneFrame] = await ws.waitForFrames("chat.done", 1, 5000);
        expect(doneFrame!.reason).toBe("completed");
      } finally {
        await mock?.stop();
        await fsNode.rm(tmpHome, { recursive: true, force: true });
      }
    },
    35000, // generous timeout: subprocess + multi-round MCP interaction
  );
});
