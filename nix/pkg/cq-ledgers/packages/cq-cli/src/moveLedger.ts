/**
 * `cq move-ledger` (T354 / G43 / Q193 / R418) — a LOSSLESS BIDIRECTIONAL
 * transplant of the live ledger between the `.cq/` working tree (the `fs`
 * backend) and the orphan ref `refs/heads/<branch>` (the `git-object` backend),
 * via an EXPLICIT `--to git | local` direction.
 *
 * It is a NATIVE TypeScript subcommand (analogous to `runInit`/`runReset`), NOT
 * prompt-driven, and confines all git mutation to the host repo's own refs +
 * working index via {@link GitPlumbing} (no `git checkout`, no working-tree
 * switch).
 *
 * ## --to git
 * Snapshot the on-disk storage ledger (`.cq/<ledger>.md` + `.cq/ledgers.yaml` +
 * `.cq/archive/**`) into the orphan ref's commit (hash-object each file → build
 * the tree STORAGE-RELATIVE → commit-tree on top of the current ref → update-ref),
 * then `git rm --cached` those storage files on the working branch and add the
 * marker-guarded git-backend `.gitignore` block (via
 * {@link ensureGitBackendGitignore}) so they stop being TRACKED. Set
 * `[ledger] backend = 'git-object'` in cq.toml. Per R418 the now-untracked
 * `.cq/*.md` files are LEFT IN PLACE on disk.
 *
 * ## --to local
 * The REVERSE: materialise the orphan ref's tree back to `.cq/<ledger>.md` +
 * `.cq/ledgers.yaml` + `.cq/archive/**` on disk (cat-file each path from the
 * ref), remove the git-backend `.gitignore` block (via
 * {@link removeGitBackendGitignore}), `git add` the restored files so they are
 * TRACKED again, and set `[ledger] backend = 'fs'` in cq.toml.
 *
 * ## Tree layout (storage-relative — mirrors {@link GitPersistence})
 * The orphan ref's tree is rooted at the STORAGE CONTENTS, so a tree path
 * `tasks.md` maps to the on-disk `.cq/tasks.md`, and `archive/<ledger>/<id>.md`
 * to `.cq/archive/<ledger>/<id>.md`.
 *
 * ## Safety
 * - Refuses without `--to`, with a clear usage error (exit {@link EXIT_USAGE}).
 * - Refuses if the TARGET side already holds a NON-EMPTY ledger, unless
 *   `--force` (exit {@link EXIT_USAGE}).
 * - Honours the `[ledger].branch` name (default `cq-ledger`) read from cq.toml.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  GitPlumbing,
  resolveLedgerBackend,
  ensureGitBackendGitignore,
  removeGitBackendGitignore,
  ledgerTreePaths,
  LEDGER_STORAGE_DIRNAME,
  type TreeEntry,
} from "@cq/ledger";

/** The migration direction supplied via `--to`. */
export type MoveDirection = "git" | "local";

/** Exit code for a usage / refusal error (mirrors main.ts EXIT_USAGE). */
const EXIT_USAGE = 2;

/** Regular-file git mode for a ledger blob (matches GitPersistence BLOB_MODE). */
const BLOB_MODE = "100644";

/** The cq.toml config filename (kept local; see main.ts CQ_CONFIG_FILENAME). */
const CQ_CONFIG_FILENAME = "cq.toml";

/** Result of a `move-ledger` run: the resolved exit code for main(). */
export interface MoveOutcome {
  exitCode: number;
}

/** IO seam: stdout / stderr line sinks (threaded from the dispatcher). */
export interface MoveIo {
  out(line: string): void;
  err(line: string): void;
}

/** Parsed `move-ledger` arguments. */
export interface MoveLedgerArgs {
  /** Resolved repo root (the host git checkout / ledger root). */
  root: string;
  /** Migration direction; `null` when `--to` was omitted (refuse). */
  to: MoveDirection | null;
  /** `--force`: proceed even when the target already holds a non-empty ledger. */
  force: boolean;
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

/**
 * Enumerate the on-disk ledger storage files as STORAGE-RELATIVE tree paths:
 * `ledgers.yaml`, every REGISTERED `<ledger>.md`, every `archive/**` file
 * (recursively), and every `logs/**` file (recursive portable runtime state).
 * Ephemeral runtime directories `.locks/` and `.backup/` are EXCLUDED — they
 * belong to the ledger but are not part of the portable tree.
 *
 * Delegates to @cq/ledger's `ledgerTreePaths` — the SINGLE source of truth for
 * "which files belong to the ledger" (shared with `cq erase`). Registry-driven,
 * so a user's NON-ledger `.cq/*.md` is never claimed, snapshotted, or untracked.
 */
async function enumerateDocsFiles(storageDir: string): Promise<string[]> {
  return ledgerTreePaths(storageDir);
}

/**
 * True iff the on-disk storage ledger is NON-EMPTY: at least one `<ledger>.md`
 * file carries an item (a markdown body beyond the registry). A bare
 * `ledgers.yaml` with empty ledger files counts as EMPTY (an init seed). We
 * treat the storage side as non-empty when any `*.md` file's content is non-blank.
 */
async function docsLedgerNonEmpty(storageDir: string): Promise<boolean> {
  if (!(await pathExists(storageDir))) return false;
  const files = await enumerateDocsFiles(storageDir);
  for (const rel of files) {
    // logs/** are portable runtime state, not ledger content — skip them so a
    // tree carrying ONLY logs is not mistaken for a non-empty ledger.
    if (rel === "logs" || rel.startsWith("logs/")) continue;
    if (!rel.endsWith(".md")) continue;
    const text = await fs.readFile(path.join(storageDir, rel), "utf8");
    if (text.trim().length > 0) return true;
  }
  return false;
}

/**
 * True iff the orphan ref carries a NON-EMPTY ledger: the ref exists AND at
 * least one `*.md` tree entry has non-blank content. A freshly-seeded ref (only
 * `ledgers.yaml`, or empty `*.md`) counts as EMPTY.
 */
async function refLedgerNonEmpty(git: GitPlumbing, ref: string): Promise<boolean> {
  const sha = await git.readRef(ref);
  if (sha === null) return false;
  const names = await git.lsTree(ref);
  for (const name of names) {
    // logs/** are portable runtime state, not ledger content — skip them so a
    // ref carrying ONLY logs is not mistaken for a non-empty ledger.
    if (name === "logs" || name.startsWith("logs/")) continue;
    if (!name.endsWith(".md")) continue;
    const text = await git.catFile(ref, name);
    if (text.trim().length > 0) return true;
  }
  return false;
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
 *
 * Exported for reuse by `cq migrate` (T504), which flips the backend to `xdg`
 * after importing the legacy state into the out-of-tree primary.
 */
export async function setLedgerBackend(
  root: string,
  backend: "git-object" | "fs" | "xdg",
): Promise<void> {
  const configPath = path.join(root, CQ_CONFIG_FILENAME);
  let source: string | null;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch {
    source = null;
  }

  const block = `[ledger]\n  backend = "${backend}"\n`;

  if (source === null) {
    await fs.writeFile(configPath, block, "utf8");
    return;
  }

  const lines = source.split("\n");
  // Locate an ACTIVE (non-comment) [ledger] table header.
  const headerIdx = lines.findIndex((l) => /^\s*\[ledger\]\s*$/.test(l));
  if (headerIdx < 0) {
    // No active [ledger] table — append a fresh block (one blank-line separated).
    const sep = source.endsWith("\n") ? "\n" : "\n\n";
    await fs.writeFile(configPath, `${source}${sep}${block}`, "utf8");
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
  await fs.writeFile(configPath, lines.join("\n"), "utf8");
}

/**
 * `--to git`: snapshot `.cq/` into the orphan ref, untrack the storage files,
 * add the git-backend `.gitignore` block, and flip cq.toml to `git-object`.
 */
async function moveToGit(
  args: MoveLedgerArgs,
  git: GitPlumbing,
  ref: string,
  io: MoveIo,
): Promise<MoveOutcome> {
  const storageDir = path.join(args.root, LEDGER_STORAGE_DIRNAME);
  if (!(await pathExists(storageDir))) {
    io.err(`cq move-ledger: no ${LEDGER_STORAGE_DIRNAME}/ ledger tree at ${storageDir} to move to git.`);
    return { exitCode: EXIT_USAGE };
  }

  // Refuse if the TARGET (orphan ref) already holds a non-empty ledger.
  if (!args.force && (await refLedgerNonEmpty(git, ref))) {
    io.err(
      `cq move-ledger: the orphan ref ${ref} already holds a non-empty ledger; ` +
        `re-run with --force to overwrite it.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  const storageFiles = await enumerateDocsFiles(storageDir);
  if (storageFiles.length === 0) {
    io.err(`cq move-ledger: ${LEDGER_STORAGE_DIRNAME}/ at ${storageDir} holds no ledger files to move.`);
    return { exitCode: EXIT_USAGE };
  }

  // Hash-object each file into a tree entry (storage-relative tree path).
  const entries: TreeEntry[] = [];
  for (const rel of storageFiles) {
    const content = await fs.readFile(path.join(storageDir, rel), "utf8");
    const sha = await git.hashObject(content);
    entries.push({ mode: BLOB_MODE, sha, path: rel });
  }

  // Build the tree, commit on top of the current ref (parent → orphan history
  // preserved when present), and CAS the ref forward.
  const expectedOld = await git.readRef(ref);
  const tree = await git.writeTree(entries);
  const commit = await git.commitTree(tree, expectedOld, "ledger: move-ledger --to git");
  await git.updateRef(ref, commit, expectedOld);

  // Untrack the storage ledger files on the working branch (git rm --cached). Only
  // files that are CURRENTLY tracked are passed, so an already-untracked tree
  // (e.g. a re-run) is not an error. Leaves the files ON DISK (R418).
  const tracked = await listTrackedStorageFiles(git, storageFiles);
  if (tracked.length > 0) {
    await git.rmCached(tracked.map((rel) => `${LEDGER_STORAGE_DIRNAME}/${rel}`));
  }

  // Add the marker-guarded git-backend .gitignore block (idempotent).
  await ensureGitBackendGitignore(args.root);

  // Flip cq.toml backend.
  await setLedgerBackend(args.root, "git-object");

  io.out(`cq move-ledger: moved ledger ${LEDGER_STORAGE_DIRNAME}/ → orphan ref ${ref} at ${args.root}`);
  io.out(`  commit: ${commit}`);
  for (const rel of storageFiles) {
    const wasTracked = tracked.includes(rel);
    io.out(`  ${rel}: snapshotted${wasTracked ? ", untracked (left on disk)" : " (was untracked)"}`);
  }
  io.out(`  cq.toml: [ledger] backend = "git-object"`);
  io.out(`  note: the now-untracked ${LEDGER_STORAGE_DIRNAME}/*.md remain on disk — remove them manually once confident.`);
  io.out(
    `  linked-worktree fallback: \`git worktree add <dir> ${ref.replace("refs/heads/", "")}\` ` +
      `to inspect the orphan ref's tree as a checkout.`,
  );
  return { exitCode: 0 };
}

/**
 * `--to local`: materialise the orphan ref's tree to `.cq/` on disk, remove the
 * git-backend `.gitignore` block, re-track the files, and flip cq.toml to `fs`.
 */
async function moveToLocal(
  args: MoveLedgerArgs,
  git: GitPlumbing,
  ref: string,
  io: MoveIo,
): Promise<MoveOutcome> {
  const sha = await git.readRef(ref);
  if (sha === null) {
    io.err(`cq move-ledger: the orphan ref ${ref} does not exist — nothing to move to local.`);
    return { exitCode: EXIT_USAGE };
  }

  const storageDir = path.join(args.root, LEDGER_STORAGE_DIRNAME);

  // Refuse if the TARGET (.cq/) already holds a non-empty ledger.
  if (!args.force && (await docsLedgerNonEmpty(storageDir))) {
    io.err(
      `cq move-ledger: ${LEDGER_STORAGE_DIRNAME}/ at ${storageDir} already holds a non-empty ledger; ` +
        `re-run with --force to overwrite it.`,
    );
    return { exitCode: EXIT_USAGE };
  }

  // Enumerate the ref's tree (storage-relative paths) and cat-file each to disk.
  const treePaths = await git.lsTree(ref);
  if (treePaths.length === 0) {
    io.err(`cq move-ledger: the orphan ref ${ref} carries no ledger files.`);
    return { exitCode: EXIT_USAGE };
  }

  await fs.mkdir(storageDir, { recursive: true });
  const written: string[] = [];
  for (const rel of treePaths) {
    const content = await git.catFile(ref, rel);
    const dest = path.join(storageDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
    written.push(rel);
  }

  // Remove the git-backend .gitignore block so the storage files become trackable.
  await removeGitBackendGitignore(args.root);

  // Re-track the restored storage files (git add).
  await git.add(written.map((rel) => `${LEDGER_STORAGE_DIRNAME}/${rel}`));

  // Flip cq.toml backend.
  await setLedgerBackend(args.root, "fs");

  io.out(`cq move-ledger: moved ledger orphan ref ${ref} → ${LEDGER_STORAGE_DIRNAME}/ at ${args.root}`);
  io.out(`  source commit: ${sha}`);
  for (const rel of written) {
    io.out(`  ${rel}: materialised + tracked`);
  }
  io.out(`  cq.toml: [ledger] backend = "fs"`);
  return { exitCode: 0 };
}

/**
 * Of the candidate storage-relative paths, return those CURRENTLY tracked by git
 * (so `git rm --cached` is only passed tracked paths — an untracked path would
 * make `git rm --cached` fail). Uses `git ls-files`.
 */
async function listTrackedStorageFiles(git: GitPlumbing, storageRelFiles: string[]): Promise<string[]> {
  const tracked = new Set(await git.lsFiles(`${LEDGER_STORAGE_DIRNAME}/`));
  return storageRelFiles.filter((rel) => tracked.has(`${LEDGER_STORAGE_DIRNAME}/${rel}`));
}

/**
 * Run `move-ledger`. Refuses (exit {@link EXIT_USAGE}) without an explicit
 * `--to`; otherwise dispatches to {@link moveToGit} / {@link moveToLocal}. The
 * orphan-ref branch name is read from cq.toml's `[ledger].branch` (default
 * `cq-ledger`).
 */
export async function runMoveLedger(args: MoveLedgerArgs, io: MoveIo): Promise<MoveOutcome> {
  if (args.to === null) {
    io.err(
      `cq move-ledger: --to <git|local> is required (the migration direction is explicit).\n` +
        `  --to git    snapshot ${LEDGER_STORAGE_DIRNAME}/ ledger into the orphan ref, untrack storage files, backend=git-object\n` +
        `  --to local  materialise the orphan ref back to ${LEDGER_STORAGE_DIRNAME}/, re-track, backend=fs`,
    );
    return { exitCode: EXIT_USAGE };
  }

  // Honour the configured branch; default cq-ledger. (Backend value is informational
  // here — move-ledger SETS the backend, it does not require a particular one.)
  const { branch } = resolveLedgerBackend(args.root);
  const ref = `refs/heads/${branch}`;
  const git = GitPlumbing.withCwd(args.root, path.join(args.root, ".git"));

  return args.to === "git"
    ? moveToGit(args, git, ref, io)
    : moveToLocal(args, git, ref, io);
}
