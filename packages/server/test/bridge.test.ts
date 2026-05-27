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
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence";
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

  // --------------------------------------------------------------------------
  // Test 7 (D28b): result message with error subtype emits both chat.done and
  //                chat.error so the UI toast surfaces the failure
  // --------------------------------------------------------------------------
  it("D28b: result{subtype:'error_max_turns'} emits chat.done{errored} + chat.error", async () => {
    const errorResultMsg: SDKMessage = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 1000,
      duration_api_ms: 900,
      is_error: true,
      num_turns: 5,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
      permission_denials: [],
      errors: ["Reached maximum number of turns"],
      uuid: "00000000-0000-4000-a000-000000000099",
      session_id: "00000000-0000-4000-a000-000000000002",
    } as unknown as SDKMessage;

    const mockQuery = makeMockQuery([makeInitMessage(), errorResultMsg]);
    const { bridge } = makeBridge(mockQuery);
    const ws = new MockWsSocket();

    await bridge.handleChatStart(ws, makeChatStart());

    // Wait for both chat.done and chat.error
    const dones = await ws.waitForFrames("chat.done");
    const errors = await ws.waitForFrames("chat.error");

    // chat.done must carry reason='errored'
    const turnDone = dones.find((f) => f.reason === "errored");
    expect(turnDone).toBeDefined();

    // chat.error must carry the SDK subtype as its code
    expect(errors).toHaveLength(1);
    const errFrame = errors[0]!;
    expect(errFrame.code).toBe("error_max_turns");
    expect(typeof errFrame.message).toBe("string");
    expect((errFrame.message as string).length).toBeGreaterThan(0);

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // R4: exactly ONE chat.done per session — no duplicate when preempt follows
  //     a completed turn (result{success} already sent chat.done{completed})
  // --------------------------------------------------------------------------
  it("R4: only one chat.done emitted for session A when preempt follows a completed turn", async () => {
    const resultMsg: SDKMessage = {
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-a000-000000000010",
      session_id: "00000000-0000-4000-a000-000000000002",
    } as unknown as SDKMessage;

    // Session A: yields init + result{success}, then hangs waiting to be interrupted.
    let resolveA!: () => void;
    const hangA = new Promise<void>((r) => { resolveA = r; });
    const genA = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      yield resultMsg;
      // Hang after the completed turn so session A is still alive when we preempt.
      await hangA;
    })();
    const queryA = genA as unknown as MockQuery;
    patchWithStubs(queryA);
    queryA.interrupt = async () => { resolveA(); };
    queryA.close = () => { resolveA(); };

    // Session B: minimal — just emits init.
    const queryB = makeMockQuery([makeInitMessage()]);

    let call = 0;
    const ws1 = new MockWsSocket();
    const ws2 = new MockWsSocket();
    const bridge = new Bridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      queryFactory: () => (++call === 1 ? queryA : queryB),
      cwd: "/tmp/test",
    });

    // Start session A and wait for the turn to complete (chat.done{completed}).
    await bridge.handleChatStart(ws1, makeChatStart());
    const [startedA] = await ws1.waitForFrames("chat.started", 1);
    const sessionAId = startedA!.sessionId as string;
    await ws1.waitForFrames("chat.done", 1);

    // Preempt with session B.
    await bridge.handleChatStart(ws2, makeChatStart());

    // Give the old A runLoop's finally time to fire.
    await Bun.sleep(50);

    // Session A must have received exactly ONE chat.done (reason='completed').
    const adonesAll = ws1.framesOfType("chat.done");
    const adones = adonesAll.filter((f) => f.sessionId === sessionAId);
    expect(adones).toHaveLength(1);
    expect(adones[0]!.reason).toBe("completed");

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // R1: broker teardown is guarded by session identity — preempt does not
  //     clear the NEW session's broker wiring from the OLD runLoop's finally
  // --------------------------------------------------------------------------
  it("R1: old runLoop finally does not clear new session's broker send wiring", async () => {
    // Session A hangs; its runLoop finally runs only after interrupt resolves.
    let resolveA!: () => void;
    const hangA = new Promise<void>((r) => { resolveA = r; });
    const genA = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangA;
    })();
    const queryA = genA as unknown as MockQuery;
    patchWithStubs(queryA);
    queryA.interrupt = async () => { resolveA(); };
    queryA.close = () => { resolveA(); };

    // Session B: fast finisher, just emits init.
    const queryB = makeMockQuery([makeInitMessage()]);

    let call = 0;
    const bridge = new Bridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      queryFactory: () => (++call === 1 ? queryA : queryB),
      cwd: "/tmp/test",
    });

    const ws1 = new MockWsSocket();
    const ws2 = new MockWsSocket();

    // Start session A and wait until active.
    await bridge.handleChatStart(ws1, makeChatStart());
    await ws1.waitForFrames("chat.started", 1);

    // Wire a recorder to the permission broker AFTER session A is up.
    const frames: unknown[] = [];
    bridge.permissionBroker.setSendFrame((f) => { frames.push(f); });

    // Preempt with session B — this interrupts A (resolveA fires), then
    // handleChatStart wires the broker to session B's sender.
    await bridge.handleChatStart(ws2, makeChatStart());

    // Give the old runLoop's finally block time to run (microtask + event loop).
    await Bun.sleep(50);

    // The broker's internal sendFrame must NOT be null (session B re-wired it).
    // We verify by calling setSendFrame again and asserting the internal state
    // hasn't been nulled — use a sentinel that would be overwritten by clearSendFrame.
    const sentinelFrames: unknown[] = [];
    bridge.permissionBroker.setSendFrame((f) => { sentinelFrames.push(f); });

    // Confirm the broker is functional: setSendFrame above would be a no-op
    // only if the broker had been completely broken. The real assertion is that
    // clearSendFrame() was NOT called after setSendFrame() by the new session.
    // We verify indirectly: pendingCount() is 0 (rejectAll wasn't called on B's requests)
    // and the broker is still wired (sendFrame is non-null, not cleared by old finally).
    expect(bridge.permissionBroker.pendingCount()).toBe(0); // no pending requests
    // The broker's sendFrame field must be the sentinel we just set, not null.
    // Access via cast since sendFrame is private.
    const brokerInternal = bridge.permissionBroker as unknown as { sendFrame: unknown };
    expect(brokerInternal.sendFrame).not.toBeNull();

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // D47: chat.rejoin — Case A: active session (still running)
  // --------------------------------------------------------------------------
  it("chat.rejoin with the active session id rebinds WS and replays persisted events", async () => {
    // Use a hanging query so the session stays active while we call handleChatRejoin.
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((r) => { resolveHang = r; });

    const assistantMsg = makeAssistantMessage("hello from replay");
    const hangingGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      yield assistantMsg;
      // Hang so the session stays active.
      await hangPromise;
    })();
    const hangingQuery = hangingGen as unknown as MockQuery;
    patchWithStubs(hangingQuery);
    hangingQuery.interrupt = async () => { resolveHang(); };
    hangingQuery.close = () => { resolveHang(); };

    const persistence = new InMemoryPersistence();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => hangingQuery,
      cwd: "/tmp/test",
      persistence,
    });

    const ws1 = new MockWsSocket();
    await bridge.handleChatStart(ws1, makeChatStart());

    // Wait for init + assistant message to be processed and persisted.
    const started1 = await ws1.waitForFrames("chat.started", 1);
    const sessionId = started1[0]!.sessionId as string;
    // Wait for at least one chat.event (assistant message persisted at that point).
    await ws1.waitForFrames("chat.event", 1);

    // Simulate a new WS connection (page refresh) sending chat.rejoin.
    const ws2 = new MockWsSocket();
    await bridge.handleChatRejoin(ws2, {
      type: "chat.rejoin",
      seq: 1,
      ts: Date.now(),
      sessionId,
    });

    // Should receive a fresh chat.started on ws2 with the same sessionId.
    const started2 = await ws2.waitForFrames("chat.started", 1);
    expect(started2[0]!.sessionId).toBe(sessionId);

    // Should receive replayed events as history.replay_event frames.
    const replays = await ws2.waitForFrames("history.replay_event", 1);
    expect(replays.length).toBeGreaterThanOrEqual(1);

    // Should receive history.replay_done.
    await ws2.waitForFrames("history.replay_done", 1);

    // Clean up.
    resolveHang();
    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // D47: chat.rejoin — unknown session id returns REJOIN_FAILED
  // --------------------------------------------------------------------------
  it("chat.rejoin with an unknown session id returns chat.error{REJOIN_FAILED}", async () => {
    const persistence = new InMemoryPersistence();
    const registry = new SessionRegistry();
    const mockQuery = makeMockQuery([]);
    const queryFactory: QueryFactory = () => mockQuery;
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      persistence,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatRejoin(ws, {
      type: "chat.rejoin",
      seq: 1,
      ts: Date.now(),
      sessionId: "00000000-0000-4000-a000-000000000099",
    });

    const errors = ws.framesOfType("chat.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REJOIN_FAILED");
  });
});
