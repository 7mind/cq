/**
 * Tests for the defect→fix-task and hypothesis-tree relationship panels (T47).
 *
 * The FakeClient is seeded with:
 *  - a "defects" ledger: D1 with dependsOn=["T1"] (forward link) and D2 with no links
 *  - a "tasks" ledger: T1 with ledgerRefs=["defects:D1"] (reverse link on D1)
 *    and T2 with ledgerRefs=["defects:D1"] (reverse link only on D1, not in D1.dependsOn)
 *  - a "hypothesis" ledger: H1 (root) → H2 (child of H1) → H3 (child of H2)
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

const TS = "2026-01-01T00:00:00.000Z";

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
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

/**
 * Extends FakeClient with defects, tasks, and hypothesis ledgers.
 * The base FakeClient's `bugs` ledger uses the "D" prefix but is not named
 * "defects", so we add the canonical "defects" and "tasks" ledgers here by
 * monkey-patching the private `data` map after construction.
 */
class RelationshipsClient extends FakeClient {
  constructor() {
    super();
    // Access private `data` field via index (TypeScript allows this in tests).
    const data = (this as unknown as { data: Record<string, unknown> }).data;
    data["defects"] = {
      schema: {
        statusValues: ["open", "wip", "resolved"],
        terminalStatuses: ["resolved"],
        idPrefix: "D",
        transitions: { open: ["wip", "resolved"], wip: ["resolved"], resolved: [] },
        fields: {
          headline: { type: "string", required: true },
          dependsOn: { type: "id[]", required: false },
        },
      },
      groups: [
        {
          id: "M1",
          items: [
            {
              id: "D1",
              milestoneId: "M1",
              status: "open",
              fields: { headline: "warp core glitch", dependsOn: ["T1"] },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "D2",
              milestoneId: "M1",
              status: "open",
              fields: { headline: "no links here" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
    };
    data["tasks"] = {
      schema: {
        statusValues: ["planned", "wip", "done"],
        terminalStatuses: ["done"],
        idPrefix: "T",
        transitions: { planned: ["wip", "done"], wip: ["done"], done: [] },
        fields: {
          headline: { type: "string", required: true },
          ledgerRefs: { type: "id[]", required: false },
        },
      },
      groups: [
        {
          id: "M1",
          items: [
            {
              id: "T1",
              milestoneId: "M1",
              status: "wip",
              // T1 appears in both D1.dependsOn AND has a reverse ledgerRefs link.
              fields: { headline: "fix warp core", ledgerRefs: ["defects:D1"] },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "T2",
              milestoneId: "M1",
              status: "planned",
              // T2 only has the reverse link (not in D1.dependsOn).
              fields: { headline: "refactor plasma injector", ledgerRefs: ["defects:D1"] },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "T3",
              milestoneId: "M1",
              status: "done",
              // T3 has no link to D1.
              fields: { headline: "unrelated task" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
    };
    data["hypothesis"] = {
      schema: {
        statusValues: ["open", "confirmed", "wrong"],
        terminalStatuses: ["confirmed", "wrong"],
        idPrefix: "H",
        transitions: { open: ["confirmed", "wrong"], confirmed: [], wrong: [] },
        fields: {
          headline: { type: "string", required: true },
          parentHypothesis: { type: "id", required: false },
        },
      },
      groups: [
        {
          id: "M1",
          items: [
            {
              id: "H1",
              milestoneId: "M1",
              status: "open",
              fields: { headline: "root hypothesis" },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H2",
              milestoneId: "M1",
              status: "open",
              fields: { headline: "child of H1", parentHypothesis: "H1" },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H3",
              milestoneId: "M1",
              status: "confirmed",
              fields: { headline: "grandchild of H1", parentHypothesis: "H2" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
    };
  }
}

async function mount(): Promise<void> {
  fake = new RelationshipsClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
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

describe("defect fix-tasks panel (T47)", () => {
  it("shows Fix tasks section with all linked task ids when a defects item is selected", async () => {
    await mount();
    click(testid("ledger-defects"));
    await flush();
    click(testid("item-D1"));
    // Wait for aux tasks fetch to complete.
    await act(async () => { await sleep(30); });

    // The section heading should be present.
    expect(testid("fix-tasks-section")).not.toBeNull();

    // T1 is linked via forward link (D1.dependsOn contains "T1").
    expect(testid("fix-task-T1")).not.toBeNull();

    // T2 is linked via reverse link (T2.ledgerRefs contains "defects:D1").
    expect(testid("fix-task-T2")).not.toBeNull();

    // T3 has no link to D1 — must not appear.
    expect(testid("fix-task-T3")).toBeNull();
  });

  it("renders status badge and summary for each linked task", async () => {
    await mount();
    click(testid("ledger-defects"));
    await flush();
    click(testid("item-D1"));
    await act(async () => { await sleep(30); });

    // T1 is "wip" — status badge should show "wip".
    const t1Status = testid("fix-task-status-T1");
    expect(t1Status).not.toBeNull();
    expect(t1Status?.textContent).toContain("wip");

    // T2 is "planned".
    const t2Status = testid("fix-task-status-T2");
    expect(t2Status).not.toBeNull();
    expect(t2Status?.textContent).toContain("planned");
  });

  it("clicking a fix-task link navigates to the tasks ledger and selects the task", async () => {
    await mount();
    click(testid("ledger-defects"));
    await flush();
    click(testid("item-D1"));
    await act(async () => { await sleep(30); });

    // Click the T1 link.
    click(testid("fix-task-T1"));
    await flush();

    // The tasks ledger should now be open, and T1 detail should be shown.
    expect(testid("detail-id")?.textContent).toBe("T1");
    expect(testid("item-T1")).not.toBeNull();
  });

  it("shows no fix-tasks section when the defect has no linked tasks", async () => {
    await mount();
    click(testid("ledger-defects"));
    await flush();
    click(testid("item-D2"));
    await act(async () => { await sleep(30); });

    // D2 has no links → panel should not render.
    expect(testid("fix-tasks-section")).toBeNull();
  });

  it("does not show fix-tasks section for non-defect ledgers", async () => {
    await mount();
    // Open the tasks ledger — no fix-tasks panel should appear.
    click(testid("ledger-tasks"));
    await flush();
    click(testid("item-T1"));
    await flush();

    expect(testid("fix-tasks-section")).toBeNull();
  });
});

describe("hypothesis tree panel (T47)", () => {
  it("shows ancestry breadcrumb for a non-root hypothesis", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H3"));
    await flush();

    // H3 → parent H2 → grandparent H1.
    expect(testid("hypothesis-tree-section")).not.toBeNull();
    expect(testid("hypothesis-ancestry")).not.toBeNull();

    // Both ancestors should appear (H2 direct parent, H1 root).
    expect(testid("ancestor-H2")).not.toBeNull();
    expect(testid("ancestor-H1")).not.toBeNull();
  });

  it("ancestry breadcrumb is ordered root-first (root → parent)", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H3"));
    await flush();

    const ancestry = testid("hypothesis-ancestry");
    expect(ancestry).not.toBeNull();
    const h1 = testid("ancestor-H1");
    const h2 = testid("ancestor-H2");
    // H1 (root) should precede H2 (direct parent) in DOM order.
    const h1BeforeH2 =
      (h1!.compareDocumentPosition(h2!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(h1BeforeH2).toBe(true);
  });

  it("shows children list for a parent hypothesis", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H1"));
    await flush();

    // H1 is the root: no ancestors, but H2 is a child.
    expect(testid("hypothesis-tree-section")).not.toBeNull();
    expect(testid("hypothesis-ancestry")).toBeNull(); // no ancestors
    expect(testid("hypothesis-children")).not.toBeNull();
    expect(testid("child-H2")).not.toBeNull();
    expect(testid("child-H3")).toBeNull(); // H3 is H2's child, not H1's direct child
  });

  it("shows both ancestry and children for a middle node", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H2"));
    await flush();

    expect(testid("hypothesis-ancestry")).not.toBeNull();
    expect(testid("ancestor-H1")).not.toBeNull();
    expect(testid("hypothesis-children")).not.toBeNull();
    expect(testid("child-H3")).not.toBeNull();
  });

  it("clicking an ancestor navigates to that hypothesis", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H3"));
    await flush();

    click(testid("ancestor-H1"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("H1");
  });

  it("clicking a child navigates to that hypothesis", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H1"));
    await flush();

    click(testid("child-H2"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("H2");
  });

  it("shows no tree panel for the root hypothesis with no children", async () => {
    // If H1 had no children and no parent, the panel should not render.
    // We test this by creating a standalone hypothesis.
    const client = new RelationshipsClient();
    // Add a standalone H4 with no parent/children.
    const data = (client as unknown as { data: Record<string, { groups: Array<{ items: Array<unknown> }> }> }).data;
    data["hypothesis"]!.groups[0]!.items.push({
      id: "H4",
      milestoneId: "M1",
      status: "open",
      fields: { headline: "standalone hypothesis" },
      createdAt: TS,
      updatedAt: TS,
    });
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H4"));
    await flush();

    expect(testid("hypothesis-tree-section")).toBeNull();
  });

  it("does not show hypothesis tree section for non-hypothesis ledgers", async () => {
    await mount();
    click(testid("ledger-tasks"));
    await flush();
    click(testid("item-T1"));
    await flush();

    expect(testid("hypothesis-tree-section")).toBeNull();
  });
});
