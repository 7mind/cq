/**
 * D12: archived milestones surface as single titled rows in the milestones-ledger
 * ItemTable (not as duplicate ArchiveSubsections).
 *
 * Exercises the T109 backfill path: the FakeClient emits archivePointers with
 * title+status already populated (as the server does post-T109). The row must
 * render the pointer's `title` field, NOT fall back to the bare id.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type { ItemProjection } from "../src/types.js";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush(); // resolve connect + enumerateLedgers
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

describe("D12: archived milestones as rows in milestones-ledger ItemTable", () => {
  it("archived milestone renders as exactly ONE row per archivePointer in the flat ItemTable", async () => {
    // FakeClient.archives.milestones has one pointer: MA1 with title "Old Phase", status "done".
    // This simulates the server post-T109 which backfills title+status from the milestones ledger.
    await mount();
    click(testid("ledger-milestones"));
    await flush();

    // Enable show-archived.
    click(testid("toggle-archive"));
    await flush();

    // The archived milestone row must appear in the flat ItemTable.
    const archivedRow = testid("item-MA1");
    expect(archivedRow).not.toBeNull();

    // CRITICAL (R95 criticism 2): the row must show the reconstructed TITLE ("Old Phase"),
    // NOT fall back to the bare id ("MA1"). This test would FAIL if the row used p.id
    // instead of p.title as the summary cell content.
    expect(archivedRow?.textContent).toContain("Old Phase");
    expect(archivedRow?.textContent).not.toMatch(/^MA1\s*MA1/);
  });

  it("archived milestone row carries a status badge (from pointer.status via T109 backfill)", async () => {
    await mount();
    click(testid("ledger-milestones"));
    await flush();
    click(testid("toggle-archive"));
    await flush();

    // The status badge for MA1 must be present.
    const badge = testid("status-MA1");
    expect(badge).not.toBeNull();
    // pointer.status is "done" → lw-status-done bucket.
    expect(badge?.className).toContain("lw-status");
    expect(badge?.className).toContain("lw-status-done");
    expect(badge?.textContent).toBe("done");
  });

  it("archived milestone row id cell contains only the id (no inline archived badge)", async () => {
    await mount();
    click(testid("ledger-milestones"));
    await flush();
    click(testid("toggle-archive"));
    await flush();

    // The lw-archived-badge was removed from the id cell (D17 fix).
    expect(testid("archived-badge-MA1")).toBeNull();

    // The id cell (2nd td) must contain only the id text, no badge wrapping it.
    const archivedRow = testid("item-MA1");
    const idCell = archivedRow?.querySelectorAll("td")[1];
    expect(idCell?.textContent?.trim()).toBe("MA1");
  });

  it("milestones ledger does NOT render ArchiveSubsections (no archive-section or ms-section-MA1 duplicate)", async () => {
    // D7's !isMilestones gate at App.tsx (ArchiveSubsections render condition) must be preserved.
    await mount();
    click(testid("ledger-milestones"));
    await flush();
    click(testid("toggle-archive"));
    await flush();

    // No archive-section (ArchiveSubsections) must appear.
    expect(testid("archive-section")).toBeNull();
    // No duplicate ms-section-MA1 per-milestone section.
    expect(testid("ms-section-MA1")).toBeNull();
    // Active M1 row is still present (regression guard).
    expect(testid("item-M1")).not.toBeNull();
    // The archived MA1 row is present in the flat table (single occurrence).
    expect(testid("item-MA1")).not.toBeNull();
  });

  it("archived rows are absent when show-archived is off", async () => {
    await mount();
    click(testid("ledger-milestones"));
    await flush();

    // Without enabling the toggle, no archived row.
    expect(testid("item-MA1")).toBeNull();
  });

  it("title fallback: row shows bare id only when pointer.title is empty (backward compat)", async () => {
    // Simulate a legacy pointer (pre-T109) with empty title. The row should fall
    // back to the bare id so the table still renders something.
    await mount();

    const origFetch = fake.fetchLedger.bind(fake);
    fake.fetchLedger = async (id: string, projection: ItemProjection) => {
      const v = await origFetch(id, projection);
      if (id === "milestones") {
        return {
          ...v,
          archivePointers: v.archivePointers.map((p) =>
            p.id === "MA1" ? { ...p, title: "" } : p,
          ),
        };
      }
      return v;
    };

    click(testid("ledger-milestones"));
    await flush();
    click(testid("toggle-archive"));
    await flush();

    // Row is still present.
    const archivedRow = testid("item-MA1");
    expect(archivedRow).not.toBeNull();
    // Summary cell shows the id (fallback) since title is empty.
    // The summary cell is the 4th td.
    const tds = archivedRow?.querySelectorAll("td");
    expect(tds?.[3]?.textContent).toBe("MA1");
  });
});
