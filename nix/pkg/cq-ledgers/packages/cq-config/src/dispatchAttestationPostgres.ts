/**
 * The PostgreSQL production {@link AttestationBackend} (T720, goal G94).
 *
 * Same single table as the bun:sqlite adapter — one row per
 * `{backend, project_key, attestation_id, generation}`, the output inside that
 * row's canonical-JSON `body` and nowhere else — and the same three durable
 * guards expressed as constraints: the primary key, a unique
 * `(backend, project_key, idempotency_key)`, and a unique
 * `(backend, project_key, capability_hash)` (Postgres treats `NULL` hashes as
 * distinct, so collapsed tombstones, which keep no hash, never collide).
 *
 * **Why a unit of work is not optional here.** {@link AttestationStore} is
 * synchronous; `Bun.sql` is not. An adapter that answered reads from a
 * materialized cache and wrote back later would let two processes decide the
 * same transition on the same revision. Instead each operation runs inside ONE
 * transaction that first takes `pg_advisory_xact_lock` for the namespace: the
 * lock is released only at commit or rollback, so the rows the operation loaded
 * cannot be superseded before its journal lands, and a peer's concurrent unit of
 * work on the same namespace WAITS rather than interleaving. The per-entry
 * digest compare-and-set in the `UPDATE`/`DELETE` predicates is belt-and-braces
 * on top.
 *
 * **Only a DRIVER failure is classified** (D177). `Bun.sql` surfaces connection
 * and SQL errors out of `pool.begin`, which is also where every decision the
 * SERVICE made inside the unit of work surfaces, so the two must be separated by
 * {@link isAttestationDomainError} rather than by position. An earlier revision
 * wrapped the whole transaction body unconditionally and rewrote a foreign
 * namespace, an unauthorized capability, a state conflict, a binding mismatch and
 * a missing record all into "postgres attestation store unreachable" — the exact
 * degradation this contract exists to prevent. The bun:sqlite and filesystem
 * adapters classify at individual query sites, where only driver errors can
 * appear, and never had the problem.
 *
 * Env-gating for tests follows the repo's existing Postgres suites (Q286):
 * `CQ_TEST_PG_URL` points at a throwaway database, and every Postgres case
 * SKIPS cleanly when it is unset.
 */

import { SQL } from "bun";
import {
  AttestationStorageError,
  AttestationTransportError,
  isAttestationDomainError,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
} from "./dispatchAttestation.js";
import {
  ATTESTATION_TABLE,
  assertAttestationStoreNamespace,
  formatAttestationNamespaceLockKey,
  persistAttestationRow,
  rehydrateAttestationRow,
  runAttestationUnitOfWork,
  type AttestationBackend,
  type AttestationJournalEntry,
  type AttestationLoadScope,
} from "./dispatchAttestationBackend.js";
import { AsyncMutex } from "./asyncMutex.js";

/** The only backends a PostgreSQL attestation store may be bound to. */
const POSTGRES_NAMESPACE_BACKENDS: ReadonlySet<string> = new Set(["postgres"]);

/** The advisory-lock key guarding the one-time DDL pass (Q271's discipline). */
const SCHEMA_LOCK_KEY = 0x63715f61_74746e00n;

interface StoredRow {
  readonly body: string;
  readonly row_digest: string;
}

/** A tagged-template query runner: the pool itself or a transaction handle. */
type PgRunner = SQL;

/** Open a `Bun.sql` pool over a `postgres://…` DSN. */
export function openAttestationPgPool(dsn: string): SQL {
  return new SQL(dsn);
}

/**
 * Apply the DDL under an advisory lock, so concurrently connecting instances
 * never race `CREATE TABLE`. Idempotent.
 */
export async function ensurePgAttestationSchema(pool: SQL): Promise<void> {
  try {
    await pool.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY}::bigint)`;
      await tx`
        CREATE TABLE IF NOT EXISTS ${tx(ATTESTATION_TABLE)} (
          backend         TEXT    NOT NULL,
          project_key     TEXT    NOT NULL,
          attestation_id  TEXT    NOT NULL,
          generation      INTEGER NOT NULL,
          kind            TEXT    NOT NULL,
          idempotency_key TEXT    NOT NULL,
          capability_hash TEXT,
          terminal_at     TEXT,
          reuse_after     TEXT,
          row_digest      TEXT    NOT NULL,
          body            TEXT    NOT NULL,
          PRIMARY KEY (backend, project_key, attestation_id, generation)
        )
      `;
      await tx`
        CREATE UNIQUE INDEX IF NOT EXISTS dispatch_attestations_idempotency
          ON ${tx(ATTESTATION_TABLE)} (backend, project_key, idempotency_key)
      `;
      await tx`
        CREATE UNIQUE INDEX IF NOT EXISTS dispatch_attestations_capability
          ON ${tx(ATTESTATION_TABLE)} (backend, project_key, capability_hash)
      `;
    });
  } catch (error) {
    throw asPgBackendError(error);
  }
}

export interface PostgresAttestationBackendOptions {
  readonly namespace: AttestationNamespace;
  readonly pool: SQL;
  /** Close `pool` on {@link PostgresAttestationBackend.close}. Default false. */
  readonly ownsPool?: boolean;
}

/**
 * The PostgreSQL attestation backend. Bound to ONE namespace; every other
 * tenant's rows share the table but are unreachable through this handle.
 */
export class PostgresAttestationBackend implements AttestationBackend {
  readonly namespace: AttestationNamespace;

  private readonly pool: SQL;
  private readonly ownsPool: boolean;
  private readonly lockKey: bigint;
  private readonly mutex = new AsyncMutex();
  private closed = false;

  private constructor(options: PostgresAttestationBackendOptions) {
    this.namespace = assertPgNamespace(options.namespace);
    this.pool = options.pool;
    this.ownsPool = options.ownsPool ?? false;
    this.lockKey = formatAttestationNamespaceLockKey(this.namespace);
  }

  /** Open over an existing pool, applying the DDL. */
  static async open(
    options: PostgresAttestationBackendOptions,
  ): Promise<PostgresAttestationBackend> {
    const backend = new PostgresAttestationBackend(options);
    await ensurePgAttestationSchema(options.pool);
    return backend;
  }

  /** Open over a DSN, owning the pool it creates. */
  static async openDsn(
    namespace: AttestationNamespace,
    dsn: string,
  ): Promise<PostgresAttestationBackend> {
    const pool = openAttestationPgPool(dsn);
    try {
      return await PostgresAttestationBackend.open({ namespace, pool, ownsPool: true });
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw error;
    }
  }

  /** The rows of THIS namespace, for a caller inspecting durable state. */
  async storedRows(): Promise<readonly AttestationRow[]> {
    return this.load(this.pool, { kind: "namespace" });
  }

  /** Every attestation table in the connected schema. Proves there is no parallel store. */
  async storageArtifacts(): Promise<readonly string[]> {
    const rows = await this.pool<{ readonly table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'dispatch_attestation%'
       ORDER BY table_name
    `;
    return Object.freeze(rows.map((row) => row.table_name));
  }

  /** Every persisted byte of THIS namespace. */
  async rawStorageDump(): Promise<string> {
    const rows = await this.pool<Record<string, unknown>[]>`
      SELECT * FROM ${this.pool(ATTESTATION_TABLE)}
       WHERE backend = ${this.namespace.backend} AND project_key = ${this.namespace.projectKey}
       ORDER BY attestation_id, generation
    `;
    return JSON.stringify(rows);
  }

  transact<T>(
    scope: AttestationLoadScope,
    body: (store: AttestationStore) => T | Promise<T>,
  ): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new AttestationTransportError(
          `attestation store for ${this.namespace.projectKey} is closed`,
        );
      }
      try {
        return (await this.pool.begin(async (tx) => {
          // Held until COMMIT/ROLLBACK: the loaded snapshot stays valid for the
          // whole unit of work, and a peer's unit of work on this namespace
          // waits instead of interleaving.
          await tx`SELECT pg_advisory_xact_lock(${this.lockKey}::bigint)`;
          return runAttestationUnitOfWork(
            this.namespace,
            scope,
            {
              load: (loadScope) => this.load(tx, loadScope),
              apply: (journal) => this.apply(tx, journal),
            },
            body,
          );
        })) as T;
      } catch (error) {
        // D177: classify ONLY a genuine driver failure. Every decision the
        // SERVICE made inside the unit of work passes through untouched — a
        // foreign namespace stays an AttestationNamespaceError, an unauthorized
        // capability stays a DispatchAuthorizationError, and so on. Wrapping the
        // whole transaction body unconditionally (as this adapter first did)
        // rewrote all of them as "postgres attestation store unreachable",
        // inverting the contract's promise that an authorization or lifecycle
        // failure is never degraded into unreachability.
        throw isAttestationDomainError(error) ? error : asPgBackendError(error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsPool) {
      await this.pool.close();
    }
  }

  private async load(
    runner: PgRunner,
    scope: AttestationLoadScope,
  ): Promise<readonly AttestationRow[]> {
    const { backend, projectKey } = this.namespace;
    const rows = await ((): Promise<StoredRow[]> => {
      switch (scope.kind) {
        case "none":
          return Promise.resolve([]);
        case "namespace":
          return runner<StoredRow[]>`
            SELECT body, row_digest FROM ${runner(ATTESTATION_TABLE)}
             WHERE backend = ${backend} AND project_key = ${projectKey}
             ORDER BY attestation_id, generation
          `;
        case "handle":
          return runner<StoredRow[]>`
            SELECT body, row_digest FROM ${runner(ATTESTATION_TABLE)}
             WHERE backend = ${backend} AND project_key = ${projectKey}
               AND attestation_id = ${scope.handle.attestationId}
               AND generation = ${scope.handle.generation}
             FOR UPDATE
          `;
        case "capability":
          return runner<StoredRow[]>`
            SELECT body, row_digest FROM ${runner(ATTESTATION_TABLE)}
             WHERE backend = ${backend} AND project_key = ${projectKey}
               AND capability_hash = ${scope.capabilityHash}
             FOR UPDATE
          `;
        case "prepare": {
          const reprepare = scope.reprepareOf;
          if (reprepare === undefined) {
            return runner<StoredRow[]>`
              SELECT body, row_digest FROM ${runner(ATTESTATION_TABLE)}
               WHERE backend = ${backend} AND project_key = ${projectKey}
                 AND idempotency_key = ${scope.idempotencyKey}
               FOR UPDATE
            `;
          }
          return runner<StoredRow[]>`
            SELECT body, row_digest FROM ${runner(ATTESTATION_TABLE)}
             WHERE backend = ${backend} AND project_key = ${projectKey}
               AND (idempotency_key = ${scope.idempotencyKey}
                    OR (attestation_id = ${reprepare.attestationId}
                        AND generation = ${reprepare.generation}))
             FOR UPDATE
          `;
        }
      }
    })();
    return Object.freeze(
      rows.map((stored) => rehydrateAttestationRow(this.namespace, stored.body, stored.row_digest)),
    );
  }

  private async apply(
    runner: PgRunner,
    journal: readonly AttestationJournalEntry[],
  ): Promise<void> {
    const { backend, projectKey } = this.namespace;
    for (const entry of journal) {
      switch (entry.kind) {
        case "insert": {
          const row = persistAttestationRow(entry.row);
          const affected = await runner`
            INSERT INTO ${runner(ATTESTATION_TABLE)}
              (backend, project_key, attestation_id, generation, kind, idempotency_key,
               capability_hash, terminal_at, reuse_after, row_digest, body)
            VALUES (${row.backend}, ${row.projectKey}, ${row.attestationId}, ${row.generation},
                    ${row.kind}, ${row.idempotencyKey}, ${row.capabilityHash}, ${row.terminalAt},
                    ${row.reuseAfter}, ${row.rowDigest}, ${row.body})
          `;
          assertOneRow(
            affected,
            `insert of attestation "${row.attestationId}" generation ${row.generation}`,
          );
          break;
        }
        case "replace": {
          const row = persistAttestationRow(entry.row);
          const affected = await runner`
            UPDATE ${runner(ATTESTATION_TABLE)}
               SET kind = ${row.kind}, idempotency_key = ${row.idempotencyKey},
                   capability_hash = ${row.capabilityHash}, terminal_at = ${row.terminalAt},
                   reuse_after = ${row.reuseAfter}, row_digest = ${row.rowDigest},
                   body = ${row.body}
             WHERE backend = ${backend} AND project_key = ${projectKey}
               AND attestation_id = ${entry.handle.attestationId}
               AND generation = ${entry.handle.generation}
               AND row_digest = ${entry.expectedDigest}
          `;
          assertOneRow(
            affected,
            `lost update on attestation "${entry.handle.attestationId}" generation ${entry.handle.generation}`,
          );
          break;
        }
        case "remove": {
          const affected = await runner`
            DELETE FROM ${runner(ATTESTATION_TABLE)}
             WHERE backend = ${backend} AND project_key = ${projectKey}
               AND attestation_id = ${entry.handle.attestationId}
               AND generation = ${entry.handle.generation}
               AND row_digest = ${entry.expectedDigest}
          `;
          assertOneRow(
            affected,
            `lost update removing attestation "${entry.handle.attestationId}" generation ${entry.handle.generation}`,
          );
          break;
        }
      }
    }
  }
}

function assertPgNamespace(namespace: AttestationNamespace): AttestationNamespace {
  const resolved = assertAttestationStoreNamespace(namespace);
  if (!POSTGRES_NAMESPACE_BACKENDS.has(resolved.backend)) {
    throw new AttestationStorageError(
      `a PostgreSQL attestation store serves the "postgres" backend, not "${resolved.backend}"`,
    );
  }
  return resolved;
}

/**
 * `Bun.sql` reports a write's row count on the result's `count`. Anything other
 * than the one expected row is a refused write — a key conflict, a lost update
 * or a vanished row — never a lifecycle state.
 */
function assertOneRow(result: unknown, detail: string): void {
  const count = (result as { readonly count?: unknown } | null)?.count;
  const affected = typeof count === "number" ? count : Number.NaN;
  if (affected !== 1) {
    throw new AttestationStorageError(`${detail}: ${String(count)} rows affected`);
  }
}

/**
 * SQLSTATE class 23 is an integrity-constraint violation: the store REFUSED the
 * write ({@link AttestationStorageError}). Everything else — a refused
 * connection, a failed authentication, a closed pool — is unreachability
 * ({@link AttestationTransportError}). Neither is ever degraded into a
 * lifecycle state.
 */
export function asPgBackendError(error: unknown): Error {
  if (error instanceof AttestationStorageError || error instanceof AttestationTransportError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const sqlState = pgSqlState(error);
  if (sqlState !== undefined && sqlState.startsWith("23")) {
    return new AttestationStorageError(
      `postgres attestation store refused a write (${sqlState}): ${message}`,
    );
  }
  return new AttestationTransportError(`postgres attestation store unreachable: ${message}`);
}

/**
 * Extract a five-character SQLSTATE from a `Bun.sql` error. Bun surfaces the
 * server's code on `errno` (as the SQLSTATE string) and a `ERR_POSTGRES_*`
 * discriminator on `code`, so both are inspected — and a plain property read is
 * avoided in favour of {@link Object.hasOwn}, since an error crossing this
 * boundary is not necessarily one of ours.
 */
function pgSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  for (const field of ["errno", "code"] as const) {
    if (!Object.hasOwn(error, field)) {
      continue;
    }
    const value = (error as Readonly<Record<string, unknown>>)[field];
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) {
      return value;
    }
  }
  return undefined;
}
