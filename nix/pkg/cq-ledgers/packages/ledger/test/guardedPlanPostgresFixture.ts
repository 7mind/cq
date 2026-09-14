import { createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore, type PostgresLedgerStore } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

export function guardedPlanPostgresSurface(store: PostgresLedgerStore) {
  return createWorksetGuardedPlanLifecycleStore({ rawStore: store, worksetStore: store.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
    runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, mutate),
  });
}

export async function guardedPlanPostgresFixture() {
  const fixture = await ownedLifecyclePostgresFixture();
  return { ...fixture, guarded: guardedPlanPostgresSurface(fixture.store) };
}
