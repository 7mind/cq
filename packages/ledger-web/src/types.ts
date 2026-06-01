/**
 * Decoded data shapes the web UI works with — structural types imported
 * (type-only, erased at runtime) from `@cq/ledger` so the UI stays in lockstep
 * with the server's data contract without a runtime dependency on the library.
 */

import type {
  Item,
  FieldValue,
  FetchedLedger,
  FetchedMilestoneGroup,
  ResolvedMilestone,
  LedgerSchema,
} from "@cq/ledger";

export type { Item, FieldValue, FetchedLedger, FetchedMilestoneGroup, ResolvedMilestone, LedgerSchema };

export interface FtsHit {
  ledgerId: string;
  item: Item;
  score: number;
  matchedFields: string[];
}

export interface ItemPatch {
  status?: string;
  fields?: Record<string, FieldValue>;
  /** Provenance of this write (see {@link Item.author}). */
  author?: string;
  /** Provenance of this write (see {@link Item.session}). */
  session?: string;
}

export interface ItemInit {
  status: string;
  fields: Record<string, FieldValue>;
  id?: string;
  /** Provenance of the creating write (see {@link Item.author}). */
  author?: string;
  /** Provenance of the creating write (see {@link Item.session}). */
  session?: string;
}

export interface MilestonePatch {
  status?: string;
  title?: string;
  description?: string;
  blockedBy?: string[];
  dependsOn?: string[];
}

/**
 * The operations the web UI needs from a ledger MCP server. Implemented by
 * {@link McpLedgerClient} (real, over HTTP) and by the in-memory fake the UI
 * tests drive.
 */
export interface LedgerClient {
  enumerateLedgers(): Promise<string[]>;
  fetchLedger(ledgerId: string): Promise<FetchedLedger>;
  fetchItem(ledgerId: string, itemId: string): Promise<Item>;
  createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item>;
  updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item>;
  ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]>;
  createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item>;
  updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item>;
  close(): Promise<void>;
}
