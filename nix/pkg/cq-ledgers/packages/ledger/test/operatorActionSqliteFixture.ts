import type { OperatorActionSeedRow } from "./operatorActionLifecycleContract.js";
import { sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

export async function operatorActionSqliteFixture(seed: readonly OperatorActionSeedRow[]) {
  const fixture = await sqlitePlanLifecycleFixture();
  fixture.db.transaction(() => {
    for (const { ledgerId, item } of seed) {
      fixture.db.query("INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(ledgerId, item.milestoneId);
      fixture.db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, item.id, item.milestoneId, item.status, JSON.stringify(item.fields),
        item.createdAt, item.updatedAt, item.author ?? null, item.session ?? null);
    }
  })();
  return {
    ...fixture,
    mutate: fixture.store.mutateOperatorAction.bind(fixture.store),
    fetch: (ledgerId: string, itemId: string) => fixture.store.fetchItem(ledgerId, itemId),
  };
}
