/**
 * A keyboard-driven single-select list.
 *
 * Renders one row per item with the focused row inverse-highlighted. ↑/↓
 * (and k/j) move the cursor, Enter selects, Esc cancels. Only mounts its
 * `useInput` handler while `isActive` — App mounts exactly one interactive
 * screen at a time so handlers never compete for keystrokes.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectListProps<T> {
  items: readonly T[];
  getLabel: (item: T, index: number) => string;
  onSelect: (item: T, index: number) => void;
  onCancel?: () => void;
  isActive?: boolean;
  /** Rendered above the list when the list is empty. */
  emptyLabel?: string;
}

export function SelectList<T>({
  items,
  getLabel,
  onSelect,
  onCancel,
  isActive = true,
  emptyLabel = "(empty)",
}: SelectListProps<T>): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const sel = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, Math.min(c, items.length - 1) - 1));
      } else if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (key.return) {
        const item = items[sel];
        if (item !== undefined) onSelect(item, sel);
      } else if (key.escape) {
        onCancel?.();
      }
    },
    { isActive },
  );

  if (items.length === 0) {
    return <Text dimColor>{emptyLabel}</Text>;
  }
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={i} inverse={i === sel}>
          {i === sel ? "› " : "  "}
          {getLabel(item, i)}
        </Text>
      ))}
    </Box>
  );
}
