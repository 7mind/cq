/**
 * Unit tests for the shared elk layout adapter + thin SVG renderer (T202).
 *
 * The layout assertions are a PURE elk call — no getBBox / ResizeObserver /
 * DOMMatrix. happy-dom is registered only because elkjs's fake worker needs a
 * `Worker` global, and to render {@link DiagramSvg} for the structural
 * data-testid assertions. The layout proper never measures the DOM.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { layoutDiagram, type DiagramModel, type LaidOutDiagram } from "../src/diagramLayout";
import { DiagramSvg } from "../src/DiagramSvg";

const isFinite = (n: number): boolean => Number.isFinite(n);

const model: DiagramModel = {
  nodes: [
    { id: "open", label: "open", fill: "#4ea1ff" },
    { id: "wip", label: "wip", fill: "#e0b341" },
    { id: "closed", label: "closed", terminal: true, fill: "#57d18a" },
  ],
  edges: [
    { from: "open", to: "wip", label: "start" },
    { from: "wip", to: "wip", label: "retry" }, // self-loop, labelled
    { from: "wip", to: "closed" },
  ],
};

describe("layoutDiagram (pure elk)", () => {
  it("produces finite node coordinates, routed edges, and a finite label position", async () => {
    const out = await layoutDiagram(model);

    expect(out.nodes).toHaveLength(3);
    for (const n of out.nodes) {
      expect(isFinite(n.x)).toBe(true);
      expect(isFinite(n.y)).toBe(true);
      expect(isFinite(n.w)).toBe(true);
      expect(isFinite(n.h)).toBe(true);
      expect(n.w).toBeGreaterThan(0);
      expect(n.h).toBeGreaterThan(0);
    }
    // Terminal + fill carried through unchanged.
    expect(out.nodes.find((n) => n.id === "closed")!.terminal).toBe(true);
    expect(out.nodes.find((n) => n.id === "open")!.fill).toBe("#4ea1ff");

    // Every edge routes to >= 2 points, including the self-loop.
    expect(out.edges).toHaveLength(3);
    for (const e of out.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      for (const p of e.points) {
        expect(isFinite(p.x)).toBe(true);
        expect(isFinite(p.y)).toBe(true);
      }
    }

    // The self-loop edge is present and routed.
    const selfLoop = out.edges.find((e) => e.from === "wip" && e.to === "wip")!;
    expect(selfLoop.points.length).toBeGreaterThanOrEqual(2);

    // The labelled edge carries a finite label position.
    const labelled = out.edges.find((e) => e.from === "open" && e.to === "wip")!;
    expect(labelled.label).toBe("start");
    expect(labelled.labelPos).toBeDefined();
    expect(isFinite(labelled.labelPos!.x)).toBe(true);
    expect(isFinite(labelled.labelPos!.y)).toBe(true);

    // Overall canvas is finite and positive.
    expect(isFinite(out.width)).toBe(true);
    expect(isFinite(out.height)).toBe(true);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it("round-trips agentId, preserving it only on the node that carries one (T326)", async () => {
    const withAgent: DiagramModel = {
      nodes: [
        { id: "a", label: "a", agentId: "wt-T326" },
        { id: "b", label: "b" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const out = await layoutDiagram(withAgent);
    expect(out.nodes.find((n) => n.id === "a")!.agentId).toBe("wt-T326");
    expect(out.nodes.find((n) => n.id === "b")!.agentId).toBeUndefined();
  });
});

describe("DiagramSvg (renderer)", () => {
  it("emits the parameterised data-testid scheme for nodes, edges, and labels", async () => {
    const out: LaidOutDiagram = await layoutDiagram(model);
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(DiagramSvg, { idPrefix: "diag", model: out }));
    });

    const q = (sel: string): Element | null => container.querySelector(sel);

    // Nodes + rects, per the documented scheme.
    expect(q('[data-testid="diag-node-open"]')).not.toBeNull();
    expect(q('[data-testid="diag-rect-open"]')).not.toBeNull();
    expect(q('[data-testid="diag-node-closed"]')).not.toBeNull();

    // Edges.
    expect(q('[data-testid="diag-edge-open-wip"]')).not.toBeNull();
    expect(q('[data-testid="diag-edge-wip-wip"]')).not.toBeNull();
    expect(q('[data-testid="diag-edge-wip-closed"]')).not.toBeNull();

    // Edge label (only for labelled edges).
    expect(q('[data-testid="diag-edge-label-open-wip"]')).not.toBeNull();
    expect(q('[data-testid="diag-edge-label-open-wip"]')!.textContent).toBe("start");
    // Unlabelled edge has no label <text>.
    expect(q('[data-testid="diag-edge-label-wip-closed"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
