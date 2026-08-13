/**
 * T1976 — shared canonical-ownership lifecycle contract over real adapters.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox. The same contract
 * drives FS, Git-object, SQLite, and live PostgreSQL; adapter fault tests own
 * transaction/restart details separately.
 */

import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  buildBackupDump,
  parseBackupDump,
  readCanonicalOwnership,
  type LedgerStore,
} from "../src/index.js";
import type { WorksetPlanLifecycleContractFactory } from "./worksetPlanLifecycleContract.js";
import {
  fsPlanLifecycleFactory,
  gitPlanLifecycleFactory,
  postgresPlanLifecycleFactory,
  sqlitePlanLifecycleFactory,
} from "./worksetPlanLifecycleDurableFactories.js";

const PROVENANCE = { author: "T1976", session: "owner-lifecycle" } as const;

function register(factory: WorksetPlanLifecycleContractFactory): void {
  describe(`${factory.name} canonical owner lifecycle [BA]`, () => {
    it("round-trips real owned-write and guarded-plan ownership through a dump", async () => {
      const store = await factory.build({ now: () => "2026-08-13T18:30:00.000Z" });
      await store.init();
      await store.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "I1",
        status: "open",
        fields: { title: "Idea", description: "Owned goal source" },
        ...PROVENANCE,
      });
      await store.owned.createOwned({
        owner: { ledgerId: IDEAS_LEDGER, itemId: "I1" },
        creationKind: "idea-to-goal",
        child: {
          ledgerId: GOALS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "G1",
          status: "clarifying",
          fields: { title: "Goal", description: "Guarded plan owner" },
          ...PROVENANCE,
        },
      });
      const claimed = await store.claimPlan({
        goalId: "G1",
        purpose: "initial",
        claimRequestId: "claim-1",
        ownerFenceToken: "aaaaaaaaaaaaaaaaaaaaaa",
        expectedGeneration: null,
        ...PROVENANCE,
      });
      if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
      const published = await store.publishPlanDraft({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "publish-1",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
        },
        ...PROVENANCE,
      });
      if (!published.ok) throw new Error(`publish failed: ${published.conflict.code}`);

      // The guarded surface intentionally omits raw mutation methods, but its
      // read surface matches the exporter input. The cast documents that
      // narrower runtime use without widening the public capability.
      const parsed = parseBackupDump(await buildBackupDump(store as unknown as LedgerStore, null));
      const goal = parsed.ledgers
        .get(GOALS_LEDGER)
        ?.milestones.flatMap(({ items }) => items)
        .find(({ id }) => id === "G1");
      const milestoneId = published.acknowledgement.manifest.milestones[0]?.id;
      const taskId = published.acknowledgement.manifest.tasks[0]?.id;
      const milestone = parsed.ledgers
        .get(MILESTONES_LEDGER)
        ?.milestones.flatMap(({ items }) => items)
        .find(({ id }) => id === milestoneId);
      const task = parsed.ledgers
        .get(TASKS_LEDGER)
        ?.milestones.flatMap(({ items }) => items)
        .find(({ id }) => id === taskId);
      expect(goal === undefined ? null : readCanonicalOwnership(goal)).toEqual({
        ownerRef: "ideas:I1",
        edgeKind: "idea-to-goal",
      });
      for (const item of [milestone, task]) {
        expect(item === undefined ? null : readCanonicalOwnership(item)).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "active-current-draft",
        });
      }
    });
  });
}

register(fsPlanLifecycleFactory);
register(gitPlanLifecycleFactory);
register(sqlitePlanLifecycleFactory);

const pgUrl = process.env.CQ_TEST_PG_URL;
if (pgUrl === undefined || pgUrl.length === 0) {
  if (process.env.CQ_TEST_REQUIRE_PG === "1") {
    throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
  }
  describe.skip("PostgresLedgerStore canonical owner lifecycle [BA]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  register(postgresPlanLifecycleFactory(pgUrl));
}
