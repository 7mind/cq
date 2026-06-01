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
/** Dispatch a document-level keydown (drives the global keyboard nav). */
function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
/** Dispatch a keydown on a specific element (drives element-level onKeyDown). */
function pressOn(el: Element | null, key: string): void {
  if (el === null) throw new Error("pressOn: element not found");
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
  // Isolate persisted UI state (panel layout + restored view) across tests.
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

describe("ledger-web App", () => {
  it("connects and lists ledgers", async () => {
    await mount();
    expect(testid("conn-status")?.textContent).toContain("connected");
    expect(testid("ledger-bugs")).not.toBeNull();
    expect(testid("ledger-milestones")).not.toBeNull();
  });

  it("shows each ledger's item count in the sidebar", async () => {
    await mount();
    // FakeClient: bugs/plain/milestones each hold 1 item.
    expect(testid("ledger-count-bugs")?.textContent).toBe("1");
    expect(testid("ledger-count-milestones")?.textContent).toBe("1");
    expect(testid("ledger-count-plain")?.textContent).toBe("1");
  });

  it("persists the current view (ledger + item) to localStorage as you navigate", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    const saved = JSON.parse(localStorage.getItem("ledger-web.view") ?? "{}") as {
      ledger?: string;
      itemId?: string;
      mainView?: string;
    };
    expect(saved.ledger).toBe("bugs");
    expect(saved.itemId).toBe("D1");
    expect(saved.mainView).toBe("ledger");
  });

  it("restores the saved ledger + item on load (reload persistence)", async () => {
    localStorage.setItem(
      "ledger-web.view",
      JSON.stringify({ ledger: "bugs", itemId: "D1", mainView: "ledger" }),
    );
    await mount();
    await flush();
    // The restored ledger's items render and the saved item is selected.
    expect(testid("item-D1")).not.toBeNull();
    expect(testid("detail-id")?.textContent).toBe("D1");
  });

  it("restores graph mode on load", async () => {
    localStorage.setItem(
      "ledger-web.view",
      JSON.stringify({ ledger: "bugs", itemId: null, mainView: "dag" }),
    );
    await mount();
    await flush();
    expect(testid("toggle-dag")?.className).toContain("lw-toggle-active");
  });

  it("opens a ledger and shows its items", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    expect(testid("item-D1")).not.toBeNull();
    expect(text()).toContain("warp leak");
  });

  it("colorizes the status badge and filters items by status type", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    // D1 is "open" → non-terminal "start" bucket badge.
    expect(testid("status-D1")?.className).toContain("lw-status-start");

    // Filter to terminal: D1 (open) drops out, table shows the empty state.
    setValue(testid("status-filter"), "terminal");
    await flush();
    expect(testid("item-D1")).toBeNull();
    expect(text()).toContain("(no items)");

    // Filter to active: D1 returns.
    setValue(testid("status-filter"), "active");
    await flush();
    expect(testid("item-D1")).not.toBeNull();
  });

  it("answers a question and resolves it in one action", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();
    expect(testid("answer-box")).not.toBeNull();
    setValue(testid("answer-input"), "ship it");
    click(testid("answer-submit"));
    await flush();
    const q = await fake.fetchItem("questions", "Q1");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("ship it");
  });

  it("answers a question 'as recommended' with one click", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();
    click(testid("answer-as-recommended"));
    await flush();
    const q = await fake.fetchItem("questions", "Q1");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("as recommended");
  });

  it("renders a question with a highlighted recommendation and fixed field order", async () => {
    await mount();
    click(testid("ledger-questions"));
    await flush();
    click(testid("item-Q1"));
    await flush();

    // The recommendation is rendered in a highlighted block.
    const rec = testid("recommendation");
    expect(rec).not.toBeNull();
    expect(rec?.classList.contains("lw-recommendation")).toBe(true);

    // DOM order: question → context → recommendation → answer (the editable box,
    // since Q1 is open/answerable).
    const question = testid("detail-field-question");
    const context = testid("detail-field-context");
    const recommendation = testid("detail-field-recommendation");
    const answer = testid("answer-box");
    for (const el of [question, context, recommendation, answer]) expect(el).not.toBeNull();
    const follows = (a: HTMLElement | null, b: HTMLElement | null): boolean =>
      (a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(question, context)).toBe(true);
    expect(follows(context, recommendation)).toBe(true);
    expect(follows(recommendation, answer)).toBe(true);
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
    // a human edit stamps author="user", surfaced in the provenance line
    expect(item.author).toBe("user");
    expect(testid("detail-provenance")?.textContent).toContain("user");
  });

  it("renders guard-aligned quick-transition buttons and applies one on click", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1")); // D1 is "open" → transitions[open] = [wip, closed]
    await flush();
    // One button per legal target; the illegal self-status "open" is absent.
    expect(testid("transitions")).not.toBeNull();
    expect(testid("transition-wip")).not.toBeNull();
    expect(testid("transition-closed")).not.toBeNull();
    expect(testid("transition-open")).toBeNull();
    // Click "wip": issues the update with the target status, preserving fields.
    click(testid("transition-wip"));
    await flush();
    const item = await fake.fetchItem("bugs", "D1");
    expect(item.status).toBe("wip");
    expect(item.fields["headline"]).toBe("warp leak"); // unchanged
    expect(item.author).toBe("user"); // stamped via the existing update path
    expect(testid("detail-status")?.textContent).toBe("wip");
  });

  it("shows no quick-transition buttons from a terminal status ([])", async () => {
    await mount();
    // Move D1 to the terminal status first.
    await fake.updateItem("bugs", "D1", { status: "closed" });
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    expect(testid("detail-status")?.textContent).toBe("closed");
    expect(testid("transitions")).toBeNull(); // transitions[closed] = [] → none
  });

  it("shows no quick-transition buttons for a ledger without a map", async () => {
    await mount();
    click(testid("ledger-plain"));
    await flush();
    click(testid("item-P1"));
    await flush();
    expect(testid("detail-status")?.textContent).toBe("open");
    expect(testid("transitions")).toBeNull(); // no map → existing editor only
    expect(testid("edit")).not.toBeNull(); // the existing status editor is intact
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

  it("creates an item through the shared editor (new item reuses the edit panel)", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("new-item-or-milestone"));
    await flush(); // editor opens in create mode + loads milestones
    // It is the same editor as edit mode: same form + a milestone picker.
    expect(testid("edit-form")).not.toBeNull();
    expect(testid("edit-milestone")).not.toBeNull();
    expect(testid("detail-id")?.textContent).toBe("new item");
    setValue(testid("edit-field-headline"), "ion drive misalignment");
    click(testid("save"));
    await flush();
    const ledger = await fake.fetchLedger("bugs");
    const headlines = ledger.milestones.flatMap((g) => g.items.map((i) => i.fields["headline"]));
    expect(headlines).toContain("ion drive misalignment");
  });

  it("searches across ledgers as you type and opens a hit into detail", async () => {
    await mount();
    // As-you-type: typing into the box debounces, then runs the search — no
    // button. Wait past the debounce window.
    setValue(testid("search-input"), "warp");
    await act(async () => {
      await sleep(260);
    });
    expect(testid("search-results")).not.toBeNull();
    expect(testid("hit-D1")).not.toBeNull();
    click(testid("hit-D1"));
    await flush();
    expect(testid("detail-id")?.textContent).toBe("D1");
  });

  it("clears search results when the box is emptied", async () => {
    // The query language itself (status:/ledger:/OR/…) is exercised server-side
    // in the library tests; here we only assert the as-you-type UX: a match
    // shows results, and clearing the input leaves search mode.
    await mount();
    setValue(testid("search-input"), "warp");
    await act(async () => {
      await sleep(260);
    });
    expect(testid("search-results")).not.toBeNull();
    setValue(testid("search-input"), "");
    await act(async () => {
      await sleep(260);
    });
    expect(testid("search-results")).toBeNull();
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

  it("hides the MCP URL/connect behind a gear popup", async () => {
    await mount();
    expect(testid("mcp-url")).toBeNull(); // not shown until the gear is opened
    click(testid("settings-toggle"));
    await flush();
    expect(testid("mcp-url")).not.toBeNull();
    expect(testid("connect")).not.toBeNull();
    click(testid("settings-toggle"));
    await flush();
    expect(testid("mcp-url")).toBeNull(); // toggles closed
  });

  it("in edit mode shows save/cancel in the header and hides close", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1"));
    await flush();
    expect(testid("detail-close")).not.toBeNull(); // view mode: close present
    click(testid("edit"));
    await flush();
    expect(testid("save")).not.toBeNull();
    expect(testid("cancel-edit")).not.toBeNull();
    expect(testid("detail-close")).toBeNull(); // close hidden while editing
    expect(testid("edit")).toBeNull();
  });
});

describe("ledger-web keyboard navigation", () => {
  it("opens a ledger from the sidebar with arrows + Enter", async () => {
    await mount();
    // sidebar focused, cursor on the first ledger (bugs, sorted first)
    expect(testid("ledger-bugs")?.className).toContain("lw-ledger-cursor");
    press("ArrowDown"); // → milestones
    await flush();
    expect(testid("ledger-milestones")?.className).toContain("lw-ledger-cursor");
    press("ArrowUp"); // back → bugs
    await flush();
    press("Enter"); // open bugs
    await flush();
    expect(testid("item-D1")).not.toBeNull();
  });

  it("moves through items into the detail panel and Esc closes it", async () => {
    await mount();
    press("Enter"); // open bugs → main zone
    await flush();
    expect(testid("detail")).toBeNull(); // nothing selected yet
    press("ArrowDown"); // select first row (D1) → live preview
    await flush();
    expect(testid("detail-id")?.textContent).toBe("D1");
    press("Escape"); // close detail
    await flush();
    expect(testid("detail")).toBeNull();
  });

  it("'/' focuses the search box", async () => {
    await mount();
    press("/");
    await flush();
    expect(document.activeElement).toBe(testid("search-input"));
  });

  it("Enter in the search box hands focus to the results", async () => {
    await mount();
    setValue(testid("search-input"), "warp");
    await act(async () => {
      await sleep(260);
    });
    expect(testid("hit-D1")).not.toBeNull();
    // Enter in the box commits + blurs → results take over keyboard focus.
    pressOn(testid("search-input"), "Enter");
    await flush();
    expect(document.activeElement).not.toBe(testid("search-input"));
    // A document-level Enter now opens the highlighted hit.
    press("Enter");
    await flush();
    expect(testid("detail-id")?.textContent).toBe("D1");
  });

  it("'?' toggles the keyboard-shortcuts help (Esc closes)", async () => {
    await mount();
    expect(testid("help-overlay")).toBeNull();
    press("?");
    await flush();
    expect(testid("help-overlay")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("help-overlay")).toBeNull();
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
