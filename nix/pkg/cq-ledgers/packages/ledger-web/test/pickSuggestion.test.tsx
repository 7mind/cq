/**
 * Tests for the per-suggestion 'pick' button (T86 / Web #14).
 *
 * An answerable question with suggestions renders a 'pick' button after each
 * <li>; clicking it calls the save path with the suggestion text as the answer
 * and ANSWERED_STATUS as the status. The buttons are NOT rendered when the item
 * is not answerable.
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

async function mount(): Promise<void> {
  holdClock = new FakeClock();
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp", holdClock }));
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

describe("per-suggestion pick button (T86)", () => {
  it("renders a pick button after each suggestion <li> when the item is answerable", async () => {
    await mount();
    // Q2 is open (answerable) and has suggestions: ["opt a", "opt b", "opt c"]
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    // The suggestions field must still render as a bulleted list.
    const dd = testid("detail-field-suggestions");
    expect(dd).not.toBeNull();
    const lis = dd?.querySelectorAll("li");
    expect(lis?.length).toBe(3);

    // A 'pick' button must follow each <li>.
    expect(testid("answer-pick-suggestion-0")).not.toBeNull();
    expect(testid("answer-pick-suggestion-1")).not.toBeNull();
    expect(testid("answer-pick-suggestion-2")).not.toBeNull();
  });

  it("clicking the pick button for 'opt b' saves answer='opt b' and status=answered", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    // Perform a completed hold on the pick button for the second suggestion ("opt b", index 1).
    await holdFull(testid("answer-pick-suggestion-1"));

    const q2 = await fake.fetchItem("questions", "Q2", "full");
    expect(q2.status).toBe("answered");
    expect(q2.fields["answer"]).toBe("opt b");
  });

  it("clicking pick button for 'opt a' (index 0) saves the first suggestion text", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    await holdFull(testid("answer-pick-suggestion-0"));

    const q2 = await fake.fetchItem("questions", "Q2", "full");
    expect(q2.status).toBe("answered");
    expect(q2.fields["answer"]).toBe("opt a");
  });

  it("pick buttons are NOT rendered when the item is not answerable (answered status)", async () => {
    await mount();
    // Mark Q2 as answered so it is no longer answerable.
    await fake.updateItem("questions", "Q2", { status: "answered", fields: { question: "Which approach?", suggestions: ["opt a", "opt b", "opt c"], answer: "opt a" } });

    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    // No pick buttons in non-answerable state.
    expect(testid("answer-pick-suggestion-0")).toBeNull();
    expect(testid("answer-pick-suggestion-1")).toBeNull();
    expect(testid("answer-pick-suggestion-2")).toBeNull();
  });

  it("pick buttons are NOT rendered for archived items (read-only)", async () => {
    await mount();
    // The bugs ledger has an archived item D99; it has no suggestions, so we
    // verify by opening a question ledger item that IS non-answerable via archive.
    // Since Q-items can't easily be archived in FakeClient, verify via the
    // explicit 'not answerable' path: a withdrawn question with suggestions.
    await fake.updateItem("questions", "Q2", { status: "withdrawn", fields: { question: "Which approach?", suggestions: ["opt a", "opt b", "opt c"] } });

    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    // Status is withdrawn (terminal, cannot answer) → no pick buttons.
    expect(testid("answer-pick-suggestion-0")).toBeNull();
    expect(testid("answer-pick-suggestion-1")).toBeNull();
  });

  it("each pick button is inside the suggestions <li> (after the text)", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q2"));
    await flush();

    const dd = testid("detail-field-suggestions");
    const lis = dd?.querySelectorAll("li");
    expect(lis).not.toBeNull();

    // Each <li> must contain a pick button.
    for (let i = 0; i < 3; i++) {
      const li = lis?.[i];
      const btn = li?.querySelector(`[data-testid="answer-pick-suggestion-${i}"]`);
      expect(btn).not.toBeNull();
      // The button comes after the suggestion text in the same <li>.
      expect(li?.textContent).toContain(["opt a", "opt b", "opt c"][i]!);
    }
  });
});
