/**
 * T807 — deterministic upstream action planning and filing claim.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import {
  classifyUpstreamEligibility,
  claimUpstreamFiling,
  finalizeUpstreamAction,
  planExplicitPrepare,
  selectUpstreamRecheckBatch,
  UPSTREAM_BATCH_LIMIT,
} from "../src/upstreamAction.js";
import { UpstreamFilingClaimedError, UpstreamFinalizeTokenError } from "../src/types.js";
import {
  GOALS_LEDGER,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
} from "../src/constants.js";
import { derivePredicates } from "../src/store/predicates.js";
import type { LedgerStore } from "../src/store/LedgerStore.js";
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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(kind: "memory" | "fs" | "sqlite"): Promise<LedgerStore> {
  if (kind === "memory") {
    const store = new InMemoryLedgerStore({});
    await store.init();
    return store;
  }
  const root = await mkdtemp(path.join(tmpdir(), `t808-${kind}-`));
  dirs.push(root);
  if (kind === "fs") {
    const store = new FsLedgerStore({ root });
    await store.init();
    return store;
  }
  const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db") });
  await store.init();
  return store;
}

describe("T808 finalize and store-family claims", () => {
  test("architecture: planner does no network or process I/O [BA]", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "../src/upstreamAction.ts"), "utf8");
    expect(source).not.toMatch(/node:http|node:child_process|undici|from "node:net"/);
    expect(source).not.toContain("fetch(");
  });

  for (const kind of ["memory", "fs", "sqlite"] as const) {
    test(`${kind}: wrong finalize token is refused; matching token is idempotent [BA]`, async () => {
      const store = await makeStore(kind);
      const milestone = await store.createMilestone({ title: "fin" });
      const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
        status: "open",
        fields: {
          headline: "file-me",
          package: "pkg",
          reportingClassification: "ordinary",
          trackerKind: "github",
        },
      });
      await claimUpstreamFiling(store, created.id, "op-1", "2026-08-19T21:00:00.000Z");
      await expect(
        finalizeUpstreamAction(store, created.id, {
          kind: "confirmed-url",
          url: "https://example.invalid/issues/1",
          checkedAt: "2026-08-19T21:00:01.000Z",
        }, "wrong"),
      ).rejects.toBeInstanceOf(UpstreamFinalizeTokenError);
      expect(store.fetchItem(UPSTREAM_LEDGER, created.id).status).toBe("open");
      const first = await finalizeUpstreamAction(store, created.id, {
        kind: "confirmed-url",
        url: "https://example.invalid/issues/1",
        checkedAt: "2026-08-19T21:00:01.000Z",
      }, "op-1");
      expect(first.status).toBe("reported");
      const second = await finalizeUpstreamAction(store, created.id, {
        kind: "confirmed-url",
        url: "https://example.invalid/issues/1",
        checkedAt: "2026-08-19T21:00:02.000Z",
      }, "op-1");
      expect(second.status).toBe("reported");
      expect(second.fields["reportUrls"]).toEqual(["https://example.invalid/issues/1"]);
      await store.dispose();
    });
  }

  test("bookkeeping does not change status or reportUrls [BA]", async () => {
    const store = await makeStore("memory");
    const milestone = await store.createMilestone({ title: "bk" });
    const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
      status: "reported",
      fields: {
        headline: "recheck",
        package: "pkg",
        reportingClassification: "ordinary",
        trackerKind: "github",
        reportUrls: ["https://example.invalid/issues/1"],
      },
    });
    const before = structuredClone(store.fetchItem(UPSTREAM_LEDGER, created.id));
    await finalizeUpstreamAction(store, created.id, {
      kind: "bookkeeping",
      outcome: "offline",
      checkedAt: "2026-08-19T21:05:00.000Z",
    });
    const after = store.fetchItem(UPSTREAM_LEDGER, created.id);
    expect(after.status).toBe(before.status);
    expect(after.fields["reportUrls"]).toEqual(before.fields["reportUrls"]);
    expect(after.fields["lastCheckOutcome"]).toBe("offline");
    await store.dispose();
  });

  test("unknown submission stays claimed until reconciliation [BA]", async () => {
    const store = await makeStore("memory");
    const milestone = await store.createMilestone({ title: "unk" });
    const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
      status: "open",
      fields: {
        headline: "unknown",
        package: "pkg",
        reportingClassification: "ordinary",
        trackerKind: "github",
      },
    });
    await claimUpstreamFiling(store, created.id, "op-u", "2026-08-19T21:06:00.000Z");
    await finalizeUpstreamAction(store, created.id, {
      kind: "unknown-submission",
      checkedAt: "2026-08-19T21:06:01.000Z",
    }, "op-u");
    const after = store.fetchItem(UPSTREAM_LEDGER, created.id);
    expect(after.status).toBe("open");
    expect(after.fields["filingState"]).toBe("reconciliation-required");
    expect(after.fields["filingOperationId"]).toBe("op-u");
    await expect(claimUpstreamFiling(store, created.id, "op-retry", "2026-08-19T21:06:02.000Z")).rejects.toBeInstanceOf(
      UpstreamFilingClaimedError,
    );
    await store.dispose();
  });
});

describe("T809 confirmed release unblocks dependents", () => {
  test("fixed-upstream → released admits the gated task and clears upstreamBlocked [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const milestone = await store.createMilestone({ title: "rel" });
    const upstream = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
      status: "fixed-upstream",
      fields: {
        headline: "fixed",
        package: "pkg",
        reportingClassification: "ordinary",
        trackerKind: "github",
      },
    });
    const goal = await store.createItem(GOALS_LEDGER, milestone.id, {
      status: "planned",
      fields: { title: "g", description: "d" },
    });
    const task = await store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: {
        headline: "gated",
        dependsOn: [`upstream:${upstream.id}`],
        ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
      },
    });
    const before = derivePredicates(store);
    expect(before.pImplement.items).not.toContain(task.id);
    expect(before.upstreamBlocked.items).toContain(task.id);
    await finalizeUpstreamAction(store, upstream.id, {
      kind: "bookkeeping",
      outcome: "still-open",
      checkedAt: "2026-08-19T21:10:00.000Z",
    });
    expect(store.fetchItem(UPSTREAM_LEDGER, upstream.id).status).toBe("fixed-upstream");
    await finalizeUpstreamAction(store, upstream.id, {
      kind: "confirmed-release",
      checkedAt: "2026-08-19T21:10:01.000Z",
    });
    const after = derivePredicates(store);
    expect(after.pImplement.items).toContain(task.id);
    expect(after.upstreamBlocked.items).not.toContain(task.id);
    const again = await finalizeUpstreamAction(store, upstream.id, {
      kind: "confirmed-release",
      checkedAt: "2026-08-19T21:10:02.000Z",
    });
    expect(again.status).toBe("released");
    await store.dispose();
  });
});
