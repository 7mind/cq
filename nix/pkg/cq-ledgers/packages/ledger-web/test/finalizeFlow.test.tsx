/**
 * T622 (goal G83): consolidated regression suite for the web finalize flow,
 * covering the delta NOT already exercised by finalizeMenu.test.tsx (T619:
 * button placement/gating, menu options, Escape-at-menu, goals presence,
 * option-pick stub, reset-on-switch) or finalizePreviewModal.test.tsx (T620:
 * eligible/skipped ids, partial-hold no-op, in-order sweep incl. one failing
 * updateItem id, archive summary synthesis, empty-plan state, stale-async
 * generation-token regression):
 *
 *  1. apply-done launched from the GOALS view closes ONLY building goals and
 *     lists every skipped goal/milestone with its reason (bound to the
 *     SKIP_* constants exported from @cq/ledger/finalize so drift fails loud
 *     — mirrors the TUI's GoalsClient fixture, T623);
 *  2. archive-sweep exactness: a 3-way milestone fixture (fully-terminal /
 *     item-terminal-but-self-open / non-terminal-item) mirroring T623's TUI
 *     ArchiveExactnessClient — only the fully-terminal milestone is ever
 *     archived;
 *  3. archive-mode partial failure: one archivable milestone's
 *     archiveMilestone rejects, a LATER archivable milestone still executes
 *     (Q292 mid-sweep continuation) and the failed row renders its error;
 *  4. Escape dismisses the finalize preview modal at the PREVIEW step and at
 *     the RESULTS step (menu-step Escape is T619's territory);
 *  5. finalize's toolbar addition does not regress the '+ milestone' create
 *     flow on the milestones view (the finalize-btn now shares the toolbar
 *     row with 'new-item-or-milestone').
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import { MILESTONES_SCHEMA } from "@cq/ledger/constants";
import {
  SKIP_INCOMPLETE_MILESTONE,
  SKIP_MILESTONE_NOT_TERMINAL,
  SKIP_NON_TERMINAL_ITEMS,
  SKIP_WRONG_PHASE,
} from "@cq/ledger/finalize";
import type {
  AgentModelsResult,
  ArchiveContent,
  ArchivePointer,
  DerivedPredicates,
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

function item(id: string, milestoneId: string, status: string, fields: Item["fields"]): Item {
  return { id, milestoneId, status, fields, createdAt: TS, updatedAt: TS };
}

function emptyPredicates(): DerivedPredicates {
  const v = (): { value: boolean; items: string[] } => ({ value: false, items: [] });
  return {
    pInvestigate: v(),
    pSeed: v(),
    pPlan: v(),
    pResearch: v(),
    pImplement: v(),
    openQuestionGate: v(),
    belowFloor: v(),
    goalDrift: v(),
  };
}

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  fields: { headline: { type: "string", required: true } },
};
// No `transitions` map on goals: building -> done is unguarded (matches the
// plan's transitionPermitted fallback), same as finalizePreviewModal.test.tsx.
const goalsSchema: LedgerSchema = {
  statusValues: ["shaping", "building", "done"],
  terminalStatuses: ["done"],
  idPrefix: "G",
  fields: {
    title: { type: "string", required: true },
    milestones: { type: "string[]", required: false },
  },
};

type RecordedCall =
  | { op: "updateMilestone"; milestoneId: string; status: string | undefined }
  | { op: "updateItem"; ledger: string; id: string; status: string | undefined }
  | { op: "archiveMilestone"; milestoneId: string; summary: string };

/**
 * Milestones + tasks + goals fixture for scenario (1): M1 (open, task done ->
 * complete), M2 (open, task wip -> incomplete). Goals: G1 (building,
 * milestones=[M1] -> close-goal), G2 (building, milestones=[M2] -> skipped,
 * SKIP_INCOMPLETE_MILESTONE), G3 (shaping -> skipped, SKIP_WRONG_PHASE).
 */
class GoalsFlowClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 3 },
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("M1", "active", "open", { title: "Wave 1" }),
              item("M2", "active", "open", { title: "Wave 2" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id: "tasks",
        schema: tasksSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          { id: "M1", milestone: { id: "M1", status: "open", title: "M1", description: "" }, items: [item("T1", "M1", "done", { headline: "t1" })] },
          { id: "M2", milestone: { id: "M2", status: "open", title: "M2", description: "" }, items: [item("T2", "M2", "wip", { headline: "t2" })] },
        ],
        archivePointers: [],
      };
    }
    if (id === "goals") {
      return {
        id: "goals",
        schema: goalsSchema,
        counters: { milestone: 1, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("G1", "active", "building", { title: "Goal one", milestones: ["M1"] }),
              item("G2", "active", "building", { title: "Goal two", milestones: ["M2"] }),
              item("G3", "active", "shaping", { title: "Goal three", milestones: ["M1"] }),
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
    this.calls.push({ op: "updateItem", ledger, id, status: patch.status });
    return item(id, "active", patch.status ?? "open", patch.fields ?? {});
  }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.calls.push({ op: "updateMilestone", milestoneId, status: patch.status });
    return item(milestoneId, "active", patch.status ?? "open", {});
  }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

/**
 * Archive-sweep exactness fixture (mirrors T623's TUI ArchiveExactnessClient
 * in happy-dom): MA is fully terminal (all grouped items terminal AND its own
 * status is terminal) -> archivable; MB's grouped items are all terminal but
 * the milestone ITSELF is still "open" -> SKIP_MILESTONE_NOT_TERMINAL; MC has
 * a non-terminal grouped item -> SKIP_NON_TERMINAL_ITEMS. Only MA may ever
 * reach archiveMilestone.
 */
class ArchiveExactnessClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];
  /** milestone ids whose archiveMilestone rejects (deliberate per-id failure). */
  readonly failArchiveIds = new Set<string>();

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 3 },
      { name: "tasks", itemCount: 3 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("MA", "active", "done", { title: "Alpha" }),
              item("MB", "active", "open", { title: "Bravo" }),
              item("MC", "active", "open", { title: "Charlie" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id: "tasks",
        schema: tasksSchema,
        counters: { milestone: 1, item: 3 },
        milestones: [
          { id: "MA", milestone: { id: "MA", status: "done", title: "Alpha", description: "" }, items: [item("T1", "MA", "done", { headline: "a-work" })] },
          { id: "MB", milestone: { id: "MB", status: "open", title: "Bravo", description: "" }, items: [item("T2", "MB", "done", { headline: "b-work" })] },
          { id: "MC", milestone: { id: "MC", status: "open", title: "Charlie", description: "" }, items: [item("T3", "MC", "planned", { headline: "c-work" })] },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    if (this.failArchiveIds.has(milestoneId)) throw new Error(`${milestoneId} archive refused`);
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

/**
 * Two-archivable-milestone fixture for scenario (3): MA and MD are BOTH
 * fully terminal (archivable); archiveMilestone rejects for MA specifically.
 * MD must still execute (Q292 mid-sweep continuation) even though it comes
 * after MA in the plan.
 */
class ArchivePartialFailureClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("MA", "active", "done", { title: "Alpha" }),
              item("MD", "active", "done", { title: "Delta" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id: "tasks",
        schema: tasksSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          { id: "MA", milestone: { id: "MA", status: "done", title: "Alpha", description: "" }, items: [item("T1", "MA", "done", { headline: "a-work" })] },
          { id: "MD", milestone: { id: "MD", status: "done", title: "Delta", description: "" }, items: [item("T2", "MD", "done", { headline: "d-work" })] },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    if (milestoneId === "MA") throw new Error("MA archive refused");
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

/**
 * Minimal milestones-only fixture for scenario (5): finalize-btn must render
 * alongside 'new-item-or-milestone' without breaking the '+ milestone' create
 * flow. `createMilestone` records calls and returns a fresh M2.
 */
class MilestonesOnlyClient implements LedgerClient {
  readonly createMilestoneCalls: Array<{ title: string }> = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "milestones", itemCount: 1 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "milestones") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "milestones",
      schema: MILESTONES_SCHEMA,
      counters: { milestone: 1, item: 1 },
      milestones: [
        {
          id: "active",
          milestone: { id: "active", status: "open", title: "active", description: "" },
          items: [item("M1", "active", "open", { title: "Wave 1" })],
        },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(patch: { title: string }): Promise<Item> {
    this.createMilestoneCalls.push({ title: patch.title });
    return item("M2", "active", "open", { title: patch.title });
  }
  async archiveMilestone(): Promise<ArchivePointer> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

let container: HTMLElement;
let root: Root;
let holdClock: FakeClock;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => { await sleep(10); });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
const testids = (prefix: string): string[] =>
  Array.from(container.querySelectorAll(`[data-testid^="${prefix}"]`)).map(
    (el) => el.getAttribute("data-testid")!.slice(prefix.length),
  );
function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => { (el as HTMLElement).click(); });
}
function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
function setValue(el: Element | null, value: string): void {
  if (el === null) throw new Error("setValue: element not found");
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function holdFull(el: Element | null): Promise<void> {
  if (el === null) throw new Error("holdFull: element not found");
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => { holdClock.advance(HOLD_MS); });
  await flush();
}

async function mount(client: LedgerClient): Promise<void> {
  holdClock = new FakeClock();
  await act(async () => {
    root.render(
      createElement(App, {
        connect: async () => client,
        initialUrl: "http://x/mcp",
        holdClock,
      }),
    );
  });
  await flush();
}

async function openPreview(view: string, mode: "apply-done" | "archive"): Promise<void> {
  click(testid(`ledger-${view}`));
  await flush();
  click(testid("finalize-btn"));
  await flush();
  click(testid(`finalize-option-${mode}`));
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

describe("T622 — web finalize flow regression suite", () => {
  it("apply-done launched from the GOALS view closes only building goals, listing every skipped id with its reason", async () => {
    const client = new GoalsFlowClient();
    await mount(client);
    await openPreview("goals", "apply-done");

    expect(testid("finalize-preview-mode")?.textContent).toBe("apply-done");
    // Plan order: milestone close before goal close (M1 before G1).
    expect(testids("finalize-affected-")).toEqual(["M1", "G1"]);
    expect(testid("finalize-affected-G1")?.textContent).toContain("close-goal");
    // G2 and G3 are NOT closed — bound to the SKIP_* constants so drift fails loud.
    expect(new Set(testids("finalize-skipped-"))).toEqual(new Set(["M2", "G2", "G3"]));
    expect(testid("finalize-skipped-G2")?.textContent).toContain(SKIP_INCOMPLETE_MILESTONE);
    expect(testid("finalize-skipped-G3")?.textContent).toContain(SKIP_WRONG_PHASE);

    await holdFull(testid("finalize-execute"));

    // Only M1 (milestone) and G1 (building goal) were ever written.
    expect(client.calls).toEqual([
      { op: "updateMilestone", milestoneId: "M1", status: "done" },
      { op: "updateItem", ledger: "goals", id: "G1", status: "done" },
    ]);
    expect(testid("finalize-result-G1")?.textContent).toContain("ok");
  });

  it("archive sweep archives exactly the fully-terminal milestone in a 3-way mixed fixture", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testids("finalize-affected-")).toEqual(["MA"]);
    expect(testid("finalize-affected-MA")?.textContent).toContain("archive-milestone");
    // MB: grouped items all terminal, but the milestone's own status ("open") is not.
    expect(testid("finalize-skipped-MB")?.textContent).toContain(SKIP_MILESTONE_NOT_TERMINAL);
    expect(testid("finalize-skipped-MB")?.textContent).toContain("open");
    // MC: has a non-terminal grouped item.
    expect(testid("finalize-skipped-MC")?.textContent).toContain(SKIP_NON_TERMINAL_ITEMS);
    expect(testid("finalize-skipped-MC")?.textContent).toContain("tasks:T3");

    await holdFull(testid("finalize-execute"));

    // Exactness: archiveMilestone was called for MA only, never MB/MC.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
    ]);
    expect(testids("finalize-result-")).toEqual(["MA"]);
    expect(testid("finalize-result-MA")?.textContent).toContain("ok");
  });

  it("archive-mode partial failure: a later archivable id still executes after an earlier archiveMilestone rejects", async () => {
    const client = new ArchivePartialFailureClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testids("finalize-affected-")).toEqual(["MA", "MD"]);

    await holdFull(testid("finalize-execute"));

    // Mid-sweep continuation: MA's rejection did not prevent MD's write.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
      { op: "archiveMilestone", milestoneId: "MD", summary: "finalized: Delta" },
    ]);
    expect(testids("finalize-result-")).toEqual(["MA", "MD"]);
    expect(testid("finalize-result-MA")?.textContent).toContain("failed");
    expect(testid("finalize-result-MA")?.textContent).toContain("MA archive refused");
    expect(testid("finalize-result-MD")?.textContent).toContain("ok");
  });

  it("Escape dismisses the finalize preview modal at the PREVIEW step without executing anything", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testid("finalize-preview")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("finalize-preview")).toBeNull();
    // Dismissing at the preview step must not have fired any write.
    expect(client.calls).toEqual([]);
  });

  it("Escape dismisses the finalize preview modal at the RESULTS (summary) step without re-executing or reverting", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");
    await holdFull(testid("finalize-execute"));

    expect(testid("finalize-results")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("finalize-preview")).toBeNull();
    // The single sweep call from the hold-execute is unchanged by Escape —
    // dismissal at the results step neither re-runs nor reverts it.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
    ]);
  });

  it("does not regress the '+ milestone' create flow on the milestones view now that finalize-btn shares its toolbar row", async () => {
    const client = new MilestonesOnlyClient();
    await mount(client);
    click(testid("ledger-milestones"));
    await flush();

    // Both controls coexist in the toolbar.
    expect(testid("finalize-btn")).not.toBeNull();
    expect(testid("new-item-or-milestone")).not.toBeNull();

    click(testid("new-item-or-milestone"));
    await flush();
    setValue(testid("ms-title"), "Phase Two");
    await holdFull(testid("ms-create"));

    expect(testid("flash")?.textContent).toContain("created M2");
    expect(client.createMilestoneCalls).toEqual([{ title: "Phase Two" }]);
  });
});
