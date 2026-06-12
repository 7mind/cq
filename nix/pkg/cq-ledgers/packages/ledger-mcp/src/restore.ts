/**
 * restore — the `ledger-mcp restore --from-cache` subcommand (T313, Q169).
 *
 * Copies the per-root cache mirror that {@link mirrorMutation} maintains under
 * the XDG cache base back into `<root>/.cq/`. The mirror is a faithful subtree
 * of `<root>/` (it stores `.cq/<ledger>.md`, `.cq/ledgers.yaml`, and
 * `.cq/archive/<ledger>/*.md`), so restore is the symmetric inverse of the
 * mirror writer: read every file the mirror holds and atomically (tmp+rename)
 * write it onto the corresponding in-repo path.
 *
 * The cache directory is computed by the SHARED {@link cacheMirrorDir} exported
 * from @cq/ledger — the sha256-of-root hash logic lives there ONCE and is never
 * duplicated here. The atomic write reuses @cq/ledger's {@link atomicWrite}
 * primitive (the same tmp+fsync+rename the store and the mirror writer use).
 *
 * This is the ONE ledger lifecycle op hosted by ledger-mcp; the rest
 * (init/reset/erase) live in the `cq` CLI.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cacheMirrorDir, atomicWrite, LEDGER_STORAGE_DIRNAME } from "@cq/ledger";

/**
 * Per-ledger restored-file count, mirroring the {@link ResetSummary} shape the
 * `cq reset` CLI prints. `ledger` is the basename without `.md` for an active
 * ledger file, `ledgers.yaml` for the registry, or `archive/<ledger>` for an
 * archived-milestone file group.
 */
export interface RestoreSummary {
  /** Absolute cache mirror dir the files were restored from. */
  cacheDir: string;
  /** Absolute store root the files were restored INTO. */
  root: string;
  /** Restored file count grouped by logical ledger/source. */
  ledgers: Array<{ name: string; fileCount: number }>;
  /** Total files restored across all groups. */
  totalFiles: number;
}

/** Thrown when the cache mirror dir is absent or holds no files to restore. */
export class CacheMirrorMissingError extends Error {
  constructor(cacheDir: string) {
    super(
      `ledger-mcp restore: no cache mirror to restore from at ${cacheDir} ` +
        `(the directory is absent or empty).`,
    );
    this.name = "CacheMirrorMissingError";
  }
}

/**
 * Recursively collect every file under `dir`, returned as paths RELATIVE to
 * `dir` (posix-joined via node:path). A missing `dir` yields `[]`.
 */
async function collectFiles(dir: string, rel = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(dir, childRel)));
    } else if (entry.isFile()) {
      files.push(childRel);
    }
  }
  return files;
}

/**
 * Map a mirror-relative path (e.g. `.cq/tasks.md`, `.cq/ledgers.yaml`,
 * `.cq/archive/tasks/M1.md`) to the logical group name used in the summary.
 */
function groupOf(relPath: string): string {
  const parts = relPath.split(path.sep);
  // All mirrored files live under `.cq/`.
  if (parts[0] === LEDGER_STORAGE_DIRNAME) {
    if (parts[1] === "archive" && parts[2] !== undefined) return `archive/${parts[2]}`;
    if (parts[1] !== undefined && parts[1].endsWith(".md")) {
      return parts[1].slice(0, -".md".length);
    }
    if (parts[1] !== undefined) return parts[1];
  }
  return relPath;
}

/**
 * Restore the cache mirror for `root` back into `<root>/.cq/`. Resolves the
 * mirror dir via {@link cacheMirrorDir}, refuses (throws
 * {@link CacheMirrorMissingError}) if it is absent/empty, otherwise atomically
 * copies every mirrored file onto its in-repo path and returns a per-group
 * file-count summary.
 */
export async function restoreFromCache(root: string): Promise<RestoreSummary> {
  const cacheDir = cacheMirrorDir(root);
  const relFiles = await collectFiles(cacheDir);
  if (relFiles.length === 0) {
    throw new CacheMirrorMissingError(cacheDir);
  }

  const counts = new Map<string, number>();
  for (const rel of relFiles.sort()) {
    const src = path.join(cacheDir, rel);
    const dest = path.join(root, rel);
    const text = await fs.readFile(src, "utf8");
    await atomicWrite(dest, text);
    const group = groupOf(rel);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const ledgers = Array.from(counts.entries())
    .map(([name, fileCount]) => ({ name, fileCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { cacheDir, root, ledgers, totalFiles: relFiles.length };
}
