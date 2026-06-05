/**
 * Tests for D19 / T115: BatchAnswerModal closes when the open-question queue
 * is drained.
 *
 * Two acceptance criteria:
 *   (1) Last-question close — a 1-question batch modal closes (batch-overlay
 *       absent) after answering via 'save & mark answered' and after 'as
 *       recommended'.
 *   (2) Recompute-open-set behavior — answering does NOT strand the modal on
 *       an already-answered row: when the remaining-open set is empty the
 *       modal closes regardless of current index; a mid-queue answer advances
 *       to the next still-open question.
 *
 * FakeClient fixture (questions ledger, all open initially):
 *   Q1 (index 0) — open; recommendation: "yes, ship it"; no suggestions.
 *   Q2 (index 1) — open; suggestions: ["opt a", "opt b", "opt c"]; no recommendation.
 *   Q3 (index 2) — open; suggestions: ["s1", "s2"]; recommendation: "do s1".
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
 * Fire onInput on an uncontrolled textarea (happy-dom safe). Required before
 * holding 'save & mark answered', which is disabled until the answer is non-empty.
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

/**
 * Pre-answer a question by updating it directly on the FakeClient so that
 * when the batch modal opens it won't include that question in the open set.
 */
async function preAnswer(id: string): Promise<void> {
  await fake.updateItem("questions", id, {
    status: "answered",
    fields: { answer: "pre-answered" },
  });
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

describe("BatchAnswerModal close on queue drain (D19 / T115)", () => {
  // ---- last-question close -------------------------------------------------

  it("closes the modal after answering the only open question via 'save & mark answered'", async () => {
    await mount();
    // Pre-answer Q2 and Q3 so only Q1 is open.
    await preAnswer("Q2");
    await preAnswer("Q3");

    // Open the batch modal — only Q1 is in the queue.
    click(testid("batch-open"));
    await flush();
    expect(testid("batch-overlay")).not.toBeNull();

    // Answer Q1 (type something first to enable the submit button).
    fireInput(testid("batch-answer-input"), "yes");
    await flush();
    await holdFull(testid("batch-answer-submit"));

    // Modal must close.
    expect(testid("batch-overlay")).toBeNull();
  });

  it("closes the modal after answering the only open question via 'as recommended'", async () => {
    await mount();
    // Pre-answer Q2 and Q3 so only Q1 is open. Q1 has recommendation: "yes, ship it".
    await preAnswer("Q2");
    await preAnswer("Q3");

    click(testid("batch-open"));
    await flush();
    expect(testid("batch-overlay")).not.toBeNull();

    // Q1 has a recommendation so the button is visible.
    await holdFull(testid("batch-answer-as-recommended"));

    expect(testid("batch-overlay")).toBeNull();
  });

  // ---- recompute-open-set: no stranding -------------------------------------

  it("closes the modal when the last question in a multi-question queue is answered", async () => {
    await mount();
    // All 3 questions are open. Answer them in order.

    click(testid("batch-open"));
    await flush();
    expect(testid("batch-overlay")).not.toBeNull();

    // Answer Q1 (index 0) — type to enable the submit button first.
    fireInput(testid("batch-answer-input"), "a1");
    await flush();
    await holdFull(testid("batch-answer-submit"));
    // Modal must still be open (Q2 and Q3 remain).
    expect(testid("batch-overlay")).not.toBeNull();

    // Answer Q2 (now at current index) — answerHasText resets on nav; type again.
    fireInput(testid("batch-answer-input"), "a2");
    await flush();
    await holdFull(testid("batch-answer-submit"));
    // Modal must still be open (Q3 remains).
    expect(testid("batch-overlay")).not.toBeNull();

    // Answer Q3 — same pattern.
    fireInput(testid("batch-answer-input"), "a3");
    await flush();
    await holdFull(testid("batch-answer-submit"));

    // All answered — modal must close.
    expect(testid("batch-overlay")).toBeNull();
  });

  it("does not strand the modal on Q1 after answering Q1 when Q2 and Q3 remain", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    // Initial question shown is Q1 (index 0).
    const progressBefore = testid("batch-progress")?.textContent ?? "";
    expect(progressBefore).toContain("1 of 3");

    // Answer Q1 — type to enable the submit button first.
    fireInput(testid("batch-answer-input"), "yes");
    await flush();
    await holdFull(testid("batch-answer-submit"));

    // Must advance — progress must NOT still show "1 of 3".
    // (The remaining set now has Q2 + Q3, still shown as 3 total but current changes.)
    // The modal is still open since there are remaining questions.
    expect(testid("batch-overlay")).not.toBeNull();
    const progressAfter = testid("batch-progress")?.textContent ?? "";
    // The current index has advanced past Q1; it should NOT still be "1 of 3".
    expect(progressAfter).not.toContain("open question 1 of 3");
  });

  it("mid-queue answer (Q2 of 3) advances to Q3, not back to Q1", async () => {
    await mount();
    click(testid("batch-open"));
    await flush();

    // Navigate to Q2 (index 1).
    click(testid("batch-next"));
    await flush();

    // Verify we are at Q2.
    expect(testid("batch-progress")?.textContent).toContain("2 of 3");

    // Answer Q2 — type to enable the submit button first.
    fireInput(testid("batch-answer-input"), "q2 answer");
    await flush();
    await holdFull(testid("batch-answer-submit"));

    // Modal must remain open (Q1 and Q3 are still unanswered).
    expect(testid("batch-overlay")).not.toBeNull();

    // The next shown question must be Q3 — the first remaining open row
    // after Q2's original position. Q3 is at original index 2 > 1, so it
    // wins over Q1 (original index 0). Progress shows "3 of 3".
    expect(testid("batch-progress")?.textContent).toContain("3 of 3");
  });

  it("closes modal via 'as recommended' on last remaining question when mid-queue", async () => {
    await mount();
    // Pre-answer Q1 and Q2 so only Q3 remains. Q3 has recommendations.
    await preAnswer("Q1");
    await preAnswer("Q2");

    click(testid("batch-open"));
    await flush();
    expect(testid("batch-overlay")).not.toBeNull();
    // Only Q3 is in the queue.
    expect(testid("batch-progress")?.textContent).toContain("1 of 1");

    await holdFull(testid("batch-answer-as-recommended"));

    expect(testid("batch-overlay")).toBeNull();
  });
});
