/**
 * Tests for D18 / T114: per-suggestion 'pick' buttons in BatchAnswerModal.
 *
 * BatchAnswerModal must render one 'pick' button per individual suggestion
 * entry. Clicking a pick button calls batchSave (the parent's onSave) with
 * the suggestion text directly — NOT a nonexistent answerWith. Each pick
 * button must be disabled by the same answerHasText rule that gates the
 * 'as recommended' button.
 *
 * Fixture data (FakeClient):
 *   Q1 (index 0) — open; has recommendation but no suggestions.
 *   Q2 (index 1) — open; suggestions: ["opt a", "opt b", "opt c"]; no recommendation.
 *   Q3 (index 2) — open; suggestions: ["s1", "s2"]; has recommendation.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type { HoldClock } from "../src/HoldButton";
import { HOLD_MS } from "../src/HoldButton";

class FakeClock implements HoldClock {
  private current = 0;
  private nextHandle = 1;
  private scheduled = new Map<number, { due: number; cb: () => void }>();
  now(): number { return this.current; }
  setTimeout(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { due: this.current + ms, cb });
    return handle;
  }
  clearTimeout(handle: number): void { this.scheduled.delete(handle); }
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let nextHandle: number | null = null;
      let nextDue = Infinity;
      for (const [handle, entry] of this.scheduled) {
        if (entry.due <= target && entry.due < nextDue) { nextDue = entry.due; nextHandle = handle; }
      }
      if (nextHandle === null) break;
      const entry = this.scheduled.get(nextHandle)!;
      this.scheduled.delete(nextHandle);
      this.current = entry.due;
      entry.cb();
    }
    this.current = target;
  }
}

let holdClock: FakeClock;
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

async function holdFull(el: Element | null): Promise<void> {
  if (el === null) throw new Error("holdFull: element not found");
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => { holdClock.advance(HOLD_MS); });
  await flush();
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
  holdClock = new FakeClock();
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp", holdClock }));
  });
  await flush();
}

/** Navigate batch modal to Q2 (index 1: suggestions only, no recommendation). */
async function openBatchAtQ2(): Promise<void> {
  click(testid("batch-open"));
  await flush();
  // Q1 is index 0; advance to Q2 (index 1).
  click(testid("batch-next"));
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

describe("batch modal per-suggestion pick buttons (D18 / T114)", () => {
  it("renders one pick button per suggestion entry in the batch modal", async () => {
    await mount();
    await openBatchAtQ2();

    // Q2 has 3 suggestions; all three pick buttons must be present.
    expect(testid("batch-pick-suggestion-0")).not.toBeNull();
    expect(testid("batch-pick-suggestion-1")).not.toBeNull();
    expect(testid("batch-pick-suggestion-2")).not.toBeNull();
  });

  it("clicking batch pick button for 'opt b' (index 1) calls batchSave with that text", async () => {
    await mount();
    await openBatchAtQ2();

    await holdFull(testid("batch-pick-suggestion-1"));

    // batchSave calls updateItem with ANSWERED_STATUS and the suggestion as the answer.
    const q2 = await fake.fetchItem("questions", "Q2", "full");
    expect(q2.status).toBe("answered");
    expect(q2.fields["answer"]).toBe("opt b");
  });

  it("clicking batch pick button for 'opt a' (index 0) saves the first suggestion", async () => {
    await mount();
    await openBatchAtQ2();

    await holdFull(testid("batch-pick-suggestion-0"));

    const q2 = await fake.fetchItem("questions", "Q2", "full");
    expect(q2.status).toBe("answered");
    expect(q2.fields["answer"]).toBe("opt a");
  });

  it("pick buttons are enabled initially (no text typed)", async () => {
    await mount();
    await openBatchAtQ2();

    expect((testid("batch-pick-suggestion-0") as HTMLButtonElement).disabled).toBe(false);
    expect((testid("batch-pick-suggestion-1") as HTMLButtonElement).disabled).toBe(false);
    expect((testid("batch-pick-suggestion-2") as HTMLButtonElement).disabled).toBe(false);
  });

  it("typing non-whitespace in the answer box disables all pick buttons", async () => {
    await mount();
    await openBatchAtQ2();

    fireInput(testid("batch-answer-input"), "my draft");
    await flush();

    expect((testid("batch-pick-suggestion-0") as HTMLButtonElement).disabled).toBe(true);
    expect((testid("batch-pick-suggestion-1") as HTMLButtonElement).disabled).toBe(true);
    expect((testid("batch-pick-suggestion-2") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clearing the answer box re-enables pick buttons", async () => {
    await mount();
    await openBatchAtQ2();

    fireInput(testid("batch-answer-input"), "draft");
    await flush();
    expect((testid("batch-pick-suggestion-0") as HTMLButtonElement).disabled).toBe(true);

    fireInput(testid("batch-answer-input"), "");
    await flush();
    expect((testid("batch-pick-suggestion-0") as HTMLButtonElement).disabled).toBe(false);
  });

  it("whitespace-only input does NOT disable pick buttons", async () => {
    await mount();
    await openBatchAtQ2();

    fireInput(testid("batch-answer-input"), "   ");
    await flush();

    expect((testid("batch-pick-suggestion-0") as HTMLButtonElement).disabled).toBe(false);
  });

  it("each pick button is rendered inside the suggestions list item", async () => {
    await mount();
    await openBatchAtQ2();

    const dd = testid("batch-field-suggestions");
    expect(dd).not.toBeNull();

    const lis = dd?.querySelectorAll("li");
    expect(lis?.length).toBe(3);

    // Each <li> must contain the suggestion text and a pick button.
    const suggestions = ["opt a", "opt b", "opt c"];
    for (let i = 0; i < 3; i++) {
      const li = lis?.[i];
      const btn = li?.querySelector(`[data-testid="batch-pick-suggestion-${i}"]`);
      expect(btn).not.toBeNull();
      expect(li?.textContent).toContain(suggestions[i]!);
    }
  });

  it("pick buttons also render for Q3 which has both suggestions and recommendation", async () => {
    await mount();
    // Navigate to Q3 (index 2).
    click(testid("batch-open"));
    await flush();
    click(testid("batch-next"));
    await flush();
    click(testid("batch-next"));
    await flush();

    // Q3 has 2 suggestions.
    expect(testid("batch-pick-suggestion-0")).not.toBeNull();
    expect(testid("batch-pick-suggestion-1")).not.toBeNull();
    // No third suggestion.
    expect(testid("batch-pick-suggestion-2")).toBeNull();
  });

  it("pick button saves directly to batch save path, not detail answerWith", async () => {
    await mount();
    await openBatchAtQ2();

    // Pick suggestion at index 2 ('opt c').
    await holdFull(testid("batch-pick-suggestion-2"));

    const q2 = await fake.fetchItem("questions", "Q2", "full");
    // batchSave sets status to answered (ANSWERED_STATUS) — confirms the batch save path was used.
    expect(q2.status).toBe("answered");
    expect(q2.fields["answer"]).toBe("opt c");
  });
});
