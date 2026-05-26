/**
 * Input.tsx — multi-line textarea for chat input.
 *
 * Props:
 *   onSubmit(text, attachments): called when the user triggers the send chord.
 *   onInterrupt():               called when the Stop button is clicked.
 *   disabled:                    passed through to the textarea.
 *   slashCommands:               list of slash commands for autocomplete popover (PR-34).
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
 *   Esc         — if popover open: close popover. Otherwise blurs the textarea.
 *   isComposing — when e.isComposing is true the handler returns early,
 *                 passing all key events through to the IME composition
 *                 session. Prevents accidental submit on Enter-to-confirm
 *                 a CJK candidate. (F-16 IME safety requirement.)
 *                 Also prevents opening the slash popover during composition.
 *
 * Slash-command autocomplete (PR-34):
 *   Typing `/` at position 0 (or at the start of any line) while NOT composing
 *   opens a popover listing slashCommands filtered by what follows `/`.
 *   Up/Down moves selection; Enter inserts `/<name> ` and closes; Esc closes.
 *   Any character that makes the leading `/` no longer present closes the popover.
 *
 * Attachments (PR-35):
 *   Paste events reading clipboardData.files and drag-and-drop events reading
 *   dataTransfer.files are handled. Files are converted to Attachment objects
 *   via fileToAttachment() and held in local state until submit, at which point
 *   they are forwarded to onSubmit alongside the text and cleared.
 */

import { useRef, useState, useEffect } from "react";
import { isMacPlatform } from "../lib/platform";
import { fuzzyFilter } from "../lib/fuzzy";
import { fileToAttachment } from "../lib/attachment";
import type { Attachment } from "../lib/attachment";
import { SlashPopover } from "./SlashPopover";
import type { SlashCommand } from "./SlashPopover";
import { AttachmentList } from "./AttachmentList";
import styles from "../styles/Input.module.css";

export interface InputProps {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  slashCommands?: SlashCommand[];
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

export function Input({ onSubmit, onInterrupt, disabled, slashCommands = [] }: InputProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);

  // --- Slash popover state ---
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);

  // --- Attachment state (PR-35) ---
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  /**
   * Recompute the filtered command list from the current textarea value.
   * Opens or closes the popover based on whether the value starts with `/`
   * at a line boundary and no whitespace follows (only the partial command name).
   */
  function syncPopover(value: string, cursorPos: number): void {
    // Find the start of the current "word" ending at cursorPos.
    const textBeforeCursor = value.slice(0, cursorPos);
    // The popover is active when the text before the cursor on this line
    // starts with `/` and contains no space (so we're still typing the command name).
    const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
    const lineFragment = textBeforeCursor.slice(lineStart);

    if (lineFragment.startsWith("/") && !lineFragment.includes(" ")) {
      const query = lineFragment.slice(1); // everything after the leading `/`
      const filtered = fuzzyFilter(query, slashCommands);
      if (filtered.length > 0) {
        setFilteredCommands(filtered);
        setSelectedIndex(0);
        setPopoverOpen(true);
        return;
      }
    }
    setPopoverOpen(false);
  }

  /** Insert the command (with trailing space) at the position of the currently-typed
   *  `/command` fragment, replacing it from the line-start `/` up to the cursor. */
  function pickCommand(name: string): void {
    const ta = ref.current;
    if (!ta) return;
    const value = ta.value;
    const cursorPos = ta.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
    // `name` already includes the leading `/` (e.g. "/clear").
    // Replace from lineStart up to cursorPos (the `/<partial>` fragment).
    const insertion = `${name} `;
    ta.value = value.slice(0, lineStart) + insertion + value.slice(cursorPos);
    const newCursor = lineStart + insertion.length;
    ta.setSelectionRange(newCursor, newCursor);
    setPopoverOpen(false);
  }

  // When slashCommands list changes externally, re-sync if popover is already open.
  useEffect(() => {
    if (!popoverOpen) return;
    const ta = ref.current;
    if (!ta) return;
    syncPopover(ta.value, ta.selectionStart ?? ta.value.length);
  }, [slashCommands]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // IME passthrough: never intercept during an active composition session.
    if (e.nativeEvent.isComposing) return;

    // --- Popover navigation (when open) ---
    if (popoverOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const cmd = filteredCommands[selectedIndex];
        if (cmd !== undefined) pickCommand(cmd.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopoverOpen(false);
        return;
      }
    }

    // --- Normal Escape: blur textarea ---
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }

    // --- Check for `/` opening the popover ---
    if (e.key === "/" && !popoverOpen) {
      // Let the browser insert the `/` first via default; we'll check in onInput.
      // (Nothing to do here; onInput will fire after the character lands.)
    }

    if (isSendChord(e.nativeEvent)) {
      e.preventDefault();
      const text = ref.current?.value ?? "";
      const trimmed = text.trim();
      if (trimmed.length > 0 || attachments.length > 0) {
        onSubmit(trimmed, attachments);
        if (ref.current) ref.current.value = "";
        setPopoverOpen(false);
        setAttachments([]);
      }
      return;
    }

    // Shift+Enter and plain Enter both fall through to default textarea
    // behaviour, which inserts a newline. No explicit handling needed.
  }

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>): void {
    const ta = e.currentTarget;
    syncPopover(ta.value, ta.selectionStart ?? ta.value.length);
  }

  /** Collect files from a FileList and add them as Attachment objects to state. */
  function addFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const pending: Promise<Attachment>[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f) pending.push(fileToAttachment(f));
    }
    Promise.all(pending).then((resolved) => {
      setAttachments((prev) => [...prev, ...resolved]);
    }).catch(() => {
      // Individual file conversion errors are non-fatal; silently skip.
    });
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = e.clipboardData?.files ?? null;
    if (files && files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
    // If no files, let default paste (text) proceed.
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    addFiles(e.dataTransfer?.files ?? null);
  }

  function handleRemoveAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div
      className={styles.container}
      style={{ position: "relative" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {popoverOpen && filteredCommands.length > 0 && (
        <SlashPopover
          items={filteredCommands}
          selectedIndex={selectedIndex}
          onPick={pickCommand}
          onClose={() => setPopoverOpen(false)}
        />
      )}
      <AttachmentList attachments={attachments} onRemove={handleRemoveAttachment} />
      <textarea
        ref={ref}
        className={styles.textarea}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onPaste={handlePaste}
        placeholder="Cmd+Enter to send"
        rows={3}
        aria-label="Chat input"
      />
      {disabled === true && onInterrupt !== undefined && (
        <button
          className={styles.stopButton}
          onClick={onInterrupt}
          type="button"
          aria-label="Stop generation"
        >
          Stop
        </button>
      )}
    </div>
  );
}
