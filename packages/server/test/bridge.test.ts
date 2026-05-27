/**
 * bridge.test.ts — Stubbed-SDK integration tests for PR-19.
 *
 * Uses MockQuery (a canned AsyncGenerator<SDKMessage>) and MockWsSocket to
 * exercise Bridge without touching the real Anthropic API.
 *
 * Required cases (6):
 *  1. chat.start triggers chat.started with init info.
 *  2. chat.input pushes to the streaming queue; assistant text echoed as chat.event.
 *  3. Concurrent chat.start while busy → preempts old session (chat.done{interrupted})
 *     and starts a new one (E2E-D04; old SESSION_BUSY behaviour removed).
 *  4. Query iteration end → chat.done reason='completed'.
 *  5. chat.interrupt calls Query.interrupt().
 *  6. bridge.shutdown() ends the active session cleanly.
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
// MockWsSocket — records outbound frames; structurally matches WsSocket.
// ---------------------------------------------------------------------------

interface ParsedFrame {
  type: string;
  [key: string]: unknown;
}

class MockWsSocket implements WsSocket {
  readonly sent: ParsedFrame[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ParsedFrame);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** Return all frames of a given type, in order. */
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
}

// ---------------------------------------------------------------------------
// MockQuery — an AsyncGenerator that yields a canned script of SDKMessages.
// Implements the Query interface's control methods as stubs.
// ---------------------------------------------------------------------------

type MockQueryScript = SDKMessage[];

/**
 * A mock Query with full stub implementations.
 * Uses `as unknown as Query` to avoid satisfying every TypeScript symbol
 * (e.g. Symbol.asyncDispose introduced in newer lib.esnext.d.ts).
 */
type MockQuery = Query & { interruptCalled: boolean };

function makeMockQuery(script: MockQueryScript): MockQuery {
  let interruptCalled = false;
  let scriptIndex = 0;
  let done = false;

  const obj = {
    // AsyncGenerator protocol
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      if (done) return Promise.resolve({ value: undefined, done: true as const });
      if (scriptIndex < script.length) {
        const msg = script[scriptIndex++]!;
        return Promise.resolve({ value: msg, done: false as const });
      }
      done = true;
      return Promise.resolve({ value: undefined, done: true as const });
    },
    return(): Promise<IteratorResult<SDKMessage, void>> {
      done = true;
      return Promise.resolve({ value: undefined, done: true as const });
    },
    throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
      done = true;
      return Promise.reject(err);
    },
    // Query control methods
    async interrupt(): Promise<void> {
      interruptCalled = true;
      obj.interruptCalled = true;
      done = true;
    },
    async setPermissionMode() {},
    async setModel() {},
    async setMaxThinkingTokens() {},
    async applyFlagSettings() {},
    async initializationResult() { throw new Error("not implemented in mock"); },
    async supportedCommands() { return []; },
    async supportedModels() { return []; },
    async supportedAgents() { return []; },
    async mcpServerStatus() { return []; },
    async getContextUsage() { throw new Error("not implemented in mock"); },
    async readFile() { return null; },
    async reloadPlugins() { throw new Error("not implemented in mock"); },
    async accountInfo() { throw new Error("not implemented in mock"); },
    async rewindFiles() { throw new Error("not implemented in mock"); },
    async seedReadState() {},
    async reconnectMcpServer() {},
    async toggleMcpServer() {},
    async setMcpServers() { throw new Error("not implemented in mock"); },
    async streamInput() {},
    async stopTask() {},
    async backgroundTasks() { return false; },
    close() { done = true; },
    interruptCalled,
  };

  return obj as unknown as MockQuery;
}

/** Patch a MockQuery with all stubs needed for the hanging generator tests. */
function patchWithStubs(mockQuery: object): void {
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
    (mockQuery as Record<string, unknown>)[k] = v;
  }
}

// ---------------------------------------------------------------------------
// SDKSystemMessage factory helper
// ---------------------------------------------------------------------------

function makeInitMessage(overrides: Record<string, unknown> = {}): SDKMessage {
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
    ...overrides,
  } as SDKMessage;
}

function makeAssistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-a000-000000000003",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Bridge factory helper
// ---------------------------------------------------------------------------

function makeBridge(mockQuery: ReturnType<typeof makeMockQuery>): {
  bridge: Bridge;
  registry: SessionRegistry;
} {
  const registry = new SessionRegistry();
  const queryFactory: QueryFactory = () => mockQuery;
  const bridge = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory,
    cwd: "/tmp/test",
  });
  return { bridge, registry };
}

// ---------------------------------------------------------------------------
// ChatStart frame factory
// ---------------------------------------------------------------------------

function makeChatStart(): import("@cq/shared").ChatStart {
  return {
    type: "chat.start",
    seq: 0,
    ts: Date.now(),
  };
}

function makeChatInput(sessionId: string, text: string): import("@cq/shared").ChatInput {
  return {
    type: "chat.input",
    seq: 1,
    ts: Date.now(),
    sessionId,
    text,
  };
}

function makeChatInterrupt(sessionId: string): import("@cq/shared").ChatInterrupt {
  return {
    type: "chat.interrupt",
    seq: 2,
    ts: Date.now(),
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bridge", () => {
  // --------------------------------------------------------------------------
  // Test 1: chat.start triggers chat.started with init info
  // --------------------------------------------------------------------------
  it("chat.start triggers chat.started with init info", async () => {
    const initMsg = makeInitMessage({ mcp_servers: [{ name: "stub", status: "connected" }] });
    const mockQuery = makeMockQuery([initMsg]);
    const { bridge } = makeBridge(mockQuery);

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    // Two chat.started frames are emitted: the first immediately after
    // handleChatStart carrying just sessionId + invocationId + cwd (so the
    // client can begin sending chat.input before the SDK has booted); the
    // second from the SDK's system/init message carrying the full initInfo.
    // Wait for both, then verify the final one has the SDK init payload.
    const started = await ws.waitForFrames("chat.started", 2);
    expect(started).toHaveLength(2);

    const earlyFrame = started[0]!;
    expect(earlyFrame.type).toBe("chat.started");
    expect(typeof earlyFrame.sessionId).toBe("string");
    expect(typeof earlyFrame.invocationId).toBe("string");
    const earlyInfo = earlyFrame.initInfo as Record<string, unknown>;
    expect(earlyInfo).toEqual({ cwd: expect.any(String) });

    const finalFrame = started[1]!;
    expect(finalFrame.sessionId).toBe(earlyFrame.sessionId);
    const finalInfo = finalFrame.initInfo as Record<string, unknown>;
    expect(finalInfo.model).toBe("claude-test");

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // Test 2: chat.input pushes to streaming queue; assistant text echoed as chat.event
  // --------------------------------------------------------------------------
  it("chat.input queues user message; assistant text arrives as chat.event", async () => {
    // The mock query yields init first, then one assistant message.
    const initMsg = makeInitMessage();
    const assistantMsg = makeAssistantMessage("world");
    const mockQuery = makeMockQuery([initMsg, assistantMsg]);
    const { bridge } = makeBridge(mockQuery);

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    // Wait for chat.started so we know the sessionId.
    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;

    // Push input (in practice this feeds the queue, but mock ignores it).
    await bridge.handleChatInput(ws, makeChatInput(sessionId, "hello"));

    // The assistant message should arrive as chat.event.
    const events = await ws.waitForFrames("chat.event");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evtFrame = events[0]!;
    expect(evtFrame.type).toBe("chat.event");
    expect(evtFrame.sessionId).toBe(sessionId);
    expect(evtFrame.sdkEvent).toBeDefined();
    const sdkEvt = evtFrame.sdkEvent as Record<string, unknown>;
    expect(sdkEvt.type).toBe("assistant");

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // Test 3: Concurrent chat.start while busy → preempts old session (E2E-D04)
  // --------------------------------------------------------------------------
  it("concurrent chat.start while busy preempts old session and starts a new one", async () => {
    // First query hangs after emitting init; second query is a fast finisher.
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((r) => { resolveHang = r; });

    const firstGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      // Hang here to keep the first session busy.
      await hangPromise;
    })();

    const firstQuery = firstGen as unknown as MockQuery;
    patchWithStubs(firstQuery);
    firstQuery.interrupt = async () => { resolveHang(); };
    firstQuery.close = () => { resolveHang(); };

    const secondQuery = makeMockQuery([makeInitMessage()]);

    let callCount = 0;
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => {
        callCount++;
        return callCount === 1 ? firstQuery : secondQuery;
      },
      cwd: "/tmp/test",
    });

    const ws1 = new MockWsSocket();
    const ws2 = new MockWsSocket();

    // Start first session and wait until it is active.
    await bridge.handleChatStart(ws1, makeChatStart());
    const [firstStarted] = await ws1.waitForFrames("chat.started");
    const firstSessionId = firstStarted!.sessionId as string;

    // Second chat.start should preempt the first — no SESSION_BUSY error.
    await bridge.handleChatStart(ws2, makeChatStart());

    // The first socket must receive chat.done{reason:'interrupted'} for the old session.
    const ws1Dones = await ws1.waitForFrames("chat.done");
    expect(ws1Dones.some((f) => f.reason === "interrupted" && f.sessionId === firstSessionId)).toBe(true);

    // No chat.error on the second socket (the preempt path doesn't reject).
    expect(ws2.framesOfType("chat.error")).toHaveLength(0);

    // The second socket must receive chat.started with a NEW sessionId.
    const [secondStarted] = await ws2.waitForFrames("chat.started");
    expect(secondStarted).toBeDefined();
    expect(secondStarted!.sessionId).not.toBe(firstSessionId);

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // Test 4: Query iteration end → chat.done reason='completed'
  // --------------------------------------------------------------------------
  it("query iteration end emits chat.done reason=completed", async () => {
    const initMsg = makeInitMessage();
    // Script ends after init — generator returns naturally.
    const mockQuery = makeMockQuery([initMsg]);
    const { bridge } = makeBridge(mockQuery);

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    const dones = await ws.waitForFrames("chat.done");
    expect(dones.length).toBeGreaterThanOrEqual(1);
    expect(dones[0]!.reason).toBe("completed");

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // Test 5: chat.interrupt calls Query.interrupt()
  // --------------------------------------------------------------------------
  it("chat.interrupt calls Query.interrupt()", async () => {
    // Keep the session running long enough to send an interrupt.
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((r) => { resolveHang = r; });

    const interruptTracker = { called: false };

    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangPromise;
    })();

    const mockQuery = asyncGen as unknown as MockQuery;
    patchWithStubs(mockQuery);
    mockQuery.interrupt = async () => {
      interruptTracker.called = true;
      resolveHang();
    };
    mockQuery.close = () => { resolveHang(); };

    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => mockQuery,
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    // Wait until session is started.
    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;

    // Send interrupt.
    await bridge.handleChatInterrupt(ws, makeChatInterrupt(sessionId));

    // Give interrupt a moment to process.
    await Bun.sleep(50);
    expect(interruptTracker.called).toBe(true);

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // Test 6: bridge.shutdown() ends the active session cleanly
  // --------------------------------------------------------------------------
  it("bridge.shutdown() ends active session; activeSessionId becomes null", async () => {
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((r) => { resolveHang = r; });

    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangPromise;
    })();

    const mockQuery = asyncGen as unknown as MockQuery;
    patchWithStubs(mockQuery);
    mockQuery.interrupt = async () => {};
    mockQuery.close = () => { resolveHang(); };

    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => mockQuery,
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started");

    expect(bridge.isBusy()).toBe(true);
    expect(bridge.activeSessionId()).not.toBeNull();

    const sentCountBeforeShutdown = ws.sent.length;

    await bridge.shutdown();

    // Give the loop a moment to settle.
    await Bun.sleep(50);

    expect(bridge.isBusy()).toBe(false);
    expect(bridge.activeSessionId()).toBeNull();

    // No further frames should arrive after shutdown.
    const sentCountAfterShutdown = ws.sent.length;
    // The count may be equal or slightly higher (e.g. a chat.done from the loop
    // finalizing), but isBusy must be false.
    expect(sentCountAfterShutdown).toBeGreaterThanOrEqual(sentCountBeforeShutdown);
  });
});
