/**
 * Assemble a dependency DAG for a chosen ledger from a LedgerClient.
 *
 * Nodes are that ledger's items; edges come from each item's `dependsOn` /
 * `blockedBy` id[] fields — an edge `dep → item` means `dep` must precede it
 * (so it lands further right). Only intra-ledger references (bare ids that
 * name another item in the same ledger) become edges; cross-ledger refs
 * (`<ledger>:<id>`) are left out.
 *
 * For the milestones ledger each node's sublabel is the count of active items
 * referencing it across all ledgers (every non-milestones ledger groups its
 * items under a milestone id — the group id — so summing group sizes yields
 * the tally with no extra calls). For any other ledger the sublabel is the
 * milestone the item belongs to (`@<milestoneId>`).
 */

import type { FieldValue, LedgerClient } from "./types.js";
import type { DagEdge } from "./dagLayout.js";

const MILESTONES = "milestones";

export interface DagNode {
  id: string;
  title: string;
  status: string;
  /** Short secondary line: ref-count (milestones) or @milestone (others). */
  sublabel: string;
}

export interface DagData {
  ledgerId: string;
  nodes: DagNode[];
  edges: DagEdge[];
}

function asIdArray(v: FieldValue | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
function titleOf(fields: Record<string, FieldValue>): string {
  const pick =
    fields["headline"] ?? fields["title"] ?? fields["question"] ?? fields["summary"] ?? Object.values(fields)[0];
  if (pick === undefined) return "";
  return Array.isArray(pick) ? pick.join(", ") : pick;
}

export async function loadDagData(client: LedgerClient, ledgerId: string): Promise<DagData> {
  const view = await client.fetchLedger(ledgerId);
  const rows = view.milestones.flatMap((g) => g.items.map((item) => ({ item, milestoneId: g.id })));
  const ids = new Set(rows.map((r) => r.item.id));

  const edges: DagEdge[] = [];
  for (const { item } of rows) {
    const deps = [...asIdArray(item.fields["dependsOn"]), ...asIdArray(item.fields["blockedBy"])];
    for (const dep of deps) {
      if (dep !== item.id && ids.has(dep)) edges.push({ from: dep, to: item.id });
    }
  }

  // Milestones-only: tally cross-ledger references per milestone for the sublabel.
  let refCounts: Map<string, number> | null = null;
  if (ledgerId === MILESTONES) {
    refCounts = new Map();
    const others = (await client.enumerateLedgers()).filter((n) => n !== MILESTONES);
    const views = await Promise.all(others.map((n) => client.fetchLedger(n)));
    for (const v of views) {
      for (const g of v.milestones) refCounts.set(g.id, (refCounts.get(g.id) ?? 0) + g.items.length);
    }
  }

  const nodes: DagNode[] = rows.map(({ item, milestoneId }) => ({
    id: item.id,
    title: titleOf(item.fields),
    status: item.status,
    sublabel: refCounts !== null ? `${refCounts.get(item.id) ?? 0} items` : `@${milestoneId}`,
  }));

  return { ledgerId, nodes, edges };
}
