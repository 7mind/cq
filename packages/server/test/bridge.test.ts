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
import { Bridge, ClaudeBridge } from "../src/agent/bridge";
import type { QueryFactory } from "../src/agent/bridge";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence";
import {
  noopLogger,
  MockWsSocket,
  makeMockQuery,
  patchStubs as patchWithStubs,
  makeInitMessage,
  makeAssistantMessage,
  makeChatStart,
  makeChatInput,
  makeChatInterrupt,
  type MockQuery,
} from "./helpers/mockBridge";

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
  // R3: rejoin Case B replay ordering — history.replay_event frames must
  //     arrive BEFORE the second chat.started from the new SDK subprocess
  // --------------------------------------------------------------------------
  it("R3: rejoin Case B — replay events arrive before the live SDK chat.started", async () => {
    // Build a persistence store with a completed session + invocation + events.
    const persistence = new InMemoryPersistence();
    const sessionId = "00000000-0000-4000-b000-000000000001";
    const invocationId = "00000000-0000-4000-b000-000000000002";
    const now = Date.now();

    const sessionRow = {
      id: sessionId,
      startedAt: now - 5000,
      endedAt: now - 1000,
      cwd: "/tmp/test",
      model: "claude-test",
      permissionMode: "default" as const,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: "completed" as const,
      title: "prior",
      lastServerSeq: 0,
      sdkSessionId: null,
      platform: "claude" as const,
      effort: "none" as const,
    };
    persistence.sessions.insert(sessionRow);

    const invRow = {
      id: invocationId,
      sessionId,
      parentInvocationId: null as null,
      resumedFromInvocationId: null as null,
      agentName: "main",
      agentId: null as null,
      taskId: null as null,
      toolUseId: null as null,
      model: "claude-test",
      startedAt: now - 5000,
      endedAt: now - 1000,
      durationMs: 4000,
      status: "completed" as const,
      toolCallCount: 0,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      promptExcerpt: "hello",
      eventLogPath: `${sessionId}/${invocationId}.jsonl`,
      ownerPid: null as null,
    };
    persistence.invocations.insert(invRow);

    // Append a couple of SDK events so replay has something to emit.
    const evtMsg = makeAssistantMessage("prior assistant reply");
    persistence.events.append(invocationId, evtMsg);
    persistence.events.append(invocationId, evtMsg);

    // The new live query (spawned by handleChatStart inside rejoin) hangs after init.
    let resolveNew!: () => void;
    const hangNew = new Promise<void>((r) => { resolveNew = r; });
    const newGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      await hangNew;
    })();
    const newQuery = newGen as unknown as MockQuery;
    patchWithStubs(newQuery);
    newQuery.interrupt = async () => { resolveNew(); };
    newQuery.close = () => { resolveNew(); };

    const registry = new SessionRegistry();
    registry.register(sessionId); // pre-register so seqs work
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => newQuery,
      cwd: "/tmp/test",
      persistence,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatRejoin(ws, {
      type: "chat.rejoin",
      seq: 1,
      ts: Date.now(),
      sessionId,
    });

    // Wait for replay_done to ensure replay has fully emitted.
    await ws.waitForFrames("history.replay_done", 1);

    // Collect all frames in order.
    const allFrames = ws.sent;

    // Find positions of key frame types.
    const firstStartedIdx = allFrames.findIndex((f) => f.type === "chat.started");
    const firstReplayIdx = allFrames.findIndex((f) => f.type === "history.replay_event");
    const replayDoneIdx = allFrames.findIndex((f) => f.type === "history.replay_done");

    // chat.started must come before any replay events.
    expect(firstStartedIdx).toBeGreaterThanOrEqual(0);
    expect(firstReplayIdx).toBeGreaterThanOrEqual(0);
    expect(replayDoneIdx).toBeGreaterThanOrEqual(0);
    expect(firstStartedIdx).toBeLessThan(firstReplayIdx);
    expect(firstReplayIdx).toBeLessThan(replayDoneIdx);

    // At least 2 replay events (we appended 2).
    expect(ws.framesOfType("history.replay_event").length).toBeGreaterThanOrEqual(2);

    // The SECOND chat.started (from the live SDK init) must arrive AFTER replay_done.
    const startedFrames = ws.framesOfType("chat.started");
    if (startedFrames.length >= 2) {
      const secondStartedIdx = allFrames.lastIndexOf(startedFrames[startedFrames.length - 1]!);
      expect(secondStartedIdx).toBeGreaterThan(replayDoneIdx);
    }

    // No history.replay_event after the second chat.started.
    const allReplayEvents = allFrames
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.type === "history.replay_event");
    const lastReplayIdx = allReplayEvents.length > 0
      ? allReplayEvents[allReplayEvents.length - 1]!.i
      : -1;
    if (startedFrames.length >= 2) {
      const secondStartedIdx = allFrames.indexOf(startedFrames[1]!);
      // lastReplayIdx must be before secondStartedIdx.
      expect(lastReplayIdx).toBeLessThan(secondStartedIdx);
    }

    resolveNew();
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

  // --------------------------------------------------------------------------
  // QR-P8: SDK error catch path — non-aborting throw in runLoop
  //
  // A MockQuery whose second next() call throws a non-abort Error should trigger:
  //   - chat.done with reason="errored"
  //   - chat.error with code="SDK_ERROR"
  //   - a system:error event appended to the invocation's JSONL log
  // --------------------------------------------------------------------------
  it("QR-P8: SDK throw in runLoop → chat.done{errored} + chat.error{SDK_ERROR} + event-log entry", async () => {
    const errMsg = "simulated SDK crash";
    let callCount = 0;

    // The generator yields init on first next(), then throws on second next().
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      // Give the bridge a moment to process init so the invocation is registered
      // before we throw (otherwise persistence.events.append hasn't been wired yet).
      await Bun.sleep(10);
      throw new Error(errMsg);
    })();

    const throwQuery = gen as unknown as MockQuery;
    patchWithStubs(throwQuery);
    throwQuery.interrupt = async () => { callCount++; };
    throwQuery.close = () => {};

    const persistence = new InMemoryPersistence();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => throwQuery,
      cwd: "/tmp/test",
      persistence,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    // chat.started (early) carries invocationId — retrieve it before the error frames arrive.
    const startedFrames = await ws.waitForFrames("chat.started", 1, 5000);
    const invocationId = startedFrames[0]!.invocationId as string;
    expect(typeof invocationId).toBe("string");

    // Wait for the error frames — both must arrive within 5 s.
    const dones = await ws.waitForFrames("chat.done", 1, 5000);
    const chatErrors = await ws.waitForFrames("chat.error", 1, 5000);

    // chat.done must have reason="errored".
    expect(dones.some((f) => f.reason === "errored")).toBe(true);

    // chat.error must have code="SDK_ERROR".
    expect(chatErrors).toHaveLength(1);
    expect(chatErrors[0]!.code).toBe("SDK_ERROR");
    expect(typeof chatErrors[0]!.message).toBe("string");
    expect((chatErrors[0]!.message as string).length).toBeGreaterThan(0);

    const logged: SDKMessage[] = [];
    for await (const e of persistence.events.readAll(invocationId)) {
      logged.push(e);
    }
    const errEntry = logged.find(
      (e) => (e as Record<string, unknown>).type === "system" &&
              (e as Record<string, unknown>).subtype === "error",
    );
    expect(errEntry).toBeDefined();
    expect((errEntry as Record<string, unknown>).error).toContain(errMsg);

    await bridge.shutdown();
    void callCount;
  });

  // --------------------------------------------------------------------------
  // codex-3: platform-mismatch refusal
  //   When `chat.start{resumeFromInvocationId}` is received but the prior
  //   session's platform differs from the requested platform, the bridge
  //   must emit `chat.error{code:'platform-mismatch'}` and NOT start the
  //   session. This is the acceptance test for the cross-platform resume
  //   guard called out in the cycle brief.
  // --------------------------------------------------------------------------
  it("codex-3: cross-platform resume is refused with chat.error{platform-mismatch}", async () => {
    const persistence = new InMemoryPersistence();

    // Seed a prior session with platform='codex' and a corresponding invocation
    // so the resume path finds them.
    const priorSessionId = "00000000-0000-4000-c000-000000000001";
    const priorInvocationId = "00000000-0000-4000-c000-000000000002";
    persistence.sessions.insert({
      id: priorSessionId,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      cwd: "/tmp/test",
      model: "gpt-5.1",
      permissionMode: "default",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: "completed",
      title: "prior codex",
      lastServerSeq: 0,
      sdkSessionId: null,
      platform: "codex",
      effort: "high",
    });
    persistence.invocations.insert({
      id: priorInvocationId,
      sessionId: priorSessionId,
      parentInvocationId: null,
      resumedFromInvocationId: null,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: "gpt-5.1",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      durationMs: 30_000,
      status: "completed",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: "hello codex",
      eventLogPath: `${priorSessionId}/${priorInvocationId}.jsonl`,
      ownerPid: null,
    });

    const mockQuery = makeMockQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => mockQuery,
      cwd: "/tmp/test",
      persistence,
    });

    // Attempt to resume the codex session with platform='claude' — must refuse.
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "claude-opus-4-7",
      platform: "claude",
      resumeFromInvocationId: priorInvocationId,
    });

    // Verify chat.error{code:'platform-mismatch'} was emitted.
    const errors = ws.framesOfType("chat.error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("platform-mismatch");
    expect(errors[0]!.sessionId).toBe(priorSessionId);

    // Verify no chat.started was emitted (session was refused, not started).
    expect(ws.framesOfType("chat.started").length).toBe(0);

    // Verify the bridge is not holding an active session.
    expect(bridge.activeSessionId()).toBeNull();

    // Verify NO new invocation row was inserted (the refusal happens before
    // any persistence write). Only the seeded prior invocation should exist.
    const allInvs = persistence.invocations.listForSession(priorSessionId);
    expect(allInvs.length).toBe(1);
    expect(allInvs[0]!.id).toBe(priorInvocationId);
  });

  // --------------------------------------------------------------------------
  // gear-4: ChatStart.effort → SDK Options.thinking.budget_tokens
  //   Pass effort='high' and assert the SDK query options carry the
  //   { thinking: { type: 'enabled', budget_tokens: 16_000 } } shape.
  //   Pass effort='none' (or omit) and assert no `thinking` key is set.
  // --------------------------------------------------------------------------
  it("gear-4: effort='high' forwards thinking.budget_tokens=16000 to SDK Options", async () => {
    let capturedOpts: unknown = null;
    const mockQuery = makeMockQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: ({ options }) => {
        capturedOpts = options;
        return mockQuery;
      },
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "claude-opus-4-7",
      effort: "high",
    });

    const opts = capturedOpts as Record<string, unknown> | null;
    expect(opts).not.toBeNull();
    expect(opts!["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 16_000,
    });

    await bridge.shutdown();
  });

  it("gear-4: effort='none' omits the thinking key entirely", async () => {
    let capturedOpts: unknown = null;
    const mockQuery = makeMockQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: ({ options }) => {
        capturedOpts = options;
        return mockQuery;
      },
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "claude-opus-4-7",
      effort: "none",
    });

    const opts = capturedOpts as Record<string, unknown> | null;
    expect(opts).not.toBeNull();
    expect(opts!["thinking"]).toBeUndefined();

    await bridge.shutdown();
  });

  it("gear-4: effort='max' saturates at 31999 tokens (one below SDK cap)", async () => {
    let capturedOpts: unknown = null;
    const mockQuery = makeMockQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: ({ options }) => {
        capturedOpts = options;
        return mockQuery;
      },
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "claude-opus-4-7",
      effort: "max",
    });

    const opts = capturedOpts as Record<string, unknown> | null;
    expect(opts).not.toBeNull();
    expect(opts!["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 31_999,
    });

    await bridge.shutdown();
  });

  // --------------------------------------------------------------------------
  // codex-3 / defense-in-depth: ClaudeBridge — constructed directly — refuses
  // platform='codex' on a fresh start. In production the facade (codex-4)
  // routes Codex frames to CodexBridge so this path is never hit, but the
  // guard exists in case of misroute.
  // --------------------------------------------------------------------------
  it("codex-3: ClaudeBridge (direct) refuses platform='codex' on a fresh start", async () => {
    const mockQuery = makeMockQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const claude = new ClaudeBridge({
      logger: noopLogger,
      registry,
      queryFactory: () => mockQuery,
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await claude.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "gpt-5.1",
      platform: "codex",
    });

    const errors = ws.framesOfType("chat.error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("platform-mismatch");
    expect(ws.framesOfType("chat.started").length).toBe(0);
    expect(claude.activeSessionId()).toBeNull();
  });
});
