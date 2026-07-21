// index.test.ts — unit tests for the ledger-status Pi wiring (from ./index.ts).
//
// Standalone package test (mirrors auto-driver/driver.test.ts style): lives
// beside the module under nix/pkg/pi-extensions/ledger-status/ (own
// package.json, `"test": "bun test"`), NOT part of the cq-ledgers workspace.
// Run with: `cd nix/pkg/pi-extensions/ledger-status && bun test`.
//
// The `cq counts` shell-out and the real timer are integration-only. These
// tests exercise the deterministic wiring with a FAKE api/ctx and injected
// runCounts/setIntervalFn/clearIntervalFn seams: the DISTINCT slot key, the
// hasUI gate, the initial paint that does NOT depend on session_start, the
// registered post-turn/post-tool events, the poll interval (named constant),
// single-flight, and the non-throwing failure path.

import { describe, test, expect } from "bun:test";
import {
  registerLedgerStatus,
  SLOT_KEY,
  POLL_INTERVAL_MS,
  type LedgerStatusOptions,
  type StatusContext,
  type StatusRegistrationApi,
} from "./index";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

type EventName = "session_start" | "turn_end" | "tool_execution_end" | "session_shutdown";

interface FakeApi extends StatusRegistrationApi {
  handlers: Map<EventName, (event: { type: string }, ctx: StatusContext) => void>;
  /** Fire a subscribed event by name with the given ctx. */
  fire(event: EventName, ctx: StatusContext): void;
}

function makeFakeApi(): FakeApi {
  const handlers = new Map<EventName, (event: { type: string }, ctx: StatusContext) => void>();
  const api: FakeApi = {
    handlers,
    on(event: EventName, handler: (event: { type: string }, ctx: StatusContext) => void): void {
      handlers.set(event, handler);
    },
    fire(event: EventName, ctx: StatusContext): void {
      const h = handlers.get(event);
      if (!h) throw new Error(`no handler registered for ${event}`);
      h({ type: event }, ctx);
    },
  };
  return api;
}

interface StatusCall {
  key: string;
  text: string | undefined;
}

function makeFakeCtx(
  statusCalls: StatusCall[],
  opts?: { hasUI?: boolean; cwd?: string },
): StatusContext {
  return {
    cwd: opts?.cwd ?? "/fake/repo",
    hasUI: opts?.hasUI ?? true,
    ui: {
      setStatus(key: string, text: string | undefined): void {
        statusCalls.push({ key, text });
      },
    },
  };
}

/** A fake timer factory that captures the poll callback and delay. */
function makeFakeTimer(): {
  opts: Pick<LedgerStatusOptions, "setIntervalFn" | "clearIntervalFn">;
  tick: () => void;
  delay: () => number | undefined;
  cleared: () => boolean;
} {
  let cb: (() => void) | undefined;
  let delay: number | undefined;
  const HANDLE = Symbol("poll");
  let cleared = false;
  return {
    opts: {
      setIntervalFn(fn: () => void, ms: number): unknown {
        cb = fn;
        delay = ms;
        return HANDLE;
      },
      clearIntervalFn(handle: unknown): void {
        if (handle === HANDLE) cleared = true;
      },
    },
    tick: () => cb?.(),
    delay: () => delay,
    cleared: () => cleared,
  };
}

/** Full Q/T/D fixture stdout, matching counts.test.ts. */
const FULL_QTD_STDOUT = JSON.stringify({
  ledgers: ["questions", "tasks", "defects"],
  counts: { questions: 12, tasks: 20, defects: 4 },
  ledgerSummaries: [
    { name: "questions", itemCount: 12, statusCounts: {}, completedCount: 3, progressTotal: 12 },
    { name: "tasks", itemCount: 20, statusCounts: {}, completedCount: 5, progressTotal: 20 },
    { name: "defects", itemCount: 4, statusCounts: {}, completedCount: 1, progressTotal: 4 },
  ],
});

const EXPECTED_LINE = "Q 3/12  T 5/20  D 1/4";

/** A runCounts fake that always resolves the full fixture. */
const fullCounts = async (): Promise<string> => FULL_QTD_STDOUT;

/** Await pending microtasks so an already-resolved refresh settles. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Slot key + hasUI gate.
// ---------------------------------------------------------------------------

describe("slot key", () => {
  test("is exactly 'cq-ledger' (never the auto-driver's 'cq-auto')", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    api.fire("session_start", makeFakeCtx(statusCalls));
    await flush();

    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls.every((c) => c.key === SLOT_KEY)).toBe(true);
    expect(SLOT_KEY).toBe("cq-ledger");
    expect(statusCalls.every((c) => c.key !== "cq-auto")).toBe(true);
  });
});

describe("hasUI gate", () => {
  test("setStatus called with the formatted line when hasUI=true", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    api.fire("session_start", makeFakeCtx(statusCalls, { hasUI: true }));
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);
  });

  test("ZERO ui calls when hasUI=false", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    // Fire every ctx-bearing trigger with hasUI=false.
    const ctx = makeFakeCtx(statusCalls, { hasUI: false });
    api.fire("session_start", ctx);
    await flush();
    api.fire("turn_end", ctx);
    await flush();
    api.fire("tool_execution_end", ctx);
    await flush();
    timer.tick();
    await flush();

    expect(statusCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Initial paint — does NOT depend on session_start.
// ---------------------------------------------------------------------------

describe("initial paint", () => {
  test("occurs on session_start (the on-load event)", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    api.fire("session_start", makeFakeCtx(statusCalls));
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);
  });

  test("occurs WITHOUT a session_start event — a first turn_end also paints", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    // session_start is NEVER fired; the first ctx-bearing event is turn_end.
    api.fire("turn_end", makeFakeCtx(statusCalls));
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);
  });

  test("occurs WITHOUT a session_start event — a first tool_execution_end also paints", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    api.fire("tool_execution_end", makeFakeCtx(statusCalls));
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);
  });
});

// ---------------------------------------------------------------------------
// Registered events + poll interval.
// ---------------------------------------------------------------------------

describe("registered triggers", () => {
  test("subscribes the real post-turn and post-tool events (turn_end, tool_execution_end)", () => {
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    expect(api.handlers.has("turn_end")).toBe(true);
    expect(api.handlers.has("tool_execution_end")).toBe(true);
    // plus the on-load and teardown events.
    expect(api.handlers.has("session_start")).toBe(true);
    expect(api.handlers.has("session_shutdown")).toBe(true);
  });

  test("arms the poll with the named POLL_INTERVAL_MS constant (15s)", () => {
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    expect(timer.delay()).toBe(POLL_INTERVAL_MS);
    expect(POLL_INTERVAL_MS).toBe(15_000);
  });

  test("a poll tick repaints using the last-seen ctx", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    // Seed a ctx via one event, then let the poll fire.
    api.fire("turn_end", makeFakeCtx(statusCalls));
    await flush();
    statusCalls.length = 0; // reset; only observe the poll's paint

    timer.tick();
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);
  });

  test("a poll tick before any ctx-bearing event paints nothing (no ctx yet)", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    // No event fired yet → lastCtx undefined → poll is a no-op.
    timer.tick();
    await flush();

    expect(statusCalls).toHaveLength(0);
  });

  test("session_shutdown clears the poll interval", () => {
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    registerLedgerStatus(api, { runCounts: fullCounts, ...timer.opts });

    expect(timer.cleared()).toBe(false);
    api.fire("session_shutdown", makeFakeCtx([]));
    expect(timer.cleared()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Single-flight.
// ---------------------------------------------------------------------------

describe("single-flight", () => {
  test("overlapping triggers do not stack runCounts calls", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();

    // runCounts that stays pending until we release it — so two triggers
    // overlap while the first is in flight.
    let releases: Array<() => void> = [];
    let calls = 0;
    const gatedCounts = (): Promise<string> => {
      calls += 1;
      return new Promise<string>((resolve) => {
        releases.push(() => resolve(FULL_QTD_STDOUT));
      });
    };

    registerLedgerStatus(api, { runCounts: gatedCounts, ...timer.opts });

    const ctx = makeFakeCtx(statusCalls);
    api.fire("turn_end", ctx); // starts refresh #1 (now in flight, pending)
    api.fire("tool_execution_end", ctx); // must be skipped (single-flight)
    timer.tick(); // must be skipped too

    expect(calls).toBe(1);

    // Release the in-flight call; a subsequent trigger may now proceed.
    releases.forEach((r) => r());
    await flush();
    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: EXPECTED_LINE }]);

    api.fire("turn_end", ctx); // in-flight cleared → this one runs
    expect(calls).toBe(2);
    releases.forEach((r) => r());
    await flush();
  });
});

// ---------------------------------------------------------------------------
// Failure path — never throws into the host loop.
// ---------------------------------------------------------------------------

describe("failure path", () => {
  test("a rejected runCounts paints the short marker and does not throw", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    const failingCounts = (): Promise<string> => Promise.reject(new Error("spawn ENOENT"));

    registerLedgerStatus(api, { runCounts: failingCounts, ...timer.opts });

    // firing must not throw synchronously...
    expect(() => api.fire("session_start", makeFakeCtx(statusCalls))).not.toThrow();
    await flush();

    // ...and the slot degrades to the short marker rather than a real line.
    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: "Q?/T?/D?/R?" }]);
  });

  test("malformed counts stdout paints the marker (parse error is caught)", async () => {
    const statusCalls: StatusCall[] = [];
    const api = makeFakeApi();
    const timer = makeFakeTimer();
    const badCounts = async (): Promise<string> => "not json";

    registerLedgerStatus(api, { runCounts: badCounts, ...timer.opts });

    api.fire("turn_end", makeFakeCtx(statusCalls));
    await flush();

    expect(statusCalls).toEqual([{ key: SLOT_KEY, text: "Q?/T?/D?/R?" }]);
  });
});
