import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const LEDGER_STATUS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "pi-extensions", "ledger-status");
const EXTENSION_PATH = path.join(LEDGER_STATUS_ROOT, "index.ts");
const ESCAPE_PROBE_PATH = path.join(LEDGER_STATUS_ROOT, "test-fixtures", "escape-probe.ts");
const EXIT_CODE_PROBE_PATH = path.join(LEDGER_STATUS_ROOT, "test-fixtures", "exit-code-probe.ts");
const PINNED_NODE_PATH = path.join(LEDGER_STATUS_ROOT, "test-fixtures", "pinned-node.ts");
const RESOLVE_HOOK_PATH = path.join(
  LEDGER_STATUS_ROOT,
  "test-fixtures",
  "ts-extension-resolve-hook.mjs",
);

type EventName = "session_start" | "turn_end" | "tool_execution_end" | "session_shutdown";
type ErrorPhase = "counts" | "paint" | "terminal";

interface StatusContext {
  cwd: string;
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

type Handler = (event: { type: string }, context: StatusContext) => void;

interface RegistrationApi {
  on(event: EventName, handler: Handler): void;
}

interface LedgerStatusModule {
  registerLedgerStatus(
    api: RegistrationApi,
    options: {
      runCounts: (cwd: string) => Promise<string>;
      setIntervalFn: (callback: () => void, milliseconds: number) => unknown;
      clearIntervalFn: (handle: unknown) => void;
      onError: (error: unknown, phase: ErrorPhase) => void;
    },
  ): void;
}

interface PinnedNodeModule {
  resolvePinnedNode(environment?: NodeJS.ProcessEnv): {
    readonly nodePath: string;
    readonly version: string;
  };
}

interface Scenario {
  readonly name: string;
  readonly trigger: "session_start" | "turn_end" | "tool_execution_end";
  readonly hasUI: boolean;
  readonly outcome: "fulfilled" | "rejected";
  readonly stale?: boolean;
  readonly shutdownBeforeSettlement?: boolean;
  readonly alwaysThrow?: boolean;
  readonly expectedPhases: Readonly<Record<ErrorPhase, number>>;
  readonly expectedUiCalls: number;
  readonly expectedLiveUiCallsAfterShutdown: number;
}

interface ScenarioObservation {
  readonly phases: Readonly<Record<ErrorPhase, number>>;
  readonly phaseMessages: Readonly<Record<ErrorPhase, readonly string[]>>;
  readonly uiCalls: number;
  readonly liveUiCallsAfterShutdown: number;
}

const COUNTS = JSON.stringify({ ledgerSummaries: [] });
const SCENARIOS: Scenario[] = [
  {
    name: "S1-REPRO-2",
    trigger: "session_start",
    hasUI: true,
    outcome: "fulfilled",
    stale: true,
    expectedPhases: { counts: 0, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S2-REPRO-1",
    trigger: "turn_end",
    hasUI: true,
    outcome: "rejected",
    stale: true,
    expectedPhases: { counts: 1, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S3-CONTROL-A",
    trigger: "tool_execution_end",
    hasUI: false,
    outcome: "fulfilled",
    expectedPhases: { counts: 0, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S4-CONTROL-B",
    trigger: "tool_execution_end",
    hasUI: true,
    outcome: "fulfilled",
    alwaysThrow: true,
    expectedPhases: { counts: 0, paint: 1, terminal: 0 },
    expectedUiCalls: 1,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S5-live-fulfilled",
    trigger: "turn_end",
    hasUI: true,
    outcome: "fulfilled",
    shutdownBeforeSettlement: true,
    expectedPhases: { counts: 0, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S5-stale",
    trigger: "session_start",
    hasUI: true,
    outcome: "fulfilled",
    stale: true,
    shutdownBeforeSettlement: true,
    expectedPhases: { counts: 0, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S5-live-rejected",
    trigger: "turn_end",
    hasUI: true,
    outcome: "rejected",
    shutdownBeforeSettlement: true,
    expectedPhases: { counts: 0, paint: 0, terminal: 0 },
    expectedUiCalls: 0,
    expectedLiveUiCallsAfterShutdown: 0,
  },
  {
    name: "S6",
    trigger: "session_start",
    hasUI: true,
    outcome: "rejected",
    alwaysThrow: true,
    expectedPhases: { counts: 1, paint: 1, terminal: 0 },
    expectedUiCalls: 1,
    expectedLiveUiCallsAfterShutdown: 0,
  },
];

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function importLedgerStatus(): Promise<LedgerStatusModule> {
  return (await import(EXTENSION_PATH)) as LedgerStatusModule;
}

async function observeScenario(scenario: Scenario): Promise<ScenarioObservation> {
  const { registerLedgerStatus } = await importLedgerStatus();
  const handlers = new Map<EventName, Handler>();
  const api: RegistrationApi = {
    on(event, handler): void {
      handlers.set(event, handler);
    },
  };
  let shutdown = false;
  let uiCalls = 0;
  let liveUiCallsAfterShutdown = 0;
  let resolveCounts: ((stdout: string) => void) | undefined;
  let rejectCounts: ((error: Error) => void) | undefined;
  const phases: Record<ErrorPhase, number> = { counts: 0, paint: 0, terminal: 0 };
  const phaseMessages: Record<ErrorPhase, string[]> = { counts: [], paint: [], terminal: [] };
  const context: StatusContext = {
    cwd: REPO_ROOT,
    get hasUI(): boolean {
      if (scenario.stale) {
        throw new Error(`${scenario.name}: stale or torn-down UI`);
      }
      return scenario.hasUI;
    },
    ui: {
      setStatus(): void {
        uiCalls += 1;
        if (shutdown && !scenario.stale) liveUiCallsAfterShutdown += 1;
        if (scenario.alwaysThrow) {
          throw new Error(`${scenario.name}: stale or torn-down UI`);
        }
      },
    },
  };

  registerLedgerStatus(api, {
    runCounts: () =>
      new Promise<string>((resolve, reject) => {
        resolveCounts = resolve;
        rejectCounts = reject;
      }),
    setIntervalFn: () => Symbol("guard-poll"),
    clearIntervalFn: () => undefined,
    onError: (error, phase) => {
      phases[phase] += 1;
      phaseMessages[phase].push(error instanceof Error ? error.message : String(error));
    },
  });

  const start = handlers.get(scenario.trigger);
  const stop = handlers.get("session_shutdown");
  if (start === undefined || stop === undefined) {
    throw new Error(`${scenario.name}: extension omitted a required lifecycle handler`);
  }
  start({ type: scenario.trigger }, context);
  if (scenario.shutdownBeforeSettlement) {
    shutdown = true;
    stop({ type: "session_shutdown" }, context);
  }
  if (scenario.outcome === "fulfilled") {
    if (resolveCounts === undefined) throw new Error(`${scenario.name}: runCounts did not start`);
    resolveCounts(COUNTS);
  } else {
    if (rejectCounts === undefined) throw new Error(`${scenario.name}: runCounts did not start`);
    rejectCounts(new Error(`${scenario.name}: runCounts rejected`));
  }
  await flush();
  await flush();

  return { phases, phaseMessages, uiCalls, liveUiCallsAfterShutdown };
}

describe("ledger-status teardown safety Arm A: in-process seams", () => {
  test("refresh has one shared paint site outside its catch blocks", () => {
    const source = readFileSync(EXTENSION_PATH, "utf8");
    const refresh = source.slice(
      source.indexOf("  async function refresh"),
      source.indexOf("\n\n  // Chosen event names"),
    );

    expect(Array.from(refresh.matchAll(/\bsetStatus\(ctx, /g))).toHaveLength(1);
    expect(refresh).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*\bsetStatus\(/s);
    expect(refresh).toMatch(/const stdout = await runCounts\(ctx\.cwd\);\s*if \(!active\) return;/);
    expect(refresh).toMatch(/catch \(err\) \{\s*if \(!active\) return;\s*onError\?\.\(err, "counts"\);/);
    expect(refresh).toMatch(/if \(!active\) return;\s*try \{\s*setStatus\(ctx, text\);/);
  });

  test.each(SCENARIOS)("$name", async (scenario) => {
    const observation = await observeScenario(scenario);
    expect(observation.phases).toEqual(scenario.expectedPhases);
    expect(observation.uiCalls).toBe(scenario.expectedUiCalls);
    expect(observation.liveUiCallsAfterShutdown).toBe(scenario.expectedLiveUiCallsAfterShutdown);

    if (scenario.expectedPhases.counts === 1) {
      expect(observation.phaseMessages.counts).toEqual([`${scenario.name}: runCounts rejected`]);
    }
    if (scenario.expectedPhases.paint === 1) {
      expect(observation.phaseMessages.paint).toEqual([`${scenario.name}: stale or torn-down UI`]);
    }
    if (scenario.expectedPhases.terminal === 1) {
      expect(observation.phaseMessages.terminal).toEqual([`${scenario.name}: stale or torn-down UI`]);
    }
  });

  test("poll reports a marker paint rejection without a terminal catch", async () => {
    const { registerLedgerStatus } = await importLedgerStatus();
    const handlers = new Map<EventName, Handler>();
    let poll: (() => void) | undefined;
    let paintFails = false;
    const phases: Record<ErrorPhase, number> = { counts: 0, paint: 0, terminal: 0 };
    const context: StatusContext = {
      cwd: REPO_ROOT,
      hasUI: false,
      ui: {
        setStatus(): void {
          if (paintFails) throw new Error("poll: stale or torn-down UI");
        },
      },
    };
    const api: RegistrationApi = {
      on(event, handler): void {
        handlers.set(event, handler);
      },
    };
    registerLedgerStatus(api, {
      runCounts: async () => COUNTS,
      setIntervalFn: (callback) => {
        poll = callback;
        return Symbol("guard-poll");
      },
      clearIntervalFn: () => undefined,
      onError: (_error, phase) => {
        phases[phase] += 1;
      },
    });

    const start = handlers.get("session_start");
    if (start === undefined) throw new Error("poll control: extension omitted session_start");
    start({ type: "session_start" }, context);
    await flush();
    await flush();
    context.hasUI = true;
    paintFails = true;
    if (poll === undefined) throw new Error("poll control: extension omitted the poll callback");
    poll();
    await flush();
    await flush();

    expect(phases).toEqual({ counts: 0, paint: 1, terminal: 0 });
  });
});

describe("ledger-status teardown safety Arm B: pinned-node process boundary", () => {
  test("all process scenarios contain refresh rejection and the exit-code fixture returns zero", async () => {
    const { resolvePinnedNode } = (await import(PINNED_NODE_PATH)) as PinnedNodeModule;
    const resolution = resolvePinnedNode();
    const probe = spawnSync(
      resolution.nodePath,
      ["--import", RESOLVE_HOOK_PATH, ESCAPE_PROBE_PATH],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    if (probe.error !== undefined) throw probe.error;

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probe.stdout).toContain("FIXTURE-READY\n");
    expect(probe.stdout).toContain("NO-HOOK-OBSERVATION=status=1; signature=ERR_MODULE_NOT_FOUND\n");
    expect(probe.stdout).toContain("REGISTER-HOOKS-TYPE=function\n");

    const escaped = Array.from(
      probe.stdout.matchAll(/^(\S+) escaped-counts=(\d+)$/gm),
      (match) => [match[1], Number(match[2])],
    );
    expect(escaped).toEqual(SCENARIOS.map((scenario) => [scenario.name, 0]));
    expect(probe.stdout).not.toContain("FRAME ");
    expect(probe.stdout).toContain("S5-live-fulfilled ui-calls-after-shutdown=0\n");
    expect(probe.stdout).toContain("S5-stale ui-calls-after-shutdown=0\n");
    expect(probe.stdout).toContain("S5-live-rejected ui-calls-after-shutdown=0\n");
    expect(probe.stdout).toContain("S5-live-rejected counts-notification-after-shutdown=0\n");

    const exitProbe = spawnSync(resolution.nodePath, [EXIT_CODE_PROBE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (exitProbe.error !== undefined) throw exitProbe.error;
    expect(exitProbe.stdout).toBe("TURN-OUTPUT-OK\n");
    expect(exitProbe.stderr).toBe("");
    expect(exitProbe.status).toBe(0);
    expect(exitProbe.signal).toBeNull();
  });

  test("CQ_TEST_PINNED_NODE names a usable executable or resolution fails loudly", async () => {
    const { resolvePinnedNode } = (await import(PINNED_NODE_PATH)) as PinnedNodeModule;
    const nonexistent = path.join(REPO_ROOT, "result", "T1199-nonexistent-node");
    expect(() =>
      resolvePinnedNode({
        ...process.env,
        CQ_TEST_PINNED_NODE: nonexistent,
      }),
    ).toThrow(`CQ_TEST_PINNED_NODE: cannot use executable ${nonexistent}`);
  });
});
