/**
 * tooltip.test.ts — Tests for <Tooltip> component and Indicator hover/click (PR-15).
 *
 * Uses happy-dom + React 19 createElement / act.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import { Tooltip } from "../src/ws/Tooltip";
import { Indicator } from "../src/ws/Indicator";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";

// ---------------------------------------------------------------------------
// Helpers — shared with indicator.test.ts but duplicated to keep files self-contained
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
    rttWindows: { "30s": null, "1m": null, "5m": null },
    lossPct: 0,
    events: [],
    ...overrides,
  };
}

class FakeManager {
  private _stats: ManagerStats;
  private readonly _subs: UpdateCb[] = [];

  constructor(initialStats: ManagerStats) {
    this._stats = initialStats;
  }

  get stats(): ManagerStats { return this._stats; }

  onUpdate(cb: UpdateCb): () => void {
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

  get subscriberCount(): number { return this._subs.length; }
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
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => { teardown(); });

/** Render <Indicator> wrapped in <ConnectionProvider value={manager}>. */
function renderIndicator(manager: FakeManager): void {
  reactRoot!.render(
    createElement(ConnectionProvider, { value: manager as never },
      createElement(Indicator, {}),
    ),
  );
}

// ---------------------------------------------------------------------------
// <Tooltip> — pure rendering tests
// ---------------------------------------------------------------------------

describe("Tooltip component", () => {
  test("renders with role=tooltip", () => {
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats: makeStats() }));
    });
    const el = container!.querySelector("[role=tooltip]");
    expect(el).not.toBeNull();
  });

  test("renders active connection id and uptime when activeConnectionId is set", () => {
    const conn = makeConn({ id: "aaaa-bbbb-cccc-dddd", state: "ALIVE", rtt: 55, uptimeMs: 5000 });
    const stats = makeStats({
      connections: [conn],
      activeConnectionId: conn.id,
      attempt: 2,
      maxAttempts: 15,
      lossPct: 3.5,
      rttWindows: {
        "30s": { min: 50, median: 55, max: 60, count: 3 },
        "1m": null,
        "5m": null,
      },
    });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats }));
    });

    const activeIdEl = container!.querySelector("[data-testid='active-id']");
    expect(activeIdEl).not.toBeNull();
    expect(activeIdEl!.textContent).toBe(conn.id);

    const lossEl = container!.querySelector("[data-testid='loss-pct']");
    expect(lossEl).not.toBeNull();
    expect(lossEl!.textContent).toContain("3.5");

    const rttEl = container!.querySelector("[data-testid='rtt-windows']");
    expect(rttEl).not.toBeNull();
    // Should contain the 30s stats
    expect(rttEl!.textContent).toContain("50");  // min
    expect(rttEl!.textContent).toContain("55");  // median
    expect(rttEl!.textContent).toContain("60");  // max
  });

  test("shows 'stopped' backoff label when isTerminal=true (V10: never lie)", () => {
    const stats = makeStats({ isTerminal: true, lastCloseCode: 1006 });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats }));
    });
    const backoffEl = container!.querySelector("[data-testid='backoff-state']");
    expect(backoffEl).not.toBeNull();
    expect(backoffEl!.textContent).toBe("stopped");
  });

  test("shows 'deferred (tab hidden)' when pendingReconnectOnVisible=true", () => {
    const stats = makeStats({ pendingReconnectOnVisible: true, attempt: 3 });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats }));
    });
    const backoffEl = container!.querySelector("[data-testid='backoff-state']");
    expect(backoffEl!.textContent).toBe("deferred (tab hidden)");
  });

  test("shows attempt N/max and ETA when nextRetryAt is set", () => {
    const now = 100_000;
    const stats = makeStats({
      attempt: 4,
      maxAttempts: 15,
      nextRetryAt: now + 5_000,
      retryScheduledAt: now - 2_000,
    });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats, now }));
    });
    const backoffEl = container!.querySelector("[data-testid='backoff-state']");
    expect(backoffEl!.textContent).toContain("4 / 15");
    expect(backoffEl!.textContent).toContain("retry in");
  });

  test("shows '—' for lastCloseCode when null", () => {
    const stats = makeStats({ lastCloseCode: null });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats }));
    });
    const codeEl = container!.querySelector("[data-testid='last-close-code']");
    expect(codeEl!.textContent).toBe("—");
  });

  test("shows numeric close code when lastCloseCode is set", () => {
    const stats = makeStats({ lastCloseCode: 1006, lastCloseReason: "abnormal" });
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats }));
    });
    const codeEl = container!.querySelector("[data-testid='last-close-code']");
    expect(codeEl!.textContent).toBe("1006");
    const reasonEl = container!.querySelector("[data-testid='last-close-reason']");
    expect(reasonEl!.textContent).toBe("abnormal");
  });

  test("renders 'no connections' when pool is empty", () => {
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats: makeStats() }));
    });
    expect(container!.textContent).toContain("no connections");
  });

  test("RTT windows show '—' cells when all windows are null", () => {
    setup();
    act(() => {
      reactRoot!.render(createElement(Tooltip, { stats: makeStats() }));
    });
    const rttEl = container!.querySelector("[data-testid='rtt-windows']");
    expect(rttEl).not.toBeNull();
    // All 3 rows should render — the text content will contain the dash placeholder
    expect(rttEl!.textContent).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// <Indicator> hover / click behaviour
// ---------------------------------------------------------------------------

describe("Indicator tooltip integration", () => {
  test("tooltip is hidden initially (no tooltip role in DOM)", () => {
    const manager = new FakeManager(makeStats());
    setup();
    act(() => {
      renderIndicator(manager);
    });
    const tooltip = container!.querySelector("[role=tooltip]");
    expect(tooltip).toBeNull();
  });

  test("hover on indicator opens tooltip (mouseover → role=tooltip visible)", () => {
    const manager = new FakeManager(makeStats({
      connections: [makeConn({ id: "abc", state: "ALIVE", rtt: 10, uptimeMs: 1000 })],
      activeConnectionId: "abc",
    }));
    setup();
    act(() => {
      renderIndicator(manager);
    });

    const indicator = container!.querySelector("#ws-indicator");
    expect(indicator).not.toBeNull();

    // React 17+ delegates onMouseEnter via mouseover at the root
    act(() => {
      indicator!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const tooltip = container!.querySelector("[role=tooltip]");
    expect(tooltip).not.toBeNull();
  });

  test("tooltip closes on mouseout when not pinned", () => {
    const manager = new FakeManager(makeStats());
    setup();
    act(() => {
      renderIndicator(manager);
    });

    const indicator = container!.querySelector("#ws-indicator")!;

    // Open via mouseover (React onMouseEnter delegate)
    act(() => {
      indicator.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).not.toBeNull();

    // Close via mouseout (React onMouseLeave delegate)
    act(() => {
      indicator.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).toBeNull();
  });

  test("click on indicator pins tooltip open; mouseout does not close it", () => {
    const manager = new FakeManager(makeStats({
      connections: [makeConn({ id: "x", state: "ALIVE", rtt: 5, uptimeMs: 500 })],
      activeConnectionId: "x",
    }));
    setup();
    act(() => {
      renderIndicator(manager);
    });

    const indicator = container!.querySelector("#ws-indicator")!;

    // Click to pin open
    act(() => {
      indicator.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).not.toBeNull();

    // mouseout (React onMouseLeave) should NOT close pinned tooltip
    act(() => {
      indicator.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).not.toBeNull();
  });

  test("second click on indicator unpins (toggles closed)", () => {
    const manager = new FakeManager(makeStats());
    setup();
    act(() => {
      renderIndicator(manager);
    });

    const indicator = container!.querySelector("#ws-indicator")!;

    // First click: pin open
    act(() => {
      indicator.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).not.toBeNull();

    // Second click: unpin
    act(() => {
      indicator.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector("[role=tooltip]")).toBeNull();
  });
});
