/**
 * interrupt.test.ts — Bridge interrupt path tests for PR-24.
 *
 * Tests:
 *  1. Interrupt mid-stream: yields 10 partial messages; interrupt fires at #3;
 *     chat.done reason=interrupted arrives within 500ms; no chat.event frames
 *     arrive after the interrupt is sent.
 *  2. Interrupt before any events: interrupt called immediately after chat.started;
 *     chat.done reason=interrupted; no chat.event frames at all.
 */

import { describe, it, expect } from "bun:test";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import type { Logger } from "../src/log/logger";

// ---------------------------------------------------------------------------
// Noop logger
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// MockWsSocket
// ---------------------------------------------------------------------------

interface ParsedFrame {
  type: string;
  [key: string]: unknown;
}

class MockWsSocket implements WsSocket {
  readonly sent: ParsedFrame[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ParsedFrame);
  }

  close(): void {}

  framesOfType(type: string): ParsedFrame[] {
    return this.sent.filter((f) => f.type === type);
  }

  /** Wait until at least `count` frames of `type` have been received. */
  async waitForFrames(type: string, count = 1, timeoutMs = 3000): Promise<ParsedFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frames = this.framesOfType(type);
      if (frames.length >= count) return frames;
      await Bun.sleep(10);
    }
    throw new Error(
      `Timed out waiting for ${count} frame(s) of type '${type}'; got ${this.framesOfType(type).length}`,
    );
  }

  /** Snapshot the count of chat.event frames received so far. */
  eventCount(): number {
    return this.framesOfType("chat.event").length;
  }
}

// ---------------------------------------------------------------------------
// MockQuery helpers
// ---------------------------------------------------------------------------

type MockQuery = Query & { interruptCalled: boolean };

function patchStubs(obj: object): void {
  const stubs: Record<string, unknown> = {
    mcpServerStatus: async () => [],
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
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
  };
  for (const [k, v] of Object.entries(stubs)) {
    (obj as Record<string, unknown>)[k] = v;
  }
}

function makeInitMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    agents: [],
    apiKeySource: "user",
    betas: [],
    claude_code_version: "0.0.0-test",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-test",
    permissionMode: "default",
    slash_commands: [],
    output_style: "text",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-a000-000000000001",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as SDKMessage;
}

function makeAssistantMessage(n: number): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: `msg_test_${n}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `message ${n}` }],
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-a000-00000000000${n}`,
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

function makeBridge(queryFactory: QueryFactory): { bridge: Bridge; ws: MockWsSocket } {
  const registry = new SessionRegistry();
  const bridge = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory,
    cwd: "/tmp/test",
  });
  return { bridge, ws: new MockWsSocket() };
}

function makeChatStart(): import("@cq/shared").ChatStart {
  return { type: "chat.start", seq: 0, ts: Date.now() };
}

function makeChatInterrupt(sessionId: string): import("@cq/shared").ChatInterrupt {
  return { type: "chat.interrupt", seq: 1, ts: Date.now(), sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bridge interrupt path", () => {
  // --------------------------------------------------------------------------
  // Test 1: interrupt mid-stream at message #3 → no later events, done=interrupted
  // --------------------------------------------------------------------------
  it("interrupt at message #3 stops further events and emits chat.done reason=interrupted", async () => {
    const TOTAL = 10;
    const INTERRUPT_AT = 3; // fire interrupt after this many assistant events received

    // The generator yields init, then 10 assistant messages with a 30ms delay between each.
    // The test fires an interrupt after message #INTERRUPT_AT arrives.
    let resolveInterrupt!: () => void;
    const interruptGate = new Promise<void>((r) => { resolveInterrupt = r; });

    let interruptCalled = false;

    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      for (let i = 1; i <= TOTAL; i++) {
        await Bun.sleep(30);
        yield makeAssistantMessage(i);
      }
    })();

    const mockQuery = asyncGen as unknown as MockQuery;
    patchStubs(mockQuery);
    mockQuery.interruptCalled = false;
    mockQuery.interrupt = async () => {
      interruptCalled = true;
      mockQuery.interruptCalled = true;
      // Signal that interrupt was received, but the generator will drain naturally.
      resolveInterrupt();
    };
    mockQuery.close = () => {};

    const queryFactory: QueryFactory = () => mockQuery as unknown as Query;
    const { bridge, ws } = makeBridge(queryFactory);

    await bridge.handleChatStart(ws, makeChatStart());

    // Wait for chat.started to know the sessionId.
    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;

    // Wait until INTERRUPT_AT events have arrived, then interrupt.
    await ws.waitForFrames("chat.event", INTERRUPT_AT, 5000);
    const eventCountAtInterrupt = ws.eventCount();

    await bridge.handleChatInterrupt(ws, makeChatInterrupt(sessionId));
    await interruptGate;

    // Wait for chat.done within 500ms.
    const dones = await ws.waitForFrames("chat.done", 1, 500);
    expect(dones[0]!.reason).toBe("interrupted");

    // Confirm interrupt() was called.
    expect(interruptCalled).toBe(true);

    // No chat.event frames should have arrived after the interrupt was processed.
    // (We allow up to eventCountAtInterrupt + 1 because one frame may have been
    // in-flight when the flag was set, but no further ones should arrive.)
    const finalEventCount = ws.eventCount();
    expect(finalEventCount).toBeLessThanOrEqual(eventCountAtInterrupt + 1);
    expect(finalEventCount).toBeLessThan(TOTAL);
  });

  // --------------------------------------------------------------------------
  // Test 2: interrupt immediately after chat.started → no events, done=interrupted
  // --------------------------------------------------------------------------
  it("interrupt before any events emits chat.done reason=interrupted with zero chat.event frames", async () => {
    // Generator yields init, then hangs until interrupt() is called, then ends.
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((r) => { resolveHang = r; });

    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangPromise;
      // After interrupt, yield one message — should be discarded by aborting flag.
      yield makeAssistantMessage(1);
    })();

    const mockQuery = asyncGen as unknown as MockQuery;
    patchStubs(mockQuery);
    mockQuery.interruptCalled = false;
    mockQuery.interrupt = async () => {
      mockQuery.interruptCalled = true;
      resolveHang();
    };
    mockQuery.close = () => { resolveHang(); };

    const queryFactory: QueryFactory = () => mockQuery as unknown as Query;
    const { bridge, ws } = makeBridge(queryFactory);

    await bridge.handleChatStart(ws, makeChatStart());

    // Wait for chat.started.
    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;

    // No events should have arrived yet.
    expect(ws.eventCount()).toBe(0);

    // Send interrupt immediately.
    const t0 = Date.now();
    await bridge.handleChatInterrupt(ws, makeChatInterrupt(sessionId));

    // chat.done should arrive within 500ms.
    const dones = await ws.waitForFrames("chat.done", 1, 500);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(dones[0]!.reason).toBe("interrupted");

    // Zero chat.event frames ever sent (the one yielded after resolveHang is
    // discarded because session.aborting is true).
    expect(ws.eventCount()).toBe(0);
  });
});
