/**
 * settingsPopup.test.ts — gear-3 + codex-7 popup behaviour.
 *
 * Verifies:
 *   - Popup is reachable from the gear button.
 *   - Outside-click closes the popup.
 *   - Esc closes the popup.
 *   - Permission-mode options switch by platform (Claude / Codex).
 *   - "Changes apply to the next new chat" hint is present.
 *   - Effort values match the canonical 5-tier enum.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Header } from "../src/chat/Header";
import type { HeaderProps, PermissionMode } from "../src/chat/Header";

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

afterEach(() => { teardown(); });

function defaultProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    cwd: "/tmp",
    model: "claude-opus-4-7",
    onModelChange: () => undefined,
    permissionMode: "default" as PermissionMode,
    onPermissionModeChange: () => undefined,
    effort: "none",
    onEffortChange: () => undefined,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    sessionId: null,
    startedAt: null,
    inProgress: false,
    onNewSession: () => undefined,
    hideSdkEvents: false,
    onHideSdkEventsChange: () => undefined,
    approvalPolicy: "on-request",
    onApprovalPolicyChange: () => undefined,
    ...overrides,
  };
}

function renderHeader(props: HeaderProps): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(createElement(Header, props));
  });
  return c;
}

function openPopup(c: HTMLDivElement): void {
  const gear = c.querySelector("[data-testid='settings-gear-btn']") as HTMLButtonElement;
  act(() => { gear.click(); });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettingsPopup", () => {
  test("popup is hidden until the gear button is clicked", () => {
    const c = renderHeader(defaultProps());
    expect(c.querySelector("[data-testid='settings-popup']")).toBeNull();
    openPopup(c);
    expect(c.querySelector("[data-testid='settings-popup']")).not.toBeNull();
  });

  test("'Changes apply to the next new chat' hint is shown", () => {
    const c = renderHeader(defaultProps());
    openPopup(c);
    const hint = c.querySelector("[data-testid='settings-hint']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("next new chat");
  });

  test("Esc closes the popup", () => {
    const c = renderHeader(defaultProps());
    openPopup(c);
    expect(c.querySelector("[data-testid='settings-popup']")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(c.querySelector("[data-testid='settings-popup']")).toBeNull();
  });

  test("outside-click closes the popup (click outside the gear + popup)", () => {
    const c = renderHeader(defaultProps());
    openPopup(c);
    expect(c.querySelector("[data-testid='settings-popup']")).not.toBeNull();
    // Click on the document body (outside both gear and popup).
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(c.querySelector("[data-testid='settings-popup']")).toBeNull();
  });

  test("click on the gear button toggles open (not just opens repeatedly)", () => {
    const c = renderHeader(defaultProps());
    openPopup(c);
    expect(c.querySelector("[data-testid='settings-popup']")).not.toBeNull();
    openPopup(c); // second click
    expect(c.querySelector("[data-testid='settings-popup']")).toBeNull();
  });

  test("permission-mode options follow Claude model selection (5 values)", () => {
    const c = renderHeader(defaultProps({ model: "claude-opus-4-7" }));
    openPopup(c);
    const sel = c.querySelector("[data-testid='permission-mode-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    const optionValues = Array.from(sel.options).map((o) => o.value);
    expect(optionValues).toContain("default");
    expect(optionValues).toContain("acceptEdits");
    expect(optionValues).toContain("bypassPermissions");
    expect(optionValues).toContain("plan");
    expect(optionValues).toContain("read-only");
    // No Codex values should appear.
    expect(optionValues).not.toContain("codex-read-only");
  });

  test("permission-mode options follow Codex model selection (3 sandbox values)", () => {
    const c = renderHeader(defaultProps({ model: "gpt-5.5" }));
    openPopup(c);
    const sel = c.querySelector("[data-testid='permission-mode-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    const optionValues = Array.from(sel.options).map((o) => o.value);
    expect(optionValues).toEqual([
      "codex-read-only",
      "codex-workspace-write",
      "codex-danger-full-access",
    ]);
  });

  test("effort dropdown lists the 5 canonical tiers", () => {
    const c = renderHeader(defaultProps());
    openPopup(c);
    const sel = c.querySelector("[data-testid='effort-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    const optionValues = Array.from(sel.options).map((o) => o.value);
    expect(optionValues).toEqual(["none", "low", "medium", "high", "max"]);
  });

  test("model dropdown drives platform-routing label change", () => {
    let chosenModel = "claude-opus-4-7";
    const c = renderHeader(
      defaultProps({
        model: chosenModel,
        onModelChange: (m) => { chosenModel = m; },
      }),
    );
    openPopup(c);
    const sel = c.querySelector("[data-testid='model-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    act(() => {
      sel.value = "gpt-5.5";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chosenModel).toBe("gpt-5.5");
  });

  // -------------------------------------------------------------------------
  // gcn1-3: approvalPolicy row is platform-gated and Codex-only
  // -------------------------------------------------------------------------
  test("gcn1-3: approval-policy row is absent for Claude models", () => {
    const c = renderHeader(defaultProps({ model: "claude-opus-4-7" }));
    openPopup(c);
    expect(c.querySelector("[data-testid='approval-policy-select']")).toBeNull();
  });

  test("gcn1-3: approval-policy row is present for Codex models with the 4 SDK values", () => {
    const c = renderHeader(defaultProps({ model: "gpt-5.5" }));
    openPopup(c);
    const sel = c.querySelector("[data-testid='approval-policy-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    const optionValues = Array.from(sel.options).map((o) => o.value);
    expect(optionValues).toEqual(["never", "on-request", "on-failure", "untrusted"]);
  });

  test("gcn1-3: changing the approval-policy fires onApprovalPolicyChange with the chosen value", () => {
    let chosen: string | null = null;
    const c = renderHeader(
      defaultProps({
        model: "gpt-5.5",
        approvalPolicy: "on-request",
        onApprovalPolicyChange: (p) => { chosen = p; },
      }),
    );
    openPopup(c);
    const sel = c.querySelector("[data-testid='approval-policy-select']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("on-request");
    act(() => {
      sel.value = "untrusted";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(chosen).toBe("untrusted");
  });
});
