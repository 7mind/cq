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
import { loadDagData, type DagData } from "../src/dagData";
import { BUCKET_HEX } from "../src/status";
import type { DagEdge } from "../src/dagLayout";
import type { LedgerSchema } from "../src/types";
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
  // Isolate persisted UI state (restored view) so one test's navigation does
  // not auto-restore into the next.
  localStorage.clear();
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

  it("colors non-milestones nodes via statusBucket + the shared palette", async () => {
    // A reviews-style ledger where `revise` is a terminal "needs changes"
    // status (→ warning) and `done` is terminal (→ done); `planned` is
    // non-terminal (→ start). None should fall back to the old amber default.
    const schema: LedgerSchema = {
      statusValues: ["planned", "wip", "revise", "done"],
      terminalStatuses: ["done", "revise"],
      fields: { headline: { type: "string", required: true } },
      idPrefix: "R",
    };
    const node = (id: string, status: string): DagData["nodes"][number] => ({
      id,
      title: id,
      status,
      sublabel: "@M1",
    });
    const data: DagData = {
      ledgerId: "reviews",
      schema,
      nodes: [node("R1", "revise"), node("R2", "done"), node("R3", "planned")],
      edges: [] as DagEdge[],
    };
    await act(async () => {
      root.render(createElement(DagView, { data, selectedId: null, onSelect: () => {} }));
    });

    const strokeOf = (id: string): string | null =>
      testid(`dag-node-${id}`)?.querySelector("rect")?.getAttribute("stroke") ?? null;
    // texts in a node: [0]=id, [1]=title, [2]=status (bucket-colored), [3]=sublabel.
    const statusFillOf = (id: string): string | null =>
      testid(`dag-node-${id}`)?.querySelectorAll("text")[2]?.getAttribute("fill") ?? null;

    expect(strokeOf("R1")).toBe(BUCKET_HEX.warning);
    expect(strokeOf("R2")).toBe(BUCKET_HEX.done);
    expect(strokeOf("R3")).toBe(BUCKET_HEX.start);
    // status-text fill tracks the same bucket color, not the old amber default.
    expect(statusFillOf("R1")).toBe(BUCKET_HEX.warning);
    expect(strokeOf("R1")).not.toBe("#e0b341");
  });
});

describe("App DAG integration", () => {
  async function mount(): Promise<DagFakeClient> {
    const fake = new DagFakeClient();
    await act(async () => {
      root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
    });
    await flush();
    return fake;
  }

  it("toggles to the graph (milestones by default) and opens a node into detail", async () => {
    const fake = await mount();
    click(testid("toggle-dag"));
    await flush();
    expect(
      fake.fetchLedgerCalls.filter(({ ledgerId }) => ledgerId === "milestones"),
    ).toEqual([
      { ledgerId: "milestones", projection: "full" },
      { ledgerId: "milestones", projection: "compact" },
    ]);
    expect(fake.fetchLedgerCalls).toContainEqual({
      ledgerId: "bugs",
      projection: "compact",
    });
    expect(testid("dag-svg")).not.toBeNull();
    expect(testid("dag-node-M3")).not.toBeNull();

    click(testid("dag-node-M2"));
    await flush();
    expect(testid("detail-id")?.textContent).toBe("M2");
    expect(testid("detail-status")?.textContent).toBe("open");
  });

  it("scopes the graph to the selected ledger", async () => {
    const fake = await mount();
    // select the bugs ledger, then switch to the graph
    click(testid("ledger-bugs"));
    await flush();
    click(testid("toggle-dag"));
    await flush();
    expect(
      fake.fetchLedgerCalls.filter(({ ledgerId }) => ledgerId === "bugs").slice(-2),
    ).toEqual([
      { ledgerId: "bugs", projection: "full" },
      { ledgerId: "bugs", projection: "compact" },
    ]);
    // bugs items are the nodes now — not milestones
    expect(testid("dag-node-D1")).not.toBeNull();
    expect(testid("dag-node-D2")).not.toBeNull();
    expect(testid("dag-edge-D1-D2")).not.toBeNull();
    expect(testid("dag-node-M1")).toBeNull();
  });
});
