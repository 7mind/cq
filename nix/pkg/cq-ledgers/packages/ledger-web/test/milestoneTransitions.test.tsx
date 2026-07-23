/**
 * T604 (D114/H81, goal G85): milestone transition-to controls in the web
 * DetailPanel were withheld by an explicit `!isMilestones` clause in both
 * transition-cluster render gates (App.tsx:3487, the load-bearing site
 * reached via the non-question main-fields path, and the byte-identical
 * :3440 duplicate inside renderQuestionFields, dead for milestones but kept
 * in byte-parity with :3487). Lifting `!isMilestones` from both gates lets
 * an `open`/`postponed`/`blocked` milestone offer one-click HoldButton
 * transitions, routed through the existing isMilestones branch of saveEdit
 * (client.updateMilestone), same as edit-mode already uses.
 *
 * Regression coverage (repro-first): against the unmodified gate, assertion
 * (a) below fails (no `transitions` node renders for a selected milestone).
 * Modeled on test/ideasFlat.test.tsx: a purpose-built happy-dom harness with
 * its own recording LedgerClient, since the shared test/fakeClient.ts
 * FakeClient's milestones schema declares no `transitions` map and its
 * `updateMilestone` does not record calls.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import { MILESTONES_SCHEMA } from "@cq/ledger";
import type {
  AgentModelsResult,
  ArchiveContent,
  FetchedLedger,
  FtsHit,
  Item,
  ItemPatch,
  LedgerClient,
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

type UpdateMilestoneArgs = { milestoneId: string; patch: MilestonePatch };

/**
 * Recording milestones-only client: one `open` milestone (M1), one `done`
 * milestone (M2, exercises assertion (d): empty transition targets), and one
 * archived milestone pointer (MA1, exercises assertion (c): archived rows
 * are read-only regardless of the gate).
 */
class MilestonesClient implements LedgerClient {
  updateMilestoneCalls: UpdateMilestoneArgs[] = [];
  updateItemCalls: Array<{ ledger: string; id: string; patch: ItemPatch }> = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<Array<{ name: string; itemCount: number }>> {
    return [{ name: "milestones", itemCount: 2 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "milestones") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "milestones",
      schema: MILESTONES_SCHEMA,
      counters: { milestone: 1, item: 2 },
      milestones: [
        {
          id: "active",
          milestone: { id: "active", status: "open", title: "active", description: "" },
          items: [
            {
              id: "M1",
              milestoneId: "active",
              status: "open",
              fields: { title: "Wave 1" },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "M2",
              milestoneId: "active",
              status: "done",
              fields: { title: "Wave 2" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
      archivePointers: [
        { id: "MA1", path: "./archive/milestones/MA1.md", summary: "archived phase", title: "Old Phase", status: "done" },
      ],
    };
  }
  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    if (ledgerId === "milestones" && archiveId === "MA1") {
      return {
        kind: "group",
        milestone: {
          id: "MA1",
          title: "Old Phase",
          description: "",
          items: [
            {
              id: "MA1",
              milestoneId: "MA1",
              status: "done",
              fields: { title: "Old Phase" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      };
    }
    throw new Error("not used");
  }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(ledger: string, id: string, patch: ItemPatch): Promise<Item> {
    this.updateItemCalls.push({ ledger, id, patch });
    return { id, milestoneId: "active", status: patch.status ?? "open", fields: patch.fields ?? {}, createdAt: TS, updatedAt: TS };
  }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.updateMilestoneCalls.push({ milestoneId, patch });
    return {
      id: milestoneId,
      milestoneId: "active",
      status: patch.status ?? "open",
      fields: {},
      createdAt: TS,
      updatedAt: TS,
    };
  }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async close(): Promise<void> { /* no-op */ }
}

let container: HTMLElement;
let root: Root;
let fakeClient: MilestonesClient;
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

async function mount(): Promise<void> {
  holdClock = new FakeClock();
  fakeClient = new MilestonesClient();
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
async function openMilestones(): Promise<void> {
  click(testid("ledger-milestones"));
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

describe("T604 — milestone transition-to controls in the web DetailPanel", () => {
  it("(a) an open milestone's DetailPanel renders a transition HoldButton per MILESTONES_SCHEMA.transitions.open target", async () => {
    await mount();
    await openMilestones();

    click(testid("item-M1"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("M1");

    const cluster = testid("transitions");
    expect(cluster).not.toBeNull();
    for (const target of MILESTONES_SCHEMA.transitions!["open"]!) {
      expect(testid(`transition-${target}`)).not.toBeNull();
    }
    expect(MILESTONES_SCHEMA.transitions!["open"]).toEqual(["done", "postponed", "blocked"]);
  });

  it("(b) hold-completing a transition button calls updateMilestone exactly once with the milestone id and target status, and never updateItem", async () => {
    await mount();
    await openMilestones();

    click(testid("item-M1"));
    await flush();

    await holdFull(testid("transition-postponed"));

    expect(fakeClient.updateMilestoneCalls.length).toBe(1);
    expect(fakeClient.updateMilestoneCalls[0]!.milestoneId).toBe("M1");
    expect(fakeClient.updateMilestoneCalls[0]!.patch.status).toBe("postponed");
    expect(fakeClient.updateItemCalls.length).toBe(0);
  });

  it("(c) an archived milestone's DetailPanel renders NO transitions cluster", async () => {
    await mount();
    await openMilestones();

    click(testid("toggle-archive"));
    await flush();
    click(testid("item-MA1"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("MA1");
    expect(testid("archived-badge")).not.toBeNull();
    expect(testid("transitions")).toBeNull();
  });

  it("(d) a done milestone's DetailPanel renders no transitions cluster (empty allowed-targets)", async () => {
    await mount();
    await openMilestones();

    click(testid("item-M2"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("M2");
    expect(MILESTONES_SCHEMA.transitions!["done"]).toEqual([]);
    expect(testid("transitions")).toBeNull();
  });
});
