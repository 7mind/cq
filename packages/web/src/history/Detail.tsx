/**
 * Detail.tsx — History invocation detail view (PR-44).
 *
 * On mount, sends `history.get` with `replay: true` for the given invocationId.
 * Collects the `history.get_result` frame (header metadata) then streams
 * `history.replay_event` frames into a local ChatEvent[] list.
 * On `history.replay_done`, stops collecting.
 *
 * Renders:
 *   - A header with: agent name, parent session, model, started/ended,
 *     duration, tokens, cost, cwd.
 *   - A body containing <Stream chatEvents={events} mode="replay" /> so the
 *     same rendering pipeline as ChatTab is reused, but interactivity is
 *     suppressed (no onQuestionReply, mode="replay").
 */

import { useState, useEffect, useCallback } from "react";
import type { HistoryRowFull, ChatEvent } from "@cq/shared";
import { useConnection } from "../ws/useConnection";
import { Stream } from "../chat/Stream";
import { Timing } from "./Timing";
import { Export, type HeaderInfo } from "./Export";
import { headerFromRow } from "./exportFormats";
import styles from "../styles/History.module.css";

// ---------------------------------------------------------------------------
// DeleteConfirm — inline confirm dialog for destructive action
// ---------------------------------------------------------------------------

interface DeleteConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirm({ onConfirm, onCancel }: DeleteConfirmProps): React.ReactElement {
  return (
    <div className={styles.deleteConfirm} data-testid="delete-confirm">
      <span className={styles.deleteConfirmText}>Delete this invocation? This cannot be undone.</span>
      <button
        className={styles.deleteConfirmBtn}
        onClick={onConfirm}
        data-testid="delete-confirm-yes"
      >
        Delete
      </button>
      <button
        className={styles.detailCloseBtn}
        onClick={onCancel}
        data-testid="delete-confirm-no"
      >
        Cancel
      </button>
    </div>
  );
}

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
    second: "2-digit",
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

// ---------------------------------------------------------------------------
// Header sub-component
// ---------------------------------------------------------------------------

interface DetailHeaderProps {
  row: HistoryRowFull;
  onClose: () => void;
  onDelete: () => void;
  exportHeader: HeaderInfo;
  events: ChatEvent[];
}

function DetailHeader({ row, onClose, onDelete, exportHeader, events }: DetailHeaderProps): React.ReactElement {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={styles.detailHeader}>
      <div className={styles.detailHeaderRow}>
        <span className={styles.detailTitle} data-testid="detail-agent-name">
          {row.agentName}
        </span>
        <Export events={events} header={exportHeader} />
        {confirming ? (
          <DeleteConfirm
            onConfirm={() => { setConfirming(false); onDelete(); }}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirming(true)}
            aria-label="Delete invocation"
            data-testid="detail-delete-btn"
          >
            Delete
          </button>
        )}
        <button
          className={styles.detailCloseBtn}
          onClick={onClose}
          aria-label="Close detail"
          data-testid="detail-close-btn"
        >
          ✕ Close
        </button>
      </div>
      <div className={styles.detailMeta}>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Session:</span>
          <span data-testid="detail-session-id">{row.sessionId.slice(0, 8)}</span>
        </span>
        {row.parentInvocationId !== null && (
          <span className={styles.detailMetaItem}>
            <span className={styles.detailMetaLabel}>Parent:</span>
            <span data-testid="detail-parent-id">{row.parentInvocationId.slice(0, 8)}</span>
          </span>
        )}
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Model:</span>
          <span data-testid="detail-model">{row.model}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Started:</span>
          <span data-testid="detail-started">{fmtDate(row.startedAt)}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Ended:</span>
          <span data-testid="detail-ended">{fmtDate(row.endedAt)}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Duration:</span>
          <span data-testid="detail-duration">{fmtDuration(row.durationMs)}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Tokens:</span>
          <span data-testid="detail-tokens">{row.totalInputTokens + row.totalOutputTokens}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Cost:</span>
          <span data-testid="detail-cost">{fmtCost(row.totalCostUsd)}</span>
        </span>
        <span className={styles.detailMetaItem}>
          <span className={styles.detailMetaLabel}>Cwd:</span>
          <span data-testid="detail-cwd">{row.cwd}</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail component
// ---------------------------------------------------------------------------

export interface DetailProps {
  invocationId: string;
  onClose: () => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "streaming"; row: HistoryRowFull }
  | { phase: "done"; row: HistoryRowFull }
  | { phase: "error"; message: string };

export function Detail({ invocationId, onClose }: DetailProps): React.ReactElement {
  const manager = useConnection();

  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const handleSeek = useCallback((toolUseId: string) => {
    const el = document.querySelector(`[data-testid="tool-use-${toolUseId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const handleDelete = useCallback(() => {
    manager.send({
      type: "history.delete",
      seq: Date.now(),
      ts: Date.now(),
      what: "invocation",
      id: invocationId,
    });
    onClose();
  }, [manager, invocationId, onClose]);

  useEffect(() => {
    // Reset state when invocationId changes.
    setLoadState({ phase: "loading" });
    setEvents([]);

    const seq = Date.now();

    // Send history.get with replay:true to request the full invocation.
    manager.send({
      type: "history.get",
      seq,
      ts: Date.now(),
      invocationId,
      replay: true,
    });

    // Subscribe to inbound frames.
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "history.get_result") {
        if (frame.requestSeq !== seq) return;
        setLoadState({ phase: "streaming", row: frame.row });
        return;
      }

      if (frame.type === "history.replay_event") {
        if (frame.requestSeq !== seq) return;
        // Convert the replay event into a ChatEvent shape compatible with Stream.
        const chatEvent: ChatEvent = {
          type: "chat.event",
          seq: frame.seq,
          ts: frame.ts,
          sessionId: invocationId, // use invocationId as a stand-in; not used by renderer
          invocationId,
          parentInvocationId: null,
          sdkEvent: frame.sdkEvent,
        };
        setEvents((prev) => [...prev, chatEvent]);
        return;
      }

      if (frame.type === "history.replay_done") {
        if (frame.requestSeq !== seq) return;
        setLoadState((prev) =>
          prev.phase === "streaming" ? { phase: "done", row: prev.row } : prev,
        );
        return;
      }
    });

    return unsub;
  }, [invocationId, manager]);

  if (loadState.phase === "loading") {
    return (
      <div className={styles.detailOverlay} data-testid="detail-overlay">
        <div className={styles.detailHeader}>
          <div className={styles.detailHeaderRow}>
            <span className={styles.detailTitle}>Loading…</span>
            <button
              className={styles.detailCloseBtn}
              onClick={onClose}
              aria-label="Close detail"
              data-testid="detail-close-btn"
            >
              ✕ Close
            </button>
          </div>
        </div>
        <div className={styles.detailLoading} data-testid="detail-loading">
          Loading invocation…
        </div>
      </div>
    );
  }

  if (loadState.phase === "error") {
    return (
      <div className={styles.detailOverlay} data-testid="detail-overlay">
        <div className={styles.detailHeader}>
          <div className={styles.detailHeaderRow}>
            <span className={styles.detailTitle}>Error</span>
            <button
              className={styles.detailCloseBtn}
              onClick={onClose}
              aria-label="Close detail"
              data-testid="detail-close-btn"
            >
              ✕ Close
            </button>
          </div>
        </div>
        <div className={styles.detailError} data-testid="detail-error">
          {loadState.message}
        </div>
      </div>
    );
  }

  // phase === "streaming" | "done"
  const { row } = loadState;

  return (
    <div className={styles.detailOverlay} data-testid="detail-overlay">
      <DetailHeader row={row} onClose={onClose} onDelete={handleDelete} exportHeader={headerFromRow(row)} events={events} />
      <Timing
        events={events}
        invocationStartedAt={row.startedAt}
        invocationEndedAt={row.endedAt}
        onSeek={handleSeek}
      />
      <div className={styles.detailBody} data-testid="detail-body">
        <Stream chatEvents={events} mode="replay" />
      </div>
    </div>
  );
}
