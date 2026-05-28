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
 * DOM: happy-dom via GlobalRegistrator (see setup.ts preload).
 * React 19 + react-dom/client + act().
 */

// Must be first — registers DOM globals (document, window, etc.)
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}
// Tell React 19 this environment supports act()
// @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
if (!globalThis.IS_REACT_ACT_ENVIRONMENT) {
  // @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

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
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    sessionId: SESSION_ID,
    startedAt: STARTED_AT,
    inProgress: false,
    onNewSession: () => undefined,
    hideSdkEvents: false,
    onHideSdkEventsChange: () => undefined,
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
    // Has sessionId + !inProgress → IDLE
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

  // D26 — hide SDK events toggle
  test("D26: hide-sdk-events toggle renders and fires callback", () => {
    let toggleValue = false;
    const c = renderHeader(
      defaultProps({
        hideSdkEvents: false,
        onHideSdkEventsChange: (v) => { toggleValue = v; },
      }),
    );

    const checkbox = c.querySelector("[data-testid='hide-sdk-events-toggle']") as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);

    // Simulate checking the checkbox.
    act(() => {
      checkbox.click();
    });
    expect(toggleValue).toBe(true);
  });
});
