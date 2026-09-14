import type { Item, Ledger } from "../../types.js";
import type { LifecyclePrivateRecordChanges } from "../lifecycleRowRepository.js";
import { claimScopeKey, operationScopeKey } from "../planLifecycleDump.js";
import type { PostgresCoherenceChange } from "./coherenceVector.js";
import type { PostgresPublicRowPlan } from "./planRowPersistence.js";
import type { PostgresGenericRowChanges } from "./genericRowPersistence.js";
import type { PostgresSelectedPublicRow } from "./selectedPublicRows.js";

export const POSTGRES_GROUP_CONTROL_PREFIX = "groups:";
export const POSTGRES_POINTER_CONTROL_PREFIX = "archive_pointers:";
export const POSTGRES_LEDGER_CONTROL_ID = "ledger-metadata";
export const POSTGRES_RESET_CONTROL_ID = "tenant-reset";

export function postgresPublicPlanChanges(plan: PostgresPublicRowPlan, dirtyLedgers: readonly string[]): PostgresCoherenceChange[] {
  const changes: PostgresCoherenceChange[] = [];
  const items = (ledger: Ledger | undefined) => new Map((ledger === undefined ? [] : ledger.milestones).flatMap((group) =>
    group.items.map((item) => [item.id, item] as const)));
  const changedRows = <Row>(ledger: string, before: ReadonlyMap<string, Row>, after: ReadonlyMap<string, Row>,
    scope: PostgresCoherenceChange["scope"], prefix: string) => {
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (JSON.stringify(before.get(key)) === JSON.stringify(after.get(key))) continue;
      changes.push({ ledger, documentId: prefix + key, scope, kind: after.has(key) ? "upsert" : "delete" });
    }
  };
  for (const ledger of new Set(dirtyLedgers)) {
    const before = plan.beforeLedgers.get(ledger);
    const after = plan.state.ledgers.get(ledger);
    changedRows<Item>(ledger, items(before), items(after), "active", "");
    const metadata = (value: Ledger | undefined) => value === undefined ? undefined : { schema: value.schema, counters: value.counters };
    if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))) {
      changes.push({ ledger, documentId: POSTGRES_LEDGER_CONTROL_ID, scope: "registry", kind: after === undefined ? "delete" : "upsert" });
    }
    const groups = (value: Ledger | undefined) => new Map((value === undefined ? [] : value.milestones).map(({ id, title, description }) => [id, { title, description }]));
    changedRows(ledger, groups(before), groups(after), "control", POSTGRES_GROUP_CONTROL_PREFIX);
    const pointers = (value: Ledger | undefined) => new Map((value === undefined ? [] : value.archivePointers).map((pointer) => [pointer.id, pointer]));
    changedRows(ledger, pointers(before), pointers(after), "control", POSTGRES_POINTER_CONTROL_PREFIX);
  }
  return changes;
}

export function postgresPrivatePlanChanges(changes: LifecyclePrivateRecordChanges): PostgresCoherenceChange[] {
  return [
    ...changes.claims.map((claim): PostgresCoherenceChange => ({ ledger: "goals", scope: "control", kind: "upsert",
      documentId: `plan_claims:${claimScopeKey(claim.goalId, claim.claimRequestId)}` })),
    ...changes.operations.map(({ replay }): PostgresCoherenceChange => ({ ledger: "goals", scope: "control", kind: "upsert",
      documentId: `plan_operations:${operationScopeKey(replay.goalId, replay.claimId, replay.generation, replay.operation, replay.operationId)}` })),
  ];
}

export function postgresSelectedRowChanges(rows: Iterable<PostgresSelectedPublicRow>): PostgresCoherenceChange[] {
  return [...rows].filter(({ item, before }) => JSON.stringify(item) !== before).map(({ ledgerId, item }) =>
    ({ ledger: ledgerId, documentId: item.id, scope: "active", kind: "upsert" }));
}

export function postgresArchivedRowChanges(changes: PostgresGenericRowChanges): PostgresCoherenceChange[] {
  return [
    ...changes.archivedDeletes.map(({ ledgerId, pointerId, itemId }): PostgresCoherenceChange =>
      ({ ledger: ledgerId, documentId: JSON.stringify([pointerId, itemId]), scope: "archived", kind: "delete" })),
    ...changes.archivedUpserts.map(({ ledgerId, pointerId, item }): PostgresCoherenceChange =>
      ({ ledger: ledgerId, documentId: JSON.stringify([pointerId, item.id]), scope: "archived", kind: "upsert" })),
  ];
}
