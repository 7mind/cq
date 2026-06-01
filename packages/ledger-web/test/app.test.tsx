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
import { App, clampPanelSize } from "../src/App";
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

  it("edits status + a field through the edit form and persists", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    // view mode → click Edit → form appears
    click(testid("edit"));
    await flush();
    expect(testid("edit-form")).not.toBeNull();
    setValue(testid("edit-status"), "wip");
    setValue(testid("edit-field-headline"), "warp leak fixed");
    click(testid("save"));
    await flush();
    const item = await fake.fetchItem("bugs", "D1");
    expect(item.status).toBe("wip");
    expect(item.fields["headline"]).toBe("warp leak fixed");
    // back in view mode, reflecting the saved values
    expect(testid("edit-form")).toBeNull();
    expect(testid("detail-status")?.textContent).toBe("wip");
  });

  it("cancels an edit without saving", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    click(testid("edit"));
    await flush();
    setValue(testid("edit-field-headline"), "should not stick");
    click(testid("cancel-edit"));
    await flush();
    expect(testid("edit-form")).toBeNull();
    expect((await fake.fetchItem("bugs", "D1")).fields["headline"]).toBe("warp leak");
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

  it("toggles the detail-panel orientation and persists it to localStorage", async () => {
    localStorage.removeItem("ledger-web.panel");
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1")); // selecting an item shows the panel + splitter
    await flush();
    expect(q(".lw-workarea-right")).not.toBeNull();
    expect(testid("splitter")).not.toBeNull();
    click(testid("panel-orientation"));
    await flush();
    expect(q(".lw-workarea-bottom")).not.toBeNull();
    const saved = JSON.parse(localStorage.getItem("ledger-web.panel") ?? "{}") as { orientation?: string };
    expect(saved.orientation).toBe("bottom");
  });
});

describe("clampPanelSize", () => {
  it("clamps to the [min, max] band", () => {
    expect(clampPanelSize(50, 800)).toBe(180); // below min
    expect(clampPanelSize(400, 800)).toBe(400); // within band
    expect(clampPanelSize(900, 800)).toBe(800); // above max
    expect(clampPanelSize(900, 50)).toBe(180); // max below min → min wins
  });
});

// Minimal fake WebSocket the test drives.
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("ledger-web live updates", () => {
  it("shows the live indicator and refetches on a pushed change", async () => {
    FakeWS.instances = [];
    fake = new FakeClient();
    await act(async () => {
      root.render(
        createElement(App, {
          connect: async () => fake,
          initialUrl: "http://x/mcp",
          liveUrl: "ws://x/ws",
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();
    // a live socket was created; open it → indicator goes live
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(1);
    const ws = FakeWS.instances[0]!;
    act(() => ws.open());
    await flush();
    expect(testid("live-status")?.getAttribute("data-state")).toBe("alive");

    // open the bugs ledger
    click(testid("ledger-bugs"));
    await flush();
    expect(testid("item-D2")).toBeNull(); // not there yet

    // an external writer adds an item, then the server pushes `changed`
    await fake.createItem("bugs", "M1", { status: "open", fields: { headline: "pushed in" } });
    act(() => ws.push({ type: "changed", ledger: "bugs" }));
    await flush();
    // the table refetched and now shows the new item
    expect(text()).toContain("pushed in");
  });
});
