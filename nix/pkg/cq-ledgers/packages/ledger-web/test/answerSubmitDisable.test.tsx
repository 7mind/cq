/**
 * Tests for D29: disable 'save & mark answered' when the trimmed answer is empty.
 *
 * Both the detail-panel HoldButton (data-testid="answer-submit") and the
 * BatchAnswerModal HoldButton (data-testid="batch-answer-submit") must be:
 * - disabled when the textarea is empty or whitespace-only
 * - enabled when the textarea contains at least one non-whitespace character
 * - re-disabled when the textarea is cleared
 * - correctly initialised from the item's stored answer field
 *
 * The answer textarea is UNCONTROLLED (ref + defaultValue). Under happy-dom,
 * onInput fires when the textarea value is set via the native property setter
 * and a synthetic input event is dispatched (same pattern as answerLock.test.tsx).
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

/**
 * Fire onInput on an uncontrolled textarea by setting its value via the native
 * property descriptor and dispatching a synthetic input event (happy-dom safe).
 */
function fireInput(el: Element | null, value: string): void {
  if (el === null) throw new Error("fireInput: element not found");
  act(() => {
    const node = el as HTMLTextAreaElement;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
    desc?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

describe("detail panel 'save & mark answered' disabled state (D29)", () => {
  it("is disabled initially when item has no stored answer", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    const btn = testid("answer-submit");
    expect(btn).not.toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("becomes enabled after typing non-whitespace", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    fireInput(testid("answer-input"), "my answer");
    await flush();

    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("remains disabled for whitespace-only input", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    fireInput(testid("answer-input"), "   ");
    await flush();

    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is re-disabled when the textarea is cleared after typing", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    fireInput(testid("answer-input"), "draft text");
    await flush();
    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(false);

    fireInput(testid("answer-input"), "");
    await flush();
    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is enabled initially when item has a stored non-empty answer", async () => {
    await mount();
    // Seed Q1 with a pre-existing answer.
    await fake.updateItem("questions", "Q1", {
      fields: { question: "Ship on Friday?", context: "release train context", recommendation: "yes, ship it", answer: "yes" },
    });

    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("is disabled on the new item after switching away from one with text", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    // Type something to enable the button on Q1.
    fireInput(testid("answer-input"), "my draft");
    await flush();
    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(false);

    // Switch to Q2 (no stored answer) — button must reset to disabled.
    click(testid("item-Q2"));
    await flush();

    expect((testid("answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch modal
// ---------------------------------------------------------------------------

describe("batch modal 'save & mark answered' disabled state (D29)", () => {
  it("is disabled initially when question has no stored answer", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    const btn = testid("batch-answer-submit");
    expect(btn).not.toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("becomes enabled after typing non-whitespace", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    fireInput(testid("batch-answer-input"), "my batch answer");
    await flush();

    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("remains disabled for whitespace-only input", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    fireInput(testid("batch-answer-input"), "  \n  ");
    await flush();

    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is re-disabled when the textarea is cleared after typing", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    fireInput(testid("batch-answer-input"), "draft");
    await flush();
    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(false);

    fireInput(testid("batch-answer-input"), "");
    await flush();
    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled on next question after navigating away from one with text", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    // Type something to enable the submit on Q1.
    fireInput(testid("batch-answer-input"), "my draft");
    await flush();
    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(false);

    // Navigate to Q2 (no stored answer) — submit must reset to disabled.
    click(testid("batch-next"));
    await flush();

    expect((testid("batch-answer-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
