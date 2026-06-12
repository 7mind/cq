/**
 * FsLedgerStore — filesystem-backed implementation of `LedgerStore`.
 *
 * It is the {@link AbstractLedgerStore} base (which holds ALL the shared,
 * persistence-agnostic machinery — the in-memory map, parse/serialize, FTS, the
 * mutex, the lockfile critical sections, schema-divergence DETECTION + reinit
 * orchestration, and every read/mutation method) wired to an {@link FsPersistence}
 * byte-I/O seam plus the filesystem-only concerns the base does not own:
 *   - the advisory lockfile root (`docs/.locks`);
 *   - the `~/.cache` mirror (cacheMirror.ts) fired after every mutation;
 *   - the FS-only `read_log` capability (T147 / Q87);
 *   - the operator-facing `reset()` wipe-and-reinit (+ `ResetSummary`);
 *   - the `rootDir` accessor a host binds root-scoped config to.
 *
 * Layout under `root` (typically the server's --cwd):
 *   ./docs/ledgers.yaml                              # central registry
 *   ./docs/<ledger>.md                               # active ledger
 *   ./docs/archive/<ledger>/<milestone-id>.md        # archived group (or item, for milestones ledger)
 *   ./docs/.locks/<ledger>.lock                      # advisory lockfile
 *   ./docs/.locks/__milestones__.lock                # global milestones lock
 *
 * Lock discipline (msunify cycle):
 *   - Per-ledger AsyncMutex + lockfile for within-ledger ops.
 *   - Global `__milestones__` AsyncMutex + lockfile for operations that
 *     mutate the milestones ledger OR create/archive items referencing it.
 *   - Multi-lock acquisition order: `__milestones__` first; then per-ledger
 *     locks in alphabetic order. This contract MUST hold for every
 *     multi-lock path to avoid cyclic deadlock.
 */

import * as path from "node:path";
import type { LedgerStore, OnMutation } from "./LedgerStore.js";
import { MAX_READ_LOG_BYTES, type ReadLogResult } from "../mcp/readLog.js";
import { promises as fs } from "node:fs";
import { LedgerError } from "../types.js";
import { Lockfile, type LockfileOpts } from "./lockfile.js";
import { mirrorMutation } from "./cacheMirror.js";
import {
  CANONICAL_LEDGERS,
  LEDGER_STORAGE_DIRNAME,
  LEDGER_LOGS_STRIP_RE,
  LEDGER_LOGS_RELATIVE_PREFIX,
} from "../constants.js";
import { AbstractLedgerStore, activeItemsOf } from "./AbstractLedgerStore.js";
import { FsPersistence } from "./FsPersistence.js";

/**
 * Result of {@link FsLedgerStore.reset}: the absolute path the prior on-disk
 * state was snapshotted to, plus a per-ledger count of the items that existed
 * BEFORE the wipe — what a CLI prints to confirm what it just backed up.
 */
export interface ResetSummary {
  /** Absolute path of the `docs/.backup/<ts>/` snapshot dir. */
  backupDir: string;
  /** Active item count per active ledger, captured BEFORE the reinit. */
  ledgers: Array<{ name: string; itemCount: number }>;
}

export interface FsLedgerStoreOpts {
  /** Filesystem root (server --cwd). Ledgers live under `<root>/docs/`. */
  root: string;
  /**
   * Returns an ISO 8601 UTC timestamp. Defaults to
   * `() => new Date().toISOString()`.
   */
  now?: () => string;
  /** Lockfile injection points for tests (isPidAlive, selfPid, …). */
  lockfile?: LockfileOpts;
  /**
   * Fired AFTER every successful write — after the lockfile is
   * released and after the in-memory map is updated. Used to broadcast
   * cross-process cache-invalidation notifications via the internal
   * WS channel (D-COHERENCE). MUST NOT block; if the hook throws, the
   * store logs to stderr and continues so write effects survive.
   *
   * Fired for: createLedger, createMilestone, createItem, updateItem,
   * updateMilestoneItem, archiveMilestone (once per participating
   * ledger, including the milestones ledger). NOT fired for reads.
   */
  onMutation?: OnMutation;
  /**
   * Policy for an on-disk canonical ledger whose schema has diverged from
   * its canonical bootstrap schema (detected at init()).
   *
   * - `'backup-reinit'` (default): back up the divergent on-disk state and
   *   reinitialise the canonical files from scratch, then continue startup.
   * - `'abort'`: refuse to start — throw `BootstrapViolationError` — so the
   *   divergence is loud and operator-handled.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
}

export class FsLedgerStore
  extends AbstractLedgerStore<FsPersistence>
  implements LedgerStore
{
  private readonly root: string;
  private readonly docsDir: string;
  private readonly logsDir: string;
  private readonly locksDir: string;
  private readonly archiveDir: string;
  private readonly registryPath: string;
  /**
   * In-flight cache-mirror writes. The mirror runs AFTER lockfile release (so
   * it does not serialise other writers), but it is still part of the mutation
   * the caller awaited; `dispose()` drains this set so an in-flight mirror is
   * not abandoned (D-LED-06 drain contract).
   */
  private readonly pendingMirrors = new Set<Promise<void>>();

  constructor(opts: FsLedgerStoreOpts) {
    const root = opts.root;
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const archiveDir = path.join(docsDir, "archive");
    const registryPath = path.join(docsDir, "ledgers.yaml");
    const now = opts.now ?? (() => new Date().toISOString());
    const persistence = new FsPersistence({
      layout: { root, docsDir, archiveDir, registryPath },
      now,
    });
    super({
      persistence,
      lockfile: new Lockfile(opts.lockfile ?? {}),
      now,
      onMutation: opts.onMutation ?? null,
      onSchemaDivergence: opts.onSchemaDivergence ?? "backup-reinit",
    });
    // The seam's divergence backup must enumerate the store's CURRENT registry
    // (held in the base) to copy + unlink the non-canonical ledger files; bind
    // the accessor now that `super()` has run and `this` is available.
    persistence.bindRegistrySnapshot(() => this.currentRegistry);
    this.root = root;
    this.docsDir = docsDir;
    this.logsDir = path.join(docsDir, "logs");
    this.locksDir = path.join(docsDir, ".locks");
    this.archiveDir = archiveDir;
    this.registryPath = registryPath;
  }

  /**
   * The resolved filesystem root this store is bound to (the server `--cwd`).
   * Exposed read-only so a host (e.g. `@cq/ledger-mcp` buildServer) can bind a
   * root-scoped capability — the cq.toml config root — to the SAME directory
   * the store reads its ledgers from, without re-resolving CWD precedence.
   */
  get rootDir(): string {
    return this.root;
  }

  /**
   * The base's current in-memory registry, exposed so the {@link FsPersistence}
   * seam's `backupCanonicalState` can enumerate non-canonical ledgers to copy +
   * unlink. Internal to the FS wiring; not part of the `LedgerStore` surface.
   */
  private get currentRegistry(): import("../types.js").LedgerRegistry {
    return this.registry;
  }

  // ---------------------------------------------------------------------------
  // Backend extension points
  // ---------------------------------------------------------------------------

  protected locksRoot(): string {
    return this.locksDir;
  }

  /**
   * Schedule the cache mirror for the file(s) `op` touched (see cacheMirror.ts)
   * as a fire-and-forget async task tracked in `pendingMirrors`. GUARDED: a
   * mirror failure is swallowed and logged to stderr exactly like the
   * onMutation hook — it MUST NOT unwind the write path.
   */
  protected override afterMutation(
    ledgerId: string,
    op: "create" | "update" | "archive",
  ): void {
    const work = (async (): Promise<void> => {
      try {
        await mirrorMutation(
          {
            rootDir: this.root,
            docsDir: this.docsDir,
            archiveDir: this.archiveDir,
            registryPath: this.registryPath,
          },
          ledgerId,
          op,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `FsLedgerStore: cache mirror threw for ${ledgerId} (${op}): ${msg}\n`,
        );
      }
    })();
    this.pendingMirrors.add(work);
    void work.finally(() => this.pendingMirrors.delete(work));
  }

  /**
   * Drain in-flight cache mirrors. The mirror is a fire-and-forget tail of
   * fireMutation, scheduled SYNCHRONOUSLY (registered in pendingMirrors) after
   * lockfile release — before the mutation method resolves and before this
   * drain runs. Awaiting it prevents an in-flight mirror from outliving
   * dispose() (extends the D-LED-06 drain contract to the mirror).
   */
  protected override async drainBackend(): Promise<void> {
    await Promise.all(Array.from(this.pendingMirrors));
  }

  // ---------------------------------------------------------------------------
  // FS-only capabilities (not on the generic LedgerStore surface)
  // ---------------------------------------------------------------------------

  /**
   * Public, operator-facing wipe-and-reinit. Intended for a CLI to call on a
   * freshly-constructed, already-init()'d store (not one actively serving
   * clients): it snapshots the current on-disk ledgers to a timestamped
   * `docs/.backup/<ts>/` dir and rewrites the canonical empty set, exactly as
   * the init()-divergence path does (reuses backupAndReinit verbatim).
   *
   * reset() handles non-canonical ledgers (created via createLedger()) fully:
   * their files are backed up and deleted from disk by backupAndReinit(), and
   * their FTS docs are removed here before the ledger map is cleared, so no
   * orphan docs/<name>.md files and no stale FTS hits survive the reset.
   *
   * reset() adds only the pre-wipe per-ledger item count and the returned
   * summary; it then reloads the fresh canonical state into memory + the FTS
   * index (via init()) so subsequent reads observe the empty ledgers.
   */
  async reset(): Promise<ResetSummary> {
    this.assertInit();
    // Count active items per ledger BEFORE the wipe.
    const ledgers = Array.from(this.ledgers.entries())
      .map(([name, ledger]) => ({ name, itemCount: activeItemsOf(ledger).length }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Drop FTS docs for non-canonical ledgers now, before backupAndReinit()
    // clears the registry. init() only indexes CANONICAL_LEDGERS, so without
    // this call those ledger's FTS docs would survive as stale hits.
    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    for (const name of this.ledgers.keys()) {
      if (!canonicalNames.has(name)) {
        this.searchIndex.removeLedger(name);
      }
    }

    const backupDir = await this.backupAndReinit();

    // backupAndReinit rewrote files + this.registry but left the in-memory
    // ledger map and FTS index pointing at the pre-wipe canonical state. Drop
    // the ledger map and re-run init() to load the fresh canonical empty set.
    this.ledgers.clear();
    this.initialised = false;
    await this.init();

    return { backupDir, ledgers };
  }

  /**
   * Bounded, root-confined read of a log file under `<root>/.cq/logs/`
   * (T147 / Q87). This is the FS-store's `read_log` capability: the
   * confinement root is the EXPLICIT FS-store root (`this.logsDir`), NOT the
   * generic `LedgerStore` interface — the in-memory store has no filesystem and
   * supplies no such capability.
   *
   * Security/bounds:
   *  - `relPath` MUST be repo-relative; an absolute path is rejected.
   *  - The path is resolved against `<root>/.cq/logs` and REJECTED if it
   *    escapes that directory (e.g. `..` traversal).
   *  - The returned content is capped at {@link MAX_READ_LOG_BYTES}; an
   *    oversized file is truncated and flagged `truncated: true`.
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    if (path.isAbsolute(relPath)) {
      throw new LedgerError(`read_log: absolute paths are not allowed: ${relPath}`);
    }
    // sessionLogs stores REPO-relative paths (".cq/logs/<file>"), but this
    // method resolves against logsDir (= <root>/.cq/logs). Strip a leading
    // .cq/logs/ so a repo-relative path is not doubled into
    // <root>/.cq/logs/.cq/logs/<file>. A path already relative to .cq/logs
    // ("<file>") is unaffected. Containment is still enforced below.
    const rel = relPath.replace(LEDGER_LOGS_STRIP_RE, "");
    // Normalise the requested relative path, then resolve under logsDir and
    // verify containment (defence-in-depth against `..` traversal).
    const resolved = path.resolve(this.logsDir, rel);
    if (
      resolved !== this.logsDir &&
      !resolved.startsWith(this.logsDir + path.sep)
    ) {
      throw new LedgerError(
        `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
      );
    }

    // Re-assert containment after symlink resolution (D26): a symlink whose
    // lexical path is inside logsDir may point outside the confinement root.
    // We resolve BOTH sides so a symlinked parent component of the store root
    // (e.g. macOS /var -> /private/var) does not cause false escape rejections
    // for legitimate in-root paths (D26 round-1 fix).
    // We catch ENOENT on the target so a genuinely missing file surfaces as-is,
    // not as a false escape error. The logsDir realpath is computed each time
    // (the root must exist when a read is attempted; if it can ENOENT, let the
    // subsequent readFile surface the right error).
    //
    // D28: hoist `real` outside the try block so the subsequent readFile uses
    // the validated canonical path instead of the raw `resolved` path.  This
    // closes the check-then-use TOCTOU: if a symlink is swapped between the
    // realpath check and the readFile, reading `real` (canonical, symlink-free)
    // ensures no new symlink is followed at read time.
    let real: string | undefined;
    try {
      real = await fs.realpath(resolved);
      let realLogsDir: string;
      try {
        realLogsDir = await fs.realpath(this.logsDir);
      } catch {
        // logsDir doesn't exist yet — a missing file read will ENOENT below.
        realLogsDir = this.logsDir;
      }
      if (real !== realLogsDir && !real.startsWith(realLogsDir + path.sep)) {
        throw new LedgerError(
          `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // ENOENT: file doesn't exist — fall through so readFile surfaces it.
      // `real` stays undefined; `real ?? resolved` below reads `resolved` so
      // the normal not-found error still surfaces (not masked).
    }

    // Use the validated canonical path when available (D28: close TOCTOU).
    // When realpath threw ENOENT, `real` is undefined and we fall back to
    // `resolved` so the readFile surfaces the expected not-found error.
    const buf = await fs.readFile(real ?? resolved);
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      const content = buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8");
      return { path: relPath, content, truncated: true };
    }
    return { path: relPath, content: buf.toString("utf8") };
  }
}
