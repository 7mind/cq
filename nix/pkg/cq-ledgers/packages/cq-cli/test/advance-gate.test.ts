/**
 * T367 / G44 (fixes D50) — the `cq advance-gate` verdict + exit-code CONTRACT.
 *
 * Drives `dispatch(['advance-gate', ...])` (→ `runAdvanceGate`) with a CAPTURED
 * {@link DispatchIo}, asserting BOTH the emitted NEUTRAL verdict JSON shape
 * `{ block, reason, predicates }` AND the resolved exit code, across ALL FOUR
 * verdict cases of decisions Q199–Q202 (see advanceGate.ts):
 *
 *   1. marker PRESENT + a TRUE-and-unblocked predicate ⇒ BLOCK (non-zero exit),
 *      reason names the predicate and carries `continue per D41`. Covered for
 *      BOTH a pInvestigate seed (actionable open defect) AND a pImplement seed
 *      (planned goal + DAG-ready task) so the block path is exercised for more
 *      than one predicate.
 *   2. marker PRESENT + an all-FALSE (here: empty/terminal) ledger ⇒ ALLOW
 *      (exit 0).
 *   3. marker ABSENT ⇒ ALLOW (exit 0) EVEN with a TRUE-predicate ledger — the
 *      gate does not engage, and does not even read the ledger, without the
 *      marker.
 *   4. marker PRESENT carrying a non-empty `external-signal: "..."` ⇒ ALLOW
 *      (exit 0) even with a TRUE predicate.
 *
 * The exhaustive derivePredicates semantics live in
 * `packages/ledger/test/predicates.test.ts`; THIS suite asserts only the CLI's
 * verdict/exit-code translation of those predicates. Each case seeds a fresh
 * temp ledger root, drives the marker dir via a temp `$XDG_RUNTIME_DIR`, writes
 * (or omits) the per-session marker, and cleans up its temp dirs in `afterAll`.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { EXIT_ALLOW, EXIT_BLOCK, type AdvanceGateVerdict } from "../src/advanceGate.js";
import { FsLedgerStore, MILESTONES_AMBIENT_ID, GOALS_LEDGER, TASKS_LEDGER } from "@cq/ledger";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[] } {
  const outs: string[] = [];
  return { outs, out: (l) => outs.push(l), err: () => {}, confirm: silentConfirm };
}

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SESSION_ID = "advance-gate-contract-session";

function markerFile(runtimeDir: string): string {
  return path.join(runtimeDir, `cq-advance-active-${SESSION_ID}`);
}

let runtimeDir: string;
let prevXdg: string | undefined;
beforeEach(async () => {
  // Point the marker dir at a temp dir so the test never collides with a real
  // /cq:advance run on the host. A fresh dir per test means no marker leaks
  // between cases — the marker-absent case (3) starts from a clean dir.
  runtimeDir = await makeTmpDir("cq-gate-rt-");
  prevXdg = process.env["XDG_RUNTIME_DIR"];
  process.env["XDG_RUNTIME_DIR"] = runtimeDir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env["XDG_RUNTIME_DIR"];
  else process.env["XDG_RUNTIME_DIR"] = prevXdg;
});

/** Parse the SOLE stdout line as the neutral verdict JSON. */
function parseVerdict(io: { outs: string[] }): AdvanceGateVerdict {
  expect(io.outs.length).toBe(1);
  return JSON.parse(io.outs[0]!) as AdvanceGateVerdict;
}

/** Run the gate against `root` for the fixed test session; return outcome+verdict. */
async function runGate(root: string): Promise<{ exitCode: number; verdict: AdvanceGateVerdict }> {
  const io = recordingIo();
  const outcome = await dispatch(["advance-gate", "--cwd", root, "--session", SESSION_ID], io);
  return { exitCode: outcome.exitCode, verdict: parseVerdict(io) };
}

/** Seed a fresh ledger root making P-investigate TRUE (one actionable open defect). */
async function seedInvestigateLedger(): Promise<string> {
  const root = await makeTmpDir("cq-gate-ledger-");
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "open",
    fields: { headline: "a real defect", severity: "high" },
  });
  await store.dispose();
  return root;
}

/**
 * Seed a fresh ledger root making P-implement TRUE: a goal in `planned` with a
 * DAG-ready (non-terminal, no deps, no gating question) task linked to it.
 */
async function seedImplementLedger(): Promise<string> {
  const root = await makeTmpDir("cq-gate-ledger-");
  const store = new FsLedgerStore({ root });
  await store.init();
  const goal = await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { title: "g", description: "d" },
  });
  await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { headline: "ready", ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`] },
  });
  await store.dispose();
  return root;
}

/** Seed a fresh, EMPTY (all-FALSE) ledger root — init only, no items. */
async function seedEmptyLedger(): Promise<string> {
  const root = await makeTmpDir("cq-gate-ledger-");
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.dispose();
  return root;
}

describe("cq advance-gate — verdict + exit-code contract (T367)", () => {
  // --- Case 1: marker PRESENT + TRUE predicate ⇒ BLOCK (non-zero) -----------

  it("(1a) marker present + P-investigate TRUE → block=true, non-zero exit, reason names predicate + 'continue per D41'", async () => {
    const root = await seedInvestigateLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_BLOCK);
    expect(exitCode).not.toBe(0);
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("P-investigate=TRUE");
    expect(verdict.reason).toContain("continue per D41");
    expect(verdict.predicates.pInvestigate.value).toBe(true);
    expect(verdict.predicates.pInvestigate.items.length).toBeGreaterThan(0);
  });

  it("(1b) marker present + P-implement TRUE → block=true, non-zero exit, reason names predicate + 'continue per D41'", async () => {
    const root = await seedImplementLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_BLOCK);
    expect(exitCode).not.toBe(0);
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("P-implement=TRUE");
    expect(verdict.reason).toContain("continue per D41");
    // No earlier-in-order predicate is TRUE, so P-implement is the named one.
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pPlan.value).toBe(false);
    expect(verdict.predicates.pImplement.value).toBe(true);
    expect(verdict.predicates.pImplement.items.length).toBeGreaterThan(0);
  });

  // --- Case 2: marker PRESENT + all-FALSE ledger ⇒ ALLOW (exit 0) -----------

  it("(2) marker present + all predicates FALSE → block=false, exit 0", async () => {
    const root = await seedEmptyLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_ALLOW);
    expect(verdict.block).toBe(false);
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pPlan.value).toBe(false);
    expect(verdict.predicates.pImplement.value).toBe(false);
  });

  // --- Case 3: marker ABSENT ⇒ ALLOW (exit 0) EVEN with a TRUE ledger -------

  it("(3) marker ABSENT → block=false, exit 0 even with a TRUE-predicate ledger (gate dormant, ledger not consulted)", async () => {
    // Seed an ACTIONABLE ledger, but write NO marker: the gate must allow
    // without engaging. The neutral JSON carries empty (unread) predicates.
    const root = await seedInvestigateLedger();

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_ALLOW);
    expect(verdict.block).toBe(false);
    // Marker-absent path does NOT read the ledger → predicates are the empty
    // placeholder (all FALSE) despite the actionable defect on disk.
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pInvestigate.items).toEqual([]);
  });

  // --- Case 4: marker WITH external-signal ⇒ ALLOW (exit 0) even if TRUE ----

  it("(4) marker present WITH external-signal → block=false, exit 0 even with a TRUE predicate", async () => {
    const root = await seedInvestigateLedger();
    await writeFile(markerFile(runtimeDir), 'external-signal: "user-interrupt"\n', "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_ALLOW);
    expect(verdict.block).toBe(false);
    // External-signal path short-circuits BEFORE reading the ledger → empty
    // predicates despite the actionable defect on disk.
    expect(verdict.predicates.pInvestigate.value).toBe(false);
  });
});
