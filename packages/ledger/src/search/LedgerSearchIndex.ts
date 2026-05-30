/**
 * LedgerSearchIndex — an in-memory full-text index over ledger items,
 * backed by MiniSearch. It is a DERIVED PROJECTION of a LedgerStore's
 * in-memory ledgers: it holds no authority of its own and is rebuilt from
 * the store's items whenever those items change (local `onMutation`) or are
 * re-read from disk by the cross-process coherence relay (`invalidate`).
 *
 * Document model
 * --------------
 * One MiniSearch document per item, keyed by a stable `docId =
 * "<ledgerId>:<itemId>"`. Ledger items have HETEROGENEOUS per-ledger schemas,
 * so we cannot index their raw field names uniformly. Instead each item's
 * field values are bucketed into a small CANONICAL field set that MiniSearch
 * can boost consistently across ledgers:
 *
 *   - `headline` — values of the highest-priority fields (headline / title /
 *     question). Boosted highest.
 *   - `body`     — values of every other string / string[] field
 *     (description, rationale, …). Boosted medium.
 *   - `status`   — the item's status. Boosted lowest.
 *
 * The full typed `Item` is retained in a side map keyed by `docId` so a search
 * hit maps back to a real `Item` (we do NOT reconstruct the Item from stored
 * MiniSearch fields).
 *
 * Per-ledger buckets
 * ------------------
 * Active and archived docs are tracked per ledger so a single ledger can be
 * rebuilt in O(docs-in-ledger) without touching other ledgers. Archived docs
 * are built from immutable archive files; active docs are rebuilt on every
 * change. See `FsLedgerStore` for the I/O wiring and the archive-immutability
 * rationale.
 */

import MiniSearch from "minisearch";
import type { FieldValue, Item } from "../types.js";

/** Field names whose values go into the high-boost `headline` bucket. */
const HEADLINE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "headline",
  "title",
  "question",
]);

/** Default field boosts: headline/title/question > body > status. */
const FIELD_BOOSTS: Readonly<Record<string, number>> = {
  headline: 4,
  body: 2,
  status: 0.5,
};

const DEFAULT_LIMIT = 20;

/** One indexed document (the canonical, ledger-agnostic shape). */
interface IndexDoc {
  docId: string;
  ledgerId: string;
  itemId: string;
  milestoneId: string;
  status: string;
  archived: boolean;
  headline: string;
  body: string;
}

/** A side-table entry mapping a docId back to its full typed Item. */
interface DocBacking {
  ledgerId: string;
  item: Item;
  archived: boolean;
}

export interface FtsSearchOpts {
  /** Restrict to a single ledger; cross-ledger when omitted. */
  ledger?: string;
  /** Max ranked hits to return. Default 20. */
  limit?: number;
  /** Enable MiniSearch fuzzy matching (edit-distance). */
  fuzzy?: boolean;
  /** Enable MiniSearch prefix matching. */
  prefix?: boolean;
  /** Exact (case-insensitive) status filter. */
  statusFilter?: string;
  /** Include archived items. Default false (archived hidden). */
  includeArchived?: boolean;
}

export interface FtsSearchHit {
  ledgerId: string;
  item: Item;
  score: number;
  matchedFields: string[];
}

/**
 * Flatten an item's field values into a single searchable string. `string[]`
 * values are space-joined; non-string scalars are coerced. Empty when the
 * field is absent.
 */
function fieldValueToText(value: FieldValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(" ");
  return value;
}

/** Build the canonical IndexDoc for a single item under `ledgerId`. */
function toDoc(ledgerId: string, item: Item, archived: boolean): IndexDoc {
  const headlineParts: string[] = [];
  const bodyParts: string[] = [];
  for (const [name, value] of Object.entries(item.fields)) {
    const text = fieldValueToText(value);
    if (text.length === 0) continue;
    if (HEADLINE_FIELD_NAMES.has(name)) headlineParts.push(text);
    else bodyParts.push(text);
  }
  return {
    docId: `${ledgerId}:${item.id}`,
    ledgerId,
    itemId: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    archived,
    headline: headlineParts.join(" "),
    body: bodyParts.join(" "),
  };
}

export class LedgerSearchIndex {
  private readonly mini: MiniSearch<IndexDoc>;
  /** docId → full typed Item + metadata, for mapping hits back to Items. */
  private readonly backing = new Map<string, DocBacking>();
  /** ledgerId → set of active docIds currently in the index. */
  private readonly activeDocIds = new Map<string, Set<string>>();
  /** ledgerId → set of archived docIds currently in the index. */
  private readonly archivedDocIds = new Map<string, Set<string>>();

  constructor() {
    this.mini = new MiniSearch<IndexDoc>({
      idField: "docId",
      fields: ["headline", "body", "status"],
      storeFields: ["ledgerId", "itemId", "status", "archived"],
    });
  }

  /**
   * Replace the ACTIVE docs for `ledgerId` with the given items. Pure
   * (no I/O); caller supplies the items. Archived docs for the ledger are
   * untouched.
   */
  rebuildLedgerActive(ledgerId: string, activeItems: Item[]): void {
    this.replaceBucket(this.activeDocIds, ledgerId, activeItems, /*archived*/ false);
  }

  /**
   * Replace the ARCHIVED docs for `ledgerId` with the given items. Pure
   * (no I/O); caller reads the immutable archive files and supplies items.
   * Active docs for the ledger are untouched.
   */
  setLedgerArchived(ledgerId: string, archivedItems: Item[]): void {
    this.replaceBucket(this.archivedDocIds, ledgerId, archivedItems, /*archived*/ true);
  }

  /** Drop every active and archived doc for `ledgerId`. */
  removeLedger(ledgerId: string): void {
    this.discardSet(this.activeDocIds.get(ledgerId));
    this.discardSet(this.archivedDocIds.get(ledgerId));
    this.activeDocIds.delete(ledgerId);
    this.archivedDocIds.delete(ledgerId);
  }

  /**
   * Cross-ledger ranked search. When `opts.ledger` is set, restricts to that
   * ledger. `includeArchived=false` (default) hides archived docs. Returns
   * hits sorted by descending score, each mapped back to its full `Item`.
   */
  search(query: string, opts: FtsSearchOpts = {}): FtsSearchHit[] {
    if (query.trim().length === 0) return [];
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const includeArchived = opts.includeArchived ?? false;
    const statusFilter =
      opts.statusFilter !== undefined ? opts.statusFilter.toLowerCase() : undefined;

    const results = this.mini.search(query, {
      boost: FIELD_BOOSTS,
      fuzzy: opts.fuzzy === true ? 0.2 : false,
      prefix: opts.prefix === true,
      filter: (r) => {
        if (opts.ledger !== undefined && r["ledgerId"] !== opts.ledger) return false;
        if (!includeArchived && r["archived"] === true) return false;
        if (
          statusFilter !== undefined &&
          String(r["status"]).toLowerCase() !== statusFilter
        ) {
          return false;
        }
        return true;
      },
    });

    const hits: FtsSearchHit[] = [];
    for (const r of results) {
      const back = this.backing.get(String(r.id));
      if (back === undefined) continue; // discarded between search + map; skip
      hits.push({
        ledgerId: back.ledgerId,
        item: back.item,
        score: r.score,
        matchedFields: matchedFieldsOf(r.match),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // --- internals ---

  /**
   * Replace one bucket (active|archived) for a ledger: discard the previously
   * tracked docIds for that bucket, then add the fresh items. Keeps the
   * docId-tracking set in sync so a later replacement never discards an id it
   * does not own nor re-adds a duplicate id.
   */
  private replaceBucket(
    tracker: Map<string, Set<string>>,
    ledgerId: string,
    items: Item[],
    archived: boolean,
  ): void {
    const prev = tracker.get(ledgerId);
    if (prev !== undefined) {
      this.discardSet(prev);
    }
    const next = new Set<string>();
    for (const item of items) {
      const doc = toDoc(ledgerId, item, archived);
      // Defensive: a docId must not already be live (the tracking sets
      // guarantee this), but guard so a stray duplicate cannot throw.
      if (this.backing.has(doc.docId)) {
        this.mini.discard(doc.docId);
        this.backing.delete(doc.docId);
      }
      this.mini.add(doc);
      this.backing.set(doc.docId, { ledgerId, item, archived });
      next.add(doc.docId);
    }
    tracker.set(ledgerId, next);
  }

  private discardSet(ids: Set<string> | undefined): void {
    if (ids === undefined) return;
    for (const id of ids) {
      if (this.backing.has(id)) {
        this.mini.discard(id);
        this.backing.delete(id);
      }
    }
  }
}

/**
 * Flatten MiniSearch's `match` (term → list of fields) into a deduplicated
 * list of the canonical field names that matched.
 */
function matchedFieldsOf(match: Record<string, string[]>): string[] {
  const out = new Set<string>();
  for (const fields of Object.values(match)) {
    for (const f of fields) out.add(f);
  }
  return Array.from(out);
}
