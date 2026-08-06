/**
 * planLifecycleDump — first-class plan-lifecycle payload inside a BackupDump
 * (D139). Serializes the private claim/operation verifier state into the same
 * `plan-lifecycle.json` shape the fs/git persistence seams already write, so a
 * dump is backend-agnostic: buildBackupDump emits one file; restore rewrites
 * either that file (fs) or the plan_claims/plan_operations rows (sqlite/xdg/
 * postgres) from the same bytes.
 */

import {
  PlanOperationReplayRecordSchema,
  PlanPrivateClaimRecordSchema,
  type PlanPrivateClaimRecord,
} from "../planLifecycle.js";
import { LedgerError } from "../types.js";
import { PLAN_LIFECYCLE_STATE_FILENAME } from "./ledgerArtifacts.js";
import type { InMemoryPlanOperationRecord } from "./inMemoryPlanLifecycle.js";

export { PLAN_LIFECYCLE_STATE_FILENAME as PLAN_LIFECYCLE_DUMP_PATH };

export interface PlanLifecycleDumpState {
  readonly claims: ReadonlyMap<string, PlanPrivateClaimRecord>;
  readonly operations: ReadonlyMap<string, InMemoryPlanOperationRecord>;
}

export function claimScopeKey(goalId: string, claimRequestId: string): string {
  return `${goalId}\u0000${claimRequestId}`;
}

export function operationScopeKey(
  goalId: string,
  claimId: string,
  generation: number,
  operation: string,
  operationId: string,
): string {
  return [goalId, claimId, generation, operation, operationId].join("\u0000");
}

/**
 * Serialize claim/operation maps into the durable `plan-lifecycle.json` body.
 * Values only — scopes are reconstructed on parse from the record fields so the
 * dump never carries a backend-specific key encoding (postgres escapes NULs).
 */
export function serializePlanLifecycleDump(state: PlanLifecycleDumpState): string {
  return JSON.stringify({
    version: 1,
    claims: [...state.claims.values()],
    operations: [...state.operations.values()],
  });
}

/**
 * Parse a `plan-lifecycle.json` body back into scoped maps. Rejects truncated
 * or hand-edited payloads the same way AbstractLedgerStore.loadPlanLifecycleState
 * does, so a dump cannot smuggle a different failure mode through restore.
 */
export function parsePlanLifecycleDump(text: string): PlanLifecycleDumpState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError("invalid persisted plan lifecycle state");
  }
  if (typeof value !== "object" || value === null) {
    throw new LedgerError("invalid persisted plan lifecycle state");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["claims"]) || !Array.isArray(record["operations"])) {
    throw new LedgerError("invalid persisted plan lifecycle state");
  }

  const claims = new Map<string, PlanPrivateClaimRecord>();
  for (const raw of record["claims"]) {
    const entry = PlanPrivateClaimRecordSchema.parse(raw);
    claims.set(claimScopeKey(entry.goalId, entry.claimRequestId), entry);
  }

  const operations = new Map<string, InMemoryPlanOperationRecord>();
  for (const raw of record["operations"]) {
    if (typeof raw !== "object" || raw === null) {
      throw new LedgerError("invalid persisted plan lifecycle operation");
    }
    const operation = raw as Record<string, unknown>;
    const replay = PlanOperationReplayRecordSchema.parse(operation["replay"]);
    operations.set(
      operationScopeKey(
        replay.goalId,
        replay.claimId,
        replay.generation,
        replay.operation,
        replay.operationId,
      ),
      { replay, acknowledgement: operation["acknowledgement"] },
    );
  }

  return { claims, operations };
}

/** True when the dump carries at least one claim or operation record. */
export function planLifecycleDumpNonEmpty(state: PlanLifecycleDumpState): boolean {
  return state.claims.size > 0 || state.operations.size > 0;
}

/**
 * Postgres cannot store U+0000 in TEXT. Escape the shared scope separator (and
 * backslash) so plan_claims/plan_operations primary keys stay legal. Inverse
 * of {@link decodePostgresPlanScope}.
 */
export function encodePostgresPlanScope(scope: string): string {
  return scope.replaceAll("\\", "\\\\").replaceAll("\u0000", "\\0");
}

/** Inverse of {@link encodePostgresPlanScope}. */
export function decodePostgresPlanScope(stored: string): string {
  return stored.replace(/\\(\\|0)/g, (_match, escaped: string) =>
    escaped === "0" ? "\u0000" : "\\",
  );
}
