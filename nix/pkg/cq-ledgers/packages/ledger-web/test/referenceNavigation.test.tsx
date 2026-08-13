import { registerDom } from "./helpers/dom.js";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.js";
import { FakeClient } from "./fakeClient.js";
import type { FetchedLedger, ItemProjection, LedgerSummary } from "../src/types.js";

let container: HTMLDivElement;
let root: Root;

class ReferenceFakeClient extends FakeClient {
  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [...await super.enumerateLedgers(), { name: "goals", itemCount: 1 }]
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  override async fetchLedger(ledgerId: string, projection: ItemProjection): Promise<FetchedLedger> {
    if (ledgerId === "goals") {
      return {
        id: "goals",
        schema: {
          statusValues: ["building", "done"],
          terminalStatuses: ["done"],
          idPrefix: "G",
          fields: {
            title: { type: "string", required: true },
            milestones: { type: "id[]", required: false },
          },
        },
        counters: { milestone: 2, item: 2 },
        milestones: [{
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Bootstrap", description: "" },
          items: [{
            id: "G1",
            milestoneId: "M1",
            status: "building",
            fields: { title: "Deliver references", milestones: ["M1"] },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }],
        }],
        archivePointers: [],
      };
    }
    const ledger = await super.fetchLedger(ledgerId, projection);
    if (ledgerId !== "tasks") return ledger;
    const task = ledger.milestones[0]?.items[0];
    if (task === undefined) throw new Error("fixture task missing");
    return {
      ...ledger,
      schema: {
        ...ledger.schema,
        fields: {
          ...ledger.schema.fields,
          dependsOn: { type: "id[]", required: false },
          ledgerRefs: { type: "id[]", required: false },
        },
      },
      milestones: ledger.milestones.map((group, groupIndex) => ({
        ...group,
        items: group.items.map((item, itemIndex) => groupIndex === 0 && itemIndex === 0
          ? {
              ...item,
              fields: {
                ...item.fields,
                description: "Review reviews:R2 before delivery.",
                dependsOn: ["R2", "not a reference"],
                ledgerRefs: ["reviews:R2"],
              },
            }
          : item),
      })),
    };
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function click(selector: string): void {
  const node = container.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error(`missing ${selector}`);
  act(() => node.click());
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
  document.querySelectorAll(".lw-ref-preview").forEach((node) => node.remove());
});

describe("App reference navigation", () => {
  it("renders Markdown and list refs as chips, preserves text, previews outside detail clippers, and navigates", async () => {
    const client = new ReferenceFakeClient();
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();
    click('[data-testid="ledger-tasks"]');
    await flush();
    click('[data-testid="item-T1"]');
    await flush();

    expect(container.querySelector('[data-testid="detail-field-dependsOn"]')?.textContent).toContain("not a reference");
    expect(container.querySelectorAll('[data-testid="detail-field-dependsOn"] .lw-ref-chip')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="detail-field-ledgerRefs"] .lw-ref-chip')).toHaveLength(1);
    const proseChip = [...container.querySelectorAll<HTMLButtonElement>('.lw-ref-chip')]
      .find((node) => node.textContent === "reviews:R2");
    if (proseChip === undefined) throw new Error("prose reference chip missing");
    act(() => proseChip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await flush();

    const preview = document.body.querySelector<HTMLElement>(".lw-ref-preview");
    expect(preview?.textContent).toContain("Looks good overall");
    expect(container.querySelector(".lw-detail-wrap")?.contains(preview ?? null)).toBe(false);
    expect(container.querySelector(".lw-detail")?.contains(preview ?? null)).toBe(false);

    act(() => proseChip.click());
    await flush();
    expect(container.querySelector('[data-testid="detail-id"]')?.textContent).toBe("R2");
    expect(client.fetchItemCalls).toContainEqual({ ledgerId: "reviews", itemId: "R2", projection: "compact" });
  });

  it("renders a goal's work-milestone ids as navigable reference chips", async () => {
    const client = new ReferenceFakeClient();
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();
    click('[data-testid="ledger-goals"]');
    await flush();
    click('[data-testid="item-G1"]');
    await flush();

    const milestoneChip = container.querySelector<HTMLButtonElement>(
      '[data-testid="detail-goal-milestones"] .lw-ref-chip',
    );
    expect(milestoneChip?.textContent).toBe("M1");
    act(() => milestoneChip?.click());
    await flush();
    expect(container.querySelector('[data-testid="detail-id"]')?.textContent).toBe("M1");
  });
});
