/**
 * TUI researches detail view tests (T561, G80/M246, Q262).
 *
 * Asserts that selecting a `researches` item renders:
 *  - its question/scope/findings/conclusion/recommendation fields, and
 *  - a "Hypothesis tree" block listing every hypothesis whose `ledgerRefs`
 *    contains `researches:<id>`, nested by `parentHypothesis`.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import type {
  ArchiveContent,
  ArchivePointer,
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

const researchesSchema: LedgerSchema = {
  statusValues: ["open", "wip", "concluded", "inconclusive", "abandoned"],
  terminalStatuses: ["concluded", "abandoned"],
  idPrefix: "RS",
  fields: {
    question: { type: "string", required: true },
    scope: { type: "string", required: false },
    findings: { type: "string", required: false },
    conclusion: { type: "string", required: false },
    recommendation: { type: "string", required: false },
  },
  transitions: {
    open: ["wip", "abandoned"],
    wip: ["concluded", "inconclusive", "abandoned"],
    inconclusive: ["wip", "abandoned"],
    concluded: [],
    abandoned: [],
  },
};

const hypothesisSchema: LedgerSchema = {
  statusValues: ["open", "confirmed", "wrong"],
  terminalStatuses: ["confirmed", "wrong"],
  idPrefix: "H",
  fields: {
    headline: { type: "string", required: true },
    parentHypothesis: { type: "string", required: false },
    ledgerRefs: { type: "id[]", required: false },
  },
};

/**
 * A client with:
 *  - a "researches" ledger: RS1, the only ledger (cursor 0 on open).
 *  - a "hypothesis" ledger: H1 (root, ledgerRefs=["researches:RS1"]) → H2
 *    (child of H1, same ledgerRefs) — both linked to RS1.
 */
class ResearchClient implements LedgerClient {
  private hypothesisRequested = false;

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "researches", itemCount: 1 }];
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "researches") {
      return {
        id: "researches",
        schema: researchesSchema,
        counters: { milestone: 1, item: 1 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Research", description: "" },
            items: [
              {
                id: "RS1",
                milestoneId: "M1",
                status: "concluded",
                fields: {
                  question: "does the widget leak memory?",
                  scope: "widget subsystem",
                  findings: "leak in the pool",
                  conclusion: "pool never releases",
                  recommendation: "release eagerly",
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
    if (id === "hypothesis") {
      this.hypothesisRequested = true;
      return {
        id: "hypothesis",
        schema: hypothesisSchema,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Research", description: "" },
            items: [
              {
                id: "H1",
                milestoneId: "M1",
                status: "confirmed",
                fields: { headline: "root cause is thermal", ledgerRefs: ["researches:RS1"] },
                createdAt: TS,
                updatedAt: TS,
              },
              {
                id: "H2",
                milestoneId: "M1",
                status: "open",
                fields: {
                  headline: "narrower sub-claim",
                  parentHypothesis: "H1",
                  ledgerRefs: ["researches:RS1"],
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
    throw new Error(`Ledger not found: ${id}`);
  }

  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(): Promise<ArchivePointer> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

describe("ledger-tui researches detail view (T561)", () => {
  it("renders the research's own fields (question/scope/findings/conclusion/recommendation)", async () => {
    const client = new ResearchClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open researches — RS1 is cursor 0
    await waitFor(() => r.lastFrame() ?? "", "does the widget leak memory?");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("widget subsystem");
    expect(f).toContain("leak in the pool");
    expect(f).toContain("pool never releases");
    expect(f).toContain("release eagerly");
    r.unmount();
  });

  it("renders a 'Hypothesis tree' block listing every linked hypothesis", async () => {
    const client = new ResearchClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open researches — RS1 is cursor 0
    // Hypotheses are fetched lazily — wait for the block heading.
    await waitFor(() => r.lastFrame() ?? "", "Hypothesis tree");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("Hypothesis tree");
    expect(f).toContain("H1");
    expect(f).toContain("H2");
    r.unmount();
  });

  it("indents H2 deeper than H1 (nested child, not a flat sibling root)", async () => {
    const client = new ResearchClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open researches — RS1 is cursor 0
    await waitFor(() => r.lastFrame() ?? "", "Hypothesis tree");
    const f = r.lastFrame() ?? "";
    // relRow indents 2 spaces per depth level: H1 (root, depth 1) renders at
    // a shallower column than H2 (its child, depth 2). A regression rendering
    // the forest FLAT would place both ids at the SAME column and fail here.
    // Match "H1 ["/"H2 [" (id + status-opening-bracket) so the id is only
    // found on its tree row, not elsewhere in the frame.
    const lines = f.split("\n");
    const h1Line = lines.find((l) => l.includes("H1 ["));
    const h2Line = lines.find((l) => l.includes("H2 ["));
    expect(h1Line).toBeDefined();
    expect(h2Line).toBeDefined();
    expect(h2Line!.indexOf("H2 [")).toBeGreaterThan(h1Line!.indexOf("H1 ["));
    r.unmount();
  });

  it("shows hypothesis summaries alongside their ids in the tree block", async () => {
    const client = new ResearchClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER);
    await waitFor(() => r.lastFrame() ?? "", "root cause is thermal");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("root cause is thermal");
    r.unmount();
  });
});
