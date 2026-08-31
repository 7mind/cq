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
  ProjectEntry,
  FetchPromptResult,
  ItemMutationAckDto,
  ItemProjection,
  MilestoneMutationAckDto,
  UsageStatsSnapshot,
  WorksetOperationClient,
  WorksetRequest,
  WorksetResult,
  WorksetResultFor,
} from "@cq/ledger";
import type { ArchiveContent, ArchivePointer } from "@cq/ledger";
import type { FinalizeBatchOperation } from "@cq/ledger/finalize";

export type {
  Item,
  FieldValue,
  FetchedLedger,
  FetchedMilestoneGroup,
  LedgerSummary,
  ResolvedMilestone,
  LedgerSchema,
  ArchiveContent,
  ArchivePointer,
  FinalizeBatchOperation,
  ProjectEntry,
  FetchPromptResult,
  ItemMutationAckDto,
  ItemProjection,
  MilestoneMutationAckDto,
  UsageStatsSnapshot,
  WorksetRequest,
  WorksetResult,
  WorksetResultFor,
};

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
  fetchLedger(
    ledgerId: string,
    projection: ItemProjection,
  ): Promise<FetchedLedger>;
  fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;
  fetchItem(
    ledgerId: string,
    itemId: string,
    projection: ItemProjection,
  ): Promise<Item>;
  /** Additive typed prompt metadata; optional so pre-catalog UI test fakes remain valid. */
  fetchPromptResult?(roleId: string): Promise<FetchPromptResult>;
  createItem(
    ledgerId: string,
    milestoneId: string,
    init: ItemInit,
  ): Promise<ItemMutationAckDto>;
  updateItem(
    ledgerId: string,
    itemId: string,
    patch: ItemPatch,
  ): Promise<ItemMutationAckDto>;
  ftsSearch(
    query: string,
    projection: ItemProjection,
    opts?: { ledger?: string },
  ): Promise<FtsHit[]>;
  createMilestone(
    init: { title: string; description?: string; id?: string },
  ): Promise<MilestoneMutationAckDto>;
  updateMilestone(
    milestoneId: string,
    patch: MilestonePatch,
  ): Promise<MilestoneMutationAckDto>;
  /**
   * Archive a milestone globally (2-level): sweeps every ledger's group with
   * this id into `./archive/<ledger>/<id>.md`, then moves the milestone-item
   * itself to `./archive/milestones/<id>.md`. Refused if any item in any
   * ledger is non-terminal (`archive_milestone` MCP tool).
   */
  archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer>;
  /** Optional one-round-trip atomic finalization path for real MCP clients. */
  executeFinalize?(operations: readonly FinalizeBatchOperation[]): Promise<{ applied: number }>;
  /**
   * List every project the connected server's store knows about (the
   * `list_projects` tool, T585/Q284) — feeds the always-visible project
   * selector (T590). OPTIONAL: pre-T590 test fakes need no update. Absent
   * (or a rejected call) is treated by the UI as "exactly one, unnamed
   * project" — a single entry synthesized from {@link displayName}.
   */
  listProjects?(): Promise<ProjectEntry[]>;
  /**
   * Read the server's per-endpoint MCP usage counters (`get_usage_stats`
   * tool, I20/G155): `{ endpoints, totals }` with each endpoint carrying
   * `{ name, callCount, bytesIn, bytesOut }`.
   */
  getUsageStats(): Promise<UsageStatsSnapshot>;
  close(): Promise<void>;
}

/** Ledger UI client with the additive workset operation. */
export interface WorksetCapableLedgerClient extends LedgerClient, WorksetOperationClient {}
