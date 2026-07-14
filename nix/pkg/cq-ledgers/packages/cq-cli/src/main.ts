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
import {
  createLedgerStore,
  CANONICAL_LEDGERS,
  removeLedgerArtifacts,
  LEDGER_STORAGE_DIRNAME,
  resolveLedgerBackend,
  resolveStateDirBase,
  resolveProjectKey,
  runBackupExport,
  type LedgerStore,
  type ResetSummary,
} from "@cq/ledger";
import { loadConfig } from "@cq/config";
import {
  type ConfirmIo,
  defaultConfirmIo,
  confirmDestructive,
} from "./confirm.js";
import { CQ_TOML_TEMPLATE } from "./cqTomlTemplate.js";
import { runMoveLedger, type MoveDirection } from "./moveLedger.js";
import { runAdvanceGate } from "./advanceGate.js";
import { runPredicates } from "./predicates.js";
import { parseLogPutArgs, runLogPut, EXIT_USAGE as LOG_PUT_EXIT_USAGE } from "./logPut.js";

/**
 * The `cq.toml` config filename, resolved relative to the ledger root. Kept as
 * a local constant (rather than importing @cq/config's `CQ_CONFIG_FILENAME`) so
 * `@cq/cli` need not depend on `@cq/config` — both agree on the literal name.
 */
export const CQ_CONFIG_FILENAME = "cq.toml";

export { type ConfirmIo, type ConfirmOutcome, defaultConfirmIo, confirmDestructive } from "./confirm.js";

/** Exit code for an unknown/absent subcommand (usage error). */
export const EXIT_USAGE = 2;

/** The subcommands the dispatcher routes to. */
export const SUBCOMMANDS = ["init", "reset", "erase", "move-ledger", "advance-gate", "predicates", "log", "backup"] as const;
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
 */
export const MODES = ["mcp", "tui", "web"] as const;
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
}

function defaultModeDelegates(): ModeDelegates {
  return {
    mcp: async (argv) => (await import("@cq/ledger-mcp")).main(argv),
    tui: async (argv) => (await import("@cq/ledger-tui")).main(argv),
    web: async (argv) => (await import("@cq/ledger-web")).main(argv),
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
  /**
   * `--to <git|local>`: the `move-ledger` migration direction. `null` when the
   * flag is absent (other subcommands ignore it; `move-ledger` refuses without
   * it). An UNRECOGNISED value is captured verbatim here and rejected by the
   * `move-ledger` handler with a usage error.
   */
  to: MoveDirection | null;
  /**
   * `--session <id>`: the `advance-gate` session id whose advance marker is
   * consulted. `null` when the flag is absent (the handler then falls back to
   * `$CLAUDE_CODE_SESSION_ID`); other subcommands ignore it.
   */
  session: string | null;
}

export const USAGE = [
  "usage: cq <mode|command> [options]",
  "",
  "modes (delegate verbatim to the product binary):",
  "  mcp         [--cwd <path>] [--http [host:]port] [--tool-prefix <p>]",
  "                                                  run the MCP server (stdio or HTTP)",
  "  mcp restore --from-cache [--cwd <path>]         restore .cq/ from the per-root XDG cache mirror",
  "  tui         [--cwd <path>] [--mcp-url <url>]    run the terminal UI",
  "  web         [--port <n>] [--host <h>] [--cwd <path>] [--mcp-url <url>]",
  "                                                  run the web UI (default port 5180)",
  "",
  "commands:",
  "  init        [--cwd <path>] [--force]            initialise the canonical ledger set",
  "  reset       [--cwd <path>] [--yes|-y]           backup + reinitialise the ledgers (destructive)",
  "  erase       [--cwd <path>] [--yes|-y]           remove the ledger tree (destructive)",
  "  move-ledger --to <git|local> [--cwd <path>] [--force]",
  "                                                  migrate the ledger between .cq/ and the orphan",
  "                                                  ref refs/heads/<branch> (default cq-ledger):",
  "                                                    --to git    snapshot .cq/ → orphan ref, untrack",
  "                                                                .cq/ files (left on disk), backend=git-object",
  "                                                    --to local  materialise orphan ref → .cq/, re-track,",
  "                                                                backend=fs",
  "                                                  refuses a non-empty target without --force.",
  "                                                  inspect the orphan ref as a checkout via:",
  "                                                    git worktree add <dir> cq-ledger",
  "  advance-gate [--cwd <path>] [--session <id>]    emit the neutral /cq:advance stop-gate verdict",
  "                                                  JSON (block + reason + predicates) to stdout;",
  "                                                  exit 0 = allow, non-zero = block.",
  "  predicates  [--cwd <path>]                      emit the derived flow predicates JSON",
  "                                                  ({ predicates: { pInvestigate, pPlan, pImplement,",
  "                                                  openQuestionGate } }) to stdout UNCONDITIONALLY;",
  "                                                  no session/marker, always exit 0.",
  "  log put <src>|--stdin --dest logs/<rel> [--cwd <path>]",
  "                                                  write a log file into .cq/logs/<rel>;",
  "                                                  source is a local file path OR --stdin;",
  "                                                  --dest must be under logs/ (no escapes).",
  "  backup      [--cwd <path>]                      export a human-readable .cq dump of the",
  "                                                  xdg primary (incl. logs) to the target",
  "                                                  configured by [ledger].backup",
  "                                                  (in-tree | orphan-branch); write-only,",
  "                                                  never read back as a primary.",
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
  let to: MoveDirection | null = null;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else if (a === "--to") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --to requires a value (git|local)");
      }
      to = parseMoveDirection(v);
    } else if (a !== undefined && a.startsWith("--to=")) {
      to = parseMoveDirection(a.slice("--to=".length));
    } else if (a === "--session") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq: --session requires a value");
      }
      session = v;
    } else if (a !== undefined && a.startsWith("--session=")) {
      session = a.slice("--session=".length);
    }
  }
  return { cwd: resolveRoot(cwd), yes, force, to, session };
}

/** Parse a `--to` value into a {@link MoveDirection}; fail fast on anything else. */
function parseMoveDirection(v: string): MoveDirection {
  if (v === "git" || v === "local") {
    return v;
  }
  throw new Error(`cq: --to must be "git" or "local", got "${v}"`);
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
  // Write cq.toml BEFORE constructing the store (T501): a FRESH init (no
  // pre-existing cq.toml, or --force) writes CQ_TOML_TEMPLATE here so the
  // backend-selecting factory below reads the template's default backend
  // ('xdg') rather than the pre-write no-cq.toml fallback ('fs'). An existing,
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
  const { store } = await createLedgerStore(args.cwd);
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
  // semantics (docs/.backup/) are FS-specific; the git-object backend does not
  // implement reset (out of scope per the backend caveats), so a git-object
  // config here is rejected with a clear error rather than a silent no-op.
  const { store, backend } = await createLedgerStore(args.cwd);
  try {
    if (!isResettable(store)) {
      io.err(
        `cq reset: [ledger] backend='${backend}' does not support reset ` +
          `(backup→reinit is filesystem-specific). Use backend='fs'.`,
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
 * `cq erase` (Q110, the MOST destructive subcommand): DESTROY everything the
 * ledger suite owns under `args.cwd` — with NO backup and NO reinit. Per the
 * user's answer ("erase should erase everything including archives and config"),
 * the destructive set is an EXPLICIT, BOUNDED set of known paths under the
 * resolved root:
 *
 *   1. The ledger's OWN artifacts under `<root>/.cq/` — `ledgers.yaml`, every
 *      REGISTERED `<name>.md`, `archive/`, and the runtime dirs `logs/`,
 *      `.locks/`, `.backup/` — enumerated by @cq/ledger's `removeLedgerArtifacts`
 *      (the single source of truth shared with `cq move-ledger`). NON-ledger
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

  // Best-effort resolve the xdg out-of-tree project dir (T501). Only attempted
  // when a cq.toml exists to read; any failure (malformed toml, no git
  // identity/shallow clone, backend isn't 'xdg', …) leaves this undefined and
  // erase falls back to the bounded fs+config delete only, exactly as before.
  let xdgProjectDir: string | undefined;
  if (configExists) {
    try {
      const { backend } = resolveLedgerBackend(args.cwd);
      if (backend === "xdg") {
        const config = loadConfig(args.cwd);
        const projectId = config?.ledger?.projectId ?? null;
        const projectKey = await resolveProjectKey({ repoRoot: args.cwd, projectId });
        xdgProjectDir = resolveStateDirBase(projectKey);
      }
    } catch {
      xdgProjectDir = undefined;
    }
  }
  // D91: deliberately OUTSIDE the try/catch above — an invariant violation
  // here must abort loudly, never be swallowed into the best-effort fallback.
  if (xdgProjectDir !== undefined) {
    assertXdgProjectDirScoped(xdgProjectDir, resolveStateDirBase(""));
  }
  const xdgProjectDirExists = xdgProjectDir !== undefined && (await pathExists(xdgProjectDir));

  // SAFETY: nothing to erase → refuse (don't silently succeed on an empty root).
  if (!storageExists && !configExists && !xdgProjectDirExists) {
    io.err(
      `cq erase: nothing to erase at ${args.cwd} ` +
        `(no ${LEDGER_STORAGE_DIRNAME}/ tree and no ${CQ_CONFIG_FILENAME}).`,
    );
    return { exitCode: EXIT_USAGE };
  }

  const decision = await confirmDestructive(
    args.yes,
    `ERASE all ledgers + config at ${args.cwd}? This is IRREVERSIBLE. [y/N] `,
    `cq erase: refusing to erase ledgers + config at ${args.cwd} without confirmation; ` +
      `re-run with --yes to erase non-interactively.`,
    io.confirm,
  );
  if (!decision.proceed) {
    return { exitCode: decision.exitCode };
  }

  // Bounded delete: the ledger's OWN artifacts under .cq/ (shared enumerator)
  // + cq.toml. Non-ledger content under .cq/ is preserved; the whole root is
  // never touched beyond these.
  const removed: string[] = [];
  let storageDirPreserved = false;
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
  // xdg (T501): remove EXACTLY this project's out-of-tree dir (state/ + logs/)
  // — never the whole XDG base, never a sibling project's dir.
  if (xdgProjectDirExists && xdgProjectDir !== undefined) {
    await fs.rm(xdgProjectDir, { recursive: true, force: true });
    removed.push(xdgProjectDir);
  }

  io.out(`cq erase: erased ledgers + config at ${args.cwd} (IRREVERSIBLE, no backup)`);
  for (const p of removed) {
    io.out(`  removed: ${p}`);
  }
  if (storageDirPreserved) {
    io.out(`  preserved: ${storageDir} (non-ledger content remains)`);
  }
  return { exitCode: 0 };
}

/**
 * `cq move-ledger` (T354): a NATIVE subcommand performing a lossless
 * bidirectional transplant of the live ledger between the `.cq/` working tree
 * and the orphan ref via an explicit `--to git|local`. The migration logic lives
 * in ./moveLedger.ts; this thin wrapper bridges {@link SubcommandArgs} to its
 * {@link MoveLedgerArgs} and threads the dispatcher IO.
 */
export async function runMoveLedgerCmd(
  args: SubcommandArgs,
  io: DispatchIo,
): Promise<SubcommandOutcome> {
  return runMoveLedger(
    { root: args.cwd, to: args.to, force: args.force },
    { out: io.out, err: io.err },
  );
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
 * Only the `xdg` backend is supported: the exporter dumps the OUT-OF-TREE
 * primary (SQLite + xdg logs area, Q247) into today's `.cq/` layout. The fs /
 * git-object backends already keep their state in that human-readable form.
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
  if (backend !== "xdg") {
    io.err(
      `cq backup: [ledger] backend='${backend}' does not support the backup exporter ` +
        `(it dumps the out-of-tree xdg primary into the .cq/ layout, which the '${backend}' ` +
        `backend already keeps human-readable). Use backend='xdg'.`,
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
  // `log` is a namespace subcommand: the handler placeholder is never invoked
  // directly — the dispatch() function intercepts it and delegates to runLogCmd
  // with the raw post-"log" argv.  This entry must exist so isSubcommand() and
  // SUBCOMMANDS include "log".
  log: async (_args, io) => {
    io.err("cq log: internal error — log handler called without sub-argv");
    return { exitCode: EXIT_USAGE };
  },
  backup: runBackup,
};

/**
 * Route `argv` (the args after the program name) to a MODE or a subcommand.
 *
 * MODE routing runs FIRST: if `argv[0]` is a {@link Mode} (mcp|tui|web), the
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
