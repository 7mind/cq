// false-drained-regression.test.ts — e2e regression for the false-DRAINED defect
// (T480, G-auto-driver; defends the T478 oracle re-point from cq advance-gate to
// cq predicates).
//
// ## What this regression proves (reproduction-first, Q242)
//
// The demo (demo/e2e-demo.ts) Scenario 1 and the runbook
// (docs/drafts/20260615-1915-pi-auto-driver-demo.md §3) recorded
// `action=STOP_DRAINED, iterations=0` as a [PASS] when the auto-driver oracle
// shelled `cq advance-gate`. That was a FALSE-PASS: against an ACTIONABLE ledger
// (an open high-severity defect ⇒ pInvestigate TRUE) the marker-gated
// `cq advance-gate` returns ALL-FALSE predicates whenever the per-session advance
// marker is ABSENT (the "pi situation" — see
// cq-cli/test/advance-gate-false-drained.test.ts, T474). All-false ⇒
// advanceAutoPreset.terminalPredicate ⇒ decideNextAction returns STOP_DRAINED on
// cycle 0, draining a run that still had work. The T478 fix re-points the oracle
// at `cq predicates`, which ALWAYS reads the ledger (no marker), so it reports the
// REAL actionable predicate and the driver does NOT drain.
//
// This test pins BOTH channels against the SAME seeded actionable ledger and
// asserts the divergence:
//   (1) OLD channel — source `cq advance-gate` with the marker ABSENT (a fresh,
//       empty XDG_RUNTIME_DIR) ⇒ all-false ⇒ decideNextAction == STOP_DRAINED
//       on cycle 0 (the documented-wrong outcome we are guarding against).
//   (2) NEW channel — getPredicates(ctx) from ./oracle, the production parser,
//       fed the source `cq predicates` stdout ⇒ pInvestigate TRUE ⇒
//       decideNextAction is NOT STOP_DRAINED on cycle 0.
//
// The regression FAILS if the oracle were reverted to advance-gate: channel (2)'s
// assertion (pInvestigate TRUE ⇒ not drained) is exactly what advance-gate
// CANNOT satisfy without a marker — so a revert collapses (2) onto (1)'s
// all-false/STOP_DRAINED outcome and this test goes red.
//
// ## CLI invocation discipline (CRITICAL — T480 environment fact)
//
// The `cq` binary on PATH is a STALE nix build WITHOUT the `cq predicates`
// subcommand (it ships only when the product is rebuilt — T482). Therefore this
// e2e invokes the SOURCE cq-cli `main.ts` directly via `bun run`, NEVER the
// deployed `cq`. The source CLI path and the seed script's host package are both
// resolved RELATIVE to this test file.
//
// ## Why getPredicates is fed the SOURCE CLI here
//
// oracle.ts's getPredicates() shells bare `cq` (CQ_COMMAND='cq'), which on the
// stale binary lacks `predicates`. To exercise the REAL predicate derivation
// deterministically we run the SOURCE `main.ts predicates` ourselves and feed its
// stdout through the oracle's PRODUCTION parser (parsePredicatesOutput, the same
// code path getPredicates uses after the shell-out). That isolates the channel's
// PARSE+DECIDE behaviour from the stale-binary spawn, while still asserting on the
// real `cq predicates` output and the real decision core.
//
// ## Package-isolation discipline
//
// The auto-driver package imports NOTHING from @cq/* in its source or this test.
// The ledger fixture is seeded by SHELLING OUT to a throwaway seed script that we
// write INTO the cq-cli package dir (so its `@cq/ledger` workspace symlink
// resolves) and remove in afterAll — exactly the "a TEST may shell the source CLI
// via bun run" allowance. No @cq import crosses into this package's module graph.

import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePredicatesOutput } from "./oracle";
import { decideNextAction, type AutoRunState, type AutoSignals } from "./decide";
import { AutoAction, advanceAutoPreset, type DerivedPredicates } from "./decision";

// --- Paths resolved relative to THIS test file (no absolute-path assumptions) ---

const HERE = path.dirname(fileURLToPath(import.meta.url));
// auto-driver/ -> pi-extensions/ -> pkg/ -> nix/ -> repoRoot
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CQ_CLI_PKG_DIR = path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers", "packages", "cq-cli");
const CQ_CLI_MAIN = path.join(CQ_CLI_PKG_DIR, "src", "main.ts");

/** Fixed fake session id; its marker is the file we deliberately never write. */
const FAKE_SESSION = "t480-false-drained-regression-session";

// --- Temp dir bookkeeping (mirrors the T474 fixture discipline) -----------------

const tempDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// The throwaway seed script lives in the cq-cli package dir so `@cq/ledger`
// resolves via that package's workspace symlink. Tracked here for afterAll cleanup.
let seedScriptPath: string | null = null;

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  if (seedScriptPath !== null) rmSync(seedScriptPath, { force: true });
});

// --- Fixture: an ACTIONABLE ledger (one open high-severity defect ⇒ pInvestigate) ---

/**
 * Seed a fresh fs-backed ledger root with one open high-severity defect, so the
 * shared derivePredicates engine reports pInvestigate TRUE. Built by shelling a
 * throwaway script (written into the cq-cli package dir so `@cq/ledger` resolves)
 * — this package never imports @cq itself. Replicates T474's
 * `seedActionableLedger` shape via @cq/ledger's FsLedgerStore.
 */
function seedActionableLedger(): string {
  const root = makeTmpDir("cq-t480-ledger-");
  if (seedScriptPath === null) {
    seedScriptPath = path.join(CQ_CLI_PKG_DIR, "_t480-regression-seed.ts");
    writeFileSync(
      seedScriptPath,
      [
        'import { FsLedgerStore, MILESTONES_AMBIENT_ID } from "@cq/ledger";',
        "const store = new FsLedgerStore({ root: process.argv[2] });",
        "await store.init();",
        'await store.createItem("defects", MILESTONES_AMBIENT_ID, {',
        '  status: "open",',
        '  fields: { headline: "a real, actionable defect", severity: "high" },',
        "});",
        "await store.dispose();",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  execFileSync("bun", [seedScriptPath, root], { cwd: CQ_CLI_PKG_DIR, encoding: "utf8" });
  return root;
}

// --- Channel invocations against the SOURCE CLI ---------------------------------

/**
 * Run the SOURCE `cq predicates --cwd <root>` and parse its stdout through the
 * oracle's PRODUCTION parser — the same parse path getPredicates() uses after its
 * shell-out. ALWAYS reads the ledger (no marker), so it reports the real predicates.
 */
function predicatesChannel(root: string): DerivedPredicates {
  const stdout = execFileSync("bun", ["run", CQ_CLI_MAIN, "predicates", "--cwd", root], {
    cwd: CQ_CLI_PKG_DIR,
    encoding: "utf8",
  });
  return parsePredicatesOutput(stdout.trim());
}

/**
 * Run the SOURCE `cq advance-gate --cwd <root> --session <fake>` with a FRESH,
 * EMPTY XDG_RUNTIME_DIR so the per-session advance marker is genuinely ABSENT
 * (the "pi situation"). The gate then short-circuits to ALLOW with ALL predicates
 * false WITHOUT reading the ledger — the false-DRAINED verdict.
 */
function advanceGateChannel(root: string): DerivedPredicates {
  const freshRuntimeDir = makeTmpDir("cq-t480-rt-");
  const stdout = execFileSync(
    "bun",
    ["run", CQ_CLI_MAIN, "advance-gate", "--cwd", root, "--session", FAKE_SESSION],
    { cwd: CQ_CLI_PKG_DIR, encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: freshRuntimeDir } },
  );
  const parsed = JSON.parse(stdout.trim()) as { predicates: DerivedPredicates };
  return parsed.predicates;
}

// --- Cycle-0 decision helper ----------------------------------------------------

/** A fresh cycle-0 run state + neutral signals (no quota, unknown context). */
function cycle0Decision(predicates: DerivedPredicates): AutoAction {
  const runState: AutoRunState = {
    iteration: 0,
    maxIterations: 25,
    prevPredicates: null,
    prevAction: null,
  };
  const signals: AutoSignals = { contextPercent: null, quotaHit: false };
  return decideNextAction({
    predicates,
    terminalPredicate: advanceAutoPreset.terminalPredicate,
    runState,
    signals,
  });
}

// --- Timeout constants ---------------------------------------------------------

/** Per-test timeout for cold subprocess shell-outs (seedActionableLedger, predicatesChannel, advanceGateChannel). */
const COLD_SHELLOUT_TIMEOUT_MS = 30_000;

// --- Env discipline: guard the ambient XDG_RUNTIME_DIR (T474 criticism fix) ------

// advanceGateChannel sets XDG_RUNTIME_DIR ONLY in the child spawn env, never on
// this process — so the parent's ambient value is not mutated. This afterEach
// restore is a belt-and-braces guard pinned to the value captured at module load.
const AMBIENT_XDG_RUNTIME_DIR = process.env["XDG_RUNTIME_DIR"];
afterEach(() => {
  if (AMBIENT_XDG_RUNTIME_DIR === undefined) delete process.env["XDG_RUNTIME_DIR"];
  else process.env["XDG_RUNTIME_DIR"] = AMBIENT_XDG_RUNTIME_DIR;
});

describe("auto-driver false-DRAINED regression (T480)", () => {
  test("OLD channel (advance-gate, marker absent) => all-false => STOP_DRAINED on cycle 0", () => {
    const root = seedActionableLedger();
    const predicates = advanceGateChannel(root);

    // The documented-wrong outcome: a marker-less gate sees nothing.
    expect(predicates.pInvestigate.value).toBe(false);
    expect(predicates.pPlan.value).toBe(false);
    expect(predicates.pImplement.value).toBe(false);
    expect(predicates.openQuestionGate.value).toBe(false);

    expect(cycle0Decision(predicates)).toBe(AutoAction.STOP_DRAINED);
  }, COLD_SHELLOUT_TIMEOUT_MS);

  test("NEW channel (cq predicates) => real pInvestigate TRUE => NOT STOP_DRAINED on cycle 0", () => {
    const root = seedActionableLedger();
    const predicates = predicatesChannel(root);

    // The REAL ledger actionability: the open high-severity defect drives
    // pInvestigate TRUE with the defect id named.
    expect(predicates.pInvestigate.value).toBe(true);
    expect(predicates.pInvestigate.items.length).toBeGreaterThan(0);

    // The fix's payoff: the driver must NOT drain a run that still has work.
    // A revert to advance-gate (marker absent) would make pInvestigate FALSE
    // here and flip this decision to STOP_DRAINED — turning this test red.
    expect(cycle0Decision(predicates)).not.toBe(AutoAction.STOP_DRAINED);
  }, COLD_SHELLOUT_TIMEOUT_MS);

  test("the two channels DIVERGE on the same seeded ledger (the false-DRAINED gap)", () => {
    const root = seedActionableLedger();
    const gatePredicates = advanceGateChannel(root);
    const realPredicates = predicatesChannel(root);

    // Same ledger root, opposite pInvestigate verdicts — this gap IS the defect
    // the T478 oracle re-point closes.
    expect(gatePredicates.pInvestigate.value).toBe(false);
    expect(realPredicates.pInvestigate.value).toBe(true);

    expect(cycle0Decision(gatePredicates)).toBe(AutoAction.STOP_DRAINED);
    expect(cycle0Decision(realPredicates)).not.toBe(AutoAction.STOP_DRAINED);
  }, COLD_SHELLOUT_TIMEOUT_MS);
});
