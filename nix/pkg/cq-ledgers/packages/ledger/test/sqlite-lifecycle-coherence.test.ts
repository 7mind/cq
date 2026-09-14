import { expect, test } from "bun:test";
import { coherenceVersion } from "../src/store/sqlite/connection.js";
import { claimScopeKey } from "../src/store/planLifecycleDump.js";
import { LIFECYCLE_CLAIM_INPUT, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

// expected-failure: tasks:T5547
test.failing("sqlite lifecycle projection applies only exact changed documents", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    const before = coherenceVersion(db);
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    const changes = store.readCoherenceChanges(before);
    expect(changes.version).toBe(before + 1);
    expect(changes.entries.map(({ ledger, documentId, scope, kind }) => ({ ledger, documentId, scope, kind }))).toEqual([
      { ledger: "goals", documentId: "G1", scope: "active", kind: "upsert" },
      { ledger: "goals", documentId: `plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`, scope: "control", kind: "upsert" },
    ]);
  } finally { await fixture.dispose(); }
});
