import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import {
  PostgresLedgerStore,
  createWorksetGenericMutationGateway,
  recordProtectedImplementationCompletion,
} from "../src/index.js";
import { runImplementationCompletionFixReconciliationContract } from "./implementationCompletionFixReconciliationContract.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { waitForPostgresLock } from "./postgresLockWait.js";
import {
  DIRECT_TASK_AUTHORITY,
  directCompletionRecord,
} from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

const POSTGRES_APPLICATION_NAME_BYTE_LIMIT = 63;

function reconciliationPeerApplicationNames(token: string): readonly [string, string] {
  const applicationNames: readonly [string, string] = [`fix-${token}-source`, `fix-${token}-completion`];
  if (applicationNames[0] === applicationNames[1]) {
    throw new Error("PostgreSQL reconciliation peers require distinct application names");
  }
  for (const applicationName of applicationNames) {
    const byteLength = new TextEncoder().encode(applicationName).byteLength;
    if (byteLength > POSTGRES_APPLICATION_NAME_BYTE_LIMIT) {
      throw new Error(`PostgreSQL application name exceeds ${POSTGRES_APPLICATION_NAME_BYTE_LIMIT} bytes`);
    }
  }
  return applicationNames;
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL required reconciliation registration", () => {
  runImplementationCompletionFixReconciliationContract("PostgreSQL", async () => {
    const fixture = await postgresKeyedFixture();
    const projectKey = "completion-fix-reconciliation";
    const store = new PostgresLedgerStore({
      pool: fixture.pool,
      projectKey,
      displayName: projectKey,
      now: () => LIFECYCLE_NOW,
    });
    try {
      await store.init();
      return {
        store,
        dispose: async () => {
          await store.dispose();
          await fixture.dispose();
        },
      };
    } catch (error) {
      await store.dispose();
      await fixture.dispose();
      throw error;
    }
  });

  test("an indexed reverse source queued before completion is fenced into the authoritative union", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
    const [sourceApplicationName, completionApplicationName] = reconciliationPeerApplicationNames(randomUUID());
    const peer = (applicationName: string) => new PostgresLedgerStore({
      projectKey: fixture.projectKey,
      displayName: fixture.projectKey,
      pool: new SQL({
        url: dsn,
        connection: {
          search_path: fixture.schema,
          application_name: applicationName,
          lock_timeout: "2s",
        },
      }),
      now: () => LIFECYCLE_NOW,
    });
    const sourceStore = peer(sourceApplicationName);
    const completionStore = peer(completionApplicationName);
    const pending: Promise<unknown>[] = [];
    try {
      const milestone = await fixture.store.createMilestone({ title: "source fence" });
      await fixture.store.createItem("tasks", milestone.id, {
        id: "T2345", status: "wip", fields: { headline: "completion", ledgerRefs: ["defects:D1"] },
      });
      await fixture.store.createItem("tasks", milestone.id, {
        id: "T2346", status: "wip", fields: { headline: "concurrent source" },
      });
      await fixture.store.createItem("defects", "M-AMBIENT", {
        id: "D1", status: "root-caused", fields: { headline: "fenced", severity: "high", dependsOn: ["tasks:T2345"] },
      });
      const completion = await directCompletionRecord();
      await sourceStore.init();
      await completionStore.init();
      const boundApplicationNames = await fixture.pool<Array<{ application_name: string }>>`
        SELECT DISTINCT application_name FROM pg_stat_activity
        WHERE application_name = ${sourceApplicationName}
          OR application_name = ${completionApplicationName}`;
      expect(boundApplicationNames.map(({ application_name }) => application_name).sort()).toEqual(
        [sourceApplicationName, completionApplicationName].sort(),
      );
      const sourceWorkset = sourceStore.worksetStore();
      const mutations = createWorksetGenericMutationGateway({
        rawStore: sourceStore,
        worksetStore: sourceWorkset,
        runGenericTransaction: (mutate, measurement, scope, context, binding) =>
          sourceStore.runAtomicGenericMutation(mutate, undefined, measurement, scope, context, binding),
      });
      const queued = await fixture.pool.begin(async (holder) => {
        await holder`SELECT 1 FROM items WHERE project_key = ${fixture.projectKey}
          AND ledger = 'defects' AND id = 'D1' FOR UPDATE`;
        const source = mutations.updateItem("tasks", "T2346", { fields: { ledgerRefs: ["defects:D1"] } });
        pending.push(source);
        await waitForPostgresLock(fixture.pool, sourceApplicationName, 1_000);
        const record = recordProtectedImplementationCompletion(
          completionStore,
          DIRECT_TASK_AUTHORITY,
          completion,
          LIFECYCLE_PROVENANCE,
        );
        pending.push(record);
        await waitForPostgresLock(fixture.pool, completionApplicationName, 1_000);
        return { source, record };
      });
      await queued.source;
      await expect(queued.record).resolves.toEqual({ reviewRef: "reviews:R1" });
      await fixture.store.reloadCommittedState();
      expect(fixture.store.fetchItem("tasks", "T2345").status).toBe("done");
      expect(fixture.store.fetchItem("tasks", "T2346").status).toBe("wip");
      expect(fixture.store.fetchItem("defects", "D1").status).toBe("root-caused");
    } finally {
      await Promise.allSettled(pending);
      await sourceStore.dispose();
      await completionStore.dispose();
      await fixture.dispose();
    }
  });
});
