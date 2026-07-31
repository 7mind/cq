import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

interface StatusContext {
  cwd: string;
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

type EventName = "session_start" | "turn_end" | "tool_execution_end" | "session_shutdown";
type Handler = (event: { type: string }, context: StatusContext) => void;

interface RegistrationApi {
  on(event: EventName, handler: Handler): void;
}

interface Scenario {
  name: string;
  hasUI: boolean;
  outcome: "fulfilled" | "rejected";
  stale?: boolean;
  shutdownBeforeSettlement?: boolean;
  alwaysThrow?: boolean;
}

const COUNTS = JSON.stringify({ ledgerSummaries: [] });
const require = createRequire(import.meta.url);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function noHookObservation(): void {
  if (process.argv.includes("--without-hook")) return;
  const child = spawnSync(process.execPath, [process.argv[1], "--without-hook"], { encoding: "utf8" });
  const signature = `${child.stderr}\n${child.stdout}`.match(/ERR_MODULE_NOT_FOUND|Cannot find module/)?.[0] ?? "unexpected";
  console.log(`NO-HOOK-OBSERVATION=status=${child.status ?? "signal"}; signature=${signature}`);
  if (child.status === 0 || signature === "unexpected") {
    throw new Error("extensionless ./counts unexpectedly loaded without a hook");
  }
}

async function runScenario(registerLedgerStatus: (api: RegistrationApi, options: { runCounts: () => Promise<string>; setIntervalFn: () => unknown; clearIntervalFn: () => void }) => void, scenario: Scenario): Promise<void> {
  const handlers = new Map<EventName, Handler>();
  const api: RegistrationApi = { on: (event, handler) => handlers.set(event, handler) };
  let settled = false;
  let shutdown = false;
  let escaped = 0;
  let uiCallsAfterShutdown = 0;
  let countsNotificationBeforeShutdown = 0;
  const frames: string[] = [];
  let resolveCounts: ((stdout: string) => void) | undefined;
  let rejectCounts: ((reason: Error) => void) | undefined;
  const runCounts = (): Promise<string> => {
    if (!shutdown) countsNotificationBeforeShutdown += 1;
    return new Promise<string>((resolve, reject) => {
      resolveCounts = resolve;
      rejectCounts = reject;
    });
  };
  const context: StatusContext = {
    cwd: process.cwd(),
    get hasUI(): boolean {
      if (scenario.stale) {
        throw new Error(`${scenario.name}: stale or torn-down UI`);
      }
      return scenario.hasUI;
    },
    ui: {
      setStatus(): void {
        if (shutdown && !scenario.stale) uiCallsAfterShutdown += 1;
        if (scenario.alwaysThrow) {
          throw new Error(`${scenario.name}: stale or torn-down UI`);
        }
      },
    },
  };
  const onUnhandled = (reason: unknown): void => {
    escaped += 1;
    const stack = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    frames.push(stack.split("\n").slice(0, 2).join(" | "));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    registerLedgerStatus(api, {
      runCounts,
      setIntervalFn: () => Symbol("fixture-poll"),
      clearIntervalFn: () => undefined,
    });
    const start = handlers.get("session_start");
    const stop = handlers.get("session_shutdown");
    if (start === undefined || stop === undefined) throw new Error(`${scenario.name}: missing lifecycle handler`);
    start({ type: "session_start" }, context);
    if (scenario.shutdownBeforeSettlement) {
      shutdown = true;
      stop({ type: "session_shutdown" }, context);
    }
    if (scenario.outcome === "fulfilled") resolveCounts?.(COUNTS);
    else rejectCounts?.(new Error(`${scenario.name}: runCounts rejected`));
    settled = true;
    await flush();
    await flush();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  if (!settled) throw new Error(`${scenario.name}: runCounts did not settle`);
  console.log(`${scenario.name} escaped-counts=${escaped}`);
  if (scenario.shutdownBeforeSettlement) console.log(`${scenario.name} ui-calls-after-shutdown=${uiCallsAfterShutdown}`);
  if (scenario.name === "S5-live-rejected") {
    if (countsNotificationBeforeShutdown !== 1) throw new Error("S5-live-rejected notification measurement failed");
    console.log(`S5-live-rejected counts-notification-before-shutdown=${countsNotificationBeforeShutdown}`);
  }
  for (const frame of frames) console.log(`FRAME ${scenario.name}: ${frame}`);
}

const indexUrl = new URL("../index.ts", import.meta.url).href;
const module = await import(indexUrl);
console.log("FIXTURE-READY");
if (!process.argv.includes("--without-hook")) noHookObservation();
console.log(`REGISTER-HOOKS-TYPE=${typeof require("node:module").registerHooks}`);

const scenarios: readonly Scenario[] = [
  { name: "S1-REPRO-2", hasUI: true, outcome: "fulfilled", stale: true },
  { name: "S2-REPRO-1", hasUI: true, outcome: "rejected", stale: true },
  { name: "S3-CONTROL-A", hasUI: false, outcome: "fulfilled" },
  { name: "S4-CONTROL-B", hasUI: true, outcome: "fulfilled", alwaysThrow: true },
  { name: "S5-live-fulfilled", hasUI: true, outcome: "fulfilled", shutdownBeforeSettlement: true },
  { name: "S5-stale", hasUI: true, outcome: "fulfilled", stale: true, shutdownBeforeSettlement: true },
  { name: "S5-live-rejected", hasUI: true, outcome: "rejected", shutdownBeforeSettlement: true },
  { name: "S6", hasUI: true, outcome: "rejected", alwaysThrow: true },
];
for (const scenario of scenarios) await runScenario(module.registerLedgerStatus, scenario);
