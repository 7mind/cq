/**
 * Blackbox-Atomic unit tests for the pure relationship-resolution helpers
 * (T46).  All tests drive the functions with hand-built Item fixtures —
 * no store, no filesystem.
 */

import { describe, it, expect } from "bun:test";
import {
  defectFixTaskIds,
  hypothesisRelationships,
  hypothesesLinkedToRef,
  hypothesisForest,
} from "../src/index.js";
import type { Item } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal item factory
// ---------------------------------------------------------------------------

function makeItem(
  id: string,
  fields: Record<string, string | string[]>,
): Item {
  return {
    id,
    milestoneId: "M1",
    status: "open",
    fields,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// defectFixTaskIds
// ---------------------------------------------------------------------------

describe("defectFixTaskIds", () => {
  it("returns fix-task ids from BOTH link directions, de-duplicated", () => {
    // D3 references T10 via its own dependsOn (forward link).
    // T20 references D3 via its ledgerRefs (reverse link).
    // T10 ALSO references D3 via ledgerRefs — so T10 appears in both
    // directions; the result must contain it exactly once.
    // H5 is a hypothesis id included in dependsOn to confirm only T-prefixed
    // ids are taken from forward links.
    const defects: Item[] = [
      makeItem("D3", { dependsOn: ["T10", "H5"] }), // H5 is a hypothesis id — filtered out
    ];
    const tasks: Item[] = [
      makeItem("T10", { ledgerRefs: ["defects:D3"] }),
      makeItem("T20", { ledgerRefs: ["defects:D3", "tasks:T10"] }),
      makeItem("T30", { ledgerRefs: ["defects:D99"] }), // different defect — excluded
    ];

    const result = defectFixTaskIds("D3", defects, tasks);
    expect(result).toEqual(["T10", "T20"]);
  });

  it("returns only forward-link tasks when no reverse links exist", () => {
    const defects: Item[] = [
      makeItem("D1", { dependsOn: ["T5", "T6"] }),
    ];
    const tasks: Item[] = [
      makeItem("T5", { ledgerRefs: [] }),
      makeItem("T6", {}),         // no ledgerRefs field at all
      makeItem("T7", {}),         // not linked at all
    ];

    const result = defectFixTaskIds("D1", defects, tasks);
    expect(result).toEqual(["T5", "T6"]);
  });

  it("returns only reverse-link tasks when defect has no dependsOn", () => {
    const defects: Item[] = [
      makeItem("D2", {}), // no dependsOn
    ];
    const tasks: Item[] = [
      makeItem("T8", { ledgerRefs: ["defects:D2"] }),
      makeItem("T9", { ledgerRefs: ["defects:D2"] }),
    ];

    const result = defectFixTaskIds("D2", defects, tasks);
    expect(result).toEqual(["T8", "T9"]);
  });

  it("returns empty array when defect has no links in either direction", () => {
    const defects: Item[] = [makeItem("D4", {})];
    const tasks: Item[] = [makeItem("T1", {})];

    expect(defectFixTaskIds("D4", defects, tasks)).toEqual([]);
  });

  it("returns empty array when defect id is not found and no reverse links exist", () => {
    // D99 does not exist in the defects array (only D1 does).
    // No task references D99 via ledgerRefs either.
    const defects: Item[] = [makeItem("D1", { dependsOn: ["T1"] })];
    const tasks: Item[] = [makeItem("T1", { ledgerRefs: ["defects:D1"] })];

    expect(defectFixTaskIds("D99", defects, tasks)).toEqual([]);
  });

  it("resolves PREFIXED dependsOn entries (G80/M245 ref grammar) to bare task ids", () => {
    // D5's dependsOn mixes the canonical prefixed form ("tasks:T11") with a
    // prefixed non-task ref ("defects:D9") that must be excluded, and a
    // malformed ref ("bogus::x") that must be skipped without throwing.
    const defects: Item[] = [
      makeItem("D5", { dependsOn: ["tasks:T11", "defects:D9", "bogus::x"] }),
    ];
    const tasks: Item[] = [makeItem("T11", {})];

    expect(defectFixTaskIds("D5", defects, tasks)).toEqual(["T11"]);
  });

  it("treats bare and prefixed forms of the SAME task as one de-duplicated entry", () => {
    const defects: Item[] = [
      makeItem("D6", { dependsOn: ["T12", "tasks:T12"] }),
    ];
    const tasks: Item[] = [makeItem("T12", {})];

    expect(defectFixTaskIds("D6", defects, tasks)).toEqual(["T12"]);
  });
});

// ---------------------------------------------------------------------------
// hypothesisRelationships
// ---------------------------------------------------------------------------

describe("hypothesisRelationships", () => {
  it("resolves a 3-level ancestry chain (child → parent → grandparent)", () => {
    // H1 (root) ← H2 ← H3
    const hypotheses: Item[] = [
      makeItem("H1", {}),                              // root: no parent
      makeItem("H2", { parentHypothesis: "H1" }),      // child of H1
      makeItem("H3", { parentHypothesis: "H2" }),      // grandchild of H1
    ];

    const { ancestors, children } = hypothesisRelationships("H3", hypotheses);

    // Ancestors from direct parent to root: H2, then H1.
    expect(ancestors).toEqual(["H2", "H1"]);
    // H3 has no children.
    expect(children).toEqual([]);
  });

  it("reports direct children of a node in the chain", () => {
    // H1 is the root. H2 and H3 are both children of H1.
    const hypotheses: Item[] = [
      makeItem("H1", {}),
      makeItem("H2", { parentHypothesis: "H1" }),
      makeItem("H3", { parentHypothesis: "H1" }),
    ];

    const { ancestors, children } = hypothesisRelationships("H1", hypotheses);

    expect(ancestors).toEqual([]);
    expect(children.sort()).toEqual(["H2", "H3"]);
  });

  it("handles a hypothesis with multiple children and ancestors simultaneously", () => {
    // H1 ← H2 ← H3, H4 (both children of H2)
    const hypotheses: Item[] = [
      makeItem("H1", {}),
      makeItem("H2", { parentHypothesis: "H1" }),
      makeItem("H3", { parentHypothesis: "H2" }),
      makeItem("H4", { parentHypothesis: "H2" }),
    ];

    const { ancestors, children } = hypothesisRelationships("H2", hypotheses);

    // H2's ancestor is H1 (the root).
    expect(ancestors).toEqual(["H1"]);
    // H2's children are H3 and H4.
    expect(children.sort()).toEqual(["H3", "H4"]);
  });

  it("returns empty ancestors and children for an isolated hypothesis", () => {
    const hypotheses: Item[] = [makeItem("H1", {})];
    const { ancestors, children } = hypothesisRelationships("H1", hypotheses);
    expect(ancestors).toEqual([]);
    expect(children).toEqual([]);
  });

  it("does not enter an infinite loop on a parentHypothesis cycle", () => {
    // Malformed data: H1 → H2 → H1 (cycle).
    const hypotheses: Item[] = [
      makeItem("H1", { parentHypothesis: "H2" }),
      makeItem("H2", { parentHypothesis: "H1" }),
    ];
    // Should terminate gracefully; the order depends on where we start.
    const { ancestors } = hypothesisRelationships("H1", hypotheses);
    // Only one ancestor reachable before the cycle guard fires.
    expect(ancestors).toEqual(["H2"]);
  });
});

// ---------------------------------------------------------------------------
// hypothesesLinkedToRef + hypothesisForest (T561, G80/M246, Q262)
// ---------------------------------------------------------------------------

describe("hypothesesLinkedToRef", () => {
  it("returns hypotheses whose ledgerRefs contains the exact owner ref", () => {
    const hypotheses: Item[] = [
      makeItem("H1", { ledgerRefs: ["researches:RS1"] }),
      makeItem("H2", { ledgerRefs: ["researches:RS1", "researches:RS2"] }),
      makeItem("H3", { ledgerRefs: ["researches:RS2"] }),
      makeItem("H4", { ledgerRefs: ["defects:D1"] }),
      makeItem("H5", {}), // no ledgerRefs at all
    ];

    const result = hypothesesLinkedToRef("researches:RS1", hypotheses).map((h) => h.id);
    expect(result).toEqual(["H1", "H2"]);
  });

  it("returns an empty array when no hypothesis links the owner ref", () => {
    const hypotheses: Item[] = [makeItem("H1", { ledgerRefs: ["defects:D1"] })];
    expect(hypothesesLinkedToRef("researches:RS1", hypotheses)).toEqual([]);
  });
});

describe("hypothesisForest", () => {
  it("nests a single-root, multi-level tree", () => {
    // H1 (root) -> H2, H3 (children of H1); H4 (child of H2).
    const hypotheses: Item[] = [
      makeItem("H1", {}),
      makeItem("H2", { parentHypothesis: "H1" }),
      makeItem("H3", { parentHypothesis: "H1" }),
      makeItem("H4", { parentHypothesis: "H2" }),
    ];

    const forest = hypothesisForest(hypotheses);
    expect(forest).toHaveLength(1);
    expect(forest[0]!.id).toBe("H1");
    expect(forest[0]!.children.map((c) => c.id).sort()).toEqual(["H2", "H3"]);
    const h2 = forest[0]!.children.find((c) => c.id === "H2")!;
    expect(h2.children.map((c) => c.id)).toEqual(["H4"]);
    const h3 = forest[0]!.children.find((c) => c.id === "H3")!;
    expect(h3.children).toEqual([]);
  });

  it("treats a hypothesis whose parent is OUTSIDE the given set as a root", () => {
    // H2's parentHypothesis (H1) is not in the input set (e.g. filtered out
    // because it belongs to a different owning ref) — H2 becomes a root.
    const hypotheses: Item[] = [makeItem("H2", { parentHypothesis: "H1" })];
    const forest = hypothesisForest(hypotheses);
    expect(forest).toEqual([{ id: "H2", children: [] }]);
  });

  it("produces multiple independent roots when there is no shared ancestor", () => {
    const hypotheses: Item[] = [makeItem("H1", {}), makeItem("H2", {})];
    const forest = hypothesisForest(hypotheses);
    expect(forest.map((n) => n.id).sort()).toEqual(["H1", "H2"]);
  });

  it("does not enter an infinite loop on a parentHypothesis cycle", () => {
    // Malformed data: H1 -> H2 -> H1. Neither has a parent OUTSIDE the set,
    // so neither qualifies as a root — the forest is empty rather than
    // recursing forever or throwing.
    const hypotheses: Item[] = [
      makeItem("H1", { parentHypothesis: "H2" }),
      makeItem("H2", { parentHypothesis: "H1" }),
    ];
    expect(() => hypothesisForest(hypotheses)).not.toThrow();
    expect(hypothesisForest(hypotheses)).toEqual([]);
  });

  it("does not enter an infinite loop on a cycle disjoint from a real root", () => {
    // H1 is a genuine root; H2 <-> H3 form a mutual cycle with no root of
    // their own (their parents are both IN the set).
    const hypotheses: Item[] = [
      makeItem("H1", {}),
      makeItem("H2", { parentHypothesis: "H3" }),
      makeItem("H3", { parentHypothesis: "H2" }),
    ];
    expect(() => hypothesisForest(hypotheses)).not.toThrow();
    // H1 is the only well-formed root; H2/H3 form an unreachable cycle and
    // simply do not appear in the forest.
    expect(hypothesisForest(hypotheses)).toEqual([{ id: "H1", children: [] }]);
  });
});
