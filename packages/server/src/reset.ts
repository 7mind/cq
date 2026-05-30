/**
 * `cq reset` — back up (or, with --no-backup, delete) the regenerable
 * bootstrapped ledger files under `<cwd>/docs/` so the next server start
 * regenerates them fresh. Used to recover from a `BootstrapViolationError`
 * after a canonical-schema change (the on-disk ledger was written under an
 * older schema).
 *
 * The bootstrap artifact set is DERIVED from `@cq/ledger`'s `CANONICAL_LEDGERS`
 * — the single source of truth — never a hardcoded list:
 *   - docs/ledgers.yaml               (the registry)
 *   - docs/<ledger>.md                (one per canonical ledger)
 *   - docs/.locks/                    (advisory lockfiles dir)
 *   - docs/archive/<ledger>/          (archived groups dir — ONLY a dir whose
 *                                      name exactly matches a canonical ledger;
 *                                      NEVER a flat docs/archive/tasks-M*.md)
 *
 * Tracked docs (docs/drafts, docs/logs, docs/research, the flat
 * docs/archive/tasks-M*.md files) are never in the set and are left untouched.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { CANONICAL_LEDGERS } from "@cq/ledger";

/** A single bootstrap artifact that exists on disk and is in scope for reset. */
export type Artifact = Readonly<{
  /** Absolute path. */
  abs: string;
  /** Path relative to the docs dir (preserved inside the backup dir). */
  rel: string;
  /** Whether the artifact is a directory (recursive move/remove). */
  isDir: boolean;
}>;

/** Injectable side-effects so `runReset` is fully testable. */
export type ResetDeps = Readonly<{
  /** Writes a line of normal output. */
  stdout: (s: string) => void;
  /** Writes a line of error output. */
  stderr: (s: string) => void;
  /**
   * Resolves true to proceed, false to abort. Only invoked when interactive
   * confirmation is required (i.e. not `--yes`). The default implementation
   * reads a line from stdin; on a non-TTY it must NOT be called (the caller
   * refuses first — see `runReset`).
   */
  confirm: (prompt: string) => Promise<boolean>;
  /** ISO-8601 UTC timestamp for the backup directory name. */
  now: () => string;
  /** Whether stdin is an interactive terminal. */
  stdinIsTty: () => boolean;
}>;

export type RunResetOpts = Readonly<{
  cwd: string;
  yes: boolean;
  backup: boolean;
}>;

/** Outcome of a reset run; `code` is the intended process exit code. */
export type ResetResult = Readonly<{ code: number }>;

const BACKUP_DIR_NAME = ".ledger-backup";

/**
 * Compute the in-scope bootstrap artifacts that EXIST under `<docsDir>`.
 * Order is deterministic: ledgers.yaml, then per-ledger .md, then per-ledger
 * archive dirs, then .locks. A path is included only if it exists; archive
 * entries are included only when the path is a directory whose basename
 * exactly matches a canonical ledger name.
 */
export async function collectArtifacts(docsDir: string): Promise<Artifact[]> {
  const candidates: Array<{ rel: string; abs: string; mustBeDir: boolean }> = [];

  candidates.push({
    rel: "ledgers.yaml",
    abs: path.join(docsDir, "ledgers.yaml"),
    mustBeDir: false,
  });

  for (const { name } of CANONICAL_LEDGERS) {
    candidates.push({
      rel: `${name}.md`,
      abs: path.join(docsDir, `${name}.md`),
      mustBeDir: false,
    });
  }

  for (const { name } of CANONICAL_LEDGERS) {
    const rel = path.join("archive", name);
    candidates.push({
      rel,
      abs: path.join(docsDir, "archive", name),
      mustBeDir: true,
    });
  }

  candidates.push({
    rel: ".locks",
    abs: path.join(docsDir, ".locks"),
    mustBeDir: true,
  });

  const out: Artifact[] = [];
  for (const c of candidates) {
    let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      st = await fs.lstat(c.abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw e;
    }
    const isDir = st.isDirectory();
    // Defensive: an archive/<ledger> entry is in scope ONLY as a directory.
    // If a same-named flat file somehow exists there it is left untouched.
    if (c.mustBeDir && !isDir) continue;
    out.push({ abs: c.abs, rel: c.rel, isDir });
  }
  return out;
}

/**
 * Default interactive confirmation: print the prompt and read one line from
 * stdin. `y` / `yes` (case-insensitive, trimmed) → true; anything else
 * (including empty line or EOF) → false.
 */
export async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (a) => resolve(a));
      // On EOF (stdin closed without a line) readline emits 'close' without
      // firing the question callback — resolve to empty so we abort.
      rl.on("close", () => resolve(""));
    });
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Move `artifact` into `<backupRoot>/<rel>`, creating parent dirs. Uses
 * `fs.rename` (atomic on the same filesystem) and falls back to a recursive
 * copy+remove across filesystem boundaries (EXDEV).
 */
async function moveInto(artifact: Artifact, backupRoot: string): Promise<void> {
  const dest = path.join(backupRoot, artifact.rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(artifact.abs, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.cp(artifact.abs, dest, { recursive: true });
    await fs.rm(artifact.abs, { recursive: true, force: true });
  }
}

/**
 * Run `cq reset`. Returns the intended exit code; never calls `process.exit`
 * itself so it is unit-testable. All side effects go through `deps`.
 */
export async function runReset(
  opts: RunResetOpts,
  deps: ResetDeps,
): Promise<ResetResult> {
  const docsDir = path.join(opts.cwd, "docs");
  const artifacts = await collectArtifacts(docsDir);

  if (artifacts.length === 0) {
    deps.stdout(`No bootstrapped ledger files to reset under ${docsDir}.`);
    return { code: 0 };
  }

  deps.stdout(`Bootstrapped ledger files under ${docsDir}:`);
  for (const a of artifacts) {
    deps.stdout(`  ${a.rel}${a.isDir ? "/" : ""}`);
  }
  deps.stdout(
    "These regenerable ledger files will be " +
      (opts.backup
        ? "moved to a backup and recreated on next start."
        : "deleted and recreated on next start."),
  );

  // Confirmation gate. `--yes` skips it. Otherwise require an interactive TTY
  // — refuse (rather than hang) on a non-TTY so scripts must pass --yes.
  if (!opts.yes) {
    if (!deps.stdinIsTty()) {
      deps.stderr(
        "refusing to reset without confirmation; pass --yes for non-interactive use",
      );
      return { code: 1 };
    }
    const proceed = await deps.confirm(
      `Reset ${artifacts.length} ledger file(s)? [y/N] `,
    );
    if (!proceed) {
      deps.stdout("Aborted.");
      return { code: 0 };
    }
  }

  if (opts.backup) {
    const backupRoot = path.join(docsDir, BACKUP_DIR_NAME, deps.now());
    await fs.mkdir(backupRoot, { recursive: true });
    for (const a of artifacts) {
      await moveInto(a, backupRoot);
    }
    deps.stdout(
      `Reset complete. ${artifacts.length} file(s) backed up to ${backupRoot} — restart cq to regenerate.`,
    );
  } else {
    for (const a of artifacts) {
      await fs.rm(a.abs, { recursive: true, force: true });
    }
    deps.stdout(
      `Reset complete. ${artifacts.length} file(s) removed — restart cq to regenerate.`,
    );
  }

  return { code: 0 };
}
