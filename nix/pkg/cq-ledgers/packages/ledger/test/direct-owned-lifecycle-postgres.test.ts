import { describe, expect, test } from "bun:test";
import { runDirectOwnedLifecycleContract } from "./directOwnedLifecycleContract.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL direct lifecycle", () => {
  runDirectOwnedLifecycleContract("real PostgreSQL / GoodCommunication", ownedLifecyclePostgresFixture);
  test("a callback without a closed descriptor is rejected before execution or database access", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    let called = false;
    try {
      fixture.accesses.length = 0;
      await expect(fixture.store.runAtomicOwnedMutation(() => { called = true; }, null)).rejects.toThrow("require a closed operation descriptor");
      expect(called).toBe(false);
      expect(fixture.accesses).toEqual([]);
    } finally { await fixture.dispose(); }
  });
});
