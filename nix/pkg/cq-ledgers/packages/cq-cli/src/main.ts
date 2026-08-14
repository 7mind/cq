#!/usr/bin/env -S bun run
/**
 * cq — the ledger-suite CLI.
 *
 * An argv dispatcher routing the FIRST positional argument to one of three
 * subcommands operating on a ledger root:
 *
 *   cq init  [--cwd <path>]            # initialise the canonical ledger set
 *   cq reset [--cwd <path>] [--yes|-y] # backup + reinit (destructive)
 *   cq erase [--cwd <path>] [--yes|-y] # remove the ledger tree (destructive)
 *
 * Ledger-root precedence (shared with ledger-mcp / ledger-web): each subcommand
 * resolves its root as `--cwd > $LEDGER_ROOT > process CWD`; a relative value
 * resolves against the CWD.
 *
 * This module hosts the dispatcher, the shared confirmation helper (see
 * ./confirm.ts), and the subcommand handlers. `init` (T189), `reset` (T190),
 * and `erase` (T191) are implemented.
 *
 * Unknown or absent subcommand → usage to stderr + exit 2.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  createLedgerStore,
  createManagementLedgerStore,
  CANONICAL_LEDGERS,
  removeLedgerArtifacts,
  LEDGER_STORAGE_DIRNAME,
  resolveLedgerBackend,
  resolveStateDirBase,
  resolveProjectKey,
  runBackupExport,
  readDumpInTree,
  readDumpOrphanBranch,
  restoreDumpToXdg,
  RestoreTargetChangedError,
  isXdgPrimaryEmpty,
  restoreDumpToPostgres,
  isPostgresTenantEmpty,
  createTrustedWorksetManagementAuthority,
  createPostgresWorksetStore,
  createSqliteWorksetStore,
  openExistingLedgerDb,
  PostgresLedgerStore,
  XDG_DB_FILENAME,
  RemoteLedgerClientNotWiredError,
  PostgresDsnResolutionError,
  type LedgerStore,
  type ResetSummary,
} from "@cq/ledger";
import { CQ_CONFIG_FILENAME, loadConfig, resolveGlobalConfigPath } from "@cq/config";
import {
  EXIT_REFUSED,
  type ConfirmIo,
  defaultConfirmIo,
  confirmDestructive,
} from "./confirm.js";
import { CQ_TOML_GLOBAL_TEMPLATE, CQ_TOML_TEMPLATE } from "./cqTomlTemplate.js";
import { runMigrate } from "./migrate.js";
import { runAdvanceGate } from "./advanceGate.js";
import { runPredicates } from "./predicates.js";
import { runCounts } from "./counts.js";
import { runConfig } from "./config.js";
import { runStats } from "./stats.js";
import { runGateRun } from "./gateRun.js";
import { parseLogPutArgs, runLogPut, EXIT_USAGE as LOG_PUT_EXIT_USAGE } from "./logPut.js";
import {
  resolvePostgresTenant,
  countTenantActiveItems,
  wipeTenantRows,
  type PostgresTenantHandle,
} from "./postgresTenant.js";

export { CQ_CONFIG_FILENAME };

export { type ConfirmIo, type ConfirmOutcome, defaultConfirmIo, confirmDestructive } from "./confirm.js";

/** Exit code for an unknown/absent subcommand (usage error). */
export const EXIT_USAGE = 2;

/** The subcommands the dispatcher routes to. */
export const SUBCOMMANDS = ["init", "reset", "erase", "move-ledger", "advance-gate", "predicates", "counts", "config", "stats", "log", "backup", "restore", "migrate", "gate"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

/**
 * The product MODES the dispatcher delegates to BEFORE native subcommand
 * parsing. When `argv[0]` is one of these, the dispatcher dynamically imports
 * the matching workspace product and calls its exported `main(argv.slice(1))`
 * with the post-mode args VERBATIM — no flag re-parse, no native parsing. The
 * delegated `main` owns its own argv contract (`--help`, nested subcommands like
 * `cq mcp restore`, embedded-vs-remote selection by `--mcp-url` absence, etc.).
 *
 * `tui`/`web` delegate to long-running entries (Ink render / web server); their
 * awaited `main` resolves only when the process exits, mirroring the standalone
 * bins. `mcp` keeps stdout PROTOCOL-ONLY — the dispatcher prints nothing on it.
 *
 * `serve` (T586) is the pure-CLI multi-tenant hub server skeleton: unlike
 * every other mode it resolves NO ledger root at all (no `--cwd`, no
 * `cq.toml`) — its config is `--pg-url`/`--host`/`--port`/`--token` (+ env DSN
 * fallback) only. It delegates to `@cq/ledger-web`'s `hubServe.ts` module
 * (imported via the `@cq/ledger-web/hub` subpath, distinct from `web`'s
 * `serve.ts` entry) rather than its `main` export.
 */
export const MODES = ["mcp", "tui", "web", "serve"] as const;
export type Mode = (typeof MODES)[number];

function isMode(s: string): s is Mode {
  return (MODES as readonly string[]).includes(s);
}

/**
 * Delegate a MODE to its product's exported argv-taking `main`, called with the
 * post-mode args verbatim. Imports are dynamic so the heavy product trees (Ink,
 * the web server, the MCP SDK) load only when their mode is actually invoked.
 *
 * Exposed as a seam so the dispatch-routing unit test (T389) can substitute the
 * delegated mains and assert the verbatim `argv.slice(1)` pass-through without
 * launching a real server / Ink render. The default loads the real products.
 */
export interface ModeDelegates {
  mcp(argv: readonly string[]): Promise<void>;
  tui(argv: readonly string[]): Promise<void>;
  web(argv: readonly string[]): Promise<void>;
  serve(argv: readonly string[]): Promise<void>;
}

function defaultModeDelegates(): ModeDelegates {
  return {
    mcp: async (argv) => (await import("@cq/ledger-mcp")).main(argv),
    tui: async (argv) => (await import("@cq/ledger-tui")).main(argv),
    web: async (argv) => (await import("@cq/ledger-web")).main(argv),
    serve: async (argv) => (await import("@cq/ledger-web/hub")).main(argv),
  };
}

/** Flags common to all subcommands plus the destructive-op confirmation flag. */
export interface SubcommandArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  cwd: string;
  /** `--yes`/`-y`: skip the interactive confirmation (destructive subcommands). */
  yes: boolean;
  /** `--force`: overwrite an existing cq.toml when running `cq init`. */
  force: boolean;
  /** `--global`: scaffold the XDG global cq.toml without opening a project store. */
  global: boolean;
  /**
   * `--session <id>`: the `advance-gate` session id whose advance marker is
   * consulted. `null` when the flag is absent (the handler then falls back to
   * `$CLAUDE_CODE_SESSION_ID`); other subcommands ignore it.
   */
  session: string | null;
  /**
   * `--to <value>`: `migrate`'s target-leg selector (T581) — the RAW string
   * value, unvalidated here (mirrors `--session`'s leniency, and matters for
   * the RETIRED `move-ledger` subcommand, which also recognised a `--to
   * <local|git>` flag it now ignores — see move-ledger.test.ts's "old flags
   * ignored" contract). `runMigrateCmd` is the ONE place that validates it
   * against `"postgres"`. `null` when the flag is absent.
   */
  to: string | null;
}

export const USAGE = [
  "usage: cq <mode|command> [options]",
  "",
  "modes (delegate verbatim to the product binary):",
  "  mcp         [--cwd <path>] [--http [host:]port] [--tool-prefix <p>]",
  "                                                  run the MCP server (stdio or HTTP)",
  "  tui         [--cwd <path>] [--mcp-url <url>]    run the terminal UI",
  "  web         [--port <n>] [--host <h>] [--cwd <path>] [--mcp-url <url>]",
  "                                                  run the web UI (default port 5180)",
  "  serve       --pg-url <dsn> [--host <h>] [--port <n>] [--token <t>]",
  "              [--management-token <t>]",
  "                                                  run the multi-tenant hub server (default port",
  "                                                  5190); NO --cwd/cq.toml — DSN resolves from",
  "                                                  --pg-url, else $CQ_LEDGER_PG_URL/$DATABASE_URL.",
  "                                                  --token is REQUIRED for a non-loopback --host",
  "                                                  management token must differ from --token",
  "                                                  (Q273); once set, /mcp + the projects API need",
  "                                                  Authorization: Bearer <token>, /ws needs ?token=",
  "                                                  (the web UI reads/forwards it from its own URL).",
  "",
  "commands:",
  "  init        [--cwd <path>] [--force] [--global] initialise the canonical ledger set",
  "                                                  --global scaffolds only the XDG global cq.toml",
  "  reset       [--cwd <path>] [--yes|-y]           backup + reinitialise the ledgers (destructive)",
  "  erase       [--cwd <path>] [--yes|-y]           remove the ledger tree (destructive)",
  "  move-ledger                                     RETIRED (T505): the fs<->git-object transplant",
  "                                                  is superseded by `cq migrate` (legacy -> xdg)",
  "  advance-gate [--cwd <path>] [--session <id>]    emit the neutral /cq:advance stop-gate verdict",
  "                                                  JSON (block + reason + predicates) to stdout;",
  "                                                  exit 0 = allow, non-zero = block.",
  "  predicates  [--cwd <path>]                      emit the derived flow predicates JSON",
  "                                                  ({ predicates: { pInvestigate, pSeed, pPlan,",
  "                                                  pResearch, pImplement, pOperatorAction, openQuestionGate,",
  "                                                  belowFloor, planBusy, goalDrift } })",
  "                                                  to stdout UNCONDITIONALLY;",
  "                                                  no session/marker, always exit 0.",
  "  counts      [--cwd <path>]                      emit the ledger-summaries JSON",
  "                                                  ({ ledgers, counts, ledgerSummaries })",
  "                                                  to stdout UNCONDITIONALLY;",
  "                                                  no session/marker, always exit 0.",
  "  config      [--cwd <path>]                      emit the merged get_config(all) JSON",
  "                                                  for the active harness; exit 0 with",
  "                                                  configured:false when no config exists,",
  "                                                  exit 1 on invalid or unreadable config.",
  "  stats       [--cwd <path>]                      emit the MCP usage-counters JSON",
  "                                                  ({ endpoints, totals }) to stdout",
  "                                                  UNCONDITIONALLY; no session/marker,",
  "                                                  always exit 0. Counters accumulate",
  "                                                  only from MCP tool invocations against",
  "                                                  this project store (CLI direct reads",
  "                                                  do not increment); stats are",
  "                                                  primary-store-local telemetry, outside",
  "                                                  cq backup/restore.",
  "  log put <src>|--stdin --dest logs/<rel> [--cwd <path>]",
  "                                                  write a log file into .cq/logs/<rel>;",
  "                                                  source is a local file path OR --stdin;",
  "                                                  --dest must be under logs/ (no escapes).",
  "  backup      [--cwd <path>]                      export a human-readable .cq dump of the",
  "                                                  out-of-tree primary (xdg SQLite, or a",
  "                                                  postgres tenant's rows, incl. logs either",
  "                                                  way) to the target configured by",
  "                                                  [ledger].backup (in-tree | orphan-branch);",
  "                                                  write-only, never read back as a primary.",
  "  restore     [--cwd <path>] [--yes|-y]           import a .cq dump (in-tree | orphan-branch,",
  "                                                  per [ledger].backup) INTO the out-of-tree",
  "                                                  primary (xdg SQLite, or a postgres tenant's",
  "                                                  rows, incl. logs either way); disaster",
  "                                                  recovery, no merge; refuses a non-empty",
  "                                                  primary/tenant without --yes.",
  "  migrate     [--cwd <path>] [--yes|-y] [--to postgres]",
  "                                                  one-shot migration; default (no --to): the",
  "                                                  LEGACY backend cq.toml names (fs .cq/ |",
  "                                                  git-object orphan ref), state AND logs, INTO",
  "                                                  the out-of-tree xdg primary; flips [ledger]",
  "                                                  backend to xdg; refuses a non-empty target",
  "                                                  without --yes. `--to postgres` (requires",
  "                                                  backend='xdg' already): the xdg primary,",
  "                                                  state AND logs, INTO a Postgres tenant (DSN",
  "                                                  via CQ_LEDGER_PG_URL / DATABASE_URL /",
  "                                                  [ledger].url / PG* env); flips [ledger]",
  "                                                  backend to postgres; hard-refuses a",
  "                                                  non-empty tenant (no override). Either leg",
  "                                                  leaves its source untouched.",
  "  gate run --worktree <path> --command-cwd <path> [--deadline <ISO-8601>] -- <command...>",
  "                                                  run one bounded process group under the",
  "                                                  canonical Git-worktree exclusive gate.",
  "",
  "ledger root: --cwd > $LEDGER_ROOT > current working directory",
].join("\n");

/**
 * Resolve the ledger root with the precedence shared across the suite:
 * `--cwd > $LEDGER_ROOT > process CWD`. A non-empty relative value resolves
 * against the CWD. (Mirrors ledger-mcp's parseArgs root logic.)
 */
export function resolveRoot(cwdArg: string | undefined): string {
  const fromArg = cwdArg !== undefined && cwdArg !== "" ? cwdArg : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  return chosen !== undefined ? path.resolve(chosen) : process.cwd();
}

/**
 * Parse a subcommand's own flags from the args *after* the subcommand token.
 * Recognises `--cwd <path>` / `--cwd=<path>` and `--yes`/`-y`; the resolved
 * root applies the suite-wide precedence. Unknown flags are ignored here (the
 * subcommand handlers, filled by T189/T190/T191, may tighten this).
 */
export function parseSubcommandArgs(argv: readonly string[]): SubcommandArgs {
  let cwd: string | undefined;
  let yes = false;
  let force = false;
  let global = false;
  let session: string | null = null;
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--global") {
      global = true;
    } else if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else if (a === "--session") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --session requires a value");
      }
      session = v;
    } else if (a !== undefined && a.startsWith("--session=")) {
      session = a.slice("--session=".length);
    } else if (a === "--to") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --to requires a value");
      }
      to = v;
    } else if (a !== undefined && a.startsWith("--to=")) {
      to = a.slice("--to=".length);
    }
  }
  return { cwd: resolveRoot(cwd), yes, force, global, session, to };
}

/**
 * Outcome of a native subcommand handler: just an exit code. The dispatcher
 * wraps this with `longRunning: false` before returning {@link DispatchOutcome}.
 */
export interface SubcommandOutcome {
  exitCode: number;
}

/**
 * Outcome of a dispatch: the process exit code and whether the mode owns its
 * own process lifetime (long-running). When `longRunning` is true, `main()`
 * must NOT call `process.exit()` — the delegate's stdio transport / Ink render
 * / web server keeps the event loop alive and exits naturally when the channel
 * closes. When false, `main()` calls `process.exit(exitCode)` to propagate
 * non-zero codes from native subcommands.
 */
export interface DispatchOutcome {
  exitCode: number;
  longRunning: boolean;
}

/** IO seam for the dispatcher so tests can capture usage output. */
export interface DispatchIo {
  out(line: string): void;
  err(line: string): void;
  /** Confirmation IO threaded to the destructive subcommand handlers. */
  confirm: ConfirmIo;
  /**
   * Optional stdin reader for `cq log put --stdin`.  When absent, the default
   * production implementation ({@link readProcessStdin}) is used.  Tests inject
   * a controlled string here to avoid blocking on a real pipe.
   */
  readStdin?(): Promise<string>;
}

function defaultDispatchIo(): DispatchIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    confirm: defaultConfirmIo(),
  };
}

// --- Subcommand handlers -----------------------------------------------------

export async function runInit(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  if (args.global) {
    const globalConfigPath = resolveGlobalConfigPath(process.env, homedir());
    const configExists = await pathExists(globalConfigPath);
    if (!configExists || args.force) {
      await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
      await fs.writeFile(globalConfigPath, CQ_TOML_GLOBAL_TEMPLATE, "utf8");
    }

    if (configExists && !args.force) {
      io.out(
        `cq init --global: ${CQ_CONFIG_FILENAME} already exists at ${globalConfigPath}; re-run with --force to overwrite`,
      );
    } else if (configExists) {
      io.out(`cq init --global: overwrote ${CQ_CONFIG_FILENAME} at ${globalConfigPath}`);
    } else {
      io.out(`cq init --global: wrote ${CQ_CONFIG_FILENAME} at ${globalConfigPath}`);
    }
    return { exitCode: 0 };
  }

  // Write cq.toml BEFORE constructing the store (T501): a FRESH init (no
  // pre-existing cq.toml, or --force) writes CQ_TOML_TEMPLATE here so the
  // backend-selecting factory below reads the template's explicit backend. The
  // pre-write no-cq.toml fallback ('xdg') was established by K117. An existing,
  // untouched cq.toml (no --force) is left exactly as before — its
  // already-configured backend is unaffected by this task.
  const configPath = path.join(args.cwd, CQ_CONFIG_FILENAME);
  const configExists = await pathExists(configPath);
  if (!configExists || args.force) {
    await fs.writeFile(configPath, CQ_TOML_TEMPLATE, "utf8");
  }

  // Route through the backend-selecting factory (T357): for backend='git-object'
  // this validates the git env (fail-fast) and installs the idempotent
  // git-backend .gitignore block BEFORE seeding the orphan ref, so a fresh
  // git-object ledger's docs/ is gitignored from the first write. backend='xdg'
  // (T501, the new fresh-init default) resolves a git-identity-keyed store under
  // the XDG state dir — a repo with no git identity (no commits, no git at all,
  // or a shallow clone) FAILS FAST here with an actionable ProjectKeyResolutionError
  // pointing at [ledger].projectId (propagated to the caller; see main()'s
  // top-level `cq: fatal: <message>` handler). backend='fs' (still selectable via
  // an existing/explicit cq.toml) is byte-identical to the historical FsLedgerStore.init().
  const { store } = await createManagementLedgerStore(args.cwd);
  await store.dispose();
  const ledgerNames = CANONICAL_LEDGERS.map((c) => c.name).join(", ");
  io.out(`initialised ledgers at ${args.cwd} (${ledgerNames})`);

  if (configExists && !args.force) {
    io.out(
      `cq init: ${CQ_CONFIG_FILENAME} already exists at ${configPath}; re-run with --force to overwrite`,
    );
  } else if (configExists) {
    io.out(`cq init: overwrote ${CQ_CONFIG_FILENAME} at ${configPath}`);
  } else {
    io.out(`cq init: wrote ${CQ_CONFIG_FILENAME} at ${configPath}`);
  }

  return { exitCode: 0 };
}

/**
 * `cq reset` (Q109): confirm via the shared destructive-op policy, then
 * wipe-and-reinit the ledgers at `args.cwd` via the public
 * {@link FsLedgerStore.reset}, print the backup dir + per-ledger summary, and
 * return an exit code. The `reset()` method itself STAYS in @cq/ledger — this
 * wrapper only owns confirmation, IO, and the exit code (relocated from the old
 * ledger-mcp `--reset` short-circuit).
 *
 * Confirmation policy (shared with `erase`, see ./confirm.ts):
 *   - `--yes`            → proceed unattended (no prompt).
 *   - TTY, no `--yes`    → prompt; proceed only on a `y`/`Y` answer.
 *   - non-TTY, no `--yes`→ REFUSE (exit 2) — never wipe a tree silently.
 */
export async function runReset(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  // backend='postgres' (T583, Q275 context) is scoped to ONE tenant's rows in
  // a SHARED database — routed to its own handler below rather than the
  // generic isResettable dispatch: the confirmation message must name the
  // tenant (display name + project_key) BEFORE createLedgerStore's init()
  // would auto-register a not-yet-registered one as a side effect.
  const { backend: preflightBackend } = resolveLedgerBackend(args.cwd);
  if (preflightBackend === "postgres") {
    return runResetPostgres(args, io);
  }

  const decision = await confirmDestructive(
    args.yes,
    `Reset ledgers at ${args.cwd}? Backup -> ${LEDGER_STORAGE_DIRNAME}/.backup/ [y/N] `,
    `cq reset: refusing to reset ledgers at ${args.cwd} without confirmation; ` +
      `re-run with --yes to reset non-interactively.`,
    io.confirm,
  );
  if (!decision.proceed) {
    return { exitCode: decision.exitCode };
  }

  // Construct via the backend-selecting factory (T357). reset()'s backup→reinit
  // semantics (docs/.backup/) are FS-specific; a store that does not implement
  // reset is rejected with a clear error rather than a silent no-op.
  const { store, backend } = await createManagementLedgerStore(args.cwd);
  try {
    if (!isResettable(store)) {
      io.err(
        `cq reset: [ledger] backend='${backend}' does not support reset ` +
          `(backup→reinit is filesystem-specific).`,
      );
      return { exitCode: EXIT_USAGE };
    }
    const summary = await store.reset();
    io.out(`cq reset: reset ledgers at ${args.cwd}`);
    io.out(`  backup: ${summary.backupDir}`);
    for (const { name, itemCount } of summary.ledgers) {
      io.out(`  ${name}: ${itemCount} item(s) backed up, reinitialised empty`);
    }
  } finally {
    await store.dispose();
  }
  return { exitCode: 0 };
}

/**
 * `cq reset` — postgres backend (T583). DELETEs every row this tenant owns
 * (children-first FK order, same order `PostgresLedgerStore.backupAndReinitTenant`
 * uses) + re-inits the canonical ledger set — never touching any OTHER
 * tenant's rows in the shared database.
 *
 * Resolves the tenant (project_key + display name) via
 * {@link resolvePostgresTenant} BEFORE confirming, so the prompt names the
 * blast radius, then wipes + reseeds on the SAME pool/projectKey.
 */
async function runResetPostgres(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  const tenant = await resolvePostgresTenant(args.cwd);
  let store: PostgresLedgerStore | null = null;
  try {
    const displayName = tenant.registeredDisplayName ?? tenant.candidateDisplayName;
    const decision = await confirmDestructive(
      args.yes,
      `Reset postgres tenant "${displayName}" (project_key ${tenant.projectKey}) at ${args.cwd}? ` +
        `DELETEs ALL of this tenant's rows, then reinitialises the canonical ledger set. [y/N] `,
      `cq reset: refusing to reset postgres tenant "${displayName}" (project_key ${tenant.projectKey}) ` +
        `at ${args.cwd} without confirmation; re-run with --yes to reset non-interactively.`,
      io.confirm,
    );
    if (!decision.proceed) {
      return { exitCode: decision.exitCode };
    }

    const before = await countTenantActiveItems(tenant.pool, tenant.projectKey);
    const authority = createTrustedWorksetManagementAuthority();
    store = new PostgresLedgerStore({
      pool: tenant.pool,
      projectKey: tenant.projectKey,
      displayName,
      worksetAuthority: authority,
    });
    const resetStore = store;
    await resetStore.init();
    const { branch } = resolveLedgerBackend(args.cwd);
    const backupTarget = tenant.backup;
    let backupLine = `none ([ledger].backup = "none" — run \`cq backup\` before reset for a pre-wipe dump)`;
    await resetStore.resetTenant({
      authority,
      ...(backupTarget === "none"
        ? {}
        : {
            beforeReset: async () => {
              const fileCount = await runBackupExport({
                store: resetStore,
                root: args.cwd,
                target: backupTarget,
                branch,
                logsDir: null,
              });
              backupLine =
                backupTarget === "in-tree"
                  ? `${fileCount} file(s) at ${path.join(args.cwd, LEDGER_STORAGE_DIRNAME)}`
                  : `${fileCount} file(s) at refs/heads/${branch}`;
            },
          }),
    });

    io.out(
      `cq reset: reset postgres tenant "${displayName}" (project_key ${tenant.projectKey}) at ${args.cwd}`,
    );
    io.out(
      `  backup: ${backupLine}`,
    );
    for (const { name, itemCount } of before) {
      io.out(`  ${name}: ${itemCount} item(s) wiped, reinitialised empty`);
    }
    return { exitCode: 0 };
  } finally {
    if (store === null) await tenant.pool.close();
    else await store.dispose();
  }
}

/**
 * `cq erase` (Q110, the MOST destructive subcommand): DESTROY everything the
 * ledger suite owns under `args.cwd` — with NO backup and NO reinit. Per the
 * user's answer ("erase should erase everything including archives and config"),
 * the destructive set is an EXPLICIT, BOUNDED set of known paths under the
 * resolved root:
 *
 *   1. The ledger's OWN artifacts under `<root>/.cq/` — `ledgers.yaml`, every
 *      REGISTERED `<name>.md`, `archive/`, and the runtime dirs `logs/`,
 *      `.locks/`, `.backup/` — enumerated by @cq/ledger's `removeLedgerArtifacts`
 *      (the single source of truth for the ledger's own file set). NON-ledger
 *      content a user keeps under `.cq/` is PRESERVED; `.cq/` itself is removed
 *      only if it is empty afterward.
 *   2. `<root>/cq.toml`   — the config file, if present (unlink).
 *
 * It is NOT a blind wipe of `<root>/.cq/`, and NOT of `<root>`: any sibling
 * under the root (source, project docs/, etc.)
 * survives. Unlike `reset`, erase does NOT call init() afterward — the suite is
 * left fully un-initialised.
 *
 * No FsLedgerStore is constructed (which would acquire the FS lock and recreate
 * `.cq/`): erase removes `.locks/` itself, so holding a lock while deleting it
 * would be self-defeating. The deletes go straight through `node:fs`.
 *
 * backend='xdg' (T501): the ledger's data lives OUT OF TREE under the XDG state
 * dir (`resolveStateDirBase(projectKey)`), not under `<root>/.cq/`. Erase
 * additionally removes EXACTLY that project's directory — never the whole XDG
 * base, never another project's directory. The backend + projectKey are
 * resolved BEST-EFFORT (a malformed cq.toml, no git identity, etc. all degrade
 * to "unknown" rather than aborting the erase) so the fs+config bounded delete
 * below is unaffected by an unresolvable xdg identity.
 *
 * backend='postgres' (T583, Q275 context): the tenant's rows live in a SHARED
 * database (T572) — this repo's `project_key` is ONE of many. Erase resolves
 * the tenant via {@link resolvePostgresTenant} (also BEST-EFFORT, same
 * degrade-to-fs-only rationale as xdg above) and, when resolvable, additionally
 * DELETEs EXACTLY that tenant's rows (items, groups, ledgers, logs, and the
 * `projects` registry entry) — never another tenant's. Unlike xdg, a
 * resolvable-but-UNREGISTERED tenant hard-refuses (nothing to erase) rather
 * than silently skipping the tenant wipe while still deleting the local
 * fs+config artifacts — see the guard below.
 *
 * Confirmation policy (shared with `reset`, see ./confirm.ts):
 *   - `--yes`             → proceed unattended (no prompt).
 *   - TTY, no `--yes`     → prompt; proceed only on a `y`/`Y` answer.
 *   - non-TTY, no `--yes` → REFUSE (exit 2) — never wipe a tree silently.
 *
 * SAFETY: if neither `<root>/.cq`, `<root>/cq.toml`, nor a resolvable xdg
 * project dir exists there is nothing to erase; refuse with exit
 * {@link EXIT_USAGE} rather than silently succeed.
 */
/**
 * D91 belt-and-suspenders: `xdgProjectDir` MUST be a directory STRICTLY nested
 * under the shared XDG projects base (`resolveStateDirBase("")` — path.join
 * drops the trailing empty segment, so this collapses to exactly
 * `<XDG>/cq/projects`) — never the base itself. This guards against an
 * empty/blank project key reaching the recursive `fs.rm` in {@link runErase}
 * below and deleting EVERY project's out-of-tree ledger, backstopping
 * resolveProjectKey's own empty-projectId guard (D91) in case some other path
 * ever produces an empty/blank key. Exported so this invariant is unit
 * testable directly — resolveProjectKey's own guard makes it otherwise
 * unreachable from a black-box `runErase` test.
 */
export function assertXdgProjectDirScoped(xdgProjectDir: string, xdgProjectsBase: string): void {
  const isStrictlyNested =
    xdgProjectDir !== xdgProjectsBase && xdgProjectDir.startsWith(xdgProjectsBase + path.sep);
  if (!isStrictlyNested) {
    throw new Error(
      `cq erase: refusing to erase the xdg project directory — it resolved to ` +
        `"${xdgProjectDir}", which is NOT strictly inside the shared XDG projects base ` +
        `("${xdgProjectsBase}"). Erasing it would delete EVERY project's out-of-tree ledger. ` +
        `Aborting rather than deleting (D91).`,
    );
  }
}

export async function runErase(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  const storageDir = path.join(args.cwd, LEDGER_STORAGE_DIRNAME);
  const configFile = path.join(args.cwd, CQ_CONFIG_FILENAME);

  const storageExists = await pathExists(storageDir);
  const configExists = await pathExists(configFile);

  // Best-effort resolve the xdg out-of-tree project dir (T501), OR the
  // postgres tenant this cq.toml names (T583). Only attempted when a cq.toml
  // exists to read; most failures (malformed toml, no git identity/shallow
  // clone, missing DSN, …) leave both undefined and erase falls back to the
  // bounded fs+config delete only. D102: a postgres CONNECTION failure is
  // NOT folded into that degrade — the operator asked to erase a live tenant
  // and must learn the rows were NOT erased.
  let xdgProjectDir: string | undefined;
  let postgresTenant: PostgresTenantHandle | undefined;
  if (configExists) {
    let backend: string | undefined;
    try {
      backend = resolveLedgerBackend(args.cwd).backend;
      if (backend === "remote") {
        io.err(new RemoteLedgerClientNotWiredError("cq erase", args.cwd).message);
        return { exitCode: EXIT_USAGE };
      }
      if (backend === "xdg") {
        const config = loadConfig(args.cwd);
        const projectId = config?.ledger?.projectId ?? null;
        const projectKey = await resolveProjectKey({ repoRoot: args.cwd, projectId });
        xdgProjectDir = resolveStateDirBase(projectKey);
      } else if (backend === "postgres") {
        postgresTenant = await resolvePostgresTenant(args.cwd);
      }
    } catch (err) {
      if (backend === "postgres" && !(err instanceof PostgresDsnResolutionError)) {
        const detail = err instanceof Error ? err.message : String(err);
        io.err(
          `cq erase: postgres tenant NOT erased — could not reach the database: ${detail}`,
        );
        return { exitCode: EXIT_USAGE };
      }
      xdgProjectDir = undefined;
      postgresTenant = undefined;
    }
  }
  // D91: deliberately OUTSIDE the try/catch above — an invariant violation
  // here must abort loudly, never be swallowed into the best-effort fallback.
  if (xdgProjectDir !== undefined) {
    assertXdgProjectDirScoped(xdgProjectDir, resolveStateDirBase(""));
  }
  const xdgProjectDirExists = xdgProjectDir !== undefined && (await pathExists(xdgProjectDir));

  // Postgres-specific guard (T583): a project_key with no `projects` row has
  // no tenant rows in the shared database to erase — refuse rather than
  // silently no-op the tenant wipe while still deleting the bounded
  // fs+config artifacts (which would read as "erase succeeded" to an
  // operator who wanted the live tenant rows gone).
  if (postgresTenant !== undefined && postgresTenant.registeredDisplayName === null) {
    await postgresTenant.pool.close();
    io.err(
      `cq erase: nothing to erase — project_key ${postgresTenant.projectKey} at ${args.cwd} ` +
        `is not registered in the postgres tenant registry.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  // SAFETY: nothing to erase → refuse (don't silently succeed on an empty root).
  if (!storageExists && !configExists && !xdgProjectDirExists) {
    io.err(
      `cq erase: nothing to erase at ${args.cwd} ` +
        `(no ${LEDGER_STORAGE_DIRNAME}/ tree and no ${CQ_CONFIG_FILENAME}).`,
    );
    return { exitCode: EXIT_USAGE };
  }

  const tenantLabel =
    postgresTenant !== undefined
      ? ` — postgres tenant "${postgresTenant.registeredDisplayName}" (project_key ${postgresTenant.projectKey})`
      : "";
  const decision = await confirmDestructive(
    args.yes,
    `ERASE all ledgers + config at ${args.cwd}${tenantLabel}? This is IRREVERSIBLE. [y/N] `,
    `cq erase: refusing to erase ledgers + config at ${args.cwd}${tenantLabel} without confirmation; ` +
      `re-run with --yes to erase non-interactively.`,
    io.confirm,
  );
  if (!decision.proceed) {
    if (postgresTenant !== undefined) await postgresTenant.pool.close();
    return { exitCode: decision.exitCode };
  }

  // Bounded delete: the ledger's OWN artifacts under .cq/ (shared enumerator)
  // + cq.toml. Non-ledger content under .cq/ is preserved; the whole root is
  // never touched beyond these.
  const removed: string[] = [];
  let storageDirPreserved = false;
  const removeLocalArtifacts = async (): Promise<void> => {
    if (storageExists) {
      const result = await removeLedgerArtifacts(storageDir);
      if (result.docsDirRemoved) {
        removed.push(storageDir);
      } else {
        removed.push(...result.removed);
        storageDirPreserved = true;
      }
    }
    if (configExists) {
      await fs.rm(configFile, { force: true });
      removed.push(configFile);
    }
  };

  // xdg (T501/T1959): wait for all admitted work, then atomically move this
  // project's complete state+logs directory out of the canonical namespace.
  // Cleanup targets only that quarantine path; a peer may legitimately create
  // fresh canonical state after the rename linearization point.
  if (xdgProjectDirExists && xdgProjectDir !== undefined) {
    const dbPath = path.join(xdgProjectDir, "state", XDG_DB_FILENAME);
    const quarantineDir = `${xdgProjectDir}.erase-${randomUUID()}`;
    if (await pathExists(dbPath)) {
      const db = openExistingLedgerDb(dbPath);
      const workset = createSqliteWorksetStore({ db });
      try {
        try {
          await workset.runAdministrative({
            kind: "erase",
            authority: createTrustedWorksetManagementAuthority(),
            destructivePhase: async () => {
              await fs.rename(xdgProjectDir, quarantineDir);
            },
          });
        } catch (error) {
          if (!(await pathExists(xdgProjectDir)) && (await pathExists(quarantineDir))) {
            await fs.rename(quarantineDir, xdgProjectDir);
          }
          throw error;
        }
      } finally {
        db.close();
      }
    } else {
      await fs.rename(xdgProjectDir, quarantineDir);
    }
    await fs.rm(quarantineDir, { recursive: true, force: true });
    removed.push(xdgProjectDir);
  }

  // postgres (T583): DELETE exactly this tenant's rows — items, groups,
  // ledgers, logs, AND the projects registry entry — never another tenant's.
  let postgresWipeSummary:
    | { projectKey: string; items: Array<{ name: string; itemCount: number }> }
    | undefined;
  if (postgresTenant !== undefined) {
    const items = await countTenantActiveItems(postgresTenant.pool, postgresTenant.projectKey);
    // T1959: exclusive administrative admission for erase; the final tenant
    // deletion commits while the exclusive row remains visible to every peer.
    const workset = createPostgresWorksetStore({
      pool: postgresTenant.pool,
      projectKey: postgresTenant.projectKey,
    });
    try {
      await workset.runAdministrative({
        kind: "erase",
        authority: createTrustedWorksetManagementAuthority(),
        destructivePhase: async () => {
          await wipeTenantRows(postgresTenant.pool, postgresTenant.projectKey, true, false);
        },
      });
    } finally {
      workset.close();
    }
    await postgresTenant.pool.close();
    removed.push(
      `postgres tenant "${postgresTenant.registeredDisplayName}" (project_key ${postgresTenant.projectKey})`,
    );
    postgresWipeSummary = { projectKey: postgresTenant.projectKey, items };
  }

  await removeLocalArtifacts();

  io.out(`cq erase: erased ledgers + config at ${args.cwd} (IRREVERSIBLE, no backup)`);
  for (const p of removed) {
    io.out(`  removed: ${p}`);
  }
  if (postgresWipeSummary !== undefined) {
    for (const { name, itemCount } of postgresWipeSummary.items) {
      io.out(
        `  ${name}: ${itemCount} item(s) removed (postgres project_key ${postgresWipeSummary.projectKey})`,
      );
    }
  }
  if (storageDirPreserved) {
    io.out(`  preserved: ${storageDir} (non-ledger content remains)`);
  }
  return { exitCode: 0 };
}

/**
 * `cq move-ledger` — RETIRED (T505). The fs<->git-object transplant it
 * performed (T354) migrated between two LEGACY primaries that are no longer
 * selectable at runtime; `cq migrate` (legacy → xdg) supersedes it. The
 * subcommand token is kept recognised so an old invocation gets a pointed,
 * actionable error instead of the generic usage dump.
 */
export async function runMoveLedgerCmd(
  _args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  io.err(
    "cq move-ledger: RETIRED (T505) — the fs<->git-object transplant is superseded by " +
      "`cq migrate`, the one-shot migration of the legacy backend cq.toml names into the " +
      "out-of-tree xdg primary. Run `cq migrate [--cwd <path>] [--yes]` instead.",
  );
  return { exitCode: EXIT_USAGE };
}

/**
 * `cq advance-gate` (T362): a NATIVE subcommand emitting the harness-agnostic
 * `/cq:advance` stop-gate verdict JSON to stdout, with exit 0 = allow /
 * non-zero = block. The verdict derivation lives in ./advanceGate.ts; this thin
 * wrapper bridges {@link SubcommandArgs} to its {@link AdvanceGateArgs} and
 * threads the dispatcher IO (out/err).
 */
export async function runAdvanceGateCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  return runAdvanceGate(
    { cwd: args.cwd, session: args.session },
    { out: io.out, err: io.err },
  );
}

/**
 * `cq predicates` (T476 / Q241): a NATIVE subcommand emitting the derived flow
 * predicates JSON to stdout UNCONDITIONALLY — no session resolution, no marker
 * check, always exit 0. The derivation lives in ./predicates.ts; this thin
 * wrapper bridges {@link SubcommandArgs} to its {@link PredicatesArgs} and
 * threads the dispatcher IO (out/err).
 */
export async function runPredicatesCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  return runPredicates({ cwd: args.cwd }, { out: io.out, err: io.err });
}

/**
 * `cq counts` (T533 / G76): a NATIVE subcommand emitting the ledger-summaries
 * JSON to stdout UNCONDITIONALLY — no session resolution, no marker check,
 * always exit 0. The derivation lives in ./counts.ts; this thin wrapper
 * bridges {@link SubcommandArgs} to its {@link CountsArgs} and threads the
 * dispatcher IO (out/err).
 */
export async function runCountsCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  return runCounts({ cwd: args.cwd }, { out: io.out, err: io.err });
}

/**
 * `cq stats` (I20/G155, T1512): a NATIVE subcommand emitting the MCP
 * usage-counters JSON to stdout UNCONDITIONALLY — no session resolution, no
 * marker check, always exit 0. The derivation lives in ./stats.ts; this thin
 * wrapper bridges {@link SubcommandArgs} to its {@link StatsArgs} and threads
 * the dispatcher IO (out/err).
 */
export async function runStatsCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  return runStats({ cwd: args.cwd }, { out: io.out, err: io.err });
}

/**
 * `cq log` (T406 / G49): a NATIVE namespace subcommand whose first positional
 * token is a sub-subcommand (`put`). The only recognised sub-subcommand is
 * `put`; anything else prints a usage error and exits {@link EXIT_USAGE}.
 *
 * The `cwd` in `args` is the already-resolved ledger root (from the top-level
 * `--cwd` / `$LEDGER_ROOT` / CWD). The `logArgv` slice carries the tokens
 * AFTER "log" (e.g. `["put", "--stdin", "--dest", "logs/raw/x.jsonl"]`).
 */
export async function runLogCmd(
  args: SubcommandArgs,
  logArgv: readonly string[],
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  // Find the first positional token in logArgv (the sub-subcommand); skip any
  // leading flags (e.g. --cwd /foo that appear between "log" and "put").
  let subIdx = -1;
  for (let i = 0; i < logArgv.length; i++) {
    const a = logArgv[i];
    if (a !== undefined && !a.startsWith("-")) {
      subIdx = i;
      break;
    }
    // Skip --cwd <value> and --cwd=<value> since they were already consumed by
    // the top-level dispatcher.
    if (a === "--cwd") {
      i += 1;
    }
  }

  const sub = subIdx >= 0 ? logArgv[subIdx] : undefined;
  if (sub !== "put") {
    io.err(
      sub === undefined
        ? "cq log: a sub-subcommand is required (e.g. `cq log put --stdin --dest logs/<rel>`).\n" +
            "  put <src>|--stdin --dest logs/<rel>   write a log file into .cq/logs/<rel>"
        : `cq log: unknown sub-subcommand "${sub}"; expected "put".\n` +
            "  put <src>|--stdin --dest logs/<rel>   write a log file into .cq/logs/<rel>",
    );
    return { exitCode: EXIT_USAGE };
  }

  // Everything after "put" is the `log put` argv:
  // positional src, --stdin, --dest, etc. (--cwd was already consumed by the
  // top-level parser and is reflected in args.cwd).
  let putArgs;
  try {
    putArgs = parseLogPutArgs(args.cwd, logArgv.slice(subIdx + 1));
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return { exitCode: LOG_PUT_EXIT_USAGE };
  }

  return runLogPut(putArgs, {
    out: io.out,
    err: io.err,
    readStdin: io.readStdin ?? readProcessStdin,
  });
}

/**
 * `cq backup` (T502 / Q244): an EXPLICIT, on-demand run of the one-way
 * human-readable backup exporter — the same export the debounced post-mutation
 * trigger performs, but awaited and surfaced (errors are fatal here, not
 * best-effort-swallowed). The target comes from `[ledger].backup`:
 *
 *   - `none` (the default)  → refuse with a usage error: backups are OFF and
 *     nothing must ever be written in-tree or to any ref.
 *   - `in-tree`             → write the dump under `<root>/.cq/`.
 *   - `orphan-branch`       → commit the dump tree to `refs/heads/<branch>`.
 *
 * The `xdg` AND `postgres` backends are supported (T582, Q275 full-parity
 * decision): the exporter dumps the OUT-OF-TREE primary — xdg's SQLite + xdg
 * logs area (Q247), or postgres's tenant rows + tenant-keyed `logs` table via
 * the store-agnostic `buildBackupDump`/T575 `listLogs` seam — into today's
 * `.cq/` layout, SCOPED to the connecting project/tenant (never the whole
 * postgres database — that remains `pg_dump`'s job). The fs / git-object
 * backends remain genuinely unsupported: they already keep their state in
 * that human-readable form in place, so there is nothing to dump.
 */
export async function runBackup(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  const { backend, branch } = resolveLedgerBackend(args.cwd);
  const config = loadConfig(args.cwd);
  const target = config?.ledger?.backup ?? "none";

  if (target === "none") {
    io.err(
      `cq backup: [ledger].backup is "none" (the default) at ${args.cwd} — backups are OFF. ` +
        `Set backup = "in-tree" or "orphan-branch" in ${CQ_CONFIG_FILENAME} to enable exports.`,
    );
    return { exitCode: EXIT_USAGE };
  }
  if (backend !== "xdg" && backend !== "postgres") {
    io.err(
      `cq backup: [ledger] backend='${backend}' does not support the backup exporter ` +
        `(it dumps the out-of-tree xdg primary or the postgres tenant into the .cq/ layout, which ` +
        `the '${backend}' backend already keeps human-readable). Use backend='xdg' or backend='postgres'.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  const resolved = await createLedgerStore(args.cwd);
  try {
    const fileCount = await runBackupExport({
      store: resolved.store,
      root: args.cwd,
      target,
      branch,
      logsDir: resolved.logsDir ?? null,
    });
    if (target === "in-tree") {
      io.out(
        `cq backup: exported ${fileCount} file(s) to ${path.join(args.cwd, LEDGER_STORAGE_DIRNAME)}`,
      );
    } else {
      io.out(
        `cq backup: committed a ${fileCount}-file dump to refs/heads/${branch} at ${args.cwd}`,
      );
    }
  } finally {
    // The explicit export above already ran; drop the debounced trigger (no
    // mutations happened here) and release the store.
    resolved.backup?.close();
    await resolved.store.dispose();
  }
  return { exitCode: 0 };
}

/**
 * `cq restore` (T503 / Q244; postgres parity T582 / Q275): the explicit
 * one-way IMPORT counterpart of `cq backup` — reads the dump at the
 * CONFIGURED `[ledger].backup` target (in-tree `.cq/` or the orphan ref, same
 * source `cq backup` writes to) and writes its content into the out-of-tree
 * primary — xdg's SQLite rows + primary logs area, or (T580)
 * `restoreDumpToPostgres`'s id/timestamp-preserving import into the
 * connecting project's postgres tenant — so `fetch_ledger`/`fetch_item`/
 * `read_log` serve the restored state. Disaster recovery, NOT sync — no merge
 * semantics: the primary (xdg) / tenant (postgres) is wiped and replaced
 * wholesale, SCOPED to that one tenant only under postgres — never the whole
 * shared database.
 *
 * Refuses the SAME two ways `cq backup` does (no configured target; a
 * genuinely unsupported backend — fs / git-object), plus the destructive-op
 * confirmation policy (shared with `reset`/`erase`) when the primary/tenant is
 * non-empty:
 *   - `--yes`             → proceed unattended (no prompt).
 *   - TTY, no `--yes`     → prompt; proceed only on a `y`/`Y` answer.
 *   - non-TTY, no `--yes` → REFUSE (exit 2) — never overwrite silently.
 * An EMPTY primary/tenant (nothing beyond the canonical bootstrap state)
 * restores unconditionally — there is nothing destructive to confirm.
 *
 * The dump is read and parsed BEFORE any confirmation/wipe, so a malformed or
 * incomplete dump fails loud without touching the primary/tenant.
 */
export async function runRestore(args: SubcommandArgs, io: DispatchIo): Promise<SubcommandOutcome> {
  const { backend, branch } = resolveLedgerBackend(args.cwd);
  const config = loadConfig(args.cwd);
  const target = config?.ledger?.backup ?? "none";

  if (target === "none") {
    io.err(
      `cq restore: [ledger].backup is "none" (the default) at ${args.cwd} — no dump target is ` +
        `configured. Set backup = "in-tree" or "orphan-branch" in ${CQ_CONFIG_FILENAME} to enable restore.`,
    );
    return { exitCode: EXIT_USAGE };
  }
  if (backend !== "xdg" && backend !== "postgres") {
    io.err(
      `cq restore: [ledger] backend='${backend}' does not support restore (it imports INTO the ` +
        `out-of-tree xdg primary or the postgres tenant; the '${backend}' backend already keeps its ` +
        `state human-readable in place). Use backend='xdg' or backend='postgres'.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  let dump;
  try {
    dump =
      target === "in-tree"
        ? await readDumpInTree(args.cwd)
        : await readDumpOrphanBranch(args.cwd, branch);
  } catch (e) {
    io.err(`cq restore: failed to read the ${target} dump: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: EXIT_USAGE };
  }

  if (backend === "postgres") {
    return runRestorePostgres(args, io, target, dump);
  }

  const resolved = await createManagementLedgerStore(args.cwd);
  const { dbPath, logsDir } = resolved;
  if (dbPath === undefined || logsDir === undefined) {
    await resolved.store.dispose();
    io.err("cq restore: internal error — the xdg backend did not resolve a dbPath/logsDir");
    return { exitCode: EXIT_USAGE };
  }

  let overwriteAuthorized = args.yes;
  if (!(await isXdgPrimaryEmpty(resolved.store))) {
    const decision = await confirmDestructive(
      args.yes,
      `Restore will OVERWRITE the non-empty ledger primary at ${args.cwd}? [y/N] `,
      `cq restore: refusing to overwrite the non-empty ledger primary at ${args.cwd} without ` +
        `confirmation; re-run with --yes to restore non-interactively.`,
      io.confirm,
    );
    if (!decision.proceed) {
      resolved.backup?.close();
      await resolved.store.dispose();
      return { exitCode: decision.exitCode };
    }
    overwriteAuthorized = true;
  }
  resolved.backup?.close();
  await resolved.store.dispose();

  let summary;
  try {
    summary = await restoreDumpToXdg({
      dbPath,
      logsDir,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized,
    });
  } catch (error) {
    if (!(error instanceof RestoreTargetChangedError)) throw error;
    io.err("cq restore: refusing because the xdg primary became non-empty after confirmation");
    return { exitCode: EXIT_REFUSED };
  }
  io.out(
    `cq restore: restored ${summary.ledgerCount} ledger(s) + ${summary.logCount} log artifact(s) ` +
      `from the ${target} dump at ${args.cwd}`,
  );
  return { exitCode: 0 };
}

/**
 * `cq restore`'s postgres branch (T582, Q275 full-parity decision) —
 * {@link runRestore}'s delegate, split out only for readability. Resolves the
 * tenant via {@link resolvePostgresTenant} (self-sufficient: it does NOT
 * pre-register the tenant, mirroring `restoreDumpToPostgres`'s own UPSERT of
 * the `projects` row — T580's doc), applies the SAME destructive-op
 * confirmation policy `runRestore`'s xdg path uses (keyed off
 * {@link isPostgresTenantEmpty}, the postgres analogue of
 * `isXdgPrimaryEmpty`), then imports via `restoreDumpToPostgres` — scoped
 * STRICTLY to this one `project_key`, never another tenant's rows.
 */
async function runRestorePostgres(
  args: SubcommandArgs,
  io: DispatchIo,
  target: "in-tree" | "orphan-branch",
  dump: Awaited<ReturnType<typeof readDumpInTree>>,
): Promise<SubcommandOutcome> {
  const tenant = await resolvePostgresTenant(args.cwd);
  const displayName = tenant.registeredDisplayName ?? tenant.candidateDisplayName;
  try {
    const empty = await isPostgresTenantEmpty(tenant.pool, tenant.projectKey);
    let overwriteAuthorized = args.yes;
    if (!empty) {
      const decision = await confirmDestructive(
        args.yes,
        `Restore will OVERWRITE the non-empty postgres tenant "${displayName}" ` +
          `(project_key ${tenant.projectKey}) at ${args.cwd}? [y/N] `,
        `cq restore: refusing to overwrite the non-empty postgres tenant "${displayName}" ` +
          `(project_key ${tenant.projectKey}) at ${args.cwd} without confirmation; re-run with ` +
          `--yes to restore non-interactively.`,
        io.confirm,
      );
      if (!decision.proceed) {
        return { exitCode: decision.exitCode };
      }
      overwriteAuthorized = true;
    }

    let summary;
    try {
      summary = await restoreDumpToPostgres({
        pool: tenant.pool,
        projectKey: tenant.projectKey,
        displayName,
        dump,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized,
      });
    } catch (error) {
      if (!(error instanceof RestoreTargetChangedError)) throw error;
      io.err(
        `cq restore: refusing because postgres tenant ${tenant.projectKey} became non-empty ` +
          `after confirmation`,
      );
      return { exitCode: EXIT_REFUSED };
    }
    io.out(
      `cq restore: restored ${summary.ledgerCount} ledger(s) + ${summary.logCount} log artifact(s) ` +
        `from the ${target} dump at ${args.cwd} (postgres tenant "${displayName}", ` +
        `project_key ${tenant.projectKey})`,
    );
    return { exitCode: 0 };
  } finally {
    await tenant.pool.close();
  }
}

/**
 * `cq migrate` (T504 / Q243, xdg->postgres leg T581): the explicit one-shot
 * LEGACY (fs | git-object) → xdg migration, or (`--to postgres`) the xdg →
 * postgres migration. The full logic lives in ./migrate.ts; this thin
 * wrapper bridges {@link SubcommandArgs} to its {@link MigrateArgs} and
 * threads the dispatcher IO (out/err + the shared confirmation IO).
 *
 * `args.to` is the RAW, unvalidated `--to` value (parseSubcommandArgs is
 * shared across every subcommand, so it stays lenient — see its doc). THIS
 * is the one place that validates it: `"postgres"` selects the xdg ->
 * postgres leg, absent (`null`) selects the default leg, and any OTHER
 * value is a usage error naming the one recognised value.
 */
export async function runMigrateCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  if (args.to !== null && args.to !== "postgres") {
    io.err(`cq migrate: --to only recognises "postgres" (got "${args.to}").`);
    return { exitCode: EXIT_USAGE };
  }
  return runMigrate(
    { cwd: args.cwd, yes: args.yes, to: args.to },
    { out: io.out, err: io.err, confirm: io.confirm },
  );
}

/** A store exposing the FS-specific backup→reinit `reset()` (FsLedgerStore). */
interface ResettableStore extends LedgerStore {
  reset(): Promise<ResetSummary>;
}

/** Duck-typed guard: does `store` expose the FS-only `reset()` method? */
function isResettable(store: LedgerStore): store is ResettableStore {
  return typeof (store as { reset?: unknown }).reset === "function";
}

/**
 * Read all of process.stdin as a UTF-8 string.
 * Used as the default `readStdin` implementation threaded into {@link runLogPut}.
 */
async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True iff `p` exists on disk (any node type). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const HANDLERS: Record<Subcommand, (args: SubcommandArgs, io: DispatchIo) => Promise<SubcommandOutcome>> = {
  init: runInit,
  reset: runReset,
  erase: runErase,
  "move-ledger": runMoveLedgerCmd,
  "advance-gate": runAdvanceGateCmd,
  predicates: runPredicatesCmd,
  counts: runCountsCmd,
  config: runConfig,
  stats: runStatsCmd,
  // `log` is a namespace subcommand: the handler placeholder is never invoked
  // directly — the dispatch() function intercepts it and delegates to runLogCmd
  // with the raw post-"log" argv.  This entry must exist so isSubcommand() and
  // SUBCOMMANDS include "log".
  log: async (_args, io) => {
    io.err("cq log: internal error — log handler called without sub-argv");
    return { exitCode: EXIT_USAGE };
  },
  backup: runBackup,
  restore: runRestore,
  migrate: runMigrateCmd,
  gate: async (_args, io) => {
    io.err("cq gate: internal error — gate handler called without sub-argv");
    return { exitCode: EXIT_USAGE };
  },
};

/**
 * Route `argv` (the args after the program name) to a MODE or a subcommand.
 *
 * MODE routing runs FIRST: if `argv[0]` is a {@link Mode} (mcp|tui|web|serve), the
 * dispatcher delegates to that product's exported `main(argv.slice(1))` with the
 * post-mode args VERBATIM — no native flag parsing — and returns exit 0 once the
 * delegated main resolves (long-running for tui/web). The `mcp` path emits
 * nothing of its own so stdout stays protocol-only.
 *
 * Otherwise the FIRST positional arg selects a native subcommand; the rest are
 * its flags. An unknown or absent first token prints {@link USAGE} to stderr and
 * resolves exit {@link EXIT_USAGE} WITHOUT invoking a handler.
 */
export async function dispatch(
  argv: readonly string[],
  io: DispatchIo = defaultDispatchIo(),
  modes: ModeDelegates = defaultModeDelegates(),
): Promise<DispatchOutcome> {
  const first = argv[0];
  if (first !== undefined && isMode(first)) {
    await modes[first](argv.slice(1));
    return { exitCode: 0, longRunning: true };
  }
  if (first === undefined || !isSubcommand(first)) {
    io.err(USAGE);
    return { exitCode: EXIT_USAGE, longRunning: false };
  }
  if (first === "gate") {
    const outcome = await runGateRun(argv.slice(1), io);
    return { ...outcome, longRunning: false };
  }
  const args = parseSubcommandArgs(argv.slice(1));
  // `log` is a namespace subcommand — intercept it before the generic handler
  // dispatch so runLogCmd receives the raw post-"log" argv for sub-subcommand
  // routing and `log put` argument parsing.
  if (first === "log") {
    const outcome = await runLogCmd(args, argv.slice(1), io);
    return { ...outcome, longRunning: false };
  }
  const outcome = await HANDLERS[first](args, io);
  return { ...outcome, longRunning: false };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { exitCode, longRunning } = await dispatch(argv);
  // Long-running modes (mcp/tui/web) govern their own process lifetime via the
  // delegate's stdio transport / Ink render / web server keeping the event loop
  // alive. Calling process.exit() here would tear the channel down immediately
  // (see ledger-mcp main.ts lifecycle comment). Native subcommands do not block
  // the event loop, so we must exit explicitly to propagate non-zero codes.
  if (longRunning) return;
  process.exit(exitCode);
}

// Only run main() when executed directly (not when imported by the test
// suite). `import.meta.main` is bun-specific.
const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq: fatal: ${msg}\n`);
    process.exit(1);
  });
}
