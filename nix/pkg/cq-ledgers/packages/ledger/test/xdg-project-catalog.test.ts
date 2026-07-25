import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CANONICAL_LEDGERS,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
} from "../src/constants.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import {
  PROJECT_DISPLAY_NAME_META_KEY,
  SqliteXdgProjectIdentityAccess,
  type XdgProjectIdentity,
} from "../src/store/sqlite/projectIdentity.js";
import { ensureSchema, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";
import {
  FilesystemXdgProjectCatalogSource,
  ReadOnlyXdgProjectCatalog,
  XdgProjectCatalogRootError,
  type XdgProjectCatalog,
  type XdgProjectCatalogCandidate,
  type XdgProjectCatalogDiagnosticCode,
  type XdgProjectCatalogSource,
  type XdgProjectStoreProbe,
  type XdgProjectStoreSnapshot,
} from "../src/store/sqlite/xdgProjectCatalog.js";

const roots: string[] = [];
const FIXED_NOW = "2026-07-25T00:00:00.000Z";
const SHA_KEY = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ValidCandidateOptions {
  readonly identity: XdgProjectIdentity | null;
  readonly substantive: boolean;
  readonly schemaVersion: number;
  readonly omitCanonicalLedger: string | null;
  readonly malformedCanonicalLedger: string | null;
  readonly divergentCanonicalLedger: string | null;
  readonly compatibleMissingOptionalField: {
    readonly ledger: string;
    readonly field: string;
  } | null;
  readonly addSqlColumn: boolean;
  readonly foreignKeyViolation: boolean;
  readonly includeActiveGroup: boolean;
  readonly includeAmbientMilestone: boolean;
}

const DEFAULT_VALID_OPTIONS: ValidCandidateOptions = {
  identity: null,
  substantive: false,
  schemaVersion: SCHEMA_VERSION,
  omitCanonicalLedger: null,
  malformedCanonicalLedger: null,
  divergentCanonicalLedger: null,
  compatibleMissingOptionalField: null,
  addSqlColumn: false,
  foreignKeyViolation: false,
  includeActiveGroup: true,
  includeAmbientMilestone: true,
};

function withValidOptions(
  patch: Partial<ValidCandidateOptions>,
): ValidCandidateOptions {
  return { ...DEFAULT_VALID_OPTIONS, ...patch };
}

function cloneCanonicalSchemas(
  options: ValidCandidateOptions,
): Map<string, string> {
  const schemas = new Map<string, string>();
  for (const canonical of CANONICAL_LEDGERS) {
    if (canonical.name === options.omitCanonicalLedger) continue;
    if (canonical.name === options.malformedCanonicalLedger) {
      schemas.set(canonical.name, "{");
      continue;
    }
    const schema = structuredClone(canonical.schema);
    if (canonical.name === options.divergentCanonicalLedger) {
      schema.statusValues = [...schema.statusValues, "future-status"];
    }
    if (canonical.name === options.compatibleMissingOptionalField?.ledger) {
      delete schema.fields[options.compatibleMissingOptionalField.field];
    }
    schemas.set(canonical.name, JSON.stringify(schema));
  }
  return schemas;
}

const VALID_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ledgers: ["name", "schema_json", "milestone_counter", "item_counter"],
  groups: ["ledger", "id", "title", "description"],
  items: [
    "ledger",
    "id",
    "milestone_id",
    "status",
    "fields_json",
    "created_at",
    "updated_at",
    "author",
    "session",
  ],
  archive_pointers: ["ledger", "id", "summary", "title", "status", "archived_at"],
  archived_items: [
    "ledger",
    "pointer_id",
    "id",
    "milestone_id",
    "status",
    "fields_json",
    "created_at",
    "updated_at",
    "author",
    "session",
  ],
  meta: ["key", "value"],
};

function makeSnapshot(options: ValidCandidateOptions): XdgProjectStoreSnapshot {
  const tableColumns = structuredClone(VALID_TABLE_COLUMNS) as Record<string, string[]>;
  if (options.addSqlColumn) tableColumns.items?.push("future_optional");
  return {
    integrityCheck: ["ok"],
    foreignKeyViolationCount: options.foreignKeyViolation ? 1 : 0,
    tableColumns,
    schemaVersion: options.schemaVersion,
    ledgerSchemaRows: [...cloneCanonicalSchemas(options)].map(([name, schemaJson]) => ({
      name,
      schemaJson,
    })),
    activeGroup: options.includeActiveGroup
      ? { title: MILESTONES_ACTIVE_GROUP_TITLE, description: "" }
      : null,
    ambientMilestone: options.includeAmbientMilestone
      ? {
          milestoneId: MILESTONES_ACTIVE_GROUP_ID,
          status: "open",
          fieldsJson: JSON.stringify({ title: "ambient" }),
        }
      : null,
    identity: options.identity,
    substantiveRowCount: options.substantive ? 1 : 0,
  };
}

class InMemoryXdgProjectCatalogSource implements XdgProjectCatalogSource {
  readonly candidates = new Map<
    string,
    { candidate: XdgProjectCatalogCandidate; probe: XdgProjectStoreProbe | null }
  >();
  readonly probes: string[] = [];

  constructor(readonly projectsRoot: string) {}

  addValid(key: string, options: ValidCandidateOptions): void {
    this.candidates.set(key, {
      candidate: { key, kind: "directory" },
      probe: { ok: true, snapshot: makeSnapshot(options) },
    });
  }

  addRejected(
    key: string,
    kind: XdgProjectCatalogCandidate["kind"],
    code: SourceRejectionCode,
  ): void {
    this.candidates.set(key, {
      candidate: { key, kind },
      probe:
        kind === "directory"
          ? { ok: false, code, message: `dummy ${code}` }
          : null,
    });
  }

  async listImmediateChildren(projectsRoot: string): Promise<readonly XdgProjectCatalogCandidate[]> {
    expect(projectsRoot).toBe(this.projectsRoot);
    return [...this.candidates.values()].map((entry) => entry.candidate).reverse();
  }

  async probeProject(
    projectsRoot: string,
    key: string,
  ): Promise<XdgProjectStoreProbe> {
    expect(projectsRoot).toBe(this.projectsRoot);
    this.probes.push(key);
    const entry = this.candidates.get(key);
    if (entry?.probe === null || entry?.probe === undefined) {
      throw new Error(`dummy candidate ${key} has no probe`);
    }
    return entry.probe;
  }
}

interface CatalogContractFixture {
  readonly root: string;
  readonly catalog: XdgProjectCatalog;
  addValid(key: string, options: ValidCandidateOptions): Promise<void>;
  addRejected(
    key: string,
    kind: XdgProjectCatalogCandidate["kind"],
    code: SourceRejectionCode,
  ): Promise<void>;
}

type SourceRejectionCode = Extract<
  XdgProjectCatalogDiagnosticCode,
  | "missing-database"
  | "not-directory"
  | "symlink"
  | "unreadable-database"
  | "malformed-project-identity"
>;

interface CatalogContractFactory {
  readonly name: string;
  build(): Promise<CatalogContractFixture>;
}

async function freshProjectsRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seedSqliteCandidate(
  projectsRoot: string,
  key: string,
  options: ValidCandidateOptions,
): Promise<string> {
  const stateDir = path.join(projectsRoot, key, "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "ledger.db");
  const db = openLedgerDb(dbPath);
  try {
    populateSqliteCandidate(db, options);
  } finally {
    db.close();
  }
  return dbPath;
}

function populateSqliteCandidate(
  db: ReturnType<typeof openLedgerDb>,
  options: ValidCandidateOptions,
): void {
  ensureSchema(db);
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
    options.schemaVersion,
  );
  const insertLedger = db.query(
    "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
  );
  for (const [name, rawSchema] of cloneCanonicalSchemas(options)) {
    insertLedger.run(name, rawSchema);
  }
  if (options.includeActiveGroup) {
    db.query(
      "INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, '')",
    ).run(
      MILESTONES_LEDGER,
      MILESTONES_ACTIVE_GROUP_ID,
      MILESTONES_ACTIVE_GROUP_TITLE,
    );
  }
  if (options.includeAmbientMilestone) {
    db.query(
      `INSERT INTO items
         (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
       VALUES (?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
    ).run(
      MILESTONES_LEDGER,
      MILESTONES_AMBIENT_ID,
      MILESTONES_ACTIVE_GROUP_ID,
      JSON.stringify({ title: "ambient" }),
      FIXED_NOW,
      FIXED_NOW,
    );
  }
  if (options.substantive) {
    db.query(
      `INSERT INTO items
         (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
       VALUES (?, 'T1', ?, 'planned', ?, ?, ?, NULL, NULL)`,
    ).run(
      TASKS_LEDGER,
      MILESTONES_AMBIENT_ID,
      JSON.stringify({ headline: "content title must not become project identity" }),
      FIXED_NOW,
      FIXED_NOW,
    );
  }
  if (options.identity !== null) {
    new SqliteXdgProjectIdentityAccess(db).upsertProjectIdentity(options.identity);
  }
  if (options.addSqlColumn) {
    db.exec("ALTER TABLE items ADD COLUMN future_optional TEXT");
  }
  if (options.foreignKeyViolation) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.query(
      "INSERT INTO groups (ledger, id, title, description) VALUES ('ghost', 'g', 'g', '')",
    ).run();
  }
}

const dummyFactory: CatalogContractFactory = {
  name: "hand-written in-memory dummy (Behavioral-Active Blackbox-Atomic)",
  async build() {
    const root = path.join(tmpdir(), "t830-dummy-projects");
    const source = new InMemoryXdgProjectCatalogSource(root);
    return {
      root,
      catalog: new ReadOnlyXdgProjectCatalog(source),
      async addValid(key, options) {
        source.addValid(key, options);
      },
      async addRejected(key, kind, code) {
        source.addRejected(key, kind, code);
      },
    };
  },
};

const realFactory: CatalogContractFactory = {
  name: "real filesystem/SQLite adapter (Behavioral-Active Blackbox-GoodCommunication)",
  async build() {
    const root = await freshProjectsRoot("t830-real-projects-");
    return {
      root,
      catalog: new ReadOnlyXdgProjectCatalog(new FilesystemXdgProjectCatalogSource()),
      async addValid(key, options) {
        await seedSqliteCandidate(root, key, options);
      },
      async addRejected(key, kind) {
        if (kind === "other") {
          await writeFile(path.join(root, key), "not a directory");
          return;
        }
        if (kind === "symlink") {
          const target = await freshProjectsRoot("t830-symlink-target-");
          await seedSqliteCandidate(target, "target", DEFAULT_VALID_OPTIONS);
          await symlink(path.join(target, "target"), path.join(root, key), "dir");
          return;
        }
        const stateDir = path.join(root, key, "state");
        await mkdir(stateDir, { recursive: true });
        await writeFile(path.join(stateDir, "ledger.db"), "not sqlite");
      },
    };
  },
};

function runCatalogContract(factory: CatalogContractFactory): void {
  describe(`XDG catalog contract — ${factory.name}`, () => {
    test("returns named substantive, unnamed bootstrap-only, and supported-v1 stores in display-name/key order", async () => {
      const fixture = await factory.build();
      await fixture.addValid(
        "named",
        withValidOptions({
          identity: { repositoryPath: "/repos/named", displayName: "alpha" },
          substantive: true,
        }),
      );
      await fixture.addValid(
        "named-second",
        withValidOptions({
          identity: { repositoryPath: "/repos/named-second", displayName: "alpha" },
          substantive: true,
        }),
      );
      await fixture.addValid("bootstrap-project", DEFAULT_VALID_OPTIONS);
      await fixture.addValid(
        "legacy",
        withValidOptions({
          identity: { repositoryPath: "/repos/legacy", displayName: "zulu" },
          schemaVersion: 1,
        }),
      );

      expect(await fixture.catalog.discover(fixture.root)).toEqual({
        projects: [
          {
            key: "named",
            displayName: "alpha",
            repositoryPath: "/repos/named",
            content: "substantive",
          },
          {
            key: "named-second",
            displayName: "alpha",
            repositoryPath: "/repos/named-second",
            content: "substantive",
          },
          {
            key: "bootstrap-project",
            displayName: "bootstrap-project",
            repositoryPath: null,
            content: "bootstrap-only",
          },
          {
            key: "legacy",
            displayName: "zulu",
            repositoryPath: "/repos/legacy",
            content: "bootstrap-only",
          },
        ],
        diagnostics: [
          {
            key: "bootstrap-project",
            severity: "warning",
            code: "missing-project-identity",
            message: "project identity metadata is absent; using the deterministic project-key fallback",
          },
        ],
      });
    });

    test("accepts forward-compatible canonical schemas and additive SQLite columns", async () => {
      const fixture = await factory.build();
      await fixture.addValid(
        "compatible",
        withValidOptions({
          compatibleMissingOptionalField: { ledger: TASKS_LEDGER, field: "rawLogs" },
          addSqlColumn: true,
        }),
      );

      const result = await fixture.catalog.discover(fixture.root);
      expect(result.projects.map((project) => project.key)).toEqual(["compatible"]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "missing-project-identity",
      ]);
    });

    test("rejects missing, malformed, and divergent canonical schemas plus unsupported versions", async () => {
      const fixture = await factory.build();
      await fixture.addValid(
        "d-divergent",
        withValidOptions({ divergentCanonicalLedger: TASKS_LEDGER }),
      );
      await fixture.addValid(
        "m-malformed",
        withValidOptions({ malformedCanonicalLedger: TASKS_LEDGER }),
      );
      await fixture.addValid(
        "n-missing",
        withValidOptions({ omitCanonicalLedger: TASKS_LEDGER }),
      );
      await fixture.addValid("u-unsupported", withValidOptions({ schemaVersion: 99 }));

      const result = await fixture.catalog.discover(fixture.root);
      expect(result.projects).toEqual([]);
      expect(
        result.diagnostics.map(({ key, severity, code }) => ({ key, severity, code })),
      ).toEqual([
        { key: "d-divergent", severity: "error", code: "divergent-canonical-schema" },
        { key: "m-malformed", severity: "error", code: "malformed-canonical-schema" },
        { key: "n-missing", severity: "error", code: "missing-canonical-ledger" },
        { key: "u-unsupported", severity: "error", code: "unsupported-schema-version" },
      ]);
    });

    test("rejects foreign-key/bootstrap failures, non-directories, symlinks, and unreadable databases deterministically", async () => {
      const fixture = await factory.build();
      await fixture.addValid(
        "a-foreign-key",
        withValidOptions({ foreignKeyViolation: true }),
      );
      await fixture.addValid(
        "b-no-active",
        withValidOptions({ includeActiveGroup: false }),
      );
      await fixture.addValid(
        "c-no-ambient",
        withValidOptions({ includeAmbientMilestone: false }),
      );
      await fixture.addRejected("d-file", "other", "not-directory");
      await fixture.addRejected("e-link", "symlink", "symlink");
      await fixture.addRejected("f-malformed", "directory", "unreadable-database");

      const result = await fixture.catalog.discover(fixture.root);
      expect(result.projects).toEqual([]);
      expect(result.diagnostics.map(({ key, code }) => ({ key, code }))).toEqual([
        { key: "a-foreign-key", code: "foreign-key-check-failed" },
        { key: "b-no-active", code: "invalid-bootstrap-state" },
        { key: "c-no-ambient", code: "invalid-bootstrap-state" },
        { key: "d-file", code: "not-directory" },
        { key: "e-link", code: "symlink" },
        { key: "f-malformed", code: "unreadable-database" },
      ]);
    });
  });
}

runCatalogContract(dummyFactory);
runCatalogContract(realFactory);

describe("filesystem XDG catalog boundaries", () => {
  test("uses only the explicit root and immediate children; never follows project or database symlinks", async () => {
    const explicitRoot = await freshProjectsRoot("t830-explicit-");
    const ambientRoot = await freshProjectsRoot("t830-ambient-");
    await seedSqliteCandidate(explicitRoot, "direct", DEFAULT_VALID_OPTIONS);
    await seedSqliteCandidate(ambientRoot, "ambient-env-project", DEFAULT_VALID_OPTIONS);

    const nestedContainer = path.join(explicitRoot, "container", "nested");
    await mkdir(nestedContainer, { recursive: true });
    await seedSqliteCandidate(nestedContainer, "deep-project", DEFAULT_VALID_OPTIONS);

    const outsideRoot = await freshProjectsRoot("t830-outside-");
    const outsideDb = await seedSqliteCandidate(outsideRoot, "outside", DEFAULT_VALID_OPTIONS);
    await symlink(path.dirname(path.dirname(outsideDb)), path.join(explicitRoot, "project-link"), "dir");
    await mkdir(path.join(explicitRoot, "db-link", "state"), { recursive: true });
    await symlink(outsideDb, path.join(explicitRoot, "db-link", "state", "ledger.db"));

    const priorXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = ambientRoot;
    try {
      const result = await new ReadOnlyXdgProjectCatalog(
        new FilesystemXdgProjectCatalogSource(),
      ).discover(explicitRoot);
      expect(result.projects.map((project) => project.key)).toEqual(["direct"]);
      expect(result.projects.map((project) => project.key)).not.toContain(
        "ambient-env-project",
      );
      expect(result.projects.map((project) => project.key)).not.toContain("deep-project");
      expect(result.diagnostics.map(({ key, code }) => ({ key, code }))).toEqual([
        { key: "container", code: "missing-database" },
        { key: "db-link", code: "symlink" },
        { key: "direct", code: "missing-project-identity" },
        { key: "project-link", code: "symlink" },
      ]);
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = priorXdg;
    }
  });

  test("strict read-only discovery preserves database/sidecar bytes, hashes, mtimes, and never invokes store init", async () => {
    const root = await freshProjectsRoot("t830-readonly-");
    const dbPath = await seedSqliteCandidate(
      root,
      SHA_KEY,
      withValidOptions({ substantive: true }),
    );
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    await writeFile(walPath, "sentinel-wal-bytes");
    await writeFile(shmPath, "sentinel-shm-bytes");
    const old = new Date("2001-02-03T04:05:06.000Z");
    await utimes(dbPath, old, old);
    await utimes(walPath, old, old);
    await utimes(shmPath, old, old);

    const before = await captureFilesystemManifest(root);
    const initSpy = spyOn(SqliteLedgerStore.prototype, "init");
    try {
      const result = await new ReadOnlyXdgProjectCatalog(
        new FilesystemXdgProjectCatalogSource(),
      ).discover(root);
      expect(result.projects).toEqual([
        {
          key: SHA_KEY,
          displayName: "bbbbbbbbbbbb",
          repositoryPath: null,
          content: "substantive",
        },
      ]);
      expect(initSpy).toHaveBeenCalledTimes(0);
    } finally {
      initSpy.mockRestore();
    }
    expect(await captureFilesystemManifest(root)).toEqual(before);
    expect((await readdir(path.dirname(dbPath))).sort()).toEqual([
      "ledger.db",
      "ledger.db-shm",
      "ledger.db-wal",
    ]);
  });

  test("discovers committed WAL schema, identity, and content without mutating an open production store", async () => {
    const root = await freshProjectsRoot("t830-live-wal-");
    const key = "live-wal-project";
    const stateDir = path.join(root, key, "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, "ledger.db");
    const writer = openLedgerDb(dbPath);
    const initSpy = spyOn(SqliteLedgerStore.prototype, "init");
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      populateSqliteCandidate(
        writer,
        withValidOptions({
          identity: {
            repositoryPath: "/repos/live-wal",
            displayName: "live WAL project",
          },
          substantive: true,
        }),
      );

      expect((await readdir(stateDir)).sort()).toEqual([
        "ledger.db",
        "ledger.db-shm",
        "ledger.db-wal",
      ]);
      const before = await captureFilesystemManifest(root);

      const result = await new ReadOnlyXdgProjectCatalog(
        new FilesystemXdgProjectCatalogSource(),
      ).discover(root);

      expect(result).toEqual({
        projects: [
          {
            key,
            displayName: "live WAL project",
            repositoryPath: "/repos/live-wal",
            content: "substantive",
          },
        ],
        diagnostics: [],
      });
      expect(initSpy).toHaveBeenCalledTimes(0);
      expect(await captureFilesystemManifest(root)).toEqual(before);
      expect((await readdir(stateDir)).sort()).toEqual([
        "ledger.db",
        "ledger.db-shm",
        "ledger.db-wal",
      ]);
    } finally {
      initSpy.mockRestore();
      writer.close();
    }
  });

  test("reports integrity failures from the shared validation layer", async () => {
    const root = path.join(tmpdir(), "t830-integrity-dummy");
    const source = new InMemoryXdgProjectCatalogSource(root);
    const snapshot = makeSnapshot(DEFAULT_VALID_OPTIONS);
    source.candidates.set("corrupt", {
      candidate: { key: "corrupt", kind: "directory" },
      probe: {
        ok: true,
        snapshot: { ...snapshot, integrityCheck: ["row 7 missing from index"] },
      },
    });

    const result = await new ReadOnlyXdgProjectCatalog(source).discover(root);
    expect(result.projects).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "integrity-check-failed",
    ]);
  });

  test("rejects missing physical tables/columns, missing or malformed schema versions, and malformed identity", async () => {
    const root = await freshProjectsRoot("t830-physical-");
    const emptyState = path.join(root, "a-empty", "state");
    await mkdir(emptyState, { recursive: true });
    await writeFile(path.join(emptyState, "ledger.db"), "");
    const missingTableDb = await seedSqliteCandidate(root, "b-table", DEFAULT_VALID_OPTIONS);
    const missingColumnDb = await seedSqliteCandidate(root, "c-column", DEFAULT_VALID_OPTIONS);
    const missingVersionDb = await seedSqliteCandidate(root, "d-version", DEFAULT_VALID_OPTIONS);
    const malformedVersionDb = await seedSqliteCandidate(root, "e-version", DEFAULT_VALID_OPTIONS);
    const malformedIdentityDb = await seedSqliteCandidate(root, "f-identity", DEFAULT_VALID_OPTIONS);
    const duplicateCanonicalDb = await seedSqliteCandidate(
      root,
      "g-duplicate",
      DEFAULT_VALID_OPTIONS,
    );

    mutateDb(missingTableDb, (db) => db.exec("DROP TABLE archived_items"));
    mutateDb(missingColumnDb, (db) =>
      db.exec("ALTER TABLE archive_pointers RENAME COLUMN summary TO future_summary"),
    );
    mutateDb(missingVersionDb, (db) =>
      db.query("DELETE FROM meta WHERE key = 'schema_version'").run(),
    );
    mutateDb(malformedVersionDb, (db) =>
      db.query("UPDATE meta SET value = 'two' WHERE key = 'schema_version'").run(),
    );
    mutateDb(malformedIdentityDb, (db) =>
      db
        .query("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run(PROJECT_DISPLAY_NAME_META_KEY, "orphaned name"),
    );
    mutateDb(duplicateCanonicalDb, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("ALTER TABLE ledgers RENAME TO original_ledgers");
      db.exec(`
        CREATE TABLE ledgers (
          name TEXT NOT NULL,
          schema_json TEXT NOT NULL,
          milestone_counter INTEGER NOT NULL,
          item_counter INTEGER NOT NULL
        )
      `);
      db.exec("INSERT INTO ledgers SELECT * FROM original_ledgers");
      db.query("INSERT INTO ledgers SELECT * FROM original_ledgers WHERE name = ?").run(
        TASKS_LEDGER,
      );
    });

    const result = await new ReadOnlyXdgProjectCatalog(
      new FilesystemXdgProjectCatalogSource(),
    ).discover(root);
    expect(result.projects).toEqual([]);
    expect(result.diagnostics.map(({ key, code }) => ({ key, code }))).toEqual([
      { key: "a-empty", code: "missing-table" },
      { key: "b-table", code: "missing-table" },
      { key: "c-column", code: "missing-column" },
      { key: "d-version", code: "missing-schema-version" },
      { key: "e-version", code: "malformed-schema-version" },
      { key: "f-identity", code: "malformed-project-identity" },
      { key: "g-duplicate", code: "duplicate-canonical-ledger" },
    ]);
  });

  test("does not filter by age or infer display names from workflow titles", async () => {
    const root = await freshProjectsRoot("t830-age-");
    const dbPath = await seedSqliteCandidate(
      root,
      "readable-project-id",
      withValidOptions({ substantive: true }),
    );
    const old = new Date("1999-12-31T23:59:59.000Z");
    await utimes(dbPath, old, old);

    const result = await new ReadOnlyXdgProjectCatalog(
      new FilesystemXdgProjectCatalogSource(),
    ).discover(root);
    expect(result.projects).toEqual([
      {
        key: "readable-project-id",
        displayName: "readable-project-id",
        repositoryPath: null,
        content: "substantive",
      },
    ]);
  });

  test("rejects a relative, missing, non-directory, or symlink projects root", async () => {
    const catalog = new ReadOnlyXdgProjectCatalog(new FilesystemXdgProjectCatalogSource());
    await expect(catalog.discover("relative/projects")).rejects.toBeInstanceOf(
      XdgProjectCatalogRootError,
    );
    await expect(catalog.discover(path.join(tmpdir(), "t830-does-not-exist"))).rejects.toBeInstanceOf(
      XdgProjectCatalogRootError,
    );

    const fileRoot = path.join(await freshProjectsRoot("t830-file-root-"), "file");
    await writeFile(fileRoot, "x");
    await expect(catalog.discover(fileRoot)).rejects.toBeInstanceOf(
      XdgProjectCatalogRootError,
    );

    const target = await freshProjectsRoot("t830-root-target-");
    const link = path.join(await freshProjectsRoot("t830-root-link-parent-"), "link");
    await symlink(target, link, "dir");
    await expect(catalog.discover(link)).rejects.toBeInstanceOf(
      XdgProjectCatalogRootError,
    );
  });
});

function mutateDb(dbPath: string, mutate: (db: ReturnType<typeof openLedgerDb>) => void): void {
  const db = openLedgerDb(dbPath);
  try {
    mutate(db);
  } finally {
    db.close();
  }
}

interface ManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mtimeNs: string;
  readonly bytes?: string;
  readonly sha256?: string;
  readonly target?: string;
}

async function captureFilesystemManifest(root: string): Promise<readonly ManifestEntry[]> {
  const entries: ManifestEntry[] = [];

  async function visit(absolute: string, relative: string): Promise<void> {
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink()) {
      entries.push({
        path: relative,
        kind: "symlink",
        mtimeNs: info.mtimeNs.toString(),
        target: await readlink(absolute),
      });
      return;
    }
    if (info.isDirectory()) {
      entries.push({
        path: relative,
        kind: "directory",
        mtimeNs: info.mtimeNs.toString(),
      });
      const children = (await readdir(absolute)).sort();
      for (const child of children) {
        await visit(path.join(absolute, child), path.join(relative, child));
      }
      return;
    }
    const bytes = await readFile(absolute);
    entries.push({
      path: relative,
      kind: "file",
      mtimeNs: info.mtimeNs.toString(),
      bytes: bytes.toString("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  await visit(root, ".");
  return entries;
}
