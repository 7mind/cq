// counts.test.ts — unit tests for parseCounts/formatStatus (from ./counts.ts).
//
// Standalone package test (mirrors auto-driver/oracle.test.ts style): lives
// beside the module under nix/pkg/pi-extensions/ledger-status/ (own
// package.json, `"test": "bun test"`), NOT part of the cq-ledgers workspace.
// Run with: `cd nix/pkg/pi-extensions/ledger-status && bun test`.
//
// Fixtures below are LITERAL JSON strings shaped like the real `cq counts`
// (T533) stdout: `{ ledgers, counts, ledgerSummaries }`, where
// `ledgerSummaries` entries are `{ name, itemCount, statusCounts,
// completedCount, progressTotal }` (see @cq/ledger's computeLedgerSummaries).
// T560 adds the `researches` (T556) ledger's R segment alongside Q/T/D.

import { describe, test, expect } from "bun:test";
import { parseCounts, formatStatus } from "./counts";

/** Full Q/T/D/R fixture: questions 3/12, tasks 5/20, defects 1/4, researches 2/6. */
const FULL_QTD_STDOUT = JSON.stringify({
  ledgers: ["questions", "tasks", "defects", "researches"],
  counts: { questions: 12, tasks: 20, defects: 4, researches: 6 },
  ledgerSummaries: [
    {
      name: "questions",
      itemCount: 12,
      statusCounts: { open: 9, answered: 3 },
      completedCount: 3,
      progressTotal: 12,
    },
    {
      name: "tasks",
      itemCount: 20,
      statusCounts: { planned: 10, wip: 5, done: 5 },
      completedCount: 5,
      progressTotal: 20,
    },
    {
      name: "defects",
      itemCount: 4,
      statusCounts: { open: 3, resolved: 1 },
      completedCount: 1,
      progressTotal: 4,
    },
    {
      // completedCount here counts the researches schema's two terminal
      // statuses (concluded + abandoned), e.g. 1 concluded + 1 abandoned = 2.
      name: "researches",
      itemCount: 6,
      statusCounts: { open: 2, wip: 2, concluded: 1, abandoned: 1 },
      completedCount: 2,
      progressTotal: 6,
    },
  ],
});

/** Missing-ledger fixture: no `defects` entry at all in ledgerSummaries. */
const MISSING_DEFECTS_STDOUT = JSON.stringify({
  ledgers: ["questions", "tasks"],
  counts: { questions: 12, tasks: 20 },
  ledgerSummaries: [
    {
      name: "questions",
      itemCount: 12,
      statusCounts: { open: 9, answered: 3 },
      completedCount: 3,
      progressTotal: 12,
    },
    {
      name: "tasks",
      itemCount: 20,
      statusCounts: { planned: 10, wip: 5, done: 5 },
      completedCount: 5,
      progressTotal: 20,
    },
  ],
});

/**
 * Missing-researches fixture: questions/tasks/defects present, no `researches`
 * entry at all — tolerates an old cq build without the T556 researches ledger.
 */
const MISSING_RESEARCHES_STDOUT = JSON.stringify({
  ledgers: ["questions", "tasks", "defects"],
  counts: { questions: 12, tasks: 20, defects: 4 },
  ledgerSummaries: [
    {
      name: "questions",
      itemCount: 12,
      statusCounts: { open: 9, answered: 3 },
      completedCount: 3,
      progressTotal: 12,
    },
    {
      name: "tasks",
      itemCount: 20,
      statusCounts: { planned: 10, wip: 5, done: 5 },
      completedCount: 5,
      progressTotal: 20,
    },
    {
      name: "defects",
      itemCount: 4,
      statusCounts: { open: 3, resolved: 1 },
      completedCount: 1,
      progressTotal: 4,
    },
  ],
});

/** Zero-total fixture: defects ledger exists but is empty (0/0). */
const ZERO_TOTAL_STDOUT = JSON.stringify({
  ledgers: ["questions", "tasks", "defects"],
  counts: { questions: 12, tasks: 20, defects: 0 },
  ledgerSummaries: [
    {
      name: "questions",
      itemCount: 12,
      statusCounts: { open: 9, answered: 3 },
      completedCount: 3,
      progressTotal: 12,
    },
    {
      name: "tasks",
      itemCount: 20,
      statusCounts: { planned: 10, wip: 5, done: 5 },
      completedCount: 5,
      progressTotal: 20,
    },
    {
      name: "defects",
      itemCount: 0,
      statusCounts: {},
      completedCount: 0,
      progressTotal: 0,
    },
  ],
});

describe("parseCounts", () => {
  test("parses the full questions/tasks/defects/researches fixture", () => {
    expect(parseCounts(FULL_QTD_STDOUT)).toEqual({
      questions: { done: 3, total: 12 },
      tasks: { done: 5, total: 20 },
      defects: { done: 1, total: 4 },
      researches: { done: 2, total: 6 },
    });
  });

  test("omits a ledger absent from ledgerSummaries (no defects entry)", () => {
    expect(parseCounts(MISSING_DEFECTS_STDOUT)).toEqual({
      questions: { done: 3, total: 12 },
      tasks: { done: 5, total: 20 },
    });
  });

  test("omits researches when its ledger is absent (old cq build, no researches ledger)", () => {
    expect(parseCounts(MISSING_RESEARCHES_STDOUT)).toEqual({
      questions: { done: 3, total: 12 },
      tasks: { done: 5, total: 20 },
      defects: { done: 1, total: 4 },
    });
  });

  test("parses a present-but-empty ledger as a genuine 0/0", () => {
    expect(parseCounts(ZERO_TOTAL_STDOUT)).toEqual({
      questions: { done: 3, total: 12 },
      tasks: { done: 5, total: 20 },
      defects: { done: 0, total: 0 },
    });
  });

  test("throws on stdout that is not valid JSON", () => {
    expect(() => parseCounts("not json")).toThrow(/not valid JSON/);
  });

  test("throws when stdout is not a JSON object", () => {
    expect(() => parseCounts("42")).toThrow(/not a JSON object/);
  });

  test('throws when "ledgerSummaries" is absent', () => {
    expect(() => parseCounts('{"ledgers":[],"counts":{}}')).toThrow(/no "ledgerSummaries" array/);
  });

  test("throws when a ledgerSummaries entry is malformed (completedCount not a number)", () => {
    const stdout = JSON.stringify({
      ledgers: ["questions"],
      counts: { questions: 1 },
      ledgerSummaries: [{ name: "questions", itemCount: 1, completedCount: "3", progressTotal: 12 }],
    });
    expect(() => parseCounts(stdout)).toThrow(/\.completedCount is not a number/);
  });
});

describe("formatStatus", () => {
  test("renders the exact Q257/T560 format for the full Q/T/D/R fixture", () => {
    const counts = parseCounts(FULL_QTD_STDOUT);
    expect(formatStatus(counts)).toBe("Q 3/12  T 5/20  D 1/4  R 2/6");
  });

  test("omits the defects segment entirely when its ledger is absent", () => {
    const counts = parseCounts(MISSING_DEFECTS_STDOUT);
    expect(formatStatus(counts)).toBe("Q 3/12  T 5/20");
  });

  test("omits the researches segment entirely when its ledger is absent", () => {
    const counts = parseCounts(MISSING_RESEARCHES_STDOUT);
    expect(formatStatus(counts)).toBe("Q 3/12  T 5/20  D 1/4");
  });

  test("renders a genuine zero-total ledger as 0/0 (not omitted)", () => {
    const counts = parseCounts(ZERO_TOTAL_STDOUT);
    expect(formatStatus(counts)).toBe("Q 3/12  T 5/20  D 0/0");
  });
});
