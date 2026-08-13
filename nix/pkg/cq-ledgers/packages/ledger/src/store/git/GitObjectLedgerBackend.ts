/**
 * GitObjectLedgerBackend — git-object-backed implementation of `LedgerStore`
 * (G43 / Q190 / Q191 / K66). The git-blob analogue of {@link FsLedgerStore}: the
 * shared {@link AbstractLedgerStore} base (in-memory map, parse/serialize, FTS,
 * the mutex, the advisory-lockfile critical sections, schema-divergence
 * DETECTION + reinit orchestration, and every read/mutation method) wired to a
 * {@link GitPersistence} byte-I/O seam that stores the ledger on an ORPHAN ref
 * (`refs/heads/<branch>`, default `cq-ledger`) via {@link GitPlumbing}.
 *
 * Every mutation advances the orphan ref by ONE commit (blob → isolated
 * scratch-index tree → `commit-tree` → CAS `update-ref`) WITHOUT a checkout, so
 * the host repo's working tree, index, and HEAD stay byte-identical and
 * `git status` stays clean (the K66 PoC invariant). The lockfiles stay on the
 * REAL filesystem (gitignored, NEVER in the orphan tree) — see {@link locksRoot}.
 *
 * Reads stay SYNCHRONOUS from the in-memory map (no `LedgerStore` interface
 * change); `git cat-file`/`ls-tree` run ONLY at `init()` and on the
 * coherence-reload path (`invalidate`), never per read-call.
 *
 * ## Out of scope for this backend (per K66 caveats / Q195)
 *  - the command-step `git add .cq/` drops (T358);
 *  - push/fetch wiring of `refs/heads/cq-ledger` (T355);
 *  - NO `~/.cache` mirror (Q195(2)) — no `afterMutation`/`drainBackend` override.
 * Divergence backup tags the ref head before reinit (caveat 6), delegated to
 * {@link GitPersistence.backupCanonicalState}; the backup-reinit vs abort policy
 * is the base's, unchanged.
 */

import * as path from "node:path";
import type { LedgerStore, OnMutation } from "../LedgerStore.js";
import { Lockfile, type LockfileOpts } from "../lockfile.js";
import { AbstractLedgerStore } from "../AbstractLedgerStore.js";
import { GitPlumbing } from "./GitPlumbing.js";
import { GitPersistence } from "./GitPersistence.js";
import type { ReadLogResult } from "../../mcp/readLog.js";
import { DEFAULT_ON_SCHEMA_DIVERGENCE, LEDGER_STORAGE_DIRNAME } from "../../constants.js";
import type { PlanLifecycleSerializationBoundaryHook } from "../planLifecycleSerialization.js";
import { createGitObjectWorksetStore } from "../../worksetStoreGit.js";
import { serializeWorksetRootsDocument } from "../../worksetStoreGit.js";
import { createObserveOnlyWorksetInvocationAuthority } from "../../worksetInvocationAuthority.js";

/** Default orphan branch the ledger tree lives on (short name, no `refs/`). */
const DEFAULT_BRANCH = "cq-ledger";

export interface GitObjectLedgerBackendOpts {
  /**
   * Absolute repo root the orphan ref + plumbing operate against (the host git
   * checkout). Advisory lockfiles live under `<repoRoot>/.cq/.locks` on the
   * real filesystem — NEVER committed to the orphan tree.
   */
  repoRoot: string;
  /**
   * Short branch name for the orphan ledger ref (default `cq-ledger`). Stored
   * fully-qualified as `refs/heads/<branch>`.
   */
  ref?: string;
  /**
   * Returns an ISO 8601 UTC timestamp. Defaults to
   * `() => new Date().toISOString()`. Also stamps the divergence-backup tag.
   */
  now?: () => string;
  /** Lockfile injection points for tests (isPidAlive, selfPid, …). */
  lockfile?: LockfileOpts;
  /**
   * Injected {@link GitPlumbing} (so a test drives a throwaway repo). Defaults to
   * one bound to {@link nodeGitRunner} at `repoRoot`, with scratch index files
   * placed under `<repoRoot>/.git`.
   */
  git?: GitPlumbing;
  /**
   * Fired AFTER every successful write — after lockfile release + the in-memory
   * map update. Used to broadcast cross-process cache-invalidation (D-COHERENCE).
   * MUST NOT block; a throw is logged and swallowed by the base.
   */
  onMutation?: OnMutation;
  /** Test-only hook reached after the decisive plan-serialization lock stack is held. */
  planSerializationBoundaryHook?: PlanLifecycleSerializationBoundaryHook;
  /**
   * Policy for an on-ref canonical ledger whose schema diverged from canon
   * (detected at init()):
   *  - `'abort'` (default, {@link DEFAULT_ON_SCHEMA_DIVERGENCE}): throw
   *    `BootstrapViolationError`, leaving the ref untouched, so the divergence
   *    is loud;
   *  - `'backup-reinit'`: tag the ref head, then reinit canonical.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
  /** Runtime-only authority for destructive divergence reinitialization. */
  worksetAuthority?: unknown;
}

export class GitObjectLedgerBackend
  extends AbstractLedgerStore<GitPersistence>
  implements LedgerStore
{
  private readonly repoRoot: string;
  private readonly branch: string;
  private readonly locksDir: string;
  /** The seam, retained so init() can seed the orphan ref before super.init(). */
  private readonly gitPersistence: GitPersistence;
  private readonly branch: string;
  private readonly git: GitPlumbing;
  private readonly worksetAuthority: unknown;

  constructor(opts: GitObjectLedgerBackendOpts) {
    const repoRoot = opts.repoRoot;
    const branch = opts.ref ?? DEFAULT_BRANCH;
    const ref = `refs/heads/${branch}`;
    const now = opts.now ?? (() => new Date().toISOString());
    const git = opts.git ?? GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git"));
    const persistence = new GitPersistence({ git, ref, now, repoRoot });
    super({
      persistence,
      lockfile: new Lockfile(opts.lockfile ?? {}),
      now,
      onMutation: opts.onMutation ?? null,
      onSchemaDivergence: opts.onSchemaDivergence ?? DEFAULT_ON_SCHEMA_DIVERGENCE,
      planSerializationBoundaryHook: opts.planSerializationBoundaryHook ?? null,
    });
    this.repoRoot = repoRoot;
    this.branch = branch;
    this.locksDir = path.join(repoRoot, LEDGER_STORAGE_DIRNAME, ".locks");
    this.gitPersistence = persistence;
    this.branch = branch;
    this.git = git;
    this.worksetAuthority =
      opts.worksetAuthority ?? createObserveOnlyWorksetInvocationAuthority();
  }

  /**
   * The resolved repo root this backend's orphan ref lives in. Exposed read-only
   * for symmetry with {@link FsLedgerStore.rootDir}.
   */
  get rootDir(): string {
    return this.repoRoot;
  }

  /**
   * Bounded, root-confined read of a session log at `logs/<rel>` on the orphan
   * ref (T408) — the git-object backend's `read_log` capability, the analogue of
   * {@link FsLedgerStore.readLog}. Delegates to {@link GitPersistence.readLog},
   * which closes over this backend's {@link GitPlumbing} + ref and mirrors the FS
   * capability's confinement + {@link MAX_READ_LOG_BYTES} cap + result shape
   * exactly. Wired into `read_log` by the MCP host (see
   * `createLedgerMcpServer`), gated on the backend-aware `rootDir` capability
   * rather than `instanceof FsLedgerStore`.
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    return this.gitPersistence.readLog(relPath);
  }

  /** Emit the workset roots/epoch stored on this backend's orphan ref. */
  async exportWorksetRootsState(): Promise<string> {
    const workset = await createGitObjectWorksetStore({
      repoRoot: this.repoRoot,
      ref: this.branch,
    });
    return serializeWorksetRootsDocument(await workset.snapshot());
  }

  // ---------------------------------------------------------------------------
  // Backend extension points
  // ---------------------------------------------------------------------------

  /**
   * The advisory lockfiles live on the REAL filesystem under
   * `<repoRoot>/.cq/.locks` (gitignored, NEVER in the orphan tree) — caveat 2.
   */
  protected locksRoot(): string {
    return this.locksDir;
  }

  protected override async backupAndReinit(): Promise<string> {
    const workset = await createGitObjectWorksetStore({
      repoRoot: this.repoRoot,
      ref: this.branch,
      git: this.git,
      locksDir: this.locksDir,
    });
    let backupTag = "";
    await workset.runAdministrative({
      kind: "divergence-reinitialization",
      authority: this.worksetAuthority,
      destructivePhase: async () => {
        backupTag = await super.backupAndReinit();
      },
    });
    return backupTag;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Seed the orphan ref from an EMPTY tree when absent (so the base's read loop
   * has a base tree), THEN run the base init() (registry/ledger bootstrap +
   * divergence handling + FTS build).
   */
  override async init(): Promise<void> {
    await this.gitPersistence.ensureRef();
    await super.init();
  }
}
