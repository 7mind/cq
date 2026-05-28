/**
 * resume.test.ts — PR-43: Resume-from-history entry point tests.
 *
 * Two required cases:
 *  1. Insert a session with sdk_session_id; chat.start{resumeFromInvocationId}
 *     → assert SDK options include resume: <that sdk_session_id>.
 *  2. history.get{replay:true} for an invocation with 5 stored events
 *     → 5 history.replay_event frames in order, then history.replay_done.
 */

import { describe, it, expect } from "bun:test";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory } from "../src/agent/bridge";
import type { Query, SDKMessage, Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";
import { WsSession } from "../src/ws/session";
import type { SessionRow, InvocationRow } from "@cq/shared";
import {
  noopLogger,
  MockWsSocket,
  makeAssistantMessage,
  type ParsedFrame,
} from "./helpers/mockBridge";



// ---------------------------------------------------------------------------
// MockQuery factory — records the SDKOptions it was called with.
// ---------------------------------------------------------------------------

function makeCaptureQuery(script: SDKMessage[]): {
  factory: QueryFactory;
  captured: { options: SDKOptions | undefined };
} {
  const captured = { options: undefined as SDKOptions | undefined };
  const factory: QueryFactory = ({ options }) => {
    captured.options = options;
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
      async interrupt(): Promise<void> { done = true; },
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
    };
    return obj as unknown as Query;
  };
  return { factory, captured };
}

// ---------------------------------------------------------------------------
// SDK message factories
// ---------------------------------------------------------------------------

function makeInitMessage(sdkSessionId = "sdk-session-00000000"): SDKMessage {
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
    session_id: sdkSessionId,
  } as SDKMessage;
}

// ---------------------------------------------------------------------------
// Test 1: chat.start with resumeFromInvocationId → SDK options include resume: <sdk_session_id>
// ---------------------------------------------------------------------------

describe("Resume-from-history", () => {
  it("chat.start{resumeFromInvocationId} passes resume:<sdk_session_id> to SDK", async () => {
    const persistence = new InMemoryPersistence();

    // Pre-insert a session with a known sdk_session_id.
    const existingSessionId = "aaaaaaaa-0000-4000-a000-000000000001";
    const existingInvocationId = "bbbbbbbb-0000-4000-a000-000000000002";
    const knownSdkSessionId = "sdk-session-prior-abc123";

    const sessionRow: SessionRow = {
      id: existingSessionId,
      startedAt: Date.now() - 60000,
      endedAt: Date.now() - 1000,
      cwd: "/tmp/prior",
      model: "claude-test",
      permissionMode: "default",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: "completed",
      title: "",
      lastServerSeq: 0,
      sdkSessionId: knownSdkSessionId,
      platform: "claude",
      effort: "none",
    };
    const invocationRow: InvocationRow = {
      id: existingInvocationId,
      sessionId: existingSessionId,
      parentInvocationId: null,
      resumedFromInvocationId: null,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: "claude-test",
      startedAt: Date.now() - 60000,
      endedAt: Date.now() - 1000,
      durationMs: 59000,
      status: "completed",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: "prior session prompt",
      eventLogPath: `${existingSessionId}/${existingInvocationId}.jsonl`,
      ownerPid: null,
    };
    persistence.sessions.insert(sessionRow);
    persistence.invocations.insert(invocationRow);

    // Build a capture factory that records what options the SDK received.
    const { factory: captureFactory, captured } = makeCaptureQuery([makeInitMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: captureFactory,
      cwd: "/tmp/test",
      persistence,
    });
    const ws = new MockWsSocket();

    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      resumeFromInvocationId: existingInvocationId,
    });

    // Wait for chat.started.
    await ws.waitForFrames("chat.started");

    // Assert SDK options include resume: <sdk_session_id>.
    expect(captured.options?.resume).toBe(knownSdkSessionId);
  });

  // ---------------------------------------------------------------------------
  // Test 2: history.get{replay:true} → 5 history.replay_event + history.replay_done
  // ---------------------------------------------------------------------------

  it("history.get{replay:true} streams 5 events in order then replay_done", async () => {
    const persistence = new InMemoryPersistence();

    // Pre-insert a session and invocation with 5 stored events.
    const sessionId = "cccccccc-0000-4000-a000-000000000001";
    const invocationId = "dddddddd-0000-4000-a000-000000000002";

    const sessionRow: SessionRow = {
      id: sessionId,
      startedAt: Date.now() - 60000,
      endedAt: Date.now() - 1000,
      cwd: "/tmp",
      model: "claude-test",
      permissionMode: "default",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: "completed",
      title: "",
      lastServerSeq: 0,
      sdkSessionId: null,
      platform: "claude",
      effort: "none",
    };
    const invocationRow: InvocationRow = {
      id: invocationId,
      sessionId,
      parentInvocationId: null,
      resumedFromInvocationId: null,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: "claude-test",
      startedAt: Date.now() - 60000,
      endedAt: Date.now() - 1000,
      durationMs: 59000,
      status: "completed",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: "replay test",
      eventLogPath: `${sessionId}/${invocationId}.jsonl`,
      ownerPid: null,
    };
    persistence.sessions.insert(sessionRow);
    persistence.invocations.insert(invocationRow);

    // Store 5 events.
    const events: SDKMessage[] = [
      makeAssistantMessage("msg-0"),
      makeAssistantMessage("msg-1"),
      makeAssistantMessage("msg-2"),
      makeAssistantMessage("msg-3"),
      makeAssistantMessage("msg-4"),
    ];
    for (const evt of events) {
      persistence.events.append(invocationId, evt);
    }

    // Build a WsSession and a mock WS socket.
    const registry = new SessionRegistry();
    const wsSess = new WsSession("conn-test", noopLogger, registry, null, persistence);

    // A minimal WsSocket compatible with WsSession.
    const sentFrames: ParsedFrame[] = [];
    const mockSocket = {
      send(data: string): void {
        sentFrames.push(JSON.parse(data) as ParsedFrame);
      },
      close(): void {},
      data: { sessionId: "conn-test", session: wsSess },
    };

    // Send history.get with replay:true.
    const reqSeq = 42;
    wsSess.message(mockSocket, JSON.stringify({
      type: "history.get",
      seq: reqSeq,
      ts: Date.now(),
      invocationId,
      replay: true,
    }));

    // Wait for replay_done (async).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (sentFrames.some((f) => f.type === "history.replay_done")) break;
      await Bun.sleep(10);
    }

    // Assert: 5 history.replay_event frames.
    const replayEvents = sentFrames.filter((f) => f.type === "history.replay_event");
    expect(replayEvents).toHaveLength(5);

    // Assert ordinals are 0..4 in order.
    for (let i = 0; i < 5; i++) {
      expect(replayEvents[i]!.ordinal).toBe(i);
      expect(replayEvents[i]!.invocationId).toBe(invocationId);
      expect(replayEvents[i]!.requestSeq).toBe(reqSeq);
    }

    // Assert history.replay_done is present.
    const donFrames = sentFrames.filter((f) => f.type === "history.replay_done");
    expect(donFrames).toHaveLength(1);
    expect(donFrames[0]!.requestSeq).toBe(reqSeq);

    // Assert replay_done comes after all replay_events.
    const doneIdx = sentFrames.findIndex((f) => f.type === "history.replay_done");
    const lastEventIdx = sentFrames.reduce(
      (max, f, i) => (f.type === "history.replay_event" ? i : max),
      -1,
    );
    expect(doneIdx).toBeGreaterThan(lastEventIdx);
  });
});
