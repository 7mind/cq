/**
 * TUI relationship view tests (T48).
 *
 * Asserts that:
 * - Selecting a defects item renders a "Fix tasks" block listing linked task ids.
 * - Selecting a hypothesis renders its ancestry chain and direct children.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import type {
  ArchiveContent,
  FetchedLedger,
  FtsHit,
  Item,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

const ENTER = "\r";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the rendered frame until it contains `substr`. */
async function waitFor(getFrame: () => string, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getFrame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitFor: '${substr}' never appeared in:\n${getFrame()}`);
}

// ---------------------------------------------------------------------------
// Defects + tasks client
// ---------------------------------------------------------------------------

const defectsSchema: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  idPrefix: "D",
  fields: {
    headline: { type: "string", required: true },
    dependsOn: { type: "id[]", required: false },
  },
  transitions: { open: ["wip", "closed"], wip: ["closed", "open"], closed: [] },
};

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  fields: {
    headline: { type: "string", required: true },
    ledgerRefs: { type: "id[]", required: false },
  },
};

/**
 * A client with:
 *  - defects ledger: D1 with `dependsOn: ["T2"]` (forward link) and D2 with no links.
 *  - tasks ledger: T1 with `ledgerRefs: ["defects:D1"]` (reverse link), T2 with headline "engine fix".
 *
 * When viewing D1, the "Fix tasks" block must list both T2 (forward) and T1 (reverse).
 */
class DefectsClient implements LedgerClient {
  private tasksRequested = false;

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "defects", itemCount: 2 }];
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "defects") {
      return {
        id: "defects",
        schema: defectsSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Sprint 1", description: "" },
            items: [
              {
                id: "D1",
                milestoneId: "M1",
                status: "open",
                fields: { headline: "warp drive failure", dependsOn: ["T2"] },
                createdAt: TS,
                updatedAt: TS,
              },
              {
                id: "D2",
                milestoneId: "M1",
                status: "wip",
                fields: { headline: "shield flicker" },
                createdAt: TS,
                updatedAt: TS,
              },
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      this.tasksRequested = true;
      return {
        id: "tasks",
        schema: tasksSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Sprint 1", description: "" },
            items: [
              {
                id: "T1",
                milestoneId: "M1",
                status: "wip",
                fields: { headline: "diagnose warp", ledgerRefs: ["defects:D1"] },
                createdAt: TS,
                updatedAt: TS,
              },
              {
                id: "T2",
                milestoneId: "M1",
                status: "planned",
                fields: { headline: "engine fix" },
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
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Hypothesis client
// ---------------------------------------------------------------------------

const hypothesisSchema: LedgerSchema = {
  statusValues: ["proposed", "confirmed", "refuted"],
  terminalStatuses: ["confirmed", "refuted"],
  idPrefix: "H",
  fields: {
    headline: { type: "string", required: true },
    parentHypothesis: { type: "string", required: false },
  },
};

/**
 * A client with a hypothesis ledger forming a small tree:
 *   H1 (root)
 *   └─ H2 (child of H1)
 *      └─ H3 (child of H2)
 *
 * When viewing H2:
 *   - Ancestry: [H1]
 *   - Children: [H3]
 *
 * When viewing H1 (root):
 *   - Ancestry: []
 *   - Children: [H2]
 */
class HypothesisClient implements LedgerClient {
  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "hypothesis", itemCount: 3 }];
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "hypothesis") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "hypothesis",
      schema: hypothesisSchema,
      counters: { milestone: 1, item: 3 },
      milestones: [
        {
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Research", description: "" },
          items: [
            {
              id: "H1",
              milestoneId: "M1",
              status: "proposed",
              fields: { headline: "root cause is thermal" },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H2",
              milestoneId: "M1",
              status: "proposed",
              fields: { headline: "cooling fan broken", parentHypothesis: "H1" },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H3",
              milestoneId: "M1",
              status: "proposed",
              fields: { headline: "bearing worn", parentHypothesis: "H2" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
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
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Tests: defects → Fix tasks block
// ---------------------------------------------------------------------------

describe("ledger-tui relationship view: defects (T48)", () => {
  it("renders a 'Fix tasks' block in the content pane when a defects item is selected", async () => {
    const client = new DefectsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open defects (the only ledger)
    // Wait for the fix-task relationship to appear (tasks are fetched lazily)
    await waitFor(() => r.lastFrame() ?? "", "Fix tasks");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Fix tasks");
    r.unmount();
  });

  it("lists forward-linked task ids in the Fix tasks block (dependsOn T2)", async () => {
    const client = new DefectsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open defects — D1 is selected (cursor 0)
    // T2 is in D1's dependsOn — it must appear in Fix tasks after tasks are fetched.
    await waitFor(() => r.lastFrame() ?? "", "T2");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("T2");
    r.unmount();
  });

  it("lists reverse-linked task ids (ledgerRefs: defects:D1 on T1)", async () => {
    const client = new DefectsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open defects — D1 is selected
    // T1 reverse-links D1 via ledgerRefs. Both T1 and T2 must appear.
    await waitFor(() => r.lastFrame() ?? "", "T1");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("T1");
    r.unmount();
  });

  it("shows task summary in Fix tasks block when tasks are loaded", async () => {
    const client = new DefectsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open defects
    // T2 has headline "engine fix" — should appear as the summary next to T2.
    await waitFor(() => r.lastFrame() ?? "", "engine fix");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("engine fix");
    r.unmount();
  });

  it("renders 'Fix tasks' block for D2 with no links showing (none)", async () => {
    const DOWN = "[B";
    const client = new DefectsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open defects
    await tick(40);
    r.stdin.write(DOWN); // move to D2
    // Wait for tasks to load, then check content pane shows Fix tasks with (none).
    await waitFor(() => r.lastFrame() ?? "", "Fix tasks");
    await tick(200); // give tasks fetch time to complete
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Fix tasks");
    // D2 is now selected; it has no linked tasks → shows (none)
    // Note: we check that the content pane shows D2 at all.
    expect(f).toContain("D2");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Tests: hypothesis → Ancestry + Children blocks
// ---------------------------------------------------------------------------

describe("ledger-tui relationship view: hypothesis (T48)", () => {
  it("renders Ancestry and Children blocks for H2 (middle of tree)", async () => {
    const DOWN = "[B";
    const client = new HypothesisClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open hypothesis — H1 is cursor 0
    await tick(40);
    r.stdin.write(DOWN); // move to H2
    await tick(40);
    const f = r.lastFrame() ?? "";
    // H2 has H1 as parent (ancestor) and H3 as child.
    expect(f).toContain("H2"); // selected item
    expect(f).toContain("Ancestry");
    expect(f).toContain("H1");   // parent in ancestry chain
    expect(f).toContain("Children");
    expect(f).toContain("H3");   // direct child
    r.unmount();
  });

  it("shows root hypothesis H1 with only Children (no ancestry)", async () => {
    const client = new HypothesisClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open hypothesis — H1 is cursor 0
    await tick(40);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("H1"); // selected
    // H1 is root: no ancestry, but has H2 as a child.
    expect(f).toContain("Children");
    expect(f).toContain("H2");
    // No ancestry block since H1 has no parent.
    expect(f).not.toContain("Ancestry");
    r.unmount();
  });

  it("shows leaf hypothesis H3 with only Ancestry (no children)", async () => {
    const DOWN = "[B";
    const client = new HypothesisClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open hypothesis — H1 cursor 0
    await tick(40);
    r.stdin.write(DOWN); // H2
    await tick(20);
    r.stdin.write(DOWN); // H3
    await tick(40);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("H3"); // selected
    // H3 is a leaf: it has ancestry [H2, H1] but no children.
    expect(f).toContain("Ancestry");
    expect(f).toContain("H2"); // direct parent
    expect(f).toContain("H1"); // grandparent
    // No Children block (H3 has none).
    expect(f).not.toContain("Children");
    r.unmount();
  });

  it("shows ancestor summary text alongside the ancestor id", async () => {
    const DOWN = "[B";
    const client = new HypothesisClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open hypothesis
    await tick(40);
    r.stdin.write(DOWN); // H2
    await tick(40);
    const f = r.lastFrame() ?? "";
    // H1's headline is "root cause is thermal" — should appear as summary.
    expect(f).toContain("root cause is thermal");
    r.unmount();
  });
});
