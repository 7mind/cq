import { unlinkSync } from "node:fs";
import type { Database, Statement } from "bun:sqlite";
import type { InvocationRow, HistoryRow, HistoryRowFull } from "@cq/shared";
import type { InvocationFilter, InvocationSortSpec, PageSpec, PagedResult } from "./Persistence.js";

// ---------------------------------------------------------------------------
// Column mapping helpers (camelCase ↔ snake_case)
// ---------------------------------------------------------------------------

interface InvocationSqlRow {
  id: string;
  session_id: string;
  parent_invocation_id: string | null;
  agent_name: string;
  agent_id: string | null;
  task_id: string | null;
  tool_use_id: string | null;
  model: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "errored";
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  prompt_excerpt: string;
  event_log_path: string;
}

function toRow(r: InvocationSqlRow): InvocationRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    parentInvocationId: r.parent_invocation_id,
    agentName: r.agent_name,
    agentId: r.agent_id,
    taskId: r.task_id,
    toolUseId: r.tool_use_id,
    model: r.model,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    toolCallCount: r.tool_call_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    promptExcerpt: r.prompt_excerpt,
    eventLogPath: r.event_log_path,
  };
}

/** SQL row shape for the joined history query (invocation + session columns). */
interface HistorySqlRow extends InvocationSqlRow {
  title: string;
  // session fields for HistoryRowFull
  cwd: string;
  permission_mode: string;
  ended_reason: string | null;
  sdk_session_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

const INVOCATION_SORT_MAP: Record<string, string> = {
  startedAt: "i.started_at",
  endedAt: "i.ended_at",
  durationMs: "i.duration_ms",
  costUsd: "i.cost_usd",
  toolCallCount: "i.tool_call_count",
};

function toHistoryRow(r: HistorySqlRow): HistoryRow {
  return {
    invocationId: r.id,
    sessionId: r.session_id,
    agentName: r.agent_name,
    model: r.model,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    toolCallCount: r.tool_call_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    promptExcerpt: r.prompt_excerpt,
    title: r.title,
  };
}

function toHistoryRowFull(r: HistorySqlRow): HistoryRowFull {
  return {
    ...toHistoryRow(r),
    cwd: r.cwd,
    permissionMode: r.permission_mode,
    endedReason: r.ended_reason,
    sdkSessionId: r.sdk_session_id,
    eventLogPath: r.event_log_path,
    parentInvocationId: r.parent_invocation_id,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCostUsd: r.total_cost_usd,
  };
}

// ---------------------------------------------------------------------------
// InvocationStore
// ---------------------------------------------------------------------------

export class InvocationStore {
  private readonly stmtInsert: Statement;
  private readonly stmtGet: Statement<InvocationSqlRow, [string]>;
  private readonly stmtListForSession: Statement<InvocationSqlRow, [string]>;

  constructor(private readonly db: Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO invocation
        (id, session_id, parent_invocation_id, agent_name, agent_id,
         task_id, tool_use_id, model, started_at, ended_at, duration_ms,
         status, tool_call_count, input_tokens, output_tokens, cost_usd,
         prompt_excerpt, event_log_path)
      VALUES
        ($id, $session_id, $parent_invocation_id, $agent_name, $agent_id,
         $task_id, $tool_use_id, $model, $started_at, $ended_at, $duration_ms,
         $status, $tool_call_count, $input_tokens, $output_tokens, $cost_usd,
         $prompt_excerpt, $event_log_path)
    `);

    this.stmtGet = db.prepare<InvocationSqlRow, [string]>(
      "SELECT * FROM invocation WHERE id = ?"
    );

    this.stmtListForSession = db.prepare<InvocationSqlRow, [string]>(
      "SELECT * FROM invocation WHERE session_id = ? ORDER BY started_at ASC"
    );
  }

  insert(row: InvocationRow): void {
    this.stmtInsert.run({
      $id: row.id,
      $session_id: row.sessionId,
      $parent_invocation_id: row.parentInvocationId,
      $agent_name: row.agentName,
      $agent_id: row.agentId,
      $task_id: row.taskId,
      $tool_use_id: row.toolUseId,
      $model: row.model,
      $started_at: row.startedAt,
      $ended_at: row.endedAt,
      $duration_ms: row.durationMs,
      $status: row.status,
      $tool_call_count: row.toolCallCount,
      $input_tokens: row.inputTokens,
      $output_tokens: row.outputTokens,
      $cost_usd: row.costUsd,
      $prompt_excerpt: row.promptExcerpt,
      $event_log_path: row.eventLogPath,
    });
  }

  update(id: string, patch: Partial<InvocationRow>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: id };

    if (patch.sessionId !== undefined) { sets.push("session_id = $session_id"); params.$session_id = patch.sessionId; }
    if (patch.parentInvocationId !== undefined) { sets.push("parent_invocation_id = $parent_invocation_id"); params.$parent_invocation_id = patch.parentInvocationId; }
    if (patch.agentName !== undefined) { sets.push("agent_name = $agent_name"); params.$agent_name = patch.agentName; }
    if (patch.agentId !== undefined) { sets.push("agent_id = $agent_id"); params.$agent_id = patch.agentId; }
    if (patch.taskId !== undefined) { sets.push("task_id = $task_id"); params.$task_id = patch.taskId; }
    if (patch.toolUseId !== undefined) { sets.push("tool_use_id = $tool_use_id"); params.$tool_use_id = patch.toolUseId; }
    if (patch.model !== undefined) { sets.push("model = $model"); params.$model = patch.model; }
    if (patch.startedAt !== undefined) { sets.push("started_at = $started_at"); params.$started_at = patch.startedAt; }
    if (patch.endedAt !== undefined) { sets.push("ended_at = $ended_at"); params.$ended_at = patch.endedAt; }
    if (patch.durationMs !== undefined) { sets.push("duration_ms = $duration_ms"); params.$duration_ms = patch.durationMs; }
    if (patch.status !== undefined) { sets.push("status = $status"); params.$status = patch.status; }
    if (patch.toolCallCount !== undefined) { sets.push("tool_call_count = $tool_call_count"); params.$tool_call_count = patch.toolCallCount; }
    if (patch.inputTokens !== undefined) { sets.push("input_tokens = $input_tokens"); params.$input_tokens = patch.inputTokens; }
    if (patch.outputTokens !== undefined) { sets.push("output_tokens = $output_tokens"); params.$output_tokens = patch.outputTokens; }
    if (patch.costUsd !== undefined) { sets.push("cost_usd = $cost_usd"); params.$cost_usd = patch.costUsd; }
    if (patch.promptExcerpt !== undefined) { sets.push("prompt_excerpt = $prompt_excerpt"); params.$prompt_excerpt = patch.promptExcerpt; }
    if (patch.eventLogPath !== undefined) { sets.push("event_log_path = $event_log_path"); params.$event_log_path = patch.eventLogPath; }

    if (sets.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.run(`UPDATE invocation SET ${sets.join(", ")} WHERE id = $id`, params as any);
  }

  get(id: string): InvocationRow | undefined {
    const r = this.stmtGet.get(id);
    return r ? toRow(r) : undefined;
  }

  list(
    filter: InvocationFilter,
    sort: InvocationSortSpec,
    page: PageSpec,
  ): PagedResult<HistoryRow> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.agentName !== undefined) {
      conditions.push("i.agent_name = $agent_name");
      params.$agent_name = filter.agentName;
    }
    if (filter.model !== undefined) {
      conditions.push("i.model = $model");
      params.$model = filter.model;
    }
    if (filter.status !== undefined) {
      conditions.push("i.status = $status");
      params.$status = filter.status;
    }
    if (filter.dateFrom !== undefined) {
      conditions.push("i.started_at >= $date_from");
      params.$date_from = filter.dateFrom;
    }
    if (filter.dateTo !== undefined) {
      conditions.push("i.started_at <= $date_to");
      params.$date_to = filter.dateTo;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const col = INVOCATION_SORT_MAP[sort.field] ?? "i.started_at";
    const dir = sort.dir === "desc" ? "DESC" : "ASC";

    const baseQuery = `
      FROM invocation i
      LEFT JOIN session s ON s.id = i.session_id
      ${where}
    `;

    // FTS search: run as a separate query when search is provided, then intersect ids.
    if (filter.search) {
      const safeQuery = `"${filter.search.replace(/"/g, '""')}"`;
      const ftsIds = new Set<string>(
        this.db
          .query<{ id: string }, [string]>(
            `SELECT i.id FROM invocation i JOIN invocation_fts fts ON fts.rowid = i.rowid WHERE invocation_fts MATCH ?`,
          )
          .all(safeQuery)
          .map((r) => r.id),
      );
      if (ftsIds.size === 0) return { rows: [], total: 0 };
      const idList = [...ftsIds].map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const ftsWhere = where
        ? `${where} AND i.id IN (${idList})`
        : `WHERE i.id IN (${idList})`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = (this.db.query<{ n: number }, any>(
        `SELECT COUNT(*) AS n FROM invocation i LEFT JOIN session s ON s.id = i.session_id ${ftsWhere}`,
      ).get(params) ?? { n: 0 }).n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = this.db.query<HistorySqlRow, any>(
        `SELECT i.*, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd
         FROM invocation i LEFT JOIN session s ON s.id = i.session_id
         ${ftsWhere}
         ORDER BY ${col} ${dir} LIMIT $limit OFFSET $offset`,
      ).all({ ...params, $limit: page.limit, $offset: page.offset });
      return { rows: rows.map(toHistoryRow), total };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = (this.db.query<{ n: number }, any>(
      `SELECT COUNT(*) AS n ${baseQuery}`,
    ).get(params) ?? { n: 0 }).n;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = this.db.query<HistorySqlRow, any>(
      `SELECT i.*, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd
       ${baseQuery}
       ORDER BY ${col} ${dir} LIMIT $limit OFFSET $offset`,
    ).all({ ...params, $limit: page.limit, $offset: page.offset });

    return { rows: rows.map(toHistoryRow), total };
  }

  getFull(id: string): HistoryRowFull | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = this.db.query<HistorySqlRow, any>(
      `SELECT i.*, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd
       FROM invocation i LEFT JOIN session s ON s.id = i.session_id
       WHERE i.id = ?`,
    ).get(id);
    return r ? toHistoryRowFull(r) : undefined;
  }

  listForSession(sessionId: string): InvocationRow[] {
    return this.stmtListForSession.all(sessionId).map(toRow);
  }

  delete(id: string): void {
    // Collect event_log_paths for this invocation and all its descendants
    // (via ON DELETE CASCADE in SQLite) BEFORE the DELETE removes the rows.
    const paths = this._collectDescendantPaths(id);
    this.db.run("DELETE FROM invocation WHERE id = ?", [id]);
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* best-effort */ }
    }
  }

  /**
   * Collects event_log_path for the given invocation and all its transitive
   * children (parent_invocation_id chain) using a recursive CTE.
   */
  private _collectDescendantPaths(rootId: string): string[] {
    const rows = this.db
      .query<{ event_log_path: string }, [string]>(`
        WITH RECURSIVE desc(id) AS (
          SELECT id FROM invocation WHERE id = ?
          UNION ALL
          SELECT i.id FROM invocation i JOIN desc d ON i.parent_invocation_id = d.id
        )
        SELECT event_log_path FROM invocation WHERE id IN (SELECT id FROM desc)
      `)
      .all(rootId);
    return rows.map((r) => r.event_log_path);
  }

  /**
   * One-shot startup reaper: marks any invocation rows stuck at status='running'
   * as 'errored', setting ended_at + duration_ms. Idempotent.
   * Returns the number of rows updated.
   *
   * Run once at SqlitePersistence construction (after migrations) so unclean
   * shutdowns don't leave permanent "running" rows in the History tab.
   */
  reapOrphans(now: number): number {
    const result = this.db.run(
      `UPDATE invocation
         SET status='errored',
             ended_at=COALESCE(ended_at, ?),
             duration_ms=COALESCE(duration_ms, ? - started_at)
       WHERE status='running'`,
      [now, now],
    );
    return result.changes;
  }

  searchFts(query: string, limit: number): InvocationRow[] {
    // Wrap the user query in double-quotes so FTS5 treats it as a phrase,
    // avoiding tokenisation of special characters (hyphens, etc.).
    const safeQuery = `"${query.replace(/"/g, '""')}"`;
    const rows = this.db
      .query<InvocationSqlRow, [string, number]>(`
        SELECT i.*
        FROM invocation i
        JOIN invocation_fts fts ON fts.rowid = i.rowid
        WHERE invocation_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(safeQuery, limit);
    return rows.map(toRow);
  }
}
