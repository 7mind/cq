/**
 * GitPlumbing — a thin, INJECTABLE wrapper over the exact `git` plumbing
 * invocations proven in the K66 PoC
 * (`debug/20260609-221530-orphan-ledger-poc.sh`) and the orphan-ledger
 * feasibility spike (`docs/drafts/20260609-221530-orphan-ledger-feasibility.md`).
 *
 * ## Purpose (G43 / T348)
 *
 * It is the low-level git seam the planned `GitObjectLedgerBackend` (T351) will
 * build on: store a ledger on an ORPHAN ref and advance it per write WITHOUT
 * ever switching the working tree, mutating the real index, or perturbing
 * `git status`. Every mutation is: blob -> ISOLATED scratch-index tree ->
 * `commit-tree` -> compare-and-swap `update-ref`; every read is `cat-file` /
 * `ls-tree` against a ref — no checkout.
 *
 * ## Isolation invariants (why this is safe to run against a live repo)
 *
 * - Tree assembly uses a THROWAWAY index file via `GIT_INDEX_FILE` pointing at a
 *   unique path inside a tmp dir — NEVER the repo's real `.git/index`. So the
 *   working-tree status and the index stay byte-identical across writes.
 *   ({@link writeTree} creates and removes a fresh scratch index per call.)
 * - No `git checkout` / `git switch` / `git read-tree` / `git reset` is ever
 *   issued; the orphan ref advances purely via `update-ref`.
 * - `updateRef` uses the CAS form `git update-ref <ref> <new> <old>` so a stale
 *   `expectedOld` (a concurrent writer moved the ref) surfaces as a typed
 *   {@link StaleRefError} rather than silent last-writer-wins data loss.
 *
 * ## Injection seam
 *
 * The actual process execution is behind the {@link GitRunner} interface so a
 * test can drive every method against a throwaway `/tmp` repo (or, in principle,
 * a fully in-memory fake). The production runner ({@link nodeGitRunner}) uses
 * `node:child_process.execFile` with an explicit `cwd` (the repo root) and a
 * controlled env (the scratch `GIT_INDEX_FILE` only ever set for the
 * tree-assembly calls, never globally).
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A single tree entry for {@link GitPlumbing.writeTree}. */
export interface TreeEntry {
  /** Git file mode, e.g. `100644` (regular file) or `100755` (executable). */
  readonly mode: string;
  /** The blob SHA (from {@link GitPlumbing.hashObject}). */
  readonly sha: string;
  /** The path within the tree, e.g. `docs/tasks.md` (nested paths are fine). */
  readonly path: string;
}

/** The result of running a single git invocation. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code (`0` on success). */
  readonly code: number;
}

/** Options for a single {@link GitRunner} invocation. */
export interface GitRunOpts {
  /** Optional data to feed on the child's stdin (e.g. blob content). */
  readonly stdin?: string;
  /**
   * Extra environment variables MERGED over the inherited environment for this
   * invocation only (e.g. `GIT_INDEX_FILE` for the scratch-index tree build).
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The exec seam: run a single `git` invocation with the given argument vector
 * and options, returning its captured stdout/stderr/exit-code. A non-zero exit
 * code is NOT thrown here — the caller decides how to interpret it (e.g.
 * `update-ref` distinguishes a stale-ref CAS failure from other errors).
 *
 * Implementations MUST run with the repo root as `cwd` (bound at construction)
 * and MUST NOT mutate the repo's real index — callers pass a scratch
 * `GIT_INDEX_FILE` in {@link GitRunOpts.env} when an index is required.
 */
export type GitRunner = (args: readonly string[], opts?: GitRunOpts) => Promise<GitResult>;

/**
 * Thrown when a compare-and-swap {@link GitPlumbing.updateRef} fails because the
 * ref's current value did not match the supplied `expectedOld` (a concurrent
 * writer advanced it since the caller read it). This is the optimistic-
 * concurrency signal the feasibility spike (§4) calls for: surface a lost update
 * as a typed error rather than silently overwriting a peer's commit.
 */
export class StaleRefError extends Error {
  constructor(
    readonly ref: string,
    readonly expectedOld: string | null,
    readonly detail: string,
  ) {
    super(
      `Stale ref CAS for ${ref}: expected old ${expectedOld ?? "(absent)"} but ref had moved` +
        (detail ? ` — ${detail}` : ""),
    );
    this.name = "StaleRefError";
  }
}

/** Thrown for any non-CAS git failure (non-zero exit that is not a stale ref). */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

/** The all-zeroes SHA git uses to mean "ref must not currently exist" in a CAS. */
const ZERO_OID = "0000000000000000000000000000000000000000";

/**
 * The production {@link GitRunner}: `execFile("git", args, { cwd })` with a
 * controlled, MERGED env. `cwd` is the repo root; `opts.env` overlays the
 * inherited environment (so a scratch `GIT_INDEX_FILE` applies ONLY to the
 * invocation that needs it). Disables gpg signing and forces a deterministic
 * identity so `commit-tree` never blocks on missing `user.name`/`user.email`.
 */
export function nodeGitRunner(cwd: string): GitRunner {
  return (args, opts) =>
    new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        "git",
        [...args],
        {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "cq-ledger",
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "cq-ledger@localhost",
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "cq-ledger",
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "cq-ledger@localhost",
            // Force the C locale so git's human-readable stderr is deterministic
            // regardless of the inherited locale (D54). updateRef's CAS-vs-error
            // discriminator (D49) matches on the "cannot lock ref" stderr phrase;
            // a non-C LANG/LC_ALL could translate it and misroute the error.
            LC_ALL: "C",
            LANG: "C",
            ...(opts?.env ?? {}),
          },
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          // execFile's error has `.code` (number | string) for a non-zero exit;
          // we surface code/stdout/stderr to the caller rather than throwing, so
          // updateRef can distinguish a CAS failure from a hard error.
          if (err && typeof (err as { code?: unknown }).code !== "number") {
            // Spawn-level failure (e.g. git not found) — no exit code.
            reject(err);
            return;
          }
          const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
      if (opts?.stdin !== undefined) {
        child.stdin?.end(opts.stdin);
      }
    });
}

/**
 * Thin wrapper over the git plumbing commands. Inject a {@link GitRunner}; the
 * default ({@link GitPlumbing.withCwd}) binds {@link nodeGitRunner} to the repo
 * root. Optionally inject a `tmpDir` factory so tests place scratch index files
 * in a controlled location.
 */
export class GitPlumbing {
  private readonly run: GitRunner;
  private readonly scratchDir: string;

  constructor(opts: { runner: GitRunner; scratchDir?: string }) {
    this.run = opts.runner;
    this.scratchDir = opts.scratchDir ?? os.tmpdir();
  }

  /** Construct a `GitPlumbing` bound to the production node runner at `cwd`. */
  static withCwd(cwd: string, scratchDir?: string): GitPlumbing {
    const runner = nodeGitRunner(cwd);
    return scratchDir === undefined
      ? new GitPlumbing({ runner })
      : new GitPlumbing({ runner, scratchDir });
  }

  /** Run git, throwing {@link GitCommandError} on any non-zero exit. */
  private async runOk(args: readonly string[], opts?: GitRunOpts): Promise<GitResult> {
    const res = await this.run(args, opts);
    if (res.code !== 0) throw new GitCommandError(args, res.code, res.stderr);
    return res;
  }

  /**
   * Write `content` as a blob into the object DB and return its blob SHA.
   *
   * Runs: `git hash-object -w --stdin` (content on stdin).
   */
  async hashObject(content: string): Promise<string> {
    const res = await this.runOk(["hash-object", "-w", "--stdin"], { stdin: content });
    return res.stdout.trim();
  }

  /**
   * Build a tree object from `entries` via an ISOLATED scratch index, returning
   * the tree SHA. NEVER touches the repo's real index.
   *
   * Runs, with `GIT_INDEX_FILE` pointing at a fresh throwaway path:
   *   - `git update-index --add --cacheinfo <mode>,<sha>,<path>` per entry
   *     (the comma form stages one entry; nested paths build subtrees
   *     automatically), then
   *   - `git write-tree` to serialise the scratch index to a tree object.
   * The scratch index file is created fresh and removed in a `finally`.
   */
  async writeTree(entries: readonly TreeEntry[]): Promise<string> {
    if (entries.length === 0) throw new Error("writeTree: at least one entry is required");
    const indexFile = path.join(
      this.scratchDir,
      `cq-ledger-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    const env = { GIT_INDEX_FILE: indexFile } as const;
    try {
      for (const e of entries) {
        await this.runOk(
          ["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`],
          { env },
        );
      }
      const res = await this.runOk(["write-tree"], { env });
      return res.stdout.trim();
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  /**
   * Build a commit object for `tree` with the given `message`, returning the
   * commit SHA. When `parent` is `null` the commit is an ORPHAN (no `-p`); the
   * orphan property is exactly "the first `commit-tree` has no parent".
   *
   * Runs: `git commit-tree <tree> [-p <parent>] -m <message>`.
   */
  async commitTree(tree: string, parent: string | null, message: string): Promise<string> {
    const args = parent
      ? ["commit-tree", tree, "-p", parent, "-m", message]
      : ["commit-tree", tree, "-m", message];
    const res = await this.runOk(args, {});
    return res.stdout.trim();
  }

  /**
   * Compare-and-swap a ref to `newSha`, asserting its current value is
   * `expectedOld` (pass `null` to assert the ref does NOT currently exist). On a
   * mismatch git exits non-zero; this method translates that into a typed
   * {@link StaleRefError}. Any other non-zero exit is a {@link GitCommandError}.
   *
   * Runs: `git update-ref <ref> <newSha> <expectedOld | 0000…0>` — the
   * three-argument form is the atomic CAS git provides natively.
   */
  async updateRef(ref: string, newSha: string, expectedOld: string | null): Promise<void> {
    const oldArg = expectedOld ?? ZERO_OID;
    const args = ["update-ref", ref, newSha, oldArg] as const;
    const res = await this.run(args);
    if (res.code === 0) return;
    // A genuine CAS / locking failure from git update-ref always mentions
    // "cannot lock ref" in stderr (e.g. "is at <sha> but expected <sha>",
    // "reference already exists"). Any other non-zero exit (e.g. a malformed
    // or nonexistent newSha) is a programming error and must surface as
    // GitCommandError so it is not silently swallowed as a concurrency signal.
    if (res.stderr.includes("cannot lock ref")) {
      throw new StaleRefError(ref, expectedOld, res.stderr.trim());
    }
    throw new GitCommandError(args, res.code, res.stderr);
  }

  /**
   * Resolve `ref` to its current commit SHA, or `null` if the ref does not
   * exist. Uses `--verify --quiet` so an absent ref is a clean `null`, not an
   * error.
   *
   * Runs: `git rev-parse --verify --quiet <ref>` (with a `^{commit}` peel so a
   * tag resolves to its commit).
   */
  async readRef(ref: string): Promise<string | null> {
    const res = await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (res.code !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  /**
   * Read the content of `path` at `ref` WITHOUT any checkout, returning the
   * blob's bytes as a UTF-8 string.
   *
   * Runs: `git cat-file -p <ref>:<path>`.
   */
  async catFile(ref: string, filePath: string): Promise<string> {
    const res = await this.runOk(["cat-file", "-p", `${ref}:${filePath}`]);
    return res.stdout;
  }

  /**
   * Enumerate the file paths under `ref` (recursively), WITHOUT any checkout.
   *
   * Runs: `git ls-tree -r --name-only <ref>`. Returns the non-empty lines.
   */
  async lsTree(ref: string): Promise<string[]> {
    const res = await this.runOk(["ls-tree", "-r", "--name-only", ref]);
    return res.stdout.split("\n").filter((line) => line.length > 0);
  }

  /**
   * Enumerate the FULL tree entries (mode + blob SHA + path) under `ref`
   * recursively, WITHOUT any checkout. Unlike {@link lsTree} (name-only), this
   * returns the mode + sha needed to RE-ASSEMBLE a tree with one path
   * replaced/added/removed — the read-current-tree step of the orphan-ref
   * read-modify-write the `GitObjectLedgerBackend` performs under its lock.
   *
   * Runs: `git ls-tree -r <ref>` and parses the porcelain lines
   * `<mode> <type> <sha>\t<path>`, keeping only blob (`type === "blob"`)
   * entries (the ledger tree is flat files; there are no submodule/commit
   * gitlink entries to carry forward).
   */
  async lsTreeEntries(ref: string): Promise<TreeEntry[]> {
    const res = await this.runOk(["ls-tree", "-r", ref]);
    const out: TreeEntry[] = [];
    for (const line of res.stdout.split("\n")) {
      if (line.length === 0) continue;
      // Format: "<mode> <type> <sha>\t<path>"
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      const path = line.slice(tab + 1);
      const [mode, type, sha] = meta;
      if (mode === undefined || type === undefined || sha === undefined) continue;
      if (type !== "blob") continue;
      out.push({ mode, sha, path });
    }
    return out;
  }

  /**
   * Create (or move) a lightweight tag `tag` pointing at `sha`.
   *
   * Runs: `git tag -f <tag> <sha>` (`-f` so a snapshot tag can be re-pointed,
   * e.g. for the divergence-backup analogue in the feasibility spike §4).
   */
  async tagRef(tag: string, sha: string): Promise<void> {
    await this.runOk(["tag", "-f", tag, sha]);
  }

  /**
   * Enumerate the repo's root commit(s) — the commit(s) with zero parents
   * reachable from `HEAD` — used by {@link resolveProjectKey} (G67 / Q246) to
   * derive a stable, repo-identity project key that is identical across every
   * worktree and clone of the same repo (they share the same commit graph, so
   * the same root commit(s) in the same order).
   *
   * Runs: `git rev-list --max-parents=0 HEAD`. Returns the trimmed, non-empty
   * output lines in the order git emits them (first line = the SHA
   * {@link resolveProjectKey} treats as "the" first-commit SHA when a history
   * has more than one root, e.g. an `--allow-unrelated-histories` merge).
   * Returns `[]` (rather than throwing) when the command fails — an unborn
   * `HEAD` (no commits yet) or `cwd` not being a git work tree at all — so the
   * caller can distinguish "no root commit" from a hard git error and fail
   * fast with an actionable message instead of a raw {@link GitCommandError}.
   */
  async firstCommitShas(): Promise<string[]> {
    const res = await this.run(["rev-list", "--max-parents=0", "HEAD"]);
    if (res.code !== 0) return [];
    return res.stdout.split("\n").filter((line) => line.length > 0);
  }

  /**
   * Whether `cwd` is a SHALLOW clone (`git clone --depth N`) — used by
   * {@link resolveProjectKey} (D85 / H66) to refuse deriving a project key from
   * `firstCommitShas` there: a shallow clone grafts its shallow-boundary
   * commit to appear parentless, so `rev-list --max-parents=0` returns that
   * unstable boundary SHA instead of the true root, silently diverging from a
   * full clone's key (Q246).
   *
   * Runs: `git rev-parse --is-shallow-repository`, returning `true`/`false` as
   * a boolean. Returns `false` (rather than throwing) when the command fails
   * (e.g. `cwd` is not a git work tree at all) — `firstCommitShas` already
   * turns that case into the no-root-commit fail-fast path.
   */
  async isShallowRepository(): Promise<boolean> {
    const res = await this.run(["rev-parse", "--is-shallow-repository"]);
    if (res.code !== 0) return false;
    return res.stdout.trim() === "true";
  }
}
