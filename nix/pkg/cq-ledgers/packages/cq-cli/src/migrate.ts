/**
 * `cq migrate` (T504 / Q243, remote owner T731 / T736) — the explicit
 * ONE-SHOT migration EITHER from a LEGACY in-repo backend into the
 * out-of-tree xdg primary, OR from the xdg primary into a `cq serve` tenant
 * over project-admin MCP. There is deliberately NO auto-migration on init
 * (D43-class data-loss territory): this subcommand is the only path, and it
 * NEVER touches the migration's source data.
 *
 * Two legs, selected by `--to remote` (absent = the original legacy->xdg leg):
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
 * 2. xdg -> remote (`--to remote`, T731) — source is the CURRENT xdg primary
 *    (`backend` must already be explicit `xdg`). The dump is imported through
 *    project-admin `import_dump` with `intent=migrate-empty`, then cq.toml's
 *    `[ledger].backend` flips to `remote`. The hub origin is `CQ_LEDGER_SERVER_URL`;
 *    the admin secret is `CQ_LEDGER_REMOTE_ADMIN_TOKEN`. Public `--to postgres`
 *    is retired at the dispatcher.
 *
 * Either leg's source data remains in place so recovery remains possible. The
 * workset records the durable administrative admission used for exclusion;
 * the user deletes the old primary manually once confident.
 *
 * Safety:
 *   - leg 1: `backend = 'xdg'` already (and no `--to`) → refuse (no legacy
 *     source is configured);
 *   - leg 1: a NON-EMPTY xdg target → the shared destructive-op confirmation
 *     policy ({@link confirmDestructive}): `--yes` proceeds, a TTY prompts,
 *     non-TTY refuses. An empty target (nothing beyond canonical bootstrap)
 *     migrates unconditionally;
 *   - leg 2: `--to remote` with a non-explicit-xdg backend → refuse;
 *   - both legs: the source is read and the dump parsed BEFORE any
 *     confirmation or write, so a broken source fails loud without touching
 *     the target.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildBackupDump,
  createManagementLedgerStore,
  createFsWorksetStore,
  createGitObjectWorksetStore,
  ensureStateDir,
  GitPlumbing,
  isXdgPrimaryEmpty,
  LEDGER_LOGS_DIRNAME,
  LEDGER_STORAGE_DIRNAME,
  hasLegacyFsLedger,
  openLegacyLedgerStore,
  resolveLedgerBackend,
  resolveLogsDir,
  resolveProjectKey,
  resolveStateDir,
  prepareImportedOwnershipDump,
  RemoteLedgerClient,
  restoreDumpToXdg,
  RestoreTargetChangedError,
  createTrustedWorksetManagementAuthority,
  SqliteLedgerStore,
  XDG_DB_FILENAME,
  type BackupDumpFile,
  type WorksetStore,
} from "@cq/ledger";
import { loadConfig } from "@cq/config";
import { resolveRemoteAdminToken } from "@cq/config";
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
   * `--to remote` (T731): selects the xdg -> cq serve tenant leg instead of
   * the default legacy -> xdg leg. `null` (the flag absent) is the default leg.
   */
  to: "remote" | null;
}

async function runUnderMigrationAdmission<T>(
  workset: WorksetStore,
  body: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let completed = false;
  await workset.runAdministrative({
    kind: "backend-migration",
    authority: createTrustedWorksetManagementAuthority(),
    destructivePhase: async () => {
      result = await body();
      completed = true;
    },
  });
  if (!completed) throw new Error("backend migration admission completed without a result");
  return result as T;
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
  backend: "git-object" | "fs" | "xdg" | "remote",
  extras: Readonly<Record<string, string>> = {},
): Promise<void> {
  const configPath = path.join(root, CQ_CONFIG_FILENAME);
  let source: string | null;
  try {
    source = await fsPromises.readFile(configPath, "utf8");
  } catch {
    source = null;
  }

  const extraLines = Object.entries(extras).map(([key, value]) => `  ${key} = "${value}"`);
  const block = [`[ledger]`, `  backend = "${backend}"`, ...extraLines, ""].join("\n");

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
    backendIdx = headerIdx + 1;
    end += 1;
  }
  let insertAt = backendIdx + 1;
  for (const [key, value] of Object.entries(extras)) {
    const extraRe = new RegExp(`^\\s*${key}\\s*=`);
    let extraIdx = -1;
    for (let i = headerIdx + 1; i < end; i++) {
      if (extraRe.test(lines[i] ?? "")) {
        extraIdx = i;
        break;
      }
    }
    if (extraIdx >= 0) {
      const indent = (lines[extraIdx] ?? "").match(/^\s*/)?.[0] ?? "  ";
      lines[extraIdx] = `${indent}${key} = "${value}"`;
    } else {
      lines.splice(insertAt, 0, `  ${key} = "${value}"`);
      insertAt += 1;
      end += 1;
    }
  }
  await fsPromises.writeFile(configPath, lines.join("\n"), "utf8");
}

/**
 * Run `cq migrate`: routes to the leg `args.to` selects — the default
 * legacy (fs | git-object) -> xdg leg, or (`--to remote`) the xdg ->
 * cq serve tenant leg (T731). See the module doc for the full contract.
 */
export async function runMigrate(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  if (args.to === "remote") {
    return runMigrateXdgToRemote(args, io);
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
          `\`cq migrate --to remote\`, to upload the xdg primary into a cq serve tenant?)`,
      );
      return { exitCode: EXIT_USAGE };
    }
  }

  const sourceWorkset =
    backend === "git-object"
      ? await createGitObjectWorksetStore({ repoRoot: args.cwd, ref: branch })
      : createFsWorksetStore({ root: args.cwd });
  return runUnderMigrationAdmission(sourceWorkset, async () => {
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
        backend === "fs" ? path.join(args.cwd, LEDGER_STORAGE_DIRNAME, LEDGER_LOGS_DIRNAME) : null;
      dump = await buildBackupDump(legacy.store, fsLogsDir);
      if (backend === "git-object") {
        dump.push(...(await readGitObjectLogs(args.cwd, branch)));
      }
    } finally {
      await legacy.store.dispose();
    }
    // T1977: contextual legacy inference is pure and completes before the xdg
    // destination path is resolved or opened. A conflicting sealed/evidence
    // relation therefore cannot observe, create, or mutate the target.
    const preparedOwnership = prepareImportedOwnershipDump(dump, "infer-unambiguous-legacy");

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
    const targetEmpty = await isXdgPrimaryEmpty(probe);
    await probe.dispose();
    let overwriteAuthorized = args.yes;
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
      overwriteAuthorized = true;
    }

    // --- Import, then flip the backend. The legacy ledger data is not rewritten.
    let summary;
    try {
      summary = await restoreDumpToXdg({
        dbPath,
        logsDir,
        preparedOwnership,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized,
        administrativeKind: "backend-migration",
      });
    } catch (error) {
      if (!(error instanceof RestoreTargetChangedError)) throw error;
      io.err(
        `cq migrate: refusing to overwrite the xdg primary at ${dbPath}; ` +
          `it became non-empty after the initial check`,
      );
      return { exitCode: EXIT_USAGE };
    }
    await setLedgerBackend(args.cwd, "xdg");

    const legacyLocation =
      backend === "fs"
        ? `${path.join(args.cwd, LEDGER_STORAGE_DIRNAME)}${path.sep} (the tracked files)`
        : `the orphan ref refs/heads/${branch}`;
    io.out(
      `cq migrate: migrated the legacy '${backend}' ledger at ${args.cwd} into the out-of-tree xdg primary`,
    );
    io.out(
      `  ledgers:  ${summary.ledgerCount} (items + archives, ${summary.fileCount} dump file(s))`,
    );
    io.out(`  logs:     ${summary.logCount} artifact(s)`);
    io.out(`  state:    ${dbPath}`);
    io.out(`  logs dir: ${logsDir}`);
    io.out(`  ${CQ_CONFIG_FILENAME}:  [ledger] backend = "xdg"`);
    io.out(
      `  legacy data left UNTOUCHED at ${legacyLocation} — delete it manually once confident.`,
    );
    return { exitCode: 0 };
  });
}

async function runMigrateXdgToRemote(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  const { backend, explicit } = resolveLedgerBackend(args.cwd);
  if (backend !== "xdg" || !explicit) {
    io.err(
      `cq migrate --to remote: [ledger] backend at ${args.cwd} must be explicit 'xdg'.`,
    );
    return { exitCode: EXIT_USAGE };
  }
  const serverUrl = process.env["CQ_LEDGER_SERVER_URL"]?.trim() ?? "";
  if (serverUrl === "") {
    io.err("cq migrate --to remote: CQ_LEDGER_SERVER_URL must be set to the cq serve origin");
    return { exitCode: EXIT_USAGE };
  }
  const resolved = await createManagementLedgerStore(args.cwd);
  const projectKey = resolved.projectKey;
  const logsDir = resolved.logsDir;
  if (projectKey === undefined || logsDir === undefined) {
    await resolved.store.dispose();
    throw new Error("cq migrate --to remote: xdg store resolved without projectKey/logsDir");
  }
  try {
    const dump = await buildBackupDump(resolved.store, logsDir);
    const operationId = `migrate-${randomUUID()}`;
    const adminToken = resolveRemoteAdminToken(process.env);
    const client = await RemoteLedgerClient.connectAdmin({
      serverUrl,
      projectKey,
      adminToken,
    });
    try {
      await client.importDump(operationId, "migrate-empty", dump);
    } finally {
      await client.close();
    }
    await setLedgerBackend(args.cwd, "remote", { serverUrl });
    io.out(`cq migrate: uploaded the xdg primary at ${args.cwd} to remote tenant ${projectKey}`);
    io.out(`  ${CQ_CONFIG_FILENAME}:  [ledger] backend = "remote"`);
    io.out("  xdg primary data left INTACT — delete it manually once confident.");
    return { exitCode: 0 };
  } finally {
    await resolved.store.dispose();
  }
}
