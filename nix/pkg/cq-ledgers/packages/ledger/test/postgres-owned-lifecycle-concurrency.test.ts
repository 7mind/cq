import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { createTrustedWorksetManagementAuthority, createWorksetOwnedGuardedLedger, PostgresLedgerStore } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { waitForPostgresLock } from "./postgresLockWait.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL owned concurrency [T5920 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("an admitted roots read does not block a peer granting another ordinary admission", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const peer = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: fixture.schema, lock_timeout: "250ms" } }),
      projectKey: fixture.projectKey, displayName: fixture.projectKey });
    try {
      await fixture.store.replaceWorksetRoots(["goals:G1"]);
      await peer.init();
      await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM workset_roots WHERE project_key = ${fixture.projectKey} FOR SHARE`;
        const admission = await peer.worksetStore().admitLedgerMutation({ kind: "owned-write", targets: ["goals:G1"] });
        try { expect(admission.roots).toEqual(["goals:G1"]); }
        finally { await admission.acknowledge(); }
      });
    } finally { await peer.dispose(); await fixture.dispose(); }
  });

  test("unrelated counter and owner locks do not block creation; a same-owner waiter rejects the newly committed phase", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const applicationName = `owned-race-${randomUUID()}`;
    const peer = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: {
      search_path: fixture.schema, application_name: applicationName, lock_timeout: "2s",
    } }), projectKey: fixture.projectKey, displayName: fixture.projectKey });
    let pending: Promise<unknown> | null = null;
    try {
      await fixture.store.createItem("goals", "M-AMBIENT", { id: "G90000", status: "clarifying", fields: { title: "unrelated", description: "unrelated" } });
      await fixture.store.replaceWorksetRoots(["goals:G1"]);
      await peer.init();
      const guarded = createWorksetOwnedGuardedLedger({ rawStore: peer, worksetStore: peer.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(), runOwnedTransaction: (mutate, context) => peer.runAtomicOwnedMutation(mutate, context) });
      const create = () => guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
        child: { ledgerId: "questions", status: "open", fields: { question: "selected" } } });
      await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G90000' FOR UPDATE`;
        await holder`SELECT 1 FROM ledgers WHERE project_key = ${fixture.projectKey} AND name = 'ideas' FOR UPDATE`;
        expect(await create()).toMatchObject({ child: { fields: { worksetOwnerRef: "goals:G1" } } });
      });
      const held = await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1' FOR UPDATE`;
        const contender = create().then((value) => ({ kind: "result" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
        pending = contender;
        await waitForPostgresLock(fixture.pool, applicationName, 1_000);
        await holder`UPDATE items SET status = 'abandoned' WHERE project_key = ${fixture.projectKey} AND ledger = 'goals' AND id = 'G1'`;
        return { contender };
      });
      const settled = await held.contender;
      expect(settled.kind).toBe("error");
      if (settled.kind !== "error") throw new Error("owned creation unexpectedly accepted an abandoned owner");
      expect((settled.error as Error).message).toContain("does not authorise exact-gate-question");
      expect(await fixture.pool`SELECT id FROM items WHERE project_key = ${fixture.projectKey} AND ledger = 'questions'`).toHaveLength(1);
    } finally {
      if (pending !== null) await Promise.allSettled([pending]);
      await peer.dispose(); await fixture.dispose();
    }
  });
});
