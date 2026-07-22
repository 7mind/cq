/**
 * createLedgerStore — the SINGLE backend-selecting store factory (T357 / G43;
 * legacy cutover T505 / G67).
 *
 * Every store construction site in the running products (ledger-mcp's
 * `createEmbeddedStore()` + `main()`, cq-cli's `runInit()` / `runReset()`)
 * routes through this factory so the `[ledger]` backend choice in cq.toml is
 * honoured in EXACTLY one place:
 *
 *   - `backend = 'xdg'` (T530) → {@link SqliteLedgerStore} on
 *     `<stateDir>/ledger.db`, where `stateDir` is resolved from the repo's
 *     stable {@link resolveProjectKey} (a `[ledger].projectId` override, else
 *     the repo's first commit SHA — see projectKey.ts). A repo whose identity
 *     cannot be resolved (a shallow clone, or no git at all) FAILS FAST with
 *     {@link ProjectKeyResolutionError} rather than silently mislocating the
 *     store.
 *   - `backend = 'fs' | 'git-object'` (EXPLICIT in cq.toml — the no-cq.toml
 *     default is 'xdg' since K117) → the legacy in-tree store is opened
 *     as-is, with a DEPRECATION WARNING on stderr naming `cq migrate` (K117
 *     relaxed T505's hard {@link LegacyBackendError} refusal to a warning).
 *   - a DEFAULT-resolved 'xdg' (no explicit `backend` key) at a root that
 *     still carries a legacy in-tree ledger (`.cq/ledgers.yaml`) → the xdg
 *     store is used, with a SHADOW WARNING on stderr naming `cq migrate` —
 *     preserving T505's protection against silently shadowing an existing
 *     in-tree ledger with an empty xdg store, without the hard stop.
 *
 * `cq migrate` reads a live legacy backend through
 * {@link openLegacyLedgerStore} below (which also accepts an explicit
 * backend override for the default-xdg-with-legacy-tree case).
 *
 * The factory `init()`s the returned store before handing it back, mirroring the
 * historical `new FsLedgerStore(); await store.init()` pattern at each site.
 *
 * This lives in `@cq/ledger` (not ledger-mcp) because BOTH ledger-mcp and cq-cli
 * already depend on `@cq/ledger`; cq-cli does not depend on ledger-mcp, so a
 * shared low-level home avoids pulling the MCP transport into the CLI.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SQL } from "bun";
import { loadConfig, type LedgerBackend, type LedgerBackupMode } from "@cq/config";
import type { LedgerStore } from "./LedgerStore.js";
import { FsLedgerStore } from "./FsLedgerStore.js";
import { GitObjectLedgerBackend } from "./git/GitObjectLedgerBackend.js";
import { SqliteLedgerStore } from "./sqlite/SqliteLedgerStore.js";
import { dataVersion, openLedgerDb } from "./sqlite/connection.js";
import { openPgPool } from "./postgres/connection.js";
import { ensureSchema } from "./postgres/schema.js";
import { resolvePostgresDsn } from "./postgres/dsn.js";
import { resolveDisplayName } from "./postgres/displayName.js";
import { PostgresLedgerStore } from "./postgres/PostgresLedgerStore.js";
import { LEDGER_STORAGE_DIRNAME } from "../constants.js";
import { resolveProjectKey } from "../projectKey.js";
import { resolveStateDir, resolveLogsDir, ensureStateDir } from "../stateDir.js";
import { BackupScheduler, runBackupExport } from "./backupExporter.js";

/**
 * The xdg backend's database filename within `<stateDir>` (T530). Exported so
 * `cq migrate` (T504) can resolve the xdg primary's dbPath BEFORE cq.toml is
 * flipped to `backend = 'xdg'`.
 */
export const XDG_DB_FILENAME = "ledger.db";

/** Default poll interval for {@link startXdgCoherenceWatcher}. */
const XDG_WATCHER_DEFAULT_POLL_MS = 500;

/** Default branch/remote when no cq.toml `[ledger]` table is present. */
const DEFAULT_BRANCH = "cq-ledger";

/**
 * The resolved storage backend for a root, plus the branch the git-object
 * backend operates on (the `[ledger].branch`, default `cq-ledger`). Returned
 * alongside the store so the construction site can select the matching
 * coherence watcher.
 */
export interface ResolvedLedgerStore {
  /** The initialised store. */
  readonly store: LedgerStore;
  /**
   * The cq.toml CONFIG ROOT — the `root` this factory was called with, where
   * cq.toml + .git live (D93). Independent of the store's own data location:
   * for the xdg backend that location is out-of-tree (`<stateDir>/ledger.db`),
   * but cq.toml never moves there, so config/prompt-catalog capability wiring
   * (ledger-mcp's `createLedgerMcpServer`) MUST key off `configRoot`, not off a
   * duck-typed `store.rootDir` (which the xdg `SqliteLedgerStore` has no
   * reason to expose).
   */
  readonly configRoot: string;
  /** The resolved backend identifier. */
  readonly backend: LedgerBackend;
  /** The orphan-ref branch (git-object only; the default otherwise). */
  readonly branch: string;
  /**
   * The concrete `ledger.db` path (xdg backend only) — the input
   * {@link startXdgCoherenceWatcher} polls via `PRAGMA data_version` to
   * detect a peer process's commit. `undefined` for the legacy backends
   * {@link openLegacyLedgerStore} returns, whose coherence watchers key off a
   * different signal (file mtime / ref sha).
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
   * The debounced post-mutation backup trigger (T502; postgres parity T582) —
   * present ONLY when the xdg OR postgres backend is configured with a
   * non-`none` `[ledger].backup`. The store's `onMutation` hook `schedule()`s
   * it; hosts/tests may `flush()` for a deterministic export or `close()` on
   * shutdown. Best-effort by design: its timers are unref'd and a backup
   * failure never unwinds a store write.
   */
  readonly backup?: BackupScheduler;
  /**
   * The live Postgres handle (`backend = 'postgres'` only, T577/G81) — what
   * T578's LISTEN/NOTIFY coherence watcher needs: the
   * connection pool to reserve a dedicated LISTEN connection from, the
   * resolved DSN (to re-`new SQL(dsn)` on a dropped LISTEN connection, since
   * `PG_DRIVER_DEFAULTS` resolves to `""` for "let the driver use its own
   * defaults" — the SAME empty-string convention `runLogPutPostgres` uses),
   * and this tenant's `projectKey` (to filter NOTIFY payloads to this store's
   * own tenant). `undefined` for every other backend.
   */
  readonly pg?: ResolvedPostgresHandle;
  /**
   * This repo's resolved `projectKey` (T585 / Q284) — the SAME value
   * `resolveProjectKey` computed to key the xdg `stateDir` / the postgres
   * tenant row, exposed here so ledger-mcp's `createLedgerMcpServer` can
   * synthesize the single-project `list_projects` fallback entry without
   * re-resolving it. `undefined` only for the legacy backends
   * {@link openLegacyLedgerStore} returns (no such concept there — that
   * internal path is not a `list_projects`-serving runtime primary).
   */
  readonly projectKey?: string;
}

/**
 * The `backend = 'postgres'`-only handle carried on {@link ResolvedLedgerStore}
 * (see `pg` above). Kept as its own named interface (rather than inlined) so
 * T578's watcher signature reads as `startPostgresCoherenceWatcher(store,
 * pgHandle, onChange?)` against a stable type.
 */
export interface ResolvedPostgresHandle {
  /** The connection pool `PostgresLedgerStore` was constructed with. */
  readonly pool: SQL;
  /**
   * The resolved DSN, or `""` when {@link resolvePostgresDsn} returned the
   * `PG_DRIVER_DEFAULTS` sentinel (no explicit DSN — the driver reads `PG*`
   * env vars itself).
   */
  readonly dsn: string;
  /** This store's tenant key (`projects.project_key`). */
  readonly projectKey: string;
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
 * The legacy in-tree store presence probe (K117): a root with a
 * `.cq/ledgers.yaml` registry carries an fs-backend ledger. Used by the
 * factory's shadow warning and by `cq migrate`'s cq.toml-less source
 * detection — both key off the SAME signal so they can never disagree.
 */
export function hasLegacyFsLedger(root: string): boolean {
  return existsSync(join(root, LEDGER_STORAGE_DIRNAME, "ledgers.yaml"));
}

/**
 * K117 relaxed T505's hard `LegacyBackendError` to stderr warnings; these two
 * writers are the ONLY places the deprecation / shadow text lives. Warnings,
 * not errors: the store still constructs, so warning emission must never
 * unwind a caller.
 */
function warnLegacyBackendDeprecated(backend: LedgerBackend, root: string): void {
  process.stderr.write(
    `warning: [ledger] backend = '${backend}' at ${root} is a DEPRECATED legacy in-tree ` +
      `backend — the runtime primary is the out-of-tree xdg store. Run \`cq migrate\` to ` +
      `import this ledger into the xdg primary (it flips cq.toml for you).\n`,
  );
}

function warnLegacyLedgerShadowedByXdgDefault(root: string): void {
  process.stderr.write(
    `warning: ${root} carries a legacy in-tree ledger (${LEDGER_STORAGE_DIRNAME}/ledgers.yaml) ` +
      `but cq.toml names no [ledger] backend, so the DEFAULT out-of-tree xdg store is used — ` +
      `the in-tree ledger is NOT read. Run \`cq migrate\` to import it into the xdg primary, ` +
      `or set backend = "fs" explicitly to keep reading it (deprecated).\n`,
  );
}

/**
 * Thrown by `cq reset`'s postgres branch (`runResetPostgres`, main.ts / T583)
 * when `[ledger].backup != 'none'`: unlike the fs backend's `reset()` (which
 * atomically snapshots-then-reinitialises), the postgres reset path does not
 * (yet) take its OWN pre-wipe backup snapshot before deleting a tenant's rows.
 *
 * This is now a NARROW gap, not a general one: T582 wired `cq backup`/`cq
 * restore` and the debounced post-mutation exporter for `backend = 'postgres'`
 * (via {@link runBackupExport}'s store-agnostic dump builder + T575's
 * `listLogs` duck-type) — {@link createLedgerStore} below no longer throws
 * this error. Only `cq reset`'s specific "snapshot immediately before
 * wiping" safety net remains unimplemented; run `cq backup` yourself right
 * before `cq reset` in the meantime.
 */
export class PostgresBackupNotWiredError extends Error {
  constructor(backupTarget: LedgerBackupMode, root: string) {
    super(
      `[ledger] backend = 'postgres' at ${root} is configured with [ledger].backup = ` +
        `'${backupTarget}'; \`cq reset\` does not yet take a pre-wipe backup snapshot for the ` +
        `postgres backend (the general backup mechanism — \`cq backup\`/\`cq restore\` + the ` +
        `debounced auto-export — is wired; this is only reset's own safety net). Run ` +
        `\`cq backup\` immediately before \`cq reset\`, or set [ledger].backup = "none" to skip ` +
        `this guard.`,
    );
    this.name = "PostgresBackupNotWiredError";
  }
}

/**
 * Resolve the `[ledger]` backend for `root` from cq.toml. No cq.toml, no
 * `[ledger]` table, or a `[ledger]` table without a `backend` key → `'xdg'`
 * (K117), with `explicit: false` so callers can tell the default apart from a
 * deliberate choice (the factory's legacy-shadow warning and `cq migrate`'s
 * cq.toml-less source detection both key off it).
 */
export function resolveLedgerBackend(root: string): {
  backend: LedgerBackend;
  branch: string;
  explicit: boolean;
} {
  const config = loadConfig(root);
  if (config === null || config.ledger === null) {
    return { backend: "xdg", branch: DEFAULT_BRANCH, explicit: false };
  }
  return {
    backend: config.ledger.backend,
    branch: config.ledger.branch,
    explicit: config.ledger.backendExplicit,
  };
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
 * `backend = 'xdg'` (the K117 default) and `'postgres'` are the runtime
 * primaries. An EXPLICIT legacy `fs` / `git-object` opens the in-tree store
 * with a deprecation warning; a DEFAULT-resolved xdg over a root that still
 * carries a legacy in-tree ledger warns that the in-tree ledger is shadowed
 * (both warnings name `cq migrate`; K117 relaxed T505's hard refusal).
 *
 * The store is `init()`-ed before return (mirrors every historical call site).
 */
export async function createLedgerStore(root: string): Promise<ResolvedLedgerStore> {
  const { backend, branch, explicit } = resolveLedgerBackend(root);

  if (backend === "fs" || backend === "git-object") {
    warnLegacyBackendDeprecated(backend, root);
    return openLegacyLedgerStore(root, backend);
  }

  if (backend === "postgres") {
    return createPostgresLedgerStore(root, branch);
  }

  if (!explicit && hasLegacyFsLedger(root)) {
    warnLegacyLedgerShadowedByXdgDefault(root);
  }

  // backend === 'xdg' (T530): the out-of-tree bun:sqlite primary (K102).
  // resolveProjectKey lets ProjectKeyResolutionError propagate as the
  // fail-fast (a shallow clone or a non-git/no-commit root has no stable
  // identity to key the store off — see projectKey.ts's no-fallback
  // rationale, Q246).
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
    return { store, configRoot: root, backend, branch, dbPath, logsDir, backup, projectKey };
  }
  return { store, configRoot: root, backend, branch, dbPath, logsDir, projectKey };
}

/**
 * The `backend = 'postgres'` construction path (T577, G81/M248) —
 * {@link createLedgerStore}'s delegate, split out only for readability.
 *
 * Mirrors the xdg branch's fail-fast shape:
 *  - `resolveProjectKey` lets {@link ProjectKeyResolutionError} propagate
 *    (same no-fallback rationale, Q246) — the postgres backend's tenant key
 *    IS the projectKey, same as xdg's stateDir key.
 *  - `resolvePostgresDsn` lets {@link PostgresDsnResolutionError} propagate
 *    when no connection info is configured (dsn.ts).
 *
 * The display name is the RECONCILED four-rung chain (Q270, displayName.ts):
 * cq.toml `[project].name` > `[ledger].projectId` > the repo root's basename
 * > the projectKey itself (which never fails to resolve). `PostgresLedgerStore`
 * UPSERTs it into `projects.display_name` on every `init()`, so a later
 * cq.toml rename propagates on reconnect.
 *
 * `dbPath`/`logsDir` stay `undefined` (unlike the xdg branch) — this backend's
 * ledger rows AND log artifacts both live in the database, not on this host's
 * filesystem. The returned `pg` handle (pool + resolved dsn + projectKey) is
 * what T578's LISTEN/NOTIFY coherence watcher needs.
 *
 * `[ledger].backup != 'none'` (T582, Q275 full-parity decision): mirrors the
 * xdg branch's {@link BackupScheduler} wiring exactly — `runBackupExport`'s
 * dump builder is store-agnostic (T575's `listLogs` duck-type feeds it this
 * store's tenant-scoped logs in place of a filesystem `logsDir`, which this
 * backend passes as `null`), so the SAME debounced post-mutation trigger the
 * xdg backend uses works unchanged against `PostgresLedgerStore`.
 *
 * On any failure after the pool is opened (schema DDL, tenant bootstrap,
 * `init()`), the pool is closed before the error propagates — otherwise a
 * failed construction would leak a live connection pool.
 */
async function createPostgresLedgerStore(
  root: string,
  branch: string,
): Promise<ResolvedLedgerStore> {
  const config = loadConfig(root);
  const ledgerConfig = config?.ledger;
  if (ledgerConfig === null || ledgerConfig === undefined) {
    // Unreachable in practice: resolveLedgerBackend's no-`[ledger]`-table
    // default resolves to 'fs', never 'postgres' — a second loadConfig here
    // finding no `[ledger]` table would mean cq.toml changed between the two
    // reads. Fail loud rather than silently treat it as misconfigured.
    throw new Error(
      `[ledger] backend = 'postgres' resolved at ${root}, but reloading cq.toml found no ` +
        `[ledger] table — cq.toml may have changed concurrently; re-run.`,
    );
  }

  const projectKey = await resolveProjectKey({
    repoRoot: root,
    projectId: ledgerConfig.projectId,
  });

  const resolution = resolvePostgresDsn(ledgerConfig, process.env);
  const dsn = resolution.kind === "dsn" ? resolution.dsn : "";

  const backupTarget = ledgerConfig.backup;

  const displayName = resolveDisplayName({
    projectName: config?.project?.name,
    projectId: ledgerConfig.projectId,
    repoBasename: basename(root),
    projectKey,
  });

  const pool = openPgPool(dsn);
  try {
    await ensureSchema(pool);
    let backup: BackupScheduler | undefined;
    const store = new PostgresLedgerStore({
      pool,
      projectKey,
      displayName,
      onMutation: () => backup?.schedule(),
    });
    await store.init();
    if (backupTarget !== "none") {
      backup = new BackupScheduler(async () => {
        await runBackupExport({ store, root, target: backupTarget, branch, logsDir: null });
      });
      return {
        store,
        configRoot: root,
        backend: "postgres",
        branch,
        pg: { pool, dsn, projectKey },
        projectKey,
        backup,
      };
    }
    return {
      store,
      configRoot: root,
      backend: "postgres",
      branch,
      pg: { pool, dsn, projectKey },
      projectKey,
    };
  } catch (err) {
    await pool.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Open a LIVE LEGACY backend at `root` — the read path `cq migrate` (T504)
 * uses to export a legacy ledger's state, the construction site for
 * {@link FsLedgerStore} / {@link GitObjectLedgerBackend}, and (since K117)
 * {@link createLedgerStore}'s delegate for an EXPLICIT deprecated
 * `backend = 'fs' | 'git-object'`.
 *
 * `backendOverride` bypasses cq.toml resolution: `cq migrate` passes `'fs'`
 * for the cq.toml-less legacy-tree case (where resolution now yields the
 * K117 `'xdg'` default), and {@link createLedgerStore} passes its
 * already-resolved backend to avoid a second cq.toml read.
 *
 * `init()` is the same idempotent load every historical server start
 * performed — it never rewrites existing content, so a migrate source stays
 * byte-identical. Throws when the resolved backend is not a legacy one
 * (there is no legacy source to open).
 */
export async function openLegacyLedgerStore(
  root: string,
  backendOverride?: "fs" | "git-object",
): Promise<ResolvedLedgerStore> {
  const resolved = resolveLedgerBackend(root);
  const backend = backendOverride ?? resolved.backend;
  const branch = resolved.branch;

  if (backend === "git-object") {
    assertGitWorkTree(root);
    const store = new GitObjectLedgerBackend({ repoRoot: root, ref: branch });
    await store.init();
    return { store, configRoot: root, backend, branch };
  }
  if (backend === "fs") {
    const store = new FsLedgerStore({ root });
    await store.init();
    return { store, configRoot: root, backend, branch };
  }
  throw new Error(
    `openLegacyLedgerStore: [ledger] backend = '${backend}' at ${root} is not a legacy ` +
      `backend — nothing to open (expected 'fs' or 'git-object').`,
  );
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
