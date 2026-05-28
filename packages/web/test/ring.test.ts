/**
 * ring.test.ts
 *
 * Tests for CountdownRing (SVG rendering) and computeRingRemaining (pure function),
 * plus an integration test for Indicator's ring updating on Manager.onUpdate.
 *
 * Runs under happy-dom, registered at module level with a shared-global guard
 * (`typeof globalThis.document === "undefined"`) so that only the first file
 * to evaluate calls GlobalRegistrator.register(). When running the full web
 * test suite Bun evaluates test files in reverse-alphabetical order (r before l
 * before i), so ring.test.ts registers first and indicator.test.ts skips it.
 *
 * The CloseEvent init-dict defect in happy-dom is worked around in
 * MockWebSocket._makeCloseEvent (Object.defineProperty), so happy-dom being
 * active does not corrupt lifecycle.test.ts's WebSocket close-code handling.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { CountdownRing } from "../src/ws/CountdownRing";
import { computeRingRemaining } from "../src/ws/computeRingRemaining";
import type { RingInfo } from "../src/ws/computeRingRemaining";
import { Indicator } from "../src/ws/Indicator";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import type { ManagerStats } from "../src/ws/Manager";

// ---------------------------------------------------------------------------
// Helpers — fake Manager + stats builder
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
// Default ring opts for computeRingRemaining
// ---------------------------------------------------------------------------

const RING_OPTS = {
  connectTimeoutMs: 10_000,
  pongTimeoutMs: 8_000,
  staleGraceMs: 6_000,
};

// ---------------------------------------------------------------------------
// CountdownRing — SVG rendering tests
// ---------------------------------------------------------------------------

describe("CountdownRing", () => {
  test("renders with proportional stroke-dashoffset at 50%", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(CountdownRing, { remaining: 50, total: 100 }),
      );
    });

    // There should be 2 circles: the track and the indicator arc
    const circles = container!.querySelectorAll("circle");
    expect(circles.length).toBe(2);

    // The second circle is the indicator arc
    const arc = circles[1]!;
    const dashArray = parseFloat(arc.getAttribute("stroke-dasharray") ?? "0");
    const dashOffset = parseFloat(arc.getAttribute("stroke-dashoffset") ?? "0");

    // At 50% remaining, dashoffset should be ~50% of dasharray
    expect(dashArray).toBeGreaterThan(0);
    // dashoffset = circ * (1 - 0.5) = circ * 0.5
    expect(Math.abs(dashOffset - dashArray * 0.5)).toBeLessThan(0.5);
  });

  test("stroke-dashoffset is 0 (full ring) when remaining = total", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(CountdownRing, { remaining: 100, total: 100 }),
      );
    });
    const circles = container!.querySelectorAll("circle");
    const arc = circles[1]!;
    const dashOffset = parseFloat(arc.getAttribute("stroke-dashoffset") ?? "1");
    expect(dashOffset).toBeCloseTo(0, 3);
  });

  test("stroke-dashoffset equals circumference (empty ring) when remaining = 0", () => {
    setup();
    act(() => {
      reactRoot!.render(
        createElement(CountdownRing, { remaining: 0, total: 100 }),
      );
    });
    const circles = container!.querySelectorAll("circle");
    const arc = circles[1]!;
    const dashArray = parseFloat(arc.getAttribute("stroke-dasharray") ?? "0");
    const dashOffset = parseFloat(arc.getAttribute("stroke-dashoffset") ?? "0");
    expect(Math.abs(dashOffset - dashArray)).toBeLessThan(0.5);
  });

  test("stroke-dashoffset monotonically increases as remaining decreases", () => {
    // Simulate a sequence of now values advancing across a 10s connect timeout.
    const connectedAt = 1_000_000;
    const activeId = "conn-1";
    const offsets: number[] = [];

    for (let elapsed = 0; elapsed <= 10_000; elapsed += 1_000) {
      const now = connectedAt + elapsed;
      const stats = makeStats({
        activeConnectionId: activeId,
        connections: [makeConn({
          id: activeId,
          state: "NEW",
          connectedAt,
        })],
      });
      const info = computeRingRemaining(stats, RING_OPTS, now) as RingInfo;
      expect(info).not.toBeNull();
      expect(info.phase).toBe("connect");

      // Compute what the SVG dashoffset would be
      const radius = (32 - 3) / 2;
      const circ = 2 * Math.PI * radius;
      const fraction = Math.max(0, Math.min(info.remaining, info.total)) / info.total;
      const offset = circ * (1 - fraction);
      offsets.push(offset);
    }

    // Each offset should be >= the previous (ring depletes = offset grows)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]! - 0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// computeRingRemaining — pure function tests
// ---------------------------------------------------------------------------

describe("computeRingRemaining", () => {
  test("NEW connection in connect timeout → phase=connect", () => {
    const now = 2_000_000;
    const connectedAt = now - 3_000; // 3 s elapsed of 10 s timeout
    const activeId = "conn-new";

    const stats = makeStats({
      activeConnectionId: activeId,
      connections: [makeConn({ id: activeId, state: "NEW", connectedAt })],
    });

    const result = computeRingRemaining(stats, RING_OPTS, now);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("connect");
    expect(result!.total).toBe(10_000);
    expect(result!.remaining).toBeCloseTo(7_000, -1); // 10000 - 3000
    expect(result!.remaining).toBeLessThanOrEqual(result!.total);
  });

  test("ALIVE connection with pending ping → phase=pong", () => {
    const now = 3_000_000;
    const pingAt = now - 2_000; // 2 s elapsed of 8 s pong timeout
    const activeId = "conn-alive";

    const stats = makeStats({
      activeConnectionId: activeId,
      connections: [makeConn({
        id: activeId,
        state: "ALIVE",
        rtt: 50,
        oldestPendingPingSentAt: pingAt,
      })],
    });

    const result = computeRingRemaining(stats, RING_OPTS, now);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("pong");
    expect(result!.total).toBe(8_000);
    expect(result!.remaining).toBeCloseTo(6_000, -1); // 8000 - 2000
  });

  test("STALE connection → phase=stale", () => {
    const now = 4_000_000;
    const staleAt = now - 1_500; // 1.5 s elapsed of 6 s grace
    const activeId = "conn-stale";

    const stats = makeStats({
      activeConnectionId: activeId,
      connections: [makeConn({
        id: activeId,
        state: "STALE",
        enteredStaleAt: staleAt,
      })],
    });

    const result = computeRingRemaining(stats, RING_OPTS, now);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("stale");
    expect(result!.total).toBe(6_000);
    expect(result!.remaining).toBeCloseTo(4_500, -1); // 6000 - 1500
  });

  test("no ALIVE connection + nextRetryAt set → phase=reconnect", () => {
    const now = 5_000_000;
    const retryScheduledAt = now - 2_000;
    const nextRetryAt = now + 3_000; // 3 s remaining of a 5 s backoff

    const stats = makeStats({
      nextRetryAt,
      retryScheduledAt,
    });

    const result = computeRingRemaining(stats, RING_OPTS, now);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("reconnect");
    expect(result!.total).toBeCloseTo(5_000, -1); // nextRetryAt - retryScheduledAt
    expect(result!.remaining).toBeCloseTo(3_000, -1);
  });

  test("no waiting phase → null", () => {
    const stats = makeStats({
      connections: [makeConn({ id: "c", state: "ALIVE", rtt: 10, uptimeMs: 5000 })],
      activeConnectionId: "c",
    });
    // ALIVE connection with no pending pings → no ring
    const result = computeRingRemaining(stats, RING_OPTS, Date.now());
    expect(result).toBeNull();
  });

  test("remaining is clamped to 0 when deadline has passed", () => {
    const now = 6_000_000;
    const connectedAt = now - 15_000; // 15 s elapsed, timeout is 10 s → expired
    const activeId = "conn-expired";

    const stats = makeStats({
      activeConnectionId: activeId,
      connections: [makeConn({ id: activeId, state: "NEW", connectedAt })],
    });

    const result = computeRingRemaining(stats, RING_OPTS, now);
    expect(result).not.toBeNull();
    expect(result!.remaining).toBe(0);
    expect(result!.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Indicator integration — ring appears on Manager.onUpdate with reconnect phase
// ---------------------------------------------------------------------------

describe("Indicator ring integration", () => {
  test("ring appears with phase=reconnect when Manager pushes nextRetryAt", () => {
    const manager = new FakeManager(makeStats());
    setup();

    const ringOpts = RING_OPTS;

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(Indicator, { ringOpts }),
        ),
      );
    });

    // No ring initially (no waiting phase)
    let svgEl = container!.querySelector("svg");
    expect(svgEl).toBeNull();

    // Push stats with a reconnect phase
    const now = Date.now();
    act(() => {
      manager.push(makeStats({
        nextRetryAt: now + 30_000,
        retryScheduledAt: now,
      }));
    });

    // Ring SVG should now be present
    svgEl = container!.querySelector("svg");
    expect(svgEl).not.toBeNull();

    // The ring should be showing a non-zero dashoffset < circumference
    // (30s remaining of a 30s total → fraction ≈ 1.0 → offset ≈ 0)
    const circles = svgEl!.querySelectorAll("circle");
    expect(circles.length).toBe(2);
    const arc = circles[1]!;
    const dashOffset = parseFloat(arc.getAttribute("stroke-dashoffset") ?? "-1");
    expect(dashOffset).toBeGreaterThanOrEqual(0);
  });
});
