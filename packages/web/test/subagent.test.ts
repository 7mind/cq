/**
 * subagent.test.ts — PR-27: sub-agent nested cards + agentProgressSummaries.
 *
 * Required case:
 *   Feed: task_started → assistant message (parent_tool_use_id matches) →
 *         task_progress → tool_use (parent_tool_use_id) → tool_result →
 *         task_notification.
 *   Assert: one SubagentCard rendered; inner assistant text present; inner
 *           tool card present; status badge shows 'completed'.
 *
 * Test environment: happy-dom via GlobalRegistrator (preloaded by bunfig.toml).
 * React 19 + react-dom/client for rendering.
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

/** SDKTaskStartedMessage frame. */
function makeTaskStarted(taskId: string, toolUseId: string, description: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: "task",
      uuid: "00000000-0000-0000-0000-000000000010",
      session_id: "sess1",
    },
  };
}

/** SDKAssistantMessage frame with parent_tool_use_id set (nested sub-agent message). */
function makeNestedAssistant(
  messageId: string,
  text: string,
  parentToolUseId: string,
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000020",
      session_id: "sess1",
      parent_tool_use_id: parentToolUseId,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 10 },
      },
    },
  };
}

/** SDKAssistantMessage with tool_use block, nested under parentToolUseId. */
function makeNestedAssistantWithToolUse(
  messageId: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  parentToolUseId: string,
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000021",
      session_id: "sess1",
      parent_tool_use_id: parentToolUseId,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input: toolInput,
          },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    },
  };
}

/** SDKUserMessage with tool_result, nested under parentToolUseId. */
function makeNestedToolResult(
  toolUseId: string,
  resultText: string,
  parentToolUseId: string,
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "user",
      uuid: "00000000-0000-0000-0000-000000000030",
      session_id: "sess1",
      parent_tool_use_id: parentToolUseId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: resultText,
          },
        ],
      },
    },
  };
}

/** SDKTaskProgressMessage frame. */
function makeTaskProgress(taskId: string, summary: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      description: "In progress",
      summary,
      usage: { total_tokens: 100, tool_uses: 1, duration_ms: 5000 },
      uuid: "00000000-0000-0000-0000-000000000040",
      session_id: "sess1",
    },
  };
}

/** SDKTaskNotificationMessage frame. */
function makeTaskNotification(
  taskId: string,
  status: "completed" | "failed" | "stopped",
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status,
      output_file: "/tmp/output.txt",
      summary: "Task done",
      usage: { total_tokens: 200, tool_uses: 2, duration_ms: 10000 },
      uuid: "00000000-0000-0000-0000-000000000050",
      session_id: "sess1",
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

describe("SubagentCard — sub-agent nested cards", () => {
  test(
    "task_started → nested assistant → task_progress → nested tool_use → tool_result → task_notification renders SubagentCard with completed badge",
    () => {
      const TASK_ID = "task-abc-001";
      const TOOL_USE_ID = "toolu_subagent_001";
      const INNER_MSG_ID = "msg-inner-001";
      const INNER_TOOL_USE_ID = "toolu_read_001";
      const INNER_MSG2_ID = "msg-inner-002";

      const events: ChatEvent[] = [
        // 1. Sub-agent starts.
        makeTaskStarted(TASK_ID, TOOL_USE_ID, "Analysing authentication module"),
        // 2. Nested assistant text message.
        makeNestedAssistant(INNER_MSG_ID, "I will analyse the authentication module.", TOOL_USE_ID),
        // 3. Progress summary arrives.
        makeTaskProgress(TASK_ID, "Analysing authentication module"),
        // 4. Nested tool_use (Read tool).
        makeNestedAssistantWithToolUse(
          INNER_MSG2_ID,
          INNER_TOOL_USE_ID,
          "Read",
          { file_path: "/src/auth.ts" },
          TOOL_USE_ID,
        ),
        // 5. Nested tool_result for the Read tool_use.
        makeNestedToolResult(INNER_TOOL_USE_ID, "export function authenticate() {}", TOOL_USE_ID),
        // 6. Task completes.
        makeTaskNotification(TASK_ID, "completed"),
      ];

      // --- Pure computation assertions ---
      const rendered = computeRenderedMessages(events);

      // Exactly one top-level SubagentCard.
      expect(rendered).toHaveLength(1);
      const card = rendered[0];
      expect(card?.kind).toBe("subagent");
      if (card?.kind !== "subagent") return;

      // Status is 'completed' after task_notification.
      expect(card.task.status).toBe("completed");

      // Summary updated by task_progress.
      expect(card.task.summary).toBe("Analysing authentication module");

      // Description from task_started.
      expect(card.task.task_description).toBe("Analysing authentication module");

      // Children: one assistant text + one tool_use.
      // (The nested user message with tool_result merges into the tool_use child.)
      expect(card.children.length).toBeGreaterThanOrEqual(1);
      const assistantChild = card.children.find((c) => c.kind === "assistant");
      expect(assistantChild).not.toBeUndefined();
      if (assistantChild?.kind === "assistant") {
        expect(assistantChild.text).toContain("I will analyse");
      }

      const toolChild = card.children.find((c) => c.kind === "tool_use");
      // The tool_use child may or may not have a paired tool_result depending
      // on how the user message (tool_result) is accumulated. The user message
      // with parent_tool_use_id routes into the sub-agent entry as an unknown
      // (since it's a 'user' type, not 'assistant') — acceptable per spec.
      expect(toolChild).not.toBeUndefined();

      // --- DOM rendering assertions ---
      const c = renderStream(events);

      // SubagentCard root element present.
      const subCard = c.querySelector("[data-testid='subagent-card']");
      expect(subCard).not.toBeNull();

      // Status badge shows 'completed'.
      const badge = c.querySelector("[data-testid='subagent-status']");
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe("completed");

      // Children area is present.
      const children = c.querySelector("[data-testid='subagent-children']");
      expect(children).not.toBeNull();

      // Inner assistant text is rendered somewhere inside the card.
      expect(subCard?.textContent).toContain("I will analyse");

      // Inner tool card (ReadCard) is rendered inside the card.
      const readCard = c.querySelector("[data-testid='read-card']");
      expect(readCard).not.toBeNull();
    },
  );
});
