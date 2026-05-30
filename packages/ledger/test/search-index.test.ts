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
    // Replace the active set with a different item.
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
