// oracle.test.ts — unit tests for parseAdvanceGateOutput (from ./oracle.ts).
//
// Standalone package test (option (a), mirroring decide.test.ts): lives beside
// the module under nix/pkg/pi-extensions/auto-driver/ (own package.json,
// `"test": "bun test"`), NOT part of the cq-ledgers workspace. Run with:
// `cd nix/pkg/pi-extensions/auto-driver && bun test`.
//
// The parser is exercised against the REAL `cq advance-gate` stdout shape. The
// sample below is the byte-for-byte verdict captured from this repo's ledger via
// BOTH `cq advance-gate` and `mcp__ledger__derive_predicates` (T463 manual
// verification) — they returned the identical `predicates` object. getPredicates
// itself shells out `cq advance-gate`; only the pure parser is unit-tested here.

import { describe, test, expect } from "bun:test";
import { parseAdvanceGateOutput } from "./oracle";
import type { DerivedPredicates } from "./decision";

// Verbatim `cq advance-gate` stdout captured on this repo's ledger (T463).
const REAL_ADVANCE_GATE_STDOUT =
  '{"block":true,"reason":"P-investigate=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition","predicates":{"pInvestigate":{"value":true,"items":["D72","D73"]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":true,"items":["T463"]},"openQuestionGate":{"value":false,"items":[]}}}';

describe("parseAdvanceGateOutput", () => {
  test("parses the real cq advance-gate verdict into all four predicates", () => {
    const expected: DerivedPredicates = {
      pInvestigate: { value: true, items: ["D72", "D73"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T463"] },
      openQuestionGate: { value: false, items: [] },
    };
    expect(parseAdvanceGateOutput(REAL_ADVANCE_GATE_STDOUT)).toEqual(expected);
  });

  test("parses an all-false drained verdict", () => {
    const stdout =
      '{"block":false,"reason":"drained","predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(parseAdvanceGateOutput(stdout)).toEqual({
      pInvestigate: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    });
  });

  test("throws on stdout that is not valid JSON", () => {
    expect(() => parseAdvanceGateOutput("not json")).toThrow(/not valid JSON/);
  });

  test("throws when the predicates object is absent", () => {
    expect(() => parseAdvanceGateOutput('{"block":true,"reason":"x"}')).toThrow(/no "predicates"/);
  });

  test("throws when a predicate key is missing", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]}}}';
    expect(() => parseAdvanceGateOutput(stdout)).toThrow(/openQuestionGate/);
  });

  test("throws when value is not a boolean", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":"yes","items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(() => parseAdvanceGateOutput(stdout)).toThrow(/\.value is not a boolean/);
  });

  test("throws when items is not a string[]", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":true,"items":[1,2]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(() => parseAdvanceGateOutput(stdout)).toThrow(/\.items is not a string\[\]/);
  });
});
