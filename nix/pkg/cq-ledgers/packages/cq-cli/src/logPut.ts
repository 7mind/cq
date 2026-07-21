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
 * T406 wires dispatch + parsing + validation.
 * T410 implements the fs-backend write path (redaction + JSONL validation +
 * atomic write to <root>/.cq/logs/<rel>).
 */

import { promises as nodeFs } from "node:fs";
import * as path from "node:path";
import { loadConfig } from "@cq/config";
import {
  resolveLedgerBackend,
  redactSecrets,
  validateJsonl,
  atomicWrite,
  GitPlumbing,
  StaleRefError,
  LEDGER_STORAGE_DIRNAME,
  LEDGER_LOGS_DIRNAME,
  resolveProjectKey,
  resolveLogsDir,
  PostgresLedgerStore,
  openPgPool,
  ensureSchema,
  resolvePostgresDsn,
  type TreeEntry,
} from "@cq/ledger";

/** Exit code for a usage / validation error. */
export const EXIT_USAGE = 2;

/** Regular-file git mode for a log blob (mirrors GitPersistence's BLOB_MODE). */
const BLOB_MODE = "100644";

/**
 * Bounded retries for the orphan-ref CAS read-modify-write. `cq log put` runs
 * OUTSIDE the server's per-ledger lock, so a concurrent {@link GitPersistence}
 * advance (or a peer `log put`) can move the ref between our read and our CAS,
 * surfacing as a {@link StaleRefError}. We re-read (expectedOld + entries) and
 * rebuild on each stale CAS up to this many attempts before giving up.
 */
const MAX_CAS_ATTEMPTS = 8;

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

/**
 * Run `log put`.  Validates the parsed arguments (which have already been
 * checked by {@link parseLogPutArgs}) and performs the write.
 *
 * T406 implements dispatch + parsing + validation.
 * T410 implements the fs-backend write path:
 *   1. Resolve backend via resolveLedgerBackend(cwd).
 *   2. Read source (file or stdin).
 *   3. Apply redactSecrets.
 *   4. If dest ends in .jsonl, validateJsonl — fail with line+reason on error.
 *   5. Atomically write to <cwd>/.cq/<dest>.
 *   6. Print the written absolute path.
 *
 * T413 implements the git-object backend write path: same redaction + strict-
 * JSONL validation, then a CAS-commit of the blob at tree path `<dest>` on the
 * orphan ref `refs/heads/<branch>` under a BOUNDED StaleRefError-retry loop
 * (this runs OUTSIDE the server's per-ledger lock).
 *
 * T499 implements the xdg backend write path: same redaction + strict-JSONL
 * validation, then an atomic write under the project's out-of-tree logs area
 * (`resolveLogsDir(projectKey)`, T495 layout) — the sibling of the xdg
 * primary store's `state/` sub-directory, keyed by the SAME `projectKey` (a
 * committed `[ledger].projectId` override, else the repo's first commit SHA;
 * see projectKey.ts) so every worktree/clone of one repo lands on the same
 * out-of-tree logs area.
 *
 * `gitFactory` is an injection seam for the git-object branch: tests pass a
 * factory that wraps a {@link GitPlumbing} bound to a throwaway repo (and may
 * simulate a {@link StaleRefError} on the first CAS) without a cq.toml-resolved
 * production runner. Production omits it and the real runner is built from
 * `args.cwd` + its `.git` dir.
 */
export async function runLogPut(
  args: LogPutArgs,
  io: LogPutIo,
  gitFactory?: (root: string) => GitPlumbing,
): Promise<LogPutOutcome> {
  const { backend, branch } = resolveLedgerBackend(args.cwd);

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

  if (backend === "git-object") {
    return runLogPutGitObject(args, io, redacted, branch, gitFactory);
  }

  if (backend === "xdg") {
    return runLogPutXdg(args, io, redacted);
  }

  if (backend === "postgres") {
    return runLogPutPostgres(args, io, redacted);
  }

  // backend === 'fs' (the historical default) — write under <cwd>/.cq/<dest>.

  // --- Resolve the on-disk destination path ---
  const destAbs = path.join(args.cwd, LEDGER_STORAGE_DIRNAME, args.dest);

  // Defense-in-depth: ensure the resolved path stays under .cq/logs/ even
  // if validateLogDest was somehow bypassed.
  const storageLogsAbs = path.join(args.cwd, LEDGER_STORAGE_DIRNAME, LEDGER_LOGS_DIRNAME);
  const resolved = path.resolve(destAbs);
  if (!resolved.startsWith(storageLogsAbs + path.sep) && resolved !== storageLogsAbs) {
    io.err(
      `cq log put: resolved destination "${resolved}" escapes ${LEDGER_STORAGE_DIRNAME}/${LEDGER_LOGS_DIRNAME}/ — rejected`,
    );
    return { exitCode: 1 };
  }

  // --- Atomic write ---
  await atomicWrite(destAbs, redacted);

  io.out(destAbs);
  return { exitCode: 0 };
}

/**
 * The git-object backend write path (T413). Commits `content` as a blob at the
 * storage-relative tree path `args.dest` (the orphan tree is rooted at the
 * storage CONTENTS, so the tree path is `args.dest` verbatim — NO `.cq/` prefix,
 * just as {@link GitPersistence} stores `logs/<rel>`) on `refs/heads/<branch>`.
 *
 * Mirrors {@link GitPersistence.advance}'s read-modify-write EXACTLY so foreign
 * tree paths survive: expectedOld = readRef(ref); current = lsTreeEntries(ref);
 * sha = hashObject(content); rebuild entries with `<dest>` replaced/added;
 * tree = writeTree(entries); commit = commitTree(tree, expectedOld); CAS
 * updateRef(ref, commit, expectedOld). Because this runs OUTSIDE the server's
 * per-ledger lock, the read→CAS cycle is wrapped in a BOUNDED retry loop that
 * RE-READS (expectedOld + entries) and rebuilds on a {@link StaleRefError}, so a
 * concurrent advance's foreign paths survive and the log entry is not clobbered.
 */
async function runLogPutGitObject(
  args: LogPutArgs,
  io: LogPutIo,
  content: string,
  branch: string,
  gitFactory?: (root: string) => GitPlumbing,
): Promise<LogPutOutcome> {
  const ref = `refs/heads/${branch}`;
  const git =
    gitFactory !== undefined
      ? gitFactory(args.cwd)
      : GitPlumbing.withCwd(args.cwd, path.join(args.cwd, ".git"));

  // The blob is content-addressed: its sha is stable across retries, so we hash
  // once outside the loop (a re-hash on retry would produce the identical sha).
  const blobSha = await git.hashObject(content);
  const treePath = args.dest;
  const message = `ledger: log put ${treePath}`;

  let lastErr: StaleRefError | undefined;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    // RE-READ expectedOld + entries every attempt so a concurrent advance's
    // foreign paths (and other tree paths) are carried forward on a retry.
    const expectedOld = await git.readRef(ref);
    const current: TreeEntry[] =
      expectedOld === null ? [] : await git.lsTreeEntries(ref);

    // Rebuild entries with our path replaced/added (mirrors advance()).
    const kept = current.filter((e) => e.path !== treePath);
    kept.push({ mode: BLOB_MODE, sha: blobSha, path: treePath });

    const tree = await git.writeTree(kept);
    const commit = await git.commitTree(tree, expectedOld, message);
    try {
      await git.updateRef(ref, commit, expectedOld);
      io.out(`${ref}:${treePath}`);
      return { exitCode: 0 };
    } catch (e) {
      if (e instanceof StaleRefError) {
        // A concurrent writer moved the ref between our read and the CAS.
        // Re-read + rebuild on the next iteration so we do not clobber the peer.
        lastErr = e;
        continue;
      }
      throw e;
    }
  }

  io.err(
    `cq log put: ref ${ref} kept moving under concurrent writers; gave up after ` +
      `${MAX_CAS_ATTEMPTS} CAS attempts${lastErr ? ` (last: ${lastErr.message})` : ""}`,
  );
  return { exitCode: 1 };
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
 * mirroring the fs branch's `<root>/.cq/<dest>` layout, just rooted at the
 * out-of-tree logs dir instead of `<root>/.cq`.
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

/**
 * The postgres backend write path (T575, Q274/Q285). Same redaction +
 * strict-JSONL validation as every other backend (run by the caller,
 * `runLogPut`); only the final write differs — into the tenant-keyed `logs`
 * table (T572 schema) via {@link PostgresLedgerStore.putLog} instead of the
 * xdg out-of-tree files.
 *
 * HONEST-MINIMAL NOTE (per the task method): `createLedgerStore` — the ONE
 * backend-selecting store factory — does NOT yet wire `backend = 'postgres'`
 * (that is T577's job); this branch is written against the seam T577 will
 * complete, constructing a `PostgresLedgerStore` directly from the T571 DSN
 * resolver + T572 schema module rather than blocking this task on T577.
 * Tenant registration (the `projects` row) is documented as T574's concern,
 * not yet implemented anywhere in this codebase — until T574 lands, this
 * function performs the same minimal `INSERT ... ON CONFLICT DO NOTHING`
 * upsert T573's own test harness (store-postgres.test.ts) uses, so a fresh
 * tenant is immediately usable. `projectKey` reuses the SAME repo-identity
 * resolver ({@link resolveProjectKey}) the xdg backend keys its out-of-tree
 * store off, for lack of any postgres-specific tenant-keying primitive today
 * — T574 may replace this with a dedicated mechanism.
 *
 * The destination-path normalisation mirrors {@link runLogPutXdg} EXACTLY
 * (strip the leading `logs/` prefix via {@link LOGS_PREFIX}) so
 * sessionLogs/rawLogs references keep resolving identically regardless of
 * backend.
 */
async function runLogPutPostgres(
  args: LogPutArgs,
  io: LogPutIo,
  content: string,
): Promise<LogPutOutcome> {
  const config = loadConfig(args.cwd);
  const ledgerConfig = config?.ledger;
  if (ledgerConfig === null || ledgerConfig === undefined) {
    io.err(
      "cq log put: [ledger] backend = 'postgres' requires a [ledger] table in cq.toml",
    );
    return { exitCode: 1 };
  }

  // resolvePostgresDsn lets PostgresDsnResolutionError propagate as the
  // fail-fast (mirrors resolveProjectKey's ProjectKeyResolutionError below —
  // neither is caught here, consistent with the rest of this function).
  const resolution = resolvePostgresDsn(ledgerConfig, process.env);
  // PG_DRIVER_DEFAULTS (no explicit DSN, but standard PG* env vars present)
  // means "let the driver read its own defaults" — Bun's SQL constructor
  // does this when given an empty connection string.
  const dsn = resolution.kind === "dsn" ? resolution.dsn : "";

  const pool = openPgPool(dsn);
  let store: PostgresLedgerStore | undefined;
  try {
    await ensureSchema(pool);
    const projectKey = await resolveProjectKey({
      repoRoot: args.cwd,
      projectId: ledgerConfig.projectId,
    });
    const displayName = config?.project?.name ?? projectKey;
    await pool`
      INSERT INTO projects (project_key, display_name)
      VALUES (${projectKey}, ${displayName})
      ON CONFLICT (project_key) DO NOTHING
    `;
    store = new PostgresLedgerStore({ pool, projectKey, displayName });
    await store.init();

    // args.dest is validated (validateLogDest) to start with "logs/" — strip
    // it exactly as runLogPutXdg does so the stored key matches what readLog
    // resolves (bare, logsDir-relative form).
    const rel = args.dest.slice(LOGS_PREFIX.length);
    await store.putLog(rel, content);

    io.out(`postgres:${projectKey}/${args.dest}`);
    return { exitCode: 0 };
  } finally {
    // store.dispose() closes the pool; if construction never reached that
    // point (an error thrown before `store` was assigned), close it here.
    if (store !== undefined) {
      await store.dispose();
    } else {
      await pool.close();
    }
  }
}
