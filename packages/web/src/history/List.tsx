/**
 * List.tsx — History table with sortable columns and filter inputs (PR-42).
 *
 * Props:
 *   rows        — array of HistoryRow to render
 *   sort        — current sort state
 *   filter      — current filter values
 *   loading     — show loading placeholder
 *   onSort      — called when a sortable column header is clicked
 *   onFilter    — called when any filter input changes
 */

import type { HistoryRow } from "@cq/shared";
import styles from "../styles/History.module.css";

// ---------------------------------------------------------------------------
// Sort state
// ---------------------------------------------------------------------------

export type SortKey = "startedAt" | "durationMs" | "toolCallCount" | "costUsd";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

export interface FilterState {
  agentName: string;
  model: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}

export const EMPTY_FILTER: FilterState = {
  agentName: "",
  model: "",
  status: "",
  dateFrom: "",
  dateTo: "",
  search: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

function statusClass(status: HistoryRow["status"]): string {
  switch (status) {
    case "running": return styles.statusRunning!;
    case "completed": return styles.statusCompleted!;
    case "failed": return styles.statusFailed!;
    case "stopped": return styles.statusStopped!;
    case "wiped": return styles.statusWiped!;
  }
}

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

interface ColDef {
  label: string;
  sortKey?: SortKey;
}

const COLUMNS: ColDef[] = [
  { label: "When", sortKey: "startedAt" },
  { label: "Agent" },
  { label: "Model" },
  { label: "Duration", sortKey: "durationMs" },
  { label: "Tool calls", sortKey: "toolCallCount" },
  { label: "Status" },
  { label: "Cost", sortKey: "costUsd" },
  { label: "In tokens" },
  { label: "Out tokens" },
  { label: "Session / Excerpt" },
  // PR-03: rightmost Resume column. Empty cell on subagent / active /
  // unfinished rows; a button on finished top-level main rows.
  { label: "" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ListProps {
  rows: HistoryRow[];
  sort: SortState;
  filter: FilterState;
  loading: boolean;
  onSort: (key: SortKey) => void;
  onFilter: (patch: Partial<FilterState>) => void;
  /** Called when the user clicks a history row. Receives the invocationId. */
  onRowClick?: (invocationId: string) => void;
  /**
   * PR-03: the currently-active session id (from SessionContext). A row whose
   * sessionId matches this value will not render the Resume button (you can't
   * resume the live session — you're already in it).
   */
  activeSessionId?: string | null;
  /**
   * PR-03: called when the user clicks the Resume button. Receives the
   * row's invocationId; the parent forwards to the cross-tab resume signal
   * (SessionContext.requestResume).
   */
  onResumeSession?: (invocationId: string) => void;
}

export function List({
  rows,
  sort,
  filter,
  loading,
  onSort,
  onFilter,
  onRowClick,
  activeSessionId = null,
  onResumeSession,
}: ListProps): React.ReactElement {
  return (
    <div className={styles.historyTab}>
      {/* Filter bar */}
      <div className={styles.filters} role="search" aria-label="History filters">
        <input
          className={`${styles.filterInput} ${styles.searchInput}`}
          type="search"
          placeholder="Search excerpts…"
          value={filter.search}
          aria-label="Search excerpts"
          onChange={(e) => onFilter({ search: e.target.value })}
        />
        <input
          className={styles.filterInput}
          type="text"
          placeholder="Agent"
          value={filter.agentName}
          aria-label="Filter by agent"
          onChange={(e) => onFilter({ agentName: e.target.value })}
        />
        <input
          className={styles.filterInput}
          type="text"
          placeholder="Model"
          value={filter.model}
          aria-label="Filter by model"
          onChange={(e) => onFilter({ model: e.target.value })}
        />
        <select
          className={styles.filterInput}
          value={filter.status}
          aria-label="Filter by status"
          onChange={(e) => onFilter({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="stopped">Stopped</option>
          <option value="wiped">Wiped</option>
        </select>
        <input
          className={styles.filterInput}
          type="date"
          placeholder="From date"
          value={filter.dateFrom}
          aria-label="Filter from date"
          onChange={(e) => onFilter({ dateFrom: e.target.value })}
        />
        <input
          className={styles.filterInput}
          type="date"
          placeholder="To date"
          value={filter.dateTo}
          aria-label="Filter to date"
          onChange={(e) => onFilter({ dateTo: e.target.value })}
        />
      </div>

      {/* Table */}
      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>No history entries found.</div>
        ) : (
          <table className={styles.table} aria-label="Invocation history">
            <thead>
              <tr>
                {COLUMNS.map((col) =>
                  col.sortKey ? (
                    <th
                      key={col.label}
                      className={`${styles.sortable}`}
                      aria-sort={
                        sort.key === col.sortKey
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        className={styles.sortButton}
                        onClick={() => onSort(col.sortKey!)}
                        aria-label={`Sort by ${col.label}`}
                      >
                        {col.label}
                        {sort.key === col.sortKey && (
                          <span className={styles.sortIndicator}>
                            {sort.dir === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                      </button>
                    </th>
                  ) : (
                    <th key={col.label}>{col.label}</th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.invocationId}
                  onClick={onRowClick ? () => onRowClick(row.invocationId) : undefined}
                  style={onRowClick ? { cursor: "pointer" } : undefined}
                  data-testid={`history-row-${row.invocationId}`}
                >
                  <td className={styles.mono}>{fmtDate(row.startedAt)}</td>
                  <td>
                    {row.agentName !== "main" && (
                      <span title="Subagent invocation" style={{ marginRight: 4 }}>↪</span>
                    )}
                    {row.agentName}
                    {row.resumedFromInvocationId != null && (
                      <span
                        className={styles.resumedBadge}
                        title={`Resumed from ${row.resumedFromInvocationId.slice(0, 8)}`}
                      >
                        {" "}↻
                      </span>
                    )}
                  </td>
                  <td className={styles.mono}>{row.model}</td>
                  <td className={styles.mono}>{fmtDuration(row.durationMs)}</td>
                  <td className={styles.mono}>{row.toolCallCount}</td>
                  <td>
                    <span className={`${styles.statusBadge} ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  {/* PR-02: subagent rows have no per-row cost/token data
                      (SDK emits result only at the top-level turn boundary),
                      so render empty cells rather than misleading zeros. */}
                  <td className={styles.mono}>{row.agentName === "main" ? fmtCost(row.costUsd) : ""}</td>
                  <td className={styles.mono}>{row.agentName === "main" ? row.inputTokens : ""}</td>
                  <td className={styles.mono}>{row.agentName === "main" ? row.outputTokens : ""}</td>
                  <td>
                    {/* PR-05: main rows show Haiku-generated title (or first
                        prompt excerpt as fallback, then "(no prompt)" if both
                        are empty). Subagent rows keep the old layout: small
                        session-id line + their existing prompt-excerpt body,
                        because the subagent's prompt is already meaningful and
                        we deliberately do not generate titles for them. */}
                    {row.agentName === "main" ? (
                      <div className={styles.mono} style={{ fontSize: 11 }}>
                        {row.title || row.promptExcerpt || "(no prompt)"}
                      </div>
                    ) : (
                      <>
                        <div className={styles.mono} style={{ fontSize: 11 }}>
                          {row.sessionId.slice(0, 8)}
                        </div>
                        <div className={styles.excerpt} title={row.promptExcerpt}>
                          {row.promptExcerpt}
                        </div>
                      </>
                    )}
                  </td>
                  {/* PR-03: Resume button — only on finished top-level main rows
                      that are not the currently-active session. */}
                  <td>
                    {row.agentName === "main" &&
                    row.endedAt !== null &&
                    row.sessionId !== activeSessionId &&
                    onResumeSession !== undefined ? (
                      <button
                        type="button"
                        className={styles.resumeButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          onResumeSession(row.invocationId);
                        }}
                        data-testid={`resume-row-${row.invocationId}`}
                        aria-label={`Resume session ${row.sessionId.slice(0, 8)}`}
                      >
                        Resume
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
