/**
 * The bun:sqlite production {@link AttestationBackend} — and with it the `xdg`
 * out-of-tree primary (T720, goal G94).
 *
 * One table, {@link ATTESTATION_TABLE}, holds every namespace's rows keyed by
 * `(backend, project_key, attestation_id, generation)`. The output lives in that
 * row's canonical-JSON `body` and NOWHERE else: there is no parallel output
 * store, no blob side-table and no file, so a stored result can never drift from
 * the attestation that authorized it.
 *
 * Three durable invariants are enforced by the SCHEMA, not by the service, so a
 * defect in the service (or a future second writer that bypasses it) still
 * cannot corrupt the store:
 *
 *  - the primary key refuses a duplicate `{attestationId,generation}` in a
 *    namespace;
 *  - a unique index on `(backend, project_key, idempotency_key)` refuses a
 *    second row holding a live key — the durable half of the idempotency
 *    horizon;
 *  - a unique index on `(backend, project_key, capability_hash)` refuses two
 *    live rows resolvable by ONE capability. (`NULL` hashes are distinct in
 *    SQLite, so collapsed tombstones — which keep no hash at all — never
 *    collide.)
 *
 * Cross-process safety is `BEGIN IMMEDIATE` on a WAL connection with a
 * `busy_timeout`: the write lock is taken BEFORE the unit of work's read
 * snapshot, so a peer process cannot commit between the load and the apply
 * (K102's discipline, and the reason `DEFERRED` would be wrong here — it would
 * return `SQLITE_BUSY_SNAPSHOT` on upgrade instead of waiting). An in-process
 * mutex serializes units of work on ONE connection, since a single connection
 * cannot hold two overlapping transactions.
 */

import { Database, SQLiteError } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AttestationStorageError,
  AttestationTransportError,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
} from "./dispatchAttestation.js";
import {
  ATTESTATION_TABLE,
  assertAttestationStoreNamespace,
  persistAttestationRow,
  rehydrateAttestationRow,
  runAttestationUnitOfWork,
  type AttestationBackend,
  type AttestationJournalEntry,
  type AttestationLoadScope,
} from "./dispatchAttestationBackend.js";
import { AsyncMutex } from "./asyncMutex.js";

/** Cross-process write-lock timeout: a writer waits this long on SQLITE_BUSY. */
export const ATTESTATION_BUSY_TIMEOUT_MS = 5_000;

/** The db file name under a project's XDG state directory. */
export const ATTESTATION_DB_FILENAME = "dispatch-attestations.db";

/** The only backends a bun:sqlite attestation store may be bound to. */
const SQLITE_NAMESPACE_BACKENDS: ReadonlySet<string> = new Set(["xdg"]);

interface StoredRow {
  readonly body: string;
  readonly row_digest: string;
}

/**
 * Apply the DDL. Idempotent, so every open may call it.
 *
 * `body` is the row; the indexes are the durable guards described on the module.
 */
export function ensureAttestationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ATTESTATION_TABLE} (
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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ${ATTESTATION_TABLE}_idempotency
      ON ${ATTESTATION_TABLE} (backend, project_key, idempotency_key);

    CREATE UNIQUE INDEX IF NOT EXISTS ${ATTESTATION_TABLE}_capability
      ON ${ATTESTATION_TABLE} (backend, project_key, capability_hash);
  `);
}

export interface SqliteAttestationBackendOptions {
  readonly namespace: AttestationNamespace;
  /** A concrete db file path. XDG resolution is {@link xdgAttestationDbPath}'s. */
  readonly dbPath: string;
}

/**
 * The bun:sqlite attestation backend. Bound to ONE namespace; rows of another
 * namespace in the same file are invisible to it and unreachable through it.
 */
export class SqliteAttestationBackend implements AttestationBackend {
  readonly namespace: AttestationNamespace;
  readonly dbPath: string;

  private readonly db: Database;
  private readonly mutex = new AsyncMutex();
  private closed = false;

  constructor(options: SqliteAttestationBackendOptions) {
    this.namespace = assertSqliteNamespace(options.namespace);
    this.dbPath = options.dbPath;
    this.db = openAttestationDb(options.dbPath);
    try {
      ensureAttestationSchema(this.db);
    } catch (error) {
      this.db.close();
      throw asSqliteBackendError(error);
    }
  }

  /** The rows of THIS namespace, for a caller inspecting durable state. */
  storedRows(): readonly AttestationRow[] {
    return this.loadScoped({ kind: "namespace" });
  }

  /** Every table this backend owns. Proves there is no parallel output store. */
  storageArtifacts(): readonly string[] {
    const rows = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as readonly { readonly name: string }[];
    return Object.freeze(rows.map((row) => row.name));
  }

  /** Every persisted byte, for a caller asserting what the store does NOT hold. */
  rawStorageDump(): string {
    const rows = this.db
      .query(
        `SELECT * FROM ${ATTESTATION_TABLE} WHERE backend = ? AND project_key = ? ORDER BY attestation_id, generation`,
      )
      .all(this.namespace.backend, this.namespace.projectKey);
    return JSON.stringify(rows);
  }

  transact<T>(scope: AttestationLoadScope, body: (store: AttestationStore) => T): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new AttestationTransportError(`attestation store "${this.dbPath}" is closed`);
      }
      // IMMEDIATE: the write lock is taken before the read snapshot, so the
      // rows this unit of work loads cannot be superseded before it commits.
      this.exec("BEGIN IMMEDIATE");
      try {
        const result = await runAttestationUnitOfWork(
          this.namespace,
          scope,
          {
            load: (loadScope) => this.loadScoped(loadScope),
            apply: (journal) => {
              this.applyJournal(journal);
            },
          },
          body,
        );
        this.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // BEGIN itself failed — there is no transaction to roll back.
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return Promise.resolve();
  }

  private loadScoped(scope: AttestationLoadScope): readonly AttestationRow[] {
    const { backend, projectKey } = this.namespace;
    const where = `backend = ? AND project_key = ?`;
    const rows = ((): readonly StoredRow[] => {
      switch (scope.kind) {
        case "none":
          return [];
        case "namespace":
          return this.query(
            `SELECT body, row_digest FROM ${ATTESTATION_TABLE} WHERE ${where} ORDER BY attestation_id, generation`,
            [backend, projectKey],
          );
        case "handle":
          return this.query(
            `SELECT body, row_digest FROM ${ATTESTATION_TABLE} WHERE ${where} AND attestation_id = ? AND generation = ?`,
            [backend, projectKey, scope.handle.attestationId, scope.handle.generation],
          );
        case "capability":
          return this.query(
            `SELECT body, row_digest FROM ${ATTESTATION_TABLE} WHERE ${where} AND capability_hash = ?`,
            [backend, projectKey, scope.capabilityHash],
          );
        case "prepare": {
          if (scope.reprepareOf === undefined) {
            return this.query(
              `SELECT body, row_digest FROM ${ATTESTATION_TABLE} WHERE ${where} AND idempotency_key = ?`,
              [backend, projectKey, scope.idempotencyKey],
            );
          }
          return this.query(
            `SELECT body, row_digest FROM ${ATTESTATION_TABLE} WHERE ${where} AND (idempotency_key = ? OR (attestation_id = ? AND generation = ?))`,
            [
              backend,
              projectKey,
              scope.idempotencyKey,
              scope.reprepareOf.attestationId,
              scope.reprepareOf.generation,
            ],
          );
        }
      }
    })();
    return Object.freeze(
      rows.map((stored) => rehydrateAttestationRow(this.namespace, stored.body, stored.row_digest)),
    );
  }

  private applyJournal(journal: readonly AttestationJournalEntry[]): void {
    for (const entry of journal) {
      switch (entry.kind) {
        case "insert": {
          const persisted = persistAttestationRow(entry.row);
          this.write(
            `INSERT INTO ${ATTESTATION_TABLE}
               (backend, project_key, attestation_id, generation, kind, idempotency_key,
                capability_hash, terminal_at, reuse_after, row_digest, body)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              persisted.backend,
              persisted.projectKey,
              persisted.attestationId,
              persisted.generation,
              persisted.kind,
              persisted.idempotencyKey,
              persisted.capabilityHash,
              persisted.terminalAt,
              persisted.reuseAfter,
              persisted.rowDigest,
              persisted.body,
            ],
            1,
            `insert of attestation "${persisted.attestationId}" generation ${persisted.generation}`,
          );
          break;
        }
        case "replace": {
          const persisted = persistAttestationRow(entry.row);
          // The compare-and-set: the UPDATE only lands on the revision the
          // service observed. A peer that advanced the row leaves 0 rows
          // affected, which is a lost update, not a silent clobber.
          //
          // UNREACHABLE while `BEGIN IMMEDIATE` holds (mutations M30 and M31 both
          // survive): the write lock is taken before the load, so no peer can
          // change the row between the load and this UPDATE, and a body that
          // disagreed with its `row_digest` column would already have been
          // refused at load. It is retained as defence for a DIFFERENT failure —
          // a regression in how the lock is taken — which mutation M32 (BEGIN
          // DEFERRED) shows the cross-process suite does detect. The same
          // invariant IS reached and asserted on the filesystem adapter, whose
          // lock a plain write can bypass.
          this.write(
            `UPDATE ${ATTESTATION_TABLE}
                SET kind = ?, idempotency_key = ?, capability_hash = ?, terminal_at = ?,
                    reuse_after = ?, row_digest = ?, body = ?
              WHERE backend = ? AND project_key = ? AND attestation_id = ? AND generation = ?
                AND row_digest = ?`,
            [
              persisted.kind,
              persisted.idempotencyKey,
              persisted.capabilityHash,
              persisted.terminalAt,
              persisted.reuseAfter,
              persisted.rowDigest,
              persisted.body,
              this.namespace.backend,
              this.namespace.projectKey,
              entry.handle.attestationId,
              entry.handle.generation,
              entry.expectedDigest,
            ],
            1,
            `lost update on attestation "${entry.handle.attestationId}" generation ${entry.handle.generation}`,
          );
          break;
        }
        case "remove": {
          this.write(
            `DELETE FROM ${ATTESTATION_TABLE}
              WHERE backend = ? AND project_key = ? AND attestation_id = ? AND generation = ?
                AND row_digest = ?`,
            [
              this.namespace.backend,
              this.namespace.projectKey,
              entry.handle.attestationId,
              entry.handle.generation,
              entry.expectedDigest,
            ],
            1,
            `lost update removing attestation "${entry.handle.attestationId}" generation ${entry.handle.generation}`,
          );
          break;
        }
      }
    }
  }

  private query(sql: string, params: readonly (string | number)[]): readonly StoredRow[] {
    try {
      return this.db.query(sql).all(...(params as (string | number)[])) as readonly StoredRow[];
    } catch (error) {
      throw asSqliteBackendError(error);
    }
  }

  private write(
    sql: string,
    params: readonly (string | number | null)[],
    expectedChanges: number,
    detail: string,
  ): void {
    let changes: number;
    try {
      changes = this.db.query(sql).run(...(params as (string | number | null)[])).changes;
    } catch (error) {
      throw asSqliteBackendError(error);
    }
    if (changes !== expectedChanges) {
      throw new AttestationStorageError(`${detail}: ${changes} rows affected`);
    }
  }

  private exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (error) {
      throw asSqliteBackendError(error);
    }
  }
}

function assertSqliteNamespace(namespace: AttestationNamespace): AttestationNamespace {
  const resolved = assertAttestationStoreNamespace(namespace);
  if (!SQLITE_NAMESPACE_BACKENDS.has(resolved.backend)) {
    throw new AttestationStorageError(
      `a bun:sqlite attestation store serves the "xdg" backend, not "${resolved.backend}"`,
    );
  }
  return resolved;
}

function openAttestationDb(dbPath: string): Database {
  let db: Database;
  try {
    db = new Database(dbPath, { create: true });
  } catch (error) {
    throw asSqliteBackendError(error);
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${ATTESTATION_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA synchronous = NORMAL");
  } catch (error) {
    db.close();
    throw asSqliteBackendError(error);
  }
  return db;
}

/**
 * Codes that mean "the store could not be reached / could not be written at
 * all" as opposed to "the store refused this write". A constraint violation is
 * a REFUSAL ({@link AttestationStorageError}); an unopenable or read-only file
 * is unreachability ({@link AttestationTransportError}). Neither is ever
 * degraded into a lifecycle state.
 */
const SQLITE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_READONLY",
  "SQLITE_NOTADB",
  "SQLITE_PERM",
  "SQLITE_AUTH",
  "SQLITE_FULL",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CORRUPT",
]);

/**
 * Classify a bun:sqlite failure. Exported so the adapter suite can assert the
 * classification rather than infer it from a message.
 */
export function asSqliteBackendError(error: unknown): Error {
  if (error instanceof AttestationStorageError || error instanceof AttestationTransportError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SQLiteError) {
    const code = error.code;
    // The extended codes are `<PRIMARY>_<DETAIL>` (e.g. SQLITE_BUSY_SNAPSHOT),
    // so a primary-code prefix is matched too rather than enumerated.
    const primary = typeof code === "string" ? code.split("_").slice(0, 2).join("_") : "";
    if (
      (typeof code === "string" && SQLITE_TRANSPORT_CODES.has(code)) ||
      SQLITE_TRANSPORT_CODES.has(primary)
    ) {
      return new AttestationTransportError(`sqlite attestation store unreachable: ${message}`);
    }
    return new AttestationStorageError(`sqlite attestation store refused a write: ${message}`);
  }
  return new AttestationTransportError(`sqlite attestation store unreachable: ${message}`);
}

// ---------------------------------------------------------------------------
// The xdg location
// ---------------------------------------------------------------------------

/**
 * Resolve the XDG state base the same way the ledger's primary store does:
 * `$XDG_STATE_HOME` when it is set to an absolute path, else `~/.local/state`.
 * The environment is an explicit input so a test never resolves the real one.
 */
export function xdgAttestationStateBase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const stateHome = env["XDG_STATE_HOME"];
  return stateHome !== undefined && stateHome.trim() !== "" && isAbsolute(stateHome)
    ? stateHome
    : join(homedir(), ".local", "state");
}

/**
 * The attestation db path for one project under the XDG layout:
 * `<state base>/cq/projects/<projectKey>/state/dispatch-attestations.db` — the
 * same `state/` area the primary ledger db lives in, so one project's durable
 * state stays in one place.
 */
export function xdgAttestationDbPath(
  projectKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(
    xdgAttestationStateBase(env),
    "cq",
    "projects",
    projectKey,
    "state",
    ATTESTATION_DB_FILENAME,
  );
}
