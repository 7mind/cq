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
import type { LedgerPersistence } from "./LedgerPersistence.js";
import type { LedgerRegistry } from "../types.js";
import { LedgerError } from "../types.js";
import { CANONICAL_LEDGERS } from "../constants.js";
import { atomicWrite } from "./fsAtomic.js";

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
  /**
   * Returns the store's CURRENT in-memory registry (for divergence backup).
   * Bound by the owning store AFTER its `super()` call via
   * {@link bindRegistrySnapshot}, because the registry lives in the base and a
   * subclass cannot reference `this` before `super()` to capture it at
   * construction time.
   */
  private registrySnapshot: () => LedgerRegistry = () => ({ version: 1, ledgers: [] });

  constructor(opts: { layout: FsPersistenceLayout; now: () => string }) {
    this.root = opts.layout.root;
    this.docsDir = opts.layout.docsDir;
    this.archiveDir = opts.layout.archiveDir;
    this.registryPath = opts.layout.registryPath;
    this.now = opts.now;
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
    await atomicWrite(this.ledgerPath(name), text);
  }

  async writeRegistrySource(text: string): Promise<void> {
    await atomicWrite(this.registryPath, text);
  }

  async readArchive(locator: string): Promise<string> {
    return fs.readFile(this.resolveArchive(locator), "utf8");
  }

  async writeArchive(locator: string, text: string): Promise<void> {
    const abs = this.resolveArchive(locator);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, text);
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
    ];
    for (const src of filesToBackup) {
      const dest = path.join(backupDir, path.basename(src));
      try {
        await fs.copyFile(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

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

  async currentSourceToken(name: string): Promise<string> {
    const stat = await fs.stat(this.ledgerPath(name));
    return String(stat.mtimeMs);
  }
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
