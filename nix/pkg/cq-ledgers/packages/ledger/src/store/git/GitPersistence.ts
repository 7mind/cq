/**
 * GitPersistence — the git-object implementation of the {@link LedgerPersistence}
 * byte-I/O seam (G43 / Q190 / K66). The git-blob analogue of {@link FsPersistence}:
 * instead of `fs.*` calls under `docs/`, it reads/writes blobs addressed by a
 * tree on an ORPHAN ref (`refs/heads/<branch>`, default `cq-ledger`) via the
 * {@link GitPlumbing} seam — NO checkout, the working tree + index + HEAD stay
 * byte-identical across every write (proven by the K66 PoC).
 *
 * ## Tree layout (docs-relative — NO `docs/` prefix)
 *
 * The orphan ref's tree is rooted at the DOCS CONTENTS, so tree paths mirror the
 * `ArchivePointer.path` convention the shared base already speaks (paths relative
 * to the docs root):
 *   ledgers.yaml                     # central registry
 *   <ledger>.md                      # active ledger
 *   archive/<ledger>/<id>.md         # archived group (or item, for milestones)
 *
 * Archive locators arrive as `./archive/<ledger>/<id>.md`; {@link normalizePath}
 * strips a leading `./` so the tree path is consistent.
 *
 * ## Write model — one atomic ref-advance per mutation
 *
 * Each `write*`/`removeArchive` performs a read-modify-write under the base's
 * per-ledger AsyncMutex + advisory lockfile critical section:
 *   1. read CURRENT ref sha = expectedOld (null when the ref is absent → orphan);
 *   2. read current tree entries (mode+sha+path for ALL files) via
 *      {@link GitPlumbing.lsTreeEntries};
 *   3. hash-object the new blob (for writes);
 *   4. build the new entry-set = current entries with the one path
 *      replaced/added (writes) or removed (removeArchive);
 *   5. {@link GitPlumbing.writeTree} via the isolated scratch index;
 *   6. {@link GitPlumbing.commitTree}(tree, expectedOld /*parent; null→orphan*\/);
 *   7. CAS {@link GitPlumbing.updateRef}(ref, newCommit, expectedOld).
 * A {@link StaleRefError} on the CAS propagates (caveat 1): a cross-process
 * lost-update race surfaces loudly rather than silently overwriting a peer.
 * In-process writes are serialised by the base's lock; the CAS catches the
 * cross-process race the lock cannot.
 *
 * ## Divergence backup (caveat 6)
 *
 * `backupCanonicalState` tags the CURRENT ref head as
 * `refs/tags/cq-ledger-backup-<sanitized-now>` and returns the tag name, so the
 * pre-reinit state is preserved as a ref the operator can inspect/restore. The
 * git analogue of the FS `.backup/<ts>/` dir.
 *
 * ## NOT a concern here (per caveats / Q195)
 *  - the advisory `docs/.locks/*.lock` stay on the REAL FS, gitignored, NEVER in
 *    the orphan tree — that is the base's lockfile + the backend's `locksRoot()`.
 *  - NO `~/.cache` mirror (Q195(2)).
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { LedgerPersistence } from "../LedgerPersistence.js";
import type { GitPlumbing, TreeEntry } from "./GitPlumbing.js";
import { LedgerError } from "../../types.js";
import { MAX_READ_LOG_BYTES, type ReadLogResult } from "../../mcp/readLog.js";
import {
  LEDGER_LOGS_DIRNAME,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
} from "../../constants.js";

/** Regular-file git mode for a ledger blob. */
const BLOB_MODE = "100644";

/**
 * The docs-relative tree prefix the git-object backend stores session logs under
 * (the orphan tree is rooted at the DOCS CONTENTS, so the FS `<root>/.cq/logs`
 * confinement root is the `logs/` subtree here — NO `.cq/` prefix; see the
 * tree-layout note above). Points at {@link LEDGER_LOGS_DIRNAME} so the two stay
 * in sync via a single constant.
 */
const LOGS_TREE_PREFIX = LEDGER_LOGS_DIRNAME;

/** Registry tree path (docs-relative). */
const REGISTRY_PATH = "ledgers.yaml";

/**
 * The canonical empty-tree object id git recognises intrinsically in every repo
 * — used to seed the orphan ref's FIRST commit when the ref is absent so reads
 * and writes have a base tree to read from.
 */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Normalise a docs-relative locator to a tree path: strip a single leading `./`
 * (the `ArchivePointer.path` form is `./archive/<ledger>/<id>.md`). A path with
 * no `./` prefix is returned unchanged.
 */
function normalizePath(locator: string): string {
  return locator.startsWith("./") ? locator.slice(2) : locator;
}

/**
 * Git-object-backed {@link LedgerPersistence}. Constructed with an injected
 * {@link GitPlumbing} (so a test drives a throwaway repo) plus the fully-
 * qualified orphan `ref` (e.g. `refs/heads/cq-ledger`) and the `now` clock for
 * the divergence-backup tag timestamp.
 */
export class GitPersistence implements LedgerPersistence {
  private readonly git: GitPlumbing;
  private readonly ref: string;
  private readonly now: () => string;
  /**
   * The repo root on the REAL filesystem (the backend's checkout), injected so
   * {@link readLog} can fall back to the working-tree logs dir
   * (`<repoRoot>/<LEDGER_LOGS_RELATIVE_PREFIX>`) when a log is present on disk
   * but absent from the orphan ref (D69).
   */
  private readonly repoRoot: string;

  constructor(opts: {
    git: GitPlumbing;
    ref: string;
    now: () => string;
    repoRoot: string;
  }) {
    this.git = opts.git;
    this.ref = opts.ref;
    this.now = opts.now;
    this.repoRoot = opts.repoRoot;
  }

  /** Tree path for ledger `name`. */
  private ledgerTreePath(name: string): string {
    return `${name}.md`;
  }

  /**
   * Ensure the orphan ref exists: if absent, seed it with a parentless commit on
   * the intrinsic empty tree so subsequent reads/writes have a base. Idempotent;
   * a CAS race (a peer created the ref first) is swallowed — either way the ref
   * now exists. Called by the backend's `init()` BEFORE the base's load loop.
   */
  async ensureRef(): Promise<void> {
    const current = await this.git.readRef(this.ref);
    if (current !== null) return;
    const commit = await this.git.commitTree(EMPTY_TREE_OID, null, "ledger: init");
    try {
      await this.git.updateRef(this.ref, commit, null);
    } catch {
      // A concurrent writer seeded the ref first — the ref exists either way.
    }
  }

  /** The current ref sha, or null when the ref is absent. */
  private async refSha(): Promise<string | null> {
    return this.git.readRef(this.ref);
  }

  /** Read `path` at the current ref, or null if the ref or path is absent. */
  private async readAt(treePath: string): Promise<string | null> {
    const sha = await this.refSha();
    if (sha === null) return null;
    // Gate the catFile on a presence check so an ABSENT path returns a clean
    // null (the base's "bootstrap a fresh ledger" signal) rather than surfacing
    // a GitCommandError for the expected missing-on-first-init case.
    const names = await this.git.lsTree(this.ref);
    if (!names.includes(treePath)) return null;
    return this.git.catFile(this.ref, treePath);
  }

  /**
   * The read-modify-write that advances the orphan ref by ONE commit: replace or
   * remove a single tree path, then CAS the ref. `nextBlobSha === null` removes
   * the path (idempotent — absence is not an error); otherwise it
   * replaces/adds it. Runs inside the base's per-ledger lock; a CAS
   * {@link StaleRefError} propagates.
   */
  private async advance(
    treePath: string,
    nextBlobSha: string | null,
    message: string,
  ): Promise<void> {
    const expectedOld = await this.refSha();
    const current: TreeEntry[] =
      expectedOld === null ? [] : await this.git.lsTreeEntries(this.ref);

    const existing = current.find((e) => e.path === treePath);
    if (nextBlobSha === null && existing === undefined) {
      // removeArchive on an absent path — idempotent no-op (mirrors
      // fs.rm({force:true})). Do NOT advance the ref on a no-op removal.
      return;
    }

    const kept = current.filter((e) => e.path !== treePath);
    if (nextBlobSha !== null) {
      kept.push({ mode: BLOB_MODE, sha: nextBlobSha, path: treePath });
    }

    const tree =
      kept.length === 0
        ? EMPTY_TREE_OID
        : await this.git.writeTree(kept);
    const commit = await this.git.commitTree(tree, expectedOld, message);
    await this.git.updateRef(this.ref, commit, expectedOld);
  }

  // ---------------------------------------------------------------------------
  // (a) Source reads
  // ---------------------------------------------------------------------------

  async readLedgerSource(name: string): Promise<string | null> {
    return this.readAt(this.ledgerTreePath(name));
  }

  async readRegistrySource(): Promise<string | null> {
    return this.readAt(REGISTRY_PATH);
  }

  // ---------------------------------------------------------------------------
  // (b) Source writes
  // ---------------------------------------------------------------------------

  async writeLedgerSource(name: string, text: string): Promise<void> {
    const blob = await this.git.hashObject(text);
    await this.advance(this.ledgerTreePath(name), blob, `ledger: write ${name}`);
  }

  async writeRegistrySource(text: string): Promise<void> {
    const blob = await this.git.hashObject(text);
    await this.advance(REGISTRY_PATH, blob, "ledger: write registry");
  }

  // ---------------------------------------------------------------------------
  // (c) Archive I/O
  // ---------------------------------------------------------------------------

  async readArchive(locator: string): Promise<string> {
    const treePath = normalizePath(locator);
    const text = await this.readAt(treePath);
    if (text === null) {
      // Parity with FsPersistence.readArchive (fs.readFile): a missing archive
      // is an error the caller's fail-soft try/catch handles, not a null.
      throw new Error(`archive not found at ${treePath} (ref ${this.ref})`);
    }
    return text;
  }

  async writeArchive(locator: string, text: string): Promise<void> {
    const treePath = normalizePath(locator);
    const blob = await this.git.hashObject(text);
    await this.advance(treePath, blob, `ledger: archive ${treePath}`);
  }

  async removeArchive(locator: string): Promise<void> {
    const treePath = normalizePath(locator);
    await this.advance(treePath, null, `ledger: unarchive ${treePath}`);
  }

  async readArchiveDir(name: string): Promise<string[]> {
    const sha = await this.refSha();
    if (sha === null) return [];
    const prefix = `archive/${name}/`;
    const names = await this.git.lsTree(this.ref);
    return names
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((basename) => basename.length > 0 && !basename.includes("/"));
  }

  // ---------------------------------------------------------------------------
  // (d) Schema-divergence BACKUP action
  // ---------------------------------------------------------------------------

  async backupCanonicalState(): Promise<string> {
    const head = await this.refSha();
    // `tagRef` runs `git tag -f <name>` (short name → creates refs/tags/<name>);
    // pass the SHORT name, return the fully-qualified ref as the locator.
    const name = `cq-ledger-backup-${sanitize(this.now())}`;
    if (head !== null) {
      await this.git.tagRef(name, head);
    }
    return `refs/tags/${name}`;
  }

  // ---------------------------------------------------------------------------
  // (e) Coherence token
  // ---------------------------------------------------------------------------

  async currentSourceToken(_name: string): Promise<string> {
    // Coherence is ref-sha based: the whole ledger tree advances as one ref, so
    // a per-name token is the ref sha (uniform across names). Absent ref → "".
    const sha = await this.refSha();
    return sha ?? "";
  }

  // ---------------------------------------------------------------------------
  // (f) Bounded read-log capability (T408 / Q87 / R137 #6)
  // ---------------------------------------------------------------------------

  /**
   * Bounded, root-confined read of a session log at `logs/<rel>` on the orphan
   * ref — the git-object analogue of {@link FsLedgerStore.readLog}. The FS
   * capability confines to `<root>/.cq/logs`; the orphan tree is rooted at the
   * docs contents, so the confinement root here is the `logs/` SUBTREE. The
   * confinement + {@link MAX_READ_LOG_BYTES} cap + {@link ReadLogResult} shape
   * MIRROR the FS capability EXACTLY:
   *  - `relPath` MUST be repo-relative; an absolute path is rejected;
   *  - the path is normalised under `logs/` and REJECTED if it escapes that
   *    subtree (e.g. `..` traversal);
   *  - read is `lsTree` presence-check + `catFile` at the ref tip (no checkout);
   *  - a missing path is a clean not-found (mirroring the FS ENOENT surface);
   *  - oversized content is truncated to the byte cap and flagged
   *    `truncated: true`.
   *
   * Confinement against the orphan TREE is purely lexical. When the ref does not
   * carry the path, a WORKING-TREE fallback (D69) reads from
   * `<repoRoot>/<LEDGER_LOGS_RELATIVE_PREFIX>`; that path traverses the real
   * filesystem, so it re-applies the FS realpath/symlink TOCTOU defences
   * (D26/D28) before reading — see {@link readWorkingTreeLog}.
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    if (path.isAbsolute(relPath)) {
      throw new LedgerError(`read_log: absolute paths are not allowed: ${relPath}`);
    }
    // sessionLogs stores REPO-relative paths (".cq/logs/<file>"); strip a
    // leading .cq/logs/ so it is not doubled into logs/.cq/logs/<file>. A path
    // already relative to logs ("<file>") is unaffected (mirrors FsLedgerStore).
    const rel = relPath.replace(LEDGER_LOGS_STRIP_RE, "");
    // Resolve under a virtual `/<LOGS_TREE_PREFIX>` root and verify lexical
    // containment (defence-in-depth against `..` traversal), then derive the
    // tree path relative to the logs subtree. Using POSIX path semantics so the
    // tree path uses forward slashes regardless of host platform.
    const virtualRoot = path.posix.join("/", LOGS_TREE_PREFIX);
    const resolved = path.posix.resolve(virtualRoot, rel.split(path.sep).join("/"));
    if (resolved !== virtualRoot && !resolved.startsWith(virtualRoot + "/")) {
      throw new LedgerError(`read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`);
    }
    // Tree path is docs-relative: drop the leading slash of the virtual root.
    const treePath = resolved.slice(1);

    // Presence-check via lsTree, then catFile at the ref tip (no checkout).
    const sha = await this.refSha();
    const names = sha === null ? [] : await this.git.lsTree(this.ref);
    if (!names.includes(treePath)) {
      // FALLBACK (D69): the orphan ref does NOT carry this log, but it may exist
      // in the working-tree logs dir (`cq log put` to the FS backend, or a log
      // not yet committed to the orphan ref). Serve it from disk with the SAME
      // realpath/symlink containment defence FsLedgerStore.readLog applies
      // (D26/D28 TOCTOU). `rel` is already stripped of the LEDGER_LOGS prefix;
      // the FS logs root is `<repoRoot>/<LEDGER_LOGS_RELATIVE_PREFIX>`.
      return this.readWorkingTreeLog(relPath, rel);
    }
    const content = await this.git.catFile(this.ref, treePath);
    // Cap on BYTE length (mirrors FsLedgerStore: it reads bytes and slices the
    // Buffer at MAX_READ_LOG_BYTES). catFile decoded utf8; re-encode to bound
    // bytes faithfully and slice on a byte boundary when oversized.
    const buf = Buffer.from(content, "utf8");
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      return {
        path: relPath,
        content: buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8"),
        truncated: true,
      };
    }
    return { path: relPath, content };
  }

  /**
   * Working-tree fallback for {@link readLog} (D69): read a log that is present
   * on the real filesystem under `<repoRoot>/<LEDGER_LOGS_RELATIVE_PREFIX>` but
   * ABSENT from the orphan ref. Mirrors {@link FsLedgerStore.readLog}'s
   * containment + realpath/symlink (D26/D28 TOCTOU) defences and the
   * {@link MAX_READ_LOG_BYTES} byte cap. `strippedRel` is the path already
   * stripped of the LEDGER_LOGS prefix (the suffix under the logs root);
   * `relPath` is the ORIGINAL request, returned unchanged as the result `path`.
   * A genuinely missing file surfaces the standard ref-absent ENOENT error so
   * the not-found contract is unchanged when BOTH ref and disk lack the log.
   */
  private async readWorkingTreeLog(
    relPath: string,
    strippedRel: string,
  ): Promise<ReadLogResult> {
    const logsRoot = path.resolve(this.repoRoot, LEDGER_LOGS_RELATIVE_PREFIX);
    // Lexical containment (defence-in-depth against `..` traversal) BEFORE any
    // filesystem access.
    const resolved = path.resolve(logsRoot, strippedRel);
    if (resolved !== logsRoot && !resolved.startsWith(logsRoot + path.sep)) {
      throw new LedgerError(`read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`);
    }

    // Re-assert containment after symlink resolution (D26/D28): a symlink whose
    // lexical path is inside logsRoot may point outside it. Resolve BOTH sides
    // so a symlinked parent of the root does not cause a false escape. Hoist
    // `real` so the subsequent readFile uses the validated canonical path,
    // closing the check-then-use TOCTOU (D28).
    let real: string | undefined;
    try {
      real = await fs.realpath(resolved);
      let realLogsRoot: string;
      try {
        realLogsRoot = await fs.realpath(logsRoot);
      } catch {
        realLogsRoot = logsRoot;
      }
      if (real !== realLogsRoot && !real.startsWith(realLogsRoot + path.sep)) {
        throw new LedgerError(
          `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // ENOENT during realpath — the file is absent on disk too. Surface the
      // standard ref-absent not-found so the contract is unchanged when BOTH
      // the orphan ref and the working tree lack the log.
      throw new LedgerError(
        `read_log: no such file: ${relPath} (ENOENT, ref ${this.ref})`,
      );
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(real ?? resolved);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new LedgerError(
          `read_log: no such file: ${relPath} (ENOENT, ref ${this.ref})`,
        );
      }
      throw err;
    }
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      return {
        path: relPath,
        content: buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8"),
        truncated: true,
      };
    }
    return { path: relPath, content: buf.toString("utf8") };
  }
}

/** Sanitise an ISO timestamp into a ref-name-safe suffix (`:` → `-`). */
function sanitize(ts: string): string {
  return ts.replace(/:/g, "-");
}
