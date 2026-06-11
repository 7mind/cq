/**
 * ensureGitBackendGitignore — the SINGLE source of the git-backend `.gitignore`
 * block text (T357 / R418), shared by `createLedgerStore` (fresh git-object
 * startup / `cq init`) and T354's `cq move-ledger`.
 *
 * The git-object backend stores the ledger on an ORPHAN ref and NEVER touches
 * the working tree, so the on-disk `docs/*.md` + `docs/ledgers.yaml` (written by
 * the FS mirror / a prior fs-backed ledger / init) must be gitignored on the
 * working branch — otherwise a fresh git-object ledger would be accidentally
 * tracked. This helper appends a MARKER-DELIMITED block to `<root>/.gitignore`
 * idempotently: if the marker is already present the file is left untouched, so
 * repeated startups / `cq init` runs / `cq move-ledger` invocations never
 * duplicate it.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Marker comment guarding the git-backend block (idempotency anchor). */
export const GIT_BACKEND_GITIGNORE_MARKER = "# cq git-object ledger backend (managed) — do not edit";

/**
 * The full block appended to `.gitignore` for the git-object backend. The ledger
 * lives on the orphan ref, so its on-disk projection under `docs/` stays
 * untracked on the working branch. The lockfiles under `docs/.locks` are already
 * runtime-only and must never be committed either.
 */
export const GIT_BACKEND_GITIGNORE_BLOCK = [
  GIT_BACKEND_GITIGNORE_MARKER,
  "docs/*.md",
  "docs/ledgers.yaml",
  "docs/.locks/",
  "docs/logs/",
].join("\n");

/**
 * Idempotently ensure `<root>/.gitignore` contains the git-backend block.
 *
 * - Absent `.gitignore` → created with the block.
 * - Present without the marker → the block is appended (preserving existing
 *   content), separated by a blank line.
 * - Present WITH the marker → left untouched (no duplicate).
 *
 * Returns `true` when the block was written/added, `false` when it was already
 * present.
 */
export async function ensureGitBackendGitignore(root: string): Promise<boolean> {
  const gitignorePath = path.join(root, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== null && existing.includes(GIT_BACKEND_GITIGNORE_MARKER)) {
    return false; // already present — idempotent no-op
  }

  if (existing === null || existing.length === 0) {
    await fs.writeFile(gitignorePath, `${GIT_BACKEND_GITIGNORE_BLOCK}\n`, "utf8");
    return true;
  }

  // Append, ensuring exactly one blank line separates prior content from the block.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.writeFile(gitignorePath, `${existing}${sep}${GIT_BACKEND_GITIGNORE_BLOCK}\n`, "utf8");
  return true;
}

/**
 * The REMOVAL counterpart of {@link ensureGitBackendGitignore} (T354): strip the
 * marker-guarded git-backend block from `<root>/.gitignore` so the docs ledger
 * projection becomes trackable again under the fs backend (the `--to local`
 * direction of `cq move-ledger`).
 *
 * The block is the exact {@link GIT_BACKEND_GITIGNORE_BLOCK} text that
 * {@link ensureGitBackendGitignore} appends; this removes that span verbatim,
 * along with the single blank-line separator that precedes it (if any) so the
 * round trip (add → remove) restores the file byte-for-byte. Surrounding
 * user-authored content is preserved.
 *
 * - Absent `.gitignore`, or one without the marker → no-op, returns `false`.
 * - Present WITH the block → the block (and its leading separator) is excised;
 *   if the file is left empty it is removed entirely. Returns `true`.
 */
export async function removeGitBackendGitignore(root: string): Promise<boolean> {
  const gitignorePath = path.join(root, ".gitignore");
  let existing: string;
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    return false; // no .gitignore — nothing to remove
  }

  if (!existing.includes(GIT_BACKEND_GITIGNORE_MARKER)) {
    return false; // marker absent — idempotent no-op
  }

  // Excise the block plus the trailing newline ensureGitBackendGitignore wrote
  // (`${BLOCK}\n`), then any leading blank-line separator, so the round trip is
  // byte-exact.
  const blockWithNl = `${GIT_BACKEND_GITIGNORE_BLOCK}\n`;
  const idx = existing.indexOf(blockWithNl);
  let next: string;
  if (idx >= 0) {
    const before = existing.slice(0, idx);
    const after = existing.slice(idx + blockWithNl.length);
    // ensureGitBackendGitignore joined prior content to the block with a single
    // "\n" (when content already ended in "\n") — drop that separating newline.
    const trimmedBefore = before.endsWith("\n") ? before.slice(0, -1) : before;
    next = trimmedBefore + after;
  } else {
    // The block text without a trailing newline (it was written as the whole
    // file: `${BLOCK}\n`, but a later manual edit may have changed the tail).
    next = existing.replace(GIT_BACKEND_GITIGNORE_BLOCK, "");
  }

  if (next.trim().length === 0) {
    await fs.rm(gitignorePath, { force: true });
  } else {
    await fs.writeFile(gitignorePath, next, "utf8");
  }
  return true;
}
