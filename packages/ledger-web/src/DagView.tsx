/**
 * SVG renderer for the milestone dependency DAG.
 *
 * Thin mapping over {@link computeDagLayout}: nodes are rounded rects carrying
 * id / title / status / reference-count; edges are bezier connectors with an
 * arrowhead pointing at the dependent milestone. Clicking a node selects it.
 */

import React from "react";
import { computeDagLayout, DEFAULT_LAYOUT_OPTS } from "./dagLayout.js";
import type { DagData } from "./dagData.js";

const STATUS_COLORS: Record<string, string> = {
  open: "#4ea1ff",
  done: "#57d18a",
  postponed: "#8b93a7",
  blocked: "#ef6a6a",
};
function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#e0b341";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function DagView({
  data,
  selectedId,
  onSelect,
}: {
  data: DagData;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const ids = data.milestones.map((m) => m.id);
  const layout = computeDagLayout(ids, data.edges);
  const byId = new Map(data.milestones.map((m) => [m.id, m]));
  const posById = new Map(layout.nodes.map((n) => [n.id, n]));

  if (ids.length === 0) {
    return <p className="lw-empty">(no milestones to graph)</p>;
  }

  return (
    <svg
      className="lw-dag"
      data-testid="dag-svg"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      <defs>
        <marker id="lw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#566" />
        </marker>
      </defs>

      {layout.edges.map((e) => {
        const midX = (e.x1 + e.x2) / 2;
        const d = `M${e.x1},${e.y1} C${midX},${e.y1} ${midX},${e.y2} ${e.x2},${e.y2}`;
        return (
          <path
            key={`${e.from}->${e.to}`}
            data-testid={`dag-edge-${e.from}-${e.to}`}
            d={d}
            fill="none"
            stroke="#566"
            strokeWidth={1.5}
            markerEnd="url(#lw-arrow)"
          />
        );
      })}

      {data.milestones.map((m) => {
        const n = posById.get(m.id);
        if (n === undefined) return null;
        const color = statusColor(m.status);
        const active = m.id === selectedId;
        return (
          <g
            key={m.id}
            data-testid={`dag-node-${m.id}`}
            transform={`translate(${n.x},${n.y})`}
            onClick={() => onSelect(m.id)}
            style={{ cursor: "pointer" }}
          >
            <rect
              width={n.w}
              height={n.h}
              rx={6}
              fill="#171a21"
              stroke={active ? "#e6e9ef" : color}
              strokeWidth={active ? 2.5 : 1.5}
            />
            <rect width={4} height={n.h} rx={2} fill={color} />
            <text x={12} y={18} fill="#e6e9ef" fontSize={12} fontWeight={700}>
              {m.id}
            </text>
            <text x={12} y={34} fill="#c7cdda" fontSize={11}>
              {truncate(byId.get(m.id)!.title, 22)}
            </text>
            <text x={12} y={49} fill={color} fontSize={10}>
              {m.status}
            </text>
            <text x={n.w - 10} y={49} fill="#8b93a7" fontSize={10} textAnchor="end">
              {m.refCount} item{m.refCount === 1 ? "" : "s"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export { DEFAULT_LAYOUT_OPTS };
