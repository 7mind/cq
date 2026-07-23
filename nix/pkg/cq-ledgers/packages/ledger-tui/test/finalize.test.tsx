/**
 * T621 — the TUI finalize overlay (G83): `F` on the goals/milestones frames
 * opens a two-option select (Q291), selection computes the shared
 * `@cq/ledger/finalize` plan and shows the preview (the SAME id list the web
 * preview shows, Q292, plus skipped reasons), Enter executes through the
 * client (updateMilestone / updateItem / archiveMilestone) and the results
 * step lists per-id ok/failed. Esc cancels at every step.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import type {
  ArchiveContent,
  ArchivePointer,
  FetchedLedger,
  Item,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  MilestonePatch,
} from "../src/types.js";

const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

const TS = "2026-01-01T00:00:00.000Z";

const PICK_APPLY = "Apply Done to completed items";
const PICK_ARCHIVE = "Archive all Done items";

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  frame: () => string;
  key: (s: string) => Promise<void>;
  unmount: () => void;
}

async function mount(client: LedgerClient): Promise<Harness> {
  const r = render(<App client={client} />);
  await tick();
  return {
    frame: () => r.lastFrame() ?? "",
    key: async (s: string) => {
      r.stdin.write(s);
      await tick();
    },
    unmount: r.unmount,
  };
}

async function waitFor(h: Harness, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitFor: '${substr}' never appeared; frame:\n${h.frame()}`);
}

/**
 * Advance one overlay step by pressing Enter, resilient to a dropped
 * keystroke (cf. app.test.tsx's `advance`, D23): a freshly-mounted step can
 * miss an Enter that arrives before its input handler attaches. Re-presses
 * only while `still` is showing and `done` has not appeared, so it never
 * overshoots (the execute step is additionally guarded in-component).
 */
async function advance(h: Harness, still: string, done: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(done)) return;
    if (h.frame().includes(still)) await h.key(ENTER);
    else await tick(10);
  }
  throw new Error(`advance: '${done}' never appeared (stuck on '${still}'); frame:\n${h.frame()}`);
}

/** Press Esc until `marker` disappears from the frame (drop-resilient). */
async function escapeUntilGone(h: Harness, marker: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!h.frame().includes(marker)) return;
    await h.key(ESC);
  }
  throw new Error(`escapeUntilGone: '${marker}' still showing; frame:\n${h.frame()}`);
}

const milestonesSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { title: { type: "string", required: true } },
  idPrefix: "M",
};

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
  idPrefix: "T",
};

function item(id: string, milestoneId: string, status: string, fields: Record<string, string>): Item {
  return { id, milestoneId, status, fields, createdAt: TS, updatedAt: TS };
}

/**
 * Eligible fixture: M1 (open, "Alpha") has only terminal work → apply-done
 * closes it; M2 (done, "Beta") is fully terminal AND itself done → archive
 * sweeps it. Records every updateMilestone/archiveMilestone call.
 */
class EligibleClient implements LedgerClient {
  milestoneUpdates: Array<[string, MilestonePatch]> = [];
  archives: Array<[string, string]> = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              item("M1", "active", "open", { title: "Alpha" }),
              item("M2", "active", "done", { title: "Beta" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Alpha", description: "" },
            items: [item("T1", "M1", "done", { headline: "shipped" })],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "done", title: "Beta", description: "" },
            items: [item("T2", "M2", "done", { headline: "also shipped" })],
          },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<Item> {
    throw new Error("not used");
  }
  async updateItem(): Promise<Item> {
    throw new Error("not used");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.milestoneUpdates.push([milestoneId, patch]);
    return item(milestoneId, "active", patch.status ?? "open", { title: "Alpha" });
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.archives.push([milestoneId, summary]);
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: "Beta", status: "done" };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/**
 * Partial-failure fixture (review round 1): TWO apply-done-eligible
 * milestones — M1 (open, "Alpha") and M2 (open, "Gamma") — each with only
 * terminal work. `updateMilestone` REJECTS for M1 and succeeds for M2, so a
 * sweep must continue past the failure (Q292 mid-sweep continuation) and the
 * results step must render the per-id failed/ok split. Every attempt is
 * recorded, success or not.
 */
class PartialFailureClient implements LedgerClient {
  attempts: Array<[string, MilestonePatch]> = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              item("M1", "active", "open", { title: "Alpha" }),
              item("M2", "active", "open", { title: "Gamma" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Alpha", description: "" },
            items: [item("T1", "M1", "done", { headline: "shipped" })],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "open", title: "Gamma", description: "" },
            items: [item("T2", "M2", "done", { headline: "also shipped" })],
          },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<Item> {
    throw new Error("not used");
  }
  async updateItem(): Promise<Item> {
    throw new Error("not used");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.attempts.push([milestoneId, patch]);
    if (milestoneId === "M1") throw new Error("disk on fire");
    return item(milestoneId, "active", patch.status ?? "open", { title: "Gamma" });
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/** Open the milestones frame of the default FakeClient (ledgers sort: bugs,
 * milestones, questions, reviews, tasks → milestones is index 1). */
async function openFakeMilestones(h: Harness): Promise<void> {
  await h.key(DOWN);
  await h.key(ENTER);
  await waitFor(h, "M1");
}

describe("TUI finalize overlay (T621)", () => {
  it("F on the milestones frame opens the two-option select; Esc closes it", async () => {
    const h = await mount(new FakeClient());
    await openFakeMilestones(h);
    expect(h.frame()).toContain("F finalize"); // footer hint
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    expect(h.frame()).toContain(PICK_ARCHIVE);
    await escapeUntilGone(h, PICK_APPLY); // Esc closes at the pick step
    h.unmount();
  });

  it("F is inert (and unadvertised) on a non-gated ledger frame", async () => {
    const h = await mount(new FakeClient());
    await h.key(ENTER); // open bugs (index 0)
    await waitFor(h, "D1");
    expect(h.frame()).not.toContain("F finalize");
    await h.key("F");
    await tick(30);
    expect(h.frame()).not.toContain(PICK_APPLY);
    h.unmount();
  });

  it("non-eligible fixture: preview shows the 'nothing eligible' state with the skipped list; Esc closes", async () => {
    // FakeClient's M1 has open bugs/tasks under it → nothing is actionable.
    const h = await mount(new FakeClient());
    await openFakeMilestones(h);
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "nothing eligible"); // pick apply-done
    // Skipped reasons are listed (M1 blocked by a non-terminal item).
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("non-terminal items");
    await escapeUntilGone(h, "nothing eligible"); // Esc closes at the preview step
    h.unmount();
  });

  it("apply-done: preview lists the plan ids, Enter executes updateMilestone, results list per id", async () => {
    const client = new EligibleClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones (index 0)
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "close-milestone"); // pick apply-done → preview
    // The same computed id list the web preview shows (Q292) + skipped reasons.
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("already terminal"); // M2 skipped
    await advance(h, "Enter execute", "finalize · results"); // execute
    expect(client.milestoneUpdates).toEqual([["M1", { status: "done" }]]);
    await waitFor(h, "ok");
    expect(h.frame()).toContain("M1");
    await escapeUntilGone(h, "finalize · results"); // Esc closes at the results step
    expect(h.frame()).not.toContain("close-milestone");
    h.unmount();
  });

  it("partial failure: the sweep continues past a rejecting id and results render the per-id failed/ok split", async () => {
    const client = new PartialFailureClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones (index 0)
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "close-milestone"); // pick apply-done → preview
    // Both milestones are eligible — the preview lists both.
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("M2");
    await advance(h, "Enter execute", "finalize · results"); // execute
    // Mid-sweep continuation: M1's rejection did not stop the M2 write.
    expect(client.attempts).toEqual([
      ["M1", { status: "done" }],
      ["M2", { status: "done" }],
    ]);
    // Per-id split: the rejecting id shows the failed marker + its error
    // text; the later id shows ok. Both ids are listed.
    expect(h.frame()).toContain("failed M1");
    expect(h.frame()).toContain("disk on fire");
    expect(h.frame()).toMatch(/ok\s+M2/);
    // Footer counts the failures.
    expect(h.frame()).toContain("1 failed");
    h.unmount();
  });

  it("archive: Enter drives archiveMilestone with the synthesized summary and lists the id in results", async () => {
    const client = new EligibleClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_ARCHIVE);
    // Move the pick cursor to the archive option (drop-resilient).
    {
      const end = Date.now() + 2000;
      while (!h.frame().includes(`› ${PICK_ARCHIVE}`) && Date.now() < end) await h.key(DOWN);
    }
    await advance(h, `› ${PICK_ARCHIVE}`, "finalize · archive"); // pick archive → preview
    await waitFor(h, "archive-milestone");
    expect(h.frame()).toContain("M2");
    expect(h.frame()).toContain("milestone status not terminal"); // M1 skipped
    await advance(h, "Enter execute", "finalize · results"); // execute
    expect(client.archives).toEqual([["M2", "finalized: Beta"]]);
    expect(h.frame()).toContain("M2");
    expect(h.frame()).toContain("ok");
    h.unmount();
  });
});
