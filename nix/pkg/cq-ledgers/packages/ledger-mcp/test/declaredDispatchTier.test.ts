/**
 * D558 — the tier the dispatched unit of work declares for itself.
 *
 * `[agent_tiers]` is the per-role default, so a task's `suggestedModel` must
 * reach model resolution. It reached nothing: the declaration was recorded,
 * projected on the compact wire and shown in the tasks table, then discarded at
 * dispatch, silently and downward.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore, TASKS_LEDGER } from "@cq/ledger";
import { declaredDispatchTier, dispatchedTaskIds } from "../src/declaredDispatchTier.js";

async function storeWith(tiers: readonly (string | undefined)[]) {
  const store = new InMemoryLedgerStore({});
  await store.init();
  const milestone = await store.createMilestone({ title: "declared-tier" });
  const ids: string[] = [];
  for (const tier of tiers) {
    const item = await store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "declaring work", ...(tier === undefined ? {} : { suggestedModel: tier }) },
    });
    ids.push(item.id);
  }
  return { store, ids };
}

describe("declaredDispatchTier", () => {
  test("a single task anchor contributes its own declaration [BA]", async () => {
    const { store, ids } = await storeWith(["frontier"]);
    expect(declaredDispatchTier(store, { taskId: ids[0] })).toBe("frontier");
    await store.dispose();
  });

  test("a cohort takes the STRONGEST declaration, so no member is under-served [BA]", async () => {
    const { store, ids } = await storeWith(["standard", "frontier", "fast"]);
    const members = ids.map((id) => ({ memberRef: `${TASKS_LEDGER}:${id}` }));
    expect(declaredDispatchTier(store, { members })).toBe("frontier");
    await store.dispose();
  });

  test("work that declares nothing leaves the role default in force [BA]", async () => {
    const { store, ids } = await storeWith([undefined]);
    expect(declaredDispatchTier(store, { taskId: ids[0] })).toBeUndefined();
    await store.dispose();
  });

  test("a value outside the tier vocabulary is not a declaration [BA]", async () => {
    const { store, ids } = await storeWith(["claude:opus"]);
    expect(declaredDispatchTier(store, { taskId: ids[0] })).toBeUndefined();
    await store.dispose();
  });

  test("an unreadable member does not veto the others' declarations [BA]", async () => {
    const { store, ids } = await storeWith(["frontier"]);
    const members = [{ memberRef: `${TASKS_LEDGER}:${ids[0]}` }, { memberRef: `${TASKS_LEDGER}:T999999` }];
    expect(declaredDispatchTier(store, { members })).toBe("frontier");
    await store.dispose();
  });

  test("dispatchedTaskIds reads both dispatch shapes and ignores anything else", () => {
    expect(dispatchedTaskIds({ taskId: "T7" })).toEqual(["T7"]);
    expect(dispatchedTaskIds({ members: [{ memberRef: "tasks:T7" }, { memberRef: "defects:D1" }] })).toEqual(["T7"]);
    expect(dispatchedTaskIds({ taskId: "not-a-task" })).toEqual([]);
    expect(dispatchedTaskIds(undefined)).toEqual([]);
    expect(dispatchedTaskIds([])).toEqual([]);
  });
});
