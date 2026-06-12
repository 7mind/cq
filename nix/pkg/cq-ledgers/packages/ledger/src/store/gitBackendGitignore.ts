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
 * idempotently: if the marker is already present the marked span is compared
 * against the current block and replaced when stale, so repeated startups /
 * `cq init` runs / `cq move-ledger` invocations always converge to the current
 * block without duplication.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Start marker comment guarding the git-backend block (idempotency anchor). */
export const GIT_BACKEND_GITIGNORE_MARKER = "# cq git-object ledger backend (managed) — do not edit";

/** End marker comment closing the git-backend block. */
export const GIT_BACKEND_GITIGNORE_END_MARKER = "# cq git-object ledger backend (managed) — end";

/**
 * The full block appended to `.gitignore` for the git-object backend. The ledger
 * lives on the orphan ref, so its on-disk projection under `docs/` stays
 * untracked on the working branch. The lockfiles under `docs/.locks` are already
 * runtime-only and must never be committed either.
 *
 * The block runs from {@link GIT_BACKEND_GITIGNORE_MARKER} (inclusive) to
 * {@link GIT_BACKEND_GITIGNORE_END_MARKER} (inclusive).
 */
export const GIT_BACKEND_GITIGNORE_BLOCK = [
  GIT_BACKEND_GITIGNORE_MARKER,
  "docs/*.md",
  "docs/ledgers.yaml",
  "docs/.locks/",
  "docs/logs/",
  GIT_BACKEND_GITIGNORE_END_MARKER,
].join("\n");

/**
 * Locate the marker-guarded span within `content` and return `{ start, end }`
 * where `start` is the index of the START marker and `end` is the exclusive
 * index of the character immediately after the last character of the span
 * (i.e. after the END marker line, including its trailing `\n` if present, or
 * after the blank-line bound for legacy blocks).
 *
 * Returns `null` when the start marker is absent.
 *
 * Legacy format (no END marker): the span runs from the START marker line to
 * the next blank line (or EOF), NOT including content beyond the blank line.
 */
function locateSpan(content: string): { start: number; end: number } | null {
  const startIdx = content.indexOf(GIT_BACKEND_GITIGNORE_MARKER);
  if (startIdx === -1) return null;

  const endMarkerIdx = content.indexOf(GIT_BACKEND_GITIGNORE_END_MARKER, startIdx);
  if (endMarkerIdx !== -1) {
    // Current format: span ends after the END marker line (including trailing \n).
    const afterEnd = endMarkerIdx + GIT_BACKEND_GITIGNORE_END_MARKER.length;
    const end = content[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
    return { start: startIdx, end };
  }

  // Legacy format: no END marker — bound the span at the next blank line or EOF.
  // A blank line is "\n\n" (an empty line between newline-terminated lines).
  // We search from the start marker's position for \n\n.
  const afterStart = startIdx + GIT_BACKEND_GITIGNORE_MARKER.length;
  const blankLineIdx = content.indexOf("\n\n", afterStart);
  if (blankLineIdx === -1) {
    // No blank line — span runs to EOF.
    return { start: startIdx, end: content.length };
  }
  // Span ends at the first \n of the \n\n (the line ending of the last body line);
  // the second \n is the blank line itself, which belongs to surrounding content.
  return { start: startIdx, end: blankLineIdx + 1 };
}

/**
 * Idempotently ensure `<root>/.gitignore` contains the current git-backend block.
 *
 * - Absent `.gitignore` → created with the block.
 * - Present without the marker → the block is appended (preserving existing
 *   content), separated by a blank line.
 * - Present WITH the marker (current format) → the existing span is compared
 *   byte-for-byte with the current block; if equal, returns `false` (no-op);
 *   if stale, the span is replaced with the current block in-place.
 * - Present WITH the marker (legacy format, no END marker) → the legacy span
 *   (from start marker to next blank line / EOF) is replaced with the current
 *   START…END block, migrating to the new format.
 *
 * Returns `true` when the file was written/modified, `false` when it was already
 * current (no change needed).
 */
export async function ensureGitBackendGitignore(root: string): Promise<boolean> {
  const gitignorePath = path.join(root, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    existing = null;
  }

  if (existing === null || existing.length === 0) {
    await fs.writeFile(gitignorePath, `${GIT_BACKEND_GITIGNORE_BLOCK}\n`, "utf8");
    return true;
  }

  const span = locateSpan(existing);
  if (span === null) {
    // Marker absent — append, ensuring exactly one blank line separates prior content.
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    await fs.writeFile(gitignorePath, `${existing}${sep}${GIT_BACKEND_GITIGNORE_BLOCK}\n`, "utf8");
    return true;
  }

  // Marker present — check if the existing span already equals the current block.
  const existingSpan = existing.slice(span.start, span.end);
  // The current block as it would appear in the span (with trailing \n).
  const currentSpanText = `${GIT_BACKEND_GITIGNORE_BLOCK}\n`;
  if (existingSpan === currentSpanText) {
    return false; // already current — idempotent no-op
  }

  // Replace the stale span with the current block.
  const before = existing.slice(0, span.start);
  const after = existing.slice(span.end);
  await fs.writeFile(gitignorePath, `${before}${currentSpanText}${after}`, "utf8");
  return true;
}

/**
 * The REMOVAL counterpart of {@link ensureGitBackendGitignore} (T354): strip the
 * marker-guarded git-backend block from `<root>/.gitignore` so the docs ledger
 * projection becomes trackable again under the fs backend (the `--to local`
 * direction of `cq move-ledger`).
 *
 * The block is located by the START marker (to the END marker for current-format
 * blocks; to the next blank line / EOF for legacy blocks that lack the END
 * marker). This is robust to stale block content. The leading blank-line
 * separator inserted by {@link ensureGitBackendGitignore} is also removed so
 * the add → remove round trip restores the file byte-for-byte. Surrounding
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

  const span = locateSpan(existing);
  if (span === null) {
    return false; // marker absent — idempotent no-op
  }

  const before = existing.slice(0, span.start);
  const after = existing.slice(span.end);

  // Drop the leading blank-line separator that ensureGitBackendGitignore wrote:
  // when the block was appended to prior content ending in "\n", a single "\n"
  // was used as separator (so the file has "...\n\n<block>"); strip that extra "\n".
  const trimmedBefore = before.endsWith("\n") ? before.slice(0, -1) : before;
  const next = trimmedBefore + after;

  if (next.trim().length === 0) {
    await fs.rm(gitignorePath, { force: true });
  } else {
    await fs.writeFile(gitignorePath, next, "utf8");
  }
  return true;
}
