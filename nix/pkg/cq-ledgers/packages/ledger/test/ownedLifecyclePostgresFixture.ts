import { createTrustedWorksetManagementAuthority, createWorksetOwnedGuardedLedger, PostgresLedgerStore } from "../src/index.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

export async function ownedLifecyclePostgresFixture() {
  const fixture = await postgresKeyedFixture();
  const projectKey = "owned-keyed-fixture";
  const accesses: PostgresAccessRecord[] = [];
  const store = new PostgresLedgerStore({ pool: fixture.pool, projectKey, displayName: projectKey,
    now: () => LIFECYCLE_NOW, accessObserver: { record: (record) => accesses.push(record) } });
  try {
    await store.init();
    await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "selected", description: "selected" } });
    const guarded = createWorksetOwnedGuardedLedger({ rawStore: store, worksetStore: store.worksetStore(),
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context) });
    return { ...fixture, store, projectKey, guarded, accesses, dispose: async () => { await store.dispose(); await fixture.dispose(); } };
  } catch (error) { await store.dispose(); await fixture.dispose(); throw error; }
}
