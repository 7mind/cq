/**
 * Pure unit tests for the min-layer re-base fix in computeDagLayout (D33 / T199).
 *
 * Tests are DOM-free.  They assert that after the fix:
 *   (A) MILESTONES_SCHEMA, TASKS_SCHEMA, GOALS_SCHEMA through computeStateMachine
 *       yield Math.min(node.x) === 16 (STATE_LAYOUT_OPTS pad).
 *   (B) A flush schema (one that already had minLayer=0) is a no-op: same node
 *       count and identical x-coordinates to a captured baseline.
 *   (C) DEFAULT_LAYOUT_OPTS / DagView path:
 *       (c-i) a minLayer>0 fixture (GOALS transitions via DEFAULT_LAYOUT_OPTS)
 *             yields Math.min(node.x) === 24 (DEFAULT_LAYOUT_OPTS pad).
 *       (c-ii) a graph with a real layer-0 source is byte-identical pre/post rebase.
 *   (D) WIDTH regression: for a minLayer>0 fixture, post-fix width equals
 *       pre-fix width − minLayer*(nodeWidth+hGap).
 *   (E) Empty-graph guard: computeDagLayout([], []) returns width===pad*2,
 *       height===pad*2 without throwing.
 */

import { describe, it, expect } from "bun:test";
import { computeDagLayout, DEFAULT_LAYOUT_OPTS, type DagEdge, type LayoutOpts } from "../src/dagLayout.js";
import { computeStateMachine } from "../src/stateMachine.js";
import {
  MILESTONES_SCHEMA,
  TASKS_SCHEMA,
  GOALS_SCHEMA,
  HYPOTHESIS_SCHEMA,
} from "@cq/ledger";

// STATE_LAYOUT_OPTS mirrors the private constant in stateMachine.ts — reproduced
// here so tests do not depend on an unexported symbol.
const STATE_LAYOUT_OPTS: LayoutOpts = {
  nodeWidth: 120,
  nodeHeight: 40,
  hGap: 56,
  vGap: 18,
  pad: 16,
};

/** Extract directed edges from a schema's transitions map. */
function schemaEdges(schema: { transitions?: Record<string, string[]> }): DagEdge[] {
  const t = schema.transitions;
  if (t === undefined) return [];
  const result: DagEdge[] = [];
  for (const [from, tos] of Object.entries(t)) {
    for (const to of tos) result.push({ from, to });
  }
  return result;
}

// ---------------------------------------------------------------------------
// (A) Real canonical schemas through computeStateMachine — minX === pad === 16
// ---------------------------------------------------------------------------
describe("A — canonical schemas via computeStateMachine (STATE_LAYOUT_OPTS, pad=16)", () => {
  for (const { name, schema } of [
    { name: "MILESTONES_SCHEMA", schema: MILESTONES_SCHEMA },
    { name: "TASKS_SCHEMA", schema: TASKS_SCHEMA },
    { name: "GOALS_SCHEMA", schema: GOALS_SCHEMA },
  ]) {
    it(`${name}: Math.min(node.x) === 16`, () => {
      const m = computeStateMachine(schema);
      expect(m.nodes.length).toBeGreaterThan(0);
      const minX = Math.min(...m.nodes.map((n) => n.x));
      expect(minX).toBe(STATE_LAYOUT_OPTS.pad);
    });
  }
});

// ---------------------------------------------------------------------------
// (B) Previously-flush schema (HYPOTHESIS_SCHEMA) — rebase is a no-op
//
// HYPOTHESIS_SCHEMA transitions: open→uncertain/confirmed/wrong; uncertain→confirmed/wrong.
// "open" has no predecessors, so minLayer=0 before the fix — the re-base changes nothing.
// Baseline x-coordinates captured from a known-good layout (layer 0,1,2,2):
//   open:      pad + 0*(nodeWidth+hGap) = 16
//   uncertain: pad + 1*(nodeWidth+hGap) = 16 + 176 = 192
//   confirmed: pad + 2*(nodeWidth+hGap) = 16 + 352 = 368
//   wrong:     pad + 2*(nodeWidth+hGap) = 368
// ---------------------------------------------------------------------------
describe("B — flush schema (HYPOTHESIS_SCHEMA) is a rebase no-op", () => {
  const BASELINE: Record<string, number> = {
    open: 16,
    uncertain: 192,
    confirmed: 368,
    wrong: 368,
  };

  it("node count is unchanged", () => {
    const m = computeStateMachine(HYPOTHESIS_SCHEMA);
    expect(m.nodes.length).toBe(4);
  });

  it("minX is still 16 (pad)", () => {
    const m = computeStateMachine(HYPOTHESIS_SCHEMA);
    const minX = Math.min(...m.nodes.map((n) => n.x));
    expect(minX).toBe(STATE_LAYOUT_OPTS.pad);
  });

  it("x-coordinates are byte-identical to the pre-fix baseline", () => {
    const m = computeStateMachine(HYPOTHESIS_SCHEMA);
    for (const n of m.nodes) {
      expect(n.x).toBe(BASELINE[n.status]!);
    }
  });
});

// ---------------------------------------------------------------------------
// (C) DagView / DEFAULT_LAYOUT_OPTS path (pad=24)
// ---------------------------------------------------------------------------
describe("C — DEFAULT_LAYOUT_OPTS (pad=24)", () => {
  // (c-i) GOALS transition set has minLayer>0 before the rebase fix.
  // Pre-fix: planned=layer1, building=2, planning=3, clarifying=4, done=3, abandoned=5
  // (minLayer=1). After the fix all layers are rebased down by 1 → minX === pad=24.
  it("c-i: GOALS transitions via DEFAULT_LAYOUT_OPTS — Math.min(node.x) === 24", () => {
    const ids = GOALS_SCHEMA.statusValues;
    const edges = schemaEdges(GOALS_SCHEMA);
    const layout = computeDagLayout(ids, edges, DEFAULT_LAYOUT_OPTS);
    expect(layout.nodes.length).toBe(ids.length);
    const minX = Math.min(...layout.nodes.map((n) => n.x));
    expect(minX).toBe(DEFAULT_LAYOUT_OPTS.pad);
  });

  // (c-ii) A graph WITH a real layer-0 source is unaffected by the rebase.
  // A->B->C: A has no predecessors (layer 0 before and after rebase).
  it("c-ii: linear source graph A->B->C is identical pre/post rebase", () => {
    const layout = computeDagLayout(
      ["A", "B", "C"],
      [{ from: "A", to: "B" }, { from: "B", to: "C" }],
      DEFAULT_LAYOUT_OPTS,
    );
    // A is at layer 0 (source); minLayer=0 → rebase is a no-op.
    const a = layout.nodes.find((n) => n.id === "A")!;
    const b = layout.nodes.find((n) => n.id === "B")!;
    const c = layout.nodes.find((n) => n.id === "C")!;
    expect(a.x).toBe(DEFAULT_LAYOUT_OPTS.pad);                                          // 24
    expect(b.x).toBe(DEFAULT_LAYOUT_OPTS.pad + 1 * (DEFAULT_LAYOUT_OPTS.nodeWidth + DEFAULT_LAYOUT_OPTS.hGap)); // 24+232=256
    expect(c.x).toBe(DEFAULT_LAYOUT_OPTS.pad + 2 * (DEFAULT_LAYOUT_OPTS.nodeWidth + DEFAULT_LAYOUT_OPTS.hGap)); // 24+464=488
  });
});

// ---------------------------------------------------------------------------
// (D) WIDTH regression: width after fix === pre-fix width − minLayer*(nodeWidth+hGap)
//
// Use GOALS transitions through DEFAULT_LAYOUT_OPTS (minLayer was 1 pre-fix).
//   pre-fix:  maxLayer=5 → width = 5*(168+64)+168+24*2 = 1376
//   post-fix: maxLayer=4 → width = 4*(168+64)+168+24*2 = 1144
//   Δ = 232 = 1*(168+64) = minLayer*(nodeWidth+hGap)
// ---------------------------------------------------------------------------
describe("D — width shrinks by minLayer*(nodeWidth+hGap)", () => {
  it("GOALS transitions (minLayer=1 pre-fix): post-fix width === pre-fix width − minLayer*(nodeWidth+hGap)", () => {
    const { nodeWidth, hGap, pad } = DEFAULT_LAYOUT_OPTS;
    const ids = GOALS_SCHEMA.statusValues;
    const edges = schemaEdges(GOALS_SCHEMA);
    const layout = computeDagLayout(ids, edges, DEFAULT_LAYOUT_OPTS);

    // Post-fix: maxRebasedLayer = 4 (abandoned), so width = 4*(nodeWidth+hGap)+nodeWidth+pad*2
    const expectedPostFixWidth = 4 * (nodeWidth + hGap) + nodeWidth + pad * 2;
    expect(layout.width).toBe(expectedPostFixWidth);

    // minLayer was 1 pre-fix, so pre-fix width was (4+1)*(nodeWidth+hGap)+nodeWidth+pad*2
    const priorMinLayer = 1;
    const expectedPreFixWidth = expectedPostFixWidth + priorMinLayer * (nodeWidth + hGap);
    expect(layout.width).toBe(expectedPreFixWidth - priorMinLayer * (nodeWidth + hGap));
  });
});

// ---------------------------------------------------------------------------
// (E) Empty-graph guard — width===pad*2, height===pad*2, no throw
// ---------------------------------------------------------------------------
describe("E — empty-graph guard", () => {
  it("computeDagLayout([], []) returns width===pad*2, height===pad*2 without throwing", () => {
    const layout = computeDagLayout([], []);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(DEFAULT_LAYOUT_OPTS.pad * 2);
    expect(layout.height).toBe(DEFAULT_LAYOUT_OPTS.pad * 2);
  });

  it("empty graph with custom opts uses that opts.pad", () => {
    const customOpts: LayoutOpts = { ...DEFAULT_LAYOUT_OPTS, pad: 10 };
    const layout = computeDagLayout([], [], customOpts);
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(20);
  });
});
