/**
 * Timing.tsx — horizontal SVG timing strip (PR-45).
 *
 * Renders a horizontal SVG strip showing each tool call in the invocation as
 * a `<rect>` positioned by `start_offset_ms` from the invocation start and
 * sized by `duration_ms`. Hover shows a tooltip with the tool name and timing.
 * Click calls `onSeek(toolUseId)` so Detail can scroll the transcript.
 *
 * ## How timing is derived
 *
 * ChatEvent frames carry `ts` (wall-clock ms since epoch). Tool calls appear
 * as `tool_use` blocks inside `assistant`-type sdkEvents. We walk events in
 * order:
 *
 *  - When we encounter a `tool_use` block, we record its `ts` (the event that
 *    carried it) as `startTs`.
 *  - When we encounter a `tool_result` block referencing the same `tool_use_id`,
 *    we record that event's `ts` as `endTs` → `duration_ms = endTs - startTs`.
 *  - If no matching tool_result is found (e.g. the invocation is still running),
 *    we use `invocationEndedAt ?? Date.now()` for the end, giving an estimate.
 *
 * `start_offset_ms` is computed relative to `invocationStartedAt`.
 */

import { useState, useCallback } from "react";
import type { ChatEvent } from "@cq/shared";
import styles from "../styles/Timing.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolTiming {
  toolUseId: string;
  toolName: string;
  startOffsetMs: number;
  durationMs: number;
}

export interface TimingProps {
  events: ChatEvent[];
  invocationStartedAt: number;
  invocationEndedAt: number | null;
  onSeek?: (toolUseId: string) => void;
}

// ---------------------------------------------------------------------------
// Timing extraction
// ---------------------------------------------------------------------------

/** Palette — cycles through a small set of distinguishable hues. */
const PALETTE = [
  "#4a90d9",
  "#e8784a",
  "#50b86c",
  "#b96fc4",
  "#d4b84a",
  "#4ac4c4",
  "#e85c7a",
  "#7ab85c",
];

function pickColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

/**
 * Walk ChatEvent[] and extract ToolTiming entries.
 * Returns them in the order the tool_use blocks were first seen.
 */
export function extractToolTimings(
  events: ChatEvent[],
  invocationStartedAt: number,
  invocationEndedAt: number | null,
): ToolTiming[] {
  // Map tool_use_id → { name, startTs }
  const pending = new Map<string, { name: string; startTs: number }>();
  const result: ToolTiming[] = [];

  for (const evt of events) {
    const sdkEvent = evt.sdkEvent as Record<string, unknown>;
    if (sdkEvent["type"] !== "assistant") continue;

    const message = sdkEvent["message"] as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.["content"])
      ? (message!["content"] as unknown[])
      : [];

    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;

      if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
        pending.set(b["id"] as string, {
          name: b["name"] as string,
          startTs: evt.ts,
        });
        continue;
      }

      if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
        const toolUseId = b["tool_use_id"] as string;
        const entry = pending.get(toolUseId);
        if (entry !== undefined) {
          pending.delete(toolUseId);
          result.push({
            toolUseId,
            toolName: entry.name,
            startOffsetMs: Math.max(0, entry.startTs - invocationStartedAt),
            durationMs: Math.max(1, evt.ts - entry.startTs),
          });
        }
      }
    }
  }

  // Flush any pending (no tool_result seen yet — still running or incomplete).
  const fallbackEnd = invocationEndedAt ?? Date.now();
  for (const [toolUseId, entry] of pending) {
    result.push({
      toolUseId,
      toolName: entry.name,
      startOffsetMs: Math.max(0, entry.startTs - invocationStartedAt),
      durationMs: Math.max(1, fallbackEnd - entry.startTs),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SVG_HEIGHT = 28;
const BAR_HEIGHT = 18;
const BAR_Y = (SVG_HEIGHT - BAR_HEIGHT) / 2;
const SVG_WIDTH = 800; // internal coordinate space; scales to container width via viewBox

interface TooltipState {
  text: string;
  x: number;
  y: number;
}

export function Timing({
  events,
  invocationStartedAt,
  invocationEndedAt,
  onSeek,
}: TimingProps): React.ReactElement {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const timings = extractToolTimings(events, invocationStartedAt, invocationEndedAt);

  const handleMouseMove = useCallback((text: string, e: React.MouseEvent) => {
    setTooltip({ text, x: e.clientX + 10, y: e.clientY - 28 });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const handleClick = useCallback(
    (toolUseId: string) => {
      onSeek?.(toolUseId);
    },
    [onSeek],
  );

  if (timings.length === 0) {
    return (
      <div className={styles.container} data-testid="timing-strip">
        <div className={styles.label}>Tool timings</div>
        <div className={styles.noData}>No tool calls recorded.</div>
      </div>
    );
  }

  // Determine the total range for scaling.
  const totalMs = Math.max(
    1,
    timings.reduce((max, t) => Math.max(max, t.startOffsetMs + t.durationMs), 0),
  );

  const toX = (offsetMs: number): number => (offsetMs / totalMs) * SVG_WIDTH;
  const toW = (durationMs: number): number => Math.max(2, (durationMs / totalMs) * SVG_WIDTH);

  return (
    <div className={styles.container} data-testid="timing-strip">
      <div className={styles.label}>Tool timings</div>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        preserveAspectRatio="none"
        height={SVG_HEIGHT}
        aria-label="Tool call timing strip"
        data-testid="timing-svg"
      >
        {timings.map((t, i) => {
          const x = toX(t.startOffsetMs);
          const w = toW(t.durationMs);
          const tooltipText = `${t.toolName} +${t.startOffsetMs}ms / ${t.durationMs}ms`;
          return (
            <rect
              key={t.toolUseId}
              data-testid={`timing-rect-${t.toolUseId}`}
              data-tool-use-id={t.toolUseId}
              x={x}
              y={BAR_Y}
              width={w}
              height={BAR_HEIGHT}
              fill={pickColor(i)}
              className={styles.bar}
              rx={2}
              ry={2}
              onMouseMove={(e) => handleMouseMove(tooltipText, e)}
              onMouseLeave={handleMouseLeave}
              onClick={() => handleClick(t.toolUseId)}
              role="button"
              aria-label={tooltipText}
            />
          );
        })}
      </svg>
      {tooltip !== null && (
        <div
          className={styles.tooltip}
          style={{ left: tooltip.x, top: tooltip.y }}
          data-testid="timing-tooltip"
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
