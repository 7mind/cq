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
 * Redacts and validates artifacts before writing to XDG storage or the remote service.
 */

import { promises as nodeFs } from "node:fs";
import * as path from "node:path";
import { loadConfig } from "@cq/config";
import {
  resolveLedgerBackend,
  redactSecrets,
  validateJsonl,
  atomicWrite,
  LEDGER_LOGS_DIRNAME,
  resolveProjectKey,
  resolveLogsDir,
} from "@cq/ledger";
import { withRemoteClient } from "./remoteClient.js";

/** Exit code for a usage / validation error. */
export const EXIT_USAGE = 2;

/** IO seam: stdout / stderr line sinks + stdin reader (threaded from the dispatcher). */
export interface LogPutIo {
  out(line: string): void;
  err(line: string): void;
  /**
   * Read all of stdin as a string.  Used when `args.stdin` is true.
   * Injected so tests can provide a controlled string without needing a real
   * tty/pipe.  The default (production) implementation reads `process.stdin`.
   */
  readStdin(): Promise<string>;
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

  // After "logs/" there must be at least one non-empty sub-path component.
  // Reject "logs/" alone (which would point to the logs directory itself).
  if (normalised === "logs/" || normalised === "logs") {
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

/** Redact and validate a log before writing it to the selected supported store. */
export async function runLogPut(
  args: LogPutArgs,
  io: LogPutIo,
): Promise<LogPutOutcome> {
  const { backend } = resolveLedgerBackend(args.cwd);
  if (backend !== "xdg" && backend !== "remote") {
    io.err("cq log put: unsupported ledger backend; select xdg or remote.");
    return { exitCode: EXIT_USAGE };
  }

  // --- Read source ---
  let raw: string;
  if (args.stdin) {
    raw = await io.readStdin();
  } else {
    // args.src is defined when stdin is false (enforced by parseLogPutArgs).
    raw = await nodeFs.readFile(args.src!, "utf8");
  }

  // --- Redact secrets (SAME for both backends) ---
  const redacted = redactSecrets(raw);

  // --- Empty-input refusal (T866): fail fast BEFORE jsonl validation and any
  // backend write. Checking POST-redaction also fails closed if the content
  // ever redacts to empty. ---
  if (redacted.trim().length === 0) {
    io.err(`cq log put: refusing to write an empty log to ${args.dest}`);
    return { exitCode: 1 };
  }

  // --- JSONL validation (only for .jsonl destinations; SAME for both
  // backends; MUST fail BEFORE any write / ref mutation) ---
  if (args.dest.endsWith(".jsonl")) {
    const validation = validateJsonl(redacted);
    if (!validation.ok) {
      io.err(
        `cq log put: malformed JSONL at line ${validation.line}: ${validation.reason}`,
      );
      return { exitCode: 1 };
    }
  }

  if (backend === "remote") {
    const rel = args.dest.startsWith("logs/") ? args.dest.slice("logs/".length) : args.dest;
    const stored = await withRemoteClient(args.cwd, (client) => client.putLog(rel, redacted));
    io.out(`remote:${stored.path}`);
    return { exitCode: 0 };
  }

  return runLogPutXdg(args, io, redacted);
}

/** `logs/` prefix stripped from `args.dest` before joining under the resolved logs dir. */
const LOGS_PREFIX = `${LEDGER_LOGS_DIRNAME}/`;

/**
 * The xdg backend write path (T499). Resolves the SAME `projectKey` the xdg
 * primary store keys off (`[ledger].projectId` override, else the repo's
 * first commit SHA — see projectKey.ts) so `cq log put` lands in the same
 * out-of-tree logs area regardless of which worktree/clone it runs from, then
 * atomically writes the (already redacted + validated) `content` under
 * `resolveLogsDir(projectKey)/<dest with the leading "logs/" stripped>` —
 * keeping log artifacts outside the working tree.
 *
 * `resolveProjectKey` lets {@link ProjectKeyResolutionError} propagate as the
 * fail-fast (a shallow clone or a non-git/no-commit root has no stable
 * identity to key the logs area off — same rationale as createLedgerStore's
 * xdg branch, Q246).
 */
async function runLogPutXdg(
  args: LogPutArgs,
  io: LogPutIo,
  content: string,
): Promise<LogPutOutcome> {
  const config = loadConfig(args.cwd);
  const projectId = config?.ledger?.projectId ?? null;
  const projectKey = await resolveProjectKey({ repoRoot: args.cwd, projectId });
  const logsDir = resolveLogsDir(projectKey);

  // args.dest is validated (validateLogDest) to start with "logs/".
  const rel = args.dest.slice(LOGS_PREFIX.length);
  const destAbs = path.join(logsDir, rel);

  // Defense-in-depth: ensure the resolved path stays under the out-of-tree
  // logs dir even if validateLogDest was somehow bypassed.
  const resolved = path.resolve(destAbs);
  if (!resolved.startsWith(logsDir + path.sep) && resolved !== logsDir) {
    io.err(
      `cq log put: resolved destination "${resolved}" escapes the out-of-tree logs dir ${logsDir} — rejected`,
    );
    return { exitCode: 1 };
  }

  await atomicWrite(destAbs, content);
  io.out(destAbs);
  return { exitCode: 0 };
}
