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

import { describe, it, expect, afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { EXIT_ALLOW, EXIT_BLOCK, type AdvanceGateVerdict } from "../src/advanceGate.js";
import {
  createLedgerStore,
  MILESTONES_AMBIENT_ID,
  GOALS_LEDGER,
  TASKS_LEDGER,
  type LedgerStore,
} from "@cq/ledger";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir so seeded state never touches the host.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = await makeTmpDir("cq-gate-xdg-");
});
afterAll(() => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
});

/**
 * A fresh xdg-backed ledger root: cq.toml pins backend='xdg' with an explicit
 * projectId (a plain temp dir has no git identity), so both the seed writes
 * and the gate's own read (runAdvanceGate → createLedgerStore) resolve the
 * same out-of-tree store.
 */
async function xdgRoot(): Promise<string> {
  const root = await makeTmpDir("cq-gate-ledger-");
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
    "utf8",
  );
  return root;
}

/** Seed `root`'s xdg store via `seed`, disposing the store afterwards. */
async function seedStore(root: string, seed: (store: LedgerStore) => Promise<void>): Promise<void> {
  const { store } = await createLedgerStore(root);
  try {
    await seed(store);
  } finally {
    await store.dispose();
  }
}

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
  const root = await xdgRoot();
  await seedStore(root, async (store) => {
    await store.createItem("defects", MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { headline: "a real defect", severity: "high" },
    });
  });
  return root;
}

/**
 * Seed a fresh ledger root making P-implement TRUE: a goal in `planned` with a
 * DAG-ready (non-terminal, no deps, no gating question) task linked to it.
 */
async function seedImplementLedger(): Promise<string> {
  const root = await xdgRoot();
  await seedStore(root, async (store) => {
    const goal = await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { title: "g", description: "d" },
    });
    await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "ready", ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`] },
    });
  });
  return root;
}

/** Seed a fresh, EMPTY (all-FALSE) ledger root — init only, no items. */
async function seedEmptyLedger(): Promise<string> {
  const root = await xdgRoot();
  await seedStore(root, async () => {});
  return root;
}

/**
 * Seed a fresh ledger root making P-seed TRUE: one root-caused HIGH defect owned
 * by no goal and gated by no question (the D94 fix-owning gap).
 */
async function seedSeedLedger(): Promise<string> {
  const root = await xdgRoot();
  await seedStore(root, async (store) => {
    await store.createItem("defects", MILESTONES_AMBIENT_ID, {
      status: "root-caused",
      fields: { headline: "root-caused, unowned, high", severity: "high" },
    });
  });
  return root;
}

/**
 * Seed a fresh ledger root with ONLY a below-floor root-caused defect (medium):
 * belowFloor names it, but NO stage predicate is TRUE, so the gate ALLOWS.
 */
async function seedBelowFloorLedger(): Promise<string> {
  const root = await xdgRoot();
  await seedStore(root, async (store) => {
    await store.createItem("defects", MILESTONES_AMBIENT_ID, {
      status: "root-caused",
      fields: { headline: "root-caused, unowned, medium", severity: "medium" },
    });
  });
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

  // --- Case 1c: marker PRESENT + P-seed TRUE ⇒ BLOCK (non-zero) -------------

  it("(1c) marker present + P-seed TRUE (root-caused unowned high defect) → block=true, non-zero exit, reason names P-seed", async () => {
    const root = await seedSeedLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_BLOCK);
    expect(exitCode).not.toBe(0);
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("P-seed=TRUE");
    expect(verdict.reason).toContain("continue per D41");
    // No earlier-in-order stage predicate is TRUE, so P-seed is the named one.
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pSeed.value).toBe(true);
    expect(verdict.predicates.pSeed.items.length).toBeGreaterThan(0);
  });

  // --- Case 2: marker PRESENT + all-FALSE ledger ⇒ ALLOW (exit 0) -----------

  it("(2) marker present + all predicates FALSE → block=false, exit 0", async () => {
    const root = await seedEmptyLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_ALLOW);
    expect(verdict.block).toBe(false);
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pSeed.value).toBe(false);
    expect(verdict.predicates.pPlan.value).toBe(false);
    expect(verdict.predicates.pImplement.value).toBe(false);
    expect(verdict.predicates.belowFloor.value).toBe(false);
  });

  // --- Case 2b: marker PRESENT + ONLY a below-floor defect ⇒ ALLOW ----------

  it("(2b) marker present + only a below-floor (medium) root-caused defect → block=false, exit 0, belowFloor names it but never gates", async () => {
    const root = await seedBelowFloorLedger();
    await writeFile(markerFile(runtimeDir), "started\n", "utf8");

    const { exitCode, verdict } = await runGate(root);

    expect(exitCode).toBe(EXIT_ALLOW);
    expect(verdict.block).toBe(false);
    // Every stage predicate is FALSE — belowFloor is informational only.
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pSeed.value).toBe(false);
    expect(verdict.predicates.pPlan.value).toBe(false);
    expect(verdict.predicates.pImplement.value).toBe(false);
    expect(verdict.predicates.belowFloor.value).toBe(true);
    expect(verdict.predicates.belowFloor.items.length).toBeGreaterThan(0);
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
    // placeholder (all FALSE) despite the actionable defect on disk. The full
    // six-key empty shape is emitted (pSeed + belowFloor included).
    expect(verdict.predicates.pInvestigate).toEqual({ value: false, items: [] });
    expect(verdict.predicates.pSeed).toEqual({ value: false, items: [] });
    expect(verdict.predicates.pPlan).toEqual({ value: false, items: [] });
    expect(verdict.predicates.pImplement).toEqual({ value: false, items: [] });
    expect(verdict.predicates.openQuestionGate).toEqual({ value: false, items: [] });
    expect(verdict.predicates.belowFloor).toEqual({ value: false, items: [] });
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
