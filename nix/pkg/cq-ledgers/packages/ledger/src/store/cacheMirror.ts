/**
 * cacheMirror — a node-only `~/.cache` mirror writer for FsLedgerStore.
 *
 * On each mutation the store mirrors ONLY the file(s) the op touched into a
 * per-root directory under the XDG cache base, overwriting the single latest
 * copy in place (no journal, no rotation). A restore CLI (T313) reuses the
 * SAME path-scheme function {@link cacheMirrorDir} — the hash logic lives here
 * once and is never duplicated.
 *
 * The mirror is best-effort: a mirror failure is swallowed (logged to stderr)
 * by the caller exactly like the onMutation hook, so it never blocks or
 * unwinds the store's write path.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./fsAtomic.js";

/** Length of the absRootDir sha256 digest suffix used to disambiguate roots. */
const ROOT_HASH_LEN = 12;

/**
 * The mirror directory for a ledger root `absRootDir`. SHARED with the restore
 * CLI (T313) — do NOT reimplement this scheme anywhere else.
 *
 *   <cacheBase>/cq/ledgers/<basename(absRootDir)>-<sha256(absRootDir)[:12]>
 *
 * where `cacheBase = $XDG_CACHE_HOME ?? <homedir>/.cache`. The basename keeps
 * the dir human-recognisable; the hex suffix keeps two roots with the same
 * basename distinct.
 */
export function cacheMirrorDir(absRootDir: string): string {
  const cacheBase = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const suffix = createHash("sha256").update(absRootDir).digest("hex").slice(0, ROOT_HASH_LEN);
  return path.join(cacheBase, "cq", "ledgers", `${path.basename(absRootDir)}-${suffix}`);
}

/**
 * The filesystem layout the store owns, resolved once by the caller so the
 * mirror can map a `ledgerId` and op to the absolute source file(s) it touched.
 * All paths are absolute.
 */
export interface MirrorLayout {
  /** Absolute store root (the server --cwd); the basis for the mirror dir. */
  readonly rootDir: string;
  /** Absolute `<root>/.cq` directory. */
  readonly docsDir: string;
  /** Absolute `<root>/.cq/archive` directory. */
  readonly archiveDir: string;
  /** Absolute `<root>/.cq/ledgers.yaml` registry path. */
  readonly registryPath: string;
}

/**
 * Mirror the file(s) a single mutation touched into the cache dir, preserving
 * the source's path RELATIVE to the store root (so the mirror is a faithful
 * subtree of `<root>/`). For:
 *   - any op: the changed `.cq/<ledgerId>.md`;
 *   - a `create` op additionally: `.cq/ledgers.yaml` (the registry is
 *     rewritten when a new non-canonical ledger is created);
 *   - an `archive` op additionally: the new archive file(s) for `ledgerId`
 *     under `.cq/archive/<ledgerId>/` and `.cq/ledgers.yaml` (the registry
 *     is rewritten on archive of a non-milestones ledger; mirror it always on
 *     archive to stay faithful).
 *   - an `update` op: only the ledger `.md` file (the registry is NOT
 *     rewritten on update).
 *
 * Each file is copied via {@link atomicWrite} (tmp + rename) — the SAME atomic
 * primitive the store uses for its own writes — so a concurrent reader of the
 * mirror never observes a torn file. A missing source file is tolerated
 * (ENOENT): the op may have removed it, or it may not exist for this ledger.
 *
 * This function may throw (e.g. on an unexpected I/O error); the caller MUST
 * guard it so a mirror failure never unwinds the store write path.
 */
export async function mirrorMutation(
  layout: MirrorLayout,
  ledgerId: string,
  op: "create" | "update" | "archive",
): Promise<void> {
  const mirrorRoot = cacheMirrorDir(layout.rootDir);
  // The ledger's own active file is touched by every op.
  await mirrorFile(layout, mirrorRoot, path.join(layout.docsDir, `${ledgerId}.md`));
  if (op === "create" || op === "archive") await mirrorFile(layout, mirrorRoot, layout.registryPath);
  if (op !== "archive") return;
  // On archive the registry is rewritten and a new archive file appears.
  await mirrorFile(layout, mirrorRoot, layout.registryPath);
  const ledgerArchiveDir = path.join(layout.archiveDir, ledgerId);
  let entries: string[];
  try {
    entries = await fs.readdir(ledgerArchiveDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of entries) {
    await mirrorFile(layout, mirrorRoot, path.join(ledgerArchiveDir, name));
  }
}

/**
 * Copy one absolute source file into the mirror, preserving its path relative
 * to the store root. Tolerates a missing source (ENOENT). The write goes
 * through {@link atomicWrite} so the mirror is updated tmp+rename.
 */
async function mirrorFile(
  layout: MirrorLayout,
  mirrorRoot: string,
  absSource: string,
): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(absSource, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const rel = path.relative(layout.rootDir, absSource);
  const dest = path.join(mirrorRoot, rel);
  await atomicWrite(dest, text);
}
