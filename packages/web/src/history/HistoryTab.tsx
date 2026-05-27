/**
 * HistoryTab.tsx — Top-level history tab component (PR-42).
 *
 * Sends `history.list` over WebSocket on mount and whenever filter/sort state
 * changes. Renders <List> with the returned rows.
 *
 * State: filter, sort, page. All changes trigger a fresh `history.list` send.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { HistoryRow, HistoryListResult } from "@cq/shared";
import { useConnection } from "../ws/useConnection";
import { useSession } from "../chat/SessionContext";
import { List, EMPTY_FILTER } from "./List";
import type { SortState, SortKey, FilterState } from "./List";
import { Detail } from "./Detail";
import styles from "../styles/History.module.css";

const DEFAULT_PAGE_SIZE = 50;

const DEFAULT_SORT: SortState = { key: "startedAt", dir: "desc" };

/** Map UI sort key to protocol sort key (snake_case). */
function toProtocolSortKey(key: SortKey): string {
  const map: Record<SortKey, string> = {
    startedAt: "started_at",
    durationMs: "duration_ms",
    toolCallCount: "tool_call_count",
    costUsd: "cost_usd",
  };
  return map[key];
}

/** Convert a date input string ("YYYY-MM-DD") to epoch ms, or undefined. */
function dateToMs(s: string, endOfDay = false): number | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function HistoryTab(): React.ReactElement {
  const manager = useConnection();
  const { activeSessionId, requestResume } = useSession();

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [page] = useState(0);
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | null>(null);

  /** Track the seq of the last sent request so stale responses are ignored. */
  const pendingSeqRef = useRef<number | null>(null);

  const sendList = useCallback(
    (currentSort: SortState, currentFilter: FilterState, currentPage: number): boolean => {
      const seq = Date.now();
      pendingSeqRef.current = seq;
      setLoading(true);

      const protocolStatus = currentFilter.status as
        | "completed"
        | "failed"
        | "stopped"
        | "running"
        | "wiped"
        | undefined;

      const sent = manager.send({
        type: "history.list",
        seq,
        ts: Date.now(),
        filter: {
          agentName: currentFilter.agentName || undefined,
          model: currentFilter.model || undefined,
          status: protocolStatus || undefined,
          dateFrom: dateToMs(currentFilter.dateFrom),
          dateTo: dateToMs(currentFilter.dateTo, true),
          search: currentFilter.search || undefined,
        },
        sort: {
          key: toProtocolSortKey(currentSort.key),
          dir: currentSort.dir,
        },
        page: currentPage,
        pageSize: DEFAULT_PAGE_SIZE,
      });

      if (!sent) {
        // Connection not ALIVE — keep loading spinner, will retry via subscription.
        setLoading(false);
        pendingSeqRef.current = null;
      }
      return sent;
    },
    [manager],
  );

  // Subscribe to inbound frames; extract history.list_result.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type !== "history.list_result") return;
      const result = frame as HistoryListResult;
      // Only apply if this matches the last pending request (by requestSeq).
      if (pendingSeqRef.current !== null && result.requestSeq !== pendingSeqRef.current) return;
      setRows(result.rows);
      setLoading(false);
    });
    return unsub;
  }, [manager]);

  // Keep refs of the latest sort/filter/page so the auto-fire effect below
  // captures fresh values without re-subscribing on every change.
  const sortRef = useRef(sort);
  const filterRef = useRef(filter);
  const pageRef = useRef(page);
  useEffect(() => { sortRef.current = sort; }, [sort]);
  useEffect(() => { filterRef.current = filter; }, [filter]);
  useEffect(() => { pageRef.current = page; }, [page]);

  // Auto-fire history.list whenever the connection is ALIVE and we have not
  // yet loaded any data. Fires on mount (if alive) and on every subsequent
  // manager.onUpdate (covering: late-ALIVE on first connect, reconnect after
  // a drop, etc.). The pendingSeqRef guard prevents stacking duplicate sends.
  useEffect(() => {
    let inFlight = false;
    const tryFire = (): void => {
      if (inFlight) return;
      const isAlive = manager.stats.connections.some((c) => c.state === "ALIVE");
      if (!isAlive) return;
      const ok = sendList(sortRef.current, filterRef.current, pageRef.current);
      if (ok) inFlight = true;
    };

    const unsubMsg = manager.onMessage((frame) => {
      if (frame.type === "history.list_result") inFlight = false;
    });

    tryFire();
    const unsubUpdate = manager.onUpdate(() => { tryFire(); });

    return () => { unsubMsg(); unsubUpdate(); };
  }, [manager, sendList]);

  const handleSort = useCallback(
    (key: SortKey) => {
      setSort((prev) => {
        const next: SortState =
          prev.key === key
            ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
            : { key, dir: "desc" };
        sendList(next, filter, page);
        return next;
      });
    },
    [filter, page, sendList],
  );

  const handleFilter = useCallback(
    (patch: Partial<FilterState>) => {
      setFilter((prev) => {
        const next = { ...prev, ...patch };
        sendList(sort, next, page);
        return next;
      });
    },
    [sort, page, sendList],
  );

  return (
    <div className={styles.historyTabWrapper}>
      <List
        rows={rows}
        sort={sort}
        filter={filter}
        loading={loading}
        onSort={handleSort}
        onFilter={handleFilter}
        onRowClick={(id) => setSelectedInvocationId(id)}
        activeSessionId={activeSessionId}
        onResumeSession={requestResume}
      />
      {selectedInvocationId !== null && (
        <Detail
          invocationId={selectedInvocationId}
          onClose={() => setSelectedInvocationId(null)}
        />
      )}
    </div>
  );
}
