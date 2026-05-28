/**
 * Header.tsx — fixed top bar showing live session metadata.
 *
 * Displays:
 *   - cwd (read-only <code> element, from initInfo)
 *   - model picker (Opus/Sonnet/Haiku — set by parent or fallback list)
 *   - permission-mode toggle (4 modes: default/acceptEdits/bypassPermissions/plan)
 *   - live tokens (in/out) + cost in USD
 *   - session id (first 8 chars + title tooltip with full id)
 *   - started-at (ISO string)
 *   - duration ticking mm:ss (updates every second while in progress)
 *   - "New session" button (shows NewSessionConfirm if inProgress)
 *
 * Props:
 *   cwd              — working directory from initInfo; empty string when not yet received.
 *   model            — currently selected model; controlled by parent.
 *   onModelChange    — called when user picks a different model.
 *   permissionMode   — current permission mode; controlled by parent.
 *   onPermissionModeChange — called when user toggles the mode.
 *   inputTokens      — cumulative input token count from chat.usage.
 *   outputTokens     — cumulative output token count from chat.usage.
 *   costUsd          — cumulative cost in USD from chat.usage.
 *   sessionId        — active session UUID; null when no session started yet.
 *   startedAt        — epoch ms when the session started; null when no session.
 *   inProgress       — true while chat.started received but chat.done not yet.
 *   onNewSession     — called when user confirms starting a new session.
 *
 * Resume entry point: the resume flow is triggered from the History tab
 * (rightmost Resume column) via SessionContext.requestResume; ChatTab
 * consumes that signal. The Header carries no resume affordance.
 */

import { useState, useEffect, useRef } from "react";
import { NewSessionConfirm } from "./NewSessionConfirm";
import styles from "../styles/Header.module.css";

/**
 * Hard-coded model list. The SDK doesn't expose supportedModels via init,
 * so this is curated by hand. The `[1m]` suffix selects Anthropic's 1M-token
 * context tier; Opus and Sonnet have it, Haiku does not.
 */
const SUPPORTED_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5",
] as const;

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "read-only";

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "read-only"];

export interface HeaderProps {
  cwd: string;
  model: string;
  onModelChange: (model: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId: string | null;
  startedAt: number | null;
  inProgress: boolean;
  /** D44: count of subagents currently mid-flight (task_started without
   *  matching task_notification). Driven by computeSubagentCount in ChatTab. */
  runningSubagents?: number;
  onNewSession: () => void;
  hideSdkEvents: boolean;
  onHideSdkEventsChange: (value: boolean) => void;
}

/** Format epoch ms as "mm:ss" elapsed from startedAt to now. */
function formatDuration(startedAt: number, now: number): string {
  const totalSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Truncate a UUID to its first 8 hex chars. */
function truncateId(id: string): string {
  return id.slice(0, 8);
}

export function Header({
  cwd,
  model,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  inputTokens,
  outputTokens,
  costUsd,
  sessionId,
  startedAt,
  inProgress,
  runningSubagents = 0,
  onNewSession,
  hideSdkEvents,
  onHideSdkEventsChange,
}: HeaderProps): React.ReactElement {
  const [showConfirm, setShowConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick every second while a session is in progress to update the duration counter.
  useEffect(() => {
    if (inProgress && startedAt !== null) {
      tickRef.current = setInterval(() => {
        setNow(Date.now());
      }, 1000);
    } else {
      if (tickRef.current !== null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }
    return () => {
      if (tickRef.current !== null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [inProgress, startedAt]);

  function handleNewSessionClick(): void {
    if (inProgress) {
      setShowConfirm(true);
    } else {
      onNewSession();
    }
  }

  function handleConfirm(): void {
    setShowConfirm(false);
    onNewSession();
  }

  function handleCancel(): void {
    setShowConfirm(false);
  }

  const durationText =
    startedAt !== null ? formatDuration(startedAt, now) : "--:--";

  // D44: session status badge — "BUSY" while a turn is in flight (inProgress),
  // "IDLE" once chat.done landed and we're waiting for next input.
  const statusBadge = sessionId === null ? "NEW" : inProgress ? "BUSY" : "IDLE";

  return (
    <>
      <header className={styles.header} data-testid="chat-header">
        {/* cwd */}
        <code className={styles.cwd} title={cwd}>{cwd || "—"}</code>

        {/* model picker */}
        <select
          className={styles.select}
          value={model}
          onChange={(e) => onModelChange(e.currentTarget.value)}
          aria-label="Model"
          data-testid="model-select"
        >
          {SUPPORTED_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          {/* If current model is not in the default list, add it */}
          {!SUPPORTED_MODELS.includes(model as (typeof SUPPORTED_MODELS)[number]) && (
            <option value={model}>{model}</option>
          )}
        </select>

        {/* permission mode toggle */}
        <select
          className={styles.select}
          value={permissionMode}
          onChange={(e) => onPermissionModeChange(e.currentTarget.value as PermissionMode)}
          aria-label="Permission mode"
          data-testid="permission-mode-select"
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        {/* hide SDK events toggle */}
        <label className={styles.meta} data-testid="hide-sdk-events-label">
          <input
            type="checkbox"
            checked={hideSdkEvents}
            onChange={(e) => onHideSdkEventsChange(e.currentTarget.checked)}
            data-testid="hide-sdk-events-toggle"
          />
          {" Hide SDK events"}
        </label>

        {/* tokens + cost */}
        <span className={styles.usage} data-testid="usage">
          ↑{inputTokens} ↓{outputTokens} ${costUsd.toFixed(4)}
        </span>

        {/* session id */}
        {sessionId !== null ? (
          <span
            className={styles.sessionId}
            title={sessionId}
            data-testid="session-id"
          >
            #{truncateId(sessionId)}
          </span>
        ) : (
          <span className={styles.sessionId} data-testid="session-id">—</span>
        )}

        {/* D44: session status + subagent count badges (replaces the ISO
            startup timestamp which was visually noisy). */}
        <span
          className={`${styles.badge} ${
            statusBadge === "BUSY" ? styles.badgeBusy :
            statusBadge === "IDLE" ? styles.badgeIdle :
            styles.badgeNew
          }`}
          data-testid="session-status"
          title={`Session status: ${statusBadge.toLowerCase()}`}
        >
          {statusBadge}
        </span>
        {runningSubagents > 0 && (
          <span
            className={`${styles.badge} ${styles.badgeSub}`}
            data-testid="subagent-count"
            title={`${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"} running`}
          >
            {runningSubagents} sub
          </span>
        )}

        {/* duration */}
        <span className={styles.meta} data-testid="duration">{durationText}</span>

        <span className={styles.spacer} />

        {/* new session button */}
        <button
          type="button"
          className={styles.newSessionBtn}
          onClick={handleNewSessionClick}
          data-testid="new-session-btn"
        >
          New session
        </button>
      </header>

      {showConfirm && (
        <NewSessionConfirm onCancel={handleCancel} onConfirm={handleConfirm} />
      )}
    </>
  );
}
