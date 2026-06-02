/**
 * T85 — navigation-latency regression guard.
 *
 * The items frame re-renders on every keystroke. The O(N) list derivations
 * (filterVisibleRows → maxIdW/maxStatusW/columnWidths → buildItemEntries) used
 * to run inline in the render body, so a PURE cursor move recomputed all of
 * them — making nav latency scale O(N) in ledger size. They are now memoized
 * (App's useMemo keyed on view/filter/showArchive/archiveRows/ledger/columns),
 * so a cursor move does ZERO O(N) work.
 *
 * This test instruments the builders via `derivationCounters` and asserts:
 *   (1) opening a ledger builds each derivation a bounded, small number of times
 *       (one data-driven build; not per row);
 *   (2) moving the cursor N times across a large (N≈500) ledger adds ZERO
 *       further builder invocations.
 *
 * Reproduction discipline: with the memoization removed (derivations inline in
 * the render body), assertion (2) FAILS — every keystroke re-invokes all three
 * builders, so the post-nav counts grow by ~N. Verified manually by reverting
 * the useMemo wrapper; restored before commit.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App, derivationCounters, resetDerivationCounters } from "../src/app.js";
import type {
  ArchiveContent,
  FetchedLedger,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSummary,
  LedgerSchema,
  MilestonePatch,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";
const ENTER = "\r";
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the instrumented builders go QUIESCENT — i.e. the total invocation
 * count stops changing across a full poll interval. The mount/data-load path
 * fires a bounded burst of data-driven builds whose timing varies with N and
 * CPU load; polling for stability (rather than a fixed sleep) ensures no
 * trailing settle-render lands in a later measurement window, making the
 * counter assertions deterministic under full-suite contention.
 */
async function waitQuiescent(): Promise<void> {
  let prev = -1;
  for (let i = 0; i < 200; i++) {
    const cur =
      derivationCounters.filterVisibleRows +
      derivationCounters.computeColumnLayout +
      derivationCounters.buildItemEntries;
    if (cur === prev) return; // stable across one full poll interval
    prev = cur;
    await tick(15);
  }
}

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  transitions: { planned: ["wip", "done"], wip: ["done"], done: [] },
  fields: {
    headline: { type: "string", required: true },
    suggestedModel: { type: "string", required: false },
  },
};

/**
 * Minimal LedgerClient serving ONE tasks ledger with `n` items under a single
 * milestone group. Only the methods the items render/nav path exercises are
 * implemented; the rest throw (they are not reached during navigation).
 */
class LargeClient implements LedgerClient {
  constructor(private readonly n: number) {}
  displayName(): string {
    return "big";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "tasks", itemCount: this.n }];
  }
  async fetchLedger(_ledgerId: string): Promise<FetchedLedger> {
    const items: Item[] = Array.from({ length: this.n }, (_, i) => ({
      id: `T${i + 1}`,
      milestoneId: "M1",
      status: i % 2 === 0 ? "planned" : "wip",
      fields: { headline: `task ${i + 1}`, suggestedModel: "opus" },
      createdAt: TS,
      updatedAt: TS,
    }));
    return {
      id: "tasks",
      schema: tasksSchema,
      counters: { milestone: 2, item: this.n + 1 },
      milestones: [
        { id: "M1", milestone: { id: "M1", status: "open", title: "Big", description: "" }, items },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not implemented");
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not implemented");
  }
  async createItem(_l: string, _m: string, _init: ItemInit): Promise<Item> {
    throw new Error("not implemented");
  }
  async updateItem(_l: string, _id: string, _p: ItemPatch): Promise<Item> {
    throw new Error("not implemented");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not implemented");
  }
  async updateMilestone(_id: string, _p: MilestonePatch): Promise<Item> {
    throw new Error("not implemented");
  }
  async close(): Promise<void> {}
}

describe("ledger-tui navigation memoization (T85)", () => {
  it("heavy derivations run once per data-change, NOT per cursor move (N=500)", async () => {
    const N = 500;
    const NAV = 40; // cursor moves to perform
    const client = new LargeClient(N);
    const r = render(<App client={client} />);
    await tick(); // enumerateLedgers resolves

    // `derivationCounters` is module-global and shared across every test file in
    // the bun process, so it arrives here already polluted by prior tests' App
    // renders. Reset BEFORE opening the ledger so the mount-cap assertion counts
    // only this test's data-driven builds (not cross-file accumulation).
    resetDerivationCounters();
    r.stdin.write(ENTER); // open the only ledger (tasks)
    // Wait for the items frame to settle (first item id visible).
    for (let i = 0; i < 100 && !(r.lastFrame() ?? "").includes("T1"); i++) await tick(10);
    expect(r.lastFrame() ?? "").toContain("T1");
    await waitQuiescent(); // let ALL settle-time re-renders flush before measuring

    // The data-driven build happened a bounded, small number of times — and
    // crucially NOT proportional to N. Allow a few re-renders during mount.
    const MOUNT_BUILD_CAP = 8;
    expect(derivationCounters.filterVisibleRows).toBeLessThanOrEqual(MOUNT_BUILD_CAP);
    expect(derivationCounters.computeColumnLayout).toBeLessThanOrEqual(MOUNT_BUILD_CAP);
    expect(derivationCounters.buildItemEntries).toBeLessThanOrEqual(MOUNT_BUILD_CAP);

    // Snapshot the counters, then move the cursor NAV times with NO data change.
    resetDerivationCounters();
    for (let i = 0; i < NAV; i++) {
      r.stdin.write("j"); // down (vim)
      await tick(8);
    }
    await tick(30);

    // A pure cursor move must NOT re-invoke any heavy derivation.
    expect(derivationCounters.filterVisibleRows).toBe(0);
    expect(derivationCounters.computeColumnLayout).toBe(0);
    expect(derivationCounters.buildItemEntries).toBe(0);

    r.unmount();
  });

  it("a data change (status filter) DOES re-run the derivations", async () => {
    const client = new LargeClient(50);
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks
    for (let i = 0; i < 100 && !(r.lastFrame() ?? "").includes("T1"); i++) await tick(10);
    await waitQuiescent();

    resetDerivationCounters();
    // Open the filter overlay and pick a non-"all" filter. The overlay's first
    // option after "all" is a concrete status; pressing Down then Enter applies
    // it, which changes `filter` → the memo must recompute.
    r.stdin.write("f");
    await tick(20);
    r.stdin.write("[B"); // move selection within the filter list
    await tick(20);
    r.stdin.write(ENTER); // apply the picked filter
    for (let i = 0; i < 100 && (r.lastFrame() ?? "").indexOf("[") === -1; i++) await tick(10);
    await tick(30);

    // Changing the filter is a data change: each derivation re-ran at least once.
    expect(derivationCounters.filterVisibleRows).toBeGreaterThan(0);
    expect(derivationCounters.computeColumnLayout).toBeGreaterThan(0);
    expect(derivationCounters.buildItemEntries).toBeGreaterThan(0);

    r.unmount();
  });
});
