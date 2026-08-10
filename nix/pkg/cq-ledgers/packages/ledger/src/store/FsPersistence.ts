/**
 * FsPersistence — the filesystem implementation of the {@link LedgerPersistence}
 * byte-I/O seam (G43 / Q190).
 *
 * It owns ONLY concern (2) from {@link LedgerPersistence}'s doc comment: the
 * `fs.*` / `atomicWrite` calls that read and write the raw `string` source of
 * the registry, each ledger `.md`, each archive file, plus the schema-divergence
 * BACKUP action. The shared in-memory machinery (the map, parse/serialize, FTS,
 * the mutex, the lockfile, schema-divergence DETECTION) lives in
 * {@link AbstractLedgerStore}, which talks to this seam.
 *
 * Layout under `root` (typically the server's --cwd):
 *   ./.cq/ledgers.yaml                              # central registry
 *   ./.cq/<ledger>.md                               # active ledger
 *   ./.cq/archive/<ledger>/<milestone-id>.md        # archived group (or item, for milestones ledger)
 *   ./.cq/.backup/<ts>/                             # divergence snapshot
 *
 * ## Archive locator convention
 *
 * `readArchive` / `writeArchive` / `removeArchive` / `currentSourceToken` and the
 * archive-locator passed by the base are paths RELATIVE to `docsDir` (e.g.
 * `./archive/<ledger>/<id>.md`) — exactly the `ArchivePointer.path` the store
 * already stores. The seam resolves them against `docsDir` and enforces the
 * storage-root containment check (`assertWithinDocsRoot`, D-LED-01) so a crafted
 * pointer cannot escape the storage root.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ArchivePersistenceCommit,
  LedgerPersistence,
  PlanLifecyclePersistenceCommit,
} from "./LedgerPersistence.js";
import type { LedgerRegistry } from "../types.js";
import { LedgerError } from "../types.js";
import { CANONICAL_LEDGERS } from "../constants.js";
import { atomicWrite } from "./fsAtomic.js";
import {
  ARCHIVE_COMMIT_PENDING_FILENAME,
  LEDGER_WORKSET_DIRNAME,
  PLAN_LIFECYCLE_PENDING_FILENAME,
  PLAN_LIFECYCLE_STATE_FILENAME,
  WORKSET_ROOTS_FILENAME,
} from "./ledgerArtifacts.js";
import {
  parseWorksetRootsDocument,
  serializeWorksetRootsDocument,
} from "../worksetStoreGit.js";

/**
 * Layout the {@link FsPersistence} seam binds to. Resolved once by the store so
 * the seam can map a ledger / registry / archive id to its absolute source file.
 * All paths are absolute.
 */
export interface FsPersistenceLayout {
  /** Absolute store root (the server --cwd). */
  readonly root: string;
  /** Absolute `<root>/.cq` directory. */
  readonly docsDir: string;
  /** Absolute `<root>/.cq/archive` directory. */
  readonly archiveDir: string;
  /** Absolute `<root>/.cq/ledgers.yaml` registry path. */
  readonly registryPath: string;
}

/**
 * Filesystem-backed {@link LedgerPersistence}. Constructed with the resolved
 * layout plus a `registrySnapshot` callback the shared base uses to hand the
 * seam the CURRENT in-memory registry at `backupCanonicalState()` time (the
 * backup must enumerate the registry's non-canonical ledgers to copy + unlink
 * their files; that registry lives in the base, not the seam).
 */
export class FsPersistence implements LedgerPersistence {
  private readonly root: string;
  private readonly docsDir: string;
  private readonly archiveDir: string;
  private readonly registryPath: string;
  private readonly now: () => string;
  private readonly planStatePath: string;
  private readonly planPendingPath: string;
  private readonly archivePendingPath: string;
  private readonly writeAtomic: (filePath: string, text: string) => Promise<void>;
  /**
   * Returns the store's CURRENT in-memory registry (for divergence backup).
   * Bound by the owning store AFTER its `super()` call via
   * {@link bindRegistrySnapshot}, because the registry lives in the base and a
   * subclass cannot reference `this` before `super()` to capture it at
   * construction time.
   */
  private registrySnapshot: () => LedgerRegistry = () => ({ version: 1, ledgers: [] });

  constructor(opts: {
    layout: FsPersistenceLayout;
    now: () => string;
    atomicWrite?: (filePath: string, text: string) => Promise<void>;
  }) {
    this.root = opts.layout.root;
    this.docsDir = opts.layout.docsDir;
    this.archiveDir = opts.layout.archiveDir;
    this.registryPath = opts.layout.registryPath;
    this.now = opts.now;
    this.writeAtomic = opts.atomicWrite ?? atomicWrite;
    this.planStatePath = path.join(this.docsDir, PLAN_LIFECYCLE_STATE_FILENAME);
    this.planPendingPath = path.join(this.docsDir, PLAN_LIFECYCLE_PENDING_FILENAME);
    this.archivePendingPath = path.join(this.docsDir, ARCHIVE_COMMIT_PENDING_FILENAME);
  }

  async hasPendingArchiveCommit(): Promise<boolean> {
    try {
      await fs.stat(this.archivePendingPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async recoverArchiveCommit(): Promise<void> {
    const pending = await readMaybe(this.archivePendingPath);
    if (pending === null) return;
    await this.restoreArchivePreState(parseArchiveRollback(pending));
    await fs.rm(this.archivePendingPath, { force: true });
  }

  async commitArchive(commit: ArchivePersistenceCommit): Promise<void> {
    const rollback = await this.captureArchivePreState(commit);
    await this.writeAtomic(this.archivePendingPath, JSON.stringify(rollback));
    try {
      for (const [locator, source] of Object.entries(commit.archives)) {
        const archivePath = this.resolveArchive(locator);
        if (source === null) {
          await fs.rm(archivePath, { force: true });
          continue;
        }
        await fs.mkdir(path.dirname(archivePath), { recursive: true });
        await this.writeAtomic(archivePath, source);
      }
      for (const [name, source] of Object.entries(commit.ledgers)) {
        await this.writeAtomic(this.ledgerPath(name), source);
      }
    } catch (error) {
      try {
        await this.restoreArchivePreState(rollback);
        await fs.rm(this.archivePendingPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "archive commit failed and its pre-state rollback did not complete",
        );
      }
      throw error;
    }
    await fs.rm(this.archivePendingPath, { force: true });
  }

  private async captureArchivePreState(
    commit: ArchivePersistenceCommit,
  ): Promise<ArchiveRollback> {
    const archives: Record<string, string | null> = {};
    const ledgers: Record<string, string | null> = {};
    for (const locator of Object.keys(commit.archives)) {
      archives[locator] = await readMaybe(this.resolveArchive(locator));
    }
    for (const name of Object.keys(commit.ledgers)) {
      ledgers[name] = await readMaybe(this.ledgerPath(name));
    }
    return { version: 1, archives, ledgers };
  }

  private async restoreArchivePreState(rollback: ArchiveRollback): Promise<void> {
    for (const [locator, source] of Object.entries(rollback.archives)) {
      await this.restoreSource(this.resolveArchive(locator), source);
    }
    for (const [name, source] of Object.entries(rollback.ledgers)) {
      await this.restoreSource(this.ledgerPath(name), source);
    }
  }

  private async restoreSource(filePath: string, source: string | null): Promise<void> {
    if (source === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await this.writeAtomic(filePath, source);
  }

  async hasPendingPlanLifecycleCommit(): Promise<boolean> {
    try {
      await fs.stat(this.planPendingPath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  async recoverPlanLifecycleCommit(): Promise<void> {
    const pending = await readMaybe(this.planPendingPath);
    if (pending === null) return;
    await this.restorePlanLifecyclePreState(parsePlanLifecycleRollback(pending));
    await fs.rm(this.planPendingPath, { force: true });
  }

  async readPlanLifecycleState(): Promise<string | null> {
    return readMaybe(this.planStatePath);
  }

  async commitPlanLifecycle(commit: PlanLifecyclePersistenceCommit): Promise<void> {
    const rollback = await this.capturePlanLifecyclePreState(commit);
    await this.writeAtomic(this.planPendingPath, JSON.stringify(rollback));
    try {
      await this.applyPlanLifecycleCommit(commit);
      await fs.rm(this.planPendingPath, { force: true });
    } catch (error) {
      try {
        await this.restorePlanLifecyclePreState(rollback);
        await fs.rm(this.planPendingPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "plan lifecycle commit failed and its pre-state rollback did not complete",
        );
      }
      throw error;
    }
  }

  private async capturePlanLifecyclePreState(
    commit: PlanLifecyclePersistenceCommit,
  ): Promise<PlanLifecycleRollback> {
    const ledgers: Record<string, string | null> = {};
    for (const name of Object.keys(commit.ledgers)) {
      ledgers[name] = await readMaybe(this.ledgerPath(name));
    }
    return {
      version: 1,
      state: await readMaybe(this.planStatePath),
      ledgers,
    };
  }

  private async restorePlanLifecyclePreState(
    rollback: PlanLifecycleRollback,
  ): Promise<void> {
    for (const [name, source] of Object.entries(rollback.ledgers)) {
      await this.restoreSource(this.ledgerPath(name), source);
    }
    await this.restoreSource(this.planStatePath, rollback.state);
  }

  private async applyPlanLifecycleCommit(commit: PlanLifecyclePersistenceCommit): Promise<void> {
    for (const [name, source] of Object.entries(commit.ledgers)) {
      await this.writeAtomic(this.ledgerPath(name), source);
    }
    await this.writeAtomic(this.planStatePath, commit.state);
  }

  /**
   * Bind the accessor the divergence-backup uses to read the owning store's
   * CURRENT in-memory registry. Called once by the store after `super()`.
   */
  bindRegistrySnapshot(snapshot: () => LedgerRegistry): void {
    this.registrySnapshot = snapshot;
  }

  private ledgerPath(name: string): string {
    return path.join(this.docsDir, `${name}.md`);
  }

  /**
   * Defense-in-depth (D-LED-01): after resolving an archive locator that
   * incorporates caller-supplied data (a milestone id, an archive-pointer
   * path), refuse to read or write if the result is not inside `docsDir`.
   */
  private resolveArchive(locator: string): string {
    const abs = path.resolve(this.docsDir, locator);
    if (abs !== this.docsDir && !abs.startsWith(this.docsDir + path.sep)) {
      throw new LedgerError(`archive path escapes docs root: ${abs}`);
    }
    return abs;
  }

  async readLedgerSource(name: string): Promise<string | null> {
    return readMaybe(this.ledgerPath(name));
  }

  async readRegistrySource(): Promise<string | null> {
    return readMaybe(this.registryPath);
  }

  async writeLedgerSource(name: string, text: string): Promise<void> {
    await this.writeAtomic(this.ledgerPath(name), text);
  }

  async writeRegistrySource(text: string): Promise<void> {
    await this.writeAtomic(this.registryPath, text);
  }

  async readArchive(locator: string): Promise<string> {
    return fs.readFile(this.resolveArchive(locator), "utf8");
  }

  async writeArchive(locator: string, text: string): Promise<void> {
    const abs = this.resolveArchive(locator);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.writeAtomic(abs, text);
  }

  async removeArchive(locator: string): Promise<void> {
    await fs.rm(this.resolveArchive(locator), { force: true });
  }

  async readArchiveDir(name: string): Promise<string[]> {
    const dir = path.join(this.archiveDir, name);
    try {
      return await fs.readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Back up the divergent on-disk state to `.cq/.backup/<sanitized-ISO>/` and
   * return the absolute backup dir. Mirrors the byte-I/O prologue of the old
   * `FsLedgerStore.backupAndReinit()`: copy `ledgers.yaml` + each canonical and
   * non-canonical ledger file (ENOENT tolerated), then unlink the non-canonical
   * files so no orphan `.cq/<name>.md` survives the reinit. The DETECTION and
   * the subsequent fresh writes stay in the base.
   */
  async backupCanonicalState(): Promise<string> {
    const ts = this.now().replace(/:/g, "-");
    const backupDir = path.join(this.docsDir, ".backup", ts);
    await fs.mkdir(backupDir, { recursive: true });

    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    const nonCanonicalNames = this.registrySnapshot()
      .ledgers.map((e) => e.name)
      .filter((n) => !canonicalNames.has(n));

    const filesToBackup: string[] = [
      this.registryPath,
      ...CANONICAL_LEDGERS.map((c) => this.ledgerPath(c.name)),
      ...nonCanonicalNames.map((n) => this.ledgerPath(n)),
      // D142: durable plan-lifecycle verifier/replay state, plus any pending
      // recovery marker so a divergence snapshot preserves the full fence.
      this.planStatePath,
      this.planPendingPath,
    ];
    for (const src of filesToBackup) {
      const dest = path.join(backupDir, path.basename(src));
      try {
        await fs.copyFile(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    // T1959: capture FS workset roots into the portable dump name so divergence
    // / reset backups retain ordered roots + epoch even though live state sits
    // under `.cq/workset/roots.json`.
    await this.backupWorksetRoots(backupDir);

    // Remove non-canonical ledger files so they don't survive as orphans.
    for (const name of nonCanonicalNames) {
      try {
        await fs.unlink(this.ledgerPath(name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return backupDir;
  }

  /**
   * Copy live FS workset roots into `backupDir/workset-roots.json` (portable
   * dump name). Missing live state is a no-op (unrestricted empty is implicit).
   */
  private async backupWorksetRoots(backupDir: string): Promise<void> {
    const livePath = path.join(this.docsDir, LEDGER_WORKSET_DIRNAME, "roots.json");
    let text: string;
    try {
      text = await fs.readFile(livePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    // The portable parser accepts the live document's additive admitGeneration
    // field while rejecting malformed roots instead of silently dropping them.
    const snap = parseWorksetRootsDocument(text);
    await fs.writeFile(
      path.join(backupDir, WORKSET_ROOTS_FILENAME),
      serializeWorksetRootsDocument(snap),
      "utf8",
    );
  }

  async currentSourceToken(name: string): Promise<string> {
    const stat = await fs.stat(this.ledgerPath(name));
    return String(stat.mtimeMs);
  }
}

interface ArchiveRollback {
  readonly version: 1;
  readonly archives: Readonly<Record<string, string | null>>;
  readonly ledgers: Readonly<Record<string, string | null>>;
}

function parseArchiveRollback(text: string): ArchiveRollback {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError("invalid pending archive commit");
  }
  if (typeof value !== "object" || value === null) {
    throw new LedgerError("invalid pending archive commit");
  }
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    !isNullableStringRecord(record["archives"]) ||
    !isLedgerSourceRecord(record["ledgers"])
  ) {
    throw new LedgerError("invalid pending archive commit");
  }
  return {
    version: 1,
    archives: record["archives"],
    ledgers: record["ledgers"],
  };
}

function isLedgerSourceRecord(
  value: unknown,
): value is Readonly<Record<string, string | null>> {
  return (
    isNullableStringRecord(value) &&
    Object.keys(value).every((name) => /^[a-z][a-z0-9-]*$/.test(name))
  );
}

function isNullableStringRecord(
  value: unknown,
): value is Readonly<Record<string, string | null>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => entry === null || typeof entry === "string")
  );
}

interface PlanLifecycleRollback {
  readonly version: 1;
  readonly state: string | null;
  readonly ledgers: Readonly<Record<string, string | null>>;
}

function parsePlanLifecycleRollback(text: string): PlanLifecycleRollback {
  // A truncated pending marker (the exact artifact an interrupted writer can
  // leave) must surface as a LedgerError like every malformed-shape branch
  // below, not a raw SyntaxError out of init().
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError("invalid pending plan lifecycle commit");
  }
  if (typeof value !== "object" || value === null) {
    throw new LedgerError("invalid pending plan lifecycle commit");
  }
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    (record["state"] !== null && typeof record["state"] !== "string") ||
    !isLedgerSourceRecord(record["ledgers"])
  ) {
    throw new LedgerError("invalid pending plan lifecycle commit");
  }
  const ledgers: Record<string, string | null> = {};
  for (const [name, source] of Object.entries(record["ledgers"])) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LedgerError("invalid pending plan lifecycle ledger source");
    }
    ledgers[name] = source;
  }
  return { version: 1, state: record["state"], ledgers };
}

/** Read a UTF-8 file, mapping ENOENT to `null`. */
async function readMaybe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
