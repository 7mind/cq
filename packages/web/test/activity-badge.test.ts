/**
 * activity-badge.test.ts — ACTIVITY-01 end-to-end on the web side.
 *
 * Renders the real ChatTab (inside SessionProvider + ConnectionProvider with a
 * FakeManager) and emits server `activity.status` frames. Asserts the top-bar
 * status badge reflects the AGGREGATE `running` count pushed by the server:
 *   - activity.status{running:2} → "BUSY (2)";
 *   - activity.status{running:1} → "BUSY (1)";
 *   - activity.status{running:0} → "IDLE" (a chat session exists) / "NEW" (none);
 *   - a workflow-only frame (running:1, no chat session) → BUSY, NOT IDLE.
 *
 * This is the web-level stand-in the brief allows when timing a real /plan phase
 * deterministically in Playwright is impractical: a pushed activity.status frame
 * drives the badge text.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

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
// Minimal FakeManager (same shape as chat-autostart.test.ts)
// ---------------------------------------------------------------------------

type UpdateCb = (stats: ManagerStats) => void;

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

class FakeManager {
  private _stats: ManagerStats;
  private readonly _updateSubs: UpdateCb[] = [];
  private readonly _msgSubs: Array<(f: ServerFrame) => void> = [];
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
  emit(frame: ServerFrame): void {
    for (const cb of this._msgSubs) cb(frame);
  }
}

// ---------------------------------------------------------------------------
// DOM lifecycle
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
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
  try { localStorage.removeItem("cq.activeSessionId"); } catch { /* ignore */ }
}

afterEach(() => { teardown(); });

function renderChatTab(manager: FakeManager): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(
      createElement(ConnectionProvider, { value: manager as never },
        createElement(SessionProvider, null,
          createElement(ChatTab),
        ),
      ),
    );
  });
  return c;
}

function emitActivity(manager: FakeManager, running: number): void {
  act(() => {
    manager.emit({ type: "activity.status", seq: 1, ts: Date.now(), running } as ServerFrame);
  });
}

function badgeText(c: HTMLDivElement): string | null {
  return c.querySelector("[data-testid='session-status']")?.textContent ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatTab status badge ← activity.status (ACTIVITY-01)", () => {
  test("no session, no activity → NEW", () => {
    const c = renderChatTab(new FakeManager(makeStats()));
    expect(badgeText(c)).toBe("NEW");
  });

  test("activity.status{running:2} drives BUSY (2)", () => {
    const manager = new FakeManager(makeStats());
    const c = renderChatTab(manager);
    emitActivity(manager, 2);
    expect(badgeText(c)).toBe("BUSY (2)");
  });

  test("activity.status{running:1} drives BUSY (1)", () => {
    const manager = new FakeManager(makeStats());
    const c = renderChatTab(manager);
    emitActivity(manager, 1);
    expect(badgeText(c)).toBe("BUSY (1)");
  });

  test("workflow-only activity (running:1, no chat session) → BUSY, not IDLE", () => {
    // No chat.started was emitted, so there is no chat session — yet a /plan
    // phase dispatching makes running=1, so the badge must show BUSY (1).
    const manager = new FakeManager(makeStats());
    const c = renderChatTab(manager);
    emitActivity(manager, 1);
    expect(badgeText(c)).toBe("BUSY (1)");
  });

  test("running falls back to 0 → NEW when no chat session exists", () => {
    const manager = new FakeManager(makeStats());
    const c = renderChatTab(manager);
    emitActivity(manager, 2); // BUSY (2)
    expect(badgeText(c)).toBe("BUSY (2)");
    emitActivity(manager, 0); // back to idle; no chat session → NEW
    expect(badgeText(c)).toBe("NEW");
  });
});
