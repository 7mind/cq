import { registerDom } from "./helpers/dom";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient, itemAck } from "./fakeClient";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import type {
  FetchedLedger,
  Item,
  ItemInit,
  ItemMutationAckDto,
  ItemProjection,
  LedgerSchema,
  LedgerSummary,
} from "../src/types";

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
  /** D408: FakeClient carries no `memories` data, so record the create here. */
  readonly memoryCreates: Array<{ milestoneId: string; init: ItemInit }> = [];

  override async createItem(
    ledgerId: string,
    milestoneId: string,
    init: ItemInit,
  ): Promise<ItemMutationAckDto> {
    if (ledgerId !== "memories") return super.createItem(ledgerId, milestoneId, init);
    this.memoryCreates.push({ milestoneId, init });
    const created: Item = {
      id: "MEM2",
      milestoneId,
      status: init.status,
      fields: init.fields,
      createdAt: TS,
      updatedAt: TS,
    };
    return itemAck(created);
  }

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

/** Mirrors the hold clock in ideasFlat.test.tsx; HoldButton schedules on it. */
class FakeClock implements HoldClock {
  private current = 0;
  private nextHandle = 1;
  private scheduled = new Map<number, { due: number; cb: () => void }>();
  now(): number {
    return this.current;
  }
  setTimeout(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { due: this.current + ms, cb });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.scheduled.delete(handle);
  }
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let nextHandle: number | null = null;
      let nextDue = Infinity;
      for (const [handle, entry] of this.scheduled) {
        if (entry.due <= target && entry.due < nextDue) {
          nextDue = entry.due;
          nextHandle = handle;
        }
      }
      if (nextHandle === null) break;
      const entry = this.scheduled.get(nextHandle)!;
      this.scheduled.delete(nextHandle);
      this.current = entry.due;
      entry.cb();
    }
    this.current = target;
  }
}

let fakeClient: MemoriesClient;
let holdClock: FakeClock;

async function holdFull(element: Element | null): Promise<void> {
  if (element === null) throw new Error("holdFull: element not found");
  act(() => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => {
    holdClock.advance(HOLD_MS);
  });
  await flush();
}

function setValue(element: Element | null, value: string): void {
  if (element === null) throw new Error("setValue: element not found");
  act(() => {
    const node = element as HTMLInputElement | HTMLSelectElement;
    node.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
    desc?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mount(): Promise<void> {
  holdClock = new FakeClock();
  fakeClient = new MemoriesClient();
  await act(async () => {
    root.render(
      createElement(App, {
        connect: async () => fakeClient,
        initialUrl: "http://x/mcp",
        holdClock,
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
  });

  it("D408: creates a memory under M-AMBIENT with no work-milestone selector", async () => {
    await mount();
    click(testid("ledger-memories"));
    await flush();

    // The control was previously suppressed for Memories only, and a test
    // asserted that absence. Memories is intrinsically attached to M-AMBIENT
    // exactly like Ideas, so it gets the same create affordance.
    click(testid("new-item-or-milestone"));
    await flush();

    // Ambient-attached ledgers offer no work-milestone choice.
    expect(testid("edit-milestone")).toBeNull();

    setValue(testid("edit-field-title"), "a durable project fact");
    setValue(testid("edit-field-content"), "with its evidence");
    await holdFull(testid("save"));

    expect(fakeClient.memoryCreates).toEqual([
      {
        milestoneId: "M-AMBIENT",
        init: {
          status: "active",
          fields: { title: "a durable project fact", content: "with its evidence" },
          author: "user",
        },
      },
    ]);
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
