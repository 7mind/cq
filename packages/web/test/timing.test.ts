/**
 * timing.test.ts — PR-45: Timing strip tests.
 *
 * 2 required cases:
 *  1. Render Timing with events containing 5 tool calls; 5 <rect> elements present.
 *  2. Pixel positions: a tool starting at +1000ms with duration 500ms maps to
 *     expected x/width given total range — within 1px.
 *
 * We test `extractToolTimings` directly (pure function, no DOM needed) for
 * case 2, and render the SVG component for case 1.
 */

// Must be first — registers DOM globals
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

import type { ChatEvent } from "@cq/shared";
import { Timing, extractToolTimings } from "../src/history/Timing";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_TS = 1_700_000_000_000; // arbitrary epoch anchor

let _seq = 500;

/**
 * Build a ChatEvent carrying an `assistant`-type sdkEvent whose message.content
 * contains a mix of tool_use and tool_result blocks.
 */
function makeAssistantEvent(
  ts: number,
  contentBlocks: Record<string, unknown>[],
): ChatEvent {
  return {
    type: "chat.event",
    seq: _seq++,
    ts,
    sessionId: "11111111-2222-3333-4444-555555555555",
    invocationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    parentInvocationId: null,
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000001",
      session_id: "11111111-2222-3333-4444-555555555555",
      parent_tool_use_id: null,
      message: {
        id: `msg-${_seq}`,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  };
}

function makeToolUseBlock(id: string, name: string): Record<string, unknown> {
  return { type: "tool_use", id, name, input: {} };
}

function makeToolResultBlock(toolUseId: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: toolUseId, content: "ok" };
}

// ---------------------------------------------------------------------------
// Build a synthetic sequence of 5 tool calls (tool_use + tool_result pairs).
//
// Layout (offsets relative to BASE_TS):
//   Tool A: start=+0ms,    end=+200ms  → duration 200ms
//   Tool B: start=+300ms,  end=+600ms  → duration 300ms
//   Tool C: start=+700ms,  end=+900ms  → duration 200ms
//   Tool D: start=+1000ms, end=+1500ms → duration 500ms
//   Tool E: start=+1600ms, end=+2000ms → duration 400ms
// Total range: 2000ms
// ---------------------------------------------------------------------------

function make5ToolCallEvents(): ChatEvent[] {
  const tools = [
    { id: "tool-a", name: "Read",  startOff: 0,    endOff: 200  },
    { id: "tool-b", name: "Bash",  startOff: 300,  endOff: 600  },
    { id: "tool-c", name: "Write", startOff: 700,  endOff: 900  },
    { id: "tool-d", name: "Edit",  startOff: 1000, endOff: 1500 },
    { id: "tool-e", name: "Grep",  startOff: 1600, endOff: 2000 },
  ];

  const events: ChatEvent[] = [];

  for (const t of tools) {
    // Event carrying the tool_use block
    events.push(
      makeAssistantEvent(BASE_TS + t.startOff, [makeToolUseBlock(t.id, t.name)]),
    );
    // Event carrying the tool_result block
    events.push(
      makeAssistantEvent(BASE_TS + t.endOff, [makeToolResultBlock(t.id)]),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// DOM container lifecycle
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
}

function teardown(): void {
  if (reactRoot) {
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(teardown);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Timing strip", () => {
  test("(1) 5 tool-call events → 5 <rect> elements in the SVG", () => {
    setup();

    const events = make5ToolCallEvents();

    act(() => {
      reactRoot!.render(
        createElement(Timing, {
          events,
          invocationStartedAt: BASE_TS,
          invocationEndedAt: BASE_TS + 2000,
        }),
      );
    });

    const svg = container!.querySelector('[data-testid="timing-svg"]');
    expect(svg).not.toBeNull();

    const rects = svg!.querySelectorAll("rect");
    expect(rects.length).toBe(5);
  });

  test("(2) pixel positions for tool-d (+1000ms / 500ms) match expected x/width within 1px", () => {
    // Total range is 2000ms (tool-e ends at +2000ms).
    // SVG_WIDTH = 800 (internal coordinate space).
    // tool-d: startOffsetMs=1000ms, durationMs=500ms
    //   x     = (1000 / 2000) * 800 = 400.0
    //   width = (500  / 2000) * 800 = 200.0

    const events = make5ToolCallEvents();
    const timings = extractToolTimings(events, BASE_TS, BASE_TS + 2000);

    const toolD = timings.find((t) => t.toolUseId === "tool-d");
    expect(toolD).not.toBeUndefined();
    expect(toolD!.startOffsetMs).toBe(1000);
    expect(toolD!.durationMs).toBe(500);

    const SVG_WIDTH = 800;
    const totalMs = 2000;

    const expectedX = (toolD!.startOffsetMs / totalMs) * SVG_WIDTH;
    const expectedW = (toolD!.durationMs / totalMs) * SVG_WIDTH;

    // 400.0 and 200.0 respectively — exact, not approximate
    expect(Math.abs(expectedX - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(expectedW - 200)).toBeLessThanOrEqual(1);

    // Also verify the rendered rect attributes are correct.
    setup();

    act(() => {
      reactRoot!.render(
        createElement(Timing, {
          events,
          invocationStartedAt: BASE_TS,
          invocationEndedAt: BASE_TS + 2000,
        }),
      );
    });

    const rect = container!.querySelector('[data-testid="timing-rect-tool-d"]');
    expect(rect).not.toBeNull();

    const xAttr = parseFloat(rect!.getAttribute("x") ?? "NaN");
    const wAttr = parseFloat(rect!.getAttribute("width") ?? "NaN");

    expect(Math.abs(xAttr - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(wAttr - 200)).toBeLessThanOrEqual(1);
  });
});
