/**
 * `cq migrate` (T504 / Q243) — the explicit ONE-SHOT migration from a LEGACY
 * in-repo backend into the out-of-tree xdg primary. There is deliberately NO
 * auto-migration on init (D43-class data-loss territory): this subcommand is
 * the only path, and it NEVER touches the legacy data.
 *
 * Source — whichever legacy backend cq.toml names:
 *   - `fs`         — the tracked `.cq/` tree, read via {@link FsLedgerStore}'s
 *                    public surface (through {@link openLegacyLedgerStore})
 *                    plus the in-tree `.cq/logs/` files;
 *   - `git-object` — the orphan `refs/heads/<branch>` ref, read via
 *                    {@link GitObjectLedgerBackend}'s public surface plus the
 *                    ref's `logs/**` tree entries (the log CAS, Q247) via
 *                    {@link GitPlumbing} — no checkout, no working-tree touch.
 *
 * Both sources are serialised through {@link buildBackupDump} (the SAME
 * public-surface exporter `cq backup` uses) and written into the xdg primary
 * through {@link restoreDumpToXdg} (T503's importer: direct-SQLite row writes
 * preserving every id/timestamp/counter/author/session, group rows, archives,
 * plus log import into the primary logs area) — so migrate's fetch/read_log
 * parity contract is exactly restore's.
 *
 * After a successful import, cq.toml's `[ledger].backend` is flipped to `xdg`
 * ({@link setLedgerBackend}). The legacy data is LEFT IN PLACE UNTOUCHED —
 * the `.cq/` files / orphan ref are byte-identical before and after (reads
 * only); the user deletes them manually once confident.
 *
 * Safety:
 *   - `backend = 'xdg'` already → refuse (no legacy source is configured);
 *   - a NON-EMPTY xdg target → the shared destructive-op confirmation policy
 *     ({@link confirmDestructive}): `--yes` proceeds, a TTY prompts, non-TTY
 *     refuses. An empty target (nothing beyond canonical bootstrap) migrates
 *     unconditionally;
 *   - the legacy source is read and the dump parsed BEFORE any confirmation
 *     or write, so a broken source fails loud without touching the target.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
  buildBackupDump,
  ensureStateDir,
  GitPlumbing,
  isXdgPrimaryEmpty,
  LEDGER_LOGS_DIRNAME,
  LEDGER_STORAGE_DIRNAME,
  openLegacyLedgerStore,
  resolveLedgerBackend,
  resolveLogsDir,
  resolveProjectKey,
  resolveStateDir,
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
  /** `--yes`/`-y`: overwrite a non-empty xdg target without prompting. */
  yes: boolean;
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
  backend: "git-object" | "fs" | "xdg",
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
 * Run `cq migrate`: legacy (fs | git-object) state + logs → the xdg primary,
 * then flip cq.toml's `[ledger].backend` to `xdg`. See the module doc for the
 * full contract.
 */
export async function runMigrate(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  const { backend, branch } = resolveLedgerBackend(args.cwd);

  if (backend === "xdg") {
    io.err(
      `cq migrate: [ledger] backend is already 'xdg' at ${args.cwd} — there is no legacy ` +
        `(fs | git-object) source configured to migrate from. Nothing to do.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  // --- Read the ENTIRE legacy source (state + logs) before any target write.
  // openLegacyLedgerStore (the INTERNAL legacy read path, T505 — the runtime
  // factory createLedgerStore now rejects fs/git-object) constructs + init()s
  // the legacy store (fs reads the tracked .cq/ tree; git-object reads the
  // orphan ref) — init() is the same idempotent load every server start
  // performed; it never rewrites existing content. buildBackupDump reads via
  // the PUBLIC store surface only.
  const legacy = await openLegacyLedgerStore(args.cwd);
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
