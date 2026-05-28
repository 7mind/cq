/**
 * bridge-persist.test.ts — PR-41: Bridge persistence wiring tests.
 *
 * Runs 4 mandatory cases:
 *  1. InMemoryPersistence: 1 session + 1 invocation after chat.done; event count matches.
 *  2. SqlitePersistence (:memory:): session.endedAt set; invocation.status='completed'.
 *  3. Sub-agent flow: task_started → child invocation row with parentInvocationId set;
 *     task_notification → child status='completed'.
 *  4. history.update frames emitted between chat.started and chat.done.
 */

import { describe, it, expect } from "bun:test";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory } from "../src/agent/bridge";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";
import { SqlitePersistence } from "../src/persist/SqlitePersistence.js";
import {
  noopLogger,
  MockWsSocket,
  makeMockQuery,
  makeInitMessage,
  makeAssistantMessage,
  makeChatStart,
} from "./helpers/mockBridge";

function makeAssistantMessageWithToolUse(toolUseId: string, toolName: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Running a tool" },
        { type: "tool_use", id: toolUseId, name: toolName, input: { command: "echo hi" } },
      ],
      model: "claude-test",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-a000-000000000004",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

function makeResultMessage(totalCostUsd: number, inputTokens: number, outputTokens: number): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: totalCostUsd,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    uuid: "00000000-0000-4000-a000-000000000005",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

function makeTaskStartedMessage(taskId: string, toolUseId: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "running a subagent task",
    subagent_type: "general-purpose",
    uuid: "00000000-0000-4000-a000-000000000010",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

function makeTaskNotificationMessage(taskId: string, toolUseId: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: toolUseId,
    status: "completed",
    output_file: "/tmp/output.json",
    summary: "task finished",
    uuid: "00000000-0000-4000-a000-000000000011",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Bridge factory helpers
// ---------------------------------------------------------------------------

function makeBridgeWithPersistence(
  script: SDKMessage[],
  persistence: InMemoryPersistence | SqlitePersistence,
): { bridge: Bridge; ws: MockWsSocket } {
  const registry = new SessionRegistry();
  const queryFactory: QueryFactory = () => makeMockQuery(script);
  const bridge = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory,
    cwd: "/tmp/test",
    persistence,
  });
  return { bridge, ws: new MockWsSocket() };
}

// ---------------------------------------------------------------------------
// Test 1: InMemoryPersistence — session + invocation present; event count matches
// ---------------------------------------------------------------------------

describe("Bridge persistence", () => {
  it("InMemoryPersistence: 1 session + 1 invocation after chat.done; events match stream count", async () => {
    const persistence = new InMemoryPersistence();
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("hello"),
      makeAssistantMessage("world"),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    // 1 session row
    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    expect(sessions.total).toBe(1);
    const session = sessions.rows[0]!;
    expect(session.endedAt).not.toBeNull();
    expect(session.endedReason).toBe("completed");

    // 1 invocation row
    const invocations = persistence.invocations.listForSession(session.id);
    expect(invocations).toHaveLength(1);
    const inv = invocations[0]!;
    expect(inv.agentName).toBe("main");
    expect(inv.status).toBe("completed");
    expect(inv.endedAt).not.toBeNull();

    // Event count: 2 assistant messages (init is NOT appended)
    let eventCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _evt of persistence.events.readAll(inv.id)) {
      eventCount++;
    }
    expect(eventCount).toBe(2); // 2 assistant messages
  });

  // ---------------------------------------------------------------------------
  // Test 2: SqlitePersistence (:memory:) — session.endedAt + invocation.status='completed'
  // ---------------------------------------------------------------------------

  it("SqlitePersistence (:memory:): session.endedAt set; invocation.status='completed'", async () => {
    const persistence = new SqlitePersistence(":memory:");
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("persisted"),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    expect(sessions.total).toBe(1);
    const session = sessions.rows[0]!;
    expect(typeof session.endedAt).toBe("number");
    expect(session.endedReason).toBe("completed");

    const invocations = persistence.invocations.listForSession(session.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.status).toBe("completed");
    expect(invocations[0]!.durationMs).not.toBeNull();

    persistence.close();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Sub-agent flow — task_started → child invocation; task_notification → completed
  // ---------------------------------------------------------------------------

  it("task_started inserts child invocation with parentInvocationId; task_notification finalises it", async () => {
    const persistence = new InMemoryPersistence();
    const taskId = "task-abc-123";
    const toolUseId = "toolu_001";
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeTaskStartedMessage(taskId, toolUseId),
      makeAssistantMessage("working on subtask"),
      makeTaskNotificationMessage(taskId, toolUseId),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    const sessionId = sessions.rows[0]!.id;
    const invocations = persistence.invocations.listForSession(sessionId);

    // Should have 2 rows: 1 top-level + 1 child
    expect(invocations).toHaveLength(2);

    const topLevel = invocations.find((r) => r.agentName === "main");
    const child = invocations.find((r) => r.agentName !== "main");

    expect(topLevel).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parentInvocationId).toBe(topLevel!.id);
    expect(child!.taskId).toBe(taskId);
    expect(child!.toolUseId).toBe(toolUseId);
    expect(child!.status).toBe("completed");
    expect(child!.endedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 4: history.update frames emitted between chat.started and chat.done
  // ---------------------------------------------------------------------------

  it("history.update frames are emitted during a chat session", async () => {
    const persistence = new InMemoryPersistence();
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("answer"),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    // At minimum, finalisation emits one history.update (for the invocation).
    const updates = ws.framesOfType("history.update");
    expect(updates.length).toBeGreaterThanOrEqual(1);

    // Two chat.started frames are emitted (early + late); both carry the same
    // sessionId/invocationId. Read the invocationId from the first one.
    const started = ws.framesOfType("chat.started");
    expect(started.length).toBeGreaterThanOrEqual(1);
    const invocationId = started[0]!.invocationId as string;
    const finalUpdate = updates.find((u) => u.invocationId === invocationId);
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate!.patch as Record<string, unknown>).status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Test 5 (E2E-D15): resume from history reuses the same session row
  // ---------------------------------------------------------------------------

  it("E2E-D15: resume from history uses same sessionId, links invocation via resumedFromInvocationId, one session row", async () => {
    const persistence = new InMemoryPersistence();

    // --- First chat: a normal session ---
    const firstScript: SDKMessage[] = [
      makeInitMessage({ session_id: "sdk-session-abc-001" }),
      makeAssistantMessage("first answer"),
    ];
    const registry = new SessionRegistry();
    const firstQueryFactory: QueryFactory = () => makeMockQuery(firstScript);
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: firstQueryFactory,
      cwd: "/tmp/test",
      persistence,
    });
    const firstWs = new MockWsSocket();
    await bridge.handleChatStart(firstWs, makeChatStart());
    await firstWs.waitForFrames("chat.done");

    // Capture first invocation id from the chat.started frame.
    const firstStarted = firstWs.framesOfType("chat.started");
    expect(firstStarted.length).toBeGreaterThanOrEqual(1);
    const firstInvocationId = firstStarted[0]!.invocationId as string;
    const firstSessionId = firstStarted[0]!.sessionId as string;

    // Verify session is closed.
    const afterFirst = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    expect(afterFirst.total).toBe(1);
    expect(afterFirst.rows[0]!.endedReason).toBe("completed");

    // --- Second chat: resume from the first invocation ---
    const secondScript: SDKMessage[] = [
      makeInitMessage({ session_id: "sdk-session-abc-001" }),
      makeAssistantMessage("resumed answer"),
    ];
    let capturedSdkOptions: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
    const secondQueryFactory: QueryFactory = ({ options }) => {
      capturedSdkOptions = options;
      return makeMockQuery(secondScript);
    };
    // Replace queryFactory via a new Bridge instance sharing the same persistence + registry.
    const bridge2 = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: secondQueryFactory,
      cwd: "/tmp/test",
      persistence,
    });
    const secondWs = new MockWsSocket();
    await bridge2.handleChatStart(secondWs, {
      type: "chat.start",
      seq: 1,
      ts: Date.now(),
      resumeFromInvocationId: firstInvocationId,
    });
    await secondWs.waitForFrames("chat.done");

    const secondStarted = secondWs.framesOfType("chat.started");
    expect(secondStarted.length).toBeGreaterThanOrEqual(1);
    const secondSessionId = secondStarted[0]!.sessionId as string;
    const secondInvocationId = secondStarted[0]!.invocationId as string;

    // Same session id
    expect(secondSessionId).toBe(firstSessionId);

    // Still only ONE session row in persistence
    const afterSecond = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    expect(afterSecond.total).toBe(1);

    // Two invocations under the same session
    const invocations = persistence.invocations.listForSession(firstSessionId);
    expect(invocations).toHaveLength(2);

    const secondInv = invocations.find((r) => r.id === secondInvocationId);
    expect(secondInv).toBeDefined();
    expect(secondInv!.sessionId).toBe(firstSessionId);
    expect(secondInv!.resumedFromInvocationId).toBe(firstInvocationId);

    // SDK options should have carried resume
    expect(capturedSdkOptions?.resume).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 6 (E2E-D06): tool_use + result → persisted toolCallCount, costUsd,
  //                   inputTokens, outputTokens are non-zero
  // ---------------------------------------------------------------------------

  it("E2E-D06: assistant tool_use bumps toolCallCount; result message persists costUsd + tokens", async () => {
    const persistence = new InMemoryPersistence();
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessageWithToolUse("toolu_bash_001", "Bash"),
      makeResultMessage(0.0042, 150, 75),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    const sessionId = sessions.rows[0]!.id;
    const invocations = persistence.invocations.listForSession(sessionId);
    expect(invocations).toHaveLength(1);
    const inv = invocations[0]!;

    // tool_use block in assistant message should have been counted.
    expect(inv.toolCallCount).toBe(1);

    // result message fields should be reflected on the row.
    expect(inv.costUsd).toBeCloseTo(0.0042, 6);
    expect(inv.inputTokens).toBe(150);
    expect(inv.outputTokens).toBe(75);

    // history.update frames should have carried the updated values.
    const updates = ws.framesOfType("history.update");
    const toolCountUpdate = updates.find(
      (u) => (u.patch as Record<string, unknown>).toolCallCount === 1,
    );
    expect(toolCountUpdate).toBeDefined();

    const costUpdate = updates.find(
      (u) => typeof (u.patch as Record<string, unknown>).costUsd === "number" &&
        ((u.patch as Record<string, unknown>).costUsd as number) > 0,
    );
    expect(costUpdate).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 7 (D28a): subagent child row receives non-zero tool_call_count + model
  // ---------------------------------------------------------------------------

  it("D28a: subagent child row receives tool_call_count and model from assistant messages with parent_tool_use_id", async () => {
    const persistence = new InMemoryPersistence();
    const taskId = "task-d28a-001";
    const toolUseId = "toolu_parent_001";
    const childToolUseId = "toolu_child_001";

    // Subagent assistant message with parent_tool_use_id linking it to the child
    const subagentAssistantMsg: SDKMessage = {
      type: "assistant",
      message: {
        id: "msg_child",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "counting lines" },
          { type: "tool_use", id: childToolUseId, name: "Bash", input: { command: "wc -l **/*.ts" } },
        ],
        model: "claude-sonnet-4-7",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: toolUseId,
      uuid: "00000000-0000-4000-a000-000000000020",
      session_id: "00000000-0000-4000-a000-000000000002",
    } as unknown as SDKMessage;

    const script: SDKMessage[] = [
      makeInitMessage(),
      makeTaskStartedMessage(taskId, toolUseId),
      subagentAssistantMsg,
      makeTaskNotificationMessage(taskId, toolUseId),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    const sessionId = sessions.rows[0]!.id;
    const invocations = persistence.invocations.listForSession(sessionId);

    // Two rows: top-level + child
    expect(invocations).toHaveLength(2);
    const child = invocations.find((r) => r.agentName !== "main");
    expect(child).toBeDefined();

    // Child row must have tool_call_count > 0 (credited from the subagent assistant msg)
    expect(child!.toolCallCount).toBeGreaterThan(0);

    // Child row must have a non-empty model (captured from msg.message.model)
    expect(child!.model).toBe("claude-sonnet-4-7");

    // history.update for the child should carry toolCallCount > 0
    const updates = ws.framesOfType("history.update");
    const childToolCountUpdate = updates.find(
      (u) =>
        u.invocationId === child!.id &&
        typeof (u.patch as Record<string, unknown>).toolCallCount === "number" &&
        ((u.patch as Record<string, unknown>).toolCallCount as number) > 0,
    );
    expect(childToolCountUpdate).toBeDefined();

    // history.update for the child should carry the model
    const childModelUpdate = updates.find(
      (u) =>
        u.invocationId === child!.id &&
        (u.patch as Record<string, unknown>).model === "claude-sonnet-4-7",
    );
    expect(childModelUpdate).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test D36: child invocation event log populated from messages with parent_tool_use_id
  // ---------------------------------------------------------------------------

  it("D36: assistant messages with parent_tool_use_id are written to child event log; task control messages stay on parent only", async () => {
    const persistence = new InMemoryPersistence();
    const taskId = "task-d36-001";
    const toolUseId = "tu_1";

    // An assistant message attributed to the subagent (parent_tool_use_id = tu_1).
    const subagentMsg: SDKMessage = {
      type: "assistant",
      message: {
        id: "msg_child_d36",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "subagent output" }],
        model: "claude-test",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      parent_tool_use_id: toolUseId,
      uuid: "00000000-0000-4000-a000-d36000000001",
      session_id: "00000000-0000-4000-a000-000000000002",
    } as unknown as SDKMessage;

    const script: SDKMessage[] = [
      makeInitMessage(),
      makeTaskStartedMessage(taskId, toolUseId),
      subagentMsg,
      makeTaskNotificationMessage(taskId, toolUseId),
    ];
    const { bridge, ws } = makeBridgeWithPersistence(script, persistence);

    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.done");

    const sessions = persistence.sessions.list(
      {},
      { field: "startedAt", dir: "desc" },
      { limit: 10, offset: 0 },
    );
    const sessionId = sessions.rows[0]!.id;
    const invocations = persistence.invocations.listForSession(sessionId);

    const topLevel = invocations.find((r) => r.agentName === "main");
    const child = invocations.find((r) => r.agentName !== "main");
    expect(topLevel).toBeDefined();
    expect(child).toBeDefined();

    // Child log must contain the assistant message with parent_tool_use_id.
    const childEvents: SDKMessage[] = [];
    for await (const e of persistence.events.readAll(child!.id)) {
      childEvents.push(e);
    }
    const childAssistant = childEvents.find(
      (e) => (e as Record<string, unknown>)["type"] === "assistant",
    );
    expect(childAssistant).toBeDefined();

    // Parent log must contain ALL messages (task_started, subagent assistant, task_notification).
    const parentEvents: SDKMessage[] = [];
    for await (const e of persistence.events.readAll(topLevel!.id)) {
      parentEvents.push(e);
    }
    const parentHasTaskStarted = parentEvents.some(
      (e) =>
        (e as Record<string, unknown>)["type"] === "system" &&
        (e as Record<string, unknown>)["subtype"] === "task_started",
    );
    const parentHasAssistant = parentEvents.some(
      (e) => (e as Record<string, unknown>)["type"] === "assistant",
    );
    const parentHasTaskNotification = parentEvents.some(
      (e) =>
        (e as Record<string, unknown>)["type"] === "system" &&
        (e as Record<string, unknown>)["subtype"] === "task_notification",
    );
    expect(parentHasTaskStarted).toBe(true);
    expect(parentHasAssistant).toBe(true);
    expect(parentHasTaskNotification).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 8 (D31): SDK iterator throws → system:error appended to event log
  // ---------------------------------------------------------------------------

  it("D31: SDK iterator throw appends system:error event to JSONL log and emits chat.error WS frame", async () => {
    const persistence = new InMemoryPersistence();

    // A MockQuery that yields one init message then throws on the next next().
    const sdkError = new Error("SDK subprocess crashed unexpectedly");
    let callCount = 0;
    const throwingQuery: import("@anthropic-ai/claude-agent-sdk").Query = {
      [Symbol.asyncIterator]() { return this; },
      next(): Promise<IteratorResult<SDKMessage, void>> {
        callCount++;
        if (callCount === 1) {
          // First call: yield the init message.
          return Promise.resolve({ value: makeInitMessage() as SDKMessage, done: false });
        }
        // Second call: throw.
        return Promise.reject(sdkError);
      },
      return(): Promise<IteratorResult<SDKMessage, void>> {
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
        return Promise.reject(err);
      },
      async interrupt(): Promise<void> {},
      async setPermissionMode() {},
      async setModel() {},
      async setMaxThinkingTokens() {},
      async applyFlagSettings() {},
      async initializationResult() { throw new Error("not implemented"); },
      async supportedCommands() { return []; },
      async supportedModels() { return []; },
      async supportedAgents() { return []; },
      async mcpServerStatus() { return []; },
      async getContextUsage() { throw new Error("not implemented"); },
      async readFile() { return null; },
      async reloadPlugins() { throw new Error("not implemented"); },
      async accountInfo() { throw new Error("not implemented"); },
      async rewindFiles() { throw new Error("not implemented"); },
      async seedReadState() {},
      async reconnectMcpServer() {},
      async toggleMcpServer() {},
      async setMcpServers() { throw new Error("not implemented"); },
      async streamInput() {},
      async stopTask() {},
      async backgroundTasks() { return false; },
      close() {},
    } as unknown as import("@anthropic-ai/claude-agent-sdk").Query;

    const registry = new SessionRegistry();
    const ws = new MockWsSocket();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => throwingQuery,
      cwd: "/tmp/test",
      persistence,
    });

    await bridge.handleChatStart(ws, makeChatStart());
    // Wait for both chat.done and chat.error to arrive.
    await ws.waitForFrames("chat.done");
    await ws.waitForFrames("chat.error");

    // Assert: chat.error frame was emitted with code "SDK_ERROR".
    const errorFrames = ws.framesOfType("chat.error");
    expect(errorFrames.length).toBeGreaterThanOrEqual(1);
    const sdkErrorFrame = errorFrames.find((f) => f.code === "SDK_ERROR");
    expect(sdkErrorFrame).toBeDefined();
    expect(sdkErrorFrame?.message).toContain("SDK subprocess crashed");

    // Assert: invocation status is 'failed'.
    const sessions = persistence.sessions.list({}, { field: "startedAt", dir: "desc" }, { limit: 10, offset: 0 });
    const sessionId = sessions.rows[0]!.id;
    const invocations = persistence.invocations.listForSession(sessionId);
    expect(invocations).toHaveLength(1);
    const inv = invocations[0]!;
    expect(inv.status).toBe("failed");

    // Assert: system:error event appended to the JSONL event log.
    const events: SDKMessage[] = [];
    for await (const e of persistence.events.readAll(inv.id)) {
      events.push(e);
    }
    const sysErrorEvent = events.find(
      (e) =>
        (e as Record<string, unknown>)["type"] === "system" &&
        (e as Record<string, unknown>)["subtype"] === "error",
    );
    expect(sysErrorEvent).toBeDefined();
    expect((sysErrorEvent as Record<string, unknown>)["error"]).toContain("SDK subprocess crashed");
  });

  // ---------------------------------------------------------------------------
  // PR-01: Haiku title generator wiring
  // ---------------------------------------------------------------------------

  it("PR-01: title generator is invoked exactly once after the first successful result; title is persisted", async () => {
    const persistence = new InMemoryPersistence();
    const resultWithText = {
      ...(makeResultMessage(0.1, 5, 5) as Record<string, unknown>),
      result: "A haiku has 5-7-5 syllable structure.",
    } as unknown as SDKMessage;
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("haiku reply"),
      resultWithText,
    ];
    let callCount = 0;
    const calls: Array<{ firstUserMessage: string; firstAssistantText: string }> = [];
    const titleGenerator = {
      // eslint-disable-next-line @typescript-eslint/require-await
      generate: async (input: { firstUserMessage: string; firstAssistantText: string }): Promise<string> => {
        callCount += 1;
        calls.push(input);
        return "Writing haiku poems";
      },
    };
    const bridge = new Bridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      queryFactory: () => makeMockQuery(script),
      cwd: "/tmp/test",
      persistence,
      titleGenerator,
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    const started = ws.framesOfType("chat.started");
    expect(started.length).toBeGreaterThanOrEqual(1);
    const sessionId = started[0]!.sessionId as string;
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "Tell me about haiku." });
    await ws.waitForFrames("chat.done");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(callCount).toBe(1);
    expect(calls[0]!.firstUserMessage).toBe("Tell me about haiku.");
    expect(calls[0]!.firstAssistantText).toBe("A haiku has 5-7-5 syllable structure.");
    const sess = persistence.sessions.get(sessionId)!;
    expect(sess.title).toBe("Writing haiku poems");
  });

  it("PR-01: title generator is skipped when assistant text is empty (defensive gate)", async () => {
    const persistence = new InMemoryPersistence();
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("hi"),
      makeResultMessage(0.1, 5, 5), // no `result` field
    ];
    let callCount = 0;
    const titleGenerator = {
      // eslint-disable-next-line @typescript-eslint/require-await
      generate: async (): Promise<string> => {
        callCount += 1;
        return "Should not be called";
      },
    };
    const bridge = new Bridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      queryFactory: () => makeMockQuery(script),
      cwd: "/tmp/test",
      persistence,
      titleGenerator,
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    const sessionId = (ws.framesOfType("chat.started")[0]!.sessionId) as string;
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "Hello." });
    await ws.waitForFrames("chat.done");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(callCount).toBe(0);
    const sess = persistence.sessions.get(sessionId)!;
    expect(sess.title).toBe("");
  });

  it("PR-01: title generator is NOT re-invoked on the second result of the same session", async () => {
    const persistence = new InMemoryPersistence();
    const resultMsg = {
      ...(makeResultMessage(0.1, 5, 5) as Record<string, unknown>),
      result: "First reply text.",
    } as unknown as SDKMessage;
    const resultMsg2 = {
      ...(makeResultMessage(0.2, 6, 6) as Record<string, unknown>),
      result: "Second reply text.",
    } as unknown as SDKMessage;
    const script: SDKMessage[] = [
      makeInitMessage(),
      makeAssistantMessage("first reply"),
      resultMsg,
      makeAssistantMessage("second reply"),
      resultMsg2,
    ];
    let callCount = 0;
    const titleGenerator = {
      // eslint-disable-next-line @typescript-eslint/require-await
      generate: async (): Promise<string> => {
        callCount += 1;
        return "Only one title";
      },
    };
    const bridge = new Bridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      queryFactory: () => makeMockQuery(script),
      cwd: "/tmp/test",
      persistence,
      titleGenerator,
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    const started = ws.framesOfType("chat.started");
    const sessionId = started[0]!.sessionId as string;
    await bridge.handleChatInput(ws, { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text: "Hello." });

    // Wait until both turns complete (the script has two result messages →
    // two chat.done frames). Poll until two chat.done frames are seen.
    await ws.waitForFrames("chat.done");
    // Give the runLoop time to process the second result + chat.done.
    for (let i = 0; i < 50 && ws.framesOfType("chat.done").length < 2; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(callCount).toBe(1);
    const sess = persistence.sessions.get(sessionId)!;
    expect(sess.title).toBe("Only one title");
  });
});
