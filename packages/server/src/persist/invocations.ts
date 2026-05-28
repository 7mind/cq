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
  resumed_from_invocation_id: string | null;
  agent_name: string;
  agent_id: string | null;
  task_id: string | null;
  tool_use_id: string | null;
  model: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "wiped";
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  prompt_excerpt: string;
  event_log_path: string;
  owner_pid: number | null;
}

function toRow(r: InvocationSqlRow): InvocationRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    parentInvocationId: r.parent_invocation_id,
    resumedFromInvocationId: r.resumed_from_invocation_id,
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
    ownerPid: r.owner_pid,
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
  // gear-2/codex-2: session-level platform + effort joined into history rows.
  platform: string;
  effort: string;
  // gcn1-1 (outer-9): session-level Codex approvalPolicy joined into
  // history rows. NULL for Claude sessions and pre-migration Codex sessions.
  approval_policy: string | null;
}

const INVOCATION_SORT_MAP: Record<string, string> = {
  startedAt: "i.started_at",
  endedAt: "i.ended_at",
  durationMs: "i.duration_ms",
  costUsd: "i.cost_usd",
  toolCallCount: "i.tool_call_count",
};

function toHistoryRow(r: HistorySqlRow): HistoryRow {
  // Narrow platform string read from DB to the union; treat anything other
  // than "codex" as "claude" so legacy rows (NULL or missing) stay routable.
  const platform: "claude" | "codex" = r.platform === "codex" ? "codex" : "claude";
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
    resumedFromInvocationId: r.resumed_from_invocation_id,
    platform,
    // The DB column has DEFAULT 'none' so this is non-null for any rows
    // committed under migration #6+. Defensive fallback for tests using
    // hand-rolled SQL.
    effort: (r.effort ?? "none") as HistoryRow["effort"],
    approvalPolicy: r.approval_policy,
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
        (id, session_id, parent_invocation_id, resumed_from_invocation_id,
         agent_name, agent_id, task_id, tool_use_id, model, started_at,
         ended_at, duration_ms, status, tool_call_count, input_tokens,
         output_tokens, cost_usd, prompt_excerpt, event_log_path, owner_pid)
      VALUES
        ($id, $session_id, $parent_invocation_id, $resumed_from_invocation_id,
         $agent_name, $agent_id, $task_id, $tool_use_id, $model, $started_at,
         $ended_at, $duration_ms, $status, $tool_call_count, $input_tokens,
         $output_tokens, $cost_usd, $prompt_excerpt, $event_log_path, $owner_pid)
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
      $resumed_from_invocation_id: row.resumedFromInvocationId,
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
      $owner_pid: row.ownerPid,
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

    // Build the two halves of the union:
    //  1. main_latest: deduplicated top-level main invocations (one per session, the latest).
    //  2. subs: all subagent invocations (parent_invocation_id IS NOT NULL or agent_name != 'main').
    // User filters apply to both halves.
    const userWhere = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
    const col = INVOCATION_SORT_MAP[sort.field] ?? "i.started_at";
    const dir = sort.dir === "desc" ? "DESC" : "ASC";
    const colDeduped = col.replace("i.", "u.");

    // FTS search: run as a separate query when search is provided, then intersect ids.
    if (filter.search) {
      const safeQuery = `"${filter.search.replace(/"/g, '""')}"`;
      const ftsSessionIds = new Set<string>(
        this.db
          .query<{ session_id: string }, [string]>(
            `SELECT i.session_id FROM invocation i JOIN invocation_fts fts ON fts.rowid = i.rowid WHERE invocation_fts MATCH ?`,
          )
          .all(safeQuery)
          .map((r) => r.session_id),
      );
      if (ftsSessionIds.size === 0) return { rows: [], total: 0 };
      const sessionIdList = [...ftsSessionIds].map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const ftsExtra = `AND i.session_id IN (${sessionIdList})`;
      const ftsCte = `
        WITH main_latest AS (
          SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.session_id ORDER BY i.started_at DESC) AS rn
          FROM invocation i
          WHERE i.agent_name = 'main' AND i.parent_invocation_id IS NULL
            ${userWhere} ${ftsExtra}
        ),
        subs AS (
          SELECT i.*, 0 AS rn
          FROM invocation i
          WHERE (i.agent_name != 'main' OR i.parent_invocation_id IS NOT NULL)
            ${userWhere} ${ftsExtra}
        ),
        combined AS (
          SELECT * FROM main_latest WHERE rn = 1
          UNION ALL
          SELECT * FROM subs
        )
      `;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = (this.db.query<{ n: number }, any>(
        `${ftsCte} SELECT COUNT(*) AS n FROM combined`,
      ).get(params) ?? { n: 0 }).n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = this.db.query<HistorySqlRow, any>(
        `${ftsCte}
         SELECT u.*, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd, s.platform, s.effort, s.approval_policy
         FROM combined u
         LEFT JOIN session s ON s.id = u.session_id
         ORDER BY ${colDeduped} ${dir} LIMIT $limit OFFSET $offset`,
      ).all({ ...params, $limit: page.limit, $offset: page.offset });
      return { rows: rows.map(toHistoryRow), total };
    }

    const unionCte = `
      WITH main_latest AS (
        SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.session_id ORDER BY i.started_at DESC) AS rn
        FROM invocation i
        WHERE i.agent_name = 'main' AND i.parent_invocation_id IS NULL
          ${userWhere}
      ),
      subs AS (
        SELECT i.*, 0 AS rn
        FROM invocation i
        WHERE (i.agent_name != 'main' OR i.parent_invocation_id IS NOT NULL)
          ${userWhere}
      ),
      combined AS (
        SELECT * FROM main_latest WHERE rn = 1
        UNION ALL
        SELECT * FROM subs
      )
    `;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = (this.db.query<{ n: number }, any>(
      `${unionCte} SELECT COUNT(*) AS n FROM combined`,
    ).get(params) ?? { n: 0 }).n;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = this.db.query<HistorySqlRow, any>(
      `${unionCte}
       SELECT u.*, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd, s.platform, s.effort, s.approval_policy
       FROM combined u
       LEFT JOIN session s ON s.id = u.session_id
       ORDER BY ${colDeduped} ${dir} LIMIT $limit OFFSET $offset`,
    ).all({ ...params, $limit: page.limit, $offset: page.offset });

    return { rows: rows.map(toHistoryRow), total };
  }

  getFull(id: string): HistoryRowFull | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = this.db.query<HistorySqlRow, any>(
      `SELECT i.*, i.resumed_from_invocation_id, s.title, s.cwd, s.permission_mode, s.ended_reason, s.sdk_session_id, s.total_input_tokens, s.total_output_tokens, s.total_cost_usd, s.platform, s.effort, s.approval_policy
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
   * One-shot startup reaper: marks 'running' invocation rows whose owner
   * process is no longer alive as 'wiped'. Status 'wiped' (not 'stopped', not
   * 'failed') because the cq process restarted while these rows were running —
   * the owner is now dead, which is distinct from both a user-interrupted row
   * ('stopped') and an SDK-error row ('failed').
   *
   * Per-row liveness check (D42):
   * - Rows with owner_pid IS NULL are NEVER reaped — unknown owner, safest
   *   to leave them in place.
   * - Rows owned by this process (owner_pid === process.pid) are never reaped
   *   (they are live by definition).
   * - Rows whose owner_pid refers to a dead process (ESRCH from kill(pid,0))
   *   are transitioned to 'wiped'.
   *
   * Idempotent — run once at SqlitePersistence construction (after migrations).
   */
  reapOrphans(now: number): number {
    const candidates = this.db
      .query<{ id: string; owner_pid: number | null; started_at: number }, []>(
        `SELECT id, owner_pid, started_at FROM invocation WHERE status='running'`,
      )
      .all();
    let reaped = 0;
    for (const c of candidates) {
      if (c.owner_pid === null) continue; // unknown owner — never reap
      if (c.owner_pid === process.pid) continue; // our own row — never reap
      // Probe liveness. ESRCH = truly dead; EPERM = alive but foreign-owned.
      let alive: boolean;
      try {
        process.kill(c.owner_pid, 0);
        alive = true;
      } catch (err: unknown) {
        // Only ESRCH means the process is gone. EPERM means it's alive — do NOT reap.
        alive = (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) continue;
      this.db.run(
        `UPDATE invocation
           SET status='wiped',
               ended_at=COALESCE(ended_at, ?),
               duration_ms=COALESCE(duration_ms, ? - started_at)
         WHERE id = ?`,
        [now, now, c.id],
      );
      reaped++;
    }
    return reaped;
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
