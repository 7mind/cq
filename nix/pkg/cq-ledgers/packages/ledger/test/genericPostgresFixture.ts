import { createWorksetGenericMutationGateway, type PostgresLedgerStore } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

export function genericPostgresSurface(store: PostgresLedgerStore) {
  return createWorksetGenericMutationGateway({ rawStore: store, worksetStore: store.worksetStore() });
}

export async function genericPostgresFixture() {
  const fixture = await ownedLifecyclePostgresFixture();
  return { ...fixture, generic: genericPostgresSurface(fixture.store) };
}
