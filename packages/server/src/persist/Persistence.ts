import type { SessionRow, InvocationRow, HistoryRow, HistoryRowFull, WorkflowSessionLink } from "@cq/shared";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UiSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// Filter / sort / page helpers
// ---------------------------------------------------------------------------

export interface SessionFilter {
  search?: string;
  endedReason?: string;
}

export type SessionSortField = "startedAt" | "endedAt" | "totalCostUsd";
export type SortDir = "asc" | "desc";

export interface SortSpec {
  field: SessionSortField;
  dir: SortDir;
}

export interface PageSpec {
  limit: number;
  offset: number;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
}

/** Filter for cross-session invocation listing (history.list). */
export interface InvocationFilter {
  agentName?: string;
  model?: string;
  status?: string;
  dateFrom?: number;
  dateTo?: number;
  search?: string;
}

export type InvocationSortField =
  | "startedAt"
  | "endedAt"
  | "durationMs"
  | "costUsd"
  | "toolCallCount";

export interface InvocationSortSpec {
  field: InvocationSortField;
  dir: SortDir;
}

// ---------------------------------------------------------------------------
// Persistence interface
// ---------------------------------------------------------------------------

/**
 * Type-only persistence interface. Implementations are provided by
 * `SqlitePersistence` (PR-40) and `InMemoryPersistence` (PR-40).
 */
export interface Persistence {
  sessions: {
    insert(row: SessionRow): void;
    update(id: string, patch: Partial<SessionRow>): void;
    get(id: string): SessionRow | undefined;
    list(filter: SessionFilter, sort: SortSpec, page: PageSpec): PagedResult<SessionRow>;
    delete(id: string): void;
  };

  invocations: {
    insert(row: InvocationRow): void;
    update(id: string, patch: Partial<InvocationRow>): void;
    get(id: string): InvocationRow | undefined;
    /** List all invocations across sessions, joined with session.title. */
    list(
      filter: InvocationFilter,
      sort: InvocationSortSpec,
      page: PageSpec,
    ): PagedResult<HistoryRow>;
    /** Get a single invocation joined with session fields as HistoryRowFull. */
    getFull(id: string): HistoryRowFull | undefined;
    listForSession(sessionId: string): InvocationRow[];
    delete(id: string): void;
    searchFts(query: string, limit: number): InvocationRow[];
  };

  events: {
    append(invocationId: string, event: SDKMessage): void;
    readAll(invocationId: string): AsyncIterable<SDKMessage>;
    close(invocationId: string): void;
  };

  settings: {
    get(): UiSettings;
    set(patch: Partial<UiSettings>): void;
  };

  /**
   * Links a `/plan` workflow run's durable goal id to the session + root
   * invocation created for it. Lets a resumed phase dispatch re-attach to the
   * SAME session (no orphan / duplicate) after a server restart.
   */
  workflowSessions: {
    /** Insert or replace the goalId → (sessionId, rootInvocationId) link. */
    link(link: WorkflowSessionLink): void;
    /** Look up the workflow session link for a goal, or undefined if none. */
    getByGoal(goalId: string): WorkflowSessionLink | undefined;
  };

  withTx<T>(fn: () => T): T;
  close(): void;
  /** Reap orphaned 'running' invocations left by an unclean shutdown. No-op on in-memory adapters. */
  reapOrphans?(): number;
}
