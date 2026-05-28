/**
 * slash-autocomplete.test.ts — PR-34: slash-command popover autocomplete.
 *
 * Required cases:
 *  1. Typing `/` at position 0 opens the popover listing all commands.
 *  2. Typing `/cl` fuzzy-filters to commands matching "cl"; Enter inserts `/clear `.
 *  3. Esc closes the popover without altering the textarea value.
 *
 * Strategy:
 *   Render <Input slashCommands=[...] onSubmit=noop />.
 *   Simulate user typing by setting ta.value + firing an 'input' event (which
 *   triggers Input's onInput/syncPopover), then fire keydown events as needed.
 *   Assert on DOM: popover <ul> presence and textarea value.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Input } from "../src/chat/Input";
import type { SlashCommand } from "../src/chat/SlashPopover";
import { fuzzyFilter } from "../src/lib/fuzzy";

// ---------------------------------------------------------------------------
// Test fixture commands
// ---------------------------------------------------------------------------

const TEST_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show help" },
  { name: "/clear", description: "Clear the screen" },
  { name: "/cwd", description: "Show working directory" },
  { name: "/model", description: "Change model" },
  { name: "/cost", description: "Show cost" },
];

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

function renderInput(commands: SlashCommand[] = TEST_COMMANDS): HTMLTextAreaElement {
  act(() => {
    reactRoot!.render(createElement(Input, { onSubmit: () => { /* noop */ }, slashCommands: commands }));
  });
  const ta = container!.querySelector("textarea");
  if (!ta) throw new Error("textarea not found");
  return ta as HTMLTextAreaElement;
}

/**
 * Simulate the user typing text into the textarea: set .value then dispatch an
 * 'input' event so React's onInput handler runs syncPopover.
 */
function typeInto(ta: HTMLTextAreaElement, value: string): void {
  ta.value = value;
  // Place cursor at end.
  ta.setSelectionRange(value.length, value.length);
  act(() => {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fireKeydown(
  ta: HTMLTextAreaElement,
  init: KeyboardEventInit & { isComposing?: boolean },
): void {
  const { isComposing: composing, ...rest } = init;
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  if (composing !== undefined) {
    Object.defineProperty(e, "isComposing", { value: composing, configurable: true });
  }
  act(() => { ta.dispatchEvent(e); });
}

function getPopover(): Element | null {
  return container!.querySelector("ul[role='listbox']");
}

function getPopoverItemNames(): string[] {
  const ul = getPopover();
  if (!ul) return [];
  return Array.from(ul.querySelectorAll("span:first-child")).map((el) => el.textContent ?? "");
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("Input — PR-34 slash-command autocomplete", () => {

  test("Case 1: typing `/` opens popover with all commands", () => {
    setup();
    const ta = renderInput();
    act(() => { ta.focus(); });

    // Initially no popover.
    expect(getPopover()).toBeNull();

    // Type `/` at position 0.
    typeInto(ta, "/");

    // Popover should now be visible.
    const popover = getPopover();
    expect(popover).not.toBeNull();

    // All 5 commands should appear (empty query → all match).
    const names = getPopoverItemNames();
    expect(names.length).toBe(TEST_COMMANDS.length);
    for (const cmd of TEST_COMMANDS) {
      expect(names).toContain(cmd.name);
    }
  });

  test("Case 2: typing `/cl` fuzzy-filters; Enter inserts `/clear `", () => {
    setup();
    const ta = renderInput();
    act(() => { ta.focus(); });

    // Type `/cl` — should match `/clear` and `/cwd` is NOT a match for 'cl'
    // (subsequence: c→/clear has c at pos 1, l at pos 2 — yes; /cwd has c at pos 1, no 'l' → no).
    typeInto(ta, "/cl");

    const popover = getPopover();
    expect(popover).not.toBeNull();

    const names = getPopoverItemNames();
    // `/clear` must be in the list.
    expect(names).toContain("/clear");
    // `/cwd` should NOT be present (no 'l' in 'cwd').
    expect(names).not.toContain("/cwd");

    // Press Enter to confirm selection (first item = /clear).
    fireKeydown(ta, { key: "Enter" });

    // Popover must be gone.
    expect(getPopover()).toBeNull();

    // Textarea value must be `/clear ` (command + trailing space).
    expect(ta.value).toBe("/clear ");
  });

  test("Case 3: Esc closes popover; textarea value unchanged", () => {
    setup();
    const ta = renderInput();
    act(() => { ta.focus(); });

    // Open the popover by typing `/he`.
    typeInto(ta, "/he");

    expect(getPopover()).not.toBeNull();

    // Esc should close the popover.
    fireKeydown(ta, { key: "Escape" });

    expect(getPopover()).toBeNull();

    // Textarea value must remain as typed.
    expect(ta.value).toBe("/he");
  });

});

// ---------------------------------------------------------------------------
// Unit tests for fuzzyFilter
// ---------------------------------------------------------------------------

describe("fuzzyFilter — subsequence matching", () => {
  const items: SlashCommand[] = [
    { name: "/help" },
    { name: "/clear" },
    { name: "/cwd" },
    { name: "/model" },
    { name: "/cost" },
  ];

  test("empty query returns all items", () => {
    expect(fuzzyFilter("", items).length).toBe(5);
  });

  test("'cl' matches /clear but not /cwd or /help", () => {
    const result = fuzzyFilter("cl", items).map((i) => i.name);
    expect(result).toContain("/clear");
    expect(result).not.toContain("/cwd");
    expect(result).not.toContain("/help");
  });

  test("'co' matches /cost (and /model if it had 'o' after 'c' — it doesn't); exact check", () => {
    const result = fuzzyFilter("co", items).map((i) => i.name);
    expect(result).toContain("/cost");
    // /model does not have 'c' → no match
    expect(result).not.toContain("/model");
  });
});
