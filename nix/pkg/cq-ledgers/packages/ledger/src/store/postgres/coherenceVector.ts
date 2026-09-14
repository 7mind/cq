import { LedgerError } from "../../types.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import { encodePostgresPlanScope, decodePostgresPlanScope } from "../planLifecycleDump.js";

export type PostgresCoherenceScope = "active" | "archived" | "registry" | "control";

export interface PostgresCoherenceChange {
  readonly ledger: string;
  readonly documentId: string;
  readonly scope: PostgresCoherenceScope;
  readonly kind: "upsert" | "delete";
}

export interface PostgresCoherenceEntry extends PostgresCoherenceChange {
  readonly version: number;
  readonly origin: string;
}

function checkedVersion(value: number | bigint | string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new LedgerError("PostgreSQL coherence version exceeds the supported integer domain");
  return version;
}

/** The keyed operation owns the transaction; empty deltas perform no SQL. */
export async function recordPostgresCoherence(queries: PostgresOperationQueries, origin: string,
  changes: readonly PostgresCoherenceChange[]): Promise<number | null> {
  if (changes.length === 0) return null;
  if (origin.length === 0) throw new LedgerError("PostgreSQL coherence origin must be nonempty");
  const unique = new Map(changes.map((change) => [JSON.stringify([change.ledger, change.documentId, change.scope]), change]));
  const versions = await queries.execute<{ version: bigint }>({ table: "coherence_state", phase: "transaction", mode: "write",
    predicate: { kind: "primary-key", keys: ["coherence-version"] }, lockMode: "update" }, {
    sql: `INSERT INTO coherence_state (project_key, version) VALUES ($1, 1)
      ON CONFLICT (project_key) DO UPDATE SET version = coherence_state.version + 1 RETURNING version`, parameters: [queries.projectKey],
  }, () => "coherence-version");
  if (versions.length !== 1) throw new LedgerError("PostgreSQL coherence version write did not return exactly one row");
  const version = checkedVersion(versions[0]!.version);
  for (const [key, change] of unique) {
    await queries.execute<{ document_id: string }>({ table: "coherence_vector", phase: "transaction", mode: "write",
      predicate: { kind: "primary-key", keys: [key] }, lockMode: "update" }, {
      sql: `INSERT INTO coherence_vector (project_key, ledger, document_id, scope, kind, version, origin) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (project_key, ledger, document_id, scope) DO UPDATE SET kind = EXCLUDED.kind, version = EXCLUDED.version, origin = EXCLUDED.origin
        RETURNING document_id`, parameters: [queries.projectKey, change.ledger, encodePostgresPlanScope(change.documentId), change.scope, change.kind, version, origin],
    }, () => key);
  }
  return version;
}

export async function postgresCoherenceVersion(queries: PostgresOperationQueries): Promise<number> {
  const rows = await queries.execute<{ version: bigint }>({ table: "coherence_state", phase: "projection", mode: "read",
    predicate: { kind: "primary-key", keys: ["coherence-version"] }, lockMode: "none" }, {
    sql: "SELECT version FROM coherence_state WHERE project_key = $1", parameters: [queries.projectKey],
  }, () => "coherence-version");
  return rows[0] === undefined ? 0 : checkedVersion(rows[0].version);
}

export async function readPostgresCoherence(queries: PostgresOperationQueries, afterVersion: number, throughVersion: number): Promise<PostgresCoherenceEntry[]> {
  const rows = await queries.execute<{ ledger: string; document_id: string; scope: PostgresCoherenceScope;
    kind: PostgresCoherenceChange["kind"]; version: bigint; origin: string }>({ table: "coherence_vector", phase: "projection", mode: "read",
    predicate: { kind: "keys", keys: [`versions:${afterVersion + 1}-${throughVersion}`] }, lockMode: "none" }, {
    sql: `SELECT ledger, document_id, scope, kind, version, origin FROM coherence_vector
      WHERE project_key = $1 AND version > $2 AND version <= $3 ORDER BY version, ledger, document_id, scope`,
    parameters: [queries.projectKey, afterVersion, throughVersion],
  }, ({ ledger, document_id, scope }) => JSON.stringify([ledger, document_id, scope]));
  return rows.map(({ document_id, version, ...row }) => ({ ...row, documentId: decodePostgresPlanScope(document_id), version: checkedVersion(version) }));
}
