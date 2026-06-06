/**
 * Schema → generic-graph-model adapter for the help dialog's "State machines"
 * tab (T5, migrated to the elk renderer in T203, decision K37).
 *
 * Pure (no DOM/React, no layout): turns a ledger's {@link LedgerSchema} into the
 * generic {@link DiagramModel} ({@link layoutDiagram} positions it, then
 * {@link DiagramSvg} renders it). Node colors are resolved through the SAME
 * {@link statusBucket} → {@link BUCKET_HEX} palette the status badges and the DAG
 * view use, so a status's diagram fill matches its badge exactly.
 *
 * Edges are the `transitions` pairs verbatim — INCLUDING self-loops, which the
 * old `computeDagLayout`-based model dropped; elk routes them as a small arc. A
 * ledger WITHOUT a `transitions` map yields colored nodes and no edges.
 */

import { BUCKET_HEX, isTerminal, statusBucket } from "./status.js";
import type { DiagramModel, DiagramNode, DiagramEdge } from "./diagramLayout.js";
import type { LedgerSchema } from "./types.js";

/** Directed transition pairs from `schema.transitions` (empty when absent). */
function transitionEdges(schema: LedgerSchema): DiagramEdge[] {
  const t = schema.transitions;
  if (t === undefined) return [];
  const edges: DiagramEdge[] = [];
  for (const [from, tos] of Object.entries(t)) {
    for (const to of tos) edges.push({ from, to });
  }
  return edges;
}

/**
 * Build the generic graph model for one ledger's schema. Nodes are the schema's
 * `statusValues` (label = status, fill from {@link statusBucket} +
 * {@link BUCKET_HEX}, `terminal` from {@link isTerminal}); edges are its
 * `transitions` pairs (none when the map is absent, self-loops kept).
 */
export function computeStateMachine(schema: LedgerSchema): DiagramModel {
  const nodes: DiagramNode[] = schema.statusValues.map((status) => ({
    id: status,
    label: status,
    fill: BUCKET_HEX[statusBucket(status, schema)],
    terminal: isTerminal(status, schema),
  }));
  return { nodes, edges: transitionEdges(schema) };
}
