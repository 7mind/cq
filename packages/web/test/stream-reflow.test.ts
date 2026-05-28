/**
 * stream-reflow.test.ts — Stream renderer: partial accumulation, final replace,
 * and stable code-block identity (G2c F-07).
 *
 * Three required named cases:
 *   1. monotonic text accumulation across partials — text grows monotonically.
 *   2. final message replaces partial-stitched content — canonical text wins.
 *   3. code-block stable identity across partial updates (F-07) — <pre> DOM
 *      node is the same object reference before and after appending prose.
 *
 * Architecture note — approach (B):
 *   Each assistant message is wrapped with key={messageId}. React's positional
 *   reconciliation keeps the same <Markdown> fiber (and its <CodeBlock> child)
 *   alive across re-renders of the parent Stream, so the DOM node for <pre>
 *   never gets replaced — it receives new props via reconciliation in-place.
 *
 * Test environment:
 *   happy-dom via GlobalRegistrator for DOM globals.
 *   React 19 + react-dom/client for rendering.
 *   All assertions done synchronously after act() to avoid Shiki async effects
 *   changing the <pre> to a dangerouslySetInnerHTML <div>.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Stream } from "../src/chat/Stream";
import { computeRenderedMessages } from "../src/chat/Stream";
import { UnknownCard } from "../src/chat/Cards/UnknownCard";
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

/** Build a stream_event chat.event carrying a message_start inner event. */
function makeMessageStart(messageId: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "stream_event",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: "sess1",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  };
}

/** Build a stream_event chat.event carrying a text_delta inner event. */
function makeTextDelta(text: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "stream_event",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: "sess1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text,
        },
      },
    },
  };
}

/** Build an assistant chat.event whose content contains only a tool_use block (no text). */
function makeAssistantToolUseOnly(messageId: string, toolId: string, toolName: string): ChatEvent {
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
        content: [{ type: "tool_use", id: toolId, name: toolName, input: { path: "/tmp" } }],
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    },
  };
}

/** Build an assistant chat.event (final SDKAssistantMessage). */
function makeAssistantFinal(messageId: string, text: string): ChatEvent {
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
        content: [{ type: "text", text }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
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

// ---------------------------------------------------------------------------
// Helper — SDKUserMessage with text content
// ---------------------------------------------------------------------------

function makeUserMessage(text: string, messageId?: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "user",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: "sess1",
      parent_tool_use_id: null,
      message: {
        id: messageId ?? `user-msg-${_seq}`,
        role: "user",
        content: [{ type: "text", text }],
      },
    },
  };
}

/** SDKUserMessage carrying only tool_result blocks (no text). */
function makeUserToolResult(toolUseId: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "user",
      uuid: "00000000-0000-0000-0000-000000000099",
      session_id: "sess1",
      parent_tool_use_id: null,
      message: {
        id: `user-tool-result-${_seq}`,
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
      },
    },
  };
}

describe("Stream — streaming reflow and stable identity", () => {
  test("monotonic text accumulation across partials", () => {
    /**
     * Feed 5 partial events for the same message_id, each with a single
     * additional character. After each update, assert the rendered text
     * starts with (is a prefix of or equal to) the text from the previous render.
     */
    const msgId = "msg-monotonic-01";
    const chars = ["a", "b", "c", "d", "e"];

    const events: ChatEvent[] = [makeMessageStart(msgId)];
    const c = setup();

    let prevText = "";
    for (const ch of chars) {
      events.push(makeTextDelta(ch));
      act(() => {
        reactRoot!.render(createElement(Stream, { chatEvents: [...events] }));
      });
      const root = c.querySelector("[data-testid='stream-root']");
      const renderedText = root?.textContent ?? "";
      // Each render's text must be >= the previous (prefix-or-equal).
      expect(renderedText.startsWith(prevText)).toBe(true);
      prevText = renderedText;
    }

    // The final rendered text must contain all accumulated characters.
    expect(prevText).toContain("abcde");
  });

  test("final message replaces partial-stitched content", () => {
    /**
     * Feed 3 partials then a final SDKAssistantMessage. The rendered output
     * must match the canonical final content — not just the accumulated partials.
     */
    const msgId = "msg-final-replace-01";
    const canonicalText = "Canonical assistant response.";

    // 3 partials: "Partial " + "text " + "here."
    const events: ChatEvent[] = [
      makeMessageStart(msgId),
      makeTextDelta("Partial "),
      makeTextDelta("text "),
      makeTextDelta("here."),
    ];

    // Verify partial stitching.
    const messages = computeRenderedMessages(events);
    expect(messages).toHaveLength(1);
    const partial = messages[0];
    expect(partial?.kind).toBe("assistant");
    if (partial?.kind === "assistant") {
      expect(partial.text).toBe("Partial text here.");
    }

    // Add the final message.
    events.push(makeAssistantFinal(msgId, canonicalText));
    const finalMessages = computeRenderedMessages(events);
    expect(finalMessages).toHaveLength(1);
    const final = finalMessages[0];
    expect(final?.kind).toBe("assistant");
    if (final?.kind === "assistant") {
      expect(final.text).toBe(canonicalText);
    }

    // Render and verify DOM text contains the canonical content.
    const c = renderStream(events);
    const root = c.querySelector("[data-testid='stream-root']");
    expect(root?.textContent).toContain(canonicalText.slice(0, 10));
  });

  // D24 — user messages render as user bubbles
  // D25 — empty assistant bubbles suppressed
  test("D25: assistant message with only tool_use block — no empty assistant bubble, tool card present", () => {
    const msgId = "msg-tool-only-01";
    const toolId = "tool-d25-01";
    const events: ChatEvent[] = [makeAssistantToolUseOnly(msgId, toolId, "Read")];
    const c = renderStream(events);

    // No assistant bubble should appear (it would be empty).
    const assistantBubble = c.querySelector("[data-role='assistant']");
    expect(assistantBubble).toBeNull();

    // The tool card itself must render.
    const toolCard = c.querySelector(`[data-testid='tool-use-${toolId}']`);
    expect(toolCard).not.toBeNull();
  });

  test("D24: SDKUserMessage with text renders as a user role bubble", () => {
    const events: ChatEvent[] = [makeUserMessage("what is this project")];
    const c = renderStream(events);
    const bubble = c.querySelector("[data-role='user']");
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain("what is this project");
  });

  test("D24: SDKUserMessage with only tool_result blocks does NOT render a user bubble", () => {
    const events: ChatEvent[] = [makeUserToolResult("tool-abc")];
    const c = renderStream(events);
    // No user bubble; the frame falls through to an UnknownCard (unknown role).
    const userBubble = c.querySelector("[data-role='user']");
    expect(userBubble).toBeNull();
  });

  test("code-block stable identity across partial updates (F-07)", () => {
    /**
     * Feed a partial containing a fenced code block, then a second partial
     * that appends prose AFTER the code block. Assert the <pre> DOM node
     * is the same object reference between the two renders (isSameNode).
     *
     * Approach (B): each message is keyed by messageId, so React reconciles
     * the same <Markdown> fiber in-place. The <CodeBlock> at position 0
     * within the Markdown output receives the same props (code content
     * unchanged) and keeps its DOM node. Assertions are made synchronously
     * after act() before Shiki's async effect fires (which would replace
     * <pre> with a <div dangerouslySetInnerHTML>).
     */
    const msgId = "msg-f07-01";
    const codeBlock = "```ts\nconst x = 1;\n```";

    // First render: only the code block partial.
    const events: ChatEvent[] = [
      makeMessageStart(msgId),
      makeTextDelta(codeBlock),
    ];

    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: [...events] }));
    });

    // Capture the <pre> node synchronously (before Shiki fires).
    const pre1 = c.querySelector("pre");
    expect(pre1).not.toBeNull();

    // Second render: append prose after the code block.
    events.push(makeTextDelta("\n\nSome prose after the code block."));
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: [...events] }));
    });

    // The <pre> must be the same DOM node — no remount occurred.
    const pre2 = c.querySelector("pre");
    expect(pre2).not.toBeNull();
    expect(pre1!.isSameNode(pre2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D26 — UnknownCard label rules
// ---------------------------------------------------------------------------

describe("D26 — UnknownCard label rewrite", () => {
  function renderUnknown(sdkEvent: Record<string, unknown>): HTMLDivElement {
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(UnknownCard, { sdkEvent }));
    });
    return c;
  }

  test("system event renders 'system: <subtype>'", () => {
    const c = renderUnknown({ type: "system", subtype: "init" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("system: init");
  });

  test("user event renders 'user / tool result'", () => {
    const c = renderUnknown({ type: "user" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("user / tool result");
  });

  test("result event renders 'result: <subtype>'", () => {
    const c = renderUnknown({ type: "result", subtype: "success" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("result: success");
  });

  test("rate_limit_event with status renders 'rate limit: <status>'", () => {
    const c = renderUnknown({ type: "rate_limit_event", status: "allowed" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("rate limit: allowed");
  });

  test("rate_limit_event without status renders 'rate limit'", () => {
    const c = renderUnknown({ type: "rate_limit_event" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("rate limit");
  });

  test("unknown type with underscores humanizes to spaces", () => {
    const c = renderUnknown({ type: "tool_progress" });
    const summary = c.querySelector("summary");
    expect(summary?.textContent).toBe("tool progress");
  });
});

// ---------------------------------------------------------------------------
// D26 — Stream hideSdkEvents prop
// ---------------------------------------------------------------------------

describe("D26 — Stream hideSdkEvents prop", () => {
  function makeSystemEvent(): ChatEvent {
    return {
      ...baseFrame(),
      sdkEvent: {
        type: "system",
        subtype: "init",
        uuid: "00000000-0000-0000-0000-000000000099",
        session_id: "sess1",
        parent_tool_use_id: null,
      },
    };
  }

  test("hideSdkEvents=true hides unknown SDK event cards", () => {
    const events: ChatEvent[] = [makeSystemEvent()];
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: events, hideSdkEvents: true }));
    });
    // UnknownCard wraps inside a MessageBubble with data-role='unknown'
    const unknownBubble = c.querySelector("[data-role='unknown']");
    expect(unknownBubble).toBeNull();
  });

  test("hideSdkEvents=true does NOT hide assistant messages", () => {
    const msgId = "msg-d26-assistant";
    const events: ChatEvent[] = [
      makeMessageStart(msgId),
      makeTextDelta("hello"),
      makeAssistantFinal(msgId, "hello"),
    ];
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: events, hideSdkEvents: true }));
    });
    const assistantBubble = c.querySelector("[data-role='assistant']");
    expect(assistantBubble).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D37 — replay mode empty-state
// ---------------------------------------------------------------------------

describe("D37 — Stream replay mode empty-state", () => {
  test("mode='replay' with empty events does NOT say 'Type below to start'", () => {
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: [], mode: "replay" }));
    });
    const emptyState = c.querySelector("[data-testid='stream-empty-state']");
    expect(emptyState).not.toBeNull();
    expect(emptyState!.textContent).not.toContain("Type below to start");
  });

  test("mode='live' with empty events shows 'Type below to start'", () => {
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: [], mode: "live" }));
    });
    const emptyState = c.querySelector("[data-testid='stream-empty-state']");
    expect(emptyState).not.toBeNull();
    expect(emptyState!.textContent).toContain("Type below to start");
  });

  test("mode='replay' with empty events shows neutral placeholder", () => {
    const c = setup();
    act(() => {
      reactRoot!.render(createElement(Stream, { chatEvents: [], mode: "replay" }));
    });
    const emptyState = c.querySelector("[data-testid='stream-empty-state']");
    expect(emptyState).not.toBeNull();
    expect(emptyState!.textContent).toContain("No events for this invocation");
  });
});
