/**
 * Unit tests for LedgerSearchIndex in isolation (no store). Drives the index
 * directly with hand-built Items to assert:
 *   - ranked cross-ledger search
 *   - single-ledger restriction
 *   - headline-boost: a headline match outranks a body-only match
 *   - fuzzy + prefix options
 *   - status filter
 *   - includeArchived partition (archived hidden by default)
 */

import { describe, it, expect } from "bun:test";
import { LedgerSearchIndex } from "../src/index.js";
import type { Item } from "../src/index.js";

function item(
  id: string,
  status: string,
  fields: Record<string, string | string[]>,
  milestoneId = "M1",
): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
}

describe("LedgerSearchIndex", () => {
  it("ranks cross-ledger and restricts to a single ledger when asked", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "scroll jank in stream view", severity: "minor" }),
    ]);
    idx.rebuildLedgerActive("tasks", [
      item("T1", "planned", { headline: "fix stream scrolling", description: "stream" }),
    ]);

    const cross = idx.search("stream");
    expect(cross.map((h) => `${h.ledgerId}:${h.item.id}`).sort()).toEqual([
      "defects:D1",
      "tasks:T1",
    ]);

    const single = idx.search("stream", { ledger: "tasks" });
    expect(single.map((h) => h.item.id)).toEqual(["T1"]);
  });

  it("a headline match outranks a body-only match (boost ordering)", () => {
    const idx = new LedgerSearchIndex();
    // H1: 'widget' only in headline (high boost). H2: 'widget' only in body.
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "widget overflow", description: "unrelated text here" }),
      item("D2", "open", { headline: "unrelated heading", description: "the widget is fine" }),
    ]);
    const hits = idx.search("widget");
    expect(hits.length).toBe(2);
    expect(hits[0]?.item.id).toBe("D1");
    expect(hits[1]?.item.id).toBe("D2");
    // Score is strictly greater for the headline match.
    expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0)).toBe(true);
    // matchedFields reflects WHERE the term hit.
    expect(hits[0]?.matchedFields).toContain("headline");
    expect(hits[1]?.matchedFields).toContain("body");
  });

  it("fuzzy matching finds near-misses; exact search does not", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "neuromancer reference" }),
    ]);
    expect(idx.search("neromancer").length).toBe(0);
    expect(idx.search("neromancer", { fuzzy: true }).map((h) => h.item.id)).toEqual(["D1"]);
  });

  it("prefix matching finds terms by prefix; exact search does not", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "motorcycle maintenance" }),
    ]);
    expect(idx.search("moto").length).toBe(0);
    expect(idx.search("moto", { prefix: true }).map((h) => h.item.id)).toEqual(["D1"]);
  });

  it("status filter restricts to an exact (case-insensitive) status", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "widget alpha" }),
      item("D2", "resolved", { headline: "widget beta" }),
    ]);
    expect(idx.search("widget", { statusFilter: "open" }).map((h) => h.item.id)).toEqual(["D1"]);
    expect(idx.search("widget", { statusFilter: "RESOLVED" }).map((h) => h.item.id)).toEqual([
      "D2",
    ]);
  });

  it("archived docs are hidden by default and visible with includeArchived", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [item("D1", "open", { headline: "active widget" })]);
    idx.setLedgerArchived("defects", [item("D2", "resolved", { headline: "archived widget" })]);

    const def = idx.search("widget");
    expect(def.map((h) => h.item.id)).toEqual(["D1"]);

    const incl = idx.search("widget", { includeArchived: true });
    expect(incl.map((h) => h.item.id).sort()).toEqual(["D1", "D2"]);
  });

  it("rebuildLedgerActive replaces prior active docs (no stale hits)", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [item("D1", "open", { headline: "alpha" })]);
    expect(idx.search("alpha").length).toBe(1);
    idx.rebuildLedgerActive("defects", [item("D2", "open", { headline: "beta" })]);
    expect(idx.search("alpha").length).toBe(0);
    expect(idx.search("beta").map((h) => h.item.id)).toEqual(["D2"]);
  });

  it("removeLedger drops both active and archived docs", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [item("D1", "open", { headline: "alpha" })]);
    idx.setLedgerArchived("defects", [item("D2", "resolved", { headline: "alpha archived" })]);
    idx.removeLedger("defects");
    expect(idx.search("alpha", { includeArchived: true }).length).toBe(0);
  });

  it("empty query returns no hits", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [item("D1", "open", { headline: "alpha" })]);
    expect(idx.search("").length).toBe(0);
    expect(idx.search("   ").length).toBe(0);
  });
});

describe("LedgerSearchIndex.searchQuery (filter language)", () => {
  function fixture(): LedgerSearchIndex {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("tasks", [
      item("T1", "done", { headline: "ship the parser", severity: "minor" }),
      item("T2", "wip", { headline: "ship the web ui" }),
      item("T3", "planned", { headline: "ship the tui" }),
    ]);
    idx.rebuildLedgerActive("goals", [
      item("G1", "building", { title: "ship a platform", description: "ship everything" }),
    ]);
    return idx;
  }
  const ids = (hits: { item: { id: string } }[]): string[] => hits.map((h) => h.item.id).sort();

  it("plain free text still ranks via MiniSearch (unchanged path)", () => {
    expect(ids(fixture().searchQuery("ship"))).toEqual(["G1", "T1", "T2", "T3"]);
  });

  it("filters by a status qualifier", () => {
    expect(ids(fixture().searchQuery("status:done"))).toEqual(["T1"]);
  });

  it("evaluates an OR group of statuses", () => {
    expect(ids(fixture().searchQuery("(status:done OR status:wip)"))).toEqual(["T1", "T2"]);
  });

  it("scopes to a ledger via the ledger qualifier", () => {
    expect(ids(fixture().searchQuery("ledger:goals ship"))).toEqual(["G1"]);
  });

  it("combines a qualifier with free text (implicit AND)", () => {
    expect(ids(fixture().searchQuery("status:wip ship"))).toEqual(["T2"]);
  });

  it("supports negation", () => {
    expect(ids(fixture().searchQuery("ship -status:done ledger:tasks"))).toEqual(["T2", "T3"]);
  });

  it("matches a generic item field qualifier", () => {
    expect(ids(fixture().searchQuery("severity:minor"))).toEqual(["T1"]);
  });

  it("matches dependsOn regardless of bare vs prefixed form on EITHER side (G80/M245)", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "bug bare-stored", dependsOn: ["T1"] }),
      item("D2", "open", { headline: "bug prefixed-stored", dependsOn: ["tasks:T2"] }),
    ]);
    // A bare query operand matches BOTH a bare-stored and a prefixed-stored value.
    expect(ids(idx.searchQuery("dependsOn:T1"))).toEqual(["D1"]);
    expect(ids(idx.searchQuery("dependsOn:T2"))).toEqual(["D2"]);
    // A prefixed query operand (query.ts's first-colon tokenization keeps
    // "tasks:T1" as one operand) ALSO matches both.
    expect(ids(idx.searchQuery("dependsOn:tasks:T1"))).toEqual(["D1"]);
    expect(ids(idx.searchQuery("dependsOn:tasks:T2"))).toEqual(["D2"]);
  });

  /**
   * Reproduce-first for the Q77 anomaly (task T139): the report was that the
   * inline filter `(status:open OR status:wip)` returned an empty result.
   *
   * This exercises the EXACT query against a populated index through the SAME
   * path `fts_search` uses (`searchQuery`, which `InMemoryLedgerStore.ftsSearch`
   * / `FsLedgerStore.ftsSearch` delegate to), with items in BOTH `open` and
   * `wip` status spread across two ledgers.
   *
   * Observed (2026-06-03, worktree base 5306944): the open+wip items ARE
   * returned — `["D1","D2","T1","T2"]`. The OR-of-qualifiers evaluator is
   * therefore NOT defective: `parseQuery("(status:open OR status:wip)")` yields
   * an `or` of two `status` qualifiers with no free-text terms, and `evaluate`
   * walks every backing doc applying `matchItemQualifier`, which correctly
   * matches by status. ADJUDICATION: the Q77 empty-result anomaly is a usage /
   * stale-index artifact, not an evaluator defect. T140 (the dependent fix
   * task) is consequently documentation-only — there is no evaluator bug to fix
   * here. This test is committed GREEN as a regression guard for that
   * conclusion.
   */
  it("evaluates (status:open OR status:wip) over open+wip items (Q77/T139 repro — GREEN)", () => {
    const idx = new LedgerSearchIndex();
    idx.rebuildLedgerActive("tasks", [
      item("T1", "open", { headline: "alpha" }),
      item("T2", "wip", { headline: "beta" }),
      item("T3", "done", { headline: "gamma" }),
    ]);
    idx.rebuildLedgerActive("defects", [
      item("D1", "open", { headline: "delta" }),
      item("D2", "wip", { headline: "epsilon" }),
      item("D3", "resolved", { headline: "zeta" }),
    ]);
    expect(ids(idx.searchQuery("(status:open OR status:wip)"))).toEqual([
      "D1",
      "D2",
      "T1",
      "T2",
    ]);
  });
});
