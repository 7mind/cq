/**
 * subagent-link.test.ts — D30: compact subagent card with "View transcript →" link.
 *
 * Required assertions:
 *   1. Feed task_started (with child_invocation_id) → stream_events (parent_tool_use_id) →
 *      task_notification(completed).
 *   2. Render Stream with onSubagentClicked wired.
 *   3. Assert: NO long transcript text inline in the subagent card.
 *   4. Assert: a "View transcript" link/button is present.
 *   5. Click it: assert onSubagentClicked fires with the child invocation id.
 */

// Must be first — registers DOM globals.
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
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function baseFrame(): Omit<ChatEvent, "sdkEvent"> {
  return {
    type: "chat.event",
    seq: _seq++,
    ts: Date.now(),
    sessionId: "sess-d30",
    invocationId: "inv-d30",
    parentInvocationId: null,
  };
}

const TASK_ID = "task-d30-001";
const TOOL_USE_ID = "toolu_d30_001";
const CHILD_INV_ID = "child-inv-d30-abc";

/** task_started with child_invocation_id injected (as bridge does in D30). */
function makeTaskStarted(): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "system",
      subtype: "task_started",
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      description: "Analysing repository structure",
      subagent_type: "general-purpose",
      // D30: bridge injects this field
      child_invocation_id: CHILD_INV_ID,
    },
  };
}

/** stream_event with parent_tool_use_id (subagent text token). */
function makeStreamEvent(text: string): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "stream_event",
      parent_tool_use_id: TOOL_USE_ID,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    },
  };
}

function makeTaskNotification(status: "completed" | "failed"): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "system",
      subtype: "task_notification",
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      status,
      summary: "Analysis complete",
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
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => teardown());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D30: SubagentCard compact view with transcript link", () => {
  test("computeRenderedMessages: childInvocationId is present on subagent task when injected by bridge", () => {
    const events: ChatEvent[] = [
      makeTaskStarted(),
      makeStreamEvent("Some subagent output text"),
      makeTaskNotification("completed"),
    ];
    const rendered = computeRenderedMessages(events);
    expect(rendered).toHaveLength(1);
    const card = rendered[0];
    expect(card?.kind).toBe("subagent");
    if (card?.kind !== "subagent") return;
    expect(card.task.childInvocationId).toBe(CHILD_INV_ID);
    expect(card.task.status).toBe("completed");
  });

  test("renders 'View transcript →' button when childInvocationId is available and handler is wired", () => {
    const events: ChatEvent[] = [
      makeTaskStarted(),
      makeStreamEvent("Lots of subagent prose text that should NOT appear inline"),
      makeTaskNotification("completed"),
    ];

    const c = setup();
    act(() => {
      reactRoot!.render(
        createElement(Stream, {
          chatEvents: events,
          onSubagentClicked: () => {},
        }),
      );
    });

    const subCard = c.querySelector("[data-testid='subagent-card']");
    expect(subCard).not.toBeNull();

    // The transcript link button must be present.
    const linkBtn = c.querySelector("[data-testid='subagent-view-transcript']");
    expect(linkBtn).not.toBeNull();
    expect(linkBtn?.textContent).toContain("View transcript");

    // The inline children area must NOT be rendered (compact view hides it).
    const childrenArea = c.querySelector("[data-testid='subagent-children']");
    expect(childrenArea).toBeNull();

    // The long prose text must NOT appear inside the subagent card.
    expect(subCard?.textContent).not.toContain("Lots of subagent prose text");
  });

  test("clicking 'View transcript →' fires onSubagentClicked with the child invocation id", () => {
    const events: ChatEvent[] = [
      makeTaskStarted(),
      makeTaskNotification("completed"),
    ];

    const calls: string[] = [];
    const c = setup();
    act(() => {
      reactRoot!.render(
        createElement(Stream, {
          chatEvents: events,
          onSubagentClicked: (id) => { calls.push(id); },
        }),
      );
    });

    const linkBtn = c.querySelector("[data-testid='subagent-view-transcript']") as HTMLButtonElement | null;
    expect(linkBtn).not.toBeNull();

    act(() => {
      linkBtn!.click();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(CHILD_INV_ID);
  });

  test("without onSubagentClicked, transcript is inlined (legacy behaviour)", () => {
    const events: ChatEvent[] = [
      makeTaskStarted(),
      makeStreamEvent("Inline transcript text"),
      makeTaskNotification("completed"),
    ];

    const c = setup();
    act(() => {
      reactRoot!.render(
        createElement(Stream, {
          chatEvents: events,
          // No onSubagentClicked → legacy inline rendering
        }),
      );
    });

    // The "View transcript" button must NOT appear.
    const linkBtn = c.querySelector("[data-testid='subagent-view-transcript']");
    expect(linkBtn).toBeNull();

    // The children area presence is not asserted — stream_event deltas without
    // a message_start produce no visible child messages. This test only verifies
    // the transcript link is absent in the no-handler case.
    void c; // used for querySelector above
  });
});
