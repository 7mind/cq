// oracle.test.ts — unit tests for parsePredicatesOutput (from ./oracle.ts).
//
// Standalone package test (option (a), mirroring decide.test.ts): lives beside
// the module under nix/pkg/pi-extensions/auto-driver/ (own package.json,
// `"test": "bun test"`), NOT part of the cq-ledgers workspace. Run with:
// `cd nix/pkg/pi-extensions/auto-driver && bun test`.
//
// The parser is exercised against the REAL `cq predicates` stdout shape. The
// sample below is a representative verdict from this repo's ledger (T463/T478
// verification) — `cq predicates` and `mcp__ledger__derive_predicates` return
// the identical `predicates` object shape. getPredicates itself shells out
// `cq predicates`; only the pure parser is unit-tested here.

import { describe, test, expect } from "bun:test";
import { parsePredicatesOutput } from "./oracle";
import { advanceAutoPreset, type DerivedPredicates } from "./decision";

// Representative `cq predicates` stdout (predicates shape identical to T463
// verification, now carrying the G77/M240 pSeed + belowFloor keys, the
// G80/M246 pResearch key, and the G84/D113 report-only goalDrift key).
const REAL_PREDICATES_STDOUT =
  '{"predicates":{"pInvestigate":{"value":true,"items":["D72","D73"]},"pSeed":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pResearch":{"value":false,"items":[]},"pImplement":{"value":true,"items":["T463"]},"openQuestionGate":{"value":false,"items":[]},"belowFloor":{"value":false,"items":[]},"goalDrift":{"value":false,"items":[]}}}';

describe("parsePredicatesOutput", () => {
  test("parses the real cq predicates verdict into all eight predicates", () => {
    const expected: DerivedPredicates = {
      pInvestigate: { value: true, items: ["D72", "D73"] },
      pSeed: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pResearch: { value: false, items: [] },
      pImplement: { value: true, items: ["T463"] },
      openQuestionGate: { value: false, items: [] },
      belowFloor: { value: false, items: [] },
      goalDrift: { value: false, items: [] },
    };
    expect(parsePredicatesOutput(REAL_PREDICATES_STDOUT)).toEqual(expected);
  });

  test("parses an all-false drained verdict", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pSeed":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pResearch":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]},"belowFloor":{"value":false,"items":[]},"goalDrift":{"value":false,"items":[]}}}';
    expect(parsePredicatesOutput(stdout)).toEqual({
      pInvestigate: { value: false, items: [] },
      pSeed: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pResearch: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
      belowFloor: { value: false, items: [] },
      goalDrift: { value: false, items: [] },
    });
  });

  test("(D94 regression) a pSeed-ONLY verdict parses and is NOT terminal for the advance preset", () => {
    // A root-caused defect owned by no goal → ONLY pSeed TRUE. The parser must
    // surface it and the advance preset must NOT read it as DRAINED.
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pSeed":{"value":true,"items":["D94"]},"pPlan":{"value":false,"items":[]},"pResearch":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]},"belowFloor":{"value":false,"items":[]},"goalDrift":{"value":false,"items":[]}}}';
    const parsed = parsePredicatesOutput(stdout);
    expect(parsed.pSeed).toEqual({ value: true, items: ["D94"] });
    expect(advanceAutoPreset.terminalPredicate(parsed)).toBe(false);
  });

  test("throws on stdout that is not valid JSON", () => {
    expect(() => parsePredicatesOutput("not json")).toThrow(/not valid JSON/);
  });

  test("throws when the predicates object is absent", () => {
    expect(() => parsePredicatesOutput('{"other":true}')).toThrow(/no "predicates"/);
  });

  test("throws when a predicate key is missing", () => {
    // pInvestigate/pSeed/pPlan/pResearch/pImplement present; openQuestionGate
    // (the first missing key in canonical order) is absent → the parser names it.
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pSeed":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pResearch":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]}}}';
    expect(() => parsePredicatesOutput(stdout)).toThrow(/openQuestionGate/);
  });

  test("throws when value is not a boolean", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":"yes","items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(() => parsePredicatesOutput(stdout)).toThrow(/\.value is not a boolean/);
  });

  test("throws when items is not a string[]", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":true,"items":[1,2]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(() => parsePredicatesOutput(stdout)).toThrow(/\.items is not a string\[\]/);
  });
});

// ---------------------------------------------------------------------------
// T559 (G80/M246) — the CORRECTED false-DRAINED failure model.
//
// Review r1 (both reviewers) established that the ORIGINAL claim was inverted:
// an un-updated auto-driver's parser does NOT throw when fed the NEW six-key
// (now seven-key, pResearch included) `cq predicates` payload — it iterates
// only its OWN copied PREDICATE_KEYS and SILENTLY DROPS any key it doesn't
// know about (`parsePredicatesOutput` only ever reads `predicates[key]` for
// `key of PREDICATE_KEYS`; an unrecognised extra field is simply never
// visited). That silent drop is what feeds `advanceAutoPreset.terminalPredicate`
// a `pResearch`-less snapshot and reports a false STOP_DRAINED while research
// work is actually outstanding.
//
// `OLD_PREDICATE_KEYS` below is a FROZEN copy of this package's real
// `PREDICATE_KEYS` / `advanceAutoPreset.terminalPredicate` as they stood BEFORE
// this task's fix (i.e. before `pResearch` was added anywhere in this
// package) — the exact shape an un-updated deploy of this copy-not-import
// consumer would still be running. It is deliberately NOT sourced from
// ./oracle or ./decision (those are now fixed), so this characterization
// keeps demonstrating the old, unfixed behaviour forever, independent of the
// production fix below it.
// ---------------------------------------------------------------------------

/** Frozen copy of oracle.ts's PREDICATE_KEYS as it stood before T559. */
const OLD_PREDICATE_KEYS = [
  "pInvestigate",
  "pSeed",
  "pPlan",
  "pImplement",
  "openQuestionGate",
  "belowFloor",
] as const;

/** Frozen copy of parsePredicatesOutput's core loop, parameterized by key list. */
function parseWithKeys(stdout: string, keys: readonly string[]): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as { predicates: Record<string, unknown> };
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = parsed.predicates[key];
  }
  return result;
}

/** Frozen copy of advanceAutoPreset.terminalPredicate as it stood before T559 (no pResearch term). */
function oldAdvanceTerminalPredicate(p: Record<string, { value: boolean }>): boolean {
  return !p["pInvestigate"]!.value && !p["pSeed"]!.value && !p["pPlan"]!.value && !p["pImplement"]!.value;
}

// A NEW-shape payload: every OLD-known stage predicate is false (would-be
// drained), but pResearch — a key the OLD auto-driver has never heard of — is
// TRUE with outstanding research work.
const NEW_PAYLOAD_RESEARCH_ONLY =
  '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pSeed":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pResearch":{"value":true,"items":["RS1"]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]},"belowFloor":{"value":false,"items":[]},"goalDrift":{"value":false,"items":[]}}}';

describe("T559 false-DRAINED characterization (corrected model, G80/M246)", () => {
  test("OLD key set fed the NEW payload => parses fine but SILENTLY DROPS pResearch, and the old advance preset terminates", () => {
    const oldParsed = parseWithKeys(NEW_PAYLOAD_RESEARCH_ONLY, OLD_PREDICATE_KEYS);

    // Parses without throwing, but the un-recognised pResearch key never
    // made it into the parsed object at all — the silent drop.
    expect(Object.keys(oldParsed)).toEqual([...OLD_PREDICATE_KEYS]);
    expect(oldParsed["pResearch"]).toBeUndefined();

    // Feeding that dropped snapshot into the OLD advance preset's terminal
    // check reports DRAINED even though the real ledger has outstanding
    // research work — the documented false-DRAINED defect.
    expect(oldAdvanceTerminalPredicate(oldParsed as Record<string, { value: boolean }>)).toBe(true);
  });

  test("NEW key set fed the same payload => pResearch present, advanceAutoPreset does NOT terminate", () => {
    const parsed = parsePredicatesOutput(NEW_PAYLOAD_RESEARCH_ONLY);

    expect(parsed.pResearch).toEqual({ value: true, items: ["RS1"] });
    expect(advanceAutoPreset.terminalPredicate(parsed)).toBe(false);
  });

  test("NEW key set fed a STALE five-key payload (no pResearch) => fails fast", () => {
    // A STALE deployed `cq` binary predating T557/T558 — no pResearch key at
    // all in its stdout. This is the DEPLOY-COUPLING failure mode: the fixed
    // parser must reject it rather than silently proceeding.
    const staleStdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pSeed":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]},"belowFloor":{"value":false,"items":[]}}}';
    expect(() => parsePredicatesOutput(staleStdout)).toThrow(/pResearch/);
  });
});
