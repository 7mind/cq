/**
 * T1962 — contract module load + shared suite entry (in-memory leg also runs
 * via workset-owned-write-inmemory.test.ts).
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_OWNED_WRITE_CREATION_KINDS,
  defaultChildLedgerForCreationKind,
  PLANNING_LIFECYCLE_CREATION_KINDS,
  IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
  GOALS_LEDGER,
  TASKS_LEDGER,
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { createInMemoryWorksetOwnedGuardedLedger } from "../src/index.js";

runWorksetOwnedWriteContract({
  name: "in-memory-dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) =>
    createInMemoryWorksetOwnedGuardedLedger({
      ...options,
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    }),
});

describe("workset owned-write contract module [T1962]", () => {
  // regression: defects:D303
  it("plan publication is exclusive to the guarded lifecycle [Behavioral-Active Blackbox-Atomic]", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    });
    await ledger.init();
    const activeGoal = await ledger.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      status: "planning",
      fields: { title: "unguarded active draft", description: "regression" },
    });
    const finalizedGoal = await ledger.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      status: "planned",
      fields: { title: "unguarded finalized manifest", description: "regression" },
    });
    const legacyPublish = (
      ledger.bundles as unknown as {
        publishOwnedDraft?: (input: {
          goalId: string;
          creationKind: "active-current-draft" | "finalized-manifest";
          milestone: { title: string };
          tasks: readonly [{ headline: string }];
        }) => Promise<unknown>;
      }
    ).publishOwnedDraft;
    const publishedFields: unknown[] = [];
    if (legacyPublish !== undefined) {
      await legacyPublish.call(ledger.bundles, {
        goalId: activeGoal.id,
        creationKind: "active-current-draft",
        milestone: { title: "unguarded active milestone" },
        tasks: [{ headline: "unguarded active task" }],
      });
      await legacyPublish.call(ledger.bundles, {
        goalId: finalizedGoal.id,
        creationKind: "finalized-manifest",
        milestone: { title: "unguarded finalized milestone" },
        tasks: [{ headline: "unguarded finalized task" }],
      });
      publishedFields.push(
        ledger.fetchItem(GOALS_LEDGER, activeGoal.id).fields[
          PLAN_CURRENT_DRAFT_FIELD
        ],
        ledger.fetchItem(GOALS_LEDGER, finalizedGoal.id).fields[
          PLAN_FINALIZED_MANIFEST_FIELD
        ],
      );
    }

    expect(publishedFields).toEqual([]);
  });

  it("limits owned writes to single-child and bootstrap creation kinds", () => {
    const covered = new Set<string>(WORKSET_OWNED_WRITE_CREATION_KINDS);
    const lifecycleKinds = new Set<string>([
      ...PLANNING_LIFECYCLE_CREATION_KINDS,
      ...IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
    ]);
    expect(covered.has("active-current-draft")).toBe(false);
    expect(covered.has("finalized-manifest")).toBe(false);
    expect(lifecycleKinds.has("active-current-draft")).toBe(true);
    expect(lifecycleKinds.has("finalized-manifest")).toBe(true);
    for (const k of WORKSET_OWNED_WRITE_CREATION_KINDS) {
      expect(defaultChildLedgerForCreationKind(k)).toBeDefined();
    }
  });

  it("rejects both manifest creation kinds through the owned-write gateway", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const goal = await ledger.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      status: "planning",
      fields: { title: "owned-write rejection", description: "regression" },
    });
    type OwnedCreationKind = Parameters<
      typeof ledger.owned.createOwned
    >[0]["creationKind"];
    // @ts-expect-error plan publication belongs exclusively to PlanLifecycleStore
    const activeDraftKind: OwnedCreationKind = "active-current-draft";
    // @ts-expect-error plan publication belongs exclusively to PlanLifecycleStore
    const finalizedManifestKind: OwnedCreationKind = "finalized-manifest";
    void activeDraftKind;
    void finalizedManifestKind;
    const directCreate = ledger.owned.createOwned as unknown as (input: {
      owner: { ledgerId: string; itemId: string };
      creationKind: string;
      child: { ledgerId: string; status: string; fields: { headline: string } };
    }) => Promise<unknown>;
    for (const creationKind of [
      "active-current-draft",
      "finalized-manifest",
    ] as const) {
      await expect(
        directCreate({
          owner: { ledgerId: GOALS_LEDGER, itemId: goal.id },
          creationKind,
          child: {
            ledgerId: TASKS_LEDGER,
            status: "planned",
            fields: { headline: `rejected ${creationKind}` },
          },
        }),
      ).rejects.toMatchObject({ code: "owner-policy-denied" });
    }
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(0);
  });
});
