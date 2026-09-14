import type { Database } from "bun:sqlite";
import { GOALS_LEDGER } from "../../constants.js";
import { LedgerError } from "../../types.js";
import type { LifecyclePrivateRecordChanges } from "../lifecycleRowRepository.js";
import { claimScopeKey, operationScopeKey } from "../planLifecycleDump.js";
import { coherenceVersion } from "./connection.js";

export type SqliteCoherenceScope = "active" | "archived" | "registry" | "control";

export interface SqliteCoherenceChange {
  readonly ledger: string;
  readonly documentId: string;
  readonly scope: SqliteCoherenceScope;
  readonly kind: "upsert" | "delete" | "refresh";
}

export interface SqliteCoherenceEntry extends SqliteCoherenceChange {
  readonly version: number;
  readonly origin: string;
}

const CLAIM_CONTROL_PREFIX = "plan_claims:";
const OPERATION_CONTROL_PREFIX = "plan_operations:";

export function planControlChanges(changes: LifecyclePrivateRecordChanges): SqliteCoherenceChange[] {
  return [
    ...changes.claims.map((claim): SqliteCoherenceChange => ({
      ledger: GOALS_LEDGER, scope: "control", kind: "upsert",
      documentId: CLAIM_CONTROL_PREFIX + claimScopeKey(claim.goalId, claim.claimRequestId),
    })),
    ...changes.operations.map(({ replay }): SqliteCoherenceChange => ({
      ledger: GOALS_LEDGER, scope: "control", kind: "upsert",
      documentId: OPERATION_CONTROL_PREFIX + operationScopeKey(replay.goalId, replay.claimId, replay.generation, replay.operation, replay.operationId),
    })),
  ];
}

export function isPlanControlChange(change: SqliteCoherenceChange): boolean {
  return change.ledger === GOALS_LEDGER && change.scope === "control" && change.kind === "upsert" &&
    (change.documentId.startsWith(CLAIM_CONTROL_PREFIX) || change.documentId.startsWith(OPERATION_CONTROL_PREFIX));
}

export function changedCoherenceLedgers(changes: readonly SqliteCoherenceChange[]): string[] {
  return [...new Set(changes.map(({ ledger }) => ledger))];
}

/** Called once inside the domain transaction, after its authoritative row writes. */
export function recordSqliteCoherence(
  db: Database,
  origin: string,
  changes: readonly SqliteCoherenceChange[],
): number {
  if (!db.inTransaction)
    throw new LedgerError("Coherence entries must commit with their domain transaction");
  if (changes.length === 0) return coherenceVersion(db);
  if (origin.length === 0) throw new LedgerError("Coherence origin must be nonempty");
  const versionRow = db
    .query("UPDATE coherence_state SET version = version + 1 WHERE id = 1 RETURNING version")
    .get() as { version: number } | null;
  if (versionRow === null) throw new LedgerError("SQLite coherence_state singleton row is missing");
  const insert =
    db.query(`INSERT INTO coherence_vector (ledger, document_id, scope, change_kind, version, origin)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ledger, document_id, scope) DO UPDATE SET
    change_kind = excluded.change_kind, version = excluded.version, origin = excluded.origin`);
  for (const change of changes) {
    insert.run(
      change.ledger,
      change.documentId,
      change.scope,
      change.kind,
      versionRow.version,
      origin,
    );
  }
  return versionRow.version;
}

export function readSqliteCoherence(
  db: Database,
  afterVersion: number,
  throughVersion: number,
): SqliteCoherenceEntry[] {
  const rows = db
    .query(
      `SELECT ledger, document_id, scope, change_kind, version, origin
    FROM coherence_vector WHERE version > ? AND version <= ? ORDER BY version, ledger, document_id, scope`,
    )
    .all(afterVersion, throughVersion) as Array<{
    ledger: string;
    document_id: string;
    scope: SqliteCoherenceScope;
    change_kind: SqliteCoherenceChange["kind"];
    version: number;
    origin: string;
  }>;
  return rows.map((row) => ({
    ledger: row.ledger,
    documentId: row.document_id,
    scope: row.scope,
    kind: row.change_kind,
    version: row.version,
    origin: row.origin,
  }));
}

export function ledgerControlChanges(ledgerIds: readonly string[]): SqliteCoherenceChange[] {
  return [...new Set(ledgerIds)].map((ledger) => ({
    ledger,
    documentId: "",
    scope: "control",
    kind: "refresh",
  }));
}

export function captureSqliteCoherenceSnapshot<T>(
  db: Database,
  readDocuments: () => T,
): { readonly version: number; readonly documents: T } {
  return db.transaction(() => ({ version: coherenceVersion(db), documents: readDocuments() }))();
}
