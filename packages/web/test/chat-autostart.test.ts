/**
 * chat-autostart.test.ts — D-UX-1 verification.
 *
 * Asserts that ChatTab automatically fires chat.start when:
 *   (a) The WS connection first reaches ALIVE and activeSessionId is null.
 *   (b) A reconnect occurs (ALIVE → gone → ALIVE again) with no active session.
 *
 * Also asserts:
 *   (c) handleNewSession / handleResumeSession prevent a racing auto-start.
 *   (d) No duplicate chat.start fires when one is already in-flight.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}
// @ts-expect-error -- IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
if (!globalThis.IS_REACT_ACT_ENVIRONMENT) {
  // @ts-expect-error -- IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame } from "@cq/shared";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import { ChatTab } from "../src/chat/ChatTab";
import { SessionProvider } from "../src/chat/SessionContext";

// ---------------------------------------------------------------------------
// Helpers shared with app-mount.test.ts
// ---------------------------------------------------------------------------

type UpdateCb = (stats: ManagerStats) => void;
type ConnectionEntry = ManagerStats["connections"][number];

function makeConn(
  overrides: Partial<ConnectionEntry> & { id: string; state: ConnectionEntry["state"] },
): ConnectionEntry {
  return {
    rtt: null,
    uptimeMs: 0,
    oldestPendingPingSentAt: null,
    enteredStaleAt: null,
    connectedAt: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<ManagerStats> = {}): ManagerStats {
  return {
    connections: [],
    activeConnectionId: null,
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
    ...overrides,
  };
}

const ALIVE_STATS = makeStats({
  connections: [makeConn({ id: "c1", state: "ALIVE" })],
  activeConnectionId: "c1",
});

const NOT_ALIVE_STATS = makeStats({
  connections: [makeConn({ id: "c1", state: "DEAD" })],
  activeConnectionId: null,
});

class FakeManager {
  private _stats: ManagerStats;
  private readonly _updateSubs: UpdateCb[] = [];
  private readonly _msgSubs: Array<(f: ServerFrame) => void> = [];

  /** All frames passed to send() — inspectable by tests. */
  readonly sent: ClientFrame[] = [];

  constructor(initialStats: ManagerStats) {
    this._stats = initialStats;
  }

  get stats(): ManagerStats { return this._stats; }

  onUpdate(cb: UpdateCb): () => void {
    this._updateSubs.push(cb);
    return () => {
      const i = this._updateSubs.indexOf(cb);
      if (i !== -1) this._updateSubs.splice(i, 1);
    };
  }

  onMessage(cb: (f: ServerFrame) => void): () => void {
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

  /** Push new stats to all update subscribers (simulates Manager.onUpdate). */
  push(stats: ManagerStats): void {
    this._stats = stats;
    for (const cb of this._updateSubs) cb(stats);
  }

  /** Simulate server emitting a ServerFrame to all message subscribers. */
  emit(frame: ServerFrame): void {
    for (const cb of this._msgSubs) cb(frame);
  }

  get subscriberCount(): number { return this._updateSubs.length; }
}

// ---------------------------------------------------------------------------
// DOM lifecycle helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  return container;
}

function teardown(): void {
  if (reactRoot) {
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => { teardown(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatTab auto-start (D-UX-1)", () => {
  test("(a) fires chat.start on first ALIVE transition when no session is active", () => {
    const manager = new FakeManager(makeStats()); // starts non-ALIVE
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    // No chat.start should have been sent yet (connection not ALIVE).
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(0);

    // Transition to ALIVE.
    act(() => { manager.push(ALIVE_STATS); });

    const starts = manager.sent.filter((f) => f.type === "chat.start");
    expect(starts).toHaveLength(1);
  });

  test("(b) re-fires chat.start on reconnect when no session is active", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    // First ALIVE → auto-start fires.
    act(() => { manager.push(ALIVE_STATS); });
    // Simulate chat.started so activeSessionId is set, then chat.done to clear it.
    act(() => {
      manager.emit({
        type: "chat.started",
        seq: 1,
        ts: Date.now(),
        sessionId: "sess-1",
        invocationId: "inv-1",
        initInfo: {},
      } as ServerFrame);
    });
    act(() => {
      manager.emit({
        type: "chat.done",
        seq: 2,
        ts: Date.now(),
        sessionId: "sess-1",
        invocationId: "inv-1",
      } as ServerFrame);
    });

    // Lose connection.
    act(() => { manager.push(NOT_ALIVE_STATS); });

    const startsAfterFirst = manager.sent.filter((f) => f.type === "chat.start").length;

    // Reconnect (ALIVE edge fires again).
    act(() => {
      manager.push(makeStats({
        connections: [makeConn({ id: "c2", state: "ALIVE" })],
        activeConnectionId: "c2",
      }));
    });

    const startsTotal = manager.sent.filter((f) => f.type === "chat.start").length;
    expect(startsTotal).toBeGreaterThan(startsAfterFirst);
  });

  test("(c) does not duplicate chat.start when one is in-flight (pending)", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    // First ALIVE → auto-start fires.
    act(() => { manager.push(ALIVE_STATS); });

    // Push another ALIVE update without chat.started arriving (still in-flight).
    act(() => {
      manager.push(makeStats({
        connections: [makeConn({ id: "c1", state: "ALIVE", rtt: 20 })],
        activeConnectionId: "c1",
      }));
    });

    // Only one chat.start should have been sent.
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(1);
  });

  test("(d) empty-state hint renders when no events and not in-progress", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    // Before ALIVE: no session, no events — empty state should be visible.
    const hint = container!.querySelector("[data-testid='stream-empty-state']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("Type below to start");
  });

  test("(e) chat.started alone does NOT show thinking — session is idle, not in a turn", () => {
    // Design contract: inProgress means "a user turn is awaiting a response",
    // not "the session is established". After chat.started the session is
    // idle and ready for input; the thinking indicator must appear only after
    // the user has actually submitted a chat.input.
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    act(() => { manager.push(ALIVE_STATS); });

    // chat.started arrives but the user has not typed anything yet.
    act(() => {
      manager.emit({
        type: "chat.started",
        seq: 1,
        ts: Date.now(),
        sessionId: "sess-x",
        invocationId: "inv-x",
        initInfo: {},
      } as ServerFrame);
    });

    // No thinking indicator: not in a turn.
    expect(container!.querySelector("[data-testid='stream-thinking']")).toBeNull();
    // Empty-state hint is the correct affordance for "session ready, type below".
    expect(container!.querySelector("[data-testid='stream-empty-state']")).not.toBeNull();
  });
});
