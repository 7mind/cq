/**
 * T474 — CHARACTERIZING test for the marker-gated false-DRAINED behaviour of
 * `cq advance-gate` (the Claude Stop-hook gate).
 *
 * ## What this characterises (and why it KEEPS PASSING after the predicates fix)
 *
 * `computeVerdict` (advanceGate.ts) is marker-GATED: when the per-session
 * advance marker is ABSENT it returns an ALLOW verdict with ALL predicates
 * `value:false` WITHOUT EVER reading the ledger (advanceGate.ts step 2). This is
 * the "pi situation": a fresh harness/session has no marker in its
 * `$XDG_RUNTIME_DIR`, so the gate reports DRAINED (block=false, every predicate
 * false) even when the ledger on disk is ACTIONABLE — a FALSE-DRAINED verdict.
 *
 * To make the divergence concrete, this test ALSO builds the store directly on
 * the SAME ledger root via `createLedgerStore(root)` + `derivePredicates(store)`
 * and asserts it returns a TRUE predicate. derivePredicates always reads the
 * ledger; the gate's marker short-circuit does not. The gap between the two is
 * the false-DRAINED defect.
 *
 * This is a CHARACTERIZATION test of the marker-gating *as it stands* — the gate
 * intentionally stays dormant without a marker (advance-gate.test.ts case 3
 * locks the same contract). The later `cq predicates` fix LEAVES the gate's
 * marker-gating UNCHANGED, so this test continues to pass after that fix: it
 * pins the divergence rather than the (unwanted) DRAINED message.
 *
 * Env discipline (T474 criticism fix): the ambient `$XDG_RUNTIME_DIR` is
 * captured ONCE at module load (a module-level const) and restored once in
 * `afterAll`, with per-test mutation paired by `beforeEach`/`afterEach`. This
 * avoids the asymmetric save/restore defect where a per-test `beforeEach`
 * capture re-reads an already-mutated env var and `afterAll` then restores a
 * deleted temp dir instead of the original ambient value.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { computeVerdict } from "../src/advanceGate.js";
import {
  MILESTONES_AMBIENT_ID,
  createLedgerStore,
  derivePredicates,
} from "@cq/ledger";

/** The fixed fake session id; its marker is the file we deliberately omit. */
const SESSION_ID = "advance-gate-false-drained-session";

let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir so seeded state never touches the host.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = await makeTmpDir("cq-false-drained-xdg-");
});
afterAll(() => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
});

/**
 * The AMBIENT `$XDG_RUNTIME_DIR`, captured ONCE at module load — BEFORE any
 * test mutates it. Restoring this value (not a per-test re-read) in `afterAll`
 * is the criticism fix: a per-`beforeEach` capture would re-read test N-1's
 * temp dir and leak/restore a deleted directory.
 */
const AMBIENT_XDG_RUNTIME_DIR = process.env["XDG_RUNTIME_DIR"];

const dirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

let runtimeDir: string;
beforeEach(async () => {
  // A FRESH, EMPTY temp runtime dir per test → the advance marker is genuinely
  // ABSENT (the pi situation: no marker ever written for this session).
  runtimeDir = await makeTmpDir("cq-false-drained-rt-");
  process.env["XDG_RUNTIME_DIR"] = runtimeDir;
});
afterEach(() => {
  // Symmetric per-test restore: pair the beforeEach mutation with the ambient
  // value captured ONCE at module load — never a re-read of the mutated env.
  if (AMBIENT_XDG_RUNTIME_DIR === undefined) delete process.env["XDG_RUNTIME_DIR"];
  else process.env["XDG_RUNTIME_DIR"] = AMBIENT_XDG_RUNTIME_DIR;
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Seed a fresh xdg-backed ledger root making P-investigate TRUE (one open
 * high-severity defect). cq.toml pins backend='xdg' with an explicit projectId
 * (a plain temp dir has no git identity) so the seed and the gate's own read
 * resolve the same out-of-tree store.
 */
async function seedActionableLedger(): Promise<string> {
  const root = await makeTmpDir("cq-false-drained-ledger-");
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
    "utf8",
  );
  const { store } = await createLedgerStore(root);
  try {
    await store.createItem("defects", MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { headline: "a real, actionable defect", severity: "high" },
    });
  } finally {
    await store.dispose();
  }
  return root;
}

describe("cq advance-gate — marker-gated false-DRAINED (T474 characterization)", () => {
  it("marker ABSENT (pi situation) → ALLOW with ALL predicates false, while derivePredicates on the SAME root returns TRUE", async () => {
    const root = await seedActionableLedger();

    // (1) The gate, with NO marker present (fresh empty $XDG_RUNTIME_DIR): it
    // short-circuits to ALLOW and never reads the ledger → every predicate false.
    const verdict = await computeVerdict({ cwd: root, session: SESSION_ID });

    expect(verdict.block).toBe(false);
    expect(verdict.predicates.pInvestigate.value).toBe(false);
    expect(verdict.predicates.pPlan.value).toBe(false);
    expect(verdict.predicates.pImplement.value).toBe(false);
    expect(verdict.predicates.openQuestionGate.value).toBe(false);

    // (2) The SAME root, read directly via the shared engine, IS actionable:
    // derivePredicates always reads the ledger, so P-investigate is TRUE. The
    // gap between (1) all-false and (2) TRUE is the false-DRAINED divergence.
    const { store } = await createLedgerStore(root);
    let truthy;
    try {
      truthy = derivePredicates(store);
    } finally {
      await store.dispose();
    }

    expect(truthy.pInvestigate.value).toBe(true);
    expect(truthy.pInvestigate.items.length).toBeGreaterThan(0);
  });
});
