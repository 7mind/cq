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
 *
 * Memory reclaim (D67)
 * --------------------
 * The underlying MiniSearch is constructed with `autoVacuum: false` (see
 * {@link makeMini}) to eliminate minisearch's async background-vacuum race that
 * crashed `cq web`. With auto-vacuum off, every rebuild's discard()+add() leaves
 * tombstones that minisearch never reclaims on its own; over a long-running
 * `cq web` (which reindexes on every file change) they accumulate. We reclaim
 * them with a SYNCHRONOUS rebuild-and-swap ({@link LedgerSearchIndex.maybeReclaim})
 * gated on a dirt threshold — never minisearch's async `vacuum()` — so reclaim
 * can never interleave an add()/search the way the background vacuum did.
 */

import MiniSearch from "minisearch";
import type { FieldValue, Item } from "../types.js";
import {
  parseQuery,
  collectTerms,
  isPlainTextQuery,
  evaluate,
  type EvalContext,
} from "./query.js";

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

/**
 * Dirt threshold (number of discarded-document tombstones accumulated since the
 * last reclaim) at which {@link LedgerSearchIndex} performs an atomic
 * rebuild-and-swap to reclaim memory. See the D67 note on the class for why we
 * reclaim by synchronous rebuild rather than minisearch's async vacuum.
 */
const REBUILD_DIRT_THRESHOLD = 1000;

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

/**
 * Construct a MiniSearch configured exactly as this index requires.
 *
 * D67: `autoVacuum: false` is the core of the fix. minisearch's DEFAULT
 * auto-vacuum reclaims discarded-document space ASYNCHRONOUSLY, traversing the
 * inverted-index radix tree in batches that yield via `setTimeout` between
 * batches. Every public op on `LedgerSearchIndex` (replaceBucket/discardSet via
 * add()/discard(), and search()) is SYNCHRONOUS, but a background vacuum's
 * batch-yield opens a window in which a subsequent `add()` can RESTRUCTURE the
 * prefix tree (a node split deletes a compressed edge key) out from under the
 * vacuum's suspended TreeIterator — on resume it dives onto a now-undefined
 * child and throws `TypeError: undefined is not an object (child.keys)`,
 * crashing `cq web`. Disabling auto-vacuum means minisearch NEVER schedules a
 * background vacuum, so no `add()` can ever interleave one. We reclaim tombstone
 * memory ourselves via {@link LedgerSearchIndex.maybeReclaim} — a synchronous
 * rebuild-and-swap that has no async batch-yield window at all.
 */
function makeMini(): MiniSearch<IndexDoc> {
  return new MiniSearch<IndexDoc>({
    idField: "docId",
    fields: ["headline", "body", "status"],
    storeFields: ["ledgerId", "itemId", "status", "archived"],
    autoVacuum: false,
  });
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
  private mini: MiniSearch<IndexDoc>;
  /** docId → full typed Item + metadata, for mapping hits back to Items. */
  private readonly backing = new Map<string, DocBacking>();
  /** ledgerId → set of active docIds currently in the index. */
  private readonly activeDocIds = new Map<string, Set<string>>();
  /** ledgerId → set of archived docIds currently in the index. */
  private readonly archivedDocIds = new Map<string, Set<string>>();
  /**
   * Count of discarded-document tombstones accumulated in `this.mini` since the
   * last reclaim. With auto-vacuum disabled (D67) minisearch never reclaims
   * these itself; we rebuild-and-swap once this crosses
   * {@link REBUILD_DIRT_THRESHOLD}.
   */
  private dirtCount = 0;

  constructor() {
    this.mini = makeMini();
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
    this.maybeReclaim();
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

  /**
   * Search with the GitHub-style query language (qualifiers + boolean groups;
   * see {@link parseQuery}). Plain free-text queries delegate to {@link search}
   * unchanged (preserving its ranked OR/fuzzy/prefix semantics). Structured
   * queries are evaluated as a boolean predicate per item: free-text leaves are
   * matched (and scored) via MiniSearch per distinct term, qualifier leaves
   * against the item's metadata (status/ledger/milestone/author/session) or an
   * item field of that name. Ranking: descending summed term score, then most
   * recently updated.
   */
  searchQuery(query: string, opts: FtsSearchOpts = {}): FtsSearchHit[] {
    const node = parseQuery(query);
    if (node.t === "empty") return [];
    if (isPlainTextQuery(node)) return this.search(query, opts);

    const limit = opts.limit ?? DEFAULT_LIMIT;
    const includeArchived = opts.includeArchived ?? false;
    const statusFilter =
      opts.statusFilter !== undefined ? opts.statusFilter.toLowerCase() : undefined;

    // Per-distinct-term MiniSearch results: docId → { score, fields }.
    const termHits = new Map<string, Map<string, { score: number; fields: string[] }>>();
    for (const term of collectTerms(node)) {
      const m = new Map<string, { score: number; fields: string[] }>();
      for (const r of this.mini.search(term, {
        boost: FIELD_BOOSTS,
        fuzzy: opts.fuzzy === true ? 0.2 : false,
        prefix: opts.prefix === true,
      })) {
        m.set(String(r.id), { score: r.score, fields: matchedFieldsOf(r.match) });
      }
      termHits.set(term, m);
    }

    const scored: Array<{ hit: FtsSearchHit; updatedAt: string; docId: string }> = [];
    for (const [docId, back] of this.backing) {
      if (opts.ledger !== undefined && back.ledgerId !== opts.ledger) continue;
      if (!includeArchived && back.archived) continue;
      if (statusFilter !== undefined && back.item.status.toLowerCase() !== statusFilter) continue;

      const matchedFields = new Set<string>();
      let score = 0;
      const ctx: EvalContext = {
        matchesTerm: (text) => {
          const hit = termHits.get(text)?.get(docId);
          if (hit === undefined) return false;
          score += hit.score;
          for (const f of hit.fields) matchedFields.add(f);
          return true;
        },
        matchesQualifier: (key, value) => matchItemQualifier(back.ledgerId, back.item, key, value),
      };
      if (!evaluate(node, ctx)) continue;
      scored.push({
        hit: { ledgerId: back.ledgerId, item: back.item, score, matchedFields: [...matchedFields] },
        updatedAt: back.item.updatedAt,
        docId,
      });
    }

    scored.sort(
      (a, b) =>
        b.hit.score - a.hit.score ||
        (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
        (a.docId < b.docId ? -1 : 1),
    );
    return scored.slice(0, limit).map((s) => s.hit);
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
        this.dirtCount++;
        this.backing.delete(doc.docId);
      }
      this.mini.add(doc);
      this.backing.set(doc.docId, { ledgerId, item, archived });
      next.add(doc.docId);
    }
    tracker.set(ledgerId, next);
    this.maybeReclaim();
  }

  private discardSet(ids: Set<string> | undefined): void {
    if (ids === undefined) return;
    for (const id of ids) {
      if (this.backing.has(id)) {
        this.mini.discard(id);
        this.dirtCount++;
        this.backing.delete(id);
      }
    }
  }

  /**
   * Reclaim accumulated tombstone memory when the dirt count crosses
   * {@link REBUILD_DIRT_THRESHOLD}, by SYNCHRONOUSLY rebuilding a fresh
   * MiniSearch from the live backing docs and swapping it in.
   *
   * D67: we deliberately do NOT call minisearch's `vacuum()`. That reclaim is
   * async/batched (it yields via `setTimeout` between 1000-term batches), which
   * is precisely the window in which a concurrent `add()` corrupts its
   * suspended radix-tree iterator and throws `child.keys` TypeError. The
   * rebuild below is a single synchronous pass with NO yield, so no `add()` or
   * `search()` can ever interleave it — the swap (`this.mini = next`) is one
   * atomic assignment after the fresh index is fully built. The old instance,
   * with all its tombstones, is discarded wholesale (GC'd) — no vacuum needed.
   *
   * Gated on the threshold so this O(all-live-docs) rebuild amortizes across
   * many mutations rather than running on every rebuild.
   */
  private maybeReclaim(): void {
    if (this.dirtCount < REBUILD_DIRT_THRESHOLD) return;
    const next = makeMini();
    for (const back of this.backing.values()) {
      next.add(toDoc(back.ledgerId, back.item, back.archived));
    }
    this.mini = next;
    this.dirtCount = 0;
  }
}

/**
 * Resolve a `key:value` qualifier against an item (case-insensitive). Known
 * metadata keys (ledger/status/milestone/author/session) match item metadata;
 * any other key matches an item FIELD of that name — exact for scalars,
 * membership for `string[]` values. Unknown/absent → no match.
 */
function matchItemQualifier(ledgerId: string, item: Item, key: string, value: string): boolean {
  const want = value.toLowerCase();
  switch (key) {
    case "ledger":
      return ledgerId.toLowerCase() === want;
    case "status":
      return item.status.toLowerCase() === want;
    case "milestone":
      return item.milestoneId.toLowerCase() === want;
    case "author":
      return (item.author ?? "").toLowerCase() === want;
    case "session":
      return (item.session ?? "").toLowerCase() === want;
    default: {
      const v = item.fields[key];
      if (v === undefined) return false;
      if (Array.isArray(v)) return v.some((e) => e.toLowerCase() === want);
      return v.toLowerCase() === want;
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
