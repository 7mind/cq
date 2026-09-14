import { InMemoryLedgerStore } from "../src/index.js";
import { runDirectOwnedLifecycleContract } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

runDirectOwnedLifecycleContract("hand-written in-memory / Atomic", async () => {
  const store = new InMemoryLedgerStore({ now: () => LIFECYCLE_NOW });
  await store.init();
  await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "direct goal", description: "direct operations" } });
  return { store, dispose: () => store.dispose() };
});
