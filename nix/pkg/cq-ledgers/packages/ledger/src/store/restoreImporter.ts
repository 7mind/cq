/**
 * restoreImporter — the explicit one-way import from a backup dump (T503 /
 * Q244), the READ-side counterpart of {@link buildBackupDump} (T502).
 *
 * Reads a dump written by the backup exporter — either an in-tree `.cq/`
 * directory or an orphan-branch ref, the SAME two shapes {@link
 * exportBackupInTree} / {@link exportBackupOrphanBranch} produce — via the
 * EXISTING parsers (`parseRegistry`/`parseLedger`/`parseArchive`/
 * `parseMilestoneItemArchive`, the inverse of the serializers T502 reused),
 * and writes the parsed state into the out-of-tree xdg primary (the SQLite
 * rows `SqliteLedgerStore` reads) — INCLUDING the dump's `.cq/logs/**`
 * artifacts, imported into the primary logs area so `read_log` serves them
 * again.
 *
 * This is DISASTER RECOVERY, not sync: there is no merge semantics. The
 * primary is WIPED and REPLACED wholesale by the dump's content. Row writes go
 * DIRECTLY through `bun:sqlite` (bypassing `SqliteLedgerStore`'s public
 * mutation API) so every id, counter, timestamp, and author/session is
 * preserved EXACTLY as it was at export time — `createItem`/`updateItem` would
 * regenerate ids and stamp `now()`, which would break restore's fetch_item
 * parity contract.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ArchiveContent, LedgerStore } from "./LedgerStore.js";
import type { FieldValue, Ledger, LedgerRegistry } from "../types.js";
import { LedgerError } from "../types.js";
import { parseArchive, parseLedger, parseMilestoneItemArchive } from "../parser/parse.js";
import { parseRegistry } from "../registry.js";
import {
  CANONICAL_LEDGERS,
  LEDGER_LOGS_DIRNAME,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../constants.js";
import { ledgerTreePaths } from "./ledgerArtifacts.js";
import { GitPlumbing } from "./git/GitPlumbing.js";
import type { BackupDumpFile } from "./backupExporter.js";
import { openLedgerDb, immediateWriteTransaction } from "./sqlite/connection.js";
import { ensureSchema } from "./sqlite/schema.js";
import { buildPrefixRegistry, normalizeStoredRefFields } from "../refs.js";

/** Result of {@link restoreDumpToXdg}: counts for CLI reporting. */
export interface RestoreSummary {
  /** Number of dump files read (ledgers + registry + archives + logs). */
  fileCount: number;
  /** Number of ledgers restored (rows written to the `ledgers` table). */
  ledgerCount: number;
  /** Number of log artifacts imported into the primary logs area. */
  logCount: number;
}

/**
 * Read a dump from an in-tree `.cq/` directory at `root`, as a
 * {@link BackupDumpFile}[] relative to `.cq/` — the exact inverse of {@link
 * exportBackupInTree}. Reuses `ledgerTreePaths` (the single source of truth
 * for "which files under `.cq/` belong to the ledger", shared with `cq erase`)
 * so restore agrees with every other consumer on the set
 * of files a dump carries.
 */
export async function readDumpInTree(root: string): Promise<BackupDumpFile[]> {
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const rels = await ledgerTreePaths(docsDir);
  const files: BackupDumpFile[] = [];
  for (const rel of rels) {
    const content = await fs.readFile(path.join(docsDir, rel), "utf8");
    files.push({ path: rel, content });
  }
  return files;
}

/**
 * Read a dump from the orphan ref `refs/heads/<branch>` at `root`, as a
 * {@link BackupDumpFile}[] relative to `.cq/` — the exact inverse of {@link
 * exportBackupOrphanBranch} (whose tree is rooted at `.cq/…`, so every entry's
 * path is stripped of that prefix here). Reads via `git ls-tree` / `git
 * cat-file` — no checkout, no working-tree touch.
 */
export async function readDumpOrphanBranch(
  root: string,
  branch: string,
): Promise<BackupDumpFile[]> {
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
  const sha = await git.readRef(ref);
  if (sha === null) {
    throw new LedgerError(
      `restore: the orphan ref ${ref} does not exist at ${root} — nothing to restore from`,
    );
  }
  const prefix = `${LEDGER_STORAGE_DIRNAME}/`;
  const paths = (await git.lsTree(ref)).filter((p) => p.startsWith(prefix));
  const files: BackupDumpFile[] = [];
  for (const p of paths) {
    const content = await git.catFile(ref, p);
    files.push({ path: p.slice(prefix.length), content });
  }
  return files;
}

/**
 * The dump, fully parsed via the existing parsers — ready to write to a
 * store. Exported (T580) so {@link restoreDumpToPostgres} (the postgres
 * analogue of {@link restoreDumpToXdg}) reuses the SAME parse step rather
 * than duplicating it.
 */
export interface ParsedDump {
  registry: LedgerRegistry;
  ledgers: Map<string, Ledger>;
  archives: Map<string, Map<string, ArchiveContent>>;
  /** Dump-relative log files (`logs/<rel>`), byte-identical to the export. */
  logs: BackupDumpFile[];
}

/**
 * Parse a dump's flat file set into structured ledgers + archive contents,
 * via `parseRegistry`/`parseLedger`/`parseArchive`/`parseMilestoneItemArchive`
 * — the inverse of `buildBackupDump`'s `serializeRegistry`/`serializeLedger`/
 * `serializeArchive`/`serializeMilestoneItemArchive`. Throws {@link
 * LedgerError} on a structurally incomplete dump (missing `ledgers.yaml`, a
 * registered ledger's `.md`, or an archive pointer's target file) — restore
 * must fail loud on a corrupt/partial dump rather than silently drop state.
 *
 * Exported (T580): the store-neutral parse step shared by BOTH
 * {@link restoreDumpToXdg} (sqlite) and `restoreDumpToPostgres`
 * (postgres/restoreImporter.ts).
 */
export function parseBackupDump(dump: readonly BackupDumpFile[]): ParsedDump {
  const byPath = new Map(dump.map((f) => [f.path, f.content] as const));

  const registrySrc = byPath.get("ledgers.yaml");
  if (registrySrc === undefined) {
    throw new LedgerError("restore: dump is missing ledgers.yaml");
  }
  const registry = parseRegistry(registrySrc);

  const ledgers = new Map<string, Ledger>();
  const archives = new Map<string, Map<string, ArchiveContent>>();

  for (const entry of registry.ledgers) {
    const ledgerSrc = byPath.get(`${entry.name}.md`);
    if (ledgerSrc === undefined) {
      throw new LedgerError(`restore: dump is missing ${entry.name}.md`);
    }
    const isMilestonesLedger = entry.name === MILESTONES_LEDGER;
    const ledger = parseLedger(ledgerSrc, { schema: entry.schema, isMilestonesLedger });
    ledgers.set(entry.name, ledger);

    const archiveMap = new Map<string, ArchiveContent>();
    for (const pointer of ledger.archivePointers) {
      const archivePath = pointer.path.replace(/^\.\//, "");
      const archiveSrc = byPath.get(archivePath);
      if (archiveSrc === undefined) {
        throw new LedgerError(`restore: dump is missing archive file ${archivePath}`);
      }
      archiveMap.set(
        pointer.id,
        isMilestonesLedger
          ? { kind: "item", item: parseMilestoneItemArchive(archiveSrc) }
          : { kind: "group", milestone: parseArchive(archiveSrc) },
      );
    }
    archives.set(entry.name, archiveMap);
  }

  const logsPrefix = `${LEDGER_LOGS_DIRNAME}/`;
  const logs = dump.filter((f) => f.path.startsWith(logsPrefix));

  return { registry, ledgers, archives, logs };
}

/**
 * Write a parsed dump's rows DIRECTLY to the xdg primary's SQLite database at
 * `dbPath`, wiping every existing row first (disaster recovery — no merge),
 * then import the dump's log artifacts into `logsDir` (when given). Bypasses
 * `SqliteLedgerStore`'s public mutation API so ids/counters/timestamps/
 * author/session are preserved EXACTLY (mirrors the row shapes
 * `SqliteLedgerStore.bootstrapCanonicalRows`/`archiveMilestone` write).
 *
 * `archived_at` (the archive_pointers column) is never read back by any
 * public store surface (`ArchivePointer` and `ArchiveContent` both omit it) —
 * restore stamps it with the restore wall-clock time rather than
 * reconstructing an unrecoverable original value.
 */
export async function restoreDumpToXdg(opts: {
  dbPath: string;
  logsDir: string | null;
  dump: readonly BackupDumpFile[];
}): Promise<RestoreSummary> {
  const parsed = parseBackupDump(opts.dump);
  const restoredAt = new Date().toISOString();

  const db = openLedgerDb(opts.dbPath);
  try {
    ensureSchema(db);
    immediateWriteTransaction(db, () => {
      db.exec("DELETE FROM archived_items");
      db.exec("DELETE FROM archive_pointers");
      db.exec("DELETE FROM items");
      db.exec("DELETE FROM groups");
      db.exec("DELETE FROM ledgers");

      const insertLedger = db.query(
        "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, ?, ?)",
      );
      const insertGroup = db.query(
        "INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, ?)",
      );
      const insertItem = db.query(
        `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertPointer = db.query(
        "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertArchivedItem = db.query(
        `INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // G80/M245 (T553): normalize dependsOn/blockedBy to the canonical
      // `<ledger>:<id>` form as rows are (re-)inserted, so importing an OLD
      // (pre-grammar) backup with bare refs lands normalized — matching the
      // v1→v2 on-open migration's output for the same data. The removed legacy
      // fs/git-object primaries re-enter the xdg primary ONLY via `cq restore`
      // / `cq migrate` (which builds a dump then calls this), so THIS path is
      // what carries the git-object rollback ref forward normalized too. The
      // registry spans the dump's full ledger set (canonical + custom), the
      // same shape the writers' prefix registry uses.
      const refRegistry = buildPrefixRegistry(
        [...parsed.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
      );
      const normalizeFieldsJson = (item: { fields: Record<string, FieldValue> }): string =>
        JSON.stringify(normalizeStoredRefFields(item.fields, refRegistry).fields);

      for (const [name, ledger] of parsed.ledgers) {
        insertLedger.run(
          name,
          JSON.stringify(ledger.schema),
          ledger.counters.milestone,
          ledger.counters.item,
        );
        for (const group of ledger.milestones) {
          insertGroup.run(name, group.id, group.title, group.description);
          for (const item of group.items) {
            insertItem.run(
              name,
              item.id,
              item.milestoneId,
              item.status,
              normalizeFieldsJson(item),
              item.createdAt,
              item.updatedAt,
              item.author ?? null,
              item.session ?? null,
            );
          }
        }

        const archiveMap = parsed.archives.get(name);
        for (const pointer of ledger.archivePointers) {
          insertPointer.run(name, pointer.id, pointer.summary, pointer.title, pointer.status, restoredAt);
          const content = archiveMap?.get(pointer.id);
          const items = content === undefined ? [] : content.kind === "item" ? [content.item] : content.milestone.items;
          for (const item of items) {
            insertArchivedItem.run(
              name,
              pointer.id,
              item.id,
              item.milestoneId,
              item.status,
              normalizeFieldsJson(item),
              item.createdAt,
              item.updatedAt,
              item.author ?? null,
              item.session ?? null,
            );
          }
        }
      }
    });
  } finally {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }

  let logCount = 0;
  if (opts.logsDir !== null) {
    const logsPrefix = `${LEDGER_LOGS_DIRNAME}/`;
    for (const f of parsed.logs) {
      const rel = f.path.slice(logsPrefix.length);
      const dest = path.join(opts.logsDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
      logCount += 1;
    }
  }

  return { fileCount: opts.dump.length, ledgerCount: parsed.ledgers.size, logCount };
}

/**
 * True iff the xdg primary `store` currently holds nothing but the canonical
 * bootstrap state (every canonical ledger, no custom ledgers, no archives,
 * and — for the `milestones` ledger — nothing beyond the single `## active`
 * group holding only the immortal `M-AMBIENT` item). Restore refuses to
 * overwrite a NON-empty primary without `--yes` (the shared destructive-op
 * confirmation policy); this predicate is the "non-empty" test that gate
 * consults. Backend-agnostic (reads only the public `LedgerStore` surface),
 * even though restore itself only targets the xdg backend.
 */
export function isXdgPrimaryEmpty(store: LedgerStore): boolean {
  const names = store.enumerate();
  if (names.length > CANONICAL_LEDGERS.length) return false;

  for (const name of names) {
    const fetched = store.fetch(name);
    if (fetched.archivePointers.length > 0) return false;

    if (name === MILESTONES_LEDGER) {
      if (fetched.milestones.length !== 1) return false;
      const group = fetched.milestones[0];
      if (group === undefined || group.id !== MILESTONES_ACTIVE_GROUP_ID) return false;
      for (const item of group.items) {
        if (item.id !== MILESTONES_AMBIENT_ID) return false;
      }
    } else if (fetched.milestones.length > 0) {
      return false;
    }
  }
  return true;
}
