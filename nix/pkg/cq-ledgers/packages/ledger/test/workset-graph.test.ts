/**
 * T1952 — deterministic workset closure graph.
 *
 * Behavioral-Active Blackbox fixtures for edge direction, root asymmetry,
 * exact gate propagation, every owner-edge row, and deterministic cycles.
 */

import { describe, expect, it } from "bun:test";
import {
  ALLOWED_OWNER_EDGE_ROWS,
  buildWorksetActiveState,
  closeWorkset,
  fixturesForAllowedRow,
  PREREQUISITE_EDGE,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  WorksetRootError,
  type Item,
  type WorksetActiveState,
} from "../src/index.js";

const NOW = "2026-08-08T12:00:00.000Z";

function makeItem(
  id: string,
  status: string,
  fields: Item["fields"] = {},
  milestoneId = "M1",
): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stateFrom(
  entries: Array<{ ledger: string; item: Item }>,
): WorksetActiveState {
  const byLedger = new Map<string, Item[]>();
  for (const { ledger, item } of entries) {
    const list = byLedger.get(ledger) ?? [];
    list.push(item);
    byLedger.set(ledger, list);
  }
  return buildWorksetActiveState(
    [...byLedger.entries()].map(([ledger, items]) => ({ ledger, items })),
  );
}

function nodeRefs(graph: ReturnType<typeof closeWorkset>): string[] {
  return graph.nodes.map((n) => n.ref);
}

describe("workset-graph — root canonicalization and order", () => {
  it("preserves first-occurrence root order and de-duplicates", () => {
    const t1 = makeItem("T1", "planned", { headline: "a" });
    const t2 = makeItem("T2", "planned", { headline: "b" });
    const state = stateFrom([
      { ledger: "tasks", item: t1 },
      { ledger: "tasks", item: t2 },
    ]);
    const graph = closeWorkset(["T2", "tasks:T1", "T2", "tasks:T2"], state);
    expect(graph.roots).toEqual(["tasks:T2", "tasks:T1"]);
    expect(nodeRefs(graph)).toEqual(["tasks:T2", "tasks:T1"]);
  });

  it("rejects malformed roots under validateLiveRoots", () => {
    const state = stateFrom([]);
    expect(() => closeWorkset(["not a ref"], state, { validateLiveRoots: true })).toThrow(
      WorksetRootError,
    );
  });

  it("rejects inactive roots under validateLiveRoots (set/fetch)", () => {
    const state = stateFrom([]);
    expect(() =>
      closeWorkset(["tasks:T9"], state, { validateLiveRoots: true }),
    ).toThrow(WorksetRootError);
  });
});

describe("workset-graph — prerequisite edge direction", () => {
  it("traverses dependsOn and blockedBy only toward prerequisites", () => {
    const t1 = makeItem("T1", "planned", {
      headline: "root",
      dependsOn: ["tasks:T2"],
      blockedBy: ["questions:Q1"],
    });
    const t2 = makeItem("T2", "planned", {
      headline: "prereq",
      // Reverse edge: T2 depends on T1 — must NOT pull T1's dependants when
      // expanding from T2 alone; when expanding T1, T2 is a prereq only.
      dependsOn: ["tasks:T1"],
    });
    const t3 = makeItem("T3", "planned", {
      headline: "dependant",
      dependsOn: ["tasks:T1"],
    });
    const q1 = makeItem("Q1", "open", { question: "gate?" });
    const state = stateFrom([
      { ledger: "tasks", item: t1 },
      { ledger: "tasks", item: t2 },
      { ledger: "tasks", item: t3 },
      { ledger: "questions", item: q1 },
    ]);

    const graph = closeWorkset(["tasks:T1"], state);
    expect(nodeRefs(graph).sort()).toEqual(
      ["questions:Q1", "tasks:T1", "tasks:T2"].sort(),
    );
    expect(nodeRefs(graph)).not.toContain("tasks:T3");

    const prereqEdges = graph.edges.filter((e) => e.kind === "prerequisite");
    expect(prereqEdges).toContainEqual({
      from: "tasks:T1",
      to: "tasks:T2",
      kind: "prerequisite",
    });
    expect(prereqEdges).toContainEqual({
      from: "tasks:T1",
      to: "questions:Q1",
      kind: "prerequisite",
    });
    // Cycle T1↔T2: both nodes present, edges toward each other once each,
    // no infinite expansion.
    expect(prereqEdges).toContainEqual({
      from: "tasks:T2",
      to: "tasks:T1",
      kind: "prerequisite",
    });
    expect(PREREQUISITE_EDGE.direction).toBe("node-to-prerequisite");
  });

  it("is cycle-safe and deterministic for mutual dependsOn", () => {
    const a = makeItem("T10", "wip", {
      headline: "a",
      dependsOn: ["tasks:T11"],
    });
    const b = makeItem("T11", "wip", {
      headline: "b",
      dependsOn: ["tasks:T10"],
    });
    const state = stateFrom([
      { ledger: "tasks", item: a },
      { ledger: "tasks", item: b },
    ]);
    const g1 = closeWorkset(["tasks:T10"], state);
    const g2 = closeWorkset(["tasks:T10"], state);
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    expect(nodeRefs(g1).sort()).toEqual(["tasks:T10", "tasks:T11"].sort());
    expect(g1.edges).toEqual(g2.edges);
  });
});

describe("workset-graph — direct-task vs explicit-milestone asymmetry", () => {
  it("direct task root excludes owner milestone and sibling tasks", () => {
    const m = makeItem("M1", "open", { title: "ms" });
    const t1 = makeItem("T1", "planned", { headline: "rooted" }, "M1");
    const t2 = makeItem("T2", "planned", { headline: "sibling" }, "M1");
    const state = stateFrom([
      { ledger: "milestones", item: m },
      { ledger: "tasks", item: t1 },
      { ledger: "tasks", item: t2 },
    ]);
    const graph = closeWorkset(["tasks:T1"], state);
    expect(nodeRefs(graph)).toEqual(["tasks:T1"]);
    expect(nodeRefs(graph)).not.toContain("milestones:M1");
    expect(nodeRefs(graph)).not.toContain("tasks:T2");
  });

  it("explicit milestone root expands live tasks only", () => {
    const m = makeItem("M1", "open", { title: "ms" });
    const t1 = makeItem("T1", "planned", { headline: "live" }, "M1");
    const t2 = makeItem("T2", "done", { headline: "terminal" }, "M1");
    const t3 = makeItem("T3", "wip", { headline: "other-ms" }, "M2");
    const state = stateFrom([
      { ledger: "milestones", item: m },
      { ledger: "tasks", item: t1 },
      { ledger: "tasks", item: t2 },
      { ledger: "tasks", item: t3 },
    ]);
    const graph = closeWorkset(["milestones:M1"], state);
    expect(nodeRefs(graph).sort()).toEqual(["milestones:M1", "tasks:T1"].sort());
    expect(nodeRefs(graph)).not.toContain("tasks:T2");
    expect(nodeRefs(graph)).not.toContain("tasks:T3");
  });

  it("milestone reached as prerequisite does not expand tasks", () => {
    const m = makeItem("M1", "open", { title: "ms" });
    const tOwned = makeItem("T9", "planned", { headline: "under-m" }, "M1");
    const tRoot = makeItem("T1", "planned", {
      headline: "root",
      dependsOn: ["milestones:M1"],
    });
    const state = stateFrom([
      { ledger: "milestones", item: m },
      { ledger: "tasks", item: tOwned },
      { ledger: "tasks", item: tRoot },
    ]);
    const graph = closeWorkset(["tasks:T1"], state);
    expect(nodeRefs(graph).sort()).toEqual(["milestones:M1", "tasks:T1"].sort());
    expect(nodeRefs(graph)).not.toContain("tasks:T9");
  });
});

describe("workset-graph — exact open gate propagation", () => {
  it("includes sealed open gate questions on an included task", () => {
    const t1 = makeItem("T1", "wip", { headline: "task" });
    const qOpen = makeItem("Q1", "open", {
      question: "need answer",
      [WORKSET_OWNER_REF_FIELD]: "tasks:T1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "exact-gate-question",
    });
    const qAnswered = makeItem("Q2", "answered", {
      question: "done",
      answer: "yes",
      [WORKSET_OWNER_REF_FIELD]: "tasks:T1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "exact-gate-question",
    });
    const state = stateFrom([
      { ledger: "tasks", item: t1 },
      { ledger: "questions", item: qOpen },
      { ledger: "questions", item: qAnswered },
    ]);
    const graph = closeWorkset(["tasks:T1"], state);
    expect(nodeRefs(graph).sort()).toEqual(["questions:Q1", "tasks:T1"].sort());
    expect(graph.edges).toContainEqual({
      from: "tasks:T1",
      to: "questions:Q1",
      kind: "exact-gate-question",
    });
  });

  it("propagates gates through prerequisites", () => {
    const t1 = makeItem("T1", "planned", {
      headline: "root",
      dependsOn: ["tasks:T2"],
    });
    const t2 = makeItem("T2", "planned", { headline: "prereq" });
    const q = makeItem("Q1", "open", {
      question: "gate prereq",
      [WORKSET_OWNER_REF_FIELD]: "tasks:T2",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "exact-gate-question",
    });
    const state = stateFrom([
      { ledger: "tasks", item: t1 },
      { ledger: "tasks", item: t2 },
      { ledger: "questions", item: q },
    ]);
    const graph = closeWorkset(["tasks:T1"], state);
    expect(nodeRefs(graph)).toContain("questions:Q1");
  });
});

describe("workset-graph — every owner-edge row fixture", () => {
  it("admits positive sealed children and rejects reverse/sibling/unrelated", () => {
    for (const row of ALLOWED_OWNER_EDGE_ROWS) {
      const fixtures = fixturesForAllowedRow(row);
      for (const fixture of fixtures) {
        const ownerParsed = fixture.ownerRef.split(":");
        const childParsed = fixture.childRef.split(":");
        const ownerLedger = ownerParsed[0]!;
        const ownerId = ownerParsed[1]!;
        const childLedger = childParsed[0]!;
        const childId = childParsed[1]!;

        const ownerStatus = row.ownerStatuses[0]!;
        const ownerFields: Item["fields"] =
          ownerLedger === "milestones"
            ? { title: "owner" }
            : ownerLedger === "goals"
              ? { title: "owner", description: "d" }
              : ownerLedger === "questions"
                ? { question: "owner?" }
                : ownerLedger === "ideas"
                  ? { title: "idea" }
                  : ownerLedger === "defects"
                    ? { headline: "d", severity: "high" }
                    : ownerLedger === "researches"
                      ? { question: "r?" }
                      : ownerLedger === "reviews"
                        ? { summary: "r" }
                        : ownerLedger === "handoffs"
                          ? { summary: "h" }
                          : { headline: "owner" };

        const childFields: Item["fields"] = {
          ...(childLedger === "milestones"
            ? { title: "child" }
            : childLedger === "goals"
              ? { title: "child", description: "d" }
              : childLedger === "questions"
                ? { question: "child?" }
                : childLedger === "ideas"
                  ? { title: "child" }
                  : childLedger === "defects"
                    ? { headline: "c", severity: "low" }
                    : childLedger === "researches"
                      ? { question: "c?" }
                      : childLedger === "reviews"
                        ? { summary: "c" }
                        : childLedger === "handoffs"
                          ? { summary: "c" }
                          : childLedger === "decisions"
                            ? { headline: "c" }
                            : { headline: "child" }),
        };

        const owner = makeItem(ownerId, ownerStatus, ownerFields);
        const childStatus =
          childLedger === "questions"
            ? "open"
            : childLedger === "reviews"
              ? "revise"
              : childLedger === "milestones"
                ? "open"
                : childLedger === "goals"
                  ? "clarifying"
                  : childLedger === "tasks"
                    ? "planned"
                    : childLedger === "defects"
                      ? "open"
                      : childLedger === "researches"
                        ? "open"
                        : childLedger === "hypothesis"
                          ? "open"
                          : childLedger === "ideas"
                            ? "open"
                            : childLedger === "handoffs"
                              ? "drained"
                              : childLedger === "decisions"
                                ? "proposed"
                                : "open";

        if (fixture.relation === "positive") {
          childFields[WORKSET_OWNER_REF_FIELD] = fixture.ownerRef;
          childFields[WORKSET_OWNER_EDGE_KIND_FIELD] = row.edgeKind;
        } else if (fixture.relation === "reverse") {
          // No reverse ownership edge: both items exist; rooting at the child
          // must not pull the original owner.
        } else if (fixture.relation === "sibling") {
          // Sibling sealed under same owner; rebuilt below.
        } else {
          // unrelated: child sealed under otherRef owner
          childFields[WORKSET_OWNER_REF_FIELD] = fixture.otherRef ?? "upstream:U9";
          childFields[WORKSET_OWNER_EDGE_KIND_FIELD] = row.edgeKind;
        }

        const child = makeItem(childId, childStatus, childFields);
        const entries: Array<{ ledger: string; item: Item }> = [
          { ledger: ownerLedger, item: owner },
          { ledger: childLedger, item: child },
        ];

        if (fixture.relation === "sibling" && fixture.otherRef !== undefined) {
          const sibParts = fixture.otherRef.split(":");
          const sib = makeItem(sibParts[1]!, childStatus, {
            ...childFields,
            [WORKSET_OWNER_REF_FIELD]: fixture.ownerRef,
            [WORKSET_OWNER_EDGE_KIND_FIELD]: row.edgeKind,
            headline: childFields["headline"] ?? "sib",
            title: childFields["title"] ?? "sib",
            question: childFields["question"] ?? "sib?",
            summary: childFields["summary"] ?? "sib",
          });
          // Positive child sealed under owner.
          const positiveChild = makeItem(childId, childStatus, {
            ...childFields,
            [WORKSET_OWNER_REF_FIELD]: fixture.ownerRef,
            [WORKSET_OWNER_EDGE_KIND_FIELD]: row.edgeKind,
          });
          entries.length = 0;
          entries.push(
            { ledger: ownerLedger, item: owner },
            { ledger: childLedger, item: positiveChild },
            { ledger: sibParts[0]!, item: sib },
          );
        }

        // Goal draft/manifest edges need a parseable phase document. List the
        // child only for positive/sibling (ownership-admitted) relations so
        // reverse/unrelated cannot sneak in via the phase document alone.
        if (
          ownerLedger === "goals" &&
          (row.edgeKind === "active-current-draft" || row.edgeKind === "finalized-manifest")
        ) {
          const ownerEntry = entries.find((e) => e.ledger === "goals");
          if (ownerEntry !== undefined) {
            const listChild =
              fixture.relation === "positive" || fixture.relation === "sibling";
            const manifest = {
              revision: 1,
              milestones:
                listChild && childLedger === "milestones"
                  ? [{ key: "m1", id: childId }]
                  : [{ key: "m1", id: "M900" }],
              tasks:
                listChild && childLedger === "tasks"
                  ? [{ key: "t1", id: childId }]
                  : [{ key: "t1", id: "T900" }],
            };
            if (row.edgeKind === "active-current-draft") {
              ownerEntry.item = {
                ...ownerEntry.item,
                fields: {
                  ...ownerEntry.item.fields,
                  planCurrentDraft: JSON.stringify({
                    identity: {
                      goalId: ownerId,
                      claimId: "claim_x",
                      generation: 1,
                      revision: 1,
                    },
                    manifest,
                  }),
                },
              };
            } else {
              ownerEntry.item = {
                ...ownerEntry.item,
                fields: {
                  ...ownerEntry.item.fields,
                  planFinalizedManifest: JSON.stringify(manifest),
                },
              };
            }
            // Ensure listed placeholders exist when the child is not the pad id.
            if (!(listChild && childLedger === "milestones")) {
              entries.push({
                ledger: "milestones",
                item: makeItem("M900", "open", { title: "pad" }),
              });
            }
            if (!(listChild && childLedger === "tasks")) {
              entries.push({
                ledger: "tasks",
                item: makeItem("T900", "planned", { headline: "pad" }),
              });
            }
          }
        }

        const state = stateFrom(entries);
        const graph = closeWorkset([fixture.ownerRef], state);

        if (fixture.relation === "positive") {
          expect(nodeRefs(graph)).toContain(fixture.childRef);
          expect(
            graph.edges.some(
              (e) =>
                e.from === fixture.ownerRef &&
                e.to === fixture.childRef &&
                e.kind === row.edgeKind,
            ),
          ).toBe(true);
        } else if (fixture.relation === "reverse") {
          // Root is fixture.ownerRef which is the original child in reverse fixtures.
          // Reverse must not include the original owner via ownership.
          expect(nodeRefs(graph)).not.toContain(fixture.childRef);
        } else if (fixture.relation === "sibling") {
          // Both positive child and sibling are under the owner — both included
          // when sealed under the owner. The fixture's `included: false` means
          // sibling must not join via reverse/unrelated paths when only the
          // positive child is selected as root — re-check via child root.
          const fromChild = closeWorkset([fixture.childRef], state);
          expect(nodeRefs(fromChild)).not.toContain(fixture.otherRef);
        } else {
          // unrelated
          expect(nodeRefs(graph)).not.toContain(fixture.childRef);
        }
      }
    }
  });
});

describe("workset-graph — empty roots", () => {
  it("empty configuration is non-restrictive and empty", () => {
    const state = stateFrom([
      { ledger: "tasks", item: makeItem("T1", "planned", { headline: "x" }) },
    ]);
    const graph = closeWorkset([], state);
    expect(graph.restrictive).toBe(false);
    expect(graph.roots).toEqual([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
