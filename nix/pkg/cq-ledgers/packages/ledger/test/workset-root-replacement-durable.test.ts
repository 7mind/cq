/** T1980 live root replacement across durable adapters. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SqliteLedgerStore,
  TASKS_LEDGER,
  type LedgerStore,
  type WorksetAdmissionCoordinatorHooks,
} from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  readonly first: LedgerStore;
  readonly second: LedgerStore;
  close(): Promise<void>;
}

interface Factory {
  readonly name: string;
  build(hooks?: WorksetAdmissionCoordinatorHooks): Promise<Fixture>;
}

async function directory(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function runContract(factory: Factory): void {
  describe(`${factory.name} [Behavioral-Active Blackbox-GoodCommunication]`, () => {
    it("absorbs peer active state and FTS before validating and committing roots", async () => {
      const fixture = await factory.build();
      try {
        const milestone = await fixture.first.createMilestone({ title: "peer state" });
        const item = await fixture.first.createItem(TASKS_LEDGER, milestone.id, {
          status: "planned",
          fields: { headline: "before peer replacement" },
        });
        await fixture.first.updateItem(TASKS_LEDGER, item.id, {
          fields: { headline: "peer-new-search-term" },
        });

        expect(await fixture.second.replaceWorksetRoots?.([`${TASKS_LEDGER}:${item.id}`])).toEqual({
          roots: [`${TASKS_LEDGER}:${item.id}`],
          epoch: 1,
        });
        expect(fixture.second.fetchItem(TASKS_LEDGER, item.id).fields["headline"]).toBe(
          "peer-new-search-term",
        );
        expect(
          (await fixture.second.ftsSearch("peer-new-search-term")).map((hit) => hit.item.id),
        ).toContain(item.id);
      } finally {
        await fixture.close();
      }
    });

    it("rejects a root archived after admission but before the native boundary", async () => {
      const ready = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let pause = false;
      const fixture = await factory.build({
        async afterExclusiveReady() {
          if (!pause) return;
          ready.resolve();
          await resume.promise;
        },
      });
      try {
        const milestone = await fixture.first.createMilestone({ title: "archive race" });
        const item = await fixture.first.createItem(TASKS_LEDGER, milestone.id, {
          status: "done",
          fields: { headline: "root leaves active state" },
        });
        await fixture.first.updateMilestone(milestone.id, { status: "done" });

        pause = true;
        const replacement = fixture.second.replaceWorksetRoots?.([
          `${TASKS_LEDGER}:${item.id}`,
        ]);
        if (replacement === undefined) throw new Error("validated replacement unavailable");
        await ready.promise;
        await fixture.first.archiveMilestone(milestone.id, "peer archived");
        resume.resolve();

        await expect(replacement).rejects.toThrow(/inactive/);
        expect(await fixture.second.worksetStore?.().snapshot()).toEqual({ roots: [], epoch: 0 });
      } finally {
        resume.resolve();
        await fixture.close();
      }
    });
  });
}

runContract({
  name: "sqlite",
  async build(hooks) {
    const root = await directory("workset-replace-sqlite-");
    const dbPath = path.join(root, "ledger.db");
    const first = new SqliteLedgerStore({ dbPath });
    const second = new SqliteLedgerStore({
      dbPath,
      ...(hooks === undefined ? {} : { workset: { hooks } }),
    });
    await first.init();
    await second.init();
    return {
      first,
      second,
      close: async () => {
        await first.dispose();
        await second.dispose();
      },
    };
  },
});
