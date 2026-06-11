/**
 * `cq log put` (T406 / G49) — write a log file into the ledger's `logs/`
 * directory from a local source file OR from stdin.
 *
 * Entry point:  `cq log put <src>|--stdin --dest logs/<rel>`
 *
 * Arg contract:
 *   - `--stdin`          read input from process.stdin (mutually exclusive with
 *                        a positional source path).
 *   - `--dest <rel>`     docs-relative destination path; MUST start with
 *                        `logs/` and must contain no `.` or `..` segments.
 *                        Validated by {@link validateLogDest}; fail-fast on
 *                        escape attempts.
 *   - `<src>`            positional source path (required when `--stdin`
 *                        absent).
 *
 * This task (T406) wires dispatch + parsing + validation.  The actual fs/git
 * write body is deferred to a later task; the handler validates arguments and
 * throws a clear "not yet implemented" for the write path.
 */

import * as path from "node:path";

/** Exit code for a usage / validation error. */
export const EXIT_USAGE = 2;

/** IO seam: stdout / stderr line sinks (threaded from the dispatcher). */
export interface LogPutIo {
  out(line: string): void;
  err(line: string): void;
}

/** Parsed `log put` arguments (after validation). */
export interface LogPutArgs {
  /**
   * Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute).
   * Supplied by the dispatcher from {@link SubcommandArgs.cwd}.
   */
  cwd: string;
  /**
   * `--stdin`: read input from stdin instead of a file.
   * Mutually exclusive with `src`.
   */
  stdin: boolean;
  /**
   * Source file path (positional argument).
   * Present when `stdin` is false; `undefined` when `stdin` is true.
   */
  src: string | undefined;
  /**
   * Docs-relative destination path.  Must start with `logs/` and contain no
   * `..` segments or leading `/`.  Example: `"logs/raw/2026-06-11.jsonl"`.
   */
  dest: string;
}

/** Result of a `log put` run: the resolved exit code for the dispatcher. */
export interface LogPutOutcome {
  exitCode: number;
}

/**
 * Validate a `--dest` value: it must be a docs-relative path whose FIRST
 * segment is `logs`, with no leading `/`, no `.` or `..` segments, and no
 * attempt to escape via normalisation.
 *
 * Returns the normalised path on success; throws a descriptive Error on any
 * violation (fail-fast).
 */
export function validateLogDest(dest: string): string {
  if (dest.length === 0) {
    throw new Error("cq log put: --dest must not be empty");
  }

  // Reject an absolute path (leading /).  Use posix so behaviour is
  // forward-slash on all platforms (--dest is always a docs-relative path).
  if (path.posix.isAbsolute(dest)) {
    throw new Error(`cq log put: --dest must be a relative path, got "${dest}"`);
  }

  // Normalise with posix rules to catch `./`, redundant separators, and
  // escape attempts: `logs/../secrets` → `secrets`, `logs/./x` → `logs/x`.
  const normalised = path.posix.normalize(dest);

  // After normalisation the path must start with "logs/".
  // We require at least one sub-path component, so "logs" alone is rejected.
  // Any `..` escape (e.g. `logs/../secrets` → `secrets`) is caught here.
  if (!normalised.startsWith("logs/")) {
    throw new Error(
      `cq log put: --dest must be under logs/ (docs-relative), got "${dest}"` +
        (normalised !== dest ? ` (normalises to "${normalised}")` : ""),
    );
  }

  return normalised;
}

/**
 * Parse `log put` raw argv (the tokens AFTER `log put`) into {@link LogPutArgs},
 * applying all validation.  Throws a descriptive Error on any invalid input
 * (the caller is expected to catch, emit to stderr, and exit {@link EXIT_USAGE}).
 *
 * `cwd` is supplied separately (resolved by the top-level dispatcher from
 * `--cwd` / `$LEDGER_ROOT` / CWD, which is processed before `log put` argv).
 */
export function parseLogPutArgs(cwd: string, argv: readonly string[]): LogPutArgs {
  let useStdin = false;
  let dest: string | undefined;
  let src: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdin") {
      useStdin = true;
    } else if (a === "--dest") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq log put: --dest requires a value");
      }
      dest = v;
    } else if (a !== undefined && a.startsWith("--dest=")) {
      dest = a.slice("--dest=".length);
    } else if (a === "--cwd") {
      // --cwd is consumed by the top-level dispatcher; skip it + its value.
      i += 1;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      // --cwd=<value> form: skip entirely.
    } else if (a !== undefined && !a.startsWith("-")) {
      // Positional source path.
      if (src !== undefined) {
        throw new Error(`cq log put: unexpected extra positional argument "${a}"`);
      }
      src = a;
    } else if (a !== undefined && a.startsWith("-")) {
      throw new Error(`cq log put: unknown flag "${a}"`);
    }
  }

  // Both --stdin and a positional src given → conflict.
  if (useStdin && src !== undefined) {
    throw new Error("cq log put: --stdin and a source path are mutually exclusive");
  }
  // Neither --stdin nor src → require one.
  if (!useStdin && src === undefined) {
    throw new Error("cq log put: a source path or --stdin is required");
  }
  // --dest is required.
  if (dest === undefined) {
    throw new Error("cq log put: --dest <logs/…> is required");
  }

  const validatedDest = validateLogDest(dest);

  return { cwd, stdin: useStdin, src, dest: validatedDest };
}

/**
 * Run `log put`.  Validates the parsed arguments (which have already been
 * checked by {@link parseLogPutArgs}) and performs the write.
 *
 * T406 implements dispatch + parsing + validation; the actual fs/git write
 * body is deferred to a later task.
 */
export async function runLogPut(args: LogPutArgs, io: LogPutIo): Promise<LogPutOutcome> {
  // Argument validation is performed by parseLogPutArgs before this function
  // is called.  The write body is not yet implemented (T406 scope).
  io.err("cq log put: not yet implemented (write body deferred to a later task)");
  return { exitCode: 1 };
}
