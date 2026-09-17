import { LedgerError } from "../../types.js";
import { decodePostgresPlanScope, encodePostgresPlanScope } from "../planLifecycleDump.js";
import { PostgresOperationQueries, type PostgresQueryParameter, type PostgresRowLockMode } from "./operationAccess.js";

export type PostgresLockTarget =
  | { readonly table: "workset_roots" }
  | { readonly table: "workset_admissions"; readonly id: string }
  | { readonly table: "ledgers"; readonly ledgerId: string }
  | { readonly table: "items" | "groups" | "archive_pointers"; readonly ledgerId: string; readonly id: string }
  | { readonly table: "archived_items"; readonly ledgerId: string; readonly pointerId: string; readonly id: string }
  | { readonly table: "plan_claims" | "plan_operations"; readonly scope: string }
  | { readonly table: "implementation_completion_bindings"; readonly taskId: string }
  | { readonly table: "item_references"; readonly sourceLedger: string; readonly sourceId: string;
      readonly fieldName: string; readonly targetLedger: string; readonly targetId: string };

export interface PostgresRowLock {
  readonly target: PostgresLockTarget;
  readonly mode: Exclude<PostgresRowLockMode, "none">;
}

interface LockCoordinates {
  readonly rank: number;
  readonly key: string;
  readonly columns: readonly string[];
  readonly values: readonly PostgresQueryParameter[];
}

function coordinates(target: PostgresLockTarget): LockCoordinates {
  switch (target.table) {
    case "workset_roots": return { rank: -1, key: "roots", columns: [], values: [] };
    case "workset_admissions": return { rank: 0, key: `lease:${target.id}`, columns: ["admission_id"], values: [target.id] };
    case "items": return {
      rank: target.ledgerId === "milestones" ? 1 : target.ledgerId === "goals" ? 2 : 3,
      key: `${target.ledgerId}:${target.id}`, columns: ["ledger", "id"], values: [target.ledgerId, target.id],
    };
    case "ledgers": return { rank: 4, key: target.ledgerId, columns: ["name"], values: [target.ledgerId] };
    case "groups": case "archive_pointers": return {
      rank: target.table === "groups" ? 5 : 6, key: `${target.ledgerId}:${target.id}`,
      columns: ["ledger", "id"], values: [target.ledgerId, target.id],
    };
    case "archived_items": return { rank: 7, key: `${target.ledgerId}:${target.pointerId}:${target.id}`,
      columns: ["ledger", "pointer_id", "id"], values: [target.ledgerId, target.pointerId, target.id] };
    case "implementation_completion_bindings": return { rank: 8, key: target.taskId,
      columns: ["task_id"], values: [target.taskId] };
    case "plan_claims": case "plan_operations": return { rank: target.table === "plan_claims" ? 9 : 10,
      key: target.scope, columns: ["scope"], values: [encodePostgresPlanScope(target.scope)] };
    case "item_references": return { rank: 11,
      key: [target.sourceLedger, target.sourceId, target.fieldName, target.targetLedger, target.targetId].join(":"),
      columns: ["source_ledger", "source_id", "field_name", "target_ledger", "target_id"],
      values: [target.sourceLedger, target.sourceId, target.fieldName, target.targetLedger, target.targetId] };
  }
}

function combinedMode(left: PostgresRowLock["mode"], right: PostgresRowLock["mode"]): PostgresRowLock["mode"] {
  if (left === right) return left;
  if (left === "update" || right === "update") return "update";
  if (left === "key-share") return right;
  if (right === "key-share") return left;
  // SHARE and NO KEY UPDATE are incomparable; UPDATE subsumes both.
  return "update";
}

export function postgresRowLocksCover(held: readonly PostgresRowLock[], required: readonly PostgresRowLock[]): boolean {
  const identity = (locks: readonly PostgresRowLock[]) => JSON.stringify(orderedPostgresRowLocks(locks)
    .map(({ target, mode }) => [target.table, coordinates(target).values, mode]));
  return identity([...held, ...required]) === identity(held);
}

/** Roots, coordination parents, goals, other public rows, counters, groups, archives, private rows, then edges. */
export function orderedPostgresRowLocks(requests: readonly PostgresRowLock[]): readonly PostgresRowLock[] {
  const selected = new Map<string, PostgresRowLock>();
  for (const request of requests) {
    const location = coordinates(request.target);
    if (location.values.some((value) => typeof value === "string" && value.length === 0)) {
      throw new LedgerError(`PostgreSQL ${request.target.table} row lock has an empty identity`);
    }
    const identity = JSON.stringify([request.target.table, location.values]);
    const prior = selected.get(identity);
    selected.set(identity, prior === undefined ? request : { target: request.target, mode: combinedMode(prior.mode, request.mode) });
  }
  return [...selected.values()].sort((left, right) => {
    const a = coordinates(left.target);
    const b = coordinates(right.target);
    return a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

function lockSql(mode: PostgresRowLock["mode"]): string {
  switch (mode) {
    case "key-share": return "FOR KEY SHARE";
    case "share": return "FOR SHARE";
    case "no-key-update": return "FOR NO KEY UPDATE";
    case "update": return "FOR UPDATE";
  }
}

export async function lockPostgresRows(queries: PostgresOperationQueries, requests: readonly PostgresRowLock[]): Promise<readonly PostgresLockTarget[]> {
  const absent: PostgresLockTarget[] = [];
  for (const request of orderedPostgresRowLocks(requests)) {
    const { target, mode } = request;
    const location = coordinates(target);
    const conditions = ["project_key = $1", ...location.columns.map((column, index) => `${column} = $${index + 2}`)];
    const privateScope = target.table === "plan_claims" || target.table === "plan_operations";
    const rows = await queries.execute<{ scope: string }>({ phase: "transaction", table: target.table, mode: "read",
      predicate: { kind: "primary-key", keys: [location.key] }, lockMode: mode }, {
      sql: `SELECT ${privateScope ? "scope" : "1"} FROM ${target.table} WHERE ${conditions.join(" AND ")} ${lockSql(mode)}`,
      parameters: [queries.projectKey, ...location.values],
    }, (row) => privateScope ? decodePostgresPlanScope(row.scope) : location.key);
    if (rows.length === 0) absent.push(target);
  }
  return absent;
}

export async function postgresRowsRemainAbsent(queries: PostgresOperationQueries, targets: readonly PostgresLockTarget[]): Promise<boolean> {
  for (const target of targets) {
    const location = coordinates(target);
    const conditions = ["project_key = $1", ...location.columns.map((column, index) => `${column} = $${index + 2}`)];
    const rows = await queries.execute<{ present: number }>({ phase: "transaction", table: target.table, mode: "read",
      predicate: { kind: "primary-key", keys: [location.key] }, lockMode: "none" }, {
      sql: `SELECT 1 AS present FROM ${target.table} WHERE ${conditions.join(" AND ")}`,
      parameters: [queries.projectKey, ...location.values],
    }, () => location.key);
    if (rows.length > 0) return false;
  }
  return true;
}
