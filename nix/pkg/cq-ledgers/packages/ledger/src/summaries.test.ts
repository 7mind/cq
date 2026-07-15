/**
 * Unit tests for the shared `computeLedgerSummaries` (G76 / T532), lifted
 * out of `./mcp/ledgerTools.ts` and `./mcp/stdioLedgerTools.ts`.
 *
 * Covers the same semantics the two MCP handlers used to implement
 * privately: questions-ledger done=`answered`/total=itemCount-`withdrawn`;
 * every other ledger done=sum of schema.terminalStatuses/total=itemCount.
 */

import { describe, it, expect } from "bun:test";
import { InMemoryLedgerStore } from "./store/InMemoryLedgerStore.js";
import { computeLedgerSummaries } from "./summaries.js";
import { QUESTIONS_LEDGER, TASKS_LEDGER, DEFECTS_LEDGER } from "./constants.js";

async function buildStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore({});
  await store.init();
  return store;
}

function find(
  result: ReturnType<typeof computeLedgerSummaries>,
  name: string,
) {
  const summary = result.ledgerSummaries.find((s) => s.name === name);
  if (summary === undefined) throw new Error(`no summary for ${name}`);
  return summary;
}

describe("computeLedgerSummaries", () => {
  it("questions ledger: done=answered, total=itemCount-withdrawn (open/answered/withdrawn mix)", async () => {
    const store = await buildStore();
    await store.createMilestone({ title: "M" });

    await store.createItem(QUESTIONS_LEDGER, "M1", {
      status: "open",
      fields: { question: "q1" },
    });
    await store.createItem(QUESTIONS_LEDGER, "M1", {
      status: "answered",
      fields: { question: "q2", answer: "a2" },
    });
    await store.createItem(QUESTIONS_LEDGER, "M1", {
      status: "answered",
      fields: { question: "q3", answer: "a3" },
    });
    await store.createItem(QUESTIONS_LEDGER, "M1", {
      status: "withdrawn",
      fields: { question: "q4" },
    });

    const result = computeLedgerSummaries(store);
    const qs = find(result, QUESTIONS_LEDGER);

    expect(qs.itemCount).toBe(4);
    expect(qs.statusCounts).toEqual({ open: 1, answered: 2, withdrawn: 1 });
    // done = answered only (NOT withdrawn, though it is also terminal).
    expect(qs.completedCount).toBe(2);
    // total = itemCount(4) - withdrawn(1) = 3.
    expect(qs.progressTotal).toBe(3);
    expect(result.counts[QUESTIONS_LEDGER]).toBe(4);
    expect(result.ledgers).toContain(QUESTIONS_LEDGER);
  });

  it("tasks ledger: done = sum of terminalStatuses (done + abandoned)", async () => {
    const store = await buildStore();
    await store.createMilestone({ title: "M" });

    await store.createItem(TASKS_LEDGER, "M1", {
      status: "done",
      fields: { headline: "t1" },
    });
    await store.createItem(TASKS_LEDGER, "M1", {
      status: "abandoned",
      fields: { headline: "t2" },
    });
    await store.createItem(TASKS_LEDGER, "M1", {
      status: "wip",
      fields: { headline: "t3" },
    });
    await store.createItem(TASKS_LEDGER, "M1", {
      status: "planned",
      fields: { headline: "t4" },
    });

    const result = computeLedgerSummaries(store);
    const ts = find(result, TASKS_LEDGER);

    expect(ts.itemCount).toBe(4);
    expect(ts.statusCounts).toEqual({ done: 1, abandoned: 1, wip: 1, planned: 1 });
    // done = done(1) + abandoned(1) = 2.
    expect(ts.completedCount).toBe(2);
    // total = itemCount for non-questions ledgers.
    expect(ts.progressTotal).toBe(ts.itemCount);
  });

  it("defects ledger: done = sum of terminalStatuses (resolved + wontfix)", async () => {
    const store = await buildStore();
    await store.createMilestone({ title: "M" });

    await store.createItem(DEFECTS_LEDGER, "M1", {
      status: "resolved",
      fields: { headline: "d1", severity: "minor" },
    });
    await store.createItem(DEFECTS_LEDGER, "M1", {
      status: "wontfix",
      fields: { headline: "d2", severity: "minor" },
    });
    await store.createItem(DEFECTS_LEDGER, "M1", {
      status: "open",
      fields: { headline: "d3", severity: "minor" },
    });

    const result = computeLedgerSummaries(store);
    const ds = find(result, DEFECTS_LEDGER);

    expect(ds.itemCount).toBe(3);
    expect(ds.statusCounts).toEqual({ resolved: 1, wontfix: 1, open: 1 });
    // done = resolved(1) + wontfix(1) = 2.
    expect(ds.completedCount).toBe(2);
    expect(ds.progressTotal).toBe(ds.itemCount);
  });

  it("empty ledger: itemCount 0, completedCount 0, progressTotal 0", async () => {
    const store = await buildStore();

    const result = computeLedgerSummaries(store);
    const ts = find(result, TASKS_LEDGER);

    expect(ts.itemCount).toBe(0);
    expect(ts.statusCounts).toEqual({});
    expect(ts.completedCount).toBe(0);
    expect(ts.progressTotal).toBe(0);
  });
});
