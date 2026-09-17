import { describe, expect, test } from "bun:test";
import { recordProtectedImplementationCompletion } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL protected completion recording [T5921 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("unmerged journals and substituted task authority are rejected before database access", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    try {
      await seedDirectOwnedTasks(fixture.store);
      const completion = await directCompletionRecord();
      fixture.accesses.length = 0;
      await expect(recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, { ...completion, state: "prepared" }, LIFECYCLE_PROVENANCE))
        .rejects.toThrow("requires a merged journal");
      await expect(recordProtectedImplementationCompletion(fixture.store, { ...DIRECT_TASK_AUTHORITY, ownerGoalRef: "goals:G2" }, completion, LIFECYCLE_PROVENANCE))
        .rejects.toThrow("task authority mismatch");
      expect(fixture.accesses).toEqual([]);
      expect(fixture.store.fetchItem("tasks", "T2345").status).toBe("wip");
      expect(() => fixture.store.fetchItem("reviews", "R1")).toThrow();
    } finally { await fixture.dispose(); }
  });

  test("a task-write constraint rolls back the preceding terminal review and every named defect", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    try {
      await seedDirectOwnedTasks(fixture.store);
      const completion = await directCompletionRecord();
      const before = await snapshotPostgresLifecycleRows(fixture.pool, fixture.projectKey);
      const cached = fixture.store.snapshot();
      await fixture.pool.unsafe(`CREATE FUNCTION reject_completion_task() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'T5921 protected task-write failure'; END $$;
        CREATE TRIGGER reject_completion_task BEFORE UPDATE ON items
        FOR EACH ROW WHEN (NEW.ledger = 'tasks' AND NEW.id = 'T2345' AND NEW.status = 'done') EXECUTE FUNCTION reject_completion_task()`);
      const complete = () => recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
      await expect(complete()).rejects.toThrow("T5921 protected task-write failure");
      expect(await snapshotPostgresLifecycleRows(fixture.pool, fixture.projectKey)).toEqual(before);
      expect(fixture.store.snapshot()).toEqual(cached);
      await fixture.pool.unsafe("DROP TRIGGER reject_completion_task ON items");
      expect(await complete()).toEqual({ reviewRef: "reviews:R1" });
      expect(await complete()).toEqual({ reviewRef: "reviews:R1" });
      expect(fixture.store.fetchItem("tasks", "T2345").status).toBe("done");
      expect(fixture.store.fetchItem("reviews", "R1").status).toBe("go-ahead");
      expect(fixture.store.fetchItem("defects", "D90000").status).toBe("root-caused");
    } finally { await fixture.dispose(); }
  });
});
