import { Database, constants as sqliteConstants } from "bun:sqlite";
import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { LedgerSchema } from "../../types.js";
import {
  CANONICAL_LEDGERS,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
} from "../../constants.js";
import { validateSchema } from "../core.js";
import { schemaCompatible, schemasEqual } from "../schemaCompat.js";
import {
  SqliteXdgProjectIdentityAccess,
  XdgProjectIdentityMetadataError,
  type XdgProjectIdentity,
} from "./projectIdentity.js";
import { SCHEMA_VERSION } from "./schema.js";

const XDG_DB_FILENAME = "ledger.db";
const MIN_SUPPORTED_SCHEMA_VERSION = 1;
const SHA1_PROJECT_KEY_RE = /^[0-9a-f]{40}$/i;
const SHA1_FALLBACK_LENGTH = 12;

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
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

export type XdgProjectCatalogContent = "bootstrap-only" | "substantive";

export interface XdgProjectCatalogEntry {
  readonly key: string;
  readonly displayName: string;
  readonly repositoryPath: string | null;
  readonly content: XdgProjectCatalogContent;
}

export type XdgProjectCatalogDiagnosticCode =
  | "not-directory"
  | "symlink"
  | "missing-database"
  | "unreadable-database"
  | "integrity-check-failed"
  | "foreign-key-check-failed"
  | "missing-table"
  | "missing-column"
  | "missing-schema-version"
  | "malformed-schema-version"
  | "unsupported-schema-version"
  | "missing-canonical-ledger"
  | "duplicate-canonical-ledger"
  | "malformed-canonical-schema"
  | "divergent-canonical-schema"
  | "invalid-bootstrap-state"
  | "malformed-project-identity"
  | "missing-project-identity";

export interface XdgProjectCatalogDiagnostic {
  readonly key: string;
  readonly severity: "warning" | "error";
  readonly code: XdgProjectCatalogDiagnosticCode;
  readonly message: string;
}

export interface XdgProjectCatalogResult {
  readonly projects: readonly XdgProjectCatalogEntry[];
  readonly diagnostics: readonly XdgProjectCatalogDiagnostic[];
}

export interface XdgProjectCatalog {
  discover(projectsRoot: string): Promise<XdgProjectCatalogResult>;
}

export interface XdgProjectCatalogCandidate {
  readonly key: string;
  readonly kind: "directory" | "symlink" | "other";
}

export interface XdgProjectStoreSnapshot {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyViolationCount: number;
  readonly tableColumns: Readonly<Record<string, readonly string[]>>;
  readonly schemaVersion: unknown;
  readonly ledgerSchemaRows: readonly {
    readonly name: string;
    readonly schemaJson: unknown;
  }[];
  readonly activeGroup: {
    readonly title: unknown;
    readonly description: unknown;
  } | null;
  readonly ambientMilestone: {
    readonly milestoneId: unknown;
    readonly status: unknown;
    readonly fieldsJson: unknown;
  } | null;
  readonly identity: XdgProjectIdentity | null;
  readonly substantiveRowCount: number;
}

export type XdgProjectStoreProbe =
  | { readonly ok: true; readonly snapshot: XdgProjectStoreSnapshot }
  | {
      readonly ok: false;
      readonly code: Extract<
        XdgProjectCatalogDiagnosticCode,
        | "missing-database"
        | "not-directory"
        | "symlink"
        | "unreadable-database"
        | "malformed-project-identity"
      >;
      readonly message: string;
    };

export interface XdgProjectCatalogSource {
  listImmediateChildren(
    projectsRoot: string,
  ): Promise<readonly XdgProjectCatalogCandidate[]>;
  probeProject(projectsRoot: string, key: string): Promise<XdgProjectStoreProbe>;
}

export class XdgProjectCatalogRootError extends Error {
  override readonly name = "XdgProjectCatalogRootError";
}

export class ReadOnlyXdgProjectCatalog implements XdgProjectCatalog {
  constructor(private readonly source: XdgProjectCatalogSource) {}

  async discover(projectsRoot: string): Promise<XdgProjectCatalogResult> {
    if (!path.isAbsolute(projectsRoot)) {
      throw new XdgProjectCatalogRootError(
        `XDG projects root must be an absolute path: ${projectsRoot}`,
      );
    }

    const projects: XdgProjectCatalogEntry[] = [];
    const diagnostics: XdgProjectCatalogDiagnostic[] = [];
    const candidates = [...(await this.source.listImmediateChildren(projectsRoot))].sort(
      (a, b) => compareStrings(a.key, b.key),
    );

    for (const candidate of candidates) {
      if (candidate.kind === "symlink") {
        diagnostics.push(
          errorDiagnostic(
            candidate.key,
            "symlink",
            "project candidate is a symbolic link; discovery never follows symlinks",
          ),
        );
        continue;
      }
      if (candidate.kind !== "directory") {
        diagnostics.push(
          errorDiagnostic(
            candidate.key,
            "not-directory",
            "project candidate is not a directory",
          ),
        );
        continue;
      }

      const probe = await this.source.probeProject(projectsRoot, candidate.key);
      if (!probe.ok) {
        diagnostics.push(errorDiagnostic(candidate.key, probe.code, probe.message));
        continue;
      }

      const validationError = validateSnapshot(candidate.key, probe.snapshot);
      if (validationError !== null) {
        diagnostics.push(validationError);
        continue;
      }

      const identity = probe.snapshot.identity;
      if (identity === null) {
        diagnostics.push({
          key: candidate.key,
          severity: "warning",
          code: "missing-project-identity",
          message:
            "project identity metadata is absent; using the deterministic project-key fallback",
        });
      }
      projects.push({
        key: candidate.key,
        displayName: identity?.displayName ?? fallbackDisplayName(candidate.key),
        repositoryPath: identity?.repositoryPath ?? null,
        content: probe.snapshot.substantiveRowCount === 0 ? "bootstrap-only" : "substantive",
      });
    }

    projects.sort(
      (a, b) =>
        compareStrings(a.displayName, b.displayName) || compareStrings(a.key, b.key),
    );
    diagnostics.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.code, b.code),
    );
    return { projects, diagnostics };
  }
}

export class FilesystemXdgProjectCatalogSource implements XdgProjectCatalogSource {
  async listImmediateChildren(
    projectsRoot: string,
  ): Promise<readonly XdgProjectCatalogCandidate[]> {
    let rootInfo;
    try {
      rootInfo = await lstat(projectsRoot);
    } catch {
      throw new XdgProjectCatalogRootError(
        `XDG projects root does not exist or is unreadable: ${projectsRoot}`,
      );
    }
    if (rootInfo.isSymbolicLink()) {
      throw new XdgProjectCatalogRootError(
        `XDG projects root must not be a symbolic link: ${projectsRoot}`,
      );
    }
    if (!rootInfo.isDirectory()) {
      throw new XdgProjectCatalogRootError(
        `XDG projects root is not a directory: ${projectsRoot}`,
      );
    }

    let children;
    try {
      children = await readdir(projectsRoot, { withFileTypes: true });
    } catch {
      throw new XdgProjectCatalogRootError(
        `XDG projects root cannot be enumerated: ${projectsRoot}`,
      );
    }
    return children.map((child) => ({
      key: child.name,
      kind: child.isSymbolicLink()
        ? "symlink"
        : child.isDirectory()
          ? "directory"
          : "other",
    }));
  }

  async probeProject(projectsRoot: string, key: string): Promise<XdgProjectStoreProbe> {
    const projectDir = path.join(projectsRoot, key);
    const stateDir = path.join(projectDir, "state");
    const dbPath = path.join(stateDir, XDG_DB_FILENAME);

    const projectInspection = await inspectPath(projectDir);
    if (projectInspection.status === "missing") {
      return {
        ok: false,
        code: "missing-database",
        message: "project candidate has no state/ledger.db",
      };
    }
    if (projectInspection.status === "unreadable") {
      return {
        ok: false,
        code: "unreadable-database",
        message: "project candidate cannot be inspected",
      };
    }
    if (projectInspection.info.isSymbolicLink()) {
      return {
        ok: false,
        code: "symlink",
        message: "project candidate is a symbolic link; discovery never follows symlinks",
      };
    }
    if (!projectInspection.info.isDirectory()) {
      return {
        ok: false,
        code: "not-directory",
        message: "project candidate is not a directory",
      };
    }

    const stateInspection = await inspectPath(stateDir);
    if (stateInspection.status === "missing") {
      return {
        ok: false,
        code: "missing-database",
        message: "project candidate has no state/ledger.db",
      };
    }
    if (stateInspection.status === "unreadable") {
      return {
        ok: false,
        code: "unreadable-database",
        message: "project state directory cannot be inspected",
      };
    }
    if (stateInspection.info.isSymbolicLink()) {
      return {
        ok: false,
        code: "symlink",
        message: "project state directory is a symbolic link; discovery never follows symlinks",
      };
    }
    if (!stateInspection.info.isDirectory()) {
      return {
        ok: false,
        code: "not-directory",
        message: "project state path is not a directory",
      };
    }

    const dbInspection = await inspectPath(dbPath);
    if (dbInspection.status === "missing") {
      return {
        ok: false,
        code: "missing-database",
        message: "project candidate has no state/ledger.db",
      };
    }
    if (dbInspection.status === "unreadable") {
      return {
        ok: false,
        code: "unreadable-database",
        message: "project state/ledger.db cannot be inspected",
      };
    }
    if (dbInspection.info.isSymbolicLink()) {
      return {
        ok: false,
        code: "symlink",
        message: "project ledger.db is a symbolic link; discovery never follows symlinks",
      };
    }
    if (!dbInspection.info.isFile()) {
      return {
        ok: false,
        code: "unreadable-database",
        message: "project state/ledger.db is not a regular file",
      };
    }

    let db: Database | null = null;
    try {
      db = openStrictReadOnlyDatabase(dbPath);
      const snapshot = readSnapshot(db);
      return { ok: true, snapshot };
    } catch (error) {
      if (error instanceof XdgProjectIdentityMetadataError) {
        return {
          ok: false,
          code: "malformed-project-identity",
          message: "project identity metadata is incomplete or malformed",
        };
      }
      return {
        ok: false,
        code: "unreadable-database",
        message: "project state/ledger.db cannot be read as a SQLite ledger",
      };
    } finally {
      db?.close();
    }
  }
}

function openStrictReadOnlyDatabase(dbPath: string): Database {
  const dbUrl = pathToFileURL(dbPath);
  dbUrl.searchParams.set("mode", "ro");
  dbUrl.searchParams.set("immutable", "1");
  const flags =
    sqliteConstants.SQLITE_OPEN_READONLY |
    sqliteConstants.SQLITE_OPEN_URI |
    sqliteConstants.SQLITE_OPEN_NOFOLLOW;
  const db = new Database(dbUrl.href, flags);
  db.exec("PRAGMA query_only = ON");
  return db;
}

function readSnapshot(db: Database): XdgProjectStoreSnapshot {
  const integrityCheck = db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check);
  const foreignKeyViolationCount = db.query("PRAGMA foreign_key_check").all().length;
  const tables = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
  );
  const tableColumns: Record<string, readonly string[]> = {};
  for (const table of Object.keys(REQUIRED_TABLE_COLUMNS)) {
    if (!tables.has(table)) continue;
    tableColumns[table] = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM pragma_table_info(?) ORDER BY cid",
      )
      .all(table)
      .map((row) => row.name);
  }

  let schemaVersion: unknown = null;
  if (hasRequiredColumns(tableColumns, "meta")) {
    schemaVersion = (
      db
        .query<{ value: unknown }, [string]>(
          "SELECT value FROM meta WHERE key = ?",
        )
        .get("schema_version") ?? { value: null }
    ).value;
  }

  let ledgerSchemaRows: XdgProjectStoreSnapshot["ledgerSchemaRows"] = [];
  if (hasRequiredColumns(tableColumns, "ledgers")) {
    ledgerSchemaRows = db
      .query<{ name: string; schemaJson: unknown }, []>(
        "SELECT name, schema_json AS schemaJson FROM ledgers ORDER BY name",
      )
      .all();
  }

  let activeGroup: XdgProjectStoreSnapshot["activeGroup"] = null;
  if (hasRequiredColumns(tableColumns, "groups")) {
    activeGroup = db
      .query<
        { title: unknown; description: unknown },
        [string, string]
      >("SELECT title, description FROM groups WHERE ledger = ? AND id = ?")
      .get(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID);
  }

  let ambientMilestone: XdgProjectStoreSnapshot["ambientMilestone"] = null;
  if (hasRequiredColumns(tableColumns, "items")) {
    ambientMilestone = db
      .query<
        { milestoneId: unknown; status: unknown; fieldsJson: unknown },
        [string, string]
      >(
        `SELECT milestone_id AS milestoneId, status, fields_json AS fieldsJson
         FROM items WHERE ledger = ? AND id = ?`,
      )
      .get(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID);
  }

  let identity: XdgProjectIdentity | null = null;
  if (hasRequiredColumns(tableColumns, "meta")) {
    identity = new SqliteXdgProjectIdentityAccess(db).readProjectIdentity();
  }

  let substantiveRowCount = 0;
  if (Object.keys(REQUIRED_TABLE_COLUMNS).every((table) => hasRequiredColumns(tableColumns, table))) {
    const row = db
      .query<{ count: number }, [string, string, string, string]>(
        `SELECT
           (SELECT count(*) FROM groups WHERE NOT (ledger = ? AND id = ?)) +
           (SELECT count(*) FROM items WHERE NOT (ledger = ? AND id = ?)) +
           (SELECT count(*) FROM archive_pointers) +
           (SELECT count(*) FROM archived_items) AS count`,
      )
      .get(
        MILESTONES_LEDGER,
        MILESTONES_ACTIVE_GROUP_ID,
        MILESTONES_LEDGER,
        MILESTONES_AMBIENT_ID,
      )!;
    substantiveRowCount = row.count;
  }

  return {
    integrityCheck,
    foreignKeyViolationCount,
    tableColumns,
    schemaVersion,
    ledgerSchemaRows,
    activeGroup,
    ambientMilestone,
    identity,
    substantiveRowCount,
  };
}

function validateSnapshot(
  key: string,
  snapshot: XdgProjectStoreSnapshot,
): XdgProjectCatalogDiagnostic | null {
  if (
    snapshot.integrityCheck.length !== 1 ||
    snapshot.integrityCheck[0] !== "ok"
  ) {
    return errorDiagnostic(
      key,
      "integrity-check-failed",
      "SQLite PRAGMA integrity_check did not return exactly one ok row",
    );
  }
  if (snapshot.foreignKeyViolationCount !== 0) {
    return errorDiagnostic(
      key,
      "foreign-key-check-failed",
      "SQLite PRAGMA foreign_key_check reported violations",
    );
  }

  const missingTables = Object.keys(REQUIRED_TABLE_COLUMNS)
    .filter((table) => snapshot.tableColumns[table] === undefined)
    .sort(compareStrings);
  if (missingTables.length > 0) {
    return errorDiagnostic(
      key,
      "missing-table",
      `ledger database is missing required table(s): ${missingTables.join(", ")}`,
    );
  }

  const missingColumns: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const actualColumns = new Set(snapshot.tableColumns[table]);
    for (const column of requiredColumns) {
      if (!actualColumns.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  missingColumns.sort(compareStrings);
  if (missingColumns.length > 0) {
    return errorDiagnostic(
      key,
      "missing-column",
      `ledger database is missing required column(s): ${missingColumns.join(", ")}`,
    );
  }

  if (snapshot.schemaVersion === null || snapshot.schemaVersion === undefined) {
    return errorDiagnostic(
      key,
      "missing-schema-version",
      "ledger database has no meta.schema_version row",
    );
  }
  if (
    typeof snapshot.schemaVersion !== "number" ||
    !Number.isInteger(snapshot.schemaVersion)
  ) {
    return errorDiagnostic(
      key,
      "malformed-schema-version",
      "ledger database meta.schema_version must be an integer",
    );
  }
  if (
    snapshot.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION ||
    snapshot.schemaVersion > SCHEMA_VERSION
  ) {
    return errorDiagnostic(
      key,
      "unsupported-schema-version",
      `ledger database schema version ${snapshot.schemaVersion} is unsupported`,
    );
  }

  const canonicalRows = new Map<string, unknown[]>();
  for (const row of snapshot.ledgerSchemaRows) {
    const rows = canonicalRows.get(row.name);
    if (rows === undefined) canonicalRows.set(row.name, [row.schemaJson]);
    else rows.push(row.schemaJson);
  }
  const missingCanonical = CANONICAL_LEDGERS.map((entry) => entry.name)
    .filter((name) => !canonicalRows.has(name))
    .sort(compareStrings);
  if (missingCanonical.length > 0) {
    return errorDiagnostic(
      key,
      "missing-canonical-ledger",
      `ledger database is missing canonical ledger row(s): ${missingCanonical.join(", ")}`,
    );
  }
  const duplicateCanonical = CANONICAL_LEDGERS.map((entry) => entry.name)
    .filter((name) => (canonicalRows.get(name)?.length ?? 0) > 1)
    .sort(compareStrings);
  if (duplicateCanonical.length > 0) {
    return errorDiagnostic(
      key,
      "duplicate-canonical-ledger",
      `ledger database has duplicate canonical ledger row(s): ${duplicateCanonical.join(", ")}`,
    );
  }

  for (const canonical of CANONICAL_LEDGERS) {
    const persisted = parsePersistedSchema(
      canonicalRows.get(canonical.name)?.[0],
    );
    if (persisted === null) {
      return errorDiagnostic(
        key,
        "malformed-canonical-schema",
        `canonical ledger ${canonical.name} has malformed schema_json`,
      );
    }
    if (
      !schemasEqual(persisted, canonical.schema) &&
      !schemaCompatible(persisted, canonical.schema)
    ) {
      return errorDiagnostic(
        key,
        "divergent-canonical-schema",
        `canonical ledger ${canonical.name} has a divergent schema_json`,
      );
    }
  }

  if (!validBootstrapState(snapshot)) {
    return errorDiagnostic(
      key,
      "invalid-bootstrap-state",
      "ledger database lacks a valid active group and M-AMBIENT bootstrap milestone",
    );
  }
  if (
    !Number.isSafeInteger(snapshot.substantiveRowCount) ||
    snapshot.substantiveRowCount < 0
  ) {
    return errorDiagnostic(
      key,
      "invalid-bootstrap-state",
      "ledger database returned an invalid substantive row count",
    );
  }
  return null;
}

function validBootstrapState(snapshot: XdgProjectStoreSnapshot): boolean {
  if (
    snapshot.activeGroup === null ||
    snapshot.activeGroup.title !== MILESTONES_ACTIVE_GROUP_TITLE ||
    typeof snapshot.activeGroup.description !== "string"
  ) {
    return false;
  }
  const ambient = snapshot.ambientMilestone;
  if (
    ambient === null ||
    ambient.milestoneId !== MILESTONES_ACTIVE_GROUP_ID ||
    typeof ambient.status !== "string" ||
    !MILESTONES_SCHEMA.statusValues.includes(ambient.status) ||
    MILESTONES_SCHEMA.terminalStatuses.includes(ambient.status) ||
    typeof ambient.fieldsJson !== "string"
  ) {
    return false;
  }
  try {
    const fields = JSON.parse(ambient.fieldsJson) as unknown;
    return (
      isRecord(fields) &&
      typeof fields["title"] === "string" &&
      fields["title"].trim() !== ""
    );
  } catch {
    return false;
  }
}

function parsePersistedSchema(raw: unknown): LedgerSchema | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isLedgerSchema(parsed)) return null;
    validateSchema(parsed);
    return parsed;
  } catch {
    return null;
  }
}

function isLedgerSchema(value: unknown): value is LedgerSchema {
  if (!isRecord(value)) return false;
  if (!isStringArray(value["statusValues"])) return false;
  if (!isStringArray(value["terminalStatuses"])) return false;
  if (
    value["satisfiesDependencyStatuses"] !== undefined &&
    !isStringArray(value["satisfiesDependencyStatuses"])
  ) {
    return false;
  }
  if (value["idPrefix"] !== undefined && typeof value["idPrefix"] !== "string") {
    return false;
  }
  const fields = value["fields"];
  if (!isRecord(fields)) return false;
  for (const field of Object.values(fields)) {
    if (
      !isRecord(field) ||
      typeof field["type"] !== "string" ||
      typeof field["required"] !== "boolean"
    ) {
      return false;
    }
  }
  const transitions = value["transitions"];
  if (transitions !== undefined) {
    if (!isRecord(transitions)) return false;
    if (!Object.values(transitions).every(isStringArray)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasRequiredColumns(
  tableColumns: Readonly<Record<string, readonly string[]>>,
  table: string,
): boolean {
  const columns = tableColumns[table];
  if (columns === undefined) return false;
  const actual = new Set(columns);
  return REQUIRED_TABLE_COLUMNS[table]!.every((column) => actual.has(column));
}

function fallbackDisplayName(key: string): string {
  return SHA1_PROJECT_KEY_RE.test(key) ? key.slice(0, SHA1_FALLBACK_LENGTH) : key;
}

function errorDiagnostic(
  key: string,
  code: Exclude<XdgProjectCatalogDiagnosticCode, "missing-project-identity">,
  message: string,
): XdgProjectCatalogDiagnostic {
  return { key, severity: "error", code, message };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type PathInspection =
  | { readonly status: "ok"; readonly info: Awaited<ReturnType<typeof lstat>> }
  | { readonly status: "missing" }
  | { readonly status: "unreadable" };

async function inspectPath(target: string): Promise<PathInspection> {
  try {
    return { status: "ok", info: await lstat(target) };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { status: "missing" };
    }
    return { status: "unreadable" };
  }
}
