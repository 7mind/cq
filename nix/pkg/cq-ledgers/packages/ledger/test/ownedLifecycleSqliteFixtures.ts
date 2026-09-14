import type { Database } from "bun:sqlite";
import { createTrustedWorksetManagementAuthority, createWorksetOwnedGuardedLedger } from "../src/index.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";
import { LIFECYCLE_NOW, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

export async function ownedLifecycleSqliteFixture() {
  const fixture = await sqlitePlanLifecycleFixture();
  const guarded = createWorksetOwnedGuardedLedger({
    rawStore: fixture.store, worksetStore: fixture.store.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => fixture.store.runAtomicOwnedMutation(mutate, context),
  });
  return { ...fixture, guarded };
}

export function seedUnrelatedOwnedRows(db: Database, count: number): void {
  db.transaction(() => {
    db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-size-growth', '', '')").run();
    db.query(`INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
      VALUES ('tasks', 'M-size-archive', '', '', 'done', ?)`).run(LIFECYCLE_NOW);
    const active = db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES ('tasks', ?, 'M-size-growth', 'planned', '{"headline":"unrelated"}', ?, ?)`);
    const archived = db.query(`INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES ('tasks', 'M-size-archive', ?, 'M-size-archive', 'done', '{"headline":"unrelated"}', ?, ?)`);
    const privateClaim = db.query("INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)");
    const privateOperation = db.query("INSERT INTO plan_operations (scope, record_json) VALUES (?, ?)");
    for (let index = 0; index < count; index += 1) {
      active.run(`T${100000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
      archived.run(`T${200000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
      if (index < 2_000) {
        const claim = lifecycleClaim(`G${30000 + index}`);
        privateClaim.run(claimScopeKey(claim.goalId, claim.claimRequestId), JSON.stringify(claim));
        const operation = lifecycleOperation(`unrelated-${index}`);
        operation.replay.goalId = claim.goalId;
        operation.replay.claimId = claim.claimId;
        const key = operation.replay;
        privateOperation.run(operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), JSON.stringify(operation));
      }
    }
  })();
}
