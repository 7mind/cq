// driver.test.ts — unit tests for the drive-and-await loop (from ./driver.ts).
//
// Standalone package test (option (a), mirroring decide.test.ts / oracle.test.ts):
// lives beside the module under nix/pkg/pi-extensions/auto-driver/ (own
// package.json, `"test": "bun test"`), NOT part of the cq-ledgers workspace. Run
// with: `cd nix/pkg/pi-extensions/auto-driver && bun test`.
//
// The Pi event wiring (registerCommand + the live session) is integration-only
// (T470). These tests exercise the EXTRACTABLE, deterministic sequencing of
// `runAutoDriver` and `launchAndAwait` with a FAKE ctx/api/oracle: the
// launch->await->getPredicates->decide->act loop, runState advancement, the
// prompt-injection order, and the act-on-AutoAction mapping.

import { describe, test, expect } from "bun:test";
import {
  launchAndAwait,
  runAutoDriver,
  sampleSignals,
  type DriverAfterProviderResponseEvent,
  type DriverApi,
  type DriverContext,
  type QuotaHitRef,
} from "./driver";
import { AutoAction, type AutoPreset, type DerivedPredicates } from "./decision";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/** Records every injected prompt and the order of waitForIdle vs injection. */
interface FakeApi extends DriverApi {
  prompts: string[];
  /** The subscriber registered via on("after_provider_response", ...). */
  providerResponseHandler: ((event: DriverAfterProviderResponseEvent) => void) | null;
  /** Simulate a provider response event (e.g. a 429). */
  simulateProviderResponse(event: DriverAfterProviderResponseEvent): void;
}

function makeFakeApi(events: string[]): FakeApi {
  const api: FakeApi = {
    prompts: [],
    providerResponseHandler: null,
    sendUserMessage(content: string): void {
      api.prompts.push(content);
      events.push(`send:${content}`);
    },
    on(
      _event: "after_provider_response",
      handler: (event: DriverAfterProviderResponseEvent) => void,
    ): void {
      api.providerResponseHandler = handler;
    },
    simulateProviderResponse(event: DriverAfterProviderResponseEvent): void {
      api.providerResponseHandler?.(event);
    },
  };
  return api;
}

interface FakeCtxOptions {
  /** Records lifecycle ordering (send/await/compact) into a shared log. */
  events: string[];
  /** Whether compact() was called. */
  onCompact?: () => void;
  /**
   * Percent to return from getContextUsage(). Defaults to null.
   * Use a function to return different values across successive calls.
   */
  contextPercent?: number | null | (() => number | null);
}

function makeFakeCtx(opts: FakeCtxOptions): DriverContext {
  return {
    cwd: "/fake/repo",
    isIdle(): boolean {
      return true;
    },
    async waitForIdle(): Promise<void> {
      opts.events.push("await");
    },
    getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
      const pct =
        typeof opts.contextPercent === "function"
          ? opts.contextPercent()
          : (opts.contextPercent ?? null);
      return { tokens: null, contextWindow: 200000, percent: pct };
    },
    compact(options?: { onComplete?: (result: unknown) => void }): void {
      opts.events.push("compact");
      opts.onCompact?.();
      // Immediately invoke onComplete so tests don't hang waiting.
      options?.onComplete?.(undefined);
    },
  };
}

const ALL_FALSE: DerivedPredicates = {
  pInvestigate: { value: false, items: [] },
  pPlan: { value: false, items: [] },
  pImplement: { value: false, items: [] },
  openQuestionGate: { value: false, items: [] },
};

function withPlanWork(items: string[]): DerivedPredicates {
  return { ...ALL_FALSE, pPlan: { value: true, items: [...items] } };
}

// `plan:auto` preset: terminal when pPlan is false.
const planPreset: AutoPreset = {
  wrappedCommand: "plan",
  terminalPredicate: (p) => !p.pPlan.value,
};

/** A getPredicates fake that yields a scripted sequence, then repeats the last. */
function scriptedOracle(sequence: DerivedPredicates[]): () => Promise<DerivedPredicates> {
  let i = 0;
  return async (): Promise<DerivedPredicates> => {
    const value = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return value;
  };
}

// ---------------------------------------------------------------------------
// launchAndAwait.
// ---------------------------------------------------------------------------

describe("launchAndAwait", () => {
  test("injects the prompt THEN awaits idle (order matters)", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    await launchAndAwait(ctx, api, "/plan");

    expect(events).toEqual(["send:/plan", "await"]);
    expect(api.prompts).toEqual(["/plan"]);
  });
});

// ---------------------------------------------------------------------------
// sampleSignals (T466 real wiring).
// ---------------------------------------------------------------------------

describe("sampleSignals", () => {
  test("converts Pi 0..100 percent to 0..1 fraction and reads quotaHit from ref", () => {
    // Pi v0.78.0 getContextUsage().percent is on a 0..100 scale; sampleSignals
    // must divide by 100 before feeding contextPercent to the decision core.
    const events: string[] = [];
    const ctx = makeFakeCtx({ events, contextPercent: 42 }); // Pi 0..100 scale
    const ref: QuotaHitRef = { value: true };
    expect(sampleSignals(ctx, ref)).toEqual({ contextPercent: 0.42, quotaHit: true });
  });

  test("returns contextPercent null when getContextUsage returns undefined", () => {
    // Override getContextUsage to return undefined (e.g. right after compaction).
    const events: string[] = [];
    const ctx: DriverContext = {
      ...makeFakeCtx({ events }),
      getContextUsage: () => undefined,
    };
    const ref: QuotaHitRef = { value: false };
    expect(sampleSignals(ctx, ref)).toEqual({ contextPercent: null, quotaHit: false });
  });

  test("returns contextPercent null when percent field is null", () => {
    const events: string[] = [];
    const ctx = makeFakeCtx({ events, contextPercent: null });
    const ref: QuotaHitRef = { value: false };
    expect(sampleSignals(ctx, ref)).toEqual({ contextPercent: null, quotaHit: false });
  });

  // Pi-realistic unit-pinning tests: these fixtures use Pi's REAL 0..100 output
  // scale and verify the 0..1 fraction conversion at the sampleSignals boundary.
  // They pin the unit contract so a future change to driver.ts or decide.ts that
  // breaks the conversion is caught immediately.
  test("[unit-pinning] Pi percent=85 (0..100 scale) → contextPercent 0.85 → above COMPACT_THRESHOLD", async () => {
    // getContextUsage returns { percent: 85 } — Pi's 0..100 scale for "85% full".
    // sampleSignals must convert to 0.85 (0..1 fraction) before the decision core.
    const events: string[] = [];
    const ctx = makeFakeCtx({ events, contextPercent: 85 }); // Pi 0..100 scale
    const ref: QuotaHitRef = { value: false };
    const signals = sampleSignals(ctx, ref);
    // The conversion must yield 0.85 — strictly above COMPACT_THRESHOLD (0.8).
    expect(signals.contextPercent).toBe(0.85);

    // Also verify end-to-end: the driver must choose COMPACT_THEN_REDRIVE (not REDRIVE)
    // when getContextUsage returns percent=85 (Pi scale) and predicates are non-terminal.
    let compactCalled = false;
    let callCount = 0;
    const ctx2 = makeFakeCtx({
      events,
      onCompact: () => { compactCalled = true; },
      contextPercent: () => {
        callCount++;
        return callCount === 1 ? 85 : null; // Pi 0..100 scale; null post-compact
      },
    });
    const api = makeFakeApi(events);
    const result = await runAutoDriver({
      ctx: ctx2,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });
    expect(compactCalled).toBe(true);
    expect(result.action).toBe(AutoAction.STOP_DRAINED);
  });

  test("[unit-pinning] Pi percent=50 (0..100 scale) → contextPercent 0.5 → below COMPACT_THRESHOLD → no compaction", async () => {
    // getContextUsage returns { percent: 50 } — Pi's 0..100 scale for "50% full".
    // sampleSignals must convert to 0.5 (0..1 fraction) — below COMPACT_THRESHOLD (0.8).
    const events: string[] = [];
    const ctx = makeFakeCtx({ events, contextPercent: 50 }); // Pi 0..100 scale
    const ref: QuotaHitRef = { value: false };
    const signals = sampleSignals(ctx, ref);
    // Converted fraction must be 0.5 — strictly below COMPACT_THRESHOLD.
    expect(signals.contextPercent).toBe(0.5);

    // End-to-end: driver must NOT compact when percent=50 (Pi scale) → 0.5 fraction.
    let compactCalled = false;
    const ctxWithSpy: DriverContext = {
      ...ctx,
      compact(options?: { onComplete?: (result: unknown) => void }): void {
        compactCalled = true;
        options?.onComplete?.(undefined);
      },
    };
    const api = makeFakeApi(events);
    const result = await runAutoDriver({
      ctx: ctxWithSpy,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });
    expect(compactCalled).toBe(false);
    expect(result.action).toBe(AutoAction.STOP_DRAINED);
  });
});

// ---------------------------------------------------------------------------
// runAutoDriver.
// ---------------------------------------------------------------------------

describe("runAutoDriver", () => {
  test("STOP_DRAINED on the first cycle: launch, await, decide drained, no redrive", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    expect(result.action).toBe(AutoAction.STOP_DRAINED);
    expect(result.iterations).toBe(0);
    expect(result.finalPredicates).toEqual(ALL_FALSE);
    // Exactly ONE launch (the slash command); no corrective re-prompt.
    expect(api.prompts).toEqual(["/plan"]);
    expect(events).toEqual(["send:/plan", "await"]);
  });

  test("first launch is the wrapped slash command; redrive uses composeRedrivePrompt", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // Cycle 0: pPlan TRUE (redrive). Cycle 1: drained.
    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    expect(result.action).toBe(AutoAction.STOP_DRAINED);
    expect(result.iterations).toBe(1);
    expect(api.prompts.length).toBe(2);
    // First injection is the bare slash command.
    expect(api.prompts[0]).toBe("/plan");
    // Second injection is the corrective re-prompt naming the blocker item.
    expect(api.prompts[1]).toContain("pPlan");
    expect(api.prompts[1]).toContain("G1");
    expect(api.prompts[1]).not.toBe("/plan");
  });

  test("STOP_NO_PROGRESS when predicates do not change across a redrive", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // Same non-terminal predicates twice -> redrive once, then no-progress stop.
    const stuck = withPlanWork(["G1"]);
    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([stuck, stuck]),
    });

    expect(result.action).toBe(AutoAction.STOP_NO_PROGRESS);
    expect(result.iterations).toBe(1);
    // One launch + one redrive = two injections.
    expect(api.prompts.length).toBe(2);
  });

  test("STOP_BLOCKED_ON_QUESTIONS when the open-question gate is set", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    const gated: DerivedPredicates = {
      ...withPlanWork(["G1"]),
      openQuestionGate: { value: true, items: ["Q9"] },
    };
    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([gated]),
    });

    expect(result.action).toBe(AutoAction.STOP_BLOCKED_ON_QUESTIONS);
    expect(result.iterations).toBe(0);
    expect(api.prompts).toEqual(["/plan"]);
  });

  test("STOP_NO_PROGRESS at the iteration bound (maxIterations)", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // Distinct predicates each cycle so the no-progress equality never fires;
    // only the hard iteration bound stops the run.
    const oracle = (() => {
      let n = 0;
      return async (): Promise<DerivedPredicates> => {
        n += 1;
        return withPlanWork([`G${n}`]);
      };
    })();

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: oracle,
      maxIterations: 3,
    });

    expect(result.action).toBe(AutoAction.STOP_NO_PROGRESS);
    expect(result.iterations).toBe(3);
    // launch + 3 redrives = 4 injections.
    expect(api.prompts.length).toBe(4);
  });

  test("runState advances: prevAction is REDRIVE on the cycle after a redrive", async () => {
    // Observe runState advancement indirectly: a redrive that then DRAINS proves
    // iteration incremented and prevPredicates was carried (drained on cycle 1).
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), withPlanWork(["G2"]), ALL_FALSE]),
    });

    expect(result.action).toBe(AutoAction.STOP_DRAINED);
    // Two redrives (G1->G2, G2->drained) before the drained verdict.
    expect(result.iterations).toBe(2);
    expect(api.prompts.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T466: runtime signals — quota detection and compaction.
// ---------------------------------------------------------------------------

describe("T466 signals: simulated 429 → STOP_QUOTA", () => {
  test("quotaHitRef set to true before the cycle → STOP_QUOTA on that cycle", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // Simulate a 429 arriving (as if from the after_provider_response event)
    // before the driver reads signals.
    const quotaHitRef: QuotaHitRef = { value: true };

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"])]),
      quotaHitRef,
    });

    expect(result.action).toBe(AutoAction.STOP_QUOTA);
    expect(result.iterations).toBe(0);
    // Only one launch; no redrive.
    expect(api.prompts).toEqual(["/plan"]);
  });

  test("quotaHitRef resets to false after being read, so a second run can proceed", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // First run: quotaHit is true → STOP_QUOTA.
    const quotaHitRef: QuotaHitRef = { value: true };
    const first = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"])]),
      quotaHitRef,
    });
    expect(first.action).toBe(AutoAction.STOP_QUOTA);

    // The loop reset quotaHitRef.value to false after reading it.
    expect(quotaHitRef.value).toBe(false);

    // Second run (new ref reset by the caller, as registerAutoDriver does):
    const events2: string[] = [];
    const api2 = makeFakeApi(events2);
    const ctx2 = makeFakeCtx({ events: events2 });
    const second = await runAutoDriver({
      ctx: ctx2,
      api: api2,
      preset: planPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
      quotaHitRef, // ref is now false → should not stop_quota
    });
    expect(second.action).toBe(AutoAction.STOP_DRAINED);
  });
});

describe("T466 signals: contextPercent > 0.80 → compact then redrive", () => {
  test("contextPercent above threshold triggers compact(), then redrives to STOP_DRAINED", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);

    let compactCalled = false;
    // Cycle 0: context over threshold → COMPACT_THEN_REDRIVE.
    // Cycle 1: after compaction, context usage is unknown (null) → REDRIVE.
    // Cycle 2: drained.
    let callCount = 0;
    const ctx = makeFakeCtx({
      events,
      onCompact: () => { compactCalled = true; },
      // Pi reports 85 (0..100 scale) on first sample → 0.85 fraction → above COMPACT_THRESHOLD.
      // Null afterwards (simulating post-compact state where token count is unknown).
      contextPercent: () => {
        callCount++;
        return callCount === 1 ? 85 : null; // Pi 0..100 scale
      },
    });

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      // Cycle 0: pPlan work (will trigger COMPACT_THEN_REDRIVE due to context%).
      // Cycle 1: still pPlan work (context is now null, so no compact; redrive).
      // Cycle 2: drained.
      getPredicates: scriptedOracle([withPlanWork(["G1"]), withPlanWork(["G2"]), ALL_FALSE]),
    });

    expect(compactCalled).toBe(true);
    // compact is in the events log.
    expect(events).toContain("compact");
    expect(result.action).toBe(AutoAction.STOP_DRAINED);
    // 2 redrives after initial launch: compact+redrive cycle + normal redrive.
    expect(result.iterations).toBe(2);
  });

  test("compact() is awaited before redriving: compact precedes the next send in event order", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({
      events,
      // Only first cycle reports high context usage.
      contextPercent: () => {
        // Pi reports 90 (0..100 scale) → 0.9 fraction → above COMPACT_THRESHOLD on first sample.
        // Null afterward (post-compact unknown state).
        const high = events.filter((e) => e.startsWith("send:")).length === 1;
        return high ? 90 : null; // Pi 0..100 scale
      },
    });

    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    // Verify ordering: launch → await → compact → send (redrive) → await.
    const compactIdx = events.indexOf("compact");
    const sends = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.startsWith("send:"))
      .map(({ i }) => i);
    // The compact must appear BEFORE the second send (the redrive prompt).
    expect(compactIdx).toBeGreaterThan(-1);
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(compactIdx).toBeLessThan(sends[1]!);
  });
});

describe("T466 signals: contextPercent null → no compaction", () => {
  test("null contextPercent does not trigger compaction even when predicates are not terminal", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, contextPercent: null });

    let compactCalled = false;
    const ctxWithCompactSpy: DriverContext = {
      ...ctx,
      compact(options?: { onComplete?: (result: unknown) => void }): void {
        compactCalled = true;
        options?.onComplete?.(undefined);
      },
    };

    await runAutoDriver({
      ctx: ctxWithCompactSpy,
      api,
      preset: planPreset,
      // One redrive then drained — contextPercent is null throughout.
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    expect(compactCalled).toBe(false);
    expect(events).not.toContain("compact");
  });
});
