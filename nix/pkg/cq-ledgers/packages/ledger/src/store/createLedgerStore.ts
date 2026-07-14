/**
 * createLedgerStore — the SINGLE backend-selecting store factory (T357 / G43).
 *
 * Every store construction site in the running products (ledger-mcp's
 * `createEmbeddedStore()` + `main()`, cq-cli's `runInit()` / `runReset()`)
 * routes through this factory so the `[ledger]` backend choice in cq.toml is
 * honoured in EXACTLY one place:
 *
 *   - `backend = 'fs'` (the default, and the case when no cq.toml exists) →
 *     {@link FsLedgerStore}. Byte-identical to the historical behaviour.
 *   - `backend = 'git-object'` → {@link GitObjectLedgerBackend}, after a
 *     fail-fast validation of the git environment (git on PATH + the root is
 *     inside a git work tree) and an idempotent install of the git-backend
 *     `.gitignore` block (so a fresh ledger is never accidentally tracked).
 *   - `backend = 'xdg'` (T530) → {@link SqliteLedgerStore} on
 *     `<stateDir>/ledger.db`, where `stateDir` is resolved from the repo's
 *     stable {@link resolveProjectKey} (a `[ledger].projectId` override, else
 *     the repo's first commit SHA — see projectKey.ts). A repo whose identity
 *     cannot be resolved (a shallow clone, or no git at all) FAILS FAST with
 *     {@link ProjectKeyResolutionError} rather than silently mislocating the
 *     store.
 *
 * The factory `init()`s the returned store before handing it back, mirroring the
 * historical `new FsLedgerStore(); await store.init()` pattern at each site.
 *
 * This lives in `@cq/ledger` (not ledger-mcp) because BOTH ledger-mcp and cq-cli
 * already depend on `@cq/ledger`; cq-cli does not depend on ledger-mcp, so a
 * shared low-level home avoids pulling the MCP transport into the CLI.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, type LedgerBackend } from "@cq/config";
import type { LedgerStore } from "./LedgerStore.js";
import { FsLedgerStore } from "./FsLedgerStore.js";
import { GitObjectLedgerBackend } from "./git/GitObjectLedgerBackend.js";
import { ensureGitBackendGitignore } from "./gitBackendGitignore.js";
import { SqliteLedgerStore } from "./sqlite/SqliteLedgerStore.js";
import { dataVersion, openLedgerDb } from "./sqlite/connection.js";
import { resolveProjectKey } from "../projectKey.js";
import { resolveStateDir, resolveLogsDir, ensureStateDir } from "../stateDir.js";
import { BackupScheduler, runBackupExport } from "./backupExporter.js";

/** The xdg backend's database filename within `<stateDir>` (T530). */
const XDG_DB_FILENAME = "ledger.db";

/** Default poll interval for {@link startXdgCoherenceWatcher}. */
const XDG_WATCHER_DEFAULT_POLL_MS = 500;

/** Default branch/remote when no cq.toml `[ledger]` table is present. */
const DEFAULT_BRANCH = "cq-ledger";

/**
 * The resolved storage backend for a root, plus the branch the git-object
 * backend operates on (the `[ledger].branch`, default `cq-ledger`). Returned
 * alongside the store so the construction site can select the matching
 * coherence watcher (file-watch for fs, ref-sha-watch for git-object).
 */
export interface ResolvedLedgerStore {
  /** The initialised store (FsLedgerStore or GitObjectLedgerBackend). */
  readonly store: LedgerStore;
  /** The resolved backend identifier. */
  readonly backend: LedgerBackend;
  /** The orphan-ref branch (git-object only; the default otherwise). */
  readonly branch: string;
  /**
   * The concrete `ledger.db` path (xdg backend only) — the input
   * {@link startXdgCoherenceWatcher} polls via `PRAGMA data_version` to
   * detect a peer process's commit. `undefined` for fs / git-object, whose
   * coherence watchers key off a different signal (file mtime / ref sha).
   */
  readonly dbPath?: string;
  /**
   * The out-of-tree primary logs dir (xdg backend only) —
   * `resolveLogsDir(projectKey)`, the sibling of the `state/` area `dbPath`
   * lives under. Exposed so `cq backup` reads log artifacts from the SAME
   * location the debounced trigger exports (T502 / Q247).
   */
  readonly logsDir?: string;
  /**
   * The debounced post-mutation backup trigger (T502) — present ONLY when the
   * xdg backend is configured with a non-`none` `[ledger].backup`. The store's
   * `onMutation` hook `schedule()`s it; hosts/tests may `flush()` for a
   * deterministic export or `close()` on shutdown. Best-effort by design: its
   * timers are unref'd and a backup failure never unwinds a store write.
   */
  readonly backup?: BackupScheduler;
}

/**
 * Thrown when `backend = 'git-object'` is configured but the git environment is
 * not usable from `root` — git absent from PATH, or `root` not inside a git
 * work tree. A fail-fast at startup with a clear, actionable message.
 */
export class GitEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitEnvironmentError";
  }
}

/**
 * Resolve the `[ledger]` backend for `root` from cq.toml. No cq.toml (or no
 * `[ledger]` table) → `'fs'`, matching {@link loadConfig}'s contract and the
 * historical default.
 */
export function resolveLedgerBackend(root: string): { backend: LedgerBackend; branch: string } {
  const config = loadConfig(root);
  if (config === null || config.ledger === null) {
    return { backend: "fs", branch: DEFAULT_BRANCH };
  }
  return { backend: config.ledger.backend, branch: config.ledger.branch };
}

/**
 * Validate the git environment for the git-object backend, FAILING FAST with a
 * clear {@link GitEnvironmentError} when git is unavailable or `root` is not
 * inside a git work tree. Uses synchronous `git rev-parse --is-inside-work-tree`
 * (git resolves work-tree / GIT_DIR indirection itself) so the check is a single
 * cheap call before any store is constructed.
 */
export function assertGitWorkTree(root: string): void {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitEnvironmentError(
      `[ledger] backend = 'git-object' requires a git work tree at ${root}, ` +
        `but \`git rev-parse --is-inside-work-tree\` failed ` +
        `(git missing from PATH or not a git repository): ${detail}`,
    );
  }
  if (out !== "true") {
    throw new GitEnvironmentError(
      `[ledger] backend = 'git-object' requires ${root} to be inside a git work tree, ` +
        `but \`git rev-parse --is-inside-work-tree\` returned "${out}".`,
    );
  }
}

/**
 * Construct and initialise the ledger store selected by cq.toml's `[ledger]`
 * backend at `root`. The ONE backend-selection site for the running products.
 *
 * For `git-object`: validates the git environment (fail-fast) and installs the
 * idempotent git-backend `.gitignore` block BEFORE constructing the store, so a
 * fresh git-object ledger's `.cq/` is gitignored from the first write.
 *
 * The store is `init()`-ed before return (mirrors every historical call site).
 */
export async function createLedgerStore(root: string): Promise<ResolvedLedgerStore> {
  const { backend, branch } = resolveLedgerBackend(root);

  if (backend === "git-object") {
    assertGitWorkTree(root);
    await ensureGitBackendGitignore(root);
    const store = new GitObjectLedgerBackend({ repoRoot: root, ref: branch });
    await store.init();
    return { store, backend, branch };
  }

  // backend === 'xdg' (T530): the out-of-tree bun:sqlite primary (K102).
  // resolveProjectKey lets ProjectKeyResolutionError propagate as the
  // fail-fast (a shallow clone or a non-git/no-commit root has no stable
  // identity to key the store off — see projectKey.ts's no-fallback
  // rationale, Q246).
  if (backend === "xdg") {
    const config = loadConfig(root);
    const projectId = config?.ledger?.projectId ?? null;
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId });
    const stateDir = resolveStateDir(projectKey);
    await ensureStateDir(stateDir);
    const dbPath = join(stateDir, XDG_DB_FILENAME);
    // Sibling out-of-tree logs area (T499), same projectKey — so `read_log`
    // resolves the SAME location `cq log put`'s xdg branch writes to.
    const logsDir = resolveLogsDir(projectKey);
    // T502: the debounced human-readable backup trigger (Q244), wired at the
    // ONE place the store's onMutation hook is bound. `[ledger].backup`
    // defaults to 'none' (OFF): no scheduler, the hook is a no-op, and
    // NOTHING is ever written in-tree or to any ref. The scheduler is bound
    // AFTER init() (via the closure) so bootstrap writes never trigger an
    // export; schedule() is synchronous and the export itself is
    // fire-and-forget + guarded, so a backup failure never unwinds a write.
    const backupTarget = config?.ledger?.backup ?? "none";
    let backup: BackupScheduler | undefined;
    const store = new SqliteLedgerStore({
      dbPath,
      logsDir,
      onMutation: () => backup?.schedule(),
    });
    await store.init();
    if (backupTarget !== "none") {
      backup = new BackupScheduler(async () => {
        await runBackupExport({ store, root, target: backupTarget, branch, logsDir });
      });
      return { store, backend, branch, dbPath, logsDir, backup };
    }
    return { store, backend, branch, dbPath, logsDir };
  }

  // backend === 'fs' — byte-identical to the historical default.
  const store = new FsLedgerStore({ root });
  await store.init();
  return { store, backend, branch };
}

/** Handle returned by {@link startXdgCoherenceWatcher}. */
export interface XdgCoherenceWatcher {
  /** Stop polling and release the probe connection. */
  close(): void;
}

/**
 * The xdg backend's coherence watcher (T530) — parity with the fs file-watch
 * / git-object ref-watch selection the construction site (ledger-mcp) makes
 * for the other backends, keyed here off `PRAGMA data_version` instead of a
 * filesystem event or a ref sha.
 *
 * Opens its OWN probe connection to `dbPath` (never touches `store`'s
 * internals) and polls {@link dataVersion} every `pollMs`. `data_version` is
 * bumped by ANY commit on the file, including this process's own writes AND a
 * peer process's — but it carries no per-ledger scope, so a bump invalidates
 * every ledger `store` currently knows (`store.enumerate()`) rather than just
 * the one that changed; the abstract-suite contract makes `invalidate` cheap
 * and idempotent for an unchanged ledger.
 *
 * `onChange`, when given, fires ONCE per invalidate pass with `null` (never a
 * ledger id) — `data_version` carries no per-ledger scope to report, matching
 * the bulk-invalidate granularity above. Same callback shape as
 * startLedgerWatcher / startLedgerRefWatcher's `onChange`, so the construction
 * site (startLedgerCoherenceWatcher, ledger-mcp/main.ts) can forward it
 * uniformly across all three backends (D89).
 *
 * A `close()`d watcher stops polling and releases its probe connection; the
 * store itself is untouched (the caller still owns its lifecycle).
 */
export function startXdgCoherenceWatcher(
  store: LedgerStore,
  dbPath: string,
  pollMs: number = XDG_WATCHER_DEFAULT_POLL_MS,
  onChange?: (ledgerId: string | null) => void,
): XdgCoherenceWatcher {
  const probe = openLedgerDb(dbPath);
  let lastVersion = dataVersion(probe);
  let invalidating = false;

  const timer = setInterval(() => {
    if (invalidating) return;
    const current = dataVersion(probe);
    if (current === lastVersion) return;
    lastVersion = current;
    invalidating = true;
    void (async () => {
      try {
        for (const ledgerId of store.enumerate()) {
          await store.invalidate(ledgerId);
        }
        onChange?.(null);
      } finally {
        invalidating = false;
      }
    })();
  }, pollMs);
  // Never keep an otherwise-idle process alive on its own.
  timer.unref?.();

  return {
    close(): void {
      clearInterval(timer);
      probe.close();
    },
  };
}
