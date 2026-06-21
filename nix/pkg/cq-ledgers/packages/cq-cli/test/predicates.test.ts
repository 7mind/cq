/**
 * T476 / Q241 — the `cq predicates` UNCONDITIONAL emitter contract.
 *
 * `cq predicates` differs from `cq advance-gate` in ONE decisive way: it has NO
 * session resolution and NO marker check — it ALWAYS reads the ledger via the
 * shared `derivePredicates` engine and ALWAYS prints the REAL predicates,
 * exiting 0. This is the fix for the "pi situation" (a harness with no advance
 * marker): advance-gate on the SAME root returns a false-DRAINED verdict (all
 * predicates false) because the marker is absent, whereas `cq predicates`
 * reports the TRUE predicates.
 *
 * This suite seeds an ACTIONABLE fs fixture (one open high-severity defect ⇒
 * P-investigate TRUE) where advance-gate WITHOUT a marker would return
 * false-DRAINED, and asserts:
 *   1. `cq predicates` (via runPredicates) returns the REAL non-empty predicates
 *      that match `derivePredicates(store)` on the same root (P-investigate
 *      TRUE with a non-empty items list), exit 0.
 *   2. The emitted stdout parses through the auto-driver oracle's parser SHAPE:
 *      `parsed.predicates` is an object carrying all four keys, each a
 *      `{ value: boolean, items: string[] }` verdict.
 *
 * The oracle's `parseAdvanceGateOutput` lives OUTSIDE this bun workspace
 * (nix/pkg/pi-extensions/auto-driver/oracle.ts imports nothing from `@cq/*`),
 * so it cannot be imported here; this test replicates its parsing contract —
 * read `parsed.predicates`, require the four keys, each `{ value, items }` —
 * over the actual `cq predicates` stdout to prove the shapes agree.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runPredicates, type PredicatesIo } from "../src/predicates.js";
import {
  FsLedgerStore,
  MILESTONES_AMBIENT_ID,
  createLedgerStore,
  derivePredicates,
} from "@cq/ledger";

/** The four predicate keys the oracle's parser requires, in canonical order. */
const PREDICATE_KEYS = ["pInvestigate", "pPlan", "pImplement", "openQuestionGate"] as const;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Seed a fresh fs-backed ledger root making P-investigate TRUE (one open high-severity defect). */
async function seedActionableLedger(): Promise<string> {
  const root = await makeTmpDir("cq-predicates-ledger-");
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "open",
    fields: { headline: "a real, actionable defect", severity: "high" },
  });
  await store.dispose();
  return root;
}

/** A capturing PredicatesIo recording every stdout line. */
function recordingIo(): PredicatesIo & { outs: string[] } {
  const outs: string[] = [];
  return { outs, out: (l) => outs.push(l), err: () => {} };
}

/** Narrow an arbitrary value to a string-keyed record (mirrors oracle.isRecord). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("cq predicates — unconditional real-predicate emitter (T476)", () => {
  it("returns the REAL non-empty predicates on an actionable fs ledger, exit 0, no session/marker", async () => {
    const root = await seedActionableLedger();

    const io = recordingIo();
    const outcome = await runPredicates({ cwd: root }, io);

    // ALWAYS exit 0 — predicates never blocks.
    expect(outcome.exitCode).toBe(0);
    expect(io.outs.length).toBe(1);

    // The emitted predicates MATCH derivePredicates(store) on the same root:
    // P-investigate is TRUE with a non-empty items list (the seeded defect).
    const { store } = await createLedgerStore(root);
    let expected;
    try {
      expected = derivePredicates(store);
    } finally {
      await store.dispose();
    }
    expect(expected.pInvestigate.value).toBe(true);
    expect(expected.pInvestigate.items.length).toBeGreaterThan(0);

    const parsed = JSON.parse(io.outs[0]!) as { predicates: typeof expected };
    expect(parsed.predicates.pInvestigate.value).toBe(true);
    expect(parsed.predicates.pInvestigate.items).toEqual(expected.pInvestigate.items);
    expect(parsed.predicates).toEqual(expected);
  });

  it("emits stdout that parses via the auto-driver oracle's parser SHAPE (parsed.predicates, 4 verdict keys)", async () => {
    const root = await seedActionableLedger();

    const io = recordingIo();
    await runPredicates({ cwd: root }, io);

    // Replicate the oracle's parseAdvanceGateOutput contract over the stdout.
    const parsed: unknown = JSON.parse(io.outs[0]!);
    expect(isRecord(parsed)).toBe(true);
    const predicates = (parsed as Record<string, unknown>)["predicates"];
    expect(isRecord(predicates)).toBe(true);
    const pred = predicates as Record<string, unknown>;
    for (const key of PREDICATE_KEYS) {
      const verdict = pred[key];
      expect(isRecord(verdict)).toBe(true);
      const v = verdict as Record<string, unknown>;
      expect(typeof v["value"]).toBe("boolean");
      expect(Array.isArray(v["items"])).toBe(true);
      expect((v["items"] as unknown[]).every((it) => typeof it === "string")).toBe(true);
    }
  });
});
