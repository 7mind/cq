/**
 * input.test.ts — Input keymap contract (E2E-D09).
 *
 * Six named cases for the new send-on-Enter contract:
 *   1. bare Enter submits
 *   2. Shift+Enter inserts newline (no submit)
 *   3. Esc blurs textarea
 *   4. Enter during isComposing does NOT submit (IME safety)
 *   5. Send button click submits
 *   6. Send button is disabled when input is empty
 *
 * Strategy:
 *   Input uses an uncontrolled textarea (ref-based value read). Tests seed
 *   the textarea value by setting ta.value directly (no React state involved,
 *   no DOM events needed to populate the value).
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
import { registerDom } from "./helpers/dom";
registerDom();

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
// Helpers
// ---------------------------------------------------------------------------

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
// isSendChord pure-function contract (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("isSendChord — pure function", () => {
  test("bare Enter returns true", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    expect(isSendChord(e)).toBe(true);
  });

  test("Shift+Enter returns false", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    expect(isSendChord(e)).toBe(false);
  });

  test("Ctrl+Enter returns false", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true });
    expect(isSendChord(e)).toBe(false);
  });

  test("Meta+Enter returns false", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter", metaKey: true });
    expect(isSendChord(e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component integration cases (E2E-D09 contract)
// ---------------------------------------------------------------------------

describe("Input — E2E-D09 keymap contract", () => {

  test("bare Enter submits", () => {
    setup();

    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "hello world";
    act(() => { ta.focus(); });
    fireKeydown(ta, { key: "Enter" });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("hello world");
  });

  test("Shift+Enter inserts newline (does NOT submit)", () => {
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
    setup();

    const ta = renderInput(() => { /* no-op */ });
    act(() => { ta.focus(); });
    expect(document.activeElement).toBe(ta);

    fireKeydown(ta, { key: "Escape" });

    expect(document.activeElement).not.toBe(ta);
  });

  test("Enter during isComposing does NOT submit (IME safety)", () => {
    setup();

    const received: string[] = [];
    const ta = renderInput((t) => received.push(t));
    ta.value = "composing text";
    act(() => { ta.focus(); });
    // Fire bare Enter but with isComposing = true (IME in progress).
    fireKeydown(ta, { key: "Enter", isComposing: true });

    expect(received).toHaveLength(0);
  });

  test("Send button click submits", () => {
    setup();

    const received: string[] = [];
    renderInput((t) => received.push(t));

    // Find the Send button.
    const btn = container!.querySelector("button[aria-label='Send message']") as HTMLButtonElement | null;
    if (!btn) throw new Error("Send button not found");

    // Seed textarea value directly (uncontrolled).
    const ta = container!.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "click submit";

    // Fire an input event so the component sees the value change and enables the button.
    act(() => { ta.dispatchEvent(new Event("input", { bubbles: true })); });

    act(() => { btn.click(); });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("click submit");
  });

  test("Send button is disabled when input is empty", () => {
    setup();

    renderInput(() => { /* no-op */ });

    const btn = container!.querySelector("button[aria-label='Send message']") as HTMLButtonElement | null;
    if (!btn) throw new Error("Send button not found");

    // On initial render the textarea is empty → button must be disabled.
    expect(btn.disabled).toBe(true);
  });

});
