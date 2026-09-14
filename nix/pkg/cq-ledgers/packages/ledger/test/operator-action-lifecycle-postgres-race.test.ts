import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { operatorActionPostgresFixture } from "./operatorActionPostgresFixture.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS } from "./operatorActionLifecycleContract.js";
import { waitForPostgresLock } from "./postgresLockWait.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operator concurrency [T5919 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("an unrelated action proceeds while a same-action contender waits and then rejects its stale revision", async () => {
    const action = OPERATOR_ACTION_ROWS[0]!;
    const fixture = await operatorActionPostgresFixture([...OPERATOR_ACTION_ROWS, { ...action, item: { ...action.item, id: "OA2" } }]);
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const applicationName = `operator-race-${randomUUID()}`;
    const worker = new SQL({ url: dsn, connection: { search_path: fixture.schema, application_name: applicationName, lock_timeout: "2s" } });
    const peer = new PostgresLedgerStore({ pool: worker, projectKey: fixture.projectKey, displayName: fixture.projectKey });
    let pending: Promise<unknown> | null = null;
    try {
      await peer.init();
      const held = await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA1' FOR UPDATE`;
        expect(await peer.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, actionId: "OA2" })).toMatchObject({ state: "acknowledged" });
        const contender = peer.mutateOperatorAction(OPERATOR_ACKNOWLEDGE).then((value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }));
        pending = contender;
        await waitForPostgresLock(fixture.pool, applicationName, 1_000);
        await holder`UPDATE items SET fields_json = ${JSON.stringify({ ...action.item.fields, revision: "2" })}
          WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA1'`;
        return { contender };
      });
      const settled = await held.contender;
      expect(settled.kind).toBe("error");
      if (settled.kind !== "error") throw new Error("stale operator revision unexpectedly succeeded");
      expect((settled.error as Error).message).toContain("expected 1, current 2");
      const persisted = await fixture.pool`SELECT status, fields_json FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'operatorActions' AND id = 'OA1'`;
      expect(persisted[0].status).toBe("pending");
      expect(JSON.parse(persisted[0].fields_json)).not.toHaveProperty("acknowledgementEpoch");
    } finally {
      if (pending !== null) await Promise.allSettled([pending]);
      await peer.dispose();
      await fixture.dispose();
    }
  });
});
