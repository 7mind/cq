/**
 * header.test.ts — Header component: cwd display, usage updates, new-session confirm flow.
 *
 * Four required named cases:
 *   1. Initial header shows cwd from a fake init event.
 *   2. Usage event updates token/cost counters.
 *   3. New-session click while mid-stream shows confirm; Cancel keeps session.
 *   4. Confirm closes session + clears stream.
 *
 * Strategy:
 *   Render <Header> directly with controlled props for the first two cases.
 *   Cases 3 and 4 also render <Header> directly — they toggle inProgress and
 *   fire onNewSession/cancel callbacks, asserting the dialog lifecycle.
 *
 * DOM: happy-dom via registerDom() (helpers/dom.ts) — registers at module
 * load, unregisters in afterAll (D-OUTER7-01). No bunfig/setup.ts preload.
 * React 19 + react-dom/client + act().
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Header } from "../src/chat/Header";
import type { HeaderProps, PermissionMode } from "../src/chat/Header";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "a1b2c3d4-0000-0000-0000-000000000001";
const STARTED_AT = 1_700_000_000_000;

function defaultProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    cwd: "/home/user/project",
    model: "claude-sonnet-4-6",
    onModelChange: () => undefined,
    permissionMode: "default" as PermissionMode,
    onPermissionModeChange: () => undefined,
    effort: "none",
    onEffortChange: () => undefined,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    sessionId: SESSION_ID,
    startedAt: STARTED_AT,
    inProgress: false,
    running: 0,
    onNewSession: () => undefined,
    hideSdkEvents: false,
    onHideSdkEventsChange: () => undefined,
    themeMode: "auto",
    onThemeModeChange: () => undefined,
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

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("Header — session metadata display", () => {
  test("1. initial header shows cwd from a fake init event", () => {
    /**
     * Render the Header with cwd="/home/user/project" (as would be extracted from
     * a chat.started initInfo). Assert the cwd text appears in the DOM.
     */
    const cwd = "/home/user/project";
    const c = renderHeader(defaultProps({ cwd }));

    const header = c.querySelector("[data-testid='chat-header']");
    expect(header).not.toBeNull();

    // cwd is rendered inside a <code> element
    const cwdEl = c.querySelector("code");
    expect(cwdEl).not.toBeNull();
    expect(cwdEl!.textContent).toBe(cwd);

    // Session id truncated to 8 chars
    const sessionEl = c.querySelector("[data-testid='session-id']");
    expect(sessionEl).not.toBeNull();
    expect(sessionEl!.textContent).toBe(`#${SESSION_ID.slice(0, 8)}`);

    // D44: ISO started-at was replaced with session-status badge.
    const statusEl = c.querySelector("[data-testid='session-status']");
    expect(statusEl).not.toBeNull();
    // ACTIVITY-01: has sessionId + running=0 → IDLE.
    expect(statusEl!.textContent).toBe("IDLE");
  });

  test("2. usage event updates token/cost counters", () => {
    /**
     * Render Header with zero tokens, then re-render with updated counts
     * matching a chat.usage event payload. Assert the display reflects
     * the new values.
     */
    const c = renderHeader(defaultProps({ inputTokens: 0, outputTokens: 0, costUsd: 0 }));

    // Initial state — zeros
    const usageEl = () => c.querySelector("[data-testid='usage']");
    expect(usageEl()!.textContent).toContain("↑0");
    expect(usageEl()!.textContent).toContain("↓0");
    expect(usageEl()!.textContent).toContain("$0.0000");

    // Simulate receiving a chat.usage event by re-rendering with updated props.
    act(() => {
      reactRoot!.render(
        createElement(Header, defaultProps({ inputTokens: 1234, outputTokens: 567, costUsd: 0.0321 })),
      );
    });

    expect(usageEl()!.textContent).toContain("↑1234");
    expect(usageEl()!.textContent).toContain("↓567");
    expect(usageEl()!.textContent).toContain("$0.0321");
  });

  test("3. new-session click while mid-stream shows confirm; Cancel keeps session", () => {
    /**
     * Render Header with inProgress=true. Click the "New session" button.
     * Assert the confirm dialog appears. Click Cancel. Assert the dialog
     * disappears and onNewSession was NOT called.
     */
    let newSessionCalled = false;
    const c = renderHeader(
      defaultProps({
        inProgress: true,
        onNewSession: () => {
          newSessionCalled = true;
        },
      }),
    );

    // Confirm dialog should NOT be visible initially.
    expect(c.querySelector("[role='dialog']")).toBeNull();

    // Click the "New session" button.
    const btn = c.querySelector("[data-testid='new-session-btn']") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => {
      btn.click();
    });

    // Confirm dialog should appear.
    const dialog = c.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();

    // Click Cancel.
    const cancelBtn = dialog!.querySelector("button:first-of-type") as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn.textContent).toBe("Cancel");
    act(() => {
      cancelBtn.click();
    });

    // Dialog dismissed; onNewSession NOT called.
    expect(c.querySelector("[role='dialog']")).toBeNull();
    expect(newSessionCalled).toBe(false);
  });

  test("4. Confirm closes session + clears stream", () => {
    /**
     * Render Header with inProgress=true. Click "New session", then click Confirm.
     * Assert: the dialog is dismissed AND onNewSession is called exactly once.
     * (The caller — ChatTab — handles the actual session teardown; we verify
     * the callback fires so the parent can interrupt + restart.)
     */
    let newSessionCallCount = 0;
    const c = renderHeader(
      defaultProps({
        inProgress: true,
        onNewSession: () => {
          newSessionCallCount++;
        },
      }),
    );

    // Click "New session".
    const btn = c.querySelector("[data-testid='new-session-btn']") as HTMLButtonElement;
    act(() => {
      btn.click();
    });

    // Dialog appears.
    const dialog = c.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();

    // Click Confirm (second button in the dialog).
    const buttons = dialog!.querySelectorAll("button");
    // buttons[0] = Cancel, buttons[1] = Confirm
    const confirmBtn = buttons[1] as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn.textContent).toBe("Confirm");
    act(() => {
      confirmBtn.click();
    });

    // Dialog dismissed; onNewSession called once.
    expect(c.querySelector("[role='dialog']")).toBeNull();
    expect(newSessionCallCount).toBe(1);
  });

  // gear-3: hide-sdk-events toggle now lives in SettingsPopup, not the Header.
  // We open the popup via the gear button, then assert the toggle behaviour.
  test("gear-3: hide-sdk-events toggle in SettingsPopup renders and fires callback", () => {
    let toggleValue = false;
    const c = renderHeader(
      defaultProps({
        hideSdkEvents: false,
        onHideSdkEventsChange: (v) => { toggleValue = v; },
      }),
    );

    // Toggle is hidden until the gear opens the popup.
    expect(c.querySelector("[data-testid='hide-sdk-events-toggle']")).toBeNull();

    const gear = c.querySelector("[data-testid='settings-gear-btn']") as HTMLButtonElement;
    expect(gear).not.toBeNull();
    act(() => { gear.click(); });

    const checkbox = c.querySelector("[data-testid='hide-sdk-events-toggle']") as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);

    act(() => { checkbox.click(); });
    expect(toggleValue).toBe(true);
  });

  // gear-3: model selector lives in the popup, not inline in the header.
  test("gear-3: model selector is in the popup, not the header bar", () => {
    const c = renderHeader(defaultProps());
    // No inline model select in the header.
    const header = c.querySelector("[data-testid='chat-header']");
    expect(header).not.toBeNull();
    expect(header!.querySelector("[data-testid='model-select']")).toBeNull();

    // After opening the gear, the select appears.
    const gear = c.querySelector("[data-testid='settings-gear-btn']") as HTMLButtonElement;
    act(() => { gear.click(); });
    expect(c.querySelector("[data-testid='model-select']")).not.toBeNull();
  });

  // gear-3: effort selector is reachable from the popup.
  test("gear-3: effort selector renders and fires callback", () => {
    let effortValue: string = "";
    const c = renderHeader(
      defaultProps({
        effort: "none",
        onEffortChange: (e) => { effortValue = e; },
      }),
    );
    const gear = c.querySelector("[data-testid='settings-gear-btn']") as HTMLButtonElement;
    act(() => { gear.click(); });
    const effortSel = c.querySelector("[data-testid='effort-select']") as HTMLSelectElement;
    expect(effortSel).not.toBeNull();
    expect(effortSel.value).toBe("none");
    act(() => {
      effortSel.value = "high";
      effortSel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(effortValue).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// ACTIVITY-01: the status badge reflects the AGGREGATE `running` count
// (chat + /plan workflow phases), not just the chat-only inProgress flag.
// ---------------------------------------------------------------------------

describe("Header — aggregate activity badge (ACTIVITY-01)", () => {
  function badgeText(c: HTMLDivElement): string | null {
    return c.querySelector("[data-testid='session-status']")?.textContent ?? null;
  }
  function badgeTitle(c: HTMLDivElement): string {
    return (c.querySelector("[data-testid='session-status']") as HTMLElement | null)?.getAttribute("title") ?? "";
  }

  test("no chat session and running=0 → NEW", () => {
    const c = renderHeader(defaultProps({ sessionId: null, running: 0, inProgress: false }));
    expect(badgeText(c)).toBe("NEW");
  });

  test("chat session present and running=0 → IDLE", () => {
    const c = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 0, inProgress: false }));
    expect(badgeText(c)).toBe("IDLE");
  });

  test("running=1 → BUSY (1)", () => {
    const c = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 1 }));
    expect(badgeText(c)).toBe("BUSY (1)");
  });

  test("running=2 → BUSY (2)", () => {
    const c = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 2 }));
    expect(badgeText(c)).toBe("BUSY (2)");
  });

  test("running>0 shows BUSY even with no chat session yet (workflow-only)", () => {
    // A /plan workflow phase dispatching before any chat session exists still
    // shows BUSY — the badge reflects ALL compute, not just chat.
    const c = renderHeader(defaultProps({ sessionId: null, running: 1, inProgress: false }));
    expect(badgeText(c)).toBe("BUSY (1)");
  });

  test("badge does NOT flip to IDLE while a workflow phase runs and chat is idle", () => {
    // inProgress (chat-only) is false, but running=1 (a workflow phase) → BUSY.
    const c = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 1, inProgress: false }));
    expect(badgeText(c)).toBe("BUSY (1)");
  });

  test("badge title encodes the busy/idle/new state for the className branch", () => {
    // CSS-module class names do not resolve in the test DOM, so assert the
    // title attribute — which the same `badgeState` drives — instead. busy and
    // idle resolve to distinct, lowercase state titles.
    const busy = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 2 }));
    expect(badgeTitle(busy)).toBe("Session status: busy");
    teardown();
    const idle = renderHeader(defaultProps({ sessionId: SESSION_ID, running: 0 }));
    expect(badgeTitle(idle)).toBe("Session status: idle");
    teardown();
    const fresh = renderHeader(defaultProps({ sessionId: null, running: 0 }));
    expect(badgeTitle(fresh)).toBe("Session status: new");
  });
});
