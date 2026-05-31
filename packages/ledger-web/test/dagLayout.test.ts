/**
 * computeDagLayout unit tests — pure, no DOM. Cover layering (longest-path),
 * within-layer rows, edge endpoints, cycle tolerance, and unknown-edge drop.
 */

import { describe, it, expect } from "bun:test";
import { computeDagLayout, DEFAULT_LAYOUT_OPTS, type DagEdge } from "../src/dagLayout.js";

const O = DEFAULT_LAYOUT_OPTS;

function layerOf(layout: ReturnType<typeof computeDagLayout>, id: string): number {
  return layout.nodes.find((n) => n.id === id)!.layer;
}

describe("computeDagLayout", () => {
  it("places a linear chain in successive layers", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    const l = computeDagLayout(["A", "B", "C"], edges);
    expect(layerOf(l, "A")).toBe(0);
    expect(layerOf(l, "B")).toBe(1);
    expect(layerOf(l, "C")).toBe(2);
    // x increases per layer.
    const ax = l.nodes.find((n) => n.id === "A")!.x;
    const cx = l.nodes.find((n) => n.id === "C")!.x;
    expect(cx).toBeGreaterThan(ax);
  });

  it("uses longest path when a node has multiple predecessors", () => {
    // A->C, A->B, B->C : C should be at layer 2 (via A->B->C), not 1.
    const l = computeDagLayout(
      ["A", "B", "C"],
      [
        { from: "A", to: "C" },
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    );
    expect(layerOf(l, "C")).toBe(2);
  });

  it("stacks roots in the same layer on distinct rows", () => {
    const l = computeDagLayout(["A", "B"], []);
    const a = l.nodes.find((n) => n.id === "A")!;
    const b = l.nodes.find((n) => n.id === "B")!;
    expect(a.layer).toBe(0);
    expect(b.layer).toBe(0);
    expect(a.row).not.toBe(b.row);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it("computes edge endpoints from node anchors (source right → target left)", () => {
    const l = computeDagLayout(["A", "B"], [{ from: "A", to: "B" }]);
    const a = l.nodes.find((n) => n.id === "A")!;
    const b = l.nodes.find((n) => n.id === "B")!;
    const e = l.edges[0]!;
    expect(e.x1).toBe(a.x + a.w);
    expect(e.y1).toBe(a.y + a.h / 2);
    expect(e.x2).toBe(b.x);
    expect(e.y2).toBe(b.y + b.h / 2);
  });

  it("drops edges referencing unknown nodes and self-loops", () => {
    const l = computeDagLayout(
      ["A", "B"],
      [
        { from: "A", to: "ghost" },
        { from: "A", to: "A" },
        { from: "A", to: "B" },
      ],
    );
    expect(l.edges).toHaveLength(1);
    expect(l.edges[0]!.from).toBe("A");
    expect(l.edges[0]!.to).toBe("B");
  });

  it("tolerates cycles without infinite recursion", () => {
    const l = computeDagLayout(
      ["A", "B", "C"],
      [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "A" },
      ],
    );
    // Termination + all placed is the guarantee; exact layers for a pure
    // cycle are implementation-defined (one back-edge is broken), but finite,
    // non-negative, and distinct.
    expect(l.nodes).toHaveLength(3);
    const layers = l.nodes.map((n) => n.layer);
    for (const ly of layers) {
      expect(Number.isInteger(ly)).toBe(true);
      expect(ly).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(layers).size).toBe(3);
  });

  it("reports a bounding box that contains every node", () => {
    const l = computeDagLayout(["A", "B", "C"], [{ from: "A", to: "B" }]);
    for (const n of l.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
      expect(n.x).toBeGreaterThanOrEqual(O.pad - 1);
    }
  });

  it("handles an empty graph", () => {
    const l = computeDagLayout([], []);
    expect(l.nodes).toHaveLength(0);
    expect(l.edges).toHaveLength(0);
    expect(l.width).toBeGreaterThan(0);
  });
});
