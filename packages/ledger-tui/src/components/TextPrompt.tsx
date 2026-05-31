/**
 * A minimal single-line text input.
 *
 * Printable characters append; Backspace/Delete erase; Enter submits the
 * current value; Esc cancels. Implemented directly on `useInput` to avoid an
 * extra dependency and to keep keystroke handling identical under both a real
 * terminal and ink-testing-library.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface TextPromptProps {
  label: string;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  isActive?: boolean;
}

export function TextPrompt({
  label,
  initialValue = "",
  onSubmit,
  onCancel,
  isActive = true,
}: TextPromptProps): React.ReactElement {
  const [value, setValue] = useState(initialValue);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
      } else if (key.escape) {
        onCancel?.();
      } else if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        setValue((v) => v + input);
      }
    },
    { isActive },
  );

  return (
    <Box>
      <Text>{label} </Text>
      <Text color="cyan">{value}</Text>
      <Text>▌</Text>
    </Box>
  );
}
