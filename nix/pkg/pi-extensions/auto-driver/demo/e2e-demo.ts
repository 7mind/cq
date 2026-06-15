// e2e-demo.ts — headless end-to-end demo for the cq auto-driver (T470).
//
// Runs entirely headlessly: no interactive Pi TUI required. Exercises the REAL
// driver loop (runAutoDriver / registerAllAutoCommands from the production
// modules) via a FAITHFUL fake ctx/api that records every sendUserMessage
// injection and every ui.setStatus('cq-auto', ...) call into an ordered
// transition log.
//
// Three scenarios are demonstrated:
//   Scenario 1 — LIVE oracle: calls the REAL `cq advance-gate` CLI against this
//     repo's live ledger so a real predicate read is shown. The current ledger
//     state is printed as evidence.
//   Scenario 2 — DRAINED stop: fake oracle whose predicates progress to all-FALSE
//     across cycles, reaching STOP_DRAINED with status 'done (DRAINED)'. Also
//     shows the REDRIVE cycle (predicate still TRUE → corrective prompt naming
//     the violated predicate).
//   Scenario 3 — BLOCKED-ON-QUESTIONS stop: fake oracle returns an open-question
//     gate → STOP_BLOCKED_ON_QUESTIONS, no re-drive.
//
// The compaction and quota paths are exercised by unit tests in driver.test.ts;
// this demo focuses on the live oracle channel + the full status-bar lifecycle.
//
// Run with:
//   cd nix/pkg/pi-extensions/auto-driver && bun demo/e2e-demo.ts
// or from repo root:
//   bun run nix/pkg/pi-extensions/auto-driver/demo/e2e-demo.ts

import { runAutoDriver } from "../driver.ts";
import { registerAllAutoCommands } from "../index.ts";
import { advanceAutoPreset, type DerivedPredicates } from "../decision.ts";
import { getPredicates as liveGetPredicates } from "../oracle.ts";
import type {
  DriverApi,
  DriverContext,
  DriverUIContext,
  DriverRegistrationApi,
  DriverAfterProviderResponseEvent,
} from "../driver.ts";

// ---------------------------------------------------------------------------
// Helpers: ordered transition log.
// ---------------------------------------------------------------------------

interface LogEntry {
  kind: "status" | "send" | "info";
  text: string;
}

function printLog(log: LogEntry[], indent = "  "): void {
  for (const entry of log) {
    const prefix =
      entry.kind === "status"
        ? "[status-bar]"
        : entry.kind === "send"
          ? "[send-prompt]"
          : "[info]       ";
    console.log(`${indent}${prefix} ${entry.text}`);
  }
}

// ---------------------------------------------------------------------------
// Fake Pi ctx/api factory.
// ---------------------------------------------------------------------------

/** Build a faithful fake ctx/api pair that records all driver interactions. */
function makeFakePair(log: LogEntry[]): { ctx: DriverContext; api: DriverApi } {
  const ui: DriverUIContext = {
    setStatus(key: string, text: string | undefined): void {
      log.push({ kind: "status", text: `${key} = ${JSON.stringify(text)}` });
    },
  };

  const ctx: DriverContext = {
    cwd: process.cwd(),
    hasUI: true,
    ui,
    isIdle: () => true,
    waitForIdle: async () => {
      // Immediate resolution: the fake "agent" is always idle.
    },
    getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
    compact: (options?: { onComplete?: (result: unknown) => void }) => {
      log.push({ kind: "info", text: "compact() called" });
      options?.onComplete?.(undefined);
    },
  };

  const api: DriverApi = {
    sendUserMessage(content: string): void {
      // Truncate long redrive prompts for readability.
      const display = content.length > 100 ? content.slice(0, 100) + "…" : content;
      log.push({ kind: "send", text: display });
    },
    on(
      _event: "after_provider_response",
      _handler: (event: DriverAfterProviderResponseEvent) => void,
    ): void {
      // No-op: no real provider in the demo.
    },
  };

  return { ctx, api };
}

/** A getPredicates fake yielding a scripted sequence, repeating the last entry. */
function scriptedOracle(
  sequence: DerivedPredicates[],
): (ctx: { cwd: string }) => Promise<DerivedPredicates> {
  let i = 0;
  return async () => {
    const value = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return value;
  };
}

const ALL_FALSE: DerivedPredicates = {
  pInvestigate: { value: false, items: [] },
  pPlan: { value: false, items: [] },
  pImplement: { value: false, items: [] },
  openQuestionGate: { value: false, items: [] },
};

// ---------------------------------------------------------------------------
// Scenario 1: LIVE oracle — real `cq advance-gate` against this repo's ledger.
// ---------------------------------------------------------------------------

async function scenario1LiveOracle(): Promise<void> {
  console.log("=".repeat(72));
  console.log("Scenario 1: LIVE oracle — cq advance-gate against this repo's ledger");
  console.log("=".repeat(72));

  // Call the REAL oracle to show what the live ledger currently reports.
  let livePredicates: DerivedPredicates;
  try {
    livePredicates = await liveGetPredicates({ cwd: process.cwd() });
  } catch (err) {
    console.log(`  [ERROR] cq advance-gate failed: ${(err as Error).message}`);
    console.log("  => Skipping live oracle scenario.");
    return;
  }

  console.log("\n  Live predicate snapshot (from cq advance-gate):");
  console.log(`    pInvestigate  : value=${livePredicates.pInvestigate.value}  items=[${livePredicates.pInvestigate.items.join(", ")}]`);
  console.log(`    pPlan         : value=${livePredicates.pPlan.value}  items=[${livePredicates.pPlan.items.join(", ")}]`);
  console.log(`    pImplement    : value=${livePredicates.pImplement.value}  items=[${livePredicates.pImplement.items.join(", ")}]`);
  console.log(`    openQuestGate : value=${livePredicates.openQuestionGate.value}  items=[${livePredicates.openQuestionGate.items.join(", ")}]`);

  const terminal = advanceAutoPreset.terminalPredicate(livePredicates);
  console.log(`\n  advanceAutoPreset.terminalPredicate(live) = ${terminal}`);
  if (terminal) {
    console.log("  => All P-predicates are FALSE in this CWD's ledger snapshot.");
    console.log("     NOTE: this demo runs from the worktree package dir whose .cq/ is a stale");
    console.log("     snapshot — it does NOT necessarily reflect the live main-checkout ledger.");
    console.log("     The live main-checkout ledger may still have work outstanding (see runbook §2).");
    console.log("     Running cq:advance:auto against the live main ledger would REDRIVE if predicates are TRUE there.");
  } else {
    console.log("  => Some P-predicates are TRUE: ledger has work remaining.");
    console.log("     Running cq:advance:auto against the live ledger would REDRIVE before stopping.");
  }

  // Now drive the real advance preset using the live predicates (one-shot: supply
  // the already-fetched snapshot as a scripted oracle so we don't launch a second
  // shell-out, but the channel has already been proven above).
  const log: LogEntry[] = [];
  const { ctx, api } = makeFakePair(log);

  const result = await runAutoDriver({
    ctx,
    api,
    preset: advanceAutoPreset,
    getPredicates: scriptedOracle([livePredicates]),
    maxIterations: 5,
  });

  console.log("\n  Driver transition log (using live snapshot, fake waitForIdle):");
  printLog(log);
  console.log(`\n  Result: action=${result.action}, iterations=${result.iterations}`);
}

// ---------------------------------------------------------------------------
// Scenario 2: DRAINED stop — fake oracle progressing to all-FALSE.
//   Also exercises a REDRIVE cycle (predicate naming) and the full status-bar
//   transitions from the Q237 state list.
// ---------------------------------------------------------------------------

async function scenario2DrainedStop(): Promise<void> {
  console.log("\n" + "=".repeat(72));
  console.log("Scenario 2: DRAINED stop — fake oracle progresses to all-FALSE");
  console.log("=".repeat(72));

  // Sequence:
  //   cycle 0: pImplement TRUE (T470) → REDRIVE (corrective prompt names T470)
  //   cycle 1: pPlan TRUE (G99) → REDRIVE (corrective prompt names G99)
  //   cycle 2: all FALSE → STOP_DRAINED

  const cycle0: DerivedPredicates = {
    pInvestigate: { value: false, items: [] },
    pPlan: { value: false, items: [] },
    pImplement: { value: true, items: ["T470"] },
    openQuestionGate: { value: false, items: [] },
  };
  const cycle1: DerivedPredicates = {
    pInvestigate: { value: false, items: [] },
    pPlan: { value: true, items: ["G99"] },
    pImplement: { value: false, items: [] },
    openQuestionGate: { value: false, items: [] },
  };

  const log: LogEntry[] = [];
  const { ctx, api } = makeFakePair(log);

  const result = await runAutoDriver({
    ctx,
    api,
    preset: advanceAutoPreset,
    getPredicates: scriptedOracle([cycle0, cycle1, ALL_FALSE]),
    maxIterations: 10,
  });

  console.log("\n  Ordered transition log (status-bar states + injected prompts):");
  printLog(log);
  console.log(`\n  Result: action=${result.action}, iterations=${result.iterations}`);
  console.log(`  Expected: action=STOP_DRAINED, iterations=2`);
  if (result.action !== "STOP_DRAINED") {
    console.log("  [FAIL] Unexpected action.");
    process.exit(1);
  }
  console.log("  [PASS]");
}

// ---------------------------------------------------------------------------
// Scenario 3: BLOCKED-ON-QUESTIONS — open-question gate set; no re-drive.
// ---------------------------------------------------------------------------

async function scenario3BlockedOnQuestions(): Promise<void> {
  console.log("\n" + "=".repeat(72));
  console.log("Scenario 3: BLOCKED-ON-QUESTIONS — openQuestionGate set (Q237)");
  console.log("=".repeat(72));

  const gated: DerivedPredicates = {
    pInvestigate: { value: false, items: [] },
    pPlan: { value: true, items: ["G42"] },
    pImplement: { value: false, items: [] },
    openQuestionGate: { value: true, items: ["Q237"] },
  };

  const log: LogEntry[] = [];
  const { ctx, api } = makeFakePair(log);

  const result = await runAutoDriver({
    ctx,
    api,
    preset: advanceAutoPreset,
    getPredicates: scriptedOracle([gated]),
    maxIterations: 10,
  });

  console.log("\n  Ordered transition log:");
  printLog(log);
  console.log(`\n  Result: action=${result.action}, iterations=${result.iterations}`);
  console.log(`  Expected: action=STOP_BLOCKED_ON_QUESTIONS, iterations=0, no re-drive prompt`);
  if (result.action !== "STOP_BLOCKED_ON_QUESTIONS") {
    console.log("  [FAIL] Unexpected action.");
    process.exit(1);
  }
  const redrivePrompts = log.filter(
    (e) => e.kind === "send" && !e.text.startsWith("/cq:advance"),
  );
  if (redrivePrompts.length > 0) {
    console.log("  [FAIL] Unexpected re-drive prompts emitted:", redrivePrompts);
    process.exit(1);
  }
  console.log("  [PASS] No re-drive prompt — correctly surfaced BLOCKED-ON-QUESTIONS.");
}

// ---------------------------------------------------------------------------
// Bonus: verify registerAllAutoCommands registers all four commands.
// ---------------------------------------------------------------------------

function scenario4Registration(): void {
  console.log("\n" + "=".repeat(72));
  console.log("Scenario 4: registerAllAutoCommands — all four presets registered");
  console.log("=".repeat(72));

  const registrations: Array<{ name: string; description: string | undefined }> = [];
  const fakeApi: DriverRegistrationApi = {
    sendUserMessage: () => {},
    on: () => {},
    registerCommand(
      name: string,
      opts: { description?: string; handler: unknown },
    ): void {
      void opts;
      registrations.push({ name, description: (opts as { description?: string }).description });
    },
  };

  registerAllAutoCommands(fakeApi);

  const names = registrations.map((r) => r.name);
  console.log("\n  Registered commands:");
  for (const r of registrations) {
    console.log(`    /${r.name}`);
    console.log(`      description: ${r.description}`);
  }

  const expected = [
    "cq:advance:auto",
    "cq:plan:auto",
    "cq:investigate:auto",
    "cq:implement:auto",
  ];
  const allPresent = expected.every((e) => names.includes(e));
  console.log(`\n  All four commands present: ${allPresent}`);
  if (!allPresent) {
    console.log("  [FAIL] Missing commands.");
    process.exit(1);
  }
  console.log("  [PASS]");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("cq auto-driver e2e demo (T470)");
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  await scenario1LiveOracle();
  await scenario2DrainedStop();
  await scenario3BlockedOnQuestions();
  scenario4Registration();

  console.log("\n" + "=".repeat(72));
  console.log("All demo scenarios completed.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
