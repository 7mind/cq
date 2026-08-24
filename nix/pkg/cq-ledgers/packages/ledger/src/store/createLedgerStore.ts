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
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig, type LedgerBackend } from "@cq/config";
import type { LedgerStore } from "./LedgerStore.js";
import { FsLedgerStore } from "./FsLedgerStore.js";
import { GitObjectLedgerBackend } from "./git/GitObjectLedgerBackend.js";
import { SqliteLedgerStore } from "./sqlite/SqliteLedgerStore.js";
import { coherenceVersion, openLedgerDb } from "./sqlite/connection.js";
import { SqliteXdgProjectIdentityAccess } from "./sqlite/projectIdentity.js";
import { resolveDisplayName } from "./postgres/displayName.js";
import { LEDGER_STORAGE_DIRNAME } from "../constants.js";
import { resolveProjectKey } from "../projectKey.js";
import { resolveStateDir, resolveLogsDir, ensureStateDir } from "../stateDir.js";
import { BackupScheduler, runBackupExport } from "./backupExporter.js";
import {
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
} from "../worksetInvocationAuthority.js";
import {
  createFsImplementationEvidenceStore,
  protectLedgerStoreWithImplementationEvidence,
  type ImplementationEvidenceStore,
} from "../implementationEvidence.js";

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
  /** Protected append-only implementation review/completion authority. */
  readonly implementationEvidenceStore?: ImplementationEvidenceStore;
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
   * {@link startXdgCoherenceWatcher} polls a domain-state version to
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
   * This repo's resolved `projectKey` (T585 / Q284) — the SAME value
   * `resolveProjectKey` computed to key the xdg `stateDir`, exposed here so
   * ledger-mcp's `createLedgerMcpServer` can synthesize the single-project
   * `list_projects` fallback entry without re-resolving it. `undefined` only
   * for the legacy backends {@link openLegacyLedgerStore} returns.
   */
  readonly projectKey?: string;
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
 * Raised while the remote client adapter remains downstream of the additive
 * config cutover. Every local dispatch boundary must reject this backend
 * explicitly so it cannot fall through to filesystem, SQLite, or Postgres.
 */
export class RemoteLedgerClientNotWiredError extends Error {
  constructor(operation: string, root: string) {
    super(
      `[ledger] backend = 'remote' at ${root} cannot run ${operation}: the remote ledger client ` +
        `is not wired yet; refusing to fall through to local persistence.`,
    );
    this.name = "RemoteLedgerClientNotWiredError";
  }
}

/** Raised when a checkout still names the retired public postgres backend. */
export class PublicPostgresBackendRetiredError extends Error {
  constructor(operation: string, root: string) {
    super(
      `[ledger] backend = 'postgres' at ${root} cannot run ${operation}: PostgreSQL is private ` +
        `cq serve state. Set backend = "remote" and use CQ_LEDGER_REMOTE_TOKEN.`,
    );
    this.name = "PublicPostgresBackendRetiredError";
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
 * primaries. `backend = 'remote'` fails before local construction until its
 * downstream client adapter lands. An EXPLICIT legacy `fs` / `git-object`
 * opens the in-tree store with a deprecation warning; a DEFAULT-resolved xdg
 * over a root that still carries a legacy in-tree ledger warns that the
 * in-tree ledger is shadowed (both warnings name `cq migrate`; K117 relaxed
 * T505's hard refusal).
 *
 * The store is `init()`-ed before return (mirrors every historical call site).
 */
async function createLedgerStoreWithAuthority(
  root: string,
  worksetAuthority: unknown,
): Promise<ResolvedLedgerStore> {
  const { backend, branch, explicit } = resolveLedgerBackend(root);

  if (backend === "remote") {
    throw new RemoteLedgerClientNotWiredError("createLedgerStore", root);
  }

  if (backend === "fs" || backend === "git-object") {
    warnLegacyBackendDeprecated(backend, root);
    return openLegacyLedgerStore(root, backend, worksetAuthority);
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
    worksetAuthority,
  });
  await store.init();
  try {
    const repositoryPath = await realpath(root);
    const displayName = resolveDisplayName({
      projectName: config?.project?.name,
      projectId,
      repoBasename: basename(repositoryPath),
      projectKey,
    });
    const identityDb = openLedgerDb(dbPath);
    try {
      new SqliteXdgProjectIdentityAccess(identityDb).upsertProjectIdentity({
        repositoryPath,
        displayName,
      });
    } finally {
      identityDb.close();
    }
  } catch (err) {
    await store.dispose().catch(() => undefined);
    throw err;
  }
  if (backupTarget !== "none") {
    backup = new BackupScheduler(async () => {
      await runBackupExport({ store, root, target: backupTarget, branch, logsDir });
    });
    const implementationEvidenceStore = createFsImplementationEvidenceStore({
      path: join(stateDir, "implementation-evidence.json"),
    });
    return {
      store: protectLedgerStoreWithImplementationEvidence(store, implementationEvidenceStore),
      implementationEvidenceStore,
      configRoot: root,
      backend,
      branch,
      dbPath,
      logsDir,
      backup,
      projectKey,
    };
  }
  const implementationEvidenceStore = createFsImplementationEvidenceStore({
    path: join(stateDir, "implementation-evidence.json"),
  });
  return {
    store: protectLedgerStoreWithImplementationEvidence(store, implementationEvidenceStore),
    implementationEvidenceStore,
    configRoot: root,
    backend,
    branch,
    dbPath,
    logsDir,
    projectKey,
  };
}

/** Ordinary embedded/CLI construction: observe-only workset authority. */
export async function createLedgerStore(root: string): Promise<ResolvedLedgerStore> {
  return await createLedgerStoreWithAuthority(root, createObserveOnlyWorksetInvocationAuthority());
}

/** Dedicated trusted-host construction for direct administrative CLI paths. */
export async function createManagementLedgerStore(root: string): Promise<ResolvedLedgerStore> {
  return await createLedgerStoreWithAuthority(root, createTrustedWorksetManagementAuthority());
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
  worksetAuthority: unknown = createObserveOnlyWorksetInvocationAuthority(),
): Promise<ResolvedLedgerStore> {
  const resolved = resolveLedgerBackend(root);
  const backend = backendOverride ?? resolved.backend;
  const branch = resolved.branch;

  if (backend === "git-object") {
    assertGitWorkTree(root);
    const store = new GitObjectLedgerBackend({
      repoRoot: root,
      ref: branch,
      worksetAuthority,
    });
    await store.init();
    const implementationEvidenceStore = createFsImplementationEvidenceStore({
      path: join(root, LEDGER_STORAGE_DIRNAME, "protected", "implementation-evidence.json"),
    });
    return {
      store: protectLedgerStoreWithImplementationEvidence(store, implementationEvidenceStore),
      implementationEvidenceStore,
      configRoot: root,
      backend,
      branch,
    };
  }
  if (backend === "fs") {
    const store = new FsLedgerStore({ root, worksetAuthority });
    await store.init();
    const implementationEvidenceStore = createFsImplementationEvidenceStore({
      path: join(root, LEDGER_STORAGE_DIRNAME, "protected", "implementation-evidence.json"),
    });
    return {
      store: protectLedgerStoreWithImplementationEvidence(store, implementationEvidenceStore),
      implementationEvidenceStore,
      configRoot: root,
      backend,
      branch,
    };
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
 * for the other backends, keyed here off the persisted domain-state version
 * instead of a filesystem event or a ref sha.
 *
 * Opens its OWN probe connection to `dbPath` (never touches `store`'s
 * internals) and polls {@link coherenceVersion} every `pollMs`. SQLite
 * triggers bump that counter for persisted domain state while MCP usage
 * telemetry does not invalidate the derived search index or notify frontend
 * clients. The counter carries no per-ledger scope, so a bump invalidates
 * every ledger `store` currently knows (`store.enumerate()`).
 *
 * `onChange`, when given, fires ONCE per invalidate pass with `null` (never a
 * ledger id) — the counter carries no per-ledger scope to report, matching
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
  let lastVersion = coherenceVersion(probe);
  let invalidating = false;

  const timer = setInterval(() => {
    if (invalidating) return;
    const current = coherenceVersion(probe);
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
