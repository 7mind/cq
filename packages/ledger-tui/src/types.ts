/**
 * Decoded data shapes the TUI works with.
 *
 * These mirror the JSON the ledger MCP tools return. The structural types
 * are imported (type-only, erased at runtime) from `@cq/ledger` so the TUI
 * stays in lockstep with the server's data contract without taking a
 * runtime dependency on the library.
 */

import type {
  Item,
  FieldValue,
  FetchedLedger,
  FetchedMilestoneGroup,
  LedgerSummary,
  ResolvedMilestone,
  LedgerSchema,
} from "@cq/ledger";
import type { ArchiveContent } from "@cq/ledger";

export type { Item, FieldValue, FetchedLedger, FetchedMilestoneGroup, LedgerSummary, ResolvedMilestone, LedgerSchema, ArchiveContent };

/** A single `fts_search` hit. */
export interface FtsHit {
  ledgerId: string;
  item: Item;
  score: number;
  matchedFields: string[];
}

/** Patch accepted by {@link LedgerClient.updateItem}. */
export interface ItemPatch {
  status?: string;
  fields?: Record<string, FieldValue>;
  /** Provenance of this write (see {@link Item.author}). */
  author?: string;
  /** Provenance of this write (see {@link Item.session}). */
  session?: string;
}

/** Init accepted by {@link LedgerClient.createItem}. */
export interface ItemInit {
  status: string;
  fields: Record<string, FieldValue>;
  id?: string;
  /** Provenance of the creating write (see {@link Item.author}). */
  author?: string;
  /** Provenance of the creating write (see {@link Item.session}). */
  session?: string;
}

/** Patch accepted by {@link LedgerClient.updateMilestone}. */
export interface MilestonePatch {
  status?: string;
  title?: string;
  description?: string;
}

/**
 * The operations the TUI needs from a ledger MCP server. Implemented by
 * {@link McpLedgerClient} (real, over HTTP) and by the in-memory fake the
 * UI tests drive. Keeping it an interface is what lets the Ink components
 * be tested without a network.
 */
export interface LedgerClient {
  /**
   * The project display name surfaced by the server on connect (serverInfo.title
   * or the 'Project: <name>' instructions fallback). Captured at connect time so
   * this accessor is synchronous.
   */
  displayName(): string;
  enumerateLedgers(): Promise<LedgerSummary[]>;
  fetchLedger(ledgerId: string): Promise<FetchedLedger>;
  fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;
  fetchItem(ledgerId: string, itemId: string): Promise<Item>;
  createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item>;
  updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item>;
  ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]>;
  createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item>;
  updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item>;
  close(): Promise<void>;
}
