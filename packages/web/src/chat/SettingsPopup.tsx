/**
 * SettingsPopup.tsx — gear-popup hosting the per-session settings
 * (gear-3 + codex-7).
 *
 * Hosts four controls:
 *   - model dropdown          — drives platform routing via modelToPlatform
 *   - permission mode picker  — Claude or Codex option set, by platform
 *   - reasoning effort picker — single 5-tier enum, mapped per platform
 *                               at the bridge boundary
 *   - hide-SDK-events checkbox — Stream rendering filter
 *
 * Anchored to a parent-supplied trigger node (the gear button). Closes
 * on outside-click and Esc. No backdrop. Defaults come from localStorage
 * via the parent.
 *
 * Per-session semantics: changes here apply on the next New Chat, NOT
 * to the live session (consistent with the brief Q1/Q2). The popup just
 * updates the controlled React state; ChatTab reads it when the next
 * ChatStart is built.
 */

import { useEffect, useRef } from "react";
import type { Effort } from "@cq/shared";
import { EFFORT_VALUES, MODELS, modelToPlatform } from "@cq/shared";
import type { PermissionMode } from "./Header";
import styles from "../styles/SettingsPopup.module.css";

/** Codex sandbox option set, presented to the popup when platform=codex. */
const CODEX_SANDBOX_OPTIONS: readonly { value: PermissionMode; label: string }[] = [
  { value: "codex-read-only",        label: "read-only" },
  { value: "codex-workspace-write",  label: "workspace-write" },
  { value: "codex-danger-full-access", label: "danger-full-access" },
] as const;

/** Claude permission-mode option set (the existing 5 values). */
const CLAUDE_PERMISSION_OPTIONS: readonly { value: PermissionMode; label: string }[] = [
  { value: "default",            label: "default" },
  { value: "acceptEdits",        label: "acceptEdits" },
  { value: "bypassPermissions",  label: "bypassPermissions" },
  { value: "plan",               label: "plan" },
  { value: "read-only",          label: "read-only" },
] as const;

export interface SettingsPopupProps {
  /** Currently-selected model id. */
  model: string;
  onModelChange: (model: string) => void;
  /** Currently-selected permission mode value (union spans both platforms). */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Currently-selected reasoning-effort tier. */
  effort: Effort;
  onEffortChange: (effort: Effort) => void;
  /** Hide SDK events checkbox state. */
  hideSdkEvents: boolean;
  onHideSdkEventsChange: (value: boolean) => void;
  /** Called when the popup should close (Esc / outside-click). */
  onClose: () => void;
  /**
   * Optional anchor element — outside-click ignores clicks on this node so
   * the parent's gear button can serve as both "open" and "close" toggle
   * without flickering.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function SettingsPopup({
  model,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  effort,
  onEffortChange,
  hideSdkEvents,
  onHideSdkEventsChange,
  onClose,
  anchorRef,
}: SettingsPopupProps): React.ReactElement {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const platform = modelToPlatform(model);

  // Outside-click + Esc close.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    function onClick(e: MouseEvent): void {
      const target = e.target as Node;
      if (popupRef.current === null) return;
      if (popupRef.current.contains(target)) return;
      if (anchorRef?.current?.contains(target) === true) return;
      onClose();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onClick, true);
    };
  }, [onClose, anchorRef]);

  const permissionOptions = platform === "codex"
    ? CODEX_SANDBOX_OPTIONS
    : CLAUDE_PERMISSION_OPTIONS;

  // If the current permissionMode is not valid for the current platform,
  // reflect that visually by pre-selecting the first option of the right set.
  // The change is committed only when the user picks an option (no implicit
  // onPermissionModeChange call — keeps the popup pure controlled).
  const effectivePermissionMode = permissionOptions.some(o => o.value === permissionMode)
    ? permissionMode
    : permissionOptions[0]!.value;

  return (
    <div
      ref={popupRef}
      className={styles.popup}
      role="dialog"
      aria-label="Session settings"
      data-testid="settings-popup"
    >
      <div className={styles.row}>
        <label htmlFor="settings-model">Model</label>
        <select
          id="settings-model"
          className={styles.select}
          value={model}
          onChange={(e) => onModelChange(e.currentTarget.value)}
          data-testid="model-select"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          {!MODELS.some((m) => m.id === model) && (
            <option value={model}>{model}</option>
          )}
        </select>
      </div>

      <div className={styles.row}>
        <label htmlFor="settings-permission">
          {platform === "codex" ? "Sandbox" : "Permission mode"}
        </label>
        <select
          id="settings-permission"
          className={styles.select}
          value={effectivePermissionMode}
          onChange={(e) => onPermissionModeChange(e.currentTarget.value as PermissionMode)}
          data-testid="permission-mode-select"
        >
          {permissionOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <label htmlFor="settings-effort">Reasoning effort</label>
        <select
          id="settings-effort"
          className={styles.select}
          value={effort}
          onChange={(e) => onEffortChange(e.currentTarget.value as Effort)}
          data-testid="effort-select"
        >
          {EFFORT_VALUES.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
      </div>

      <div className={styles.rowCheckbox}>
        <label data-testid="hide-sdk-events-label">
          <input
            type="checkbox"
            checked={hideSdkEvents}
            onChange={(e) => onHideSdkEventsChange(e.currentTarget.checked)}
            data-testid="hide-sdk-events-toggle"
          />
          {" Hide SDK events"}
        </label>
      </div>

      <div className={styles.hint} data-testid="settings-hint">
        Changes apply to the next new chat.
      </div>
    </div>
  );
}
