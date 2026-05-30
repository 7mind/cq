import type { SessionRow, InvocationRow, HistoryRow, HistoryRowFull, Effort, WorkflowSessionLink } from "@cq/shared";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Persistence,
  SessionFilter,
  SortSpec,
  PageSpec,
  PagedResult,
  InvocationFilter,
  InvocationSortSpec,
} from "./Persistence.js";
import type { UiSettings } from "./settings.js";
import { InMemoryEventLog } from "./events.js";

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

const SESSION_SORT_KEYS: Record<string, keyof SessionRow> = {
  startedAt: "startedAt",
  endedAt: "endedAt",
  totalCostUsd: "totalCostUsd",
};

function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// ---------------------------------------------------------------------------
// InMemoryPersistence
// ---------------------------------------------------------------------------

/**
 * Hand-written in-memory dummy `Persistence` adapter.
 *
 * - Sessions and invocations are stored in plain `Map`s.
 * - FTS is implemented as a linear substring scan on `promptExcerpt` and
 *   `agentName` (shape-parity with SQLite FTS5).
 * - Events are stored in an `InMemoryEventLog` (in-process `Map`).
 */
export class InMemoryPersistence implements Persistence {
  private readonly sessionMap = new Map<string, SessionRow>();
  private readonly invocationMap = new Map<string, InvocationRow>();
  private readonly workflowSessionMap = new Map<string, WorkflowSessionLink>();
  private readonly eventLog = new InMemoryEventLog();
  private _uiSettings: UiSettings = { model: null, permissionMode: null, hideSdkEvents: false };

  readonly sessions = {
    insert: (row: SessionRow): void => {
      // Mirror SQLite's `kind` column DEFAULT 'chat': a row inserted without an
      // explicit kind reads back as "chat" (the SQLite adapter applies the
      // column default; the in-memory adapter must match that semantics).
      this.sessionMap.set(row.id, { kind: "chat", ...row });
    },

    update: (id: string, patch: Partial<SessionRow>): void => {
      const existing = this.sessionMap.get(id);
      if (!existing) return;
      this.sessionMap.set(id, { ...existing, ...patch });
    },

    get: (id: string): SessionRow | undefined => {
      const r = this.sessionMap.get(id);
      return r ? { ...r } : undefined;
    },

    list: (filter: SessionFilter, sort: SortSpec, page: PageSpec): PagedResult<SessionRow> => {
      let rows = [...this.sessionMap.values()];

      if (filter.endedReason !== undefined) {
        rows = rows.filter((r) => r.endedReason === filter.endedReason);
      }
      if (filter.search) {
        const q = filter.search.toLowerCase();
        rows = rows.filter(
          (r) => r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q)
        );
      }

      const key = SESSION_SORT_KEYS[sort.field] ?? "startedAt";
      rows.sort((a, b) => {
        const c = cmp(a[key], b[key]);
        return sort.dir === "desc" ? -c : c;
      });

      const total = rows.length;
      return {
        rows: rows.slice(page.offset, page.offset + page.limit).map((r) => ({ ...r })),
        total,
      };
    },

    delete: (id: string): void => {
      this.sessionMap.delete(id);
      // Cascade: delete all invocations for this session
      for (const [invId, inv] of this.invocationMap) {
        if (inv.sessionId === id) {
          this.invocationMap.delete(invId);
        }
      }
    },
  };

  readonly invocations = {
    insert: (row: InvocationRow): void => {
      this.invocationMap.set(row.id, { ...row });
    },

    update: (id: string, patch: Partial<InvocationRow>): void => {
      const existing = this.invocationMap.get(id);
      if (!existing) return;
      this.invocationMap.set(id, { ...existing, ...patch });
    },

    get: (id: string): InvocationRow | undefined => {
      const r = this.invocationMap.get(id);
      return r ? { ...r } : undefined;
    },

    listForSession: (sessionId: string): InvocationRow[] => {
      return [...this.invocationMap.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((r) => ({ ...r }));
    },

    delete: (id: string): void => {
      // Mirror SQLite's ON DELETE CASCADE: recursively delete all descendants
      // before removing the row itself, so in-memory and SQLite behaviour align.
      for (const [childId, child] of this.invocationMap) {
        if (child.parentInvocationId === id) {
          this.invocations.delete(childId);
        }
      }
      this.invocationMap.delete(id);
    },

    /**
     * Linear substring scan over `promptExcerpt` and `agentName`.
     * Treats the query as a single search term (no FTS5 syntax).
     */
    searchFts: (query: string, limit: number): InvocationRow[] => {
      const q = query.toLowerCase();
      return [...this.invocationMap.values()]
        .filter(
          (r) =>
            r.promptExcerpt.toLowerCase().includes(q) ||
            r.agentName.toLowerCase().includes(q)
        )
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },

    list: (
      filter: InvocationFilter,
      sort: InvocationSortSpec,
      page: PageSpec,
    ): PagedResult<HistoryRow> => {
      const applyUserFilters = (rows: InvocationRow[]): InvocationRow[] => {
        if (filter.agentName !== undefined) {
          rows = rows.filter((r) => r.agentName === filter.agentName);
        }
        if (filter.model !== undefined) {
          rows = rows.filter((r) => r.model === filter.model);
        }
        if (filter.status !== undefined) {
          rows = rows.filter((r) => r.status === filter.status);
        }
        if (filter.dateFrom !== undefined) {
          rows = rows.filter((r) => r.startedAt >= filter.dateFrom!);
        }
        if (filter.dateTo !== undefined) {
          rows = rows.filter((r) => r.startedAt <= filter.dateTo!);
        }
        if (filter.search) {
          const q = filter.search.toLowerCase();
          // For FTS, keep sessions that have at least one matching invocation.
          const matchingSessionIds = new Set(
            [...this.invocationMap.values()]
              .filter(
                (r) =>
                  r.promptExcerpt.toLowerCase().includes(q) ||
                  r.agentName.toLowerCase().includes(q),
              )
              .map((r) => r.sessionId),
          );
          rows = rows.filter((r) => matchingSessionIds.has(r.sessionId));
        }
        return rows;
      };

      // Half 1: top-level main invocations, deduped to latest per session.
      const mainRows = applyUserFilters(
        [...this.invocationMap.values()].filter(
          (r) => r.agentName === "main" && r.parentInvocationId === null,
        ),
      );
      const latestBySession = new Map<string, InvocationRow>();
      for (const r of mainRows) {
        const existing = latestBySession.get(r.sessionId);
        if (existing === undefined || r.startedAt > existing.startedAt) {
          latestBySession.set(r.sessionId, r);
        }
      }

      // Half 2: subagent invocations (pass through unfiltered by session dedup).
      const subRows = applyUserFilters(
        [...this.invocationMap.values()].filter(
          (r) => r.agentName !== "main" || r.parentInvocationId !== null,
        ),
      );

      const deduped = [...latestBySession.values(), ...subRows];

      const key = sort.field as keyof InvocationRow;
      deduped.sort((a, b) => {
        const av = a[key] ?? null;
        const bv = b[key] ?? null;
        if (av === null) return 1;
        if (bv === null) return -1;
        const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sort.dir === "desc" ? -c : c;
      });

      const total = deduped.length;
      const sliced = deduped.slice(page.offset, page.offset + page.limit);

      const historyRows: HistoryRow[] = sliced.map((r) => {
        const session = this.sessionMap.get(r.sessionId);
        return {
          invocationId: r.id,
          sessionId: r.sessionId,
          agentName: r.agentName,
          model: r.model,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          durationMs: r.durationMs,
          status: r.status,
          toolCallCount: r.toolCallCount,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
          promptExcerpt: r.promptExcerpt,
          title: session?.title ?? "",
          resumedFromInvocationId: r.resumedFromInvocationId,
          platform: session?.platform ?? "claude",
          effort: (session?.effort ?? "none") as Effort,
          approvalPolicy: session?.approvalPolicy ?? null,
          kind: session?.kind ?? "chat",
        };
      });

      return { rows: historyRows, total };
    },

    getFull: (id: string): HistoryRowFull | undefined => {
      const r = this.invocationMap.get(id);
      if (!r) return undefined;
      const session = this.sessionMap.get(r.sessionId);
      return {
        invocationId: r.id,
        sessionId: r.sessionId,
        agentName: r.agentName,
        model: r.model,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMs: r.durationMs,
        status: r.status,
        toolCallCount: r.toolCallCount,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        promptExcerpt: r.promptExcerpt,
        title: session?.title ?? "",
        cwd: session?.cwd ?? "",
        permissionMode: session?.permissionMode ?? "",
        endedReason: session?.endedReason ?? null,
        sdkSessionId: session?.sdkSessionId ?? null,
        eventLogPath: r.eventLogPath,
        parentInvocationId: r.parentInvocationId,
        resumedFromInvocationId: r.resumedFromInvocationId,
        totalInputTokens: session?.totalInputTokens ?? 0,
        totalOutputTokens: session?.totalOutputTokens ?? 0,
        totalCostUsd: session?.totalCostUsd ?? 0,
        platform: session?.platform ?? "claude",
        effort: (session?.effort ?? "none") as Effort,
        approvalPolicy: session?.approvalPolicy ?? null,
        kind: session?.kind ?? "chat",
      };
    },
  };

  readonly workflowSessions = {
    link: (link: WorkflowSessionLink): void => {
      this.workflowSessionMap.set(link.goalId, { ...link });
    },
    getByGoal: (goalId: string): WorkflowSessionLink | undefined => {
      const r = this.workflowSessionMap.get(goalId);
      return r ? { ...r } : undefined;
    },
  };

  readonly events = {
    append: (invocationId: string, event: SDKMessage): void =>
      this.eventLog.append(invocationId, event),
    readAll: (invocationId: string): AsyncIterable<SDKMessage> =>
      this.eventLog.readAll(invocationId),
    close: (invocationId: string): void => this.eventLog.close(invocationId),
  };

  readonly settings = {
    get: (): UiSettings => ({ ...this._uiSettings }),
    set: (patch: Partial<UiSettings>): void => {
      this._uiSettings = { ...this._uiSettings, ...patch };
    },
  };

  withTx<T>(fn: () => T): T {
    // Snapshot both maps before the transaction; restore on error.
    const sessionSnapshot = new Map(
      [...this.sessionMap.entries()].map(([k, v]) => [k, { ...v }])
    );
    const invocationSnapshot = new Map(
      [...this.invocationMap.entries()].map(([k, v]) => [k, { ...v }])
    );

    try {
      const result = fn();
      return result;
    } catch (err) {
      // Restore pre-transaction state
      this.sessionMap.clear();
      for (const [k, v] of sessionSnapshot) this.sessionMap.set(k, v);
      this.invocationMap.clear();
      for (const [k, v] of invocationSnapshot) this.invocationMap.set(k, v);
      throw err;
    }
  }

  close(): void {
    // No-op for in-memory adapter.
  }

  reapOrphans(): number {
    return 0;
  }
}
