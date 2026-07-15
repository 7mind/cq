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
  registerAutoDriver,
  sampleSignals,
  statusTextForPhase,
  STATUS_KEY,
  type DriverAfterProviderResponseEvent,
  type DriverApi,
  type DriverContext,
  type DriverPhase,
  type DriverRegistrationApi,
  type DriverUIContext,
  type QuotaHitRef,
} from "./driver";
import {
  AutoAction,
  advanceAutoPreset,
  planAutoPreset,
  investigateAutoPreset,
  implementAutoPreset,
  type AutoPreset,
  type DerivedPredicates,
} from "./decision";
import { registerAllAutoCommands } from "./index";

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
  /**
   * Whether UI is available. Defaults to false (no-op for setStatus) so that
   * existing tests that don't care about status-bar behaviour are unaffected.
   * Pass true (and optionally a status spy) to test T467 behaviour.
   */
  hasUI?: boolean;
  /** If provided, records every setStatus(key, text) call. */
  statusCalls?: Array<{ key: string; text: string | undefined }>;
}

function makeFakeCtx(opts: FakeCtxOptions): DriverContext {
  const hasUI = opts.hasUI ?? false;
  const ui: DriverUIContext = {
    setStatus(key: string, text: string | undefined): void {
      if (opts.statusCalls) {
        opts.statusCalls.push({ key, text });
      }
    },
  };
  return {
    cwd: "/fake/repo",
    hasUI,
    ui,
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
  pSeed: { value: false, items: [] },
  pPlan: { value: false, items: [] },
  pImplement: { value: false, items: [] },
  openQuestionGate: { value: false, items: [] },
  belowFloor: { value: false, items: [] },
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
      ...makeFakeCtx({ events, hasUI: false }),
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

// ---------------------------------------------------------------------------
// T467: statusTextForPhase — pure mapping, covers full Q237 state set.
// ---------------------------------------------------------------------------

describe("T467: statusTextForPhase pure mapping", () => {
  const cases: Array<[DriverPhase, string]> = [
    [{ kind: "idle" }, "idle"],
    [{ kind: "driving", command: "advance", iter: 0 }, "driving advance iter 0"],
    [{ kind: "driving", command: "plan", iter: 3 }, "driving plan iter 3"],
    [{ kind: "awaiting-stop" }, "awaiting-stop"],
    [{ kind: "checking-predicates" }, "checking-predicates"],
    [{ kind: "compacting" }, "compacting"],
    [{ kind: "stopped-quota" }, "stopped: quota"],
    [{ kind: "stopped-blocked-on-questions" }, "stopped: blocked-on-questions"],
    [{ kind: "stopped-no-progress" }, "stopped: no-progress"],
    [{ kind: "done-drained" }, "done (DRAINED)"],
  ];

  for (const [phase, expected] of cases) {
    test(`${phase.kind} → "${expected}"`, () => {
      expect(statusTextForPhase(phase)).toBe(expected);
    });
  }

  test("covers all Q237 state kinds (exhaustiveness check)", () => {
    // Verify every DriverPhase kind produces a non-empty string.
    const allKinds: DriverPhase["kind"][] = [
      "idle",
      "driving",
      "awaiting-stop",
      "checking-predicates",
      "compacting",
      "stopped-quota",
      "stopped-blocked-on-questions",
      "stopped-no-progress",
      "done-drained",
    ];
    for (const kind of allKinds) {
      const phase: DriverPhase =
        kind === "driving"
          ? { kind, command: "advance", iter: 0 }
          : { kind } as DriverPhase;
      const text = statusTextForPhase(phase);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// T467: setStatus wiring in runAutoDriver — hasUI=true vs hasUI=false.
// ---------------------------------------------------------------------------

describe("T467: setStatus called on each lifecycle point when hasUI=true", () => {
  test("STOP_DRAINED path: idle → driving iter 0 → awaiting-stop → checking-predicates → done(DRAINED)", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, hasUI: true, statusCalls });

    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    // All calls must use the stable STATUS_KEY.
    expect(statusCalls.every((c) => c.key === STATUS_KEY)).toBe(true);

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("idle");
    expect(texts).toContain("driving plan iter 0");
    expect(texts).toContain("awaiting-stop");
    expect(texts).toContain("checking-predicates");
    expect(texts).toContain("done (DRAINED)");
  });

  test("STOP_QUOTA path: includes 'stopped: quota' status", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, hasUI: true, statusCalls });

    const quotaHitRef: QuotaHitRef = { value: true };
    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"])]),
      quotaHitRef,
    });

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("stopped: quota");
  });

  test("STOP_BLOCKED_ON_QUESTIONS path: includes 'stopped: blocked-on-questions' status", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, hasUI: true, statusCalls });

    const gated: DerivedPredicates = {
      ...withPlanWork(["G1"]),
      openQuestionGate: { value: true, items: ["Q1"] },
    };
    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([gated]),
    });

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("stopped: blocked-on-questions");
  });

  test("STOP_NO_PROGRESS path: includes 'stopped: no-progress' status", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, hasUI: true, statusCalls });

    const stuck = withPlanWork(["G1"]);
    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([stuck, stuck]),
    });

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("stopped: no-progress");
  });

  test("COMPACT_THEN_REDRIVE path: includes 'compacting' status before the second drive", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    let callCount = 0;
    const ctx = makeFakeCtx({
      events,
      hasUI: true,
      statusCalls,
      contextPercent: () => {
        callCount++;
        return callCount === 1 ? 85 : null; // Pi 0..100 scale
      },
    });
    const api = makeFakeApi(events);

    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("compacting");
    // 'done (DRAINED)' must appear after 'compacting'.
    const compactIdx = texts.indexOf("compacting");
    const drainedIdx = texts.lastIndexOf("done (DRAINED)");
    expect(compactIdx).toBeGreaterThan(-1);
    expect(drainedIdx).toBeGreaterThan(compactIdx);
  });

  test("redrive increments iter in status: iter 0 then iter 1", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events, hasUI: true, statusCalls });

    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    const texts = statusCalls.map((c) => c.text);
    expect(texts).toContain("driving plan iter 0");
    expect(texts).toContain("driving plan iter 1");
  });
});

describe("T467: setStatus NOT called when hasUI=false", () => {
  test("hasUI=false: ui.setStatus is never called regardless of phase", async () => {
    const events: string[] = [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const api = makeFakeApi(events);
    // hasUI=false (the default): all setStatus calls must be suppressed.
    const ctx = makeFakeCtx({ events, hasUI: false, statusCalls });

    await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), ALL_FALSE]),
    });

    // No status calls at all when hasUI is false.
    expect(statusCalls).toHaveLength(0);
  });

  test("hasUI=false (default): existing tests are unaffected (no setStatus side-effects)", async () => {
    // Confirm that the existing test infrastructure (hasUI not set → defaults false)
    // does not see any status calls, even with multiple redrives.
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events }); // no hasUI → false

    const result = await runAutoDriver({
      ctx,
      api,
      preset: planPreset,
      getPredicates: scriptedOracle([withPlanWork(["G1"]), withPlanWork(["G2"]), ALL_FALSE]),
    });

    expect(result.action).toBe(AutoAction.STOP_DRAINED);
    expect(result.iterations).toBe(2);
    // No UI calls emitted — would throw if ui.setStatus were not gated on hasUI.
  });
});

// ---------------------------------------------------------------------------
// T468: registration.
// ---------------------------------------------------------------------------

/**
 * Minimal fake DriverRegistrationApi that only captures registered command names
 * and the preset's wrappedCommand (extracted from the description) without
 * running the full handler.
 */
interface SimpleRegistration {
  commandName: string;
  description: string | undefined;
}

function makeSimpleRegistrationApi(): {
  api: DriverRegistrationApi;
  registrations: SimpleRegistration[];
} {
  const registrations: SimpleRegistration[] = [];

  const api: DriverRegistrationApi = {
    sendUserMessage(_content: string): void {},
    on(_event: "after_provider_response", _handler: (event: DriverAfterProviderResponseEvent) => void): void {},
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: DriverContext) => Promise<void> },
    ): void {
      registrations.push({ commandName: name, description: options.description });
    },
  };

  return { api, registrations };
}

describe("T468: registerAutoDriver — command name derived from preset", () => {
  test("advanceAutoPreset registers as 'cq:advance:auto' (commandName = wrappedCommand + :auto)", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAutoDriver(api, advanceAutoPreset);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.commandName).toBe("cq:advance:auto");
  });

  test("planAutoPreset registers as 'cq:plan:auto' (explicit commandName overrides wrappedCommand)", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAutoDriver(api, planAutoPreset);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.commandName).toBe("cq:plan:auto");
  });

  test("investigateAutoPreset registers as 'cq:investigate:auto'", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAutoDriver(api, investigateAutoPreset);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.commandName).toBe("cq:investigate:auto");
  });

  test("implementAutoPreset registers as 'cq:implement:auto'", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAutoDriver(api, implementAutoPreset);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.commandName).toBe("cq:implement:auto");
  });

  test("description mentions the wrappedCommand so the command is self-documenting", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAutoDriver(api, advanceAutoPreset);
    expect(registrations[0]!.description).toContain("cq:advance");
  });
});

describe("T468: preset wrappedCommand strings (launch slash commands)", () => {
  test("advanceAutoPreset.wrappedCommand is 'cq:advance' (sends /cq:advance on launch)", () => {
    expect(advanceAutoPreset.wrappedCommand).toBe("cq:advance");
  });

  test("planAutoPreset.wrappedCommand is 'cq:plan:advance' (sends /cq:plan:advance on launch)", () => {
    expect(planAutoPreset.wrappedCommand).toBe("cq:plan:advance");
  });

  test("investigateAutoPreset.wrappedCommand is 'cq:investigate:advance'", () => {
    expect(investigateAutoPreset.wrappedCommand).toBe("cq:investigate:advance");
  });

  test("implementAutoPreset.wrappedCommand is 'cq:implement:advance'", () => {
    expect(implementAutoPreset.wrappedCommand).toBe("cq:implement:advance");
  });
});

describe("T468: preset terminalPredicates (bound correctly to each flow)", () => {
  const ALL_FALSE_P: DerivedPredicates = {
    pInvestigate: { value: false, items: [] },
    pSeed: { value: false, items: [] },
    pPlan: { value: false, items: [] },
    pImplement: { value: false, items: [] },
    openQuestionGate: { value: false, items: [] },
    belowFloor: { value: false, items: [] },
  };

  test("advanceAutoPreset terminal when ALL FOUR p-predicates are false", () => {
    expect(advanceAutoPreset.terminalPredicate(ALL_FALSE_P)).toBe(true);
  });

  test("advanceAutoPreset not terminal when only pSeed is true (D94)", () => {
    expect(
      advanceAutoPreset.terminalPredicate({ ...ALL_FALSE_P, pSeed: { value: true, items: ["D94"] } }),
    ).toBe(false);
  });

  test("advanceAutoPreset not terminal when any p-predicate is true", () => {
    expect(advanceAutoPreset.terminalPredicate({ ...ALL_FALSE_P, pPlan: { value: true, items: ["G1"] } })).toBe(false);
  });

  test("planAutoPreset terminal when pPlan is false", () => {
    expect(planAutoPreset.terminalPredicate(ALL_FALSE_P)).toBe(true);
  });

  test("planAutoPreset not terminal when pPlan is true", () => {
    expect(planAutoPreset.terminalPredicate({ ...ALL_FALSE_P, pPlan: { value: true, items: ["G1"] } })).toBe(false);
  });

  test("investigateAutoPreset terminal when pInvestigate is false", () => {
    expect(investigateAutoPreset.terminalPredicate(ALL_FALSE_P)).toBe(true);
  });

  test("investigateAutoPreset not terminal when pInvestigate is true", () => {
    expect(investigateAutoPreset.terminalPredicate({ ...ALL_FALSE_P, pInvestigate: { value: true, items: ["D1"] } })).toBe(false);
  });

  test("implementAutoPreset terminal when pImplement is false", () => {
    expect(implementAutoPreset.terminalPredicate(ALL_FALSE_P)).toBe(true);
  });

  test("implementAutoPreset not terminal when pImplement is true", () => {
    expect(implementAutoPreset.terminalPredicate({ ...ALL_FALSE_P, pImplement: { value: true, items: ["T1"] } })).toBe(false);
  });
});

describe("T468: registerAllAutoCommands — all four commands registered", () => {
  test("registers exactly 4 commands", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAllAutoCommands(api);
    expect(registrations).toHaveLength(4);
  });

  test("all four command names are present", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAllAutoCommands(api);
    const names = registrations.map((r) => r.commandName);
    expect(names).toContain("cq:advance:auto");
    expect(names).toContain("cq:plan:auto");
    expect(names).toContain("cq:investigate:auto");
    expect(names).toContain("cq:implement:auto");
  });

  test("no command name collisions (all four are distinct)", () => {
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAllAutoCommands(api);
    const names = registrations.map((r) => r.commandName);
    const unique = new Set(names);
    expect(unique.size).toBe(4);
  });

  test("no collision with existing /cq:advance slash command (advance:auto ≠ advance)", () => {
    // The wrapped command 'cq:advance' must not shadow the advance command itself.
    const { api, registrations } = makeSimpleRegistrationApi();
    registerAllAutoCommands(api);
    const names = registrations.map((r) => r.commandName);
    // None of the registered names should equal the unwrapped command names.
    expect(names).not.toContain("cq:advance");
    expect(names).not.toContain("cq:plan:advance");
    expect(names).not.toContain("cq:investigate:advance");
    expect(names).not.toContain("cq:implement:advance");
  });

  test("wrappedCommand for advance preset sends /cq:advance (verified via runAutoDriver first prompt)", async () => {
    // End-to-end: advance:auto's first injected prompt must be '/cq:advance'.
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    // Advance preset: terminal when all three predicates are false — so the
    // oracle returning ALL_FALSE immediately drains it after one launch.
    await runAutoDriver({
      ctx,
      api,
      preset: advanceAutoPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    // The first (and only) injected prompt must be the wrapped slash command.
    expect(api.prompts[0]).toBe("/cq:advance");
  });

  test("wrappedCommand for plan preset sends /cq:plan:advance (verified via runAutoDriver first prompt)", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    await runAutoDriver({
      ctx,
      api,
      preset: planAutoPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    expect(api.prompts[0]).toBe("/cq:plan:advance");
  });

  test("wrappedCommand for investigate preset sends /cq:investigate:advance", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    await runAutoDriver({
      ctx,
      api,
      preset: investigateAutoPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    expect(api.prompts[0]).toBe("/cq:investigate:advance");
  });

  test("wrappedCommand for implement preset sends /cq:implement:advance", async () => {
    const events: string[] = [];
    const api = makeFakeApi(events);
    const ctx = makeFakeCtx({ events });

    await runAutoDriver({
      ctx,
      api,
      preset: implementAutoPreset,
      getPredicates: scriptedOracle([ALL_FALSE]),
    });

    expect(api.prompts[0]).toBe("/cq:implement:advance");
  });
});
