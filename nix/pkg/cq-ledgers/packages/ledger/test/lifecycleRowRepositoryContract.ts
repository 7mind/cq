import { describe, expect, test } from "bun:test";
import { CANONICAL_LEDGERS } from "../src/constants.js";
import type { PlanPrivateClaimRecord } from "../src/planLifecycle.js";
import type { Item } from "../src/types.js";
import type { InMemoryPlanOperationRecord } from "../src/store/inMemoryPlanLifecycle.js";
import type { LifecycleRowRepository } from "../src/store/lifecycleRowRepository.js";

export function lifecycleClaim(goalId: string): PlanPrivateClaimRecord {
  return {
    goalId, claimId: `claim_${goalId}_1`, generation: 1, purpose: "initial",
    claimRequestId: `request-${goalId}`, ownerFenceTokenVerifier: "a".repeat(64),
    expectedGeneration: null, priorGeneration: null, previousGoalPhase: "clarifying",
    goalPhase: "planning", legacyAdopted: false,
    adoptedManifest: { milestoneIds: [], taskIds: [] },
    waitingResearches: [], waitingTasks: [], state: "active", author: "T5541",
  };
}

export function lifecycleOperation(operationId: string): InMemoryPlanOperationRecord {
  return {
    replay: {
      goalId: "G1", claimId: "claim_G1_1", generation: 1,
      operation: "release", operationId, requestPayloadVerifier: "b".repeat(64),
    },
    acknowledgement: { retained: operationId },
  };
}

export const LIFECYCLE_PUBLIC_ITEMS: readonly { ledgerId: string; item: Item }[] = [
  { ledgerId: "goals", item: {
    id: "G1", milestoneId: "M-AMBIENT", status: "planning",
    fields: { title: "selected", description: "selected" }, createdAt: "now", updatedAt: "now",
  } },
  { ledgerId: "tasks", item: {
    id: "T1", milestoneId: "M1", status: "planned",
    fields: { headline: "owned", worksetOwnerRef: "goals:G1", dependsOn: ["tasks:T2"] },
    createdAt: "now", updatedAt: "now",
  } },
  ...[["T10", "M4"], ["T3", "M3"], ["T2", "M4"]].map(([id, milestoneId]) => ({
    ledgerId: "tasks", item: {
      id: id!, milestoneId: milestoneId!, status: "planned", fields: { headline: "ordered" },
      createdAt: "now", updatedAt: "now",
    },
  })),
];

export const LIFECYCLE_ARCHIVED_ITEM: Item = {
  id: "T2", milestoneId: "M2", status: "done", fields: { headline: "archived" },
  createdAt: "now", updatedAt: "now",
};

export const LIFECYCLE_LEDGER_METADATA = CANONICAL_LEDGERS.map(({ name, schema }) => ({
  id: name, schema, counters: { milestone: 2, item: 2 },
}));

export interface LifecycleRowsFixture {
  readonly rows: LifecycleRowRepository;
  transaction<T>(body: () => T): T;
  dispose(): Promise<void>;
}

export function runLifecycleRowRepositoryContract(
  name: string,
  build: () => Promise<LifecycleRowsFixture>,
): void {
  describe(`keyed lifecycle row repository — ${name} [Behavioral-Active Blackbox]`, () => {
    test("reads only the requested public identities, membership, archive and incident refs", async () => {
      const fixture = await build();
      try {
        const rows = fixture.rows;
        expect(rows.publicRows.fetchActiveItem("goals:G1")).toEqual(LIFECYCLE_PUBLIC_ITEMS[0]!.item);
        expect(rows.publicRows.fetchActiveItem("goals:G-missing")).toBeUndefined();
        expect(rows.publicRows.fetchArchivedItem("tasks:T2")?.item).toEqual(LIFECYCLE_ARCHIVED_ITEM);
        expect(rows.publicRows.fetchArchivedItem("tasks:T-missing")).toBeUndefined();
        expect(rows.fetchGroup("tasks", "M1")).toEqual({ id: "M1", title: "members", description: "selected" });
        expect(rows.fetchGroup("goals", "M1")).toBeUndefined();
        expect(rows.taskRefsByMilestones(["M1"])).toEqual(["tasks:T1"]);
        expect(rows.taskRefsByMilestones(["M-missing"])).toEqual([]);
        expect(rows.taskRefsByMilestones([])).toEqual([]);
        expect(rows.taskRefsByMilestones(["M3", "M4", "M4"])).toEqual(["tasks:T10", "tasks:T2", "tasks:T3"]);
        expect(rows.publicRows.referenceSources("goals:G1", ["worksetOwnerRef"])).toEqual(["tasks:T1"]);
        expect(rows.publicRows.referenceTargets("tasks:T1", ["dependsOn"])).toEqual(["tasks:T2"]);
        expect(rows.publicRows.listLedgers().find(({ id }) => id === "tasks")?.counters).toEqual({ milestone: 2, item: 2 });
      } finally { await fixture.dispose(); }
    });

    test("partitions private request, claim, active-goal and operation identities", async () => {
      const fixture = await build();
      try {
        const rows = fixture.rows;
        const claim = lifecycleClaim("G1");
        expect(rows.fetchClaimByRequest(claim)).toEqual(claim);
        expect(rows.fetchClaimByIdentity(claim)).toEqual(claim);
        expect(rows.fetchActiveClaim("G1")).toEqual(claim);
        expect(rows.fetchClaimByRequest({ ...claim, claimRequestId: "other" })).toBeUndefined();
        expect(rows.fetchClaimByRequest({ ...claim, goalId: "G2" })).toBeUndefined();
        expect(rows.fetchClaimByIdentity({ ...claim, goalId: "G2" })).toBeUndefined();
        expect(rows.fetchClaimByIdentity({ ...claim, claimId: "other" })).toBeUndefined();
        expect(rows.fetchClaimByIdentity({ ...claim, generation: 2 })).toBeUndefined();
        expect(rows.fetchActiveClaim("G-missing")).toBeUndefined();
        const operation = lifecycleOperation("existing");
        expect(rows.fetchOperation(operation.replay)).toEqual(operation);
        for (const key of [
          { ...operation.replay, goalId: "G2" },
          { ...operation.replay, claimId: "other" },
          { ...operation.replay, generation: 2 },
          { ...operation.replay, operation: "publish-draft" as const },
          { ...operation.replay, operationId: "other" },
        ]) expect(rows.fetchOperation(key)).toBeUndefined();
      } finally { await fixture.dispose(); }
    });

    test("persists the selected claim and immutable operation without modifying a sibling", async () => {
      const fixture = await build();
      try {
        const claim = { ...lifecycleClaim("G1"), state: "released" as const };
        const operation = lifecycleOperation("new");
        fixture.transaction(() => fixture.rows.persistPrivateRecords({ claims: [claim], operations: [operation] }));
        expect(fixture.rows.fetchClaimByRequest(claim)).toEqual(claim);
        expect(fixture.rows.fetchActiveClaim("G1")).toBeUndefined();
        expect(fixture.rows.fetchActiveClaim("G2")).toEqual(lifecycleClaim("G2"));
        expect(fixture.rows.fetchOperation(operation.replay)).toEqual(operation);
        expect(fixture.rows.fetchOperation(lifecycleOperation("existing").replay)).toEqual(lifecycleOperation("existing"));
        expect(() => fixture.transaction(() => fixture.rows.persistPrivateRecords({ claims: [], operations: [operation] }))).toThrow();
        expect(fixture.rows.fetchOperation(operation.replay)).toEqual(operation);
      } finally { await fixture.dispose(); }
    });

    test("rolls back both private record kinds on failure and refuses writes outside a transaction", async () => {
      const fixture = await build();
      try {
        const changes = {
          claims: [{ ...lifecycleClaim("G1"), state: "released" as const }],
          operations: [lifecycleOperation("rolled-back")],
        };
        expect(() => fixture.rows.persistPrivateRecords(changes)).toThrow("requires a write transaction");
        expect(() => fixture.transaction(() => {
          fixture.rows.persistPrivateRecords(changes);
          throw new Error("injected after private writes");
        })).toThrow("injected after private writes");
        expect(fixture.rows.fetchActiveClaim("G1")).toEqual(lifecycleClaim("G1"));
        expect(fixture.rows.fetchOperation(changes.operations[0]!.replay)).toBeUndefined();
        expect(() => fixture.transaction(() => fixture.rows.persistPrivateRecords({
          claims: changes.claims, operations: [lifecycleOperation("existing")],
        }))).toThrow();
        expect(fixture.rows.fetchActiveClaim("G1")).toEqual(lifecycleClaim("G1"));
      } finally { await fixture.dispose(); }
    });
  });
}
