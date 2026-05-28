/**
 * export.test.ts — PR-46: History Export tests.
 *
 * 3 required cases:
 *  1. toMarkdown on a fixture (1 assistant + 1 Bash tool_use+result) produces
 *     expected markdown — assert key tokens present.
 *  2. toJson round-trip: JSON.parse recovers {header, events}; events.length
 *     equals input length.
 *  3. Click "Copy as Markdown" button stubs navigator.clipboard.writeText →
 *     assert called with the expected markdown.
 */

// Must be first — registers DOM globals
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach, mock } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

import type { ChatEvent } from "@cq/shared";
import { toMarkdown, toJson } from "../src/history/exportFormats";
import type { HeaderInfo } from "../src/history/exportFormats";
import { Export } from "../src/history/Export";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_INVOCATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_SESSION_ID = "11111111-2222-3333-4444-555555555555";

const HEADER: HeaderInfo = {
  invocationId: TEST_INVOCATION_ID,
  sessionId: TEST_SESSION_ID,
  agentName: "main",
  model: "claude-sonnet-4-6",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  durationMs: 10_000,
  totalInputTokens: 100,
  totalOutputTokens: 200,
  totalCostUsd: 0.0012,
  cwd: "/home/user/project",
};

let _seq = 1000;

/**
 * Build a ChatEvent wrapping an assistant message that contains:
 *   - one text block with `text`
 *   - one tool_use block for Bash with id `toolUseId` and command `cmd`
 */
function makeAssistantEvent(toolUseId: string, text: string, cmd: string): ChatEvent {
  return {
    type: "chat.event",
    seq: _seq++,
    ts: Date.now(),
    sessionId: TEST_SESSION_ID,
    invocationId: TEST_INVOCATION_ID,
    parentInvocationId: null,
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000001",
      session_id: TEST_SESSION_ID,
      parent_tool_use_id: null,
      message: {
        id: "msg-001",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "tool_use", id: toolUseId, name: "Bash", input: { command: cmd } },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  };
}

/**
 * Build a ChatEvent wrapping a user message that contains a tool_result
 * for `toolUseId` with `output`.
 */
function makeToolResultEvent(toolUseId: string, output: string): ChatEvent {
  return {
    type: "chat.event",
    seq: _seq++,
    ts: Date.now(),
    sessionId: TEST_SESSION_ID,
    invocationId: TEST_INVOCATION_ID,
    parentInvocationId: null,
    sdkEvent: {
      type: "user",
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: TEST_SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: output,
          },
        ],
      },
    },
  };
}

const TOOL_USE_ID = "toolu_abc123";
const BASH_CMD = "ls -la /home/user/project";
const BASH_OUTPUT = "total 8\ndrwxr-xr-x 2 user user 4096 Jan 1 12:00 .";
const ASSISTANT_TEXT = "Let me list the project directory.";

const FIXTURE_EVENTS: ChatEvent[] = [
  makeAssistantEvent(TOOL_USE_ID, ASSISTANT_TEXT, BASH_CMD),
  makeToolResultEvent(TOOL_USE_ID, BASH_OUTPUT),
];

// ---------------------------------------------------------------------------
// DOM lifecycle
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

describe("Export functions", () => {
  test("(1) toMarkdown — fixture produces expected key tokens", () => {
    const md = toMarkdown(FIXTURE_EVENTS, HEADER);

    // Document header
    expect(md).toContain("# main — Invocation Transcript");
    expect(md).toContain(TEST_INVOCATION_ID);
    expect(md).toContain("claude-sonnet-4-6");

    // Assistant text section
    expect(md).toContain("## Assistant");
    expect(md).toContain(ASSISTANT_TEXT);

    // Tool section
    expect(md).toContain("### Tool: Bash");
    expect(md).toContain(BASH_CMD);

    // Tool output
    expect(md).toContain("**Output**");
    expect(md).toContain(BASH_OUTPUT);
  });

  test("(2) toJson — round-trip recovers {header, events} shape with correct events.length", () => {
    const json = toJson(FIXTURE_EVENTS, HEADER);
    const parsed = JSON.parse(json) as { header: HeaderInfo; events: ChatEvent[] };

    expect(parsed).toHaveProperty("header");
    expect(parsed).toHaveProperty("events");

    expect(parsed.header.invocationId).toBe(HEADER.invocationId);
    expect(parsed.header.sessionId).toBe(HEADER.sessionId);
    expect(parsed.header.agentName).toBe(HEADER.agentName);

    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBe(FIXTURE_EVENTS.length);
  });

  test("(3) Export component — 'Copy as Markdown' button calls navigator.clipboard.writeText", () => {
    setup();

    // Stub clipboard API
    const writtenTexts: string[] = [];
    const writeTextMock = mock(async (text: string) => {
      writtenTexts.push(text);
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    act(() => {
      reactRoot!.render(
        createElement(Export, { events: FIXTURE_EVENTS, header: HEADER }),
      );
    });

    const btn = container!.querySelector('[data-testid="export-copy-md"]');
    expect(btn).not.toBeNull();

    act(() => {
      (btn as HTMLButtonElement).click();
    });

    // Allow the async writeText promise to settle
    expect(writeTextMock).toHaveBeenCalledTimes(1);

    // The text passed should match what toMarkdown produces
    const expectedMd = toMarkdown(FIXTURE_EVENTS, HEADER);
    expect(writtenTexts[0]).toBe(expectedMd);
  });
});
