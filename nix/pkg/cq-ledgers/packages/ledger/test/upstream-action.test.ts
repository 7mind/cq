/**
 * T807 — deterministic upstream action planning and filing claim.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import {
  classifyUpstreamEligibility,
  claimUpstreamFiling,
  planExplicitPrepare,
  selectUpstreamRecheckBatch,
  UPSTREAM_BATCH_LIMIT,
} from "../src/upstreamAction.js";
import { UpstreamFilingClaimedError } from "../src/types.js";
import { UPSTREAM_LEDGER } from "../src/constants.js";
import type { Item } from "../src/types.js";

function item(partial: Partial<Item> & Pick<Item, "id" | "status">): Item {
  return {
    milestoneId: "M1",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    fields: {},
    ...partial,
  };
}

describe("T807 upstream action planning", () => {
  test("eligibility fails closed for security, missing classification, and non-github [BA]", () => {
    expect(
      classifyUpstreamEligibility(item({ id: "U1", status: "open", fields: {} })),
    ).toEqual({ ok: false, reason: "missing-classification" });
    expect(
      classifyUpstreamEligibility(
        item({
          id: "U2",
          status: "open",
          fields: { reportingClassification: "security-sensitive", trackerKind: "github" },
        }),
      ),
    ).toEqual({ ok: false, reason: "security" });
    expect(
      classifyUpstreamEligibility(
        item({
          id: "U3",
          status: "open",
          fields: { reportingClassification: "ordinary", trackerKind: "gitlab" },
        }),
      ),
    ).toEqual({ ok: false, reason: "unsupported-tracker" });
    expect(
      classifyUpstreamEligibility(
        item({
          id: "U4",
          status: "open",
          fields: { reportingClassification: "ordinary", trackerKind: "github" },
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("explicit prepare files open, rechecks reported, refuses released [BA]", () => {
    const eligible = {
      reportingClassification: "ordinary",
      trackerKind: "github",
    };
    expect(planExplicitPrepare(item({ id: "U1", status: "open", fields: eligible }))).toEqual({
      kind: "file",
      itemId: "U1",
    });
    expect(planExplicitPrepare(item({ id: "U2", status: "reported", fields: eligible }))).toEqual({
      kind: "recheck",
      itemIds: ["U2"],
    });
    expect(planExplicitPrepare(item({ id: "U3", status: "released", fields: eligible }))).toEqual({
      kind: "refused",
      reason: "illegal-status",
      itemId: "U3",
    });
  });

  test("batch selects at most 10, never-checked first, then oldest lastCheckedAt, then id [BA]", () => {
    const eligible = { reportingClassification: "ordinary", trackerKind: "github" };
    const items = [
      item({ id: "U9", status: "reported", fields: { ...eligible, lastCheckedAt: "2026-07-02T00:00:00.000Z" } }),
      item({ id: "U2", status: "accepted", fields: { ...eligible } }),
      item({ id: "U1", status: "fixed-upstream", fields: { ...eligible } }),
      item({ id: "U8", status: "reported", fields: { ...eligible, lastCheckedAt: "2026-07-01T00:00:00.000Z" } }),
      item({ id: "U3", status: "open", fields: eligible }),
      ...Array.from({ length: 12 }, (_, i) =>
        item({
          id: `UX${String(i).padStart(2, "0")}`,
          status: "reported",
          fields: { ...eligible, lastCheckedAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` },
        }),
      ),
    ];
    const selected = selectUpstreamRecheckBatch(items);
    expect(selected).toHaveLength(UPSTREAM_BATCH_LIMIT);
    expect(selected.map((entry) => entry.id)).toEqual([
      "U1",
      "U2",
      "U8",
      "U9",
      "UX00",
      "UX01",
      "UX02",
      "UX03",
      "UX04",
      "UX05",
    ]);
    expect(selected.some((entry) => entry.status === "open")).toBe(false);
  });

  test("second prepare cannot authorize a different filing operation [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const milestone = await store.createMilestone({ title: "claim" });
    const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
      status: "open",
      fields: {
        headline: "claimable",
        package: "pkg",
        reportingClassification: "ordinary",
        trackerKind: "github",
      },
    });
    const first = await claimUpstreamFiling(store, created.id, "op-1", "2026-08-19T20:00:00.000Z");
    expect(first.fields["filingOperationId"]).toBe("op-1");
    await expect(claimUpstreamFiling(store, created.id, "op-2", "2026-08-19T20:00:01.000Z")).rejects.toBeInstanceOf(
      UpstreamFilingClaimedError,
    );
    const after = store.fetchItem(UPSTREAM_LEDGER, created.id);
    expect(after.fields["filingOperationId"]).toBe("op-1");
    expect(after.fields["headline"]).toBe("claimable");
    await store.dispose();
  });

  test("two concurrent prepares authorize at most one submission [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const milestone = await store.createMilestone({ title: "race" });
    const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
      status: "open",
      fields: {
        headline: "racy",
        package: "pkg",
        reportingClassification: "ordinary",
        trackerKind: "github",
      },
    });
    const results = await Promise.allSettled([
      claimUpstreamFiling(store, created.id, "op-a", "2026-08-19T20:00:00.000Z"),
      claimUpstreamFiling(store, created.id, "op-b", "2026-08-19T20:00:00.000Z"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe("rejected");
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(UpstreamFilingClaimedError);
    }
    const after = store.fetchItem(UPSTREAM_LEDGER, created.id);
    expect(["op-a", "op-b"]).toContain(String(after.fields["filingOperationId"]));
    await store.dispose();
  });
});
