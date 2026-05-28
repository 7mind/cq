/**
 * history-detail.test.ts — PR-44: History Detail view tests.
 *
 * 2 required cases:
 *  1. Mount Detail with invocationId='abc-…' → assert history.get{invocationId, replay:true} sent.
 *  2. Feed history.get_result then 3 history.replay_event frames then
 *     history.replay_done → assert 3 message entries rendered in <Stream>.
 */

// Must be first — registers DOM globals
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame, HistoryRowFull } from "@cq/shared";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import { Detail } from "../src/history/Detail";

// ---------------------------------------------------------------------------
// FakeManager
// ---------------------------------------------------------------------------

type UpdateCb = (stats: ManagerStats) => void;
type MessageCb = (frame: ServerFrame) => void;

function makeStats(): ManagerStats {
  return {
    connections: [
      {
        id: "conn-1",
        state: "ALIVE",
        rtt: 10,
        uptimeMs: 1000,
        oldestPendingPingSentAt: null,
        enteredStaleAt: null,
        connectedAt: null,
      },
    ],
    activeConnectionId: "conn-1",
    attempt: 0,
    maxAttempts: 15,
    isTerminal: false,
    lastCloseCode: null,
    lastCloseReason: "",
    nextRetryAt: null,
    retryScheduledAt: null,
    pendingReconnectOnVisible: false,
    rttWindows: { "30s": null, "1m": null, "5m": null },
    lossPct: 0,
    events: [],
  };
}

class FakeManager {
  private readonly _statsSubs: UpdateCb[] = [];
  private readonly _msgSubs: MessageCb[] = [];
  readonly sent: ClientFrame[] = [];
  private readonly _stats: ManagerStats;

  constructor() {
    this._stats = makeStats();
  }

  get stats(): ManagerStats { return this._stats; }

  onUpdate(cb: UpdateCb): () => void {
    this._statsSubs.push(cb);
    return () => {
      const i = this._statsSubs.indexOf(cb);
      if (i !== -1) this._statsSubs.splice(i, 1);
    };
  }

  onMessage(cb: MessageCb): () => void {
    this._msgSubs.push(cb);
    return () => {
      const i = this._msgSubs.indexOf(cb);
      if (i !== -1) this._msgSubs.splice(i, 1);
    };
  }

  send(frame: ClientFrame): boolean {
    this.sent.push(frame);
    return true;
  }

  injectMessage(frame: ServerFrame): void {
    for (const cb of this._msgSubs) cb(frame);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_INVOCATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_SESSION_ID = "11111111-2222-3333-4444-555555555555";

function makeFullRow(overrides: Partial<HistoryRowFull> = {}): HistoryRowFull {
  return {
    invocationId: TEST_INVOCATION_ID,
    sessionId: TEST_SESSION_ID,
    agentName: "main",
    model: "claude-sonnet-4-6",
    startedAt: Date.now() - 10_000,
    endedAt: Date.now(),
    durationMs: 10_000,
    status: "completed",
    toolCallCount: 3,
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.001,
    promptExcerpt: "test prompt",
    title: "Test invocation",
    cwd: "/home/user/project",
    permissionMode: "default",
    endedReason: "completed",
    sdkSessionId: null,
    eventLogPath: "/var/log/events.jsonl",
    parentInvocationId: null,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCostUsd: 0.001,
    ...overrides,
  };
}

let _seq = 1000;

/** Build a history.replay_event carrying a final assistant message. */
function makeReplayEvent(requestSeq: number, messageId: string, text: string): ServerFrame {
  return {
    type: "history.replay_event",
    seq: _seq++,
    ts: Date.now(),
    requestSeq,
    invocationId: TEST_INVOCATION_ID,
    ordinal: _seq,
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: TEST_SESSION_ID,
      parent_tool_use_id: null,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DOM lifecycle
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
}

function teardown(): void {
  if (reactRoot) {
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(teardown);

// ---------------------------------------------------------------------------
// Helper: render Detail under a fake manager
// ---------------------------------------------------------------------------

function renderDetail(manager: FakeManager, invocationId: string): void {
  act(() => {
    reactRoot!.render(
      createElement(
        ConnectionProvider,
        { value: manager as never },
        createElement(Detail, {
          invocationId,
          onClose: () => {},
        }),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("History Detail view", () => {
  test("(1) mount → sends history.get with invocationId and replay:true", () => {
    setup();
    const manager = new FakeManager();
    renderDetail(manager, TEST_INVOCATION_ID);

    const getFrames = manager.sent.filter((f) => f.type === "history.get");
    expect(getFrames.length).toBeGreaterThanOrEqual(1);

    const first = getFrames[0]!;
    if (first.type !== "history.get") throw new Error("type guard");

    expect(first.invocationId).toBe(TEST_INVOCATION_ID);
    expect(first.replay).toBe(true);
  });

  test("(2) get_result + 3 replay_event + replay_done → 3 messages rendered in Stream", () => {
    setup();
    const manager = new FakeManager();
    renderDetail(manager, TEST_INVOCATION_ID);

    // Find the seq used in the history.get frame.
    const getFrame = manager.sent.find((f) => f.type === "history.get");
    if (!getFrame || getFrame.type !== "history.get") throw new Error("no get frame");
    const requestSeq = getFrame.seq;

    // Inject get_result (header info).
    act(() => {
      manager.injectMessage({
        type: "history.get_result",
        seq: _seq++,
        ts: Date.now(),
        requestSeq,
        row: makeFullRow(),
      });
    });

    // Inject 3 replay_event frames (each is a final assistant message).
    act(() => {
      manager.injectMessage(makeReplayEvent(requestSeq, "msg-id-001", "Hello from event 1"));
      manager.injectMessage(makeReplayEvent(requestSeq, "msg-id-002", "Hello from event 2"));
      manager.injectMessage(makeReplayEvent(requestSeq, "msg-id-003", "Hello from event 3"));
    });

    // Inject replay_done.
    act(() => {
      manager.injectMessage({
        type: "history.replay_done",
        seq: _seq++,
        ts: Date.now(),
        requestSeq,
      });
    });

    // Assert that the Stream rendered 3 message entries.
    // Each assistant message renders inside [data-testid="stream-message-<messageId>"].
    const streamRoot = container!.querySelector('[data-testid="stream-root"]');
    expect(streamRoot).not.toBeNull();

    const msgNodes = streamRoot!.querySelectorAll('[data-testid^="stream-message-"]');
    expect(msgNodes.length).toBe(3);

    // Verify the header info is rendered.
    const agentName = container!.querySelector('[data-testid="detail-agent-name"]');
    expect(agentName).not.toBeNull();
    expect(agentName!.textContent).toBe("main");

    const model = container!.querySelector('[data-testid="detail-model"]');
    expect(model).not.toBeNull();
    expect(model!.textContent).toBe("claude-sonnet-4-6");

    const cwd = container!.querySelector('[data-testid="detail-cwd"]');
    expect(cwd).not.toBeNull();
    expect(cwd!.textContent).toBe("/home/user/project");
  });
});
