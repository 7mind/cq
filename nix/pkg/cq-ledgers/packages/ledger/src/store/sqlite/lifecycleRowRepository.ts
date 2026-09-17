import type { Database } from "bun:sqlite";
import { PlanOperationReplayRecordSchema, PlanPrivateClaimRecordSchema } from "../../planLifecycle.js";
import { LedgerError } from "../../types.js";
import type { LifecycleGroup, LifecycleRowRepository } from "../lifecycleRowRepository.js";
import { claimScopeKey, operationScopeKey } from "../planLifecycleDump.js";
import { createSqliteGenericMutationDataSource } from "./genericMutationDataSource.js";
import type { SqliteOperationMeasurement } from "./operationObservability.js";

interface PlanRecordRow {
  readonly scope: string;
  readonly record_json: string;
}

export function createSqliteLifecycleRowRepository(
  db: Database,
  measurement: SqliteOperationMeasurement | null,
): LifecycleRowRepository {
  const { listLedgers, fetchActiveItem, fetchArchivedItem, referenceTargets, referenceSources } =
    createSqliteGenericMutationDataSource(db, measurement ?? undefined);
  const record = (table: string, mode: "read" | "write", key: string, rowKeys: readonly string[]): void => {
    if (measurement === null) return;
    measurement.recordAccess({
      phase: "transaction", table, mode,
      keyedPredicate: { kind: "keys", keys: [key] },
      rowKeys, count: rowKeys.length,
    });
  };
  const claimResult = (key: string, row: PlanRecordRow | null) => {
    record("plan_claims", "read", key, row === null ? [] : [row.scope]);
    return row === null ? undefined : PlanPrivateClaimRecordSchema.parse(JSON.parse(row.record_json));
  };
  return {
    publicRows: { listLedgers, fetchActiveItem, fetchArchivedItem, referenceTargets, referenceSources },
    fetchGroup(ledgerId, groupId) {
      const row = db.query("SELECT id, title, description FROM groups WHERE ledger = ? AND id = ?")
        .get(ledgerId, groupId) as LifecycleGroup | null;
      const key = `${ledgerId}:${groupId}`;
      record("groups", "read", key, row === null ? [] : [key]);
      return row === null ? undefined : row;
    },
    taskRefsByMilestones(milestoneIds) {
      if (milestoneIds.length === 0) return [];
      const placeholders = milestoneIds.map(() => "?").join(", ");
      const rows = db.query(`SELECT i.id, g.id AS group_id FROM groups g JOIN items i
        ON i.ledger = g.ledger AND i.milestone_id = g.id
        WHERE g.ledger = 'tasks' AND g.id IN (${placeholders}) ORDER BY g.rowid, i.rowid`)
        .all(...milestoneIds) as Array<{ id: string; group_id: string }>;
      const refs = rows.map(({ id }) => `tasks:${id}`);
      if (measurement !== null) {
        const groupRefs = [...new Set(rows.map(({ group_id }) => `tasks:${group_id}`))];
        measurement.recordAccess({
          phase: "transaction", table: "groups", mode: "read",
          keyedPredicate: { kind: "keys", keys: milestoneIds.map((id) => `tasks:${id}`) },
          rowKeys: groupRefs, count: groupRefs.length,
        });
        measurement.recordAccess({
          phase: "transaction", table: "items", mode: "read",
          keyedPredicate: { kind: "milestone-members", keys: milestoneIds },
          rowKeys: refs, count: refs.length,
        });
      }
      return refs;
    },
    fetchClaimByRequest(key) {
      const row = db.query("SELECT scope, record_json FROM plan_claims WHERE goal_id = ? AND claim_request_id = ?")
        .get(key.goalId, key.claimRequestId) as PlanRecordRow | null;
      return claimResult(claimScopeKey(key.goalId, key.claimRequestId), row);
    },
    fetchClaimByIdentity(key) {
      const row = db.query("SELECT scope, record_json FROM plan_claims WHERE goal_id = ? AND claim_id = ? AND generation = ?")
        .get(key.goalId, key.claimId, key.generation) as PlanRecordRow | null;
      return claimResult([key.goalId, key.claimId, key.generation].join("\u0000"), row);
    },
    fetchActiveClaim(goalId) {
      const row = db.query("SELECT scope, record_json FROM plan_claims WHERE goal_id = ? AND state = 'active'")
        .get(goalId) as PlanRecordRow | null;
      return claimResult(goalId, row);
    },
    fetchOperation(key) {
      const scope = operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId);
      const row = db.query(`SELECT scope, record_json FROM plan_operations
        WHERE goal_id = ? AND claim_id = ? AND generation = ? AND operation_kind = ? AND operation_id = ?`)
        .get(key.goalId, key.claimId, key.generation, key.operation, key.operationId) as PlanRecordRow | null;
      record("plan_operations", "read", scope, row === null ? [] : [row.scope]);
      if (row === null) return undefined;
      const parsed = JSON.parse(row.record_json) as { replay: unknown; acknowledgement: unknown };
      return { replay: PlanOperationReplayRecordSchema.parse(parsed.replay), acknowledgement: parsed.acknowledgement };
    },
    fetchImplementationCompletionBinding(taskId) {
      const row = db.query("SELECT task_id, review_ref FROM implementation_completion_bindings WHERE task_id = ?")
        .get(taskId) as { task_id: string; review_ref: string } | null;
      record("implementation_completion_bindings", "read", taskId, row === null ? [] : [row.task_id]);
      return row === null ? undefined : { taskId: row.task_id, reviewRef: row.review_ref };
    },
    persistPrivateRecords(changes) {
      if (!db.inTransaction) throw new LedgerError("lifecycle row persistence requires a write transaction");
      for (const claim of changes.claims) {
        const scope = claimScopeKey(claim.goalId, claim.claimRequestId);
        db.query(`INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)
          ON CONFLICT(scope) DO UPDATE SET record_json = excluded.record_json`).run(scope, JSON.stringify(claim));
        record("plan_claims", "write", scope, [scope]);
      }
      for (const operation of changes.operations) {
        const key = operation.replay;
        const scope = operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId);
        db.query("INSERT INTO plan_operations (scope, record_json) VALUES (?, ?)").run(scope, JSON.stringify(operation));
        record("plan_operations", "write", scope, [scope]);
      }
    },
    persistImplementationCompletionBindings(changes) {
      if (!db.inTransaction) throw new LedgerError("completion binding persistence requires a write transaction");
      for (const binding of changes) {
        db.query("INSERT INTO implementation_completion_bindings (task_id, review_ref) VALUES (?, ?)")
          .run(binding.taskId, binding.reviewRef);
        record("implementation_completion_bindings", "write", binding.taskId, [binding.taskId]);
      }
    },
  };
}
