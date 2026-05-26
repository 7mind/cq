/**
 * Input.tsx — multi-line textarea for chat input.
 *
 * Props:
 *   onSubmit(text): called when the user triggers the send chord.
 *   disabled:       passed through to the textarea.
 *
 * Implementation note:
 *   The textarea is UNCONTROLLED (no React value/onChange binding) so that
 *   React 19 does not call getInstIfValueChanged on form-element keydown events.
 *   The current text is read from the ref on submit. This avoids a happy-dom +
 *   React 19 incompatibility (null fiber TypeError in getInstIfValueChanged)
 *   that fires when keydown events bubble through controlled form elements.
 *
 * Key behaviours:
 *   Send chord  — Cmd+Enter on macOS, Ctrl+Enter elsewhere.
 *                 Determined via isSendChord(e), which calls isMacPlatform()
 *                 from lib/platform.ts.
 *   Shift+Enter — default textarea behaviour (newline). preventDefault NOT
 *                 called so the browser inserts \n.
 *   Enter alone — default textarea behaviour (newline). No submit. Deliberate
 *                 product choice: plain Enter never submits; the explicit
 *                 Cmd/Ctrl chord is required (unambiguous across IME and
 *                 keyboard layouts).
 *   Esc         — blurs the textarea (e.currentTarget.blur()).
 *   isComposing — when e.isComposing is true the handler returns early,
 *                 passing all key events through to the IME composition
 *                 session. Prevents accidental submit on Enter-to-confirm
 *                 a CJK candidate. (F-16 IME safety requirement.)
 */

import { useRef } from "react";
import { isMacPlatform } from "../lib/platform";
import styles from "../styles/Input.module.css";

export interface InputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

/**
 * Returns true when the keyboard event represents the platform-appropriate
 * send chord: Cmd+Enter on macOS, Ctrl+Enter on Linux / Windows / other.
 *
 * Exported so tests can call it directly against stubbed navigator.platform.
 */
export function isSendChord(e: KeyboardEvent | React.KeyboardEvent): boolean {
  if (e.key !== "Enter") return false;
  if (isMacPlatform()) {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey && !e.metaKey;
}

export function Input({ onSubmit, disabled }: InputProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // IME passthrough: never intercept during an active composition session.
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }

    if (isSendChord(e.nativeEvent)) {
      e.preventDefault();
      const text = ref.current?.value ?? "";
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        onSubmit(trimmed);
        if (ref.current) ref.current.value = "";
      }
      return;
    }

    // Shift+Enter and plain Enter both fall through to default textarea
    // behaviour, which inserts a newline. No explicit handling needed.
  }

  return (
    <div className={styles.container}>
      <textarea
        ref={ref}
        className={styles.textarea}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        placeholder="Cmd+Enter to send"
        rows={3}
      />
    </div>
  );
}
