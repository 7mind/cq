/**
 * thinking.test.ts — PR-33: Thinking block disclosure (G2c F-06).
 *
 * Required cases:
 *  1. Assistant message with one thinking block + one text block renders both:
 *     one <details> disclosure (collapsed by default) + one text region.
 *  2. Token count approximation: Math.ceil(length / 4).
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Stream } from "../src/chat/Stream";
import { approximateTokenCount } from "../src/chat/Cards/Thinking";
import type { ChatEvent } from "@cq/shared";

// ---------------------------------------------------------------------------
// Helpers — synthetic ChatEvent construction
// ---------------------------------------------------------------------------

let _seq = 0;

function baseFrame(sessionId = "00000000-0000-0000-0000-000000000001"): Omit<ChatEvent, "sdkEvent"> {
  return {
    type: "chat.event",
    seq: _seq++,
    ts: Date.now(),
    sessionId,
    invocationId: "00000000-0000-0000-0000-000000000002",
    parentInvocationId: null,
  };
}

/**
 * Build a final assistant ChatEvent whose message.content contains:
 *   - one thinking block (thinkingText)
 *   - one text block (textContent)
 */
function makeAssistantWithThinking(
  messageId: string,
  thinkingText: string,
  textContent: string,
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: "sess1",
      parent_tool_use_id: null,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: thinkingText, signature: "sig-abc" },
          { type: "text", text: textContent },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DOM container lifecycle
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  return container;
}

function teardown(): void {
  if (reactRoot) {
    act(() => {
      reactRoot!.unmount();
    });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => {
  teardown();
});

function renderStream(events: ChatEvent[]): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(createElement(Stream, { chatEvents: events }));
  });
  return c;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("Thinking blocks", () => {
  // -------------------------------------------------------------------------
  // Case 1: thinking + text block renders disclosure + text region
  // -------------------------------------------------------------------------
  test("assistant message with thinking + text renders one disclosure and one text region", () => {
    const thinkingText = "I should consider the user's intent carefully before answering.";
    const textContent = "Here is my response to your question.";
    const msgId = "msg-thinking-01";

    const events: ChatEvent[] = [
      makeAssistantWithThinking(msgId, thinkingText, textContent),
    ];

    const c = renderStream(events);

    // The stream message wrapper must exist.
    const wrapper = c.querySelector(`[data-testid='stream-message-${msgId}']`);
    expect(wrapper).not.toBeNull();

    // Exactly one <details> disclosure must be present (the thinking block).
    const disclosures = wrapper!.querySelectorAll("[data-testid='thinking-disclosure']");
    expect(disclosures.length).toBe(1);

    // The <details> must be collapsed by default (no `open` attribute).
    const details = disclosures[0] as HTMLDetailsElement;
    expect(details.open).toBe(false);

    // The summary must mention "Thinking" and a token count.
    const summary = wrapper!.querySelector("[data-testid='thinking-summary']");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain("Thinking");
    expect(summary!.textContent).toContain("tokens");

    // A markdown-root region for the text block must also be present.
    const markdownRoots = wrapper!.querySelectorAll("[data-testid='markdown-root']");
    // At minimum two: one inside <details> body + one for the top-level text block.
    expect(markdownRoots.length).toBeGreaterThanOrEqual(2);

    // The text content is visible somewhere in the wrapper.
    expect(wrapper!.textContent).toContain(textContent);
  });

  // -------------------------------------------------------------------------
  // Case 2: token count approximation
  // -------------------------------------------------------------------------
  test("approximateTokenCount returns Math.ceil(length / 4)", () => {
    // Empty string
    expect(approximateTokenCount("")).toBe(0);

    // Exact multiple of 4
    const s4 = "abcd"; // length 4
    expect(approximateTokenCount(s4)).toBe(1);

    // One character over a multiple — rounds up
    const s5 = "abcde"; // length 5 → ceil(5/4) = 2
    expect(approximateTokenCount(s5)).toBe(2);

    // Larger realistic string (64 chars → 16 tokens)
    const s64 = "a".repeat(64);
    expect(approximateTokenCount(s64)).toBe(16);

    // Non-multiple (100 chars → ceil(100/4) = 25)
    const s100 = "x".repeat(100);
    expect(approximateTokenCount(s100)).toBe(25);

    // The DOM summary must agree with approximateTokenCount for a known string.
    const thinkingText = "A".repeat(40); // ceil(40/4) = 10 tokens
    const msgId = "msg-token-count-01";
    const c = renderStream([
      makeAssistantWithThinking(msgId, thinkingText, "reply"),
    ]);
    const summary = c.querySelector("[data-testid='thinking-summary']");
    expect(summary!.textContent).toContain("10 tokens");
  });
});
