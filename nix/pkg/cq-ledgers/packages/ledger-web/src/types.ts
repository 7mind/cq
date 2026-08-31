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
  LedgerSummary,
  ResolvedMilestone,
  LedgerSchema,
  AgentModelsResult,
  AgentModelEntry,
  AgentModelStatus,
  ListProjectsResult,
  ProjectEntry,
  ArchivePointer,
  ItemMutationAckDto,
  ItemProjection,
  MilestoneMutationAckDto,
  DerivedPredicates,
  PredicateVerdict,
  FetchPromptResult,
  UsageStatsSnapshot,
  WorksetOperationClient,
  WorksetRequest,
  WorksetResult,
  WorksetResultFor,
} from "@cq/ledger";
import type { ArchiveContent } from "@cq/ledger";
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
  AgentModelsResult,
  AgentModelEntry,
  AgentModelStatus,
  ListProjectsResult,
  ProjectEntry,
  ArchivePointer,
  FinalizeBatchOperation,
  ItemMutationAckDto,
  ItemProjection,
  MilestoneMutationAckDto,
  DerivedPredicates,
  PredicateVerdict,
  FetchPromptResult,
  UsageStatsSnapshot,
  WorksetRequest,
  WorksetResult,
  WorksetResultFor,
};

export interface FtsHit {
  ledgerId: string;
  item: Item;
  score: number;
  matchedFields: string[];
}

/** Result of a bounded read of a docs/logs file (mirrors the server-side ReadLogResult). */
export interface ReadLogResult {
  /** The repo-relative path requested (echoed back, normalised). */
  path: string;
  /** The file content (possibly truncated). */
  content: string;
  /** Present and `true` only when the file exceeded the byte cap. */
  truncated?: boolean;
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
  /**
   * The project display name surfaced by the server on connect (serverInfo.title
   * or the 'Project: <name>' instructions fallback). Captured at connect time so
   * this accessor is synchronous.
   */
  displayName(): string;
  enumerateLedgers(): Promise<LedgerSummary[]>;
  fetchLedger(ledgerId: string, projection: ItemProjection): Promise<FetchedLedger>;
  fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;
  fetchItem(ledgerId: string, itemId: string, projection: ItemProjection): Promise<Item>;
  /** Additive typed prompt metadata; optional so pre-catalog UI test fakes remain valid. */
  fetchPromptResult?(roleId: string): Promise<FetchPromptResult>;
  createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<ItemMutationAckDto>;
  updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<ItemMutationAckDto>;
  ftsSearch(
    query: string,
    projection: ItemProjection,
    opts?: { ledger?: string },
  ): Promise<FtsHit[]>;
  createMilestone(init: {
    title: string;
    description?: string;
    id?: string;
  }): Promise<MilestoneMutationAckDto>;
  updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<MilestoneMutationAckDto>;
  /**
   * Archive a milestone globally (archive_milestone MCP tool): sweeps every
   * ledger's group with this id, then the milestone-item itself, into
   * ./archive/. Refused server-side if any item under the milestone is
   * non-terminal.
   */
  archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer>;
  /** Optional one-round-trip atomic finalization path for real MCP clients. */
  executeFinalize?(operations: readonly FinalizeBatchOperation[]): Promise<{ applied: number }>;
  /** Read a log file under docs/logs/ via the read_log MCP tool. */
  readLog(path: string): Promise<ReadLogResult>;
  /** Retrieve per-agent resolved model overlays via get_config(agent_models). */
  getAgentModels(): Promise<AgentModelsResult>;
  /**
   * Enumerate every project this server knows about (list_projects MCP tool,
   * T585/T589/Q276/Q284): the genuine multi-tenant registry for a `cq serve`
   * hub, or a synthesized single entry for every other backend. ALWAYS
   * answered — every real server wires this capability (see
   * `ListProjectsNotImplementedError`'s doc), so the web client never needs to
   * sniff the backend.
   */
  listProjects(): Promise<ListProjectsResult>;
  /**
   * Derive the /cq:advance flow-detection predicates from the current ledger
   * state (derive_predicates MCP tool, G84/D113): the same
   * `{ pInvestigate, pSeed, pPlan, pResearch, pImplement, pOperatorAction, openQuestionGate,
   * belowFloor, goalDrift }` verdicts @cq/cli reads. The web UI consumes only
   * `goalDrift` today (report-only phase-drift warning).
   */
  derivePredicates(): Promise<DerivedPredicates>;
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
