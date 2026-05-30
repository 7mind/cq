/**
 * Header.tsx — fixed top bar showing live session metadata (gear-3 + codex-7).
 *
 * After gear-3 the model/permissionMode/hideSdkEvents/effort controls live
 * inside <SettingsPopup>. The Header retains:
 *   - gear icon (top-LEFT) toggling the popup
 *   - cwd (read-only <code>, from initInfo)
 *   - usage badges (tokens + cost)
 *   - session id, status badge, subagent badge
 *   - duration ticking mm:ss
 *   - "New session" button (with confirm if mid-stream)
 *
 * Resume entry point: the resume flow is triggered from the History tab
 * (rightmost Resume column) via SessionContext.requestResume; ChatTab
 * consumes that signal. The Header carries no resume affordance.
 *
 * Per-session settings semantics: the popup updates the controlled state
 * but ChatTab only reads those values when building the NEXT ChatStart —
 * changes do not affect the live session. See SettingsPopup.tsx for the
 * "Changes apply to the next new chat" hint.
 */

import { useState, useEffect, useRef } from "react";
import { NewSessionConfirm } from "./NewSessionConfirm";
import { SettingsPopup } from "./SettingsPopup";
import type { ApprovalPolicy, Effort } from "@cq/shared";
import type { ThemeMode } from "../lib/theme";
import styles from "../styles/Header.module.css";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "read-only"
  | "codex-read-only"
  | "codex-workspace-write"
  | "codex-danger-full-access";

export interface HeaderProps {
  cwd: string;
  /** Currently-selected model — used by the popup, drives platform routing. */
  model: string;
  onModelChange: (model: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** gear-3: reasoning-effort tier (per-session). */
  effort: Effort;
  onEffortChange: (effort: Effort) => void;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId: string | null;
  startedAt: number | null;
  inProgress: boolean;
  /**
   * ACTIVITY-01: aggregate compute-activity count from the server's
   * `activity.status` frame = chat-busy (0/1) + in-flight `/plan` workflow phase
   * dispatches. Drives the top-bar status badge: `running > 0 → "BUSY (running)"`.
   * Distinct from `inProgress` (chat-only), which still drives the duration tick.
   * Defaults to 0 so callers that have not wired it render IDLE/NEW.
   */
  running?: number;
  /** D44: count of subagents currently mid-flight (task_started without
   *  matching task_notification). Driven by computeSubagentCount in ChatTab. */
  runningSubagents?: number;
  onNewSession: () => void;
  hideSdkEvents: boolean;
  onHideSdkEventsChange: (value: boolean) => void;
  /** DARK-01: theme mode (display pref) — applied live via the theme controller. */
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  /** gcn1-3: Codex approvalPolicy — shown in the popup only when platform=codex. */
  approvalPolicy: ApprovalPolicy;
  onApprovalPolicyChange: (policy: ApprovalPolicy) => void;
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
  effort,
  onEffortChange,
  inputTokens,
  outputTokens,
  costUsd,
  sessionId,
  startedAt,
  inProgress,
  running = 0,
  runningSubagents = 0,
  onNewSession,
  hideSdkEvents,
  onHideSdkEventsChange,
  themeMode,
  onThemeModeChange,
  approvalPolicy,
  onApprovalPolicyChange,
}: HeaderProps): React.ReactElement {
  const [showConfirm, setShowConfirm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gearBtnRef = useRef<HTMLButtonElement | null>(null);

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

  function handleGearClick(): void {
    setSettingsOpen((prev) => !prev);
  }

  const durationText =
    startedAt !== null ? formatDuration(startedAt, now) : "--:--";

  // ACTIVITY-01: the status badge reflects ALL active compute — the aggregate
  // `running` count (chat turn streaming + in-flight /plan workflow phases), NOT
  // just the chat session's inProgress. `running > 0 → BUSY (N)`; else IDLE when
  // a chat session exists, else NEW. A workflow phase dispatching while the chat
  // is idle still shows BUSY (1). The badge STATE (busy/idle/new) drives the CSS
  // class; the LABEL carries the count.
  const badgeState: "new" | "busy" | "idle" =
    running > 0 ? "busy" : sessionId === null ? "new" : "idle";
  const statusLabel =
    badgeState === "busy" ? `BUSY (${running})` : badgeState === "idle" ? "IDLE" : "NEW";

  return (
    <>
      <header className={styles.header} data-testid="chat-header">
        {/* gear button — anchors the SettingsPopup */}
        <div className={styles.gearWrap}>
          <button
            ref={gearBtnRef}
            type="button"
            className={styles.gearBtn}
            onClick={handleGearClick}
            aria-label="Session settings"
            aria-expanded={settingsOpen}
            data-testid="settings-gear-btn"
          >
            {/* Inline SVG gear icon — no external dep. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {settingsOpen && (
            <SettingsPopup
              model={model}
              onModelChange={onModelChange}
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              effort={effort}
              onEffortChange={onEffortChange}
              hideSdkEvents={hideSdkEvents}
              onHideSdkEventsChange={onHideSdkEventsChange}
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              approvalPolicy={approvalPolicy}
              onApprovalPolicyChange={onApprovalPolicyChange}
              onClose={() => setSettingsOpen(false)}
              anchorRef={gearBtnRef}
            />
          )}
        </div>

        {/* cwd */}
        <code className={styles.cwd} title={cwd}>{cwd || "—"}</code>

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

        {/* ACTIVITY-01: aggregate-activity status + subagent count badges. */}
        <span
          className={`${styles.badge} ${
            badgeState === "busy" ? styles.badgeBusy :
            badgeState === "idle" ? styles.badgeIdle :
            styles.badgeNew
          }`}
          data-testid="session-status"
          title={`Session status: ${badgeState}`}
        >
          {statusLabel}
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
