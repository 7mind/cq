/**
 * DagView + App DAG-integration tests (happy-dom).
 *
 * DagView: renders milestone nodes + dependency edges from assembled DagData
 * and reports node clicks. App: the graph toggle loads the DAG, renders nodes,
 * and selecting a node opens that milestone in the detail panel.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DagView } from "../src/DagView";
import { App } from "../src/App";
import { loadDagData } from "../src/dagData";
import { DagFakeClient } from "./helpers/dagFake";

let container: HTMLElement;
let root: Root;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
function click(el: Element | null): void {
  if (el === null) throw new Error("click: not found");
  act(() => {
    (el as HTMLElement).dispatchEvent(new Event("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DagView", () => {
  it("renders a node per milestone and an edge per dependency", async () => {
    const data = await loadDagData(new DagFakeClient(), "milestones");
    const selected: string[] = [];
    await act(async () => {
      root.render(createElement(DagView, { data, selectedId: null, onSelect: (id: string) => selected.push(id) }));
    });
    expect(testid("dag-svg")).not.toBeNull();
    expect(testid("dag-node-M1")).not.toBeNull();
    expect(testid("dag-node-M2")).not.toBeNull();
    expect(testid("dag-node-M3")).not.toBeNull();
    expect(testid("dag-edge-M1-M2")).not.toBeNull();
    expect(testid("dag-edge-M2-M3")).not.toBeNull();
    // reference count surfaced on the node
    expect(testid("dag-node-M1")?.textContent).toContain("2 items");

    click(testid("dag-node-M2"));
    expect(selected).toEqual(["M2"]);
  });
});

describe("App DAG integration", () => {
  async function mount(): Promise<void> {
    const fake = new DagFakeClient();
    await act(async () => {
      root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
    });
    await flush();
  }

  it("toggles to the graph (milestones by default) and opens a node into detail", async () => {
    await mount();
    click(testid("toggle-dag"));
    await flush();
    expect(testid("dag-svg")).not.toBeNull();
    expect(testid("dag-node-M3")).not.toBeNull();

    click(testid("dag-node-M2"));
    await flush();
    expect(testid("detail-id")?.textContent).toBe("M2");
    expect(testid("detail-status")?.textContent).toBe("open");
  });

  it("scopes the graph to the selected ledger", async () => {
    await mount();
    // select the bugs ledger, then switch to the graph
    click(testid("ledger-bugs"));
    await flush();
    click(testid("toggle-dag"));
    await flush();
    // bugs items are the nodes now — not milestones
    expect(testid("dag-node-D1")).not.toBeNull();
    expect(testid("dag-node-D2")).not.toBeNull();
    expect(testid("dag-edge-D1-D2")).not.toBeNull();
    expect(testid("dag-node-M1")).toBeNull();
  });
});
