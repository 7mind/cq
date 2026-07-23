/**
 * T339: Surface the Ideas ledger in ledger-web with an 'Ideas' sidebar button
 * above Goals. Acceptance:
 *  - the `ledger-ideas` sidebar button renders ABOVE `ledger-goals` in DOM order;
 *  - opening the ideas ledger shows a FLAT table (no per-milestone subsections);
 *  - an idea's detail panel edits title/description/status via updateItem.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import type {
  AgentModelsResult,
  ArchiveContent,
  ArchivePointer,
  FetchedLedger,
  FtsHit,
  Item,
  ItemPatch,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  ListProjectsResult,
  MilestonePatch,
  ReadLogResult,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

class FakeClock implements HoldClock {
  private current = 0;
  private nextHandle = 1;
  private scheduled = new Map<number, { due: number; cb: () => void }>();
  now(): number { return this.current; }
  setTimeout(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { due: this.current + ms, cb });
    return handle;
  }
  clearTimeout(handle: number): void { this.scheduled.delete(handle); }
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

const ideasSchema: LedgerSchema = {
  statusValues: ["open", "planned", "discarded", "postponed"],
  terminalStatuses: ["planned", "discarded"],
  idPrefix: "I",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
  },
};

const goalsSchema: LedgerSchema = {
  statusValues: ["clarifying", "planning", "planned", "building", "done", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  idPrefix: "G",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
    milestones: { type: "id[]", required: false },
  },
};

type UpdateItemArgs = { ledger: string; id: string; patch: ItemPatch };

class IdeasClient implements LedgerClient {
  updateItemCalls: UpdateItemArgs[] = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "ideas", itemCount: 2 },
      { name: "goals", itemCount: 1 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "ideas") {
      return {
        id: "ideas",
        schema: ideasSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "M-AMBIENT",
            milestone: { id: "M-AMBIENT", status: "open", title: "ambient", description: "" },
            items: [
              {
                id: "I1",
                milestoneId: "M-AMBIENT",
                status: "open",
                fields: { title: "first idea", description: "desc one" },
                createdAt: TS,
                updatedAt: TS,
              },
              {
                id: "I2",
                milestoneId: "M-AMBIENT",
                status: "postponed",
                fields: { title: "second idea", description: "desc two" },
                createdAt: TS,
                updatedAt: TS,
              },
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "goals") {
      return {
        id: "goals",
        schema: goalsSchema,
        counters: { milestone: 1, item: 1 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Wave 1", description: "" },
            items: [
              {
                id: "G1",
                milestoneId: "M1",
                status: "planning",
                fields: { title: "a goal" },
                createdAt: TS,
                updatedAt: TS,
              },
            ],
          },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(ledger: string, id: string, patch: ItemPatch): Promise<Item> {
    this.updateItemCalls.push({ ledger, id, patch });
    return {
      id,
      milestoneId: "M-AMBIENT",
      status: patch.status ?? "open",
      fields: patch.fields ?? {},
      createdAt: TS,
      updatedAt: TS,
    };
  }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(_m: string, _p: MilestonePatch): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(): Promise<ArchivePointer> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async close(): Promise<void> { /* no-op */ }
}

let container: HTMLElement;
let root: Root;
let fakeClient: IdeasClient;
let holdClock: FakeClock;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => { await sleep(10); });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => { (el as HTMLElement).click(); });
}
async function holdFull(el: Element | null): Promise<void> {
  if (el === null) throw new Error("holdFull: element not found");
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => { holdClock.advance(HOLD_MS); });
  await flush();
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
  holdClock = new FakeClock();
  fakeClient = new IdeasClient();
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
async function openLedger(name: string): Promise<void> {
  click(testid(`ledger-${name}`));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe("T339 — ideas ledger sidebar + flat list + detail panel", () => {
  it("ledger-ideas button appears above ledger-goals in DOM order", async () => {
    await mount();

    const ideasBtn = testid("ledger-ideas");
    const goalsBtn = testid("ledger-goals");
    expect(ideasBtn).not.toBeNull();
    expect(goalsBtn).not.toBeNull();

    // DOCUMENT_POSITION_FOLLOWING (4): goalsBtn follows ideasBtn → ideas comes first.
    const pos = ideasBtn!.compareDocumentPosition(goalsBtn!);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opening the ideas ledger renders a flat table with no per-milestone subsections", async () => {
    await mount();
    await openLedger("ideas");

    // Both ideas present.
    expect(testid("item-I1")).not.toBeNull();
    expect(testid("item-I2")).not.toBeNull();
    // No coordination-milestone subsection wrappers.
    expect(testid("ms-section-M-AMBIENT")).toBeNull();
    expect(container.querySelector(".lw-milestone-section")).toBeNull();
    // Exactly one flat table renders.
    expect(container.querySelectorAll("table.lw-table").length).toBe(1);
    // Flat table headers: id/status/summary only (no milestone column).
    const headers = Array.from(
      container.querySelectorAll("table.lw-table thead th"),
    ).map((th) => th.textContent);
    expect(headers).toEqual(["id", "status", "summary"]);
  });

  it("an idea's detail panel edits title/description/status via updateItem", async () => {
    await mount();
    await openLedger("ideas");

    // Open detail for I1.
    click(testid("item-I1"));
    await flush();

    // Detail panel is open.
    expect(testid("detail-id")?.textContent).toBe("I1");

    // Click Edit to enter edit mode.
    click(testid("edit"));
    await flush();

    // Edit form is present with the status select.
    expect(testid("edit-form")).not.toBeNull();
    const statusSelect = testid("edit-status");
    expect(statusSelect).not.toBeNull();
    expect((statusSelect as HTMLSelectElement).value).toBe("open");

    // Change status to "planned".
    setValue(statusSelect, "planned");

    // Save via the HoldButton (requires fake-clock hold).
    await holdFull(testid("save"));

    // updateItem was called for the ideas ledger with the idea's id and new status.
    const call = fakeClient.updateItemCalls.find(
      (c) => c.ledger === "ideas" && c.id === "I1",
    );
    expect(call).not.toBeUndefined();
    expect(call!.patch.status).toBe("planned");
  });
});
