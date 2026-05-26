/**
 * input.test.ts — F-16 cross-platform send chord + IME passthrough.
 *
 * Six named cases per the PR-21 brief:
 *   1. Ctrl+Enter on Linux/Windows submits
 *   2. Cmd+Enter on macOS submits
 *   3. Cmd+Enter on Linux does NOT submit (and Ctrl+Enter on macOS does NOT)
 *   4. Shift+Enter inserts newline (no submit)
 *   5. Esc blurs the textarea
 *   6. Enter during isComposing does NOT submit
 *
 * Strategy:
 *   Input uses an uncontrolled textarea (ref-based value read). Tests seed
 *   the textarea value by setting ta.value directly (no React state involved,
 *   no DOM events needed to populate the value).
 *
 *   Platform is controlled by stubbing navigator.platform via Object.defineProperty.
 *   isSendChord is tested directly (pure function) for belt-and-suspenders
 *   platform-gate assertions.
 *
 * Known happy-dom + React 19 friction:
 *   Dispatching a keydown event on a textarea WITHOUT first focusing it causes
 *   React's input-event polyfill (getTargetInstForInputEventPolyfill) to call
 *   getInstIfValueChanged(activeElementInst$1) where activeElementInst$1 is null,
 *   crashing with "null is not an object (evaluating 'inst.tag')". The polyfill
 *   runs because happy-dom reports isInputEventSupported=false. Focusing the
 *   textarea before dispatching keydown sets activeElementInst$1 to the correct
 *   fiber and prevents the crash. All tests therefore call ta.focus() first.
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

import { Input, isSendChord } from "../src/chat/Input";

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
  if (container && container.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => { teardown(); });

// ---------------------------------------------------------------------------
// navigator.platform stub helpers
// ---------------------------------------------------------------------------

/** Stub navigator.platform for the duration of a single test. */
function stubPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", {
    value,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal object that satisfies the KeyboardEvent duck-type used by
 * isSendChord(). Only used for pure-function assertions.
 */
function fakeKey(init: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as unknown as KeyboardEvent;
}

/**
 * Render <Input onSubmit={spy} /> and return the textarea element.
 * The textarea is uncontrolled; callers can set ta.value directly to seed text.
 */
function renderInput(spy: (text: string) => void): HTMLTextAreaElement {
  act(() => {
    reactRoot!.render(createElement(Input, { onSubmit: spy }));
  });
  const ta = container!.querySelector("textarea");
  if (!ta) throw new Error("textarea not found after render");
  return ta as HTMLTextAreaElement;
}

/**
 * Fire a keydown event on the textarea.
 *
 * IMPORTANT: must be called after ta.focus() to prevent a React 19 + happy-dom
 * crash in getInstIfValueChanged (see file header comment). Returns the event.
 */
function fireKeydown(
  ta: HTMLTextAreaElement,
  init: KeyboardEventInit & { isComposing?: boolean },
): KeyboardEvent {
  const { isComposing: composing, ...rest } = init;
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  if (composing !== undefined) {
    // happy-dom may not propagate isComposing from the init dict; force it.
    Object.defineProperty(e, "isComposing", { value: composing, configurable: true });
  }
  act(() => { ta.dispatchEvent(e); });
  return e;
}

// ---------------------------------------------------------------------------
// F-16 test cases
// ---------------------------------------------------------------------------

describe("Input — F-16 cross-platform send chord + IME passthrough", () => {

  test("Ctrl+Enter on Linux/Windows submits", () => {
    stubPlatform("Linux x86_64");
    setup();

    // Verify isSendChord pure logic: Ctrl+Enter → true on non-mac.
    expect(isSendChord(fakeKey({ key: "Enter", ctrlKey: true }))).toBe(true);
    expect(isSendChord(fakeKey({ key: "Enter", metaKey: true }))).toBe(false);

    // Full component: set textarea value directly (uncontrolled), fire Ctrl+Enter.
    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "hello linux";
    act(() => { ta.focus(); });
    fireKeydown(ta, { key: "Enter", ctrlKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("hello linux");
  });

  test("Cmd+Enter on macOS submits", () => {
    stubPlatform("MacIntel");
    setup();

    expect(isSendChord(fakeKey({ key: "Enter", metaKey: true }))).toBe(true);
    expect(isSendChord(fakeKey({ key: "Enter", ctrlKey: true }))).toBe(false);

    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "hello mac";
    act(() => { ta.focus(); });
    fireKeydown(ta, { key: "Enter", metaKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("hello mac");
  });

  test("Cmd+Enter on Linux does NOT submit; Ctrl+Enter on macOS does NOT submit", () => {
    // Half 1: platform = Linux → metaKey chord must not match.
    stubPlatform("Linux x86_64");
    expect(isSendChord(fakeKey({ key: "Enter", metaKey: true }))).toBe(false);

    setup();
    const received1: string[] = [];
    const ta1 = renderInput((t) => received1.push(t));
    ta1.value = "linux meta";
    act(() => { ta1.focus(); });
    fireKeydown(ta1, { key: "Enter", metaKey: true });
    expect(received1).toHaveLength(0);
    teardown();

    // Half 2: platform = macOS → ctrlKey chord must not match.
    stubPlatform("MacIntel");
    expect(isSendChord(fakeKey({ key: "Enter", ctrlKey: true }))).toBe(false);

    setup();
    const received2: string[] = [];
    const ta2 = renderInput((t) => received2.push(t));
    ta2.value = "mac ctrl";
    act(() => { ta2.focus(); });
    fireKeydown(ta2, { key: "Enter", ctrlKey: true });
    expect(received2).toHaveLength(0);
  });

  test("Shift+Enter inserts newline (does NOT submit)", () => {
    stubPlatform("Linux x86_64");
    setup();

    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "line one";
    act(() => { ta.focus(); });
    const e = fireKeydown(ta, { key: "Enter", shiftKey: true });

    // onSubmit must not have been called.
    expect(received).toHaveLength(0);
    // The event must NOT have been prevented (browser inserts \n naturally).
    expect(e.defaultPrevented).toBe(false);
  });

  test("Esc blurs the textarea", () => {
    stubPlatform("Linux x86_64");
    setup();

    const ta = renderInput(() => { /* no-op */ });
    act(() => { ta.focus(); });
    expect(document.activeElement).toBe(ta);

    fireKeydown(ta, { key: "Escape" });

    expect(document.activeElement).not.toBe(ta);
  });

  test("Enter during isComposing does NOT submit (IME passthrough)", () => {
    stubPlatform("Linux x86_64");
    setup();

    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "composing text";
    act(() => { ta.focus(); });
    // Fire the send chord (Ctrl+Enter on Linux) but with isComposing = true.
    fireKeydown(ta, { key: "Enter", ctrlKey: true, isComposing: true });

    expect(received).toHaveLength(0);
  });

});
