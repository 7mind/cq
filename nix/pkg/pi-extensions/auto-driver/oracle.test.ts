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
import type { DerivedPredicates } from "./decision";

// Representative `cq predicates` stdout (predicates shape identical to T463 verification).
const REAL_PREDICATES_STDOUT =
  '{"predicates":{"pInvestigate":{"value":true,"items":["D72","D73"]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":true,"items":["T463"]},"openQuestionGate":{"value":false,"items":[]}}}';

describe("parsePredicatesOutput", () => {
  test("parses the real cq predicates verdict into all four predicates", () => {
    const expected: DerivedPredicates = {
      pInvestigate: { value: true, items: ["D72", "D73"] },
      pPlan: { value: false, items: [] },
      pImplement: { value: true, items: ["T463"] },
      openQuestionGate: { value: false, items: [] },
    };
    expect(parsePredicatesOutput(REAL_PREDICATES_STDOUT)).toEqual(expected);
  });

  test("parses an all-false drained verdict", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}';
    expect(parsePredicatesOutput(stdout)).toEqual({
      pInvestigate: { value: false, items: [] },
      pPlan: { value: false, items: [] },
      pImplement: { value: false, items: [] },
      openQuestionGate: { value: false, items: [] },
    });
  });

  test("throws on stdout that is not valid JSON", () => {
    expect(() => parsePredicatesOutput("not json")).toThrow(/not valid JSON/);
  });

  test("throws when the predicates object is absent", () => {
    expect(() => parsePredicatesOutput('{"other":true}')).toThrow(/no "predicates"/);
  });

  test("throws when a predicate key is missing", () => {
    const stdout =
      '{"predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]}}}';
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
