/**
 * Shared elk-based layout adapter for the web frontend's diagram tabs (T202,
 * decision K37). Both the State-machines tab (T203) and the Flows tab (T205)
 * feed a generic graph model through {@link layoutDiagram} and render the result
 * with {@link DiagramSvg}, replacing the homegrown `computeDagLayout` path for
 * those two tabs.
 *
 * This module is pure-ish: it has no React/DOM dependency, but `elk.layout()` is
 * async (it drives a fake Web Worker), so the consumer computes the laid-out
 * model in a `useEffect`. The function maps the generic model → an elk graph
 * (layered, LEFT→RIGHT to match the current state-machine look), runs elk, and
 * maps the result back into a flat, render-ready {@link LaidOutDiagram}.
 */

import ELK, {
  type ElkNode,
  type ElkExtendedEdge,
  type ElkLabel,
  type ElkPoint,
} from "elkjs/lib/elk.bundled.js";

/** A node in the caller's generic graph model. */
export interface DiagramNode {
  id: string;
  label: string;
  /** True for a terminal state — drawn with a thick outline + sharp corners. */
  terminal?: boolean;
  /** Hex fill; the renderer applies a default when absent. */
  fill?: string;
  /**
   * Identifies an agent this node represents. When present, the renderer makes
   * the node activatable (click / Enter / Space → `onActivateAgent`); absent
   * nodes stay static. Preserved through {@link layoutDiagram} like `fill`.
   */
  agentId?: string;
}

/** A directed edge in the caller's generic graph model. */
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** The caller's generic, unpositioned graph. */
export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** A laid-out node: position + size carried alongside the original fields. */
export interface LaidOutNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  terminal: boolean;
  fill?: string;
  /** Carried through from {@link DiagramNode.agentId} (like `fill`). */
  agentId?: string;
}

/** A laid-out edge: elk's routing polyline + optional label position. */
export interface LaidOutEdge {
  from: string;
  to: string;
  label?: string;
  /** Routing points (start → bends → end); always length ≥ 2 when routed. */
  points: { x: number; y: number }[];
  /** Centre of the edge label, when the edge carries one. */
  labelPos?: { x: number; y: number };
}

/** The render-ready, positioned diagram. */
export interface LaidOutDiagram {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

// Default node box — matches the current state-machine boxes (App.tsx).
const NODE_WIDTH = 120;
const NODE_HEIGHT = 40;
// Per-character + base estimate for an edge label's box, so elk reserves room
// for the <text> the renderer emits at labelPos. ~12px text ≈ 7px/char.
const LABEL_CHAR_WIDTH = 7;
const LABEL_BASE_WIDTH = 8;
const LABEL_HEIGHT = 14;

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  // LEFT→RIGHT flow to match the current state-machine diagram look.
  "elk.direction": "RIGHT",
  // Place edge labels inline along the routed edge (gives label x/y back).
  "elk.edgeLabels.inline": "true",
  "elk.layered.edgeLabels.sideSelection": "ALWAYS_DOWN",
  // Self-loops route as a small arc rather than being dropped.
  "elk.layered.feedbackEdges": "true",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.edgeLabel": "4",
};

function estimateLabelSize(text: string): { width: number; height: number } {
  return { width: LABEL_BASE_WIDTH + text.length * LABEL_CHAR_WIDTH, height: LABEL_HEIGHT };
}

function toElkNode(n: DiagramNode): ElkNode {
  return {
    id: n.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    labels: [{ text: n.label }],
  };
}

function toElkEdge(e: DiagramEdge, index: number): ElkExtendedEdge {
  const labels: ElkLabel[] =
    e.label === undefined ? [] : [{ text: e.label, ...estimateLabelSize(e.label) }];
  return {
    id: `e${index}`,
    sources: [e.from],
    targets: [e.to],
    labels,
  };
}

/** Flatten an elk edge section (start → bends → end) into a point list. */
function sectionPoints(section: {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [{ x: section.startPoint.x, y: section.startPoint.y }];
  for (const b of section.bendPoints ?? []) pts.push({ x: b.x, y: b.y });
  pts.push({ x: section.endPoint.x, y: section.endPoint.y });
  return pts;
}

/**
 * Lay out a generic diagram via elkjs. Returns a flat, positioned model the
 * {@link DiagramSvg} renderer maps 1:1 onto SVG. Async because `elk.layout()`
 * runs on a (fake) worker.
 */
export async function layoutDiagram(model: DiagramModel): Promise<LaidOutDiagram> {
  const elk = new ELK();
  const graph: ElkNode = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: model.nodes.map(toElkNode),
    edges: model.edges.map(toElkEdge),
  };

  const out = await elk.layout(graph);

  const fillById = new Map(model.nodes.map((n) => [n.id, n.fill]));
  const agentIdById = new Map(model.nodes.map((n) => [n.id, n.agentId]));
  const terminalById = new Map(model.nodes.map((n) => [n.id, n.terminal === true]));

  const nodes: LaidOutNode[] = (out.children ?? []).map((c) => {
    const orig = model.nodes.find((n) => n.id === c.id)!;
    const node: LaidOutNode = {
      id: c.id,
      label: orig.label,
      x: c.x ?? 0,
      y: c.y ?? 0,
      w: c.width ?? NODE_WIDTH,
      h: c.height ?? NODE_HEIGHT,
      terminal: terminalById.get(c.id) ?? false,
    };
    const fill = fillById.get(c.id);
    if (fill !== undefined) node.fill = fill;
    const agentId = agentIdById.get(c.id);
    if (agentId !== undefined) node.agentId = agentId;
    return node;
  });

  // elk attaches routed edges to `root.edges`; map each back to its model edge
  // by index (edge id `e<index>`).
  const outEdges = (out.edges ?? []) as ElkExtendedEdge[];
  const edges: LaidOutEdge[] = outEdges.map((oe) => {
    const index = Number(oe.id.slice(1));
    const orig = model.edges[index]!;
    const section = oe.sections?.[0];
    const points = section === undefined ? [] : sectionPoints(section);
    const edge: LaidOutEdge = { from: orig.from, to: orig.to, points };
    if (orig.label !== undefined) edge.label = orig.label;
    const label = oe.labels?.[0];
    if (label !== undefined && label.x !== undefined && label.y !== undefined) {
      edge.labelPos = {
        x: label.x + (label.width ?? 0) / 2,
        y: label.y + (label.height ?? 0) / 2,
      };
    }
    return edge;
  });

  return {
    nodes,
    edges,
    width: out.width ?? 0,
    height: out.height ?? 0,
  };
}
