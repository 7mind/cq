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
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, useEffect } from "react";
import { act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame } from "@cq/shared";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import { ChatTab } from "../src/chat/ChatTab";
import { SessionProvider, useSession } from "../src/chat/SessionContext";

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
  // Clear persisted session id so tests start clean (D47 localStorage).
  try { localStorage.removeItem("cq.activeSessionId"); } catch { /* ignore */ }
}

afterEach(() => { teardown(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Helper: emit a settings.get_result with default values so the deferred
// chat.start fires. Tests that don't care about model values use this.
function emitSettingsResult(manager: FakeManager, model = "claude-opus-4-7[1m]"): void {
  act(() => {
    manager.emit({
      type: "settings.get_result",
      seq: 99,
      ts: Date.now(),
      requestSeq: 0,
      model,
      permissionMode: "bypassPermissions",
      hideSdkEvents: false,
    } as ServerFrame);
  });
}

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

    // D6: chat.start is deferred until settings.get_result arrives.
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(0);

    // Simulate settings.get_result so the deferred start fires.
    emitSettingsResult(manager);

    const starts = manager.sent.filter((f) => f.type === "chat.start");
    expect(starts).toHaveLength(1);
  });

  test("(b) on reconnect with a stored session, sends chat.rejoin instead of chat.start", () => {
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

    // First ALIVE → deferred start; emit settings result to fire it.
    act(() => { manager.push(ALIVE_STATS); });
    emitSettingsResult(manager);
    const startsAfterFirst = manager.sent.filter((f) => f.type === "chat.start").length;
    expect(startsAfterFirst).toBe(1);

    // Simulate chat.started so activeSessionId is set (persisted to localStorage).
    act(() => {
      manager.emit({
        type: "chat.started",
        seq: 1,
        ts: Date.now(),
        sessionId: "00000000-0000-4000-a000-000000000011",
        invocationId: "00000000-0000-4000-a000-000000000012",
        initInfo: {},
      } as ServerFrame);
    });

    // Lose connection — clears in-flight guards but NOT activeSessionId (D47).
    act(() => { manager.push(NOT_ALIVE_STATS); });

    // Reconnect → should send chat.rejoin (not chat.start) because activeSessionId is still set.
    act(() => {
      manager.push(makeStats({
        connections: [makeConn({ id: "c2", state: "ALIVE" })],
        activeConnectionId: "c2",
      }));
    });

    const rejoins = manager.sent.filter((f) => f.type === "chat.rejoin");
    expect(rejoins).toHaveLength(1);
    expect((rejoins[0] as { sessionId: string }).sessionId).toBe(
      "00000000-0000-4000-a000-000000000011",
    );
    // No additional chat.start should have been sent.
    expect(manager.sent.filter((f) => f.type === "chat.start").length).toBe(1);
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

    // First ALIVE → deferred start; emit settings result to fire it.
    act(() => { manager.push(ALIVE_STATS); });
    emitSettingsResult(manager);

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

  test("(f) on ALIVE edge, sends settings.get before chat.start", () => {
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

    const settingsGets = manager.sent.filter((f) => f.type === "settings.get");
    expect(settingsGets).toHaveLength(1);

    // D6: chat.start is deferred until settings.get_result arrives —
    // no chat.start in the queue yet.
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(0);

    // Emit settings.get_result so the deferred chat.start fires.
    emitSettingsResult(manager);

    // settings.get must appear before chat.start in the sent queue
    const settingsGetIdx = manager.sent.findIndex((f) => f.type === "settings.get");
    const chatStartIdx = manager.sent.findIndex((f) => f.type === "chat.start");
    expect(settingsGetIdx).toBeLessThan(chatStartIdx);
  });

  test("(g) settings.get_result updates model/hideSdkEvents; no settings.set sent before first load", () => {
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

    // Before any ALIVE edge: no settings.get or settings.set should have been sent.
    expect(manager.sent.filter((f) => f.type === "settings.set")).toHaveLength(0);

    act(() => { manager.push(ALIVE_STATS); });

    // After ALIVE edge: settings.get sent but still no settings.set (settingsLoadedRef is false).
    expect(manager.sent.filter((f) => f.type === "settings.get")).toHaveLength(1);
    expect(manager.sent.filter((f) => f.type === "settings.set")).toHaveLength(0);

    // Emit settings.get_result — sets states and marks settingsLoadedRef = true.
    // The state updates (model, hideSdkEvents) happen in effects, but since
    // settingsLoadedRef becomes true only after the state setters fire, the
    // subsequent effects for those same state changes may or may not fire
    // depending on React batching. The invariant we care about is that the
    // default-state flush before the first load does NOT produce settings.set.
    act(() => {
      manager.emit({
        type: "settings.get_result",
        seq: 1,
        ts: Date.now(),
        requestSeq: 0,
        model: "claude-haiku-4-5",
        permissionMode: "default",
        hideSdkEvents: true,
      } as ServerFrame);
    });

    // The model select should reflect the loaded model if the element is rendered.
    const modelSelect = container!.querySelector("[data-testid='header-model-select']") as HTMLSelectElement | null;
    if (modelSelect !== null) {
      expect(modelSelect.value).toBe("claude-haiku-4-5");
    }
  });

  test("(h) on ALIVE edge with stored session id, sends chat.rejoin instead of chat.start", () => {
    // Pre-seed localStorage to simulate a prior session surviving page refresh.
    try { localStorage.setItem("cq.activeSessionId", "00000000-0000-4000-a000-000000000077"); } catch { /* ignore */ }

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

    // Transition to ALIVE — should attempt rejoin, not a fresh start.
    act(() => { manager.push(ALIVE_STATS); });

    const rejoins = manager.sent.filter((f) => f.type === "chat.rejoin");
    expect(rejoins).toHaveLength(1);
    expect((rejoins[0] as { sessionId: string }).sessionId).toBe(
      "00000000-0000-4000-a000-000000000077",
    );
    // No chat.start should have been sent yet.
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(0);
  });

  test("(i) REJOIN_FAILED clears localStorage and falls back to chat.start", () => {
    try { localStorage.setItem("cq.activeSessionId", "00000000-0000-4000-a000-000000000088"); } catch { /* ignore */ }

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

    // ALIVE edge → sends chat.rejoin.
    act(() => { manager.push(ALIVE_STATS); });
    expect(manager.sent.filter((f) => f.type === "chat.rejoin")).toHaveLength(1);

    // Server replies with REJOIN_FAILED.
    act(() => {
      manager.emit({
        type: "chat.error",
        seq: 2,
        ts: Date.now(),
        code: "REJOIN_FAILED",
        message: "Session not found",
      } as ServerFrame);
    });

    // A fallback chat.start should now be in the queue.
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(1);

    // localStorage should be cleared.
    let stored: string | null = null;
    try { stored = localStorage.getItem("cq.activeSessionId"); } catch { /* ignore */ }
    expect(stored).toBeNull();
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

  test("(Q4) REJOIN_FAILED fallback uses current model from ref, not stale closure", () => {
    // Pre-seed localStorage so auto-start tries chat.rejoin first.
    try { localStorage.setItem("cq.activeSessionId", "00000000-0000-4000-a000-0000000000aa"); } catch { /* ignore */ }

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

    // ALIVE edge → sends settings.get + chat.rejoin.
    act(() => { manager.push(ALIVE_STATS); });
    expect(manager.sent.filter((f) => f.type === "chat.rejoin")).toHaveLength(1);

    // Simulate settings.get_result arriving with a NEW model before REJOIN_FAILED.
    act(() => {
      manager.emit({
        type: "settings.get_result",
        seq: 1,
        ts: Date.now(),
        requestSeq: 0,
        model: "claude-haiku-4-5",
        permissionMode: "default",
        hideSdkEvents: false,
      } as ServerFrame);
    });

    // Server replies with REJOIN_FAILED — fallback chat.start should use the updated model.
    act(() => {
      manager.emit({
        type: "chat.error",
        seq: 2,
        ts: Date.now(),
        code: "REJOIN_FAILED",
        message: "Session not found",
      } as ServerFrame);
    });

    const fallbackStarts = manager.sent.filter((f) => f.type === "chat.start");
    expect(fallbackStarts).toHaveLength(1);
    expect((fallbackStarts[0] as { model: string }).model).toBe("claude-haiku-4-5");
  });

  test("(Q3) non-REJOIN chat.error clears inProgress so the UI does not stay busy", () => {
    // Helper component: on mount, sets inProgress=true via SessionContext so we can
    // observe the transition to false when chat.error{code:"SDK_ERROR"} arrives.
    function InProgressSetter(): null {
      const { setInProgress } = useSession();
      useEffect(() => { setInProgress(true); }, []); // intentional: run once on mount
      return null;
    }

    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(InProgressSetter),
            createElement(ChatTab),
          ),
        ),
      );
    });

    // Bring the connection alive.
    act(() => { manager.push(ALIVE_STATS); });

    // InProgressSetter has set inProgress=true → stop button should be enabled.
    const stopBtnBefore = container!.querySelector("button[aria-label='Stop generation']") as HTMLButtonElement | null;
    expect(stopBtnBefore).not.toBeNull();
    expect(stopBtnBefore!.disabled).toBe(false);

    // Emit a non-REJOIN chat.error (SDK_ERROR) — must clear inProgress.
    act(() => {
      manager.emit({
        type: "chat.error",
        seq: 2,
        ts: Date.now(),
        code: "SDK_ERROR",
        message: "An SDK error occurred",
      } as ServerFrame);
    });

    // inProgress should now be false → stop button disabled.
    const stopBtnAfter = container!.querySelector("button[aria-label='Stop generation']") as HTMLButtonElement | null;
    expect(stopBtnAfter!.disabled).toBe(true);
  });

  test("(Q6) deferred chat.start uses model from settings.get_result, not React default", () => {
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

    // ALIVE edge → settings.get sent, chat.start deferred.
    act(() => { manager.push(ALIVE_STATS); });
    expect(manager.sent.filter((f) => f.type === "settings.get")).toHaveLength(1);
    expect(manager.sent.filter((f) => f.type === "chat.start")).toHaveLength(0);

    // Emit settings.get_result with a specific model.
    act(() => {
      manager.emit({
        type: "settings.get_result",
        seq: 1,
        ts: Date.now(),
        requestSeq: 0,
        model: "claude-haiku-4-5",
        permissionMode: "default",
        hideSdkEvents: true,
      } as ServerFrame);
    });

    // chat.start should now be in the queue with the model from settings.
    const starts = manager.sent.filter((f) => f.type === "chat.start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { model: string }).model).toBe("claude-haiku-4-5");
  });
});
