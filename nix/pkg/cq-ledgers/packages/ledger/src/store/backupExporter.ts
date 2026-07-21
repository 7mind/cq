/**
 * backupExporter — the one-way human-readable backup exporter (T502 / Q244).
 *
 * Serializes the FULL state of a ledger store into the CURRENT markdown/YAML
 * `.cq/` layout — REUSING the existing serializers (`serializeLedger`,
 * `serializeRegistry`, `serializeArchive`, `serializeMilestoneItemArchive`) so
 * the dump stays byte-compatible with today's on-disk format for humans / PRs /
 * disaster recovery. The dump is WRITE-ONLY: it is NEVER read back as a
 * primary (restore is a separate, explicit operation — T503).
 *
 * Two targets, gated by cq.toml's `[ledger].backup` (default `none` = OFF):
 *   - `in-tree`       — write the dump under `<root>/.cq/` in the work tree
 *                       ({@link exportBackupInTree}). Overwrite-in-place, no
 *                       journal (same semantics as the old cache mirror);
 *                       stale files from a previous dump are NOT deleted.
 *   - `orphan-branch` — commit the dump tree (rooted at `.cq/…`, so a checkout
 *                       of the ref materialises the exact work-tree layout) to
 *                       `refs/heads/<branch>` via {@link GitPlumbing}
 *                       ({@link exportBackupOrphanBranch}). Write path only —
 *                       no checkout, no index mutation.
 *
 * LOG COVERAGE (Q247): BOTH targets carry the exported logs — every artifact
 * in the primary log store (the out-of-tree xdg `logsDir`, T495/T499) is
 * written into the dump at today's committed-artifact path
 * (`.cq/logs/<rel>`, e.g. `.cq/logs/<name>.md` / `.cq/logs/raw/<name>.jsonl`),
 * byte-identical to the stored (already-redacted) artifact bytes. There is no
 * target that omits logs.
 *
 * STORE-SUPPLIED LOGS SOURCE (T575, review R690): the postgres backend has no
 * filesystem `logsDir` to walk — its log artifacts live in the tenant-keyed
 * `logs` table (T572). `buildBackupDump` therefore ALSO accepts a duck-typed
 * `listLogs` capability (mirroring the existing `readLog` duck-type, T408):
 * when `store` exposes one (e.g. `PostgresLedgerStore`), it is preferred over
 * `logsDir` unconditionally — there is no filesystem area to fall back to
 * under postgres, and a store that advertises `listLogs` is authoritative
 * regardless of backend. The xdg/fs/git-object `logsDir`-walking path is
 * untouched.
 *
 * Trigger: {@link BackupScheduler} — a best-effort DEBOUNCED export after
 * mutations, mirroring the old cache-mirror hook semantics: fire-and-forget,
 * GUARDED — a backup failure is swallowed (logged to stderr) and NEVER blocks
 * or unwinds the store's write path. Plus the explicit `cq backup` subcommand
 * for on-demand dumps ({@link runBackupExport} awaited directly).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { FetchedLedger, Ledger, LedgerRegistry } from "../types.js";
import type { LedgerStore } from "./LedgerStore.js";
import {
  serializeArchive,
  serializeLedger,
  serializeMilestoneItemArchive,
} from "../parser/serialize.js";
import { serializeRegistry } from "../registry.js";
import {
  LEDGER_LOGS_DIRNAME,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_LEDGER,
} from "../constants.js";
import { atomicWrite } from "./fsAtomic.js";
import { GitPlumbing, StaleRefError, type TreeEntry } from "./git/GitPlumbing.js";

/** The backup targets this exporter can write (the non-`none` modes of Q244). */
export type BackupTarget = "in-tree" | "orphan-branch";

/** One file of a backup dump; `path` is POSIX-relative to `.cq/`. */
export interface BackupDumpFile {
  readonly path: string;
  readonly content: string;
}

/** Regular-file git mode for a dump blob (mirrors GitPersistence / logPut). */
const BLOB_MODE = "100644";

/**
 * Duck-typed store-supplied logs source (T575, review R690) — the postgres
 * analogue's alternative to a filesystem `logsDir`. Mirrors
 * `main.ts`'s `readLogOf` duck-type: a store opts in simply by exposing a
 * `listLogs(): AsyncIterable<{ path, content }>` method (no `LedgerStore`
 * interface change required); a store with none (fs/git-object/xdg, or the
 * in-memory test store) returns `undefined` and `buildBackupDump` falls back
 * to walking `logsDir`.
 */
function listLogsOf(
  store: LedgerStore,
): (() => AsyncIterable<{ path: string; content: string }>) | undefined {
  const candidate = (store as { listLogs?: unknown }).listLogs;
  if (typeof candidate !== "function") return undefined;
  const fn = candidate as () => AsyncIterable<{ path: string; content: string }>;
  return () => fn.call(store);
}

/**
 * Bounded retries for the orphan-branch CAS commit — the backup writer runs
 * outside any store lock, so a peer process's backup can move the ref between
 * our read and our CAS ({@link StaleRefError}). The dump tree itself is
 * self-contained (a full snapshot, not a merge), so a retry only re-reads the
 * parent and re-commits the SAME tree.
 */
const MAX_CAS_ATTEMPTS = 8;

/**
 * Default debounce for the post-mutation trigger. Long enough to coalesce a
 * burst of mutations into one export, short enough that the dump trails the
 * primary by well under a second in the steady state.
 */
export const DEFAULT_BACKUP_DEBOUNCE_MS = 500;

/**
 * Build the complete human-readable dump of `store` as an in-memory file set,
 * relative to `.cq/`:
 *
 *   - `ledgers.yaml`                — {@link serializeRegistry} over every
 *                                     enumerated ledger's name + schema;
 *   - `<ledger>.md`                 — {@link serializeLedger} over the fetched
 *                                     view (frontmatter carries counters +
 *                                     archive pointers, so the file parses
 *                                     back via `parseLedger`);
 *   - `archive/<ledger>/<id>.md`    — {@link serializeArchive} (group) /
 *                                     {@link serializeMilestoneItemArchive}
 *                                     (milestones item) per archive pointer;
 *   - `logs/<rel>`                  — every file under `logsDir`, byte-for-byte
 *                                     (the Q247 log coverage; `null` logsDir or
 *                                     a missing dir contributes no entries).
 *
 * Reads go through the PUBLIC store surface only (`enumerate` / `fetch` /
 * `fetchArchive`), so any `LedgerStore` backend can be dumped.
 */
export async function buildBackupDump(
  store: LedgerStore,
  logsDir: string | null,
): Promise<BackupDumpFile[]> {
  const files: BackupDumpFile[] = [];
  const names = store.enumerate();
  const fetched = names.map((name) => store.fetch(name));

  const registry: LedgerRegistry = {
    version: 1,
    ledgers: fetched.map((f) => ({ name: f.id, schema: f.schema })),
  };
  files.push({ path: "ledgers.yaml", content: serializeRegistry(registry) });

  for (const f of fetched) {
    files.push({ path: `${f.id}.md`, content: serializeLedger(fetchedToLedger(f)) });
    for (const pointer of f.archivePointers) {
      const archive = await store.fetchArchive(f.id, pointer.id);
      const content =
        archive.kind === "group"
          ? serializeArchive(archive.milestone)
          : serializeMilestoneItemArchive(archive.item);
      // pointer.path is the docs-relative locator (`./archive/<ledger>/<id>.md`);
      // strip the leading `./` to get the dump-relative path.
      files.push({ path: pointer.path.replace(/^\.\//, ""), content });
    }
  }

  const listLogs = listLogsOf(store);
  if (listLogs !== undefined) {
    // Store-supplied logs source (postgres) takes unconditional precedence:
    // there is no filesystem logs area to fall back to under that backend.
    for await (const entry of listLogs()) {
      files.push({ path: path.posix.join(LEDGER_LOGS_DIRNAME, entry.path), content: entry.content });
    }
  } else if (logsDir !== null) {
    for (const rel of await walkFiles(logsDir)) {
      const content = await fs.readFile(path.join(logsDir, rel), "utf8");
      files.push({ path: path.posix.join(LEDGER_LOGS_DIRNAME, rel), content });
    }
  }

  return files;
}

/**
 * Convert a fetched view back to the serializer's `Ledger` shape. For the
 * milestones ledger the single `active` group's title/description come from
 * the trivial self-resolution; for every other ledger the serializer emits a
 * bare `## <id>` and ignores title/description entirely.
 */
function fetchedToLedger(f: FetchedLedger): Ledger {
  const isMilestones = f.id === MILESTONES_LEDGER;
  return {
    id: f.id,
    schema: f.schema,
    counters: f.counters,
    milestones: f.milestones.map((g) => ({
      id: g.id,
      title: isMilestones ? g.milestone.title : "",
      description: isMilestones ? g.milestone.description : "",
      items: g.items,
    })),
    archivePointers: f.archivePointers,
  };
}

/**
 * Enumerate every regular file under `dir` recursively, returning
 * POSIX-relative paths in sorted order. A missing `dir` yields `[]` (no logs
 * have been stored yet); any other I/O error propagates.
 */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch (err: unknown) {
      if (rel === "" && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk("");
  return out.sort();
}

/**
 * Write `dump` under `<root>/.cq/` in the work tree via {@link atomicWrite}
 * (tmp + rename, the store's own atomic primitive), overwriting the single
 * latest copy of each file in place.
 */
export async function exportBackupInTree(
  root: string,
  dump: readonly BackupDumpFile[],
): Promise<void> {
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  for (const file of dump) {
    await atomicWrite(path.join(docsDir, file.path), file.content);
  }
}

/**
 * Commit `dump` as a tree rooted at `.cq/…` on `refs/heads/<branch>`, WITHOUT
 * touching the work tree or the real index (GitPlumbing's scratch-index
 * plumbing). Each export is a FULL self-contained snapshot commit whose parent
 * is the ref's current tip (or an orphan commit when the ref is new); a stale
 * CAS from a concurrent backup writer is retried boundedly with a re-read
 * parent and the same tree.
 */
export async function exportBackupOrphanBranch(
  root: string,
  branch: string,
  dump: readonly BackupDumpFile[],
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
  const entries: TreeEntry[] = [];
  for (const file of dump) {
    const sha = await git.hashObject(file.content);
    entries.push({
      mode: BLOB_MODE,
      sha,
      path: path.posix.join(LEDGER_STORAGE_DIRNAME, file.path),
    });
  }
  const tree = await git.writeTree(entries);
  const message = `cq backup: ${new Date().toISOString()}`;

  let lastErr: StaleRefError | undefined;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const expectedOld = await git.readRef(ref);
    const commit = await git.commitTree(tree, expectedOld, message);
    try {
      await git.updateRef(ref, commit, expectedOld);
      return;
    } catch (e) {
      if (e instanceof StaleRefError) {
        // A concurrent backup moved the ref; re-read the parent and retry.
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `backup export: ref ${ref} kept moving under concurrent writers; gave up after ` +
      `${MAX_CAS_ATTEMPTS} CAS attempts${lastErr ? ` (last: ${lastErr.message})` : ""}`,
  );
}

/** Everything one backup export needs; bound once at store construction. */
export interface BackupExportOpts {
  /** The store to dump (read via its public surface only). */
  readonly store: LedgerStore;
  /** The repo root (`--cwd`): the `.cq/` parent for in-tree, the git cwd for orphan-branch. */
  readonly root: string;
  /** The resolved non-`none` backup target. */
  readonly target: BackupTarget;
  /** The orphan ref branch name (`[ledger].branch`, default `cq-ledger`). */
  readonly branch: string;
  /** The primary log store dir (`resolveLogsDir(projectKey)`); `null` = no logs area. */
  readonly logsDir: string | null;
}

/**
 * Run one full backup export: build the dump and write it to the configured
 * target. Returns the dump's file count (for CLI reporting). Errors propagate
 * to the caller — the debounced trigger guards them ({@link BackupScheduler});
 * `cq backup` surfaces them.
 */
export async function runBackupExport(opts: BackupExportOpts): Promise<number> {
  const dump = await buildBackupDump(opts.store, opts.logsDir);
  if (opts.target === "in-tree") {
    await exportBackupInTree(opts.root, dump);
  } else {
    await exportBackupOrphanBranch(opts.root, opts.branch, dump);
  }
  return dump.length;
}

/**
 * The debounced, best-effort post-mutation trigger (the old cache-mirror hook
 * pattern, adapted to a whole-state export):
 *
 *   - `schedule()` is SYNCHRONOUS and cheap (reset a timer) — safe to call
 *     from the store's `onMutation` hook, which the store already guards;
 *   - when the timer fires the export runs fire-and-forget; a failure is
 *     swallowed and logged to stderr, so a backup failure can NEVER unwind or
 *     block a store write;
 *   - mutations arriving while an export is in flight coalesce into ONE
 *     follow-up export;
 *   - the timer is `unref()`d so a pending backup never keeps an otherwise
 *     idle process alive;
 *   - `flush()` runs any pending work to completion (deterministic tests,
 *     orderly shutdown); `close()` cancels pending work.
 */
export class BackupScheduler {
  private readonly run: () => Promise<void>;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private closed = false;

  constructor(run: () => Promise<void>, debounceMs: number = DEFAULT_BACKUP_DEBOUNCE_MS) {
    this.run = run;
    this.debounceMs = debounceMs;
  }

  /** Debounce an export: (re)start the timer. Synchronous; never throws. */
  schedule(): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.debounceMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** Start an export now, or mark a follow-up if one is already in flight. */
  private kick(): void {
    if (this.running !== null) {
      this.rerun = true;
      return;
    }
    this.running = (async () => {
      try {
        await this.run();
      } catch (err: unknown) {
        // GUARDED: a backup failure never propagates — the primary write
        // already committed; the dump just trails until the next trigger.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ledger backup export failed (best-effort, ignored): ${msg}\n`);
      } finally {
        this.running = null;
        if (this.rerun && !this.closed) {
          this.rerun = false;
          this.kick();
        }
      }
    })();
  }

  /**
   * Run all pending work to completion: fire a pending timer immediately and
   * await the (chain of) in-flight export(s). Resolves once no export is
   * pending or running.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.kick();
    }
    while (this.running !== null) {
      await this.running;
    }
  }

  /** Cancel pending work; further `schedule()` calls become no-ops. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
