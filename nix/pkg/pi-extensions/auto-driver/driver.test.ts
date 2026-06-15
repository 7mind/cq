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
  type DriverApi,
  type DriverContext,
} from "./driver";
import { AutoAction, type AutoPreset, type DerivedPredicates } from "./decision";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/** Records every injected prompt and the order of waitForIdle vs injection. */
interface FakeApi extends DriverApi {
  prompts: string[];
}

function makeFakeApi(events: string[]): FakeApi {
  return {
    prompts: [],
    sendUserMessage(content: string): void {
      this.prompts.push(content);
      events.push(`send:${content}`);
    },
  };
}

interface FakeCtxOptions {
  /** Records lifecycle ordering (send/await/compact) into a shared log. */
  events: string[];
  /** Whether compact() was called. */
  onCompact?: () => void;
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
    getContextUsage(): { percent: number | null } | undefined {
      return { percent: null };
    },
    compact(): void {
      opts.events.push("compact");
      opts.onCompact?.();
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
// sampleSignals (T465 placeholder seam).
// ---------------------------------------------------------------------------

describe("sampleSignals", () => {
  test("returns the T465 placeholder: contextPercent null, quotaHit false", () => {
    const events: string[] = [];
    const ctx = makeFakeCtx({ events });
    expect(sampleSignals(ctx)).toEqual({ contextPercent: null, quotaHit: false });
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
