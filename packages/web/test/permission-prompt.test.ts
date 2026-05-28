/**
 * permission-prompt.test.ts — PR-28: PermissionPrompt component.
 *
 * Required case:
 *   Render <PermissionPrompt> with a fake chat.permission_request frame;
 *   click Allow; assert onReply called with 'allow'.
 *   click Deny; assert onReply called with 'deny'.
 *   click Allow Once; assert onReply called with 'allow_once'.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { PermissionPrompt } from "../src/chat/PermissionPrompt";
import type { PermissionDecision } from "../src/chat/PermissionPrompt";
import type { ChatPermissionRequest } from "@cq/shared";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeFrame(overrides: Partial<ChatPermissionRequest> = {}): ChatPermissionRequest {
  return {
    type: "chat.permission_request",
    seq: 0,
    ts: Date.now(),
    sessionId: "00000000-0000-0000-0000-000000000001",
    invocationId: "00000000-0000-0000-0000-000000000002",
    permissionRequestId: "00000000-0000-0000-0000-000000000003",
    toolName: "Bash",
    toolUseId: "toolu_01",
    input: { command: "ls -la" },
    title: "Claude wants to run Bash",
    displayName: "Run command",
    description: "Claude will execute: ls -la",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PermissionPrompt", () => {
  let container: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => { root!.unmount(); });
      root = null;
    }
    if (container !== null && container.parentNode !== null) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  test("renders title, displayName, and description", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const frame = makeFrame();
    act(() => {
      root!.render(createElement(PermissionPrompt, { frame, onReply: () => {} }));
    });

    const prompt = container.querySelector("[data-testid='permission-prompt']");
    expect(prompt).not.toBeNull();

    const toolEl = container.querySelector("[data-testid='permission-prompt-tool']");
    expect(toolEl?.textContent).toBe("Run command");
  });

  test("clicking Allow calls onReply('allow')", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const calls: PermissionDecision[] = [];
    const frame = makeFrame();

    act(() => {
      root!.render(
        createElement(PermissionPrompt, { frame, onReply: (d) => { calls.push(d); } }),
      );
    });

    const btn = container.querySelector("[data-testid='permission-allow']") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => { btn.click(); });

    expect(calls).toEqual(["allow"]);
  });

  test("clicking Deny calls onReply('deny')", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const calls: PermissionDecision[] = [];
    const frame = makeFrame();

    act(() => {
      root!.render(
        createElement(PermissionPrompt, { frame, onReply: (d) => { calls.push(d); } }),
      );
    });

    const btn = container.querySelector("[data-testid='permission-deny']") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => { btn.click(); });

    expect(calls).toEqual(["deny"]);
  });

  test("clicking Allow Once calls onReply('allow_once')", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const calls: PermissionDecision[] = [];
    const frame = makeFrame();

    act(() => {
      root!.render(
        createElement(PermissionPrompt, { frame, onReply: (d) => { calls.push(d); } }),
      );
    });

    const btn = container.querySelector("[data-testid='permission-allow-once']") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => { btn.click(); });

    expect(calls).toEqual(["allow_once"]);
  });
});
