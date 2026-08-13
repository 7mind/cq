/** T1980 live PostgreSQL validated-root replacement coherence and ordering. */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  TASKS_LEDGER,
} from "../src/index.js";

const dsn = process.env.CQ_TEST_PG_URL;

if (dsn === undefined || dsn.length === 0) {
  if (process.env.CQ_TEST_REQUIRE_PG === "1") {
    throw new Error(
      "CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN",
    );
  }
  describe.skip("workset root replacement — PostgresLedgerStore", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const setupPool = openPgPool(dsn);
  const schemaReady = ensureSchema(setupPool);
  const stores: PostgresLedgerStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.dispose()));
  });

  afterAll(async () => {
    await Promise.all(stores.splice(0).map((store) => store.dispose()));
    await setupPool.close();
  });

  async function openStore(
    projectKey: string,
    hooks?: { afterExclusiveReady(): Promise<void> },
  ): Promise<PostgresLedgerStore> {
    await schemaReady;
    const store = new PostgresLedgerStore({
      pool: new SQL({ url: dsn, max: 1 }),
      projectKey,
      displayName: projectKey,
      ...(hooks === undefined ? {} : { workset: { hooks } }),
    });
    stores.push(store);
    await store.init();
    return store;
  }

  describe("workset root replacement — PostgresLedgerStore [Behavioral-Active Blackbox-GoodCommunication]", () => {
    it("absorbs a peer-created root into cache and FTS before returning", async () => {
      const projectKey = `t1980-replace-${randomUUID()}`;
      const peer = await openStore(projectKey);
      const setter = await openStore(projectKey);
      const milestone = await peer.createMilestone({ title: "peer state" });
      const item = await peer.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "postgres-peer-root-term" },
      });

      await expect(setter.replaceWorksetRoots([`${TASKS_LEDGER}:${item.id}`])).resolves.toEqual({
        roots: [`${TASKS_LEDGER}:${item.id}`],
        epoch: 1,
      });
      expect(setter.fetchItem(TASKS_LEDGER, item.id).fields["headline"]).toBe(
        "postgres-peer-root-term",
      );
      expect(
        (await setter.ftsSearch("postgres-peer-root-term", { ledger: TASKS_LEDGER })).map(
          (hit) => hit.item.id,
        ),
      ).toContain(item.id);
    });

    it("rejects a root archived while replacement waits at the exclusive boundary", async () => {
      const ready = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let pause = false;
      const projectKey = `t1980-archive-race-${randomUUID()}`;
      const peer = await openStore(projectKey);
      const setter = await openStore(projectKey, {
        async afterExclusiveReady() {
          if (!pause) return;
          ready.resolve();
          await resume.promise;
        },
      });
      try {
        const milestone = await peer.createMilestone({ title: "archive race" });
        const item = await peer.createItem(TASKS_LEDGER, milestone.id, {
          status: "done",
          fields: { headline: "root leaves active state" },
        });
        await peer.updateMilestone(milestone.id, { status: "done" });

        pause = true;
        const replacement = setter.replaceWorksetRoots([`${TASKS_LEDGER}:${item.id}`]);
        await ready.promise;
        await peer.archiveMilestone(milestone.id, "peer archived");
        resume.resolve();

        await expect(replacement).rejects.toThrow(/inactive/);
        expect(await setter.worksetStore().snapshot()).toEqual({ roots: [], epoch: 0 });
      } finally {
        resume.resolve();
      }
    });
  });
}
