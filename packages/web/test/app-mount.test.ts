/**
 * app-mount.test.ts — F-10 / F-18 verification (PR-17).
 *
 * Renders <App> under a <ConnectionProvider value={fakeManager}> via happy-dom
 * and asserts:
 *   (a) <App> mounts — the Indicator element is present in the DOM.
 *   (b) Indicator subscribes after mount — fakeManager.onUpdate called ≥ 1×.
 *   (c) After stubbed pong (manager pushes ALIVE stats), the Indicator's
 *       data-state is one of {new, alive, stale, connecting, dead, terminal}.
 *   (d) Unmount — all subscribers detached (subscriberCount returns to 0).
 *
 * [G2c F-10] — replaces the curl-based pre-mount smoke (curl sees only
 *              pre-React HTML; happy-dom exercises the full React tree).
 * [G2c F-18] — confirms no module-global Manager: we inject our own fake.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import App from "../src/App";

// ---------------------------------------------------------------------------
// Fake Manager — minimal in-memory stub
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

class FakeManager {
  private _stats: ManagerStats;
  private readonly _subs: UpdateCb[] = [];
  /** Tracks how many times onUpdate has been called (subscribe calls). */
  onUpdateCallCount = 0;

  constructor(initialStats: ManagerStats) {
    this._stats = initialStats;
  }

  get stats(): ManagerStats { return this._stats; }

  onUpdate(cb: UpdateCb): () => void {
    this.onUpdateCallCount++;
    this._subs.push(cb);
    return () => {
      const i = this._subs.indexOf(cb);
      if (i !== -1) this._subs.splice(i, 1);
    };
  }

  push(stats: ManagerStats): void {
    this._stats = stats;
    for (const cb of this._subs) cb(stats);
  }

  // No-op stub: ChatTab subscribes to onMessage; FakeManager emits no frames.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onMessage(_cb: (frame: import("@cq/shared").ServerFrame) => void): () => void {
    return () => {};
  }

  // No-op stub: ChatTab calls manager.send() on submit.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  send(_frame: import("@cq/shared").ClientFrame): void {}

  get subscriberCount(): number { return this._subs.length; }
}

// ---------------------------------------------------------------------------
// DOM container lifecycle
// ---------------------------------------------------------------------------

const VALID_STATES = new Set(["new", "alive", "stale", "connecting", "dead", "terminal"]);

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

describe("app-mount (F-10 / F-18)", () => {
  test("(a) <App> mounts — Indicator element present in DOM", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(App, {}),
        ),
      );
    });

    const indicator = container!.querySelector("#ws-indicator");
    expect(indicator).not.toBeNull();
  });

  test("(b) Indicator subscribes to onUpdate at least once after mount", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(App, {}),
        ),
      );
    });

    // useSyncExternalStore (useConnectionStats) + useEffect (setNow) both subscribe
    expect(manager.onUpdateCallCount).toBeGreaterThanOrEqual(1);
    expect(manager.subscriberCount).toBeGreaterThanOrEqual(1);
  });

  test("(c) After stubbed pong → ALIVE, data-state is a valid widget state", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(App, {}),
        ),
      );
    });

    // Simulate server pong completing → connection becomes ALIVE
    act(() => {
      manager.push(
        makeStats({
          connections: [makeConn({ id: "conn-1", state: "ALIVE", rtt: 42, uptimeMs: 1000 })],
          activeConnectionId: "conn-1",
        }),
      );
    });

    const indicator = container!.querySelector("[data-state]");
    expect(indicator).not.toBeNull();
    const state = indicator!.getAttribute("data-state") ?? "";
    expect(VALID_STATES.has(state)).toBe(true);
    // Specifically: ALIVE connection → widget state = "alive"
    expect(state).toBe("alive");
  });

  test("(d) Unmount — all subscribers detached", () => {
    const manager = new FakeManager(makeStats());
    setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(App, {}),
        ),
      );
    });

    const countAfterMount = manager.subscriberCount;
    expect(countAfterMount).toBeGreaterThanOrEqual(1);

    act(() => { reactRoot!.unmount(); });
    reactRoot = null;

    expect(manager.subscriberCount).toBe(0);

    // Pushing after unmount must not throw
    expect(() => manager.push(makeStats({ isTerminal: true }))).not.toThrow();
  });
});
