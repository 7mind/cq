/**
 * `cq migrate` (T504 / Q243, xdg->postgres leg T581 / Q280) — the explicit
 * ONE-SHOT migration EITHER from a LEGACY in-repo backend into the
 * out-of-tree xdg primary, OR from the xdg primary into the multi-tenant
 * Postgres backend. There is deliberately NO auto-migration on init (D43-class
 * data-loss territory): this subcommand is the only path, and it NEVER
 * touches the migration's source data.
 *
 * Two legs, selected by `--to postgres` (absent = the original legacy->xdg leg):
 *
 * 1. legacy -> xdg (default, no `--to`) — source is whichever legacy backend
 *    cq.toml names:
 *      - `fs`         — the tracked `.cq/` tree, read via {@link FsLedgerStore}'s
 *                       public surface (through {@link openLegacyLedgerStore})
 *                       plus the in-tree `.cq/logs/` files;
 *      - `git-object` — the orphan `refs/heads/<branch>` ref, read via
 *                       {@link GitObjectLedgerBackend}'s public surface plus the
 *                       ref's `logs/**` tree entries (the log CAS, Q247) via
 *                       {@link GitPlumbing} — no checkout, no working-tree touch.
 *    Serialised through {@link buildBackupDump} and written into the xdg
 *    primary through {@link restoreDumpToXdg} (T503's importer), then cq.toml's
 *    `[ledger].backend` flips to `xdg` ({@link setLedgerBackend}).
 *
 * 2. xdg -> postgres (`--to postgres`, T581) — source is the CURRENT xdg
 *    primary (`backend` must already be `xdg`), read via {@link createLedgerStore}
 *    (the same live construction path every product uses) and serialised
 *    through the SAME {@link buildBackupDump}, INCLUDING the out-of-tree logs
 *    dir (Q274 option-3 import — plain filesystem walk, same as the legacy
 *    leg). Imported via {@link restoreDumpToPostgres} (T580's importer: direct
 *    row writes into ONE tenant, preserving every id/timestamp/counter/
 *    author/session, self-registering the `projects` row), then cq.toml's
 *    `[ledger].backend` flips to `postgres`. The Postgres connection is
 *    resolved via {@link resolvePostgresDsn} (env override > cq.toml
 *    `[ledger].url` > `PG*` driver defaults) EVEN THOUGH cq.toml still names
 *    `xdg` at read time — `resolvePostgresDsn` only reads `.url` + env, never
 *    `.backend`.
 *
 * Either leg's source is LEFT IN PLACE UNTOUCHED — read-only access throughout
 * (the `.cq/` files / orphan ref / xdg `ledger.db` are byte-identical before
 * and after); the user deletes the old primary manually once confident.
 *
 * Safety:
 *   - leg 1: `backend = 'xdg'` already (and no `--to postgres`) → refuse (no
 *     legacy source is configured);
 *   - leg 1: a NON-EMPTY xdg target → the shared destructive-op confirmation
 *     policy ({@link confirmDestructive}): `--yes` proceeds, a TTY prompts,
 *     non-TTY refuses. An empty target (nothing beyond canonical bootstrap)
 *     migrates unconditionally;
 *   - leg 2: `--to postgres` with `backend != 'xdg'` → refuse (this leg only
 *     migrates FROM xdg; run `cq migrate` first to reach xdg);
 *   - leg 2: a NON-EMPTY postgres tenant → hard refuse, UNCONDITIONALLY (no
 *     `--yes` override) — mirrors {@link restoreDumpToPostgres}'s own
 *     no-merge-semantics contract (T580);
 *   - both legs: the source is read and the dump parsed BEFORE any
 *     confirmation or write, so a broken source fails loud without touching
 *     the target.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
  buildBackupDump,
  createLedgerStore,
  ensureSchema,
  ensureStateDir,
  GitPlumbing,
  isPostgresTenantEmpty,
  isXdgPrimaryEmpty,
  LEDGER_LOGS_DIRNAME,
  LEDGER_STORAGE_DIRNAME,
  hasLegacyFsLedger,
  openLegacyLedgerStore,
  openPgPool,
  resolveDisplayName,
  resolveLedgerBackend,
  resolveLogsDir,
  resolvePostgresDsn,
  resolveProjectKey,
  resolveStateDir,
  restoreDumpToPostgres,
  restoreDumpToXdg,
  SqliteLedgerStore,
  XDG_DB_FILENAME,
  type BackupDumpFile,
} from "@cq/ledger";
import { loadConfig } from "@cq/config";
import { confirmDestructive, type ConfirmIo } from "./confirm.js";

/** Exit code for a usage / refusal error (mirrors main.ts EXIT_USAGE). */
const EXIT_USAGE = 2;

/** The cq.toml config filename (kept local; see main.ts CQ_CONFIG_FILENAME). */
const CQ_CONFIG_FILENAME = "cq.toml";

/** Result of a `migrate` run: the resolved exit code for the dispatcher. */
export interface MigrateOutcome {
  exitCode: number;
}

/** IO seam: stdout / stderr line sinks + confirmation IO (from the dispatcher). */
export interface MigrateIo {
  out(line: string): void;
  err(line: string): void;
  confirm: ConfirmIo;
}

/** Parsed `migrate` arguments (bridged from the dispatcher's SubcommandArgs). */
export interface MigrateArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  cwd: string;
  /** `--yes`/`-y`: overwrite a non-empty xdg target without prompting (leg 1 only). */
  yes: boolean;
  /**
   * `--to postgres` (T581): selects the xdg -> postgres leg instead of the
   * default legacy -> xdg leg. `null` (the flag absent) is the default leg.
   */
  to: "postgres" | null;
}

/**
 * Read the git-object legacy backend's log artifacts — every `logs/**` tree
 * entry on the orphan ref (the paths `cq log put`'s git-object branch commits,
 * STORAGE-relative, so they match {@link BackupDumpFile}'s `.cq/`-relative
 * path convention verbatim). Read-only plumbing (`ls-tree` + `cat-file`): the
 * ref is never moved. A missing ref contributes no entries.
 */
async function readGitObjectLogs(root: string, branch: string): Promise<BackupDumpFile[]> {
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
  const sha = await git.readRef(ref);
  if (sha === null) return [];
  const prefix = `${LEDGER_LOGS_DIRNAME}/`;
  const paths = (await git.lsTree(ref)).filter((p) => p.startsWith(prefix));
  const files: BackupDumpFile[] = [];
  for (const p of paths) {
    files.push({ path: p, content: await git.catFile(ref, p) });
  }
  return files;
}

/**
 * Set `[ledger] backend = '<backend>'` in `<root>/cq.toml` via a targeted text
 * edit (cq-config has no serialiser). Three cases:
 *  - no cq.toml → create one with a `[ledger]` block;
 *  - cq.toml with an ACTIVE (uncommented) `[ledger]` table → replace its
 *    `backend = ...` line (or insert one right after the header if absent);
 *  - cq.toml WITHOUT an active `[ledger]` table → append a fresh block.
 *
 * Only the `backend` key is touched; any `branch`/`remote` lines are preserved.
 * (Relocated from the retired `cq move-ledger`, T505; migrate is now its only
 * caller.)
 */
export async function setLedgerBackend(
  root: string,
  backend: "git-object" | "fs" | "xdg" | "postgres",
): Promise<void> {
  const configPath = path.join(root, CQ_CONFIG_FILENAME);
  let source: string | null;
  try {
    source = await fsPromises.readFile(configPath, "utf8");
  } catch {
    source = null;
  }

  const block = `[ledger]\n  backend = "${backend}"\n`;

  if (source === null) {
    await fsPromises.writeFile(configPath, block, "utf8");
    return;
  }

  const lines = source.split("\n");
  // Locate an ACTIVE (non-comment) [ledger] table header.
  const headerIdx = lines.findIndex((l) => /^\s*\[ledger\]\s*$/.test(l));
  if (headerIdx < 0) {
    // No active [ledger] table — append a fresh block (one blank-line separated).
    const sep = source.endsWith("\n") ? "\n" : "\n\n";
    await fsPromises.writeFile(configPath, `${source}${sep}${block}`, "utf8");
    return;
  }

  // Find the extent of the [ledger] table: from headerIdx+1 until the next
  // active table header (a line starting with `[`).
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  // Within the table, find an ACTIVE backend assignment.
  let backendIdx = -1;
  for (let i = headerIdx + 1; i < end; i++) {
    if (/^\s*backend\s*=/.test(lines[i] ?? "")) {
      backendIdx = i;
      break;
    }
  }
  if (backendIdx >= 0) {
    // Preserve the original indentation of the line.
    const indent = (lines[backendIdx] ?? "").match(/^\s*/)?.[0] ?? "  ";
    lines[backendIdx] = `${indent}backend = "${backend}"`;
  } else {
    // Insert a backend line right after the header.
    lines.splice(headerIdx + 1, 0, `  backend = "${backend}"`);
  }
  await fsPromises.writeFile(configPath, lines.join("\n"), "utf8");
}

/**
 * Run `cq migrate`: routes to the leg `args.to` selects — the default
 * legacy (fs | git-object) -> xdg leg, or (`--to postgres`) the xdg ->
 * postgres leg (T581). See the module doc for the full contract.
 */
export async function runMigrate(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  if (args.to === "postgres") {
    return runMigrateXdgToPostgres(args, io);
  }
  return runMigrateLegacyToXdg(args, io);
}

/**
 * Leg 1 (default, no `--to`): legacy (fs | git-object) state + logs → the xdg
 * primary, then flip cq.toml's `[ledger].backend` to `xdg`. See the module
 * doc for the full contract.
 */
async function runMigrateLegacyToXdg(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  const resolved = resolveLedgerBackend(args.cwd);
  let backend = resolved.backend;
  const branch = resolved.branch;

  if (backend === "xdg") {
    // K117: with 'xdg' now the DEFAULT resolution, a cq.toml-less legacy repo
    // resolves here too — detect its in-tree fs ledger and migrate it rather
    // than refusing. An EXPLICIT backend = 'xdg' keeps the refusal: the user
    // already flipped, so there is no configured legacy source.
    if (!resolved.explicit && hasLegacyFsLedger(args.cwd)) {
      io.out(
        `cq migrate: no [ledger] backend configured at ${args.cwd}, but a legacy in-tree ` +
          `ledger (${LEDGER_STORAGE_DIRNAME}/ledgers.yaml) is present — migrating it as an ` +
          `'fs' source.`,
      );
      backend = "fs";
    } else {
      io.err(
        `cq migrate: [ledger] backend is already 'xdg' at ${args.cwd} — there is no legacy ` +
          `(fs | git-object) source configured to migrate from. Nothing to do. (Did you mean ` +
          `\`cq migrate --to postgres\`, to migrate the xdg primary onward into postgres?)`,
      );
      return { exitCode: EXIT_USAGE };
    }
  }

  // --- Read the ENTIRE legacy source (state + logs) before any target write.
  // openLegacyLedgerStore (the legacy read path, T505/K117) constructs +
  // init()s the legacy store (fs reads the tracked .cq/ tree; git-object
  // reads the orphan ref) — init() is the same idempotent load every server
  // start performed; it never rewrites existing content. buildBackupDump
  // reads via the PUBLIC store surface only. The resolved source backend is
  // passed explicitly: for the cq.toml-less case above, resolution alone
  // would yield the K117 'xdg' default, not the fs source.
  const legacy = await openLegacyLedgerStore(
    args.cwd,
    backend === "fs" || backend === "git-object" ? backend : undefined,
  );
  let dump: BackupDumpFile[];
  try {
    const fsLogsDir =
      backend === "fs"
        ? path.join(args.cwd, LEDGER_STORAGE_DIRNAME, LEDGER_LOGS_DIRNAME)
        : null;
    dump = await buildBackupDump(legacy.store, fsLogsDir);
    if (backend === "git-object") {
      dump.push(...(await readGitObjectLogs(args.cwd, branch)));
    }
  } finally {
    await legacy.store.dispose();
  }

  // --- Resolve the xdg TARGET the flipped backend will use — the same
  // projectKey -> stateDir/logsDir derivation as createLedgerStore's xdg
  // branch (which is unusable here: cq.toml still names the legacy backend).
  // A ProjectKeyResolutionError propagates as the fail-fast (Q246).
  const config = loadConfig(args.cwd);
  const projectId = config?.ledger?.projectId ?? null;
  const projectKey = await resolveProjectKey({ repoRoot: args.cwd, projectId });
  const stateDir = resolveStateDir(projectKey);
  await ensureStateDir(stateDir);
  const dbPath = path.join(stateDir, XDG_DB_FILENAME);
  const logsDir = resolveLogsDir(projectKey);

  // --- Refuse to clobber a NON-EMPTY target without confirmation. The probe
  // store's init() is the same idempotent bootstrap the xdg backend runs on
  // every start; isXdgPrimaryEmpty treats that canonical state as empty.
  const probe = new SqliteLedgerStore({ dbPath, logsDir });
  await probe.init();
  const targetEmpty = isXdgPrimaryEmpty(probe);
  await probe.dispose();
  if (!targetEmpty) {
    const decision = await confirmDestructive(
      args.yes,
      `Migrate will OVERWRITE the non-empty xdg primary at ${dbPath}? [y/N] `,
      `cq migrate: refusing to overwrite the non-empty xdg primary at ${dbPath} without ` +
        `confirmation; re-run with --yes to migrate non-interactively.`,
      io.confirm,
    );
    if (!decision.proceed) {
      return { exitCode: decision.exitCode };
    }
  }

  // --- Import, then flip the backend. The legacy source is never written.
  const summary = await restoreDumpToXdg({ dbPath, logsDir, dump });
  await setLedgerBackend(args.cwd, "xdg");

  const legacyLocation =
    backend === "fs"
      ? `${path.join(args.cwd, LEDGER_STORAGE_DIRNAME)}${path.sep} (the tracked files)`
      : `the orphan ref refs/heads/${branch}`;
  io.out(
    `cq migrate: migrated the legacy '${backend}' ledger at ${args.cwd} into the out-of-tree xdg primary`,
  );
  io.out(`  ledgers:  ${summary.ledgerCount} (items + archives, ${summary.fileCount} dump file(s))`);
  io.out(`  logs:     ${summary.logCount} artifact(s)`);
  io.out(`  state:    ${dbPath}`);
  io.out(`  logs dir: ${logsDir}`);
  io.out(`  ${CQ_CONFIG_FILENAME}:  [ledger] backend = "xdg"`);
  io.out(
    `  legacy data left UNTOUCHED at ${legacyLocation} — delete it manually once confident.`,
  );
  return { exitCode: 0 };
}

/**
 * Leg 2 (`--to postgres`, T581 / Q280): the xdg primary's state + logs → a
 * Postgres tenant, then flip cq.toml's `[ledger].backend` to `postgres`. See
 * the module doc for the full contract.
 */
async function runMigrateXdgToPostgres(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  const { backend, explicit } = resolveLedgerBackend(args.cwd);
  if (backend === "xdg" && !explicit) {
    // K117: 'xdg' is now also the DEFAULT resolution (no cq.toml / no
    // [ledger].backend key). This leg needs a real cq.toml to read the
    // committed DSN context from and to flip to 'postgres' afterwards —
    // refuse cleanly rather than fall through to the (previously
    // unreachable) config===null internal error below.
    io.err(
      `cq migrate --to postgres: no [ledger] backend configured at ${args.cwd} (the 'xdg' ` +
        `resolution is the default, not a committed choice). Run \`cq init\` (or \`cq migrate\` ` +
        `from a legacy tree) to write cq.toml with backend = "xdg" first, then ` +
        `\`cq migrate --to postgres\`.`,
    );
    return { exitCode: EXIT_USAGE };
  }
  if (backend !== "xdg") {
    io.err(
      `cq migrate --to postgres: [ledger] backend at ${args.cwd} is '${backend}', not 'xdg' — ` +
        `the xdg -> postgres leg migrates the OUT-OF-TREE xdg primary onward; it does not read a ` +
        `legacy (fs | git-object) source directly. Run \`cq migrate\` (no --to) first to reach ` +
        `xdg, then \`cq migrate --to postgres\`.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  // --- Read the ENTIRE xdg source (state + logs) before any target write.
  // createLedgerStore is the SAME live construction path every product uses
  // for backend='xdg' — no need to re-derive stateDir/dbPath/logsDir by hand
  // (unlike leg 1, where cq.toml still names the legacy backend and the xdg
  // TARGET location has to be computed ahead of the flip).
  const resolved = await createLedgerStore(args.cwd);
  let dump: BackupDumpFile[];
  const projectKey = resolved.projectKey;
  const dbPath = resolved.dbPath;
  const logsDir = resolved.logsDir;
  if (projectKey === undefined || dbPath === undefined || logsDir === undefined) {
    // Unreachable in practice: createLedgerStore's xdg branch always returns
    // projectKey/dbPath/logsDir. Guarded so a future refactor there fails
    // loud here rather than silently mis-migrating.
    await resolved.store.dispose();
    throw new Error(
      `cq migrate --to postgres: internal error — the xdg store at ${args.cwd} resolved without ` +
        `a projectKey/dbPath/logsDir (backend='${resolved.backend}').`,
    );
  }
  try {
    dump = await buildBackupDump(resolved.store, logsDir);
  } finally {
    await resolved.store.dispose();
  }

  // --- Resolve the postgres TARGET connection. cq.toml still names 'xdg' at
  // this point (the flip happens only after a successful import) —
  // resolvePostgresDsn only reads `.url` + env, never `.backend`, so this is
  // safe to call before the flip. A ProjectKeyResolutionError already
  // propagated above (via createLedgerStore); PostgresDsnResolutionError
  // propagates here the same fail-fast way.
  const config = loadConfig(args.cwd);
  if (config === null || config.ledger === null) {
    // Unreachable: the explicit-xdg guard above already required a cq.toml
    // with a [ledger].backend key (a DEFAULT-resolved xdg refuses with
    // EXIT_USAGE, K117) — cq.toml would have had to change concurrently
    // between the two reads.
    throw new Error(
      `cq migrate --to postgres: [ledger] backend='xdg' resolved at ${args.cwd}, but reloading ` +
        `cq.toml found no [ledger] table — cq.toml may have changed concurrently; re-run.`,
    );
  }
  const ledgerConfig = config.ledger;
  const resolution = resolvePostgresDsn(ledgerConfig, process.env);
  const dsn = resolution.kind === "dsn" ? resolution.dsn : "";
  const displayName = resolveDisplayName({
    projectName: config.project?.name,
    projectId: ledgerConfig.projectId,
    repoBasename: path.basename(args.cwd),
    projectKey,
  });

  const pool = openPgPool(dsn);
  try {
    await ensureSchema(pool);

    // --- Refuse to clobber a NON-EMPTY tenant — UNCONDITIONALLY (no --yes
    // override), mirroring restoreDumpToPostgres's own no-merge contract.
    const targetEmpty = await isPostgresTenantEmpty(pool, projectKey);
    if (!targetEmpty) {
      io.err(
        `cq migrate --to postgres: refusing — the postgres tenant "${displayName}" ` +
          `(project_key ${projectKey}) already holds data beyond the canonical bootstrap state; ` +
          `migrate never merges into a non-empty target.`,
      );
      return { exitCode: EXIT_USAGE };
    }

    // --- Import, then flip the backend. The xdg source is never written.
    const summary = await restoreDumpToPostgres({ pool, projectKey, displayName, dump });
    await setLedgerBackend(args.cwd, "postgres");

    io.out(
      `cq migrate: migrated the xdg primary at ${args.cwd} into postgres tenant "${displayName}" ` +
        `(project_key ${projectKey})`,
    );
    io.out(`  ledgers:  ${summary.ledgerCount} (items + archives, ${summary.fileCount} dump file(s))`);
    io.out(`  logs:     ${summary.logCount} artifact(s)`);
    io.out(`  ${CQ_CONFIG_FILENAME}:  [ledger] backend = "postgres"`);
    io.out(`  xdg primary left UNTOUCHED at ${dbPath} — delete it manually once confident.`);
    return { exitCode: 0 };
  } finally {
    await pool.close();
  }
}
