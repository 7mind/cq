/**
 * Minimal smoke test for the shared `derivePredicates` (T361).
 *
 * Exercises the pure function against a tiny stub `LedgerStore` that serves
 * only synchronous `fetch` reads — enough to confirm the three predicates +
 * the open-question gate wire up correctly and name the actionable ids.
 *
 * The comprehensive dual-adapter fixtures (real FsLedgerStore + InMemory) are
 * T366's job; this is the one minimal assertion T361's acceptance allows.
 */

import { describe, it, expect } from "bun:test";
import type { FetchedLedger, Item, LedgerStore } from "../src/index.js";
import { derivePredicates } from "../src/index.js";

function item(
  id: string,
  status: string,
  fields: Item["fields"],
  milestoneId = "M1",
): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ledger(id: string, items: Item[]): FetchedLedger {
  return {
    id,
    schema: { statusValues: [], terminalStatuses: [], fields: {} },
    counters: { milestone: 0, item: items.length },
    milestones: [
      {
        id: "M1",
        milestone: { id: "M1", status: "open", title: "m", description: "" },
        items,
      },
    ],
    archivePointers: [],
  };
}

/** Stub store serving only the `fetch` reads `derivePredicates` consumes. */
function stubStore(byLedger: Record<string, Item[]>): LedgerStore {
  const fetch = (ledgerId: string): FetchedLedger =>
    ledger(ledgerId, byLedger[ledgerId] ?? []);
  return { fetch } as unknown as LedgerStore;
}

describe("derivePredicates", () => {
  it("flags an actionable defect, a planning goal, and a DAG-ready task", () => {
    const store = stubStore({
      defects: [item("D1", "open", {})],
      goals: [item("G1", "planning", {}), item("G2", "building", {})],
      tasks: [item("T1", "planned", { ledgerRefs: ["goals:G2"] })],
      questions: [],
      milestones: [],
    });

    const p = derivePredicates(store);
    expect(p.pInvestigate).toEqual({ value: true, items: ["D1"] });
    expect(p.pPlan).toEqual({ value: true, items: ["G1"] });
    expect(p.pImplement).toEqual({ value: true, items: ["T1"] });
    expect(p.openQuestionGate).toEqual({ value: false, items: [] });
  });

  it("gates a defect/goal/task blocked solely on an open linked question", () => {
    const store = stubStore({
      defects: [item("D1", "open", {})],
      goals: [item("G1", "clarifying", {}), item("G2", "planned", {})],
      tasks: [item("T1", "planned", { ledgerRefs: ["goals:G2"] })],
      questions: [
        item("Q1", "open", { ledgerRefs: ["defects:D1"] }),
        item("Q2", "open", { ledgerRefs: ["goals:G1"] }),
        item("Q3", "open", { ledgerRefs: ["tasks:T1"] }),
      ],
      milestones: [],
    });

    const p = derivePredicates(store);
    expect(p.pInvestigate.value).toBe(false);
    expect(p.pPlan.value).toBe(false);
    expect(p.pImplement.value).toBe(false);
    expect(new Set(p.openQuestionGate.items)).toEqual(new Set(["Q1", "Q2", "Q3"]));
  });

  it("holds a task back on an unmet task- or milestone-dependency", () => {
    const store = stubStore({
      defects: [],
      goals: [item("G2", "planned", {})],
      tasks: [
        item("T1", "planned", { ledgerRefs: ["goals:G2"], dependsOn: ["T0"] }, "M2"),
        item("T0", "wip", {}, "M2"),
        item("T2", "planned", {}, "M1"), // non-terminal task under dep milestone M1
        item("T3", "planned", { ledgerRefs: ["goals:G2"] }, "M3"),
      ],
      questions: [],
      milestones: [item("M3", "open", { dependsOn: ["M1"] })],
    });

    const p = derivePredicates(store);
    // T1 blocked by unfinished dep T0; T3 blocked by milestone M1 (T2 non-terminal).
    expect(p.pImplement.value).toBe(false);
  });

  it("excludes a defect owned by a planning goal", () => {
    const store = stubStore({
      defects: [item("D1", "open", { ledgerRefs: ["goals:G1"] })],
      goals: [item("G1", "planning", {})],
      tasks: [],
      questions: [],
      milestones: [],
    });

    const p = derivePredicates(store);
    expect(p.pInvestigate.value).toBe(false);
  });
});
