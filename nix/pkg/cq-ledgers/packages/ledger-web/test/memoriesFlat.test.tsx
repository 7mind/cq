import { registerDom } from "./helpers/dom";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type { FetchedLedger, ItemProjection, LedgerSchema, LedgerSummary } from "../src/types";

const TS = "2026-01-01T00:00:00.000Z";
const memoriesSchema: LedgerSchema = {
  statusValues: ["active", "superseded", "forgotten"],
  terminalStatuses: ["superseded", "forgotten"],
  idPrefix: "MEM",
  transitions: { active: ["superseded", "forgotten"], superseded: [], forgotten: [] },
  fields: {
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
  },
};

class MemoriesClient extends FakeClient {
  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [...(await super.enumerateLedgers()), { name: "memories", itemCount: 1 }];
  }

  override async fetchLedger(id: string, projection: ItemProjection): Promise<FetchedLedger> {
    if (id !== "memories") return super.fetchLedger(id, projection);
    return {
      id,
      schema: memoriesSchema,
      counters: { milestone: 0, item: 1 },
      milestones: [
        {
          id: "M-AMBIENT",
          milestone: {
            id: "M-AMBIENT",
            status: "open",
            title: "ambient",
            description: "",
          },
          items: [
            {
              id: "MEM1",
              milestoneId: "M-AMBIENT",
              status: "active",
              fields: {
                title: "Canonical memory",
                content: "A durable project fact with **evidence**.",
                tags: ["architecture"],
                sourceRefs: ["decisions:K189"],
              },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
      archivePointers: [],
    };
  }
}

let container: HTMLElement;
let root: Root;

const testid = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function click(element: Element | null): void {
  if (element === null) throw new Error("click: element not found");
  act(() => {
    (element as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  const fake = new MemoriesClient();
  await act(async () => {
    root.render(
      createElement(App, {
        connect: async () => fake,
        initialUrl: "http://x/mcp",
      }),
    );
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

describe("canonical Memories destination", () => {
  it("places Memories beside Ideas and renders an ambient memory as a flat row", async () => {
    await mount();

    const memories = testid("ledger-memories");
    const questions = testid("ledger-questions");
    expect(memories).not.toBeNull();
    expect(questions).not.toBeNull();
    expect(memories!.compareDocumentPosition(questions!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    click(memories);
    await flush();

    expect(testid("item-MEM1")?.textContent).toContain("Canonical memory");
    expect(testid("ms-section-M-AMBIENT")).toBeNull();
    expect(container.querySelectorAll("table.lw-table")).toHaveLength(1);
    expect(testid("new-item-or-milestone")).toBeNull();
  });

  it("shows full content in detail and never offers content as a table column", async () => {
    await mount();
    click(testid("ledger-memories"));
    await flush();
    click(testid("item-MEM1"));
    await flush();

    expect(testid("detail-field-title")?.textContent).toBe("Canonical memory");
    expect(testid("detail-field-content")?.textContent).toContain(
      "A durable project fact with evidence.",
    );

    click(testid("column-menu-toggle"));
    expect(testid("column-toggle-content")).toBeNull();
    expect(testid("column-toggle-tags")).not.toBeNull();
    expect(testid("column-toggle-sourceRefs")).not.toBeNull();
  });
});
