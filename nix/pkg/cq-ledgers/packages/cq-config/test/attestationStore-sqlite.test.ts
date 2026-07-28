/**
 * The shared adapter contract against the bun:sqlite / XDG production backend,
 * plus the properties only this backend has (T720, goal G94).
 *
 * Every case runs against a throwaway db file under `mkdtemp`. `XDG_STATE_HOME`
 * is never consulted, and the real one is never touched: the fixture passes an
 * explicit `dbPath`, and the only test that exercises the XDG layout asserts the
 * pure path function against a synthetic environment record (D170's guard note —
 * a subagent has destroyed the live store from a worktree twice).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTATION_DB_FILENAME,
  ATTESTATION_TABLE,
  AttestationStorageError,
  AttestationTransportError,
  PERSISTED_ATTESTATION_COLUMNS,
  SqliteAttestationBackend,
  ensureAttestationSchema,
  xdgAttestationDbPath,
  xdgAttestationStateBase,
  type AttestationNamespace,
} from "@cq/config";
import {
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "./attestationStoreContract.js";

const NAMESPACE_BACKEND = "xdg" as const;

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cq-t720-sqlite-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

runAttestationStoreContract({
  name: "bun:sqlite (xdg)",
  namespaceBackend: NAMESPACE_BACKEND,
  build(projectKey: string): Promise<AttestationContractFixture> {
    const dbPath = join(freshRoot(), ATTESTATION_DB_FILENAME);
    const namespace: AttestationNamespace = { backend: NAMESPACE_BACKEND, projectKey };
    const open = (key: string): SqliteAttestationBackend =>
      new SqliteAttestationBackend({
        namespace: { backend: NAMESPACE_BACKEND, projectKey: key },
        dbPath,
      });

    let live = new SqliteAttestationBackend({ namespace, dbPath });
    const extra: SqliteAttestationBackend[] = [];
    const track = (backend: SqliteAttestationBackend): SqliteAttestationBackend => {
      extra.push(backend);
      return backend;
    };
    return Promise.resolve({
      get backend() {
        return live;
      },
      peer: () => Promise.resolve(track(open(projectKey))),
      restart: async () => {
        // A genuine reopen: the previous handle is closed, so nothing in memory
        // can be carrying the answer forward.
        await live.close();
        live = open(projectKey);
        return live;
      },
      sibling: (key: string) => Promise.resolve(track(open(key))),
      rows: () => Promise.resolve(live.storedRows()),
      dump: () => Promise.resolve(live.rawStorageDump()),
      artifacts: () => Promise.resolve(live.storageArtifacts()),
      breakBackend: () => {
        // OUT OF BAND: a peer connection drops the table from underneath the
        // live handle, so its next read AND its next write must fail explicitly.
        // Closing `live` would only prove the `closed` flag works.
        const saboteur = new Database(dbPath);
        saboteur.exec(`DROP TABLE ${ATTESTATION_TABLE}`);
        saboteur.close();
        return Promise.resolve();
      },
      dispose: async () => {
        await live.close();
        for (const backend of extra) {
          await backend.close();
        }
      },
    });
  },
  openWithBadCredentials: async () => {
    // A directory is not a database file: the failure must land at OPEN, before
    // any dispatch has been prepared against it.
    const root = freshRoot();
    await Promise.resolve();
    new SqliteAttestationBackend({
      namespace: { backend: NAMESPACE_BACKEND, projectKey: "unusable" },
      dbPath: root,
    });
  },
});

// ---------------------------------------------------------------------------
// Properties specific to this backend
// ---------------------------------------------------------------------------

describe("bun:sqlite attestation backend specifics", () => {
  test("only the xdg backend may be served, and the excluded ones fail at construction", () => {
    const dbPath = join(freshRoot(), ATTESTATION_DB_FILENAME);
    for (const backend of ["fs", "postgres"] as const) {
      expect(
        () => new SqliteAttestationBackend({ namespace: { backend, projectKey: "p" }, dbPath }),
        backend,
      ).toThrow(AttestationStorageError);
    }
    for (const backend of ["git-object", "remote"] as const) {
      expect(
        () => new SqliteAttestationBackend({ namespace: { backend, projectKey: "p" }, dbPath }),
        backend,
      ).toThrow(/cannot hold dispatch attestations/);
    }
  });

  test("the schema is exactly the one persisted-row column set — no parallel output table", () => {
    const db = new Database(join(freshRoot(), ATTESTATION_DB_FILENAME), { create: true });
    ensureAttestationSchema(db);
    // Idempotent: a second open must not fail or add anything.
    ensureAttestationSchema(db);
    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as readonly { readonly name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual([ATTESTATION_TABLE]);
    const columns = (
      db.query(`PRAGMA table_info(${ATTESTATION_TABLE})`).all() as readonly {
        readonly name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toEqual([...PERSISTED_ATTESTATION_COLUMNS]);
    // Both durable uniqueness guards exist as INDEXES, not as service code.
    const indexes = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .all() as readonly { readonly name: string }[]
    ).map((row) => row.name);
    expect(indexes.sort()).toEqual([
      `${ATTESTATION_TABLE}_capability`,
      `${ATTESTATION_TABLE}_idempotency`,
    ]);
    db.close();
  });

  test("opening succeeds while a peer holds the write lock — WAL is best-effort", async () => {
    // REGRESSION (found by the cross-process suite): a peer crashed inside the
    // constructor with SQLITE_BUSY from `PRAGMA journal_mode = WAL`, because
    // converting to WAL needs an EXCLUSIVE lock and — measured, not assumed —
    // `busy_timeout` does NOT apply to that conversion: it fails after 0ms
    // whether or not a timeout is set. So two processes opening the same fresh
    // store at once had one of them fail before it could serve anything.
    //
    // WAL is an optimisation; cross-process serialization comes from
    // `BEGIN IMMEDIATE` + `busy_timeout`, which work in rollback-journal mode
    // too. The conversion is therefore retried briefly and then skipped.
    const dbPath = join(freshRoot(), ATTESTATION_DB_FILENAME);
    // A store whose schema already exists, deliberately NOT in WAL mode, so the
    // only contended statement at open is the journal-mode conversion.
    const seed = new Database(dbPath, { create: true });
    ensureAttestationSchema(seed);
    seed.exec("PRAGMA journal_mode = delete");
    seed.close();

    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    let backend: SqliteAttestationBackend | undefined;
    try {
      // Previously this THREW; it must now open.
      backend = new SqliteAttestationBackend({
        namespace: { backend: NAMESPACE_BACKEND, projectKey: "wal-contended" },
        dbPath,
      });
      expect(backend.storedRows()).toEqual([]);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // And the store is fully usable once the peer releases the lock.
    expect(await backend!.transact({ kind: "namespace" }, (store) => store.rows())).toEqual([]);
    await backend!.close();
    // A later open, uncontended, does convert the file to WAL as intended.
    const later = new SqliteAttestationBackend({
      namespace: { backend: NAMESPACE_BACKEND, projectKey: "wal-contended" },
      dbPath,
    });
    const mode = new Database(dbPath).query("PRAGMA journal_mode").all() as readonly {
      readonly journal_mode: string;
    }[];
    expect(mode[0]?.journal_mode).toBe("wal");
    await later.close();
  });

  test("a NON-contention journal-mode failure is still raised, not swallowed", () => {
    // The other half of the best-effort conversion: skipping the WAL switch is
    // only correct when the cause is CONTENTION. A read-only store cannot be
    // opened for writing at all, and must fail loudly rather than be reported as
    // an ordinary store that merely stayed in rollback mode. (Mutation M54.)
    const root = freshRoot();
    const dbPath = join(root, ATTESTATION_DB_FILENAME);
    const seed = new Database(dbPath, { create: true });
    ensureAttestationSchema(seed);
    seed.exec("PRAGMA journal_mode = delete");
    seed.close();
    // Read-only file AND directory: no -wal sidecar can be created either.
    chmodSync(dbPath, 0o444);
    chmodSync(root, 0o555);
    try {
      expect(
        () =>
          new SqliteAttestationBackend({
            namespace: { backend: NAMESPACE_BACKEND, projectKey: "readonly" },
            dbPath,
          }),
      ).toThrow();
    } finally {
      // Restore permissions so afterAll can remove the directory.
      chmodSync(root, 0o755);
      chmodSync(dbPath, 0o644);
    }
  });

  test("a closed handle refuses every unit of work as a transport failure", async () => {
    const dbPath = join(freshRoot(), ATTESTATION_DB_FILENAME);
    const backend = new SqliteAttestationBackend({
      namespace: { backend: NAMESPACE_BACKEND, projectKey: "closed" },
      dbPath,
    });
    await backend.close();
    await expect(backend.transact({ kind: "namespace" }, (store) => store.rows())).rejects.toThrow(
      AttestationTransportError,
    );
    // close() is idempotent.
    await backend.close();
  });

  test("the xdg location is derived from an explicit environment, never the real one", () => {
    // D170's guard note: this repo's live store must never be resolved from a
    // worktree, so the layout is asserted against a synthetic env record only.
    expect(xdgAttestationStateBase({ XDG_STATE_HOME: "/synthetic/state" })).toBe(
      "/synthetic/state",
    );
    // A relative or blank XDG_STATE_HOME is ignored, as in the ledger's primary.
    expect(xdgAttestationStateBase({ XDG_STATE_HOME: "relative/state" })).toContain(".local");
    expect(xdgAttestationStateBase({ XDG_STATE_HOME: "  " })).toContain(".local");
    expect(xdgAttestationStateBase({})).toContain(join(".local", "state"));
    expect(xdgAttestationDbPath("proj", { XDG_STATE_HOME: "/synthetic/state" })).toBe(
      join("/synthetic/state", "cq", "projects", "proj", "state", ATTESTATION_DB_FILENAME),
    );
  });
});
