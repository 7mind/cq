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
import { FsLedgerStore, CANONICAL_LEDGERS } from "@cq/ledger";
import {
  type ConfirmIo,
  defaultConfirmIo,
  confirmDestructive,
} from "./confirm.js";
import { CQ_TOML_TEMPLATE } from "./cqTomlTemplate.js";

/**
 * The `cq.toml` config filename, resolved relative to the ledger root. Kept as
 * a local constant (rather than importing @cq/config's `CQ_CONFIG_FILENAME`) so
 * `@cq/cli` need not depend on `@cq/config` — both agree on the literal name.
 */
export const CQ_CONFIG_FILENAME = "cq.toml";

export { type ConfirmIo, type ConfirmOutcome, defaultConfirmIo, confirmDestructive } from "./confirm.js";

/** Exit code for an unknown/absent subcommand (usage error). */
export const EXIT_USAGE = 2;

/** The three subcommands the dispatcher routes to. */
export const SUBCOMMANDS = ["init", "reset", "erase"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

/** Flags common to all subcommands plus the destructive-op confirmation flag. */
export interface SubcommandArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  cwd: string;
  /** `--yes`/`-y`: skip the interactive confirmation (destructive subcommands). */
  yes: boolean;
  /** `--force`: overwrite an existing cq.toml when running `cq init`. */
  force: boolean;
}

export const USAGE = [
  "usage: cq <command> [options]",
  "",
  "commands:",
  "  init   [--cwd <path>] [--force]   initialise the canonical ledger set",
  "  reset  [--cwd <path>] [--yes|-y]  backup + reinitialise the ledgers (destructive)",
  "  erase  [--cwd <path>] [--yes|-y]  remove the ledger tree (destructive)",
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
    }
  }
  return { cwd: resolveRoot(cwd), yes, force };
}

/** Outcome of a dispatch: the process exit code main() should propagate. */
export interface DispatchOutcome {
  exitCode: number;
}

/** IO seam for the dispatcher so tests can capture usage output. */
export interface DispatchIo {
  out(line: string): void;
  err(line: string): void;
  /** Confirmation IO threaded to the destructive subcommand handlers. */
  confirm: ConfirmIo;
}

function defaultDispatchIo(): DispatchIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    confirm: defaultConfirmIo(),
  };
}

// --- Subcommand handlers -----------------------------------------------------

export async function runInit(args: SubcommandArgs, io: DispatchIo): Promise<DispatchOutcome> {
  const store = new FsLedgerStore({ root: args.cwd });
  await store.init();
  await store.dispose();
  const ledgerNames = CANONICAL_LEDGERS.map((c) => c.name).join(", ");
  io.out(`initialised ledgers at ${args.cwd} (${ledgerNames})`);

  const configPath = path.join(args.cwd, CQ_CONFIG_FILENAME);
  const configExists = await pathExists(configPath);
  if (configExists && !args.force) {
    io.out(
      `cq init: ${CQ_CONFIG_FILENAME} already exists at ${configPath}; re-run with --force to overwrite`,
    );
  } else {
    await fs.writeFile(configPath, CQ_TOML_TEMPLATE, "utf8");
    if (configExists) {
      io.out(`cq init: overwrote ${CQ_CONFIG_FILENAME} at ${configPath}`);
    } else {
      io.out(`cq init: wrote ${CQ_CONFIG_FILENAME} at ${configPath}`);
    }
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
export async function runReset(args: SubcommandArgs, io: DispatchIo): Promise<DispatchOutcome> {
  const decision = await confirmDestructive(
    args.yes,
    `Reset ledgers at ${args.cwd}? Backup -> docs/.backup/ [y/N] `,
    `cq reset: refusing to reset ledgers at ${args.cwd} without confirmation; ` +
      `re-run with --yes to reset non-interactively.`,
    io.confirm,
  );
  if (!decision.proceed) {
    return { exitCode: decision.exitCode };
  }

  const store = new FsLedgerStore({ root: args.cwd });
  await store.init();
  try {
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
 * the destructive set is an EXPLICIT, BOUNDED pair of known paths under the
 * resolved root:
 *
 *   1. `<root>/docs/`     — the entire tree: active `*.md`, `ledgers.yaml`,
 *                           `archive/`, `.backup/`, `logs/`, `.locks/`
 *                           (recursive, force).
 *   2. `<root>/cq.toml`   — the config file, if present (unlink).
 *
 * It is NOT a blind wipe of `<root>`: any sibling under the root (source, etc.)
 * survives. Unlike `reset`, erase does NOT call init() afterward — the suite is
 * left fully un-initialised.
 *
 * No FsLedgerStore is constructed (which would acquire the FS lock and recreate
 * `docs/`): erase removes `.locks/` itself, so holding a lock while deleting it
 * would be self-defeating. The deletes go straight through `node:fs`.
 *
 * Confirmation policy (shared with `reset`, see ./confirm.ts):
 *   - `--yes`             → proceed unattended (no prompt).
 *   - TTY, no `--yes`     → prompt; proceed only on a `y`/`Y` answer.
 *   - non-TTY, no `--yes` → REFUSE (exit 2) — never wipe a tree silently.
 *
 * SAFETY: if neither `<root>/docs` nor `<root>/cq.toml` exists there is nothing
 * to erase; refuse with exit {@link EXIT_USAGE} rather than silently succeed.
 */
export async function runErase(args: SubcommandArgs, io: DispatchIo): Promise<DispatchOutcome> {
  const docsDir = path.join(args.cwd, "docs");
  const configFile = path.join(args.cwd, CQ_CONFIG_FILENAME);

  const docsExists = await pathExists(docsDir);
  const configExists = await pathExists(configFile);

  // SAFETY: nothing to erase → refuse (don't silently succeed on an empty root).
  if (!docsExists && !configExists) {
    io.err(
      `cq erase: nothing to erase at ${args.cwd} ` +
        `(no docs/ tree and no ${CQ_CONFIG_FILENAME}).`,
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

  // Bounded delete of the EXPLICIT set only — never the whole root.
  const removed: string[] = [];
  if (docsExists) {
    await fs.rm(docsDir, { recursive: true, force: true });
    removed.push(docsDir);
  }
  if (configExists) {
    await fs.rm(configFile, { force: true });
    removed.push(configFile);
  }

  io.out(`cq erase: erased ledgers + config at ${args.cwd} (IRREVERSIBLE, no backup)`);
  for (const p of removed) {
    io.out(`  removed: ${p}`);
  }
  return { exitCode: 0 };
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

const HANDLERS: Record<Subcommand, (args: SubcommandArgs, io: DispatchIo) => Promise<DispatchOutcome>> = {
  init: runInit,
  reset: runReset,
  erase: runErase,
};

/**
 * Route `argv` (the args after the program name) to a subcommand. The FIRST
 * positional arg selects the subcommand; the rest are its flags. An unknown or
 * absent subcommand prints {@link USAGE} to stderr and resolves exit
 * {@link EXIT_USAGE} WITHOUT invoking a handler.
 */
export async function dispatch(
  argv: readonly string[],
  io: DispatchIo = defaultDispatchIo(),
): Promise<DispatchOutcome> {
  const first = argv[0];
  if (first === undefined || !isSubcommand(first)) {
    io.err(USAGE);
    return { exitCode: EXIT_USAGE };
  }
  const args = parseSubcommandArgs(argv.slice(1));
  return HANDLERS[first](args, io);
}

export async function main(argv: readonly string[]): Promise<void> {
  const { exitCode } = await dispatch(argv);
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
