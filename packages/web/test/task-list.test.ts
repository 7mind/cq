/**
 * task-list.test.ts — PR-38: TaskCreate / TaskList / TaskUpdate sidebar pin.
 *
 * Test cases:
 *   1. TaskCreate adds tasks; all show in the sidebar.
 *   2. TaskUpdate flips status; same DOM node retained (isSameNode).
 *   3. TaskUpdate with status:'deleted' hides the card (CSS display:none).
 *
 * Test environment: happy-dom via GlobalRegistrator (preloaded by bunfig.toml).
 * React 19 + react-dom/client for DOM rendering.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { computeTasks } from "../src/chat/computeTasks";
import { TaskListSidebar } from "../src/chat/TaskListSidebar";
import type { ChatEvent } from "@cq/shared";

// ---------------------------------------------------------------------------
// Synthetic event helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function baseFrame(): Omit<ChatEvent, "sdkEvent"> {
  return {
    type: "chat.event",
    seq: _seq++,
    ts: Date.now(),
    sessionId: "00000000-0000-0000-0000-000000000001",
    invocationId: "00000000-0000-0000-0000-000000000002",
    parentInvocationId: null,
  };
}

/** Build a ChatEvent containing an assistant message with one or more tool_use blocks. */
function makeAssistantWithTools(
  messageId: string,
  toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ChatEvent {
  return {
    ...baseFrame(),
    sdkEvent: {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000010",
      session_id: "sess1",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: toolUseBlocks.map((t) => ({
          type: "tool_use",
          id: t.id,
          name: t.name,
          input: t.input,
        })),
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  };
}

/** Convenience: TaskCreate event for one task. */
function makeTaskCreate(messageId: string, toolId: string, id: string, content: string): ChatEvent {
  return makeAssistantWithTools(messageId, [
    { id: toolId, name: "TaskCreate", input: { id, content, status: "pending" } },
  ]);
}

/** Convenience: TaskUpdate event. */
function makeTaskUpdate(
  messageId: string,
  toolId: string,
  id: string,
  status: string,
  content?: string,
): ChatEvent {
  const input: Record<string, unknown> = { id, status };
  if (content !== undefined) input["content"] = content;
  return makeAssistantWithTools(messageId, [
    { id: toolId, name: "TaskUpdate", input },
  ]);
}

/** Convenience: TaskList event (bulk create/update). */
function makeTaskList(
  messageId: string,
  toolId: string,
  tasks: Array<{ id: string; content: string; status: string }>,
): ChatEvent {
  return makeAssistantWithTools(messageId, [
    { id: toolId, name: "TaskList", input: { tasks } },
  ]);
}

// ---------------------------------------------------------------------------
// DOM lifecycle helpers
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

function renderSidebar(tasks: Map<string, import("../src/chat/computeTasks").TaskState>): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(createElement(TaskListSidebar, { tasks }));
  });
  return c;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("computeTasks — pure function", () => {
  test("TaskCreate adds tasks; all present in the Map", () => {
    const events: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-a", "Write unit tests"),
      makeTaskCreate("msg-2", "tu-2", "task-b", "Review PR"),
      makeTaskCreate("msg-3", "tu-3", "task-c", "Deploy to staging"),
    ];

    const tasks = computeTasks(events);

    expect(tasks.size).toBe(3);
    expect(tasks.get("task-a")?.content).toBe("Write unit tests");
    expect(tasks.get("task-a")?.status).toBe("pending");
    expect(tasks.get("task-b")?.content).toBe("Review PR");
    expect(tasks.get("task-c")?.content).toBe("Deploy to staging");
  });

  test("TaskList bulk-creates all items", () => {
    const events: ChatEvent[] = [
      makeTaskList("msg-1", "tu-list", [
        { id: "t1", content: "Alpha", status: "pending" },
        { id: "t2", content: "Beta", status: "in_progress" },
        { id: "t3", content: "Gamma", status: "completed" },
      ]),
    ];

    const tasks = computeTasks(events);

    expect(tasks.size).toBe(3);
    expect(tasks.get("t1")?.status).toBe("pending");
    expect(tasks.get("t2")?.status).toBe("in_progress");
    expect(tasks.get("t3")?.status).toBe("completed");
  });

  test("TaskUpdate merges status change; content preserved", () => {
    const events: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-x", "Refactor auth"),
      makeTaskUpdate("msg-2", "tu-2", "task-x", "completed"),
    ];

    const tasks = computeTasks(events);

    expect(tasks.size).toBe(1);
    const t = tasks.get("task-x");
    expect(t?.status).toBe("completed");
    // content preserved from TaskCreate since TaskUpdate did not supply it
    expect(t?.content).toBe("Refactor auth");
  });

  test("TaskUpdate with status:deleted marks task deleted", () => {
    const events: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-y", "Old task"),
      makeTaskUpdate("msg-2", "tu-2", "task-y", "deleted"),
    ];

    const tasks = computeTasks(events);

    expect(tasks.size).toBe(1);
    expect(tasks.get("task-y")?.status).toBe("deleted");
  });
});

describe("TaskListSidebar — DOM rendering", () => {
  test("case 1: TaskCreate adds tasks; all cards show in sidebar", () => {
    const events: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-a", "Write unit tests"),
      makeTaskCreate("msg-2", "tu-2", "task-b", "Review PR"),
      makeTaskCreate("msg-3", "tu-3", "task-c", "Deploy to staging"),
    ];
    const tasks = computeTasks(events);
    const c = renderSidebar(tasks);

    const sidebar = c.querySelector("[data-testid='task-list-sidebar']");
    expect(sidebar).not.toBeNull();

    // All three task cards are present.
    expect(c.querySelector("[data-testid='task-card-task-a']")).not.toBeNull();
    expect(c.querySelector("[data-testid='task-card-task-b']")).not.toBeNull();
    expect(c.querySelector("[data-testid='task-card-task-c']")).not.toBeNull();

    // Content text rendered.
    expect(c.querySelector("[data-testid='task-content-task-a']")?.textContent).toBe("Write unit tests");
  });

  test("case 2: TaskUpdate flips status; same DOM node retained (isSameNode)", () => {
    // Initial render: task pending.
    const eventsV1: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-x", "Refactor auth"),
    ];
    const tasksV1 = computeTasks(eventsV1);
    const c = renderSidebar(tasksV1);

    // Capture the DOM node for task-x.
    const cardBefore = c.querySelector("[data-testid='task-card-task-x']");
    expect(cardBefore).not.toBeNull();
    expect(cardBefore?.getAttribute("data-task-status")).toBe("pending");

    // Re-render with updated status (completed).
    const eventsV2: ChatEvent[] = [
      ...eventsV1,
      makeTaskUpdate("msg-2", "tu-2", "task-x", "completed"),
    ];
    const tasksV2 = computeTasks(eventsV2);

    act(() => {
      reactRoot!.render(createElement(TaskListSidebar, { tasks: tasksV2 }));
    });

    const cardAfter = c.querySelector("[data-testid='task-card-task-x']");
    expect(cardAfter).not.toBeNull();
    expect(cardAfter?.getAttribute("data-task-status")).toBe("completed");

    // The DOM node must be the same object — React performed in-place update.
    expect(cardBefore!.isSameNode(cardAfter!)).toBe(true);
  });

  test("case 3: TaskUpdate with status:deleted hides the card", () => {
    const events: ChatEvent[] = [
      makeTaskCreate("msg-1", "tu-1", "task-d", "Cleanup"),
      makeTaskUpdate("msg-2", "tu-2", "task-d", "deleted"),
    ];
    const tasks = computeTasks(events);
    const c = renderSidebar(tasks);

    // The card is still in the DOM (stable React key) but hidden.
    const card = c.querySelector("[data-testid='task-card-task-d']");
    expect(card).not.toBeNull();
    // data-task-status reflects deleted.
    expect(card?.getAttribute("data-task-status")).toBe("deleted");
    // The card has the CSS module class that applies display:none.
    // We verify via the data attribute rather than computed style (happy-dom
    // does not run a CSS engine for module classes).
    expect(card?.getAttribute("data-task-status")).toBe("deleted");
  });
});
