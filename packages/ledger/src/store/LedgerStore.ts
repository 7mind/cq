/**
 * LedgerStore — abstract interface implemented by the production
 * FsLedgerStore and the test-only InMemoryLedgerStore.
 *
 * Lifecycle:
 *  1. Construct.
 *  2. `init()` — load all known ledgers (from ./docs/ledgers.yaml + their .md
 *     files) into memory. After init the store serves reads from memory. The
 *     bootstrapped `milestones` ledger is created on first init if absent.
 *  3. Read methods are synchronous (in-memory) unless they touch disk
 *     (`fetchArchive`).
 *  4. Mutating methods are async (acquire mutex(es) + lockfile(s) + persist).
 *  5. `dispose()` — release any in-process resources.
 *
 * Locking discipline (msunify cycle):
 *  - Per-ledger mutex + lockfile for purely within-ledger ops.
 *  - Global `__milestones__` mutex + lockfile for any operation that
 *    mutates the milestones ledger OR creates/archives an item that
 *    references the milestones ledger.
 *  - Multi-lock acquisition order: `__milestones__` first; then per-ledger
 *    locks in alphabetical order. Documented in FsLedgerStore.
 */

import type {
  ArchivePointer,
  FetchedLedger,
  FieldValue,
  Item,
  LedgerSchema,
  Milestone,
  ResolvedMilestone,
} from "../types.js";
import type { FtsSearchHit, FtsSearchOpts } from "../search/LedgerSearchIndex.js";

export type { FtsSearchHit, FtsSearchOpts } from "../search/LedgerSearchIndex.js";

/**
 * Result shape for `fetchArchive`. Discriminated by `kind`:
 *  - `"group"` — a whole milestone-group archive (non-milestones ledgers).
 *  - `"item"`  — a single milestone-item archive (milestones ledger).
 */
export type ArchiveContent =
  | { kind: "group"; milestone: Milestone }
  | { kind: "item"; item: Item };

/**
 * Operation that triggered a mutation. Used by the `onMutation` hook
 * and by the internal-WS `ledger.changed` envelope. The mirror in
 * `@cq/shared` (`LedgerOp` Zod enum) MUST stay in lockstep — if either
 * drifts, cross-process notifications start dropping at the Zod
 * boundary on receive.
 */
export type LedgerMutationOp = "create" | "update" | "archive";

/**
 * Hook fired after every successful write. Synchronous; the store does
 * NOT await it. If the hook throws, the store logs to stderr and
 * continues — write effects are preserved.
 */
export type OnMutation = (ledgerId: string, op: LedgerMutationOp) => void;

export interface UpdateItemPatch {
  status?: string;
  fields?: Record<string, FieldValue>;
}

export interface CreateItemInit {
  id?: string;
  status: string;
  fields: Record<string, FieldValue>;
}

/**
 * Init shape for `createMilestone` — the four canonical fields of a
 * milestone-item in the milestones ledger. `blockedBy` / `dependsOn` are
 * advisory free-form id[] references (§8c rename).
 */
export interface CreateMilestoneItemInit {
  id?: string;
  title: string;
  description?: string;
  blockedBy?: string[];
  dependsOn?: string[];
}

/**
 * Patch shape for `updateMilestone`. All keys optional; `status` must
 * be one of the milestones schema's statusValues
 * (open/done/postponed/blocked).
 */
export interface UpdateMilestoneItemPatch {
  status?: string;
  title?: string;
  description?: string;
  blockedBy?: string[];
  dependsOn?: string[];
}

/**
 * Return shape for `fetchMilestone(milestoneId)`. The `references` map
 * counts active items in each ledger whose milestone-group id matches
 * `milestoneId` (a quick cross-ledger view useful before archiving).
 */
export interface FetchedMilestoneItem {
  milestone: Item;
  resolved: ResolvedMilestone;
  references: Record<string, number>;
}

export interface LedgerStore {
  init(): Promise<void>;

  // --- reads (sync in-memory unless noted) -------------------------------

  enumerate(): string[];

  /**
   * Fetch a ledger as a resolved view: each milestone-group's metadata
   * is expanded from the milestones ledger at read time. For the
   * milestones ledger itself the resolution is the trivial self-resolution.
   */
  fetch(ledgerId: string): FetchedLedger;

  fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;

  fetchItem(ledgerId: string, itemId: string): Item;

  /**
   * Global milestone lookup. Returns the milestone-item, the resolved
   * view, and per-ledger counts of items referencing it.
   */
  fetchMilestone(milestoneId: string): FetchedMilestoneItem;

  search(ledgerId: string, query: string): Item[];

  /**
   * Ranked full-text search across ledger items, backed by the in-memory
   * `LedgerSearchIndex` (a derived projection of this store, kept coherent by
   * the same local-`onMutation` + remote-`invalidate` hooks that keep the
   * stores coherent). Cross-ledger when `opts.ledger` is omitted; archived
   * items are searchable only when `opts.includeArchived === true` (default
   * false). Hits are ranked by descending score and carry the full `Item`.
   *
   * Async for interface uniformity (no sync/async union) even though the
   * index lookup itself is synchronous; the index is always current by the
   * time a caller reaches this method because the store keeps it in lockstep
   * with its mutations.
   */
  ftsSearch(query: string, opts?: FtsSearchOpts): Promise<FtsSearchHit[]>;

  /**
   * Group every active item in every ledger by its milestone-group id ===
   * `milestoneId`. Returned object keys are ledger ids; values are item
   * arrays. Empty values are omitted.
   */
  listMilestoneItems(milestoneId: string): Record<string, Item[]>;

  // --- mutations (async, write-through under lock) ------------------------

  /**
   * Update a milestone-item in the milestones ledger.
   * Holds the `__milestones__` global lock.
   */
  updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item>;

  updateItem(
    ledgerId: string,
    itemId: string,
    patch: UpdateItemPatch,
  ): Promise<Item>;

  /**
   * Create an item in `ledgerId` under depth-2 group `milestoneId`.
   * STRICT existence check: `milestoneId` must resolve to an active,
   * non-archived, non-terminal item in the milestones ledger. The
   * depth-2 group in `ledgerId` is auto-created on first reference.
   * Holds the `__milestones__` global lock AND the per-ledger lock for
   * `ledgerId` (alphabetic order after `__milestones__`).
   */
  createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item>;

  /**
   * Create a new milestone-item in the milestones ledger.
   * Holds the `__milestones__` global lock.
   */
  createMilestone(init: CreateMilestoneItemInit): Promise<Item>;

  createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger>;

  /**
   * Archive a milestone across all ledgers (Q6 — two-level atomic):
   *  1. Acquire `__milestones__`.
   *  2. For every ledger, find items whose milestone-group is `milestoneId`.
   *     Refuse with `NonTerminalItemsError` if ANY non-terminal item exists
   *     anywhere.
   *  3. For each non-milestones ledger with such a group: detach the
   *     group, write `./archive/<ledger>/<milestoneId>.md`, append the
   *     pointer to that ledger.
   *  4. In the milestones ledger: detach the milestone-item itself,
   *     write `./archive/milestones/<milestoneId>.md`, append the pointer.
   *  5. Refuse to archive the bootstrap group `M0`.
   */
  archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer>;

  /**
   * Drop the in-memory cache for `ledgerId` and re-read it from the
   * underlying source under the per-ledger lock. Used by the cross-
   * process coherence channel (D-COHERENCE) when the OTHER process
   * writes the same `docs/` tree.
   *
   * Contract:
   *  - No-op when the ledger is not registered (graceful — the
   *    receiver may be learning about a brand-new ledger; the FS
   *    implementation falls back to a registry reload under the
   *    registry lock in that case).
   *  - Re-read happens under the per-ledger lock so it cannot
   *    interleave with a local write.
   *  - In-memory stores have no external source of truth, so the
   *    method is a no-op there.
   */
  invalidate(ledgerId: string): Promise<void>;

  dispose(): Promise<void>;
}
