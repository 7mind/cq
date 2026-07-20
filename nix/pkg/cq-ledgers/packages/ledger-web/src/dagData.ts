/**
 * Assemble a dependency DAG for a chosen ledger from a LedgerClient.
 *
 * Nodes are that ledger's items; edges come from each item's `dependsOn` /
 * `blockedBy` id[] fields — an edge `dep → item` means `dep` must precede it
 * (so it lands further right). Only intra-ledger references become edges —
 * either the legacy bare form ("D1") or the canonical prefixed form naming
 * THIS ledger ("bugs:D1", G80/M245); a prefixed ref naming any OTHER ledger
 * (`<ledger>:<id>`) is a cross-ledger reference and is left out.
 *
 * For the milestones ledger each node's sublabel is the count of active items
 * referencing it across all ledgers (every non-milestones ledger groups its
 * items under a milestone id — the group id — so summing group sizes yields
 * the tally with no extra calls). For any other ledger the sublabel is the
 * milestone the item belongs to (`@<milestoneId>`).
 */

// Import via the PURE `/refs` subpath (like `/relationships` / `/constants`):
// the root `@cq/ledger` entry pulls server-only modules into the browser
// bundle and crashes the served web app.
import { parseRef, RefParseError } from "@cq/ledger/refs";
import type { FieldValue, LedgerClient, LedgerSchema } from "./types.js";
import type { DagEdge } from "./dagLayout.js";

const MILESTONES = "milestones";

/**
 * Resolves a raw `dependsOn`/`blockedBy` entry to the bare id it names WITHIN
 * `ledgerId`, or `undefined` if it names another ledger (cross-ledger — no
 * edge) or fails to parse at all. Accepts both the legacy bare form ("D1")
 * and the canonical prefixed form ("bugs:D1", G80/M245) — a prefixed entry
 * is intra-ledger only when its named ledger equals `ledgerId` itself.
 */
function intraLedgerDepId(raw: string, ledgerId: string): string | undefined {
  if (!raw.includes(":")) return raw; // legacy bare form — unchanged
  let parsed;
  try {
    parsed = parseRef(raw);
  } catch (err) {
    if (err instanceof RefParseError) return undefined;
    throw err;
  }
  return parsed.kind === "prefixed" && parsed.ledger === ledgerId ? parsed.id : undefined;
}

export interface DagNode {
  id: string;
  title: string;
  status: string;
  /** Short secondary line: ref-count (milestones) or @milestone (others). */
  sublabel: string;
}

export interface DagData {
  ledgerId: string;
  /** The graphed ledger's schema — drives per-node status→bucket coloring. */
  schema: LedgerSchema;
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
      const depId = intraLedgerDepId(dep, ledgerId);
      if (depId !== undefined && depId !== item.id && ids.has(depId)) edges.push({ from: depId, to: item.id });
    }
  }

  // Milestones-only: tally cross-ledger references per milestone for the sublabel.
  let refCounts: Map<string, number> | null = null;
  if (ledgerId === MILESTONES) {
    refCounts = new Map();
    const others = (await client.enumerateLedgers())
      .map((l) => l.name)
      .filter((n) => n !== MILESTONES);
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

  return { ledgerId, schema: view.schema, nodes, edges };
}
