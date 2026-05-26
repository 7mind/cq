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
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";
import { SqlitePersistence } from "../src/persist/SqlitePersistence.js";
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
// MockQuery factory
// ---------------------------------------------------------------------------

type MockQuery = Query & { interruptCalled: boolean };

function makeMockQuery(script: SDKMessage[]): MockQuery {
  let scriptIndex = 0;
  let done = false;

  const obj = {
    [Symbol.asyncIterator]() { return this; },
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
    async interrupt(): Promise<void> { obj.interruptCalled = true; done = true; },
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
    close() { done = true; },
    interruptCalled: false,
  };

  return obj as unknown as MockQuery;
}

// ---------------------------------------------------------------------------
// SDK message factories
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
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-a000-000000000003",
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

function makeChatStart(): import("@cq/shared").ChatStart {
  return { type: "chat.start", seq: 0, ts: Date.now() };
}

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

    // The update should carry the invocationId from the chat.started frame.
    const started = ws.framesOfType("chat.started");
    expect(started).toHaveLength(1);
    const invocationId = started[0]!.invocationId as string;
    const finalUpdate = updates.find((u) => u.invocationId === invocationId);
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate!.patch as Record<string, unknown>).status).toBe("completed");
  });
});
