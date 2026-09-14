import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import type { PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import type { OperatorActionSeedRow } from "./operatorActionLifecycleContract.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";
import type { SQL } from "bun";

export async function operatorActionPostgresFixture(seed: readonly OperatorActionSeedRow[]) {
  return operatorActionPostgresFixtureWithPool(seed, (pool) => pool);
}

export async function operatorActionPostgresFixtureWithPool(seed: readonly OperatorActionSeedRow[], wrapPool: (pool: SQL) => SQL) {
  const fixture = await postgresKeyedFixture();
  const projectKey = "operator-keyed-fixture";
  const accesses: PostgresAccessRecord[] = [];
  const store = new PostgresLedgerStore({ pool: wrapPool(fixture.pool), projectKey, displayName: projectKey,
    now: () => LIFECYCLE_NOW, accessObserver: { record: (record) => accesses.push(record) } });
  try {
    await store.init();
    await fixture.pool.begin(async (tx) => {
      for (const { ledgerId, item } of seed) {
        await tx`INSERT INTO groups (project_key, ledger, id, title, description)
          VALUES (${projectKey}, ${ledgerId}, ${item.milestoneId}, '', '') ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
          VALUES (${projectKey}, ${ledgerId}, ${item.id}, ${item.milestoneId}, ${item.status}, ${JSON.stringify(item.fields)},
            ${item.createdAt}, ${item.updatedAt}, ${item.author ?? null}, ${item.session ?? null})`;
      }
    });
    await store.reloadCommittedState();
    return { ...fixture, store, projectKey, accesses, mutate: store.mutateOperatorAction.bind(store),
      fetch: (ledgerId: string, itemId: string) => store.fetchItem(ledgerId, itemId),
      dispose: async () => { await store.dispose(); await fixture.dispose(); } };
  } catch (error) { await store.dispose(); await fixture.dispose(); throw error; }
}
