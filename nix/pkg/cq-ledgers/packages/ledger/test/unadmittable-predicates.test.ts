/**
 * D585 — report-only `unadmittable` names ready tasks cohort admission can
 * never accept.
 *
 * Admission resolves a member's repository witness only from paths reachable
 * through its own `sourceRefs` (directly, or through the primary ledger items
 * they reference). A ready task with no such path used to look implementable
 * while every admission refused it.
 */
import { describe, expect, test } from "bun:test";
import { derivePredicates } from "../src/store/predicates.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { GOALS_LEDGER, TASKS_LEDGER } from "../src/constants.js";

describe("D585 report-only unadmittable", () => {
  test("flags a ready task that reaches no repository path [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "admission-witness" });
    const goal = await store.createItem(GOALS_LEDGER, m.id, { status: "planned", fields: { title: "g", description: "d" } });
    const citedGoal = await store.createItem(GOALS_LEDGER, m.id, {
      status: "planned", fields: { title: "cited", description: "d", sourceRefs: ["packages/ledger/src/workCohort.ts"] } });
    const owner = [`${GOALS_LEDGER}:${goal.id}`];
    const bare = await store.createItem(TASKS_LEDGER, m.id, { status: "planned", fields: { headline: "no path", ledgerRefs: owner } });
    const ledgerOnly = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned", fields: { headline: "only an uncited goal", ledgerRefs: owner, sourceRefs: [`${GOALS_LEDGER}:${goal.id}`] } });
    const direct = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned", fields: { headline: "cites a line", ledgerRefs: owner, sourceRefs: ["packages/ledger/src/constants.ts:200"] } });
    const transitive = await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned", fields: { headline: "through a cited goal", ledgerRefs: owner, sourceRefs: [`${GOALS_LEDGER}:${citedGoal.id}`] } });

    const p = derivePredicates(store);
    expect(new Set(p.unadmittable.items)).toEqual(new Set([bare.id, ledgerOnly.id]));
    expect(p.unadmittable.value).toBe(true);
    // Readiness is unchanged; the signal only explains why admission refuses.
    expect(new Set(p.pImplement.items)).toEqual(new Set([bare.id, ledgerOnly.id, direct.id, transitive.id]));
  });
});
