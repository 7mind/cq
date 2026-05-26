/**
 * ResumePicker.tsx — modal picker listing prior 'main' invocations for resume.
 *
 * Calls `history.list` filtered by agentName='main', shows the results in a
 * scrollable list, and calls `onSelect` with the chosen invocationId.
 * Dismissable via the Cancel button or clicking the backdrop.
 */

import { useState, useEffect } from "react";
import { useConnection } from "../ws/useConnection";
import type { HistoryRow, HistoryListResult } from "@cq/shared";

export interface ResumePickerProps {
  onSelect: (invocationId: string) => void;
  onCancel: () => void;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function ResumePicker({ onSelect, onCancel }: ResumePickerProps): React.ReactElement {
  const manager = useConnection();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Request main-agent invocations (most recent first).
    const reqSeq = Date.now();
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "history.list_result") {
        const result = frame as unknown as HistoryListResult;
        if (result.requestSeq === reqSeq) {
          setRows(result.rows);
          setLoading(false);
        }
      }
    });

    manager.send({
      type: "history.list",
      seq: reqSeq,
      ts: Date.now(),
      filter: { agentName: "main" },
      sort: { key: "startedAt", dir: "desc" },
      page: 0,
      pageSize: 50,
    });

    return unsub;
  }, [manager]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
      }}
      onClick={onCancel}
      data-testid="resume-picker-backdrop"
    >
      <div
        style={{
          background: "#252526",
          border: "1px solid #555",
          borderRadius: 6,
          padding: "20px 24px",
          minWidth: 520,
          maxWidth: 720,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          color: "#d4d4d4",
          fontFamily: "monospace",
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="resume-picker-dialog"
      >
        <h3 style={{ margin: 0, fontFamily: "sans-serif", fontSize: 15, fontWeight: 600 }}>
          Resume from history
        </h3>

        {loading ? (
          <div style={{ color: "#808080" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "#808080" }}>No prior sessions found.</div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              overflowY: "auto",
              maxHeight: "50vh",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
            data-testid="resume-picker-list"
          >
            {rows.map((row) => (
              <li
                key={row.invocationId}
                style={{
                  padding: "8px 10px",
                  borderRadius: 4,
                  background: "#2d2d2d",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
                onClick={() => onSelect(row.invocationId)}
                data-testid={`resume-row-${row.invocationId}`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: "#9cdcfe", fontWeight: 600 }}>
                    {row.promptExcerpt || "(no prompt)"}
                  </span>
                  <span style={{ color: "#808080", flexShrink: 0 }}>
                    {formatDuration(row.durationMs)}
                  </span>
                </div>
                <div style={{ color: "#808080", fontSize: 11, display: "flex", gap: 12 }}>
                  <span>{formatDate(row.startedAt)}</span>
                  <span>{row.model}</span>
                  <span
                    style={{
                      color: row.status === "completed" ? "#4ec9b0" : row.status === "failed" ? "#f48771" : "#808080",
                    }}
                  >
                    {row.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            style={{
              padding: "5px 14px",
              background: "#3a3a3a",
              color: "#d4d4d4",
              border: "1px solid #555",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "sans-serif",
            }}
            onClick={onCancel}
            data-testid="resume-picker-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
