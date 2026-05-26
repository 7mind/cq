/**
 * a11y.test.ts — PR-50 accessibility assertions.
 *
 * Four test cases:
 *   1. Render App → at least one element has role="status" (Indicator)
 *      and aria-live="polite".
 *   2. Render Input → textarea has aria-label="Chat input".
 *   3. Render List → sortable column headers expose aria-sort attribute.
 *   4. Verify prefers-reduced-motion @media rule exists in Indicator.module.css
 *      (checked via Node fs; covers the CountdownRing suppression).
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
import { createElement, act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ManagerStats } from "../src/ws/Manager";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import App from "../src/App";
import { Input } from "../src/chat/Input";
import { List } from "../src/history/List";
import type { SortState, FilterState } from "../src/history/List";
import type { HistoryRow } from "@cq/shared";

// ---------------------------------------------------------------------------
// Minimal FakeManager
// ---------------------------------------------------------------------------

type UpdateCb = (stats: ManagerStats) => void;
type MessageCb = (frame: unknown) => void;
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
  private readonly _updateSubs: UpdateCb[] = [];
  private readonly _messageSubs: MessageCb[] = [];
  readonly sent: unknown[] = [];

  constructor(initialStats: ManagerStats = makeStats()) {
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

  onMessage(cb: MessageCb): () => void {
    this._messageSubs.push(cb);
    return () => {
      const i = this._messageSubs.indexOf(cb);
      if (i !== -1) this._messageSubs.splice(i, 1);
    };
  }

  send(frame: unknown): void {
    this.sent.push(frame);
  }

  push(stats: ManagerStats): void {
    this._stats = stats;
    for (const cb of this._updateSubs) cb(stats);
  }
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
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => { teardown(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_FILTER: FilterState = {
  agentName: "",
  model: "",
  status: "",
  dateFrom: "",
  dateTo: "",
  search: "",
};

const DEFAULT_SORT: SortState = { key: "startedAt", dir: "desc" };

function makeRow(id: string): HistoryRow {
  return {
    invocationId: id,
    sessionId: "sess-1",
    agentName: "TestAgent",
    model: "claude-sonnet-4-6",
    status: "completed",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    toolCallCount: 0,
    title: "Test",
    promptExcerpt: "test prompt",
  };
}

// ---------------------------------------------------------------------------
// Test 1: App renders role=status + aria-live=polite (Indicator)
// ---------------------------------------------------------------------------

describe("a11y: Indicator", () => {
  test("renders an element with role=status and aria-live=polite", () => {
    const manager = new FakeManager(
      makeStats({ connections: [makeConn({ id: "x", state: "ALIVE", rtt: 10, uptimeMs: 500 })] }),
    );
    setup();
    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(App, {}),
        ),
      );
    });

    const statusEl = container!.querySelector("[role='status']");
    expect(statusEl).not.toBeNull();
    expect(statusEl!.getAttribute("aria-live")).toBe("polite");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Input textarea has aria-label
// ---------------------------------------------------------------------------

describe("a11y: Input", () => {
  test("textarea has aria-label='Chat input'", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(Input, { onSubmit: () => {} }),
      );
    });

    const textarea = container!.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.getAttribute("aria-label")).toBe("Chat input");
  });

  test("Stop button has accessible aria-label when disabled+onInterrupt provided", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(Input, {
          onSubmit: () => {},
          onInterrupt: () => {},
          disabled: true,
        }),
      );
    });

    const stopBtn = container!.querySelector("button");
    expect(stopBtn).not.toBeNull();
    expect(stopBtn!.getAttribute("aria-label")).toBe("Stop generation");
  });
});

// ---------------------------------------------------------------------------
// Test 3: List sortable headers expose aria-sort
// ---------------------------------------------------------------------------

describe("a11y: List", () => {
  test("sortable column headers expose aria-sort attribute", () => {
    setup();
    const rows: HistoryRow[] = [makeRow("inv-1")];
    act(() => {
      reactRoot!.render(
        createElement(List, {
          rows,
          sort: DEFAULT_SORT,
          filter: EMPTY_FILTER,
          loading: false,
          onSort: () => {},
          onFilter: () => {},
        }),
      );
    });

    const sortableThs = container!.querySelectorAll("th[aria-sort]");
    // There are 4 sortable columns: When, Duration, Tool calls, Cost.
    expect(sortableThs.length).toBeGreaterThan(0);

    // The active sort column (startedAt / "When") should show "descending".
    const activeTh = container!.querySelector("th[aria-sort='descending']");
    expect(activeTh).not.toBeNull();

    // Inactive sortable columns should show "none".
    const noneThs = container!.querySelectorAll("th[aria-sort='none']");
    expect(noneThs.length).toBeGreaterThan(0);
  });

  test("sortable <th> contains a <button> for keyboard accessibility", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(List, {
          rows: [],
          sort: DEFAULT_SORT,
          filter: EMPTY_FILTER,
          loading: false,
          onSort: () => {},
          onFilter: () => {},
        }),
      );
    });

    const sortableThs = container!.querySelectorAll("th[aria-sort]");
    for (const th of sortableThs) {
      const btn = th.querySelector("button");
      expect(btn).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: prefers-reduced-motion rule in Indicator.module.css
// ---------------------------------------------------------------------------

describe("a11y: reduced-motion CSS", () => {
  test("Indicator.module.css contains prefers-reduced-motion media rule", () => {
    const cssPath = resolve(
      import.meta.dir,
      "../src/styles/Indicator.module.css",
    );
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("reduce");
  });
});
