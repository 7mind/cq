/**
 * Cards/index.ts — ToolCard switcher.
 *
 * Dispatches to the typed card matching `toolUse.name`.
 * Falls back to UnknownCard for unrecognised tool names.
 *
 * Tool-use / tool-result shapes follow the Anthropic SDK BetaMessage content
 * block conventions:
 *   tool_use:   { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
 *   tool_result: { type: 'tool_result', tool_use_id: string, content: unknown }
 */

import { createElement } from "react";
import { ReadCard } from "./ReadCard";
import { WriteCard } from "./WriteCard";
import { EditCard } from "./EditCard";
import { BashCard } from "./BashCard";
import { PlanModeCard } from "./PlanModeCard";
import { UnknownCard } from "./UnknownCard";

export type { ReadInput, ReadCardProps } from "./ReadCard";
export type { WriteInput, WriteCardProps } from "./WriteCard";
export type { EditInput, EditCardProps } from "./EditCard";
export type { BashInput, BashResult, BashCardProps } from "./BashCard";
export { lineDiff } from "./diffLine";
export type { DiffEntry } from "./diffLine";

/** A parsed tool_use content block (subset of BetaToolUseBlock). */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A parsed tool_result content block (subset of BetaToolResultBlock). */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
}

/**
 * Parse the raw result content from a tool_result block into BashResult fields.
 * Anthropic encodes Bash results as tagged XML-ish sections inside the text
 * content, or as plain text. We do a best-effort parse: if the content
 * contains stdout/stderr tags we extract them; otherwise we treat it as stdout.
 */
function parseBashResult(resultContent: unknown): import("./BashCard").BashResult {
  let raw = "";
  if (typeof resultContent === "string") {
    raw = resultContent;
  } else if (Array.isArray(resultContent)) {
    for (const block of resultContent) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string"
      ) {
        raw += (block as Record<string, unknown>)["text"] as string;
      }
    }
  }

  // Try to extract exit code from a trailing pattern like "\nExit code: 0"
  let exitCode: number | undefined;
  const exitMatch = /(?:^|\n)Exit code:\s*(-?\d+)/i.exec(raw);
  if (exitMatch !== null) {
    exitCode = parseInt(exitMatch[1]!, 10);
    raw = raw.slice(0, exitMatch.index).trimEnd();
  }

  // Try XML-ish stdout/stderr extraction.
  const stdoutMatch = /<stdout>([\s\S]*?)<\/stdout>/i.exec(raw);
  const stderrMatch = /<stderr>([\s\S]*?)<\/stderr>/i.exec(raw);

  if (stdoutMatch !== null || stderrMatch !== null) {
    const result: import("./BashCard").BashResult = {};
    const so = stdoutMatch?.[1]?.trim();
    const se = stderrMatch?.[1]?.trim();
    if (so !== undefined && so !== "") result.stdout = so;
    if (se !== undefined && se !== "") result.stderr = se;
    if (exitCode !== undefined) result.exitCode = exitCode;
    return result;
  }

  // Plain text — treat as stdout.
  const result: import("./BashCard").BashResult = {};
  const trimmed = raw.trim();
  if (trimmed !== "") result.stdout = trimmed;
  if (exitCode !== undefined) result.exitCode = exitCode;
  return result;
}

/**
 * Render the appropriate card for a tool_use block, optionally paired with
 * its matching tool_result.
 */
export function ToolCard(
  toolUse: ToolUseBlock,
  toolResult?: ToolResultBlock,
): React.ReactElement {
  const resultContent = toolResult?.content;

  switch (toolUse.name) {
    case "Read":
      return createElement(ReadCard, {
        input: toolUse.input as import("./ReadCard").ReadInput,
        resultContent,
      });

    case "Write":
      return createElement(WriteCard, {
        input: toolUse.input as import("./WriteCard").WriteInput,
        resultContent,
      });

    case "Edit":
      return createElement(EditCard, {
        input: toolUse.input as import("./EditCard").EditInput,
        resultContent,
      });

    case "Bash":
      return createElement(BashCard, {
        input: toolUse.input as import("./BashCard").BashInput,
        result: parseBashResult(resultContent),
      });

    case "EnterPlanMode":
    case "ExitPlanMode":
      return createElement(PlanModeCard, {
        toolUse,
        ...(toolResult !== undefined ? { toolResult } : {}),
      });

    default:
      // Unknown tool — render the raw tool_use as JSON.
      return createElement(UnknownCard, {
        sdkEvent: { type: "tool_use", name: toolUse.name, input: toolUse.input },
      });
  }
}
