/**
 * Assemble the milestone dependency DAG from a LedgerClient.
 *
 * Nodes are the active milestones (the milestones ledger's items). Edges come
 * from each milestone's `dependsOn` / `blockedBy` id[] fields — an edge
 * `dep → milestone` means `dep` must precede it (so it lands further right).
 * Per-milestone reference counts are tallied client-side: every non-milestones
 * ledger groups its items under a milestone id (the group id), so summing group
 * sizes across ledgers yields how many active items reference each milestone —
 * no extra per-milestone server calls.
 */

import type { FieldValue, LedgerClient } from "./types.js";
import type { DagEdge } from "./dagLayout.js";

const MILESTONES = "milestones";

export interface DagMilestone {
  id: string;
  title: string;
  status: string;
  /** Active items across all ledgers that reference this milestone. */
  refCount: number;
}

export interface DagData {
  milestones: DagMilestone[];
  edges: DagEdge[];
}

function asIdArray(v: FieldValue | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export async function loadDagData(client: LedgerClient): Promise<DagData> {
  const msLedger = await client.fetchLedger(MILESTONES);
  const items = msLedger.milestones.flatMap((g) => g.items);
  const ids = new Set(items.map((i) => i.id));

  const edges: DagEdge[] = [];
  for (const m of items) {
    const deps = [...asIdArray(m.fields["dependsOn"]), ...asIdArray(m.fields["blockedBy"])];
    for (const dep of deps) {
      if (dep !== m.id && ids.has(dep)) edges.push({ from: dep, to: m.id });
    }
  }

  // Reference counts: tally items per milestone group across non-milestones
  // ledgers (fetched in parallel).
  const ledgerNames = (await client.enumerateLedgers()).filter((n) => n !== MILESTONES);
  const counts = new Map<string, number>();
  const views = await Promise.all(ledgerNames.map((n) => client.fetchLedger(n)));
  for (const v of views) {
    for (const g of v.milestones) counts.set(g.id, (counts.get(g.id) ?? 0) + g.items.length);
  }

  const milestones: DagMilestone[] = items.map((m) => {
    const titleField = m.fields["title"];
    return {
      id: m.id,
      title: typeof titleField === "string" ? titleField : (titleField ?? []).join(", "),
      status: m.status,
      refCount: counts.get(m.id) ?? 0,
    };
  });

  return { milestones, edges };
}
