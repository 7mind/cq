/**
 * indicator.test.ts
 *
 * Tests for deriveWidgetState (pure function) and the <Indicator> React
 * component. Runs under happy-dom, registered here at module level with a
 * shared-global guard so that only the first file to evaluate (reverse-alpha
 * order: ring.test.ts before indicator.test.ts) calls
 * GlobalRegistrator.register().
 */

// Must be first — registers DOM globals (document, window, etc.)
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}
// Tell React 19 this environment supports act()
// @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
if (!globalThis.IS_REACT_ACT_ENVIRONMENT) {
  // @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { deriveWidgetState } from "../src/ws/deriveWidgetState";
import type { WidgetState } from "../src/ws/deriveWidgetState";
import type { ManagerStats } from "../src/ws/Manager";
import { Indicator } from "../src/ws/Indicator";

// ---------------------------------------------------------------------------
// Fake Manager — minimal in-memory stand-in
// ---------------------------------------------------------------------------

type UpdateCb = (stats: ManagerStats) => void;

type ConnectionEntry = ManagerStats["connections"][number];

function makeConn(overrides: Partial<ConnectionEntry> & { id: string; state: ConnectionEntry["state"] }): ConnectionEntry {
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
    ...overrides,
  };
}

class FakeManager {
  private _stats: ManagerStats;
  private readonly _subs: UpdateCb[] = [];

  constructor(initialStats: ManagerStats) {
    this._stats = initialStats;
  }

  get stats(): ManagerStats {
    return this._stats;
  }

  onUpdate(cb: UpdateCb): () => void {
    this._subs.push(cb);
    return () => {
      const i = this._subs.indexOf(cb);
      if (i !== -1) this._subs.splice(i, 1);
    };
  }

  /** Test helper: push a new stats snapshot to all subscribers. */
  push(stats: ManagerStats): void {
    this._stats = stats;
    for (const cb of this._subs) cb(stats);
  }

  get subscriberCount(): number {
    return this._subs.length;
  }
}

// ---------------------------------------------------------------------------
// DOM container lifecycle
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
// deriveWidgetState — pure unit tests (no DOM)
// ---------------------------------------------------------------------------

describe("deriveWidgetState", () => {
  test("ALIVE in any connection → alive", () => {
    const stats = makeStats({
      connections: [
        makeConn({ id: "a", state: "ALIVE", rtt: 42, uptimeMs: 1000 }),
        makeConn({ id: "b", state: "STALE", uptimeMs: 500 }),
      ],
    });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("alive");
  });

  test("no connections + isTerminal → terminal", () => {
    const stats = makeStats({ isTerminal: true });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("terminal");
  });

  test("NEW connection → connecting", () => {
    const stats = makeStats({
      connections: [makeConn({ id: "c", state: "NEW" })],
    });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("connecting");
  });

  test("nextRetryAt set → connecting", () => {
    const stats = makeStats({ nextRetryAt: Date.now() + 3000 });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("connecting");
  });

  test("pendingReconnectOnVisible → connecting", () => {
    const stats = makeStats({ pendingReconnectOnVisible: true });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("connecting");
  });

  test("no connections, not terminal, no retry → dead", () => {
    const stats = makeStats();
    expect(deriveWidgetState(stats)).toBe<WidgetState>("dead");
  });

  test("STALE but no ALIVE → stale", () => {
    const stats = makeStats({
      connections: [makeConn({ id: "d", state: "STALE", uptimeMs: 200 })],
    });
    expect(deriveWidgetState(stats)).toBe<WidgetState>("stale");
  });
});

// ---------------------------------------------------------------------------
// <Indicator> component tests
// ---------------------------------------------------------------------------

describe("Indicator component", () => {
  test("renders with data-state=alive when manager reports ALIVE", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "x", state: "ALIVE", rtt: 10, uptimeMs: 500 })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    const el = container!.querySelector("[data-state]");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-state")).toBe("alive");
  });

  test("renders with data-state=terminal when manager isTerminal", () => {
    const manager = new FakeManager(makeStats({ isTerminal: true }));
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    const el = container!.querySelector("[data-state]");
    expect(el!.getAttribute("data-state")).toBe("terminal");
  });

  test("updates when manager.onUpdate fires — alive → dead", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "x", state: "ALIVE", rtt: 5, uptimeMs: 200 })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    expect(container!.querySelector("[data-state]")!.getAttribute("data-state")).toBe("alive");

    // Flip to dead
    act(() => { manager.push(makeStats()); });
    expect(container!.querySelector("[data-state]")!.getAttribute("data-state")).toBe("dead");
  });

  test("aria-label includes the human-readable state", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "y", state: "ALIVE", rtt: 77, uptimeMs: 1000 })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    const el = container!.querySelector("[data-state]");
    const label = el!.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).toContain("alive");
  });

  test("aria-label changes when state transitions to connecting", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "z", state: "ALIVE", rtt: 10, uptimeMs: 300 })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    // Transition to connecting via nextRetryAt
    act(() => { manager.push(makeStats({ nextRetryAt: Date.now() + 5000 })); });
    const label = container!.querySelector("[data-state]")!.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).toContain("reconnect");
  });

  test("unmounts cleanly — no leaked subscribers", () => {
    const manager = new FakeManager(makeStats());
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    expect(manager.subscriberCount).toBe(1);

    // Unmount
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
    expect(manager.subscriberCount).toBe(0);

    // Firing an update after unmount should not throw
    expect(() => manager.push(makeStats({ isTerminal: true }))).not.toThrow();
  });

  test("renders the non-color glyph inside the circle (shape channel)", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "g", state: "ALIVE" })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(createElement(Indicator, { manager: manager as never }));
    });
    const el = container!.querySelector("[data-state]");
    // The alive glyph is "✓"
    expect(el!.textContent).toBe("✓");
  });
});
