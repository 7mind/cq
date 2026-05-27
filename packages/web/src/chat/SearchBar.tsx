/**
 * SearchBar.tsx — in-conversation search bar (F4).
 *
 * Features:
 *   - Case-insensitive substring match over rendered message text.
 *   - Highlight matches with <mark> elements (handled in Stream / MessageBubble).
 *   - Shows "N / M" match counter.
 *   - ↑ / ↓ navigation buttons (and keyboard shortcuts inside the input).
 *   - Esc closes the bar.
 *
 * The component is stateless w.r.t. search results — the parent computes
 * matchCount and currentMatch from the messages and passes them in.
 * This keeps the search logic pure and testable outside the component.
 */

import { useEffect, useRef } from "react";
import styles from "../styles/SearchBar.module.css";

export interface SearchBarProps {
  query: string;
  onChange: (q: string) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  matchCount: number;
  /** 1-based index of the active match, or 0 when no matches / query empty. */
  currentMatch: number;
}

export function SearchBar({
  query,
  onChange,
  onClose,
  onPrev,
  onNext,
  matchCount,
  currentMatch,
}: SearchBarProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when the bar mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
      return;
    }
  }

  const counterText =
    query.length === 0
      ? ""
      : matchCount === 0
        ? "No results"
        : `${currentMatch} / ${matchCount}`;

  function handleBarKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className={styles.bar} role="search" aria-label="Search messages" data-testid="search-bar" onKeyDown={handleBarKeyDown}>
      <input
        ref={inputRef}
        className={styles.input}
        type="search"
        value={query}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages…"
        aria-label="Search query"
        data-testid="search-input"
        autoComplete="off"
        spellCheck={false}
      />
      {counterText.length > 0 && (
        <span className={styles.counter} data-testid="search-counter" aria-live="polite">
          {counterText}
        </span>
      )}
      <button
        className={styles.navBtn}
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        data-testid="search-prev"
        type="button"
      >
        ↑
      </button>
      <button
        className={styles.navBtn}
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        data-testid="search-next"
        type="button"
      >
        ↓
      </button>
      <button
        className={styles.closeBtn}
        onClick={onClose}
        aria-label="Close search"
        data-testid="search-close"
        type="button"
      >
        ✕
      </button>
    </div>
  );
}
