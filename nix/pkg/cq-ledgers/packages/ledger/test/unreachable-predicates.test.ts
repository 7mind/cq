/**
 * D550 — report-only `unreachable` names tasks that can never become ready.
 *
 * A dependency terminal in a non-satisfying status (`abandoned`, `wontfix`)
 * can never be satisfied, so P-implement silently omits the dependent task
 * forever. The signal distinguishes that from "not ready yet" and follows the
 * stall down the dependency chain.
 */
import { describe, expect, test } from "bun:test";
import { derivePredicates } from "../src/store/predicates.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { TASKS_LEDGER } from "../src/constants.js";

describe("D550 report-only unreachable", () => {
  test("names direct and transitive dependants of an abandoned task [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "unreachable-chain" });
    const abandoned = await store.createItem(TASKS_LEDGER, m.id, {
      status: "abandoned",
      fields: { headline: "superseded work" },
    });
    const finished = await store.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "landed work" },
    });
    const direct = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "root of the stalled chain", dependsOn: [`tasks:${abandoned.id}`] },
    });
    const transitive = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "downstream of the stalled root", dependsOn: [`tasks:${direct.id}`] },
    });
    const reachable = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "depends only on landed work", dependsOn: [`tasks:${finished.id}`] },
    });
    const terminalDependant = await store.createItem(TASKS_LEDGER, m.id, {
      status: "done",
      fields: { headline: "already terminal", dependsOn: [`tasks:${abandoned.id}`] },
    });

    const p = derivePredicates(store);

    expect(p.unreachable.value).toBe(true);
    expect(new Set(p.unreachable.items)).toEqual(new Set([direct.id, transitive.id]));
    expect(p.unreachable.items).not.toContain(reachable.id);
    expect(p.unreachable.items).not.toContain(terminalDependant.id);
    // Report-only: it gates nothing and never feeds the open-question gate.
    expect(p.openQuestionGate).toEqual({ value: false, items: [] });
    await store.dispose();
  });

  test("stays silent while a dependency is merely unfinished [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "not-yet-ready" });
    const pending = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "still to do" },
    });
    await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "waits for it", dependsOn: [`tasks:${pending.id}`] },
    });

    expect(derivePredicates(store).unreachable).toEqual({ value: false, items: [] });
    await store.dispose();
  });
});
