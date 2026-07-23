/**
 * Tests for the header progress bars (T3, researches bar added T560):
 *   progress-questions / progress-tasks / progress-defects / progress-researches
 *
 * Each bar is fed by LedgerSummary.completedCount/itemCount computed server-side
 * (T1). No client-side schema or terminal-status classification is performed.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type {
  AgentModelsResult,
  ArchiveContent,
  ArchivePointer,
  DerivedPredicates,
  FetchedLedger,
  FtsHit,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSummary,
  ListProjectsResult,
  MilestonePatch,
  ReadLogResult,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

let container: HTMLElement;
let root: Root;

const testid = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

function fillWidth(el: HTMLElement | null): number {
  if (el === null) throw new Error("element not found");
  const fill = el.querySelector(".lw-progress-fill") as HTMLElement | null;
  if (fill === null) throw new Error(".lw-progress-fill not found");
  const w = fill.style.width;
  // e.g. "25%" → 0.25
  if (!w.endsWith("%")) throw new Error(`unexpected width: ${w}`);
  return parseFloat(w) / 100;
}

function barTitle(el: HTMLElement | null): string {
  if (el === null) throw new Error("element not found");
  return el.getAttribute("title") ?? "";
}

function barLabel(el: HTMLElement | null): string {
  if (el === null) throw new Error("element not found");
  const lbl = el.querySelector(".lw-progress-label");
  return lbl?.textContent ?? "";
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

// ---------------------------------------------------------------------------
// Minimal fake WebSocket for live-refresh tests.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ProgressFakeClient — thin wrapper over FakeClient that overrides
// enumerateLedgers to return controlled itemCount + completedCount values.
// ---------------------------------------------------------------------------

type SummaryOverride = Pick<LedgerSummary, "name" | "itemCount" | "completedCount">;

class ProgressFakeClient implements LedgerClient {
  private readonly base: FakeClient;
  private readonly overrides: SummaryOverride[];

  constructor(overrides: SummaryOverride[]) {
    this.base = new FakeClient();
    this.overrides = overrides;
  }

  displayName(): string {
    return this.base.displayName();
  }

  async enumerateLedgers(): Promise<LedgerSummary[]> {
    // Build summaries from overrides; fall back to base for ledgers not listed.
    const baseList = await this.base.enumerateLedgers();
    const map = new Map<string, LedgerSummary>();
    for (const s of baseList) map.set(s.name, s);
    for (const o of this.overrides) {
      const existing = map.get(o.name) ?? { name: o.name, itemCount: o.itemCount };
      const merged: LedgerSummary = { ...existing, itemCount: o.itemCount };
      if (o.completedCount !== undefined) merged.completedCount = o.completedCount;
      map.set(o.name, merged);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    return this.base.fetchLedger(id);
  }
  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    return this.base.fetchLedgerArchive(ledgerId, archiveId);
  }
  async fetchItem(ledgerId: string, itemId: string): Promise<Item> {
    return this.base.fetchItem(ledgerId, itemId);
  }
  async createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item> {
    return this.base.createItem(ledgerId, milestoneId, init);
  }
  async updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item> {
    return this.base.updateItem(ledgerId, itemId, patch);
  }
  async ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]> {
    return this.base.ftsSearch(query, opts);
  }
  async createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item> {
    return this.base.createMilestone(init);
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    return this.base.updateMilestone(milestoneId, patch);
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    return this.base.archiveMilestone(milestoneId, summary);
  }
  async readLog(path: string): Promise<ReadLogResult> {
    return this.base.readLog(path);
  }
  async getAgentModels(): Promise<AgentModelsResult> {
    return this.base.getAgentModels();
  }
  async listProjects(): Promise<ListProjectsResult> {
    return this.base.listProjects();
  }
  async derivePredicates(): Promise<DerivedPredicates> {
    return this.base.derivePredicates();
  }
  async close(): Promise<void> {
    return this.base.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("header progress bars (T3)", () => {
  it("renders three progress bars with correct testids", async () => {
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 12, completedCount: 3 },
      { name: "tasks", itemCount: 5, completedCount: 2 },
      { name: "defects", itemCount: 8, completedCount: 4 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    expect(testid("progress-questions")).not.toBeNull();
    expect(testid("progress-tasks")).not.toBeNull();
    expect(testid("progress-defects")).not.toBeNull();
  });

  it("questions bar fill fraction = completedCount/itemCount (3/12)", async () => {
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 12, completedCount: 3 },
      { name: "tasks", itemCount: 10, completedCount: 0 },
      { name: "defects", itemCount: 10, completedCount: 0 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const bar = testid("progress-questions");
    expect(fillWidth(bar)).toBeCloseTo(3 / 12);
    expect(barTitle(bar)).toBe("questions: 3/12");
    // Visible prefixed label so the three bars are distinguishable.
    expect(barLabel(bar)).toBe("Q: 3/12");
  });

  it("tasks bar reflects terminal-based completedCount (NOT answered special case)", async () => {
    // completedCount=4 is driven by terminalStatuses on the server; the client
    // does NOT classify by schema — it consumes the server-computed value directly.
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 5, completedCount: 1 },
      { name: "tasks", itemCount: 10, completedCount: 4 },
      { name: "defects", itemCount: 6, completedCount: 2 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const bar = testid("progress-tasks");
    expect(fillWidth(bar)).toBeCloseTo(4 / 10);
    expect(barTitle(bar)).toBe("tasks: 4/10");
    expect(barLabel(bar)).toBe("T: 4/10");
  });

  it("defects bar fill fraction = completedCount/itemCount", async () => {
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 5, completedCount: 0 },
      { name: "tasks", itemCount: 5, completedCount: 0 },
      { name: "defects", itemCount: 8, completedCount: 6 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const bar = testid("progress-defects");
    expect(fillWidth(bar)).toBeCloseTo(6 / 8);
    expect(barTitle(bar)).toBe("defects: 6/8");
    expect(barLabel(bar)).toBe("D: 6/8");
  });

  it("itemCount=0 renders a 0% bar without error", async () => {
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 0, completedCount: 0 },
      { name: "tasks", itemCount: 0, completedCount: 0 },
      { name: "defects", itemCount: 0, completedCount: 0 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    // All three should render a 0% bar (no divide-by-zero, no crash).
    expect(fillWidth(testid("progress-questions"))).toBe(0);
    expect(fillWidth(testid("progress-tasks"))).toBe(0);
    expect(fillWidth(testid("progress-defects"))).toBe(0);
    // Title shows 0/0 — server's view.
    expect(barTitle(testid("progress-questions"))).toBe("questions: 0/0");
  });

  it("missing completedCount degrades to 0% bar without throwing", async () => {
    // Omit completedCount entirely to simulate an older server peer.
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 7 },
      { name: "tasks", itemCount: 3 },
      { name: "defects", itemCount: 5 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    // No completedCount → 0% bars, no error.
    expect(fillWidth(testid("progress-questions"))).toBe(0);
    expect(fillWidth(testid("progress-tasks"))).toBe(0);
    expect(fillWidth(testid("progress-defects"))).toBe(0);
    // Title shows 0/<total>.
    expect(barTitle(testid("progress-questions"))).toBe("questions: 0/7");
  });

  it("researches bar renders when the summary includes it (T560)", async () => {
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 5, completedCount: 1 },
      { name: "tasks", itemCount: 5, completedCount: 1 },
      { name: "defects", itemCount: 5, completedCount: 1 },
      { name: "researches", itemCount: 6, completedCount: 2 },
    ]);
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const bar = testid("progress-researches");
    expect(bar).not.toBeNull();
    expect(fillWidth(bar)).toBeCloseTo(2 / 6);
    expect(barTitle(bar)).toBe("researches: 2/6");
    expect(barLabel(bar)).toBe("R: 2/6");
  });

  it("bars update after a simulated 'changed' refresh", async () => {
    FakeWS.instances = [];
    const client = new ProgressFakeClient([
      { name: "questions", itemCount: 12, completedCount: 3 },
      { name: "tasks", itemCount: 5, completedCount: 2 },
      { name: "defects", itemCount: 8, completedCount: 4 },
    ]);

    await act(async () => {
      root.render(
        createElement(App, {
          connect: async () => client,
          initialUrl: "http://x/mcp",
          liveUrl: "ws://x/ws",
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    // Verify initial state.
    expect(fillWidth(testid("progress-questions"))).toBeCloseTo(3 / 12);

    // Simulate server updating: now questions has 6 answered out of 12.
    client["overrides"][0] = { name: "questions", itemCount: 12, completedCount: 6 };

    // Trigger a 'changed' WS push → App re-enumerates.
    const ws = FakeWS.instances[0]!;
    act(() => ws.open());
    await flush();
    act(() => ws.push({ type: "changed", ledger: "questions" }));
    await flush();

    expect(fillWidth(testid("progress-questions"))).toBeCloseTo(6 / 12);
    expect(barTitle(testid("progress-questions"))).toBe("questions: 6/12");
  });
});
