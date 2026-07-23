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
  DerivedPredicates,
  PredicateVerdict,
} from "@cq/ledger";
import type { ArchiveContent } from "@cq/ledger";

export type { Item, FieldValue, FetchedLedger, FetchedMilestoneGroup, LedgerSummary, ResolvedMilestone, LedgerSchema, ArchiveContent, AgentModelsResult, AgentModelEntry, AgentModelStatus, ListProjectsResult, ProjectEntry, ArchivePointer, DerivedPredicates, PredicateVerdict };

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
  fetchLedger(ledgerId: string): Promise<FetchedLedger>;
  fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent>;
  fetchItem(ledgerId: string, itemId: string): Promise<Item>;
  createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item>;
  updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item>;
  ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]>;
  createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item>;
  updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item>;
  /**
   * Archive a milestone globally (archive_milestone MCP tool): sweeps every
   * ledger's group with this id, then the milestone-item itself, into
   * ./archive/. Refused server-side if any item under the milestone is
   * non-terminal.
   */
  archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer>;
  /** Read a log file under docs/logs/ via the read_log MCP tool. */
  readLog(path: string): Promise<ReadLogResult>;
  /** Retrieve per-agent resolved model overlays via the get_agent_models MCP tool. */
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
   * `{ pInvestigate, pSeed, pPlan, pResearch, pImplement, openQuestionGate,
   * belowFloor, goalDrift }` verdicts @cq/cli reads. The web UI consumes only
   * `goalDrift` today (report-only phase-drift warning).
   */
  derivePredicates(): Promise<DerivedPredicates>;
  close(): Promise<void>;
}
