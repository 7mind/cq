/**
 * Pure DAG layout engine for the milestone dependency graph.
 *
 * Renderer-agnostic (no DOM/React): consumes a node-id list + directed edges
 * (`from` precedes `to`) and returns absolute positions plus straight edge
 * endpoints, so the SVG renderer is a thin mapping over this output and the
 * placement logic is unit-testable on its own.
 *
 * Layering is longest-path (a node sits one column right of its deepest
 * predecessor). It is cycle-tolerant: a back-edge encountered while a node is
 * still on the recursion stack contributes 0, which breaks the cycle instead
 * of looping forever. Edges referencing unknown node ids are dropped.
 */

export interface DagEdge {
  /** Source node id — must be laid out to the LEFT of `to`. */
  from: string;
  /** Target node id. */
  to: string;
}

export interface LayoutOpts {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal gap between layers (columns). */
  hGap: number;
  /** Vertical gap between rows within a layer. */
  vGap: number;
  /** Outer padding around the whole graph. */
  pad: number;
}

export const DEFAULT_LAYOUT_OPTS: LayoutOpts = {
  nodeWidth: 168,
  nodeHeight: 56,
  hGap: 64,
  vGap: 22,
  pad: 24,
};

export interface PositionedNode {
  id: string;
  layer: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PositionedEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DagLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

/**
 * Compute a left→right layered layout. `nodeIds` defines membership and the
 * stable within-layer ordering; `edges` define precedence.
 */
export function computeDagLayout(
  nodeIds: readonly string[],
  edges: readonly DagEdge[],
  opts: LayoutOpts = DEFAULT_LAYOUT_OPTS,
): DagLayout {
  const known = new Set(nodeIds);
  // Keep only edges between known nodes and drop self-loops.
  const validEdges = edges.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to));

  const preds = new Map<string, string[]>();
  for (const id of nodeIds) preds.set(id, []);
  for (const e of validEdges) preds.get(e.to)!.push(e.from);

  // Longest-path layering with on-stack cycle breaking.
  const layer = new Map<string, number>();
  const onStack = new Set<string>();
  const layerOf = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (onStack.has(id)) return 0; // back-edge: break the cycle
    onStack.add(id);
    let best = 0;
    for (const p of preds.get(id) ?? []) best = Math.max(best, layerOf(p) + 1);
    onStack.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of nodeIds) layerOf(id);

  // Group by layer in stable input order; assign rows.
  const byLayer = new Map<number, string[]>();
  for (const id of nodeIds) {
    const l = layer.get(id)!;
    const arr = byLayer.get(l) ?? [];
    arr.push(id);
    byLayer.set(l, arr);
  }

  const pos = new Map<string, PositionedNode>();
  let maxLayer = 0;
  let maxRows = 0;
  for (const [l, ids] of byLayer) {
    maxLayer = Math.max(maxLayer, l);
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, row) => {
      pos.set(id, {
        id,
        layer: l,
        row,
        x: opts.pad + l * (opts.nodeWidth + opts.hGap),
        y: opts.pad + row * (opts.nodeHeight + opts.vGap),
        w: opts.nodeWidth,
        h: opts.nodeHeight,
      });
    });
  }

  const nodes = nodeIds.map((id) => pos.get(id)!);
  const positionedEdges: PositionedEdge[] = validEdges.map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    return {
      from: e.from,
      to: e.to,
      x1: a.x + a.w,
      y1: a.y + a.h / 2,
      x2: b.x,
      y2: b.y + b.h / 2,
    };
  });

  const width = maxLayer * (opts.nodeWidth + opts.hGap) + opts.nodeWidth + opts.pad * 2;
  const height = maxRows * (opts.nodeHeight + opts.vGap) - (maxRows > 0 ? opts.vGap : 0) + opts.pad * 2;

  return { nodes, edges: positionedEdges, width, height: Math.max(height, opts.pad * 2) };
}
