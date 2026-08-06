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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
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

/**
 * One interned bun:sqlite connection + in-process mutex for a resolved db path
 * (D177). Two {@link SqliteAttestationBackend} handles over the SAME file must
 * share both: a per-instance mutex leaves concurrent `BEGIN IMMEDIATE` to the
 * synchronous `busy_timeout`, which stalls the event loop for the full
 * {@link ATTESTATION_BUSY_TIMEOUT_MS}.
 */
export interface SqliteAttestationConnection {
  readonly db: Database;
  readonly mutex: AsyncMutex;
  /** Canonical absolute path the registry keys on. */
  readonly resolvedPath: string;
}

interface RegistryEntry {
  readonly connection: SqliteAttestationConnection;
  refCount: number;
}

/**
 * Interns ONE {@link Database} + ONE {@link AsyncMutex} per resolved db path.
 * Constructor-injectable so tests own an isolated registry; production callers
 * that omit it share {@link defaultSqliteAttestationConnectionRegistry}.
 */
export class SqliteAttestationConnectionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /** Acquire (or create) the shared connection for `dbPath`. */
  acquire(dbPath: string): SqliteAttestationConnection {
    const preOpenKey = resolveAttestationDbKey(dbPath);
    const existing = this.entries.get(preOpenKey);
    if (existing !== undefined) {
      existing.refCount += 1;
      return existing.connection;
    }
    const db = openAttestationDb(dbPath);
    // Open creates the file; re-resolve so subsequent acquires on equivalent
    // path spellings (relative vs absolute, pre- vs post-create) intern.
    const resolvedPath = resolveAttestationDbKey(dbPath);
    const raced = this.entries.get(resolvedPath);
    if (raced !== undefined) {
      // Same-tick double-open lost the intern race: drop the spare handle.
      db.close();
      raced.refCount += 1;
      return raced.connection;
    }
    const connection: SqliteAttestationConnection = {
      db,
      mutex: new AsyncMutex(),
      resolvedPath,
    };
    const entry: RegistryEntry = { connection, refCount: 1 };
    this.entries.set(resolvedPath, entry);
    if (preOpenKey !== resolvedPath) {
      this.entries.set(preOpenKey, entry);
    }
    return connection;
  }

  /** Drop one holder; close the Database when the last holder releases. */
  release(connection: SqliteAttestationConnection): void {
    const entry = this.entries.get(connection.resolvedPath);
    if (entry === undefined || entry.connection !== connection) {
      throw new Error(
        `sqlite attestation registry release of unknown connection "${connection.resolvedPath}"`,
      );
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    for (const [key, value] of this.entries) {
      if (value === entry) this.entries.delete(key);
    }
    connection.db.close();
  }

  /** Test seam: how many live holders the registry currently tracks. */
  holderCount(dbPath: string): number {
    return this.entries.get(resolveAttestationDbKey(dbPath))?.refCount ?? 0;
  }
}

/** Process-wide default registry used when a constructor omits `registry`. */
export const defaultSqliteAttestationConnectionRegistry =
  new SqliteAttestationConnectionRegistry();

/** Canonical absolute key for interning a db path (realpath when the file exists). */
export function resolveAttestationDbKey(dbPath: string): string {
  const absolute = resolvePath(dbPath);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export interface SqliteAttestationBackendOptions {
  readonly namespace: AttestationNamespace;
  /** A concrete db file path. XDG resolution is {@link xdgAttestationDbPath}'s. */
  readonly dbPath: string;
  /**
   * Connection internment scope (D177). Prefer injecting an explicit registry
   * (tests, multi-tenant hosts that want isolation); omit to share the process
   * default so independent constructions over one file still serialize.
   */
  readonly registry?: SqliteAttestationConnectionRegistry;
}

/**
 * The bun:sqlite attestation backend. Bound to ONE namespace; rows of another
 * namespace in the same file are invisible to it and unreachable through it.
 *
 * Connections are interned per resolved db path (D177): two handles over ONE
 * file share ONE Database and ONE AsyncMutex so concurrent units of work never
 * contend on synchronous `BEGIN IMMEDIATE` / `busy_timeout`.
 */
export class SqliteAttestationBackend implements AttestationBackend {
  readonly namespace: AttestationNamespace;
  readonly dbPath: string;

  private readonly registry: SqliteAttestationConnectionRegistry;
  private readonly connection: SqliteAttestationConnection;
  private closed = false;

  constructor(options: SqliteAttestationBackendOptions) {
    this.namespace = assertSqliteNamespace(options.namespace);
    this.dbPath = options.dbPath;
    this.registry = options.registry ?? defaultSqliteAttestationConnectionRegistry;
    this.connection = this.registry.acquire(options.dbPath);
    try {
      ensureAttestationSchema(this.connection.db);
    } catch (error) {
      this.registry.release(this.connection);
      throw asSqliteBackendError(error);
    }
  }

  private get db(): Database {
    return this.connection.db;
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
    return this.connection.mutex.run(async () => {
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
      this.registry.release(this.connection);
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
    // Connection-local pragmas first: neither takes a lock, and `busy_timeout`
    // must be in force before any contended statement runs.
    db.exec(`PRAGMA busy_timeout = ${ATTESTATION_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA synchronous = NORMAL");
  } catch (error) {
    db.close();
    throw asSqliteBackendError(error);
  }
  try {
    enableWalBestEffort(db);
  } catch (error) {
    db.close();
    throw asSqliteBackendError(error);
  }
  return db;
}

/** How many times a contended WAL conversion is retried before giving up on it. */
export const ATTESTATION_WAL_CONVERSION_ATTEMPTS = 5;

/** How long to wait between WAL-conversion attempts. */
const WAL_RETRY_SLEEP_MS = 25;

/**
 * Switch the database to WAL, tolerating a peer that is converting it right now.
 *
 * **Why this cannot just be `db.exec("PRAGMA journal_mode = WAL")`.** Converting a
 * database to WAL needs an EXCLUSIVE lock, and — measured, not assumed —
 * `busy_timeout` does NOT apply to it: with another connection holding a write
 * lock, the conversion fails with `SQLITE_BUSY` after 0ms whether or not a busy
 * timeout is set. So two processes opening the same FRESH store at once will have
 * one of them fail inside the constructor, before it can serve anything. That is
 * what happened to a peer in the cross-process key-reuse suite: it crashed at open
 * instead of losing the key race it was spawned to run.
 *
 * WAL is an OPTIMISATION here, not a correctness requirement: cross-process
 * serialization comes from `BEGIN IMMEDIATE` plus `busy_timeout`, which work in
 * rollback-journal mode too. The journal mode is a property of the FILE, so once
 * any process converts it every later connection sees WAL. Retrying briefly and
 * then proceeding is therefore strictly better than refusing to open — and it is
 * NOT a swallowed error: a store that stays in rollback mode is fully correct,
 * only less concurrent.
 */
function enableWalBestEffort(db: Database): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const classified = asSqliteBackendError(error);
      // Anything that is NOT contention is a real failure to open.
      if (!(classified instanceof AttestationTransportError) || !isBusy(error)) {
        throw error;
      }
      if (attempt >= ATTESTATION_WAL_CONVERSION_ATTEMPTS) {
        return;
      }
      Bun.sleepSync(WAL_RETRY_SLEEP_MS);
    }
  }
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof SQLiteError)) {
    return false;
  }
  const code = error.code;
  return (
    typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
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
