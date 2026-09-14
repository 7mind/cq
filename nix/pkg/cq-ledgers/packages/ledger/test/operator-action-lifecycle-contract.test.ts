import { applyOperatorActionLifecycleRows } from "../src/store/operatorActionLifecycle.js";
import { ItemNotFoundError } from "../src/types.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";
import { runOperatorActionLifecycleContract } from "./operatorActionLifecycleContract.js";

runOperatorActionLifecycleContract("strict hand-written row map / Atomic", async (seed) => {
  let rows = new Map(seed.map(({ ledgerId, item }) => [`${ledgerId}:${item.id}`, structuredClone(item)]));
  return {
    async mutate(input) {
      const transaction = structuredClone(rows);
      const outcome = applyOperatorActionLifecycleRows({
        fetchItem: (ledgerId, itemId) => transaction.get(`${ledgerId}:${itemId}`),
      }, input, () => LIFECYCLE_NOW);
      rows = transaction;
      return outcome.result;
    },
    fetch: (ledgerId, itemId) => {
      const item = rows.get(`${ledgerId}:${itemId}`);
      if (item === undefined) throw new ItemNotFoundError(ledgerId, itemId);
      return structuredClone(item);
    },
    dispose: async () => {},
  };
});
