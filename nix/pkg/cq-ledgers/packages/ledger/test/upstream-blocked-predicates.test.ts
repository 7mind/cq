/**
 * T799/T800 — report-only upstreamBlocked never gates quiescence.
 */
import { describe, expect, test } from "bun:test";
import { derivePredicates } from "../src/store/predicates.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { TASKS_LEDGER, UPSTREAM_LEDGER } from "../src/constants.js";

describe("T799/T800 report-only upstreamBlocked", () => {
  test("open/wontfix upstream deps appear; released does not; never feeds openQuestionGate [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "upstream-block" });
    const open = await store.createItem(UPSTREAM_LEDGER, m.id, {
      status: "open",
      fields: { headline: "open", package: "pkg" },
    });
    const wontfix = await store.createItem(UPSTREAM_LEDGER, m.id, {
      status: "wontfix",
      fields: { headline: "wontfix", package: "pkg" },
    });
    const released = await store.createItem(UPSTREAM_LEDGER, m.id, {
      status: "released",
      fields: { headline: "released", package: "pkg" },
    });
    const blockedOpen = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "blocked-open", dependsOn: [`upstream:${open.id}`] },
    });
    const blockedWontfix = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "blocked-wontfix", dependsOn: [`upstream:${wontfix.id}`] },
    });
    await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "unblocked", dependsOn: [`upstream:${released.id}`] },
    });
    const doneBlocked = await store.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "done-still-ref", dependsOn: [`upstream:${open.id}`] },
    });
    const p = derivePredicates(store);
    expect(p.upstreamBlocked.value).toBe(true);
    expect(new Set(p.upstreamBlocked.items)).toEqual(new Set([blockedOpen.id, blockedWontfix.id]));
    expect(p.upstreamBlocked.items).not.toContain(doneBlocked.id);
    expect(p.openQuestionGate).toEqual({ value: false, items: [] });
    expect(p.pImplement.value).toBe(false);
    await store.dispose();
  });
});
