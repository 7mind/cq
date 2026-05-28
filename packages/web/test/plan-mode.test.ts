/**
 * plan-mode.test.ts — PR-32: PlanModeCard component.
 *
 * Required cases:
 *  1. EnterPlanMode tool_use with plan content renders "Plan Mode" banner
 *     and the plan text.
 *  2. ExitPlanMode tool_use + tool_result with approval text renders
 *     banner, plan content, and "Approved" status.
 *  3. ExitPlanMode tool_result with deny text renders "Denied" status.
 *  4. ExitPlanMode with no tool_result renders "Pending" status.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { PlanModeCard } from "../src/chat/Cards/PlanModeCard";
import type { PlanModeCardProps } from "../src/chat/Cards/PlanModeCard";
import type { ToolUseBlock, ToolResultBlock } from "../src/chat/Cards/index";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEnterToolUse(plan?: string): ToolUseBlock {
  return {
    type: "tool_use",
    id: "toolu_enter_01",
    name: "EnterPlanMode",
    input: plan !== undefined ? { plan } : {},
  };
}

function makeExitToolUse(plan?: string): ToolUseBlock {
  return {
    type: "tool_use",
    id: "toolu_exit_01",
    name: "ExitPlanMode",
    input: plan !== undefined ? { plan } : {},
  };
}

function makeToolResult(content: string): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: "toolu_exit_01",
    content,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlanModeCard", () => {
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

  function render(props: PlanModeCardProps): HTMLElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(PlanModeCard, props));
    });
    return container;
  }

  // -------------------------------------------------------------------------
  // Case 1: EnterPlanMode renders plan content + "Plan Mode" banner
  // -------------------------------------------------------------------------
  test("EnterPlanMode renders Plan Mode banner and plan content", () => {
    const planText = "Step 1: read all files\nStep 2: write the solution";
    const el = render({ toolUse: makeEnterToolUse(planText) });

    const card = el.querySelector("[data-testid='plan-mode-card']");
    expect(card).not.toBeNull();

    // Banner title must say "Plan Mode" — check card's text content
    const card2 = el.querySelector("[data-testid='plan-mode-card']");
    expect(card2?.textContent).toContain("Plan Mode");

    // Badge must say "Enter"
    const badge = el.querySelector("[data-testid='plan-mode-badge']");
    expect(badge?.textContent).toBe("Enter");

    // Plan content must be present
    const content = el.querySelector("[data-testid='plan-mode-content']");
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe(planText);

    // No status row for EnterPlanMode
    const status = el.querySelector("[data-testid='plan-mode-status']");
    expect(status).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 2: ExitPlanMode + tool_result with approval text → "Approved"
  // -------------------------------------------------------------------------
  test("ExitPlanMode with approved result renders approval status", () => {
    const planText = "Final plan: implement feature X";
    const el = render({
      toolUse: makeExitToolUse(planText),
      toolResult: makeToolResult("Plan approved by user."),
    });

    const card = el.querySelector("[data-testid='plan-mode-card']");
    expect(card).not.toBeNull();

    // Badge must say "Exit"
    const badge = el.querySelector("[data-testid='plan-mode-badge']");
    expect(badge?.textContent).toBe("Exit");

    // Plan content present
    const content = el.querySelector("[data-testid='plan-mode-content']");
    expect(content?.textContent).toBe(planText);

    // Status row present with "Approved"
    const approved = el.querySelector("[data-testid='plan-mode-approved']");
    expect(approved).not.toBeNull();
    expect(approved?.textContent).toBe("Approved");

    // Denied and Pending must not appear
    expect(el.querySelector("[data-testid='plan-mode-denied']")).toBeNull();
    expect(el.querySelector("[data-testid='plan-mode-pending']")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 3: ExitPlanMode + tool_result with deny text → "Denied"
  // -------------------------------------------------------------------------
  test("ExitPlanMode with denied result renders denied status", () => {
    const el = render({
      toolUse: makeExitToolUse(),
      toolResult: makeToolResult("Plan denied."),
    });

    const denied = el.querySelector("[data-testid='plan-mode-denied']");
    expect(denied).not.toBeNull();
    expect(denied?.textContent).toBe("Denied");

    expect(el.querySelector("[data-testid='plan-mode-approved']")).toBeNull();
    expect(el.querySelector("[data-testid='plan-mode-pending']")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 4: ExitPlanMode with no tool_result → "Pending"
  // -------------------------------------------------------------------------
  test("ExitPlanMode with no tool_result renders pending status", () => {
    const el = render({ toolUse: makeExitToolUse() });

    const pending = el.querySelector("[data-testid='plan-mode-pending']");
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toBe("Pending");

    expect(el.querySelector("[data-testid='plan-mode-approved']")).toBeNull();
    expect(el.querySelector("[data-testid='plan-mode-denied']")).toBeNull();
  });
});
