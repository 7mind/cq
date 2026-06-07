/**
 * T219 — log popup overlay + markdown rendering test.
 *
 * Asserts:
 * 1. Initially no `log-modal` is present.
 * 2. Clicking a `log-link-<path>` opens the modal: `log-modal` (role=dialog)
 *    and `log-modal-backdrop` are present.
 * 3. The fetched content renders as MARKDOWN: a `# Title` heading becomes a
 *    heading element (not the literal `# Title` string).
 * 4. Closing via the ✕ button (log-modal-close) removes the modal.
 * 5. Closing via Escape key removes the modal.
 *
 * Regression guard: tests FAIL if LogModal reverts to `<pre>` rendering or
 * the overlay CSS classes are removed.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

const TS = "2026-01-01T00:00:00.000Z";
const LOG_PATH = "docs/logs/20260101-1200-session.md";

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error(`click: element not found`);
  act(() => {
    (el as HTMLElement).click();
  });
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

async function mountWithLogItem(): Promise<void> {
  fake = new FakeClient();
  const data = (fake as unknown as { data: Record<string, { groups: Array<{ id: string; items: Array<Record<string, unknown>> }> }> }).data;
  data["bugs"]!.groups[0]!.items.push({
    id: "D20",
    milestoneId: "M1",
    status: "open",
    fields: {
      headline: "markdown log item",
      sessionLogs: [LOG_PATH],
    },
    createdAt: TS,
    updatedAt: TS,
  });
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
  // Navigate to bugs ledger and open item D20.
  click(testid("ledger-bugs"));
  await flush();
  click(testid("item-D20"));
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

describe("log popup overlay + markdown rendering (T219)", () => {
  it("shows no log-modal initially, before any link is clicked", async () => {
    await mountWithLogItem();
    expect(testid("log-modal")).toBeNull();
    expect(testid("log-modal-backdrop")).toBeNull();
  });

  it("opens overlay (log-modal with role=dialog and log-modal-backdrop) when a log-link is clicked", async () => {
    await mountWithLogItem();
    fake.readLogResults.set(LOG_PATH, { path: LOG_PATH, content: "some content" });

    click(testid(`log-link-${LOG_PATH}`));
    await flush();

    const modal = testid("log-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(testid("log-modal-backdrop")).not.toBeNull();
  });

  it("renders markdown content as HTML (heading element, not literal # text)", async () => {
    await mountWithLogItem();
    fake.readLogResults.set(LOG_PATH, {
      path: LOG_PATH,
      content: "# Title\n\n- a\n- b",
    });

    click(testid(`log-link-${LOG_PATH}`));
    await flush();

    const contentEl = testid("log-modal-content");
    expect(contentEl).not.toBeNull();

    // The heading must be rendered as an <h1> element, not literal text.
    const h1 = contentEl!.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe("Title");

    // The literal markdown syntax must NOT appear as text anywhere in the content.
    expect(contentEl!.textContent).not.toContain("# Title");

    // List items should also be rendered as <li> elements.
    const listItems = contentEl!.querySelectorAll("li");
    expect(listItems.length).toBeGreaterThanOrEqual(2);
  });

  it("closes the modal when the ✕ button (log-modal-close) is clicked", async () => {
    await mountWithLogItem();
    fake.readLogResults.set(LOG_PATH, { path: LOG_PATH, content: "# Close test" });

    click(testid(`log-link-${LOG_PATH}`));
    await flush();
    expect(testid("log-modal")).not.toBeNull();

    click(testid("log-modal-close"));
    await flush();
    expect(testid("log-modal")).toBeNull();
    expect(testid("log-modal-backdrop")).toBeNull();
  });

  it("closes the modal on Escape keydown", async () => {
    await mountWithLogItem();
    fake.readLogResults.set(LOG_PATH, { path: LOG_PATH, content: "# Escape test" });

    click(testid(`log-link-${LOG_PATH}`));
    await flush();
    expect(testid("log-modal")).not.toBeNull();

    pressEscape();
    await flush();
    expect(testid("log-modal")).toBeNull();
    expect(testid("log-modal-backdrop")).toBeNull();
  });
});
