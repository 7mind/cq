/**
 * ledger-web UI test.
 *
 * Renders <App> under happy-dom with the in-memory FakeClient and drives the
 * DOM (clicks + controlled-input changes) to cover navigation (ledgers →
 * items → detail), status editing, milestone creation, and search.
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
const text = (): string => container.textContent ?? "";

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}
function setValue(el: Element | null, value: string): void {
  if (el === null) throw new Error("setValue: element not found");
  act(() => {
    const node = el as HTMLInputElement | HTMLSelectElement;
    node.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
    desc?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush(); // resolve connect + enumerateLedgers
}

beforeEach(() => {
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

describe("ledger-web App", () => {
  it("connects and lists ledgers", async () => {
    await mount();
    expect(testid("conn-status")?.textContent).toContain("connected");
    expect(testid("ledger-bugs")).not.toBeNull();
    expect(testid("ledger-milestones")).not.toBeNull();
  });

  it("opens a ledger and shows its items", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    expect(testid("item-D1")).not.toBeNull();
    expect(text()).toContain("warp leak");
  });

  it("opens item detail when a row is clicked", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    expect(testid("detail-id")?.textContent).toBe("D1");
    expect(testid("detail-status")?.textContent).toBe("open");
    // string field values render as markdown ("**intermittent** glitch")
    const strong = testid("detail-field-note")?.querySelector("strong");
    expect(strong?.textContent).toBe("intermittent");
  });

  it("edits an item's status and persists via the client", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    setValue(testid("status-select"), "wip");
    click(testid("status-save"));
    await flush();
    expect(testid("flash")?.textContent).toContain("D1 → wip");
    expect((await fake.fetchItem("bugs", "D1")).status).toBe("wip");
    expect(testid("detail-status")?.textContent).toBe("wip");
  });

  it("edits an item field value", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    // field-select defaults to "headline"; append to its value, then save.
    setValue(testid("field-input"), "warp leak fixed");
    click(testid("field-save"));
    await flush();
    expect((await fake.fetchItem("bugs", "D1")).fields["headline"]).toBe("warp leak fixed");
  });

  it("creates a milestone in the milestones ledger", async () => {
    await mount();
    click(testid("ledger-milestones"));
    await flush();
    click(testid("new-item-or-milestone"));
    await flush();
    setValue(testid("ms-title"), "Phase Two");
    click(testid("ms-create"));
    await flush();
    expect(testid("flash")?.textContent).toContain("created M2");
    const ms = await fake.fetchLedger("milestones");
    const titles = ms.milestones.flatMap((g) => g.items.map((i) => i.fields["title"]));
    expect(titles).toContain("Phase Two");
  });

  it("creates an item via the create form", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("new-item-or-milestone"));
    await flush(); // CreateItemForm loads milestones
    setValue(testid("ci-field-headline"), "ion drive misalignment");
    click(testid("ci-create"));
    await flush();
    const ledger = await fake.fetchLedger("bugs");
    const headlines = ledger.milestones.flatMap((g) => g.items.map((i) => i.fields["headline"]));
    expect(headlines).toContain("ion drive misalignment");
  });

  it("searches across ledgers and opens a hit into detail", async () => {
    await mount();
    setValue(testid("search-input"), "warp");
    click(testid("search-go"));
    await flush();
    expect(testid("search-results")).not.toBeNull();
    expect(testid("hit-D1")).not.toBeNull();
    click(testid("hit-D1"));
    await flush();
    expect(testid("detail-id")?.textContent).toBe("D1");
  });
});
