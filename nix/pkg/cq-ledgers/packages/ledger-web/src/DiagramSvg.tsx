/**
 * Thin SVG renderer for a {@link LaidOutDiagram} (T202, decision K37). Shared by
 * both diagram tabs: the State-machines tab (T203) and the Flows tab (T205) each
 * lay out their graph via {@link layoutDiagram} and render the result here.
 *
 * Generic: the component takes an `idPrefix` and the laid-out model; it knows
 * nothing about ledgers or flows. The data-testid scheme is parameterised so a
 * caller can reproduce a per-context naming (e.g. T203 passes
 * `idPrefix="help-sm"` + node id `<ledger>-<status>` to recover the existing
 * `help-sm-node-<ledger>-<status>` ids):
 *   - `${idPrefix}-node-${id}`                  group per node
 *   - `${idPrefix}-rect-${id}`                  the node's rounded rect
 *   - `${idPrefix}-edge-${from}-${to}`           the edge polyline
 *   - `${idPrefix}-edge-label-${from}-${to}-${i}` the edge's <text> label
 *     (i = the edge's global index in the laid-out edges array; ensures each
 *     parallel edge on the same from→to pair gets a unique, individually
 *     addressable testid — T334)
 *
 * Node fill + terminal styling are carried over verbatim from the previous
 * StateMachineDiagram: rounded-rect (rx 14, or 4 + thick 2.5 outline when
 * terminal), bucket-hex fill, dark label. Edges are polylines through elk's
 * routing points with an arrowhead marker; labels are <text> at `labelPos`.
 */

import React, { useMemo } from "react";
import type { LaidOutDiagram } from "./diagramLayout.js";

// Default node fill when the model node carries none (callers normally supply a
// BUCKET_HEX value). Matches the neutral "dropped" grey.
const DEFAULT_FILL = "#8b93a7";
const EDGE_STROKE = "#566";
const NODE_STROKE = "#171a21";
// Node labels sit on a filled <rect> (DEFAULT_FILL grey or a roleKind colour),
// so a dark fill always contrasts. EDGE labels render directly on the help-panel
// background — which is exactly #171a21 (var(--panel)), so a hard-coded dark fill
// is invisible. Edge labels therefore use the themed foreground var instead.
const LABEL_FILL = "#171a21";
const EDGE_LABEL_FILL = "var(--fg)";
// Carried over from StateMachineDiagram: rx values + outline weights.
const RX_TERMINAL = 4;
const RX_NORMAL = 14;
const STROKE_TERMINAL = 2.5;
const STROKE_NORMAL = 1;

export interface DiagramSvgProps {
  /** Prefix for every data-testid emitted (see module doc). */
  idPrefix: string;
  model: LaidOutDiagram;
  /** Extra class on the root <svg> (the state-machine svg uses one). */
  className?: string;
  /**
   * Invoked with a node's `agentId` when an activatable node is clicked or
   * keyboard-activated (Enter / Space). Nodes WITHOUT an `agentId` stay static
   * and never call this. Optional — when absent, even agentId-bearing nodes are
   * rendered but inert (no `role="button"`, no handlers).
   */
  onActivateAgent?: (agentId: string) => void;
}

/** Render an SVG polyline `points` attribute from routing points. */
function polylinePoints(points: { x: number; y: number }[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * Render a laid-out diagram as inline SVG. Pure presentation: no layout, no
 * async — the caller has already resolved {@link layoutDiagram}.
 */
export function DiagramSvg({
  idPrefix,
  model,
  className,
  onActivateAgent,
}: DiagramSvgProps): React.ReactElement {
  // One arrowhead marker per instance so multiple diagrams on a page don't
  // collide on the marker id.
  const markerId = useMemo(() => `${idPrefix}-arrow`, [idPrefix]);
  return (
    <svg
      className={className}
      data-testid={`${idPrefix}-svg`}
      width={model.width}
      height={model.height}
      // CSS width:100% fills the container; this caps upscaling at the
      // diagram's intrinsic width so a narrow diagram stays left-aligned
      // instead of stretched (carried over from the state-machine svg).
      style={{ maxWidth: model.width }}
      viewBox={`0 0 ${model.width} ${model.height}`}
      preserveAspectRatio="xMinYMid meet"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STROKE} />
        </marker>
      </defs>
      {model.edges.map((e, i) => (
        // Key by array index, not `from->to`: a flow may be a multigraph with
        // PARALLEL edges between the same node pair (e.g. reviewer→orchestrator
        // 'returns verdict' AND 'files defect'), which collide on a from-to key.
        <React.Fragment key={`edge-${i}`}>
          <polyline
            data-testid={`${idPrefix}-edge-${e.from}-${e.to}`}
            points={polylinePoints(e.points)}
            fill="none"
            stroke={EDGE_STROKE}
            strokeWidth={1.5}
            markerEnd={`url(#${markerId})`}
          />
          {e.label !== undefined && e.labelPos !== undefined ? (
            <text
              data-testid={`${idPrefix}-edge-label-${e.from}-${e.to}-${i}`}
              x={e.labelPos.x}
              y={e.labelPos.y}
              fill={EDGE_LABEL_FILL}
              fontSize={11}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {e.label}
            </text>
          ) : null}
        </React.Fragment>
      ))}
      {model.nodes.map((n) => {
        // A node is activatable only when it carries an agentId AND a handler
        // was supplied. Otherwise it stays static / non-interactive.
        const agentId = n.agentId;
        const activatable = agentId !== undefined && onActivateAgent !== undefined;
        const activate = activatable
          ? (): void => onActivateAgent(agentId)
          : undefined;
        const interactiveProps = activatable
          ? {
              role: "button",
              tabIndex: 0,
              style: { cursor: "pointer" },
              onClick: activate,
              onKeyDown: (ev: React.KeyboardEvent): void => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  activate!();
                }
              },
            }
          : {};
        return (
        <g
          key={n.id}
          data-testid={`${idPrefix}-node-${n.id}`}
          transform={`translate(${n.x},${n.y})`}
          {...interactiveProps}
        >
          <rect
            data-testid={`${idPrefix}-rect-${n.id}`}
            width={n.w}
            height={n.h}
            rx={n.terminal ? RX_TERMINAL : RX_NORMAL}
            fill={n.fill ?? DEFAULT_FILL}
            stroke={NODE_STROKE}
            strokeWidth={n.terminal ? STROKE_TERMINAL : STROKE_NORMAL}
          />
          <text
            x={n.w / 2}
            y={n.h / 2 + 4}
            fill={LABEL_FILL}
            fontSize={12}
            fontWeight={700}
            textAnchor="middle"
            style={activatable ? { textDecoration: "underline" } : undefined}
          >
            {n.label}
          </text>
        </g>
        );
      })}
    </svg>
  );
}
