import { PlanOperationReplayRecordSchema, PlanPrivateClaimRecordSchema } from "../../planLifecycle.js";
import type { AsyncLifecycleRowRepository } from "../asyncRowRepository.js";
import type { LifecycleGroup, LifecyclePrivateRecordChanges } from "../lifecycleRowRepository.js";
import { claimScopeKey, decodePostgresPlanScope, encodePostgresPlanScope, operationScopeKey } from "../planLifecycleDump.js";
import { createPostgresGenericMutationDataSource } from "./genericMutationDataSource.js";
import { PostgresOperationQueries, type PostgresStatement } from "./operationAccess.js";

interface PlanRecordRow {
  readonly scope: string;
  readonly record_json: string;
}

export function createPostgresLifecycleRowRepository(queries: PostgresOperationQueries): AsyncLifecycleRowRepository {
  const projectKey = queries.projectKey;
  const read = <Row>(table: string, keys: readonly string[], statement: PostgresStatement, keyOf: (row: Row) => string) =>
    queries.execute({ table, phase: "transaction", mode: "read", predicate: { kind: "keys", keys }, lockMode: "none" }, statement, keyOf);
  const claim = async (key: string, statement: PostgresStatement) => {
    const rows = await read<PlanRecordRow>("plan_claims", [key], statement, ({ scope }) => decodePostgresPlanScope(scope));
    for (const { scope } of rows) queries.recordReadTarget({ table: "plan_claims", scope: decodePostgresPlanScope(scope) });
    return rows[0] === undefined ? undefined : PlanPrivateClaimRecordSchema.parse(JSON.parse(rows[0].record_json));
  };
  return {
    publicRows: createPostgresGenericMutationDataSource(queries),
    async fetchGroup(ledgerId, groupId) {
      queries.recordReadTarget({ table: "groups", ledgerId, id: groupId });
      const rows = await read<LifecycleGroup>("groups", [`${ledgerId}:${groupId}`], {
        sql: "SELECT id, title, description FROM groups WHERE project_key = $1 AND ledger = $2 AND id = $3",
        parameters: [projectKey, ledgerId, groupId],
      }, ({ id }) => `${ledgerId}:${id}`);
      return rows[0];
    },
    async taskRefsByMilestones(ids) {
      if (ids.length === 0) return [];
      const rows = await queries.executeJoined<{ id: string; group_id: string }>({ table: "items", phase: "transaction", mode: "read",
        predicate: { kind: "milestone-members", keys: ids }, lockMode: "none" }, {
        sql: `SELECT i.id, g.id AS group_id FROM groups g JOIN items i
          ON i.project_key = g.project_key AND i.ledger = g.ledger AND i.milestone_id = g.id
          WHERE g.project_key = $1 AND g.ledger = 'tasks' AND g.id = ANY($2::text[]) ORDER BY g.seq, i.seq`,
        parameters: [projectKey, ids],
      }, ({ id }) => `tasks:${id}`, [{ table: "groups", predicate: { kind: "keys", keys: ids.map((id) => `tasks:${id}`) },
        rowKeys: (rows) => [...new Set(rows.map(({ group_id }) => `tasks:${group_id}`))] }]);
      for (const { id, group_id } of rows) {
        queries.recordReadTarget({ table: "items", ledgerId: "tasks", id });
        queries.recordReadTarget({ table: "groups", ledgerId: "tasks", id: group_id });
      }
      return rows.map(({ id }) => `tasks:${id}`);
    },
    fetchClaimByRequest(key) {
      return claim(claimScopeKey(key.goalId, key.claimRequestId), {
        sql: "SELECT scope, record_json FROM plan_claims WHERE project_key = $1 AND goal_id = $2 AND claim_request_id = $3",
        parameters: [projectKey, key.goalId, key.claimRequestId],
      });
    },
    fetchClaimByIdentity(key) {
      return claim([key.goalId, key.claimId, key.generation].join("\u0000"), {
        sql: "SELECT scope, record_json FROM plan_claims WHERE project_key = $1 AND goal_id = $2 AND claim_id = $3 AND generation = $4",
        parameters: [projectKey, key.goalId, key.claimId, key.generation],
      });
    },
    fetchActiveClaim(goalId) {
      return claim(goalId, { sql: "SELECT scope, record_json FROM plan_claims WHERE project_key = $1 AND goal_id = $2 AND state = 'active'",
        parameters: [projectKey, goalId] });
    },
    async fetchOperation(key) {
      const scope = operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId);
      const rows = await read<PlanRecordRow>("plan_operations", [scope], {
        sql: `SELECT scope, record_json FROM plan_operations WHERE project_key = $1 AND goal_id = $2 AND claim_id = $3
          AND generation = $4 AND operation_kind = $5 AND operation_id = $6`,
        parameters: [projectKey, key.goalId, key.claimId, key.generation, key.operation, key.operationId],
      }, ({ scope }) => decodePostgresPlanScope(scope));
      if (rows[0] === undefined) return undefined;
      queries.recordReadTarget({ table: "plan_operations", scope: decodePostgresPlanScope(rows[0].scope) });
      const parsed = JSON.parse(rows[0].record_json) as { replay: unknown; acknowledgement: unknown };
      return { replay: PlanOperationReplayRecordSchema.parse(parsed.replay), acknowledgement: parsed.acknowledgement };
    },
  };
}

/** The caller owns the surrounding PostgreSQL transaction and its lock order. */
export async function persistPostgresPrivateRecords(queries: PostgresOperationQueries, changes: LifecyclePrivateRecordChanges): Promise<void> {
  const write = async (table: "plan_claims" | "plan_operations", scope: string, json: string, suffix: string) => {
    await queries.execute<{ scope: string }>({ table, phase: "transaction", mode: "write",
      predicate: { kind: "keys", keys: [scope] }, lockMode: "update" }, {
      sql: `INSERT INTO ${table} (project_key, scope, record_json) VALUES ($1, $2, $3) ${suffix} RETURNING scope`,
      parameters: [queries.projectKey, encodePostgresPlanScope(scope), json],
    }, ({ scope }) => decodePostgresPlanScope(scope));
  };
  for (const claim of changes.claims) await write("plan_claims", claimScopeKey(claim.goalId, claim.claimRequestId), JSON.stringify(claim),
    "ON CONFLICT (project_key, scope) DO UPDATE SET record_json = EXCLUDED.record_json");
  for (const operation of changes.operations) {
    const key = operation.replay;
    await write("plan_operations", operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), JSON.stringify(operation), "");
  }
}
