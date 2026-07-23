/**
 * T620 (goal G83): web finalize preview modal + HoldButton-gated execution.
 *
 * Drives <App> under happy-dom with a purpose-built recording client (modeled
 * on test/milestoneTransitions.test.tsx — the shared fakeClient.ts records no
 * updateMilestone/archiveMilestone calls) and the injectable FakeClock
 * (HoldClock) so holds advance deterministically. Covers:
 *  1. picking 'apply-done' opens the preview modal listing EXACTLY the
 *     eligible ids computed by computeApplyDonePlan from the fixture, plus
 *     every skipped id with its reason (Q289 — never 'do nothing' unexplained);
 *  2. a partial hold on the execute HoldButton fires nothing (Q292 gating);
 *     holding to HOLD_MS fires the sweep — the client records the
 *     updateMilestone/updateItem calls in plan order — and the modal swaps to
 *     a per-id result summary with one line per id, including the
 *     deliberately-failing id's error text;
 *  3. picking 'archive' previews the archive plan and executing it records
 *     archiveMilestone with the synthesized summary;
 *  4. an empty plan renders an explicit 'nothing eligible' state with the
 *     skipped list and NO execute button.
 *
 * Fixture (eligible variant): milestones M1 (open, all tasks done → close),
 * M2 (open, task T2 wip → skipped), M3 (done, all tasks done → archive
 * candidate, apply-done-skipped as already terminal); goals G1 (building,
 * milestones=[M1] → close), G2 (building, milestones=[M2] → skipped).
 * Apply-done affected: [M1, G1]. Archive affected: [M3].
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import { MILESTONES_SCHEMA } from "@cq/ledger/constants";
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

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  fields: { headline: { type: "string", required: true } },
};
// No `transitions` map: building → done is unguarded (matches the plan's
// transitionPermitted fallback).
const goalsSchema: LedgerSchema = {
  statusValues: ["shaping", "building", "done"],
  terminalStatuses: ["done"],
  idPrefix: "G",
  fields: {
    title: { type: "string", required: true },
    milestones: { type: "string[]", required: false },
  },
};

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

type RecordedCall =
  | { op: "updateMilestone"; milestoneId: string; status: string | undefined }
  | { op: "updateItem"; ledger: string; id: string; status: string | undefined }
  | { op: "archiveMilestone"; milestoneId: string; summary: string };

/**
 * Recording milestones+tasks+goals client. `eligible=false` swaps to a
 * fixture where NO id is actionable under either plan (only skips remain).
 */
class FinalizeClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];
  /** goals item ids whose updateItem rejects (deliberate per-id failure). */
  readonly failUpdateItemIds = new Set<string>();

  constructor(private readonly eligible = true) {}

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 2 },
      { name: "milestones", itemCount: 3 },
      { name: "tasks", itemCount: 3 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      const items = this.eligible
        ? [
            item("M1", "active", "open", { title: "Wave 1" }),
            item("M2", "active", "open", { title: "Wave 2" }),
            item("M3", "active", "done", { title: "Wave 3" }),
          ]
        : [item("M2", "active", "open", { title: "Wave 2" })];
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: items.length },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items,
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      const groups = this.eligible
        ? [
            { id: "M1", items: [item("T1", "M1", "done", { headline: "t1" })] },
            { id: "M2", items: [item("T2", "M2", "wip", { headline: "t2" })] },
            { id: "M3", items: [item("T3", "M3", "done", { headline: "t3" })] },
          ]
        : [{ id: "M2", items: [item("T2", "M2", "wip", { headline: "t2" })] }];
      return {
        id: "tasks",
        schema: tasksSchema,
        counters: { milestone: 1, item: 3 },
        milestones: groups.map((g) => ({
          id: g.id,
          milestone: { id: g.id, status: "open", title: g.id, description: "" },
          items: g.items,
        })),
        archivePointers: [],
      };
    }
    if (id === "goals") {
      const items = this.eligible
        ? [
            item("G1", "active", "building", { title: "Goal one", milestones: ["M1"] }),
            item("G2", "active", "building", { title: "Goal two", milestones: ["M2"] }),
          ]
        : [item("G2", "active", "building", { title: "Goal two", milestones: ["M2"] })];
      return {
        id: "goals",
        schema: goalsSchema,
        counters: { milestone: 1, item: items.length },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items,
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
    if (this.failUpdateItemIds.has(id)) throw new Error(`${id} refused`);
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
 * FinalizeClient whose fetchLedger can be parked (T620 review round 1): with
 * `defer` on, every call snapshots the fixture variant (`msId` substituted for
 * M1) at CALL time but resolves only on releaseMany(). Exercises the
 * generation-token guard against a stale fan-out from a dismissed session.
 */
class DeferredFinalizeClient extends FinalizeClient {
  defer = false;
  /** Id substituted for M1 in views built for NEW fetchLedger calls. */
  msId = "M1";
  private waiting: Array<() => void> = [];
  get pendingCount(): number { return this.waiting.length; }
  releaseMany(n: number): void {
    for (let i = 0; i < n; i++) {
      const release = this.waiting.shift();
      if (release === undefined) throw new Error("releaseMany: nothing pending");
      release();
    }
  }
  override async fetchLedger(id: string): Promise<FetchedLedger> {
    const base = await super.fetchLedger(id);
    const view =
      this.msId === "M1"
        ? base
        : (JSON.parse(JSON.stringify(base).replaceAll('"M1"', `"${this.msId}"`)) as FetchedLedger);
    if (!this.defer) return view;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return view;
  }
}

let container: HTMLElement;
let root: Root;
let fakeClient: FinalizeClient;
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
async function holdFull(el: Element | null): Promise<void> {
  if (el === null) throw new Error("holdFull: element not found");
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => { holdClock.advance(HOLD_MS); });
  await flush();
}

async function mount(client = new FinalizeClient()): Promise<void> {
  holdClock = new FakeClock();
  fakeClient = client;
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

async function openPreview(mode: "apply-done" | "archive"): Promise<void> {
  click(testid("ledger-milestones"));
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

describe("T620 — web finalize preview modal", () => {
  it("apply-done preview lists exactly the eligible ids plus every skipped id with its reason", async () => {
    await mount();
    await openPreview("apply-done");

    expect(testid("finalize-preview")).not.toBeNull();
    expect(testid("finalize-preview-mode")?.textContent).toBe("apply-done");
    // Exactly the plan's affected ids, in execution order (M1 close before G1).
    expect(testids("finalize-affected-")).toEqual(["M1", "G1"]);
    expect(testid("finalize-affected-M1")?.textContent).toContain("close-milestone");
    expect(testid("finalize-affected-G1")?.textContent).toContain("close-goal");
    // Every skipped candidate is listed with its reason (Q289).
    expect(new Set(testids("finalize-skipped-"))).toEqual(new Set(["M2", "M3", "G2"]));
    expect(testid("finalize-skipped-M2")?.textContent).toContain("non-terminal items");
    expect(testid("finalize-skipped-M3")?.textContent).toContain("already terminal");
    expect(testid("finalize-skipped-G2")?.textContent).toContain("incomplete work milestone");
    expect(testid("finalize-empty")).toBeNull();
  });

  it("holding to HOLD_MS fires the sweep in plan order and shows one result line per id incl. the failing one", async () => {
    const client = new FinalizeClient();
    client.failUpdateItemIds.add("G1");
    await mount(client);
    await openPreview("apply-done");

    // A partial hold must NOT fire (Q292 gating).
    const execute = testid("finalize-execute");
    expect(execute).not.toBeNull();
    act(() => {
      execute!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    act(() => { holdClock.advance(HOLD_MS / 2); });
    act(() => {
      execute!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(fakeClient.calls.length).toBe(0);

    await holdFull(testid("finalize-execute"));

    // The sweep ran in plan order: M1's milestone close, then G1's goal close.
    expect(fakeClient.calls).toEqual([
      { op: "updateMilestone", milestoneId: "M1", status: "done" },
      { op: "updateItem", ledger: "goals", id: "G1", status: "done" },
    ]);
    // Per-id result summary: one line per id, the failing one with its error.
    expect(testids("finalize-result-")).toEqual(["M1", "G1"]);
    expect(testid("finalize-result-M1")?.textContent).toContain("ok");
    expect(testid("finalize-result-G1")?.textContent).toContain("failed");
    expect(testid("finalize-result-G1")?.textContent).toContain("G1 refused");
    // The execute button is gone once the results summary is up.
    expect(testid("finalize-execute")).toBeNull();
  });

  it("archive preview lists the archivable milestone and executing records archiveMilestone", async () => {
    await mount();
    await openPreview("archive");

    expect(testid("finalize-preview-mode")?.textContent).toBe("archive");
    expect(testids("finalize-affected-")).toEqual(["M3"]);
    expect(testid("finalize-affected-M3")?.textContent).toContain("archive-milestone");
    expect(new Set(testids("finalize-skipped-"))).toEqual(new Set(["M1", "M2"]));

    await holdFull(testid("finalize-execute"));

    expect(fakeClient.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "M3", summary: "finalized: Wave 3" },
    ]);
    expect(testids("finalize-result-")).toEqual(["M3"]);
    expect(testid("finalize-result-M3")?.textContent).toContain("ok");
  });

  it("a stale fan-out resolve from a dismissed session cannot clobber a re-opened same-mode preview", async () => {
    const client = new DeferredFinalizeClient();
    await mount(client);
    click(testid("ledger-milestones"));
    await flush();

    // NOTE: element presence is asserted in boolean form throughout this test
    // (`=== null`) — a failing toBeNull() on a happy-dom element makes the
    // runner serialize the whole element tree into the diff, which is
    // pathologically slow.
    client.defer = true;
    click(testid("finalize-btn"));
    await flush();
    click(testid("finalize-option-apply-done"));
    await flush();
    expect(testid("finalize-loading") !== null).toBe(true);
    expect(client.pendingCount).toBe(3); // goals + milestones + tasks, parked

    // Dismiss while the fan-out is in flight…
    press("Escape");
    await flush();
    expect(testid("finalize-preview") === null).toBe(true);

    // …then reopen the SAME mode against a CHANGED fixture (M1 renamed M9).
    client.msId = "M9";
    click(testid("finalize-btn"));
    await flush();
    click(testid("finalize-option-apply-done"));
    await flush();
    expect(client.pendingCount).toBe(6);

    // Resolving the FIRST (stale) fan-out must not install its pre-reopen
    // plan into the new session — it still shows the loading step.
    client.releaseMany(3);
    await flush();
    expect(testid("finalize-affected-M1") === null).toBe(true);
    expect(testid("finalize-loading") !== null).toBe(true);

    // The SECOND fan-out's plan is the one that renders.
    client.releaseMany(3);
    await flush();
    expect(testids("finalize-affected-")).toEqual(["M9", "G1"]);
    expect(testid("finalize-affected-M1") === null).toBe(true);
  });

  it("an empty plan renders an explicit 'nothing eligible' state with the skipped list and no execute button", async () => {
    await mount(new FinalizeClient(false));
    await openPreview("apply-done");

    expect(testid("finalize-preview")).not.toBeNull();
    expect(testid("finalize-empty")?.textContent).toContain("nothing eligible");
    expect(testid("finalize-execute")).toBeNull();
    expect(new Set(testids("finalize-skipped-"))).toEqual(new Set(["M2", "G2"]));
    expect(fakeClient.calls.length).toBe(0);
  });
});
