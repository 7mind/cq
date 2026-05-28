import { unlinkSync } from "node:fs";
import type { Database, Statement } from "bun:sqlite";
import type { SessionRow } from "@cq/shared";
import type { SessionFilter, SortSpec, PageSpec, PagedResult } from "./Persistence.js";

/** Named-parameter binding record accepted by bun:sqlite. */
type NamedParams = Record<string, string | bigint | number | boolean | null | Uint8Array>;

// ---------------------------------------------------------------------------
// Column mapping helpers (camelCase ↔ snake_case)
// ---------------------------------------------------------------------------

interface SessionSqlRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  cwd: string;
  model: string;
  permission_mode: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_create: number;
  total_cost_usd: number;
  ended_reason: string | null;
  title: string;
  last_server_seq: number;
  sdk_session_id: string | null;
  platform: string;
  effort: string;
  approval_policy: string | null;
}

function toRow(r: SessionSqlRow): SessionRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    cwd: r.cwd,
    model: r.model,
    permissionMode: r.permission_mode,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCacheRead: r.total_cache_read,
    totalCacheCreate: r.total_cache_create,
    totalCostUsd: r.total_cost_usd,
    endedReason: r.ended_reason,
    title: r.title,
    lastServerSeq: r.last_server_seq,
    sdkSessionId: r.sdk_session_id,
    // Narrow the persisted string to the SessionRow union; rows stored before
    // migration #6 will read as the default literal "claude" so the cast is
    // sound by construction.
    platform: (r.platform === "codex" ? "codex" : "claude") as "claude" | "codex",
    effort: r.effort,
    approvalPolicy: r.approval_policy,
  };
}

const SORT_MAP: Record<string, string> = {
  startedAt: "started_at",
  endedAt: "ended_at",
  totalCostUsd: "total_cost_usd",
};

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly stmtInsert: Statement;
  private readonly stmtGet: Statement<SessionSqlRow, [string]>;

  constructor(private readonly db: Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO session
        (id, started_at, ended_at, cwd, model, permission_mode,
         total_input_tokens, total_output_tokens, total_cache_read,
         total_cache_create, total_cost_usd, ended_reason, title,
         last_server_seq, sdk_session_id, platform, effort, approval_policy)
      VALUES
        ($id, $started_at, $ended_at, $cwd, $model, $permission_mode,
         $total_input_tokens, $total_output_tokens, $total_cache_read,
         $total_cache_create, $total_cost_usd, $ended_reason, $title,
         $last_server_seq, $sdk_session_id, $platform, $effort, $approval_policy)
    `);

    this.stmtGet = db.prepare<SessionSqlRow, [string]>(
      "SELECT * FROM session WHERE id = ?"
    );
  }

  insert(row: SessionRow): void {
    this.stmtInsert.run({
      $id: row.id,
      $started_at: row.startedAt,
      $ended_at: row.endedAt,
      $cwd: row.cwd,
      $model: row.model,
      $permission_mode: row.permissionMode,
      $total_input_tokens: row.totalInputTokens,
      $total_output_tokens: row.totalOutputTokens,
      $total_cache_read: row.totalCacheRead,
      $total_cache_create: row.totalCacheCreate,
      $total_cost_usd: row.totalCostUsd,
      $ended_reason: row.endedReason,
      $title: row.title,
      $last_server_seq: row.lastServerSeq,
      $sdk_session_id: row.sdkSessionId,
      $platform: row.platform,
      $effort: row.effort,
      $approval_policy: row.approvalPolicy ?? null,
    });
  }

  update(id: string, patch: Partial<SessionRow>): void {
    const sets: string[] = [];
    const params: NamedParams = { $id: id };

    if (patch.startedAt !== undefined) { sets.push("started_at = $started_at"); params.$started_at = patch.startedAt; }
    if (patch.endedAt !== undefined) { sets.push("ended_at = $ended_at"); params.$ended_at = patch.endedAt; }
    if (patch.cwd !== undefined) { sets.push("cwd = $cwd"); params.$cwd = patch.cwd; }
    if (patch.model !== undefined) { sets.push("model = $model"); params.$model = patch.model; }
    if (patch.permissionMode !== undefined) { sets.push("permission_mode = $permission_mode"); params.$permission_mode = patch.permissionMode; }
    if (patch.totalInputTokens !== undefined) { sets.push("total_input_tokens = $total_input_tokens"); params.$total_input_tokens = patch.totalInputTokens; }
    if (patch.totalOutputTokens !== undefined) { sets.push("total_output_tokens = $total_output_tokens"); params.$total_output_tokens = patch.totalOutputTokens; }
    if (patch.totalCacheRead !== undefined) { sets.push("total_cache_read = $total_cache_read"); params.$total_cache_read = patch.totalCacheRead; }
    if (patch.totalCacheCreate !== undefined) { sets.push("total_cache_create = $total_cache_create"); params.$total_cache_create = patch.totalCacheCreate; }
    if (patch.totalCostUsd !== undefined) { sets.push("total_cost_usd = $total_cost_usd"); params.$total_cost_usd = patch.totalCostUsd; }
    if (patch.endedReason !== undefined) { sets.push("ended_reason = $ended_reason"); params.$ended_reason = patch.endedReason; }
    if (patch.title !== undefined) { sets.push("title = $title"); params.$title = patch.title; }
    if (patch.lastServerSeq !== undefined) { sets.push("last_server_seq = $last_server_seq"); params.$last_server_seq = patch.lastServerSeq; }
    if (patch.sdkSessionId !== undefined) { sets.push("sdk_session_id = $sdk_session_id"); params.$sdk_session_id = patch.sdkSessionId; }
    if (patch.platform !== undefined) { sets.push("platform = $platform"); params.$platform = patch.platform; }
    if (patch.effort !== undefined) { sets.push("effort = $effort"); params.$effort = patch.effort; }
    if (patch.approvalPolicy !== undefined) { sets.push("approval_policy = $approval_policy"); params.$approval_policy = patch.approvalPolicy; }

    if (sets.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.run(`UPDATE session SET ${sets.join(", ")} WHERE id = $id`, params as any);
  }

  get(id: string): SessionRow | undefined {
    const r = this.stmtGet.get(id);
    return r ? toRow(r) : undefined;
  }

  list(filter: SessionFilter, sort: SortSpec, page: PageSpec): PagedResult<SessionRow> {
    const conditions: string[] = [];
    const params: NamedParams = {};

    if (filter.endedReason !== undefined) {
      conditions.push("ended_reason = $ended_reason");
      params.$ended_reason = filter.endedReason;
    }
    if (filter.search) {
      conditions.push("(title LIKE $search OR cwd LIKE $search)");
      params.$search = `%${filter.search}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const col = SORT_MAP[sort.field] ?? "started_at";
    const dir = sort.dir === "desc" ? "DESC" : "ASC";

    const total = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.db.query<{ n: number }, any>(
        `SELECT COUNT(*) AS n FROM session ${where}`
      ).get(params) ?? { n: 0 }
    ).n;

    const rows = this.db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .query<SessionSqlRow, any>(
        `SELECT * FROM session ${where} ORDER BY ${col} ${dir} LIMIT $limit OFFSET $offset`
      )
      .all({ ...params, $limit: page.limit, $offset: page.offset })
      .map(toRow);

    return { rows, total };
  }

  delete(id: string): void {
    // Collect all invocation event_log_paths for this session BEFORE the
    // CASCADE delete removes the invocation rows.
    const rows = this.db
      .query<{ event_log_path: string }, [string]>(
        "SELECT event_log_path FROM invocation WHERE session_id = ?",
      )
      .all(id);
    this.db.run("DELETE FROM session WHERE id = ?", [id]);
    for (const r of rows) {
      try { unlinkSync(r.event_log_path); } catch { /* best-effort */ }
    }
  }
}
