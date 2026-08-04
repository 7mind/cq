/**
 * Usage help-tab render test (T1514 / I20/G155, happy-dom).
 *
 * Opens the help dialog, activates the Usage tab, and asserts: a seeded fake
 * client's endpoints render one row each (calls / bytes in / bytes out cells)
 * plus a totals row; an empty snapshot renders the empty state and no table;
 * and re-activating the tab re-fetches (refresh on open). Driven by the
 * in-memory FakeClient via data-testid selectors.
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

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
}

async function openUsageTab(): Promise<void> {
  click(testid("help-toggle"));
  await flush();
  click(testid("help-tab-usage"));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Usage help tab (T1514)", () => {
  it("renders one row per endpoint plus the totals row from a seeded snapshot", async () => {
    await mount();
    fake.usageStats = {
      endpoints: [
        { name: "fetch_ledger", callCount: 3, bytesIn: 120, bytesOut: 4500 },
        { name: "update_item", callCount: 1, bytesIn: 80, bytesOut: 200 },
      ],
      totals: { name: "totals", callCount: 4, bytesIn: 200, bytesOut: 4700 },
    };
    await openUsageTab();

    expect(testid("help-usage")).not.toBeNull();
    expect(testid("usage-stats-empty")).toBeNull();
    expect(testid("usage-stats-table")).not.toBeNull();

    expect(testid("usage-stats-row-fetch_ledger")).not.toBeNull();
    expect(testid("usage-stats-calls-fetch_ledger")?.textContent).toBe("3");
    expect(testid("usage-stats-bytes-in-fetch_ledger")?.textContent).toBe("120");
    expect(testid("usage-stats-bytes-out-fetch_ledger")?.textContent).toBe("4500");

    expect(testid("usage-stats-row-update_item")).not.toBeNull();
    expect(testid("usage-stats-calls-update_item")?.textContent).toBe("1");
    expect(testid("usage-stats-bytes-in-update_item")?.textContent).toBe("80");
    expect(testid("usage-stats-bytes-out-update_item")?.textContent).toBe("200");

    expect(testid("usage-stats-totals")).not.toBeNull();
    expect(testid("usage-totals-calls")?.textContent).toBe("4");
    expect(testid("usage-totals-bytes-in")?.textContent).toBe("200");
    expect(testid("usage-totals-bytes-out")?.textContent).toBe("4700");
  });

  it("renders the empty state (no table) when no calls have been recorded", async () => {
    await mount();
    await openUsageTab();

    expect(testid("usage-stats-empty")).not.toBeNull();
    expect(testid("usage-stats-table")).toBeNull();
  });

  it("re-fetches on every activation of the tab (refresh on open)", async () => {
    await mount();
    await openUsageTab();
    expect(testid("usage-stats-empty")).not.toBeNull();

    // Seed stats, leave the tab, come back: the remounted tab body must show
    // the new snapshot without reopening the whole dialog.
    fake.usageStats = {
      endpoints: [{ name: "fts_search", callCount: 2, bytesIn: 40, bytesOut: 900 }],
      totals: { name: "totals", callCount: 2, bytesIn: 40, bytesOut: 900 },
    };
    click(testid("help-tab-shortcuts"));
    await flush();
    click(testid("help-tab-usage"));
    await flush();

    expect(testid("usage-stats-empty")).toBeNull();
    expect(testid("usage-stats-calls-fts_search")?.textContent).toBe("2");
    expect(testid("usage-totals-bytes-out")?.textContent).toBe("900");
  });
});
