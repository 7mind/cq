/**
 * T1956 — Git-object WorksetStore backend.
 *
 * Durable roots/epoch live as one canonical blob (`workset-roots.json`) on the
 * orphan ledger ref. Every successful `setRoots` advances the ref by exactly one
 * commit via compare-and-swap `update-ref`; a lost CAS surfaces as
 * {@link WorksetAdmissionError}(`stale-epoch`) and leaves the prior tip
 * authoritative. Admissions are process-safe: the project lockfile serialises
 * exclusive set/admin, and live leases are published under
 * `.cq/.locks/workset-admissions/` so a peer exclusive waits for (or crash-
 * reclaims) them before committing.
 *
 * In-process linearization, hooks, and race semantics are those of
 * {@link createInMemoryWorksetAdmissionCoordinator}; this module only adds the
 * git + lock durable legs.
 */

import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LEDGER_STORAGE_DIRNAME } from "./constants.js";
import { WORKSET_ROOTS_FILENAME } from "./store/ledgerArtifacts.js";
import { Lockfile, type LockfileOpts } from "./store/lockfile.js";
import {
  GitPlumbing,
  StaleRefError,
  type TreeEntry,
} from "./store/git/GitPlumbing.js";
import {
  WorksetAdmissionError,
  createInMemoryWorksetAdmissionCoordinator,
  type CreateInMemoryWorksetAdmissionCoordinatorOptions,
  type WorksetAdmissionCoordinator,
  type WorksetPublishedAdmissionLease,
  type WorksetRootsEpoch,
} from "./worksetEffectAdmission.js";
import type { WorksetStore } from "./worksetStore.js";

/** Default orphan branch short name (matches {@link GitObjectLedgerBackend}). */
const DEFAULT_BRANCH = "cq-ledger";

/** Regular-file git mode for the roots blob. */
const BLOB_MODE = "100644";

/** Intrinsic empty-tree oid — seed when the orphan ref is absent. */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Project lock key for exclusive workset set/admin. */
const WORKSET_LOCK_KEY = "workset";

/** Subdir under `.cq/.locks` holding process-visible admission leases. */
const WORKSET_ADMISSIONS_DIRNAME = "workset-admissions";

/** On-disk schema version for {@link WORKSET_ROOTS_FILENAME}. */
const WORKSET_ROOTS_SCHEMA_VERSION = 1 as const;

/** Poll cadence while waiting for peer admission leases to drain. */
const PEER_ADMISSION_POLL_MS = 25;

export interface WorksetRootsDocument {
  readonly version: typeof WORKSET_ROOTS_SCHEMA_VERSION;
  readonly roots: readonly string[];
  readonly epoch: number;
}

export interface CreateGitObjectWorksetStoreOptions {
  /** Absolute host repo root the orphan ref + lockfiles live under. */
  readonly repoRoot: string;
  /** Short branch name for the orphan ref (default `cq-ledger`). */
  readonly ref?: string;
  /** Injected plumbing (tests drive a throwaway repo). */
  readonly git?: GitPlumbing;
  /** Lockfile injection points for tests. */
  readonly lockfile?: LockfileOpts;
  /**
   * Override locks directory (default `<repoRoot>/.cq/.locks`). Tests may point
   * this at a unique temp path; production always uses the repo `.cq/.locks`.
   */
  readonly locksDir?: string;
  /** Coordinator options (hooks, validators) — same surface as the dummy. */
  readonly hooks?: CreateInMemoryWorksetAdmissionCoordinatorOptions["hooks"];
  readonly validateReplacement?: CreateInMemoryWorksetAdmissionCoordinatorOptions["validateReplacement"];
  readonly isTargetAdmitted?: CreateInMemoryWorksetAdmissionCoordinatorOptions["isTargetAdmitted"];
  /**
   * Fault-injection seam for tests: wrap/replace the CAS write. Defaults to the
   * real orphan-ref advance. Throwing leaves the prior ref authoritative.
   */
  readonly commitRoots?: (
    next: WorksetRootsEpoch,
    defaultCommit: (next: WorksetRootsEpoch) => Promise<void>,
  ) => Promise<void>;
  /** Override sleep (peer-admission poll). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override pid-alive probe used when reclaiming crash leases. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Override process-group-alive probe (POSIX kill(-pgid, 0)). */
  readonly isProcessGroupAlive?: (pgid: number) => boolean;
  /** Override self pid recorded on published leases. */
  readonly selfPid?: number;
  /** Override self hostname recorded on published leases. */
  readonly selfHostname?: string;
}

interface AdmissionLeaseFile {
  readonly id: string;
  readonly form: "ledger-mutation" | "external-effect";
  readonly kind: string;
  readonly epoch: number;
  readonly roots: readonly string[];
  readonly targets: readonly string[];
  readonly targetRef?: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
  readonly settled?: boolean;
  readonly pgid?: number;
}

function emptyRootsEpoch(): WorksetRootsEpoch {
  return { roots: [], epoch: 0 };
}

/**
 * Parse a complete roots/epoch document. Rejects torn or partial payloads so a
 * visible blob always denotes one complete batch.
 */
export function parseWorksetRootsDocument(text: string): WorksetRootsEpoch {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json is not valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json must be a JSON object",
    );
  }
  const doc = raw as Record<string, unknown>;
  if (doc["version"] !== WORKSET_ROOTS_SCHEMA_VERSION) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      `unsupported workset-roots.json version: ${String(doc["version"])}`,
    );
  }
  if (!Number.isInteger(doc["epoch"]) || (doc["epoch"] as number) < 0) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      `workset-roots.json epoch must be a non-negative integer, got ${String(doc["epoch"])}`,
    );
  }
  if (!Array.isArray(doc["roots"])) {
    throw new WorksetAdmissionError(
      "invalid-replacement",
      "workset-roots.json roots must be an array",
    );
  }
  const roots: string[] = [];
  for (const member of doc["roots"] as unknown[]) {
    if (typeof member !== "string" || member.length === 0) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset-roots.json roots members must be non-empty strings",
      );
    }
    roots.push(member);
  }
  return { roots, epoch: doc["epoch"] as number };
}

export function serializeWorksetRootsDocument(snap: WorksetRootsEpoch): string {
  const doc: WorksetRootsDocument = {
    version: WORKSET_ROOTS_SCHEMA_VERSION,
    roots: snap.roots.slice(),
    epoch: snap.epoch,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we cannot signal it — treat as alive.
    if (code === "EPERM") return true;
    return false;
  }
}

function defaultIsProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Open a Git-object-backed {@link WorksetStore}. Ensures the orphan ref exists
 * and loads the authoritative roots/epoch tip (or empty epoch 0 when absent).
 */
export async function createGitObjectWorksetStore(
  options: CreateGitObjectWorksetStoreOptions,
): Promise<WorksetStore> {
  const repoRoot = options.repoRoot;
  const branch = options.ref ?? DEFAULT_BRANCH;
  const ref = `refs/heads/${branch}`;
  const git =
    options.git ?? GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git"));
  const locksDir =
    options.locksDir ?? path.join(repoRoot, LEDGER_STORAGE_DIRNAME, ".locks");
  const admissionsDir = path.join(locksDir, WORKSET_ADMISSIONS_DIRNAME);
  const lockfile = new Lockfile(options.lockfile ?? {});
  const sleep = options.sleep ?? defaultSleep;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const isProcessGroupAlive =
    options.isProcessGroupAlive ?? defaultIsProcessGroupAlive;
  const selfPid = options.selfPid ?? process.pid;
  const selfHostname = options.selfHostname ?? os.hostname();

  await ensureOrphanRef(git, ref);
  const initial = await loadRootsEpoch(git, ref);

  // Exclusive project lock is acquired only once peer leases are empty (see
  // waitForPeerAdmissions) and held through persistCommit; released when the
  // exclusive public method returns. Never held while merely polling leases so
  // an in-flight admit can still publish its lease file.
  let exclusiveLockRelease: (() => Promise<void>) | null = null;

  async function releaseExclusiveProjectLock(): Promise<void> {
    const release = exclusiveLockRelease;
    exclusiveLockRelease = null;
    if (release !== null) {
      await release();
    }
  }

  async function commitRootsToRef(next: WorksetRootsEpoch): Promise<void> {
    const text = serializeWorksetRootsDocument(next);
    let expectedOld: string | null;
    try {
      expectedOld = await git.readRef(ref);
    } catch (err) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `failed to read workset ref ${ref}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Authoritative epoch check against the tip blob (peer may have advanced
    // between reloadBeforeCommit and this CAS preparation).
    const tip = await loadRootsEpoch(git, ref);
    if (tip.epoch !== next.epoch - 1) {
      throw new WorksetAdmissionError(
        "stale-epoch",
        `workset CAS rejected: tip epoch ${tip.epoch} is not predecessor of ${next.epoch}`,
      );
    }

    let blobSha: string;
    try {
      blobSha = await git.hashObject(text);
    } catch (err) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `failed to hash workset-roots blob: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let current: TreeEntry[];
    try {
      current = expectedOld === null ? [] : await git.lsTreeEntries(ref);
    } catch (err) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `failed to read workset tree: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const kept = current.filter((e) => e.path !== WORKSET_ROOTS_FILENAME);
    kept.push({ mode: BLOB_MODE, sha: blobSha, path: WORKSET_ROOTS_FILENAME });

    try {
      const tree =
        kept.length === 0 ? EMPTY_TREE_OID : await git.writeTree(kept);
      const commit = await git.commitTree(
        tree,
        expectedOld,
        `ledger: workset roots epoch ${next.epoch}`,
      );
      await git.updateRef(ref, commit, expectedOld);
    } catch (err) {
      if (err instanceof StaleRefError) {
        throw new WorksetAdmissionError(
          "stale-epoch",
          `workset ref CAS lost against ${ref}: ${err.message}`,
        );
      }
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `failed to advance workset ref: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const defaultCommit = commitRootsToRef;
  const commitRoots = async (next: WorksetRootsEpoch): Promise<void> => {
    try {
      if (options.commitRoots !== undefined) {
        await options.commitRoots(next, defaultCommit);
      } else {
        await defaultCommit(next);
      }
    } catch (err) {
      if (err instanceof WorksetAdmissionError) throw err;
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `workset roots commit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  async function publishAdmission(
    lease: WorksetPublishedAdmissionLease,
  ): Promise<void> {
    await fs.mkdir(admissionsDir, { recursive: true });
    const body: AdmissionLeaseFile = {
      id: lease.id,
      form: lease.form,
      kind: lease.kind,
      epoch: lease.epoch,
      roots: lease.roots.slice(),
      targets: lease.targets.slice(),
      ...(lease.targetRef !== undefined ? { targetRef: lease.targetRef } : {}),
      pid: selfPid,
      hostname: selfHostname,
      startedAt: Date.now(),
    };
    const filePath = path.join(admissionsDir, `${lease.id}.json`);
    // Exclusive create — collision on id is a hard failure (ids are unique per store).
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function retractAdmission(id: string): Promise<void> {
    const filePath = path.join(admissionsDir, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
  }

  function readLeaseFileSync(id: string): AdmissionLeaseFile | null {
    const filePath = path.join(admissionsDir, `${id}.json`);
    try {
      const raw = readFileSync(filePath, "utf8");
      return JSON.parse(raw) as AdmissionLeaseFile;
    } catch {
      return null;
    }
  }

  function writeLeaseFileSync(lease: AdmissionLeaseFile): void {
    const filePath = path.join(admissionsDir, `${lease.id}.json`);
    writeFileSync(filePath, `${JSON.stringify(lease)}\n`, "utf8");
  }

  function noteAdmissionProcessGroup(
    id: string,
    registration: { readonly pgid: number; readonly leaderPid: number },
  ): void {
    const current = readLeaseFileSync(id);
    if (current === null) return;
    writeLeaseFileSync({
      ...current,
      pgid: registration.pgid,
    });
  }

  function noteAdmissionSettled(id: string): void {
    const current = readLeaseFileSync(id);
    if (current === null) return;
    writeLeaseFileSync({
      ...current,
      settled: true,
    });
  }

  async function waitForPeerAdmissions(): Promise<void> {
    // Phase 1: poll leases WITHOUT the project lock so a peer/local admit can
    // still publish. Phase 2: acquire the lock and recheck under exclusion
    // before the exclusive body runs.
    for (;;) {
      await reclaimDeadAdmissionLeases();
      const remaining = await listAdmissionLeaseIds();
      if (remaining.length === 0) {
        if (exclusiveLockRelease === null) {
          exclusiveLockRelease = await lockfile.acquire(locksDir, WORKSET_LOCK_KEY);
        }
        await reclaimDeadAdmissionLeases();
        const underLock = await listAdmissionLeaseIds();
        if (underLock.length === 0) return;
        await releaseExclusiveProjectLock();
      }
      await sleep(PEER_ADMISSION_POLL_MS);
    }
  }

  async function listAdmissionLeaseIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(admissionsDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    return names.filter((n) => n.endsWith(".json"));
  }

  async function reclaimDeadAdmissionLeases(): Promise<void> {
    const names = await listAdmissionLeaseIds();
    for (const name of names) {
      const filePath = path.join(admissionsDir, name);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      let lease: AdmissionLeaseFile;
      try {
        lease = JSON.parse(raw) as AdmissionLeaseFile;
      } catch {
        // Torn/unparseable lease — only reclaim when the file is empty-ish and
        // cannot represent a live holder; leave well-formed peers alone.
        continue;
      }
      if (typeof lease.pid !== "number") continue;
      if (isPidAlive(lease.pid)) continue;

      // Holder is dead. Ledger-mutation leases close on crash (no process group).
      // External-effect leases require settlement evidence OR a dead process
      // group before reclaim — cleanup-before-release / crash cleanup.
      if (lease.form === "external-effect") {
        if (lease.settled === true) {
          await fs.unlink(filePath).catch(() => undefined);
          continue;
        }
        if (typeof lease.pgid === "number") {
          if (isProcessGroupAlive(lease.pgid)) {
            // Group still live without settlement — keep blocking exclusive.
            continue;
          }
          // Group leader dead without settlement record — treat as settled by
          // crash and reclaim so set can proceed (crash cleanup precedes release).
          await fs.unlink(filePath).catch(() => undefined);
          continue;
        }
        // No process group registered and holder dead — reclaim (broker died
        // before registration; nothing to clean up).
        await fs.unlink(filePath).catch(() => undefined);
        continue;
      }
      // ledger-mutation or unknown form with dead pid
      await fs.unlink(filePath).catch(() => undefined);
    }
  }

  async function confirmAdmission(
    lease: WorksetPublishedAdmissionLease,
  ): Promise<void> {
    const tip = await loadRootsEpoch(git, ref);
    if (tip.epoch !== lease.epoch) {
      throw new WorksetAdmissionError(
        "revoked",
        `workset admission revoked: tip epoch ${tip.epoch} !== granted epoch ${lease.epoch}`,
      );
    }
    if (tip.roots.length !== lease.roots.length) {
      throw new WorksetAdmissionError(
        "revoked",
        "workset admission revoked: tip roots diverged from granted roots",
      );
    }
    for (let i = 0; i < tip.roots.length; i++) {
      if (tip.roots[i] !== lease.roots[i]) {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked: tip roots diverged from granted roots",
        );
      }
    }
  }

  const coordinatorOptions: CreateInMemoryWorksetAdmissionCoordinatorOptions = {
    initial,
    persistCommit: commitRoots,
    reloadBeforeCommit: async () => loadRootsEpoch(git, ref),
    reloadBeforeAdmit: async () => loadRootsEpoch(git, ref),
    publishAdmission,
    confirmAdmission,
    retractAdmission,
    noteAdmissionProcessGroup,
    noteAdmissionSettled,
    waitForPeerAdmissions: async () => {
      try {
        await waitForPeerAdmissions();
      } catch (err) {
        await releaseExclusiveProjectLock();
        throw err;
      }
    },
    hooks: {
      ...(options.hooks ?? {}),
      afterExclusiveReady: async () => {
        // waitForPeerAdmissions leaves the project lock held; if it was skipped
        // acquire here so persistCommit is still serialized across processes.
        if (exclusiveLockRelease === null) {
          exclusiveLockRelease = await lockfile.acquire(locksDir, WORKSET_LOCK_KEY);
        }
        try {
          if (options.hooks?.afterExclusiveReady !== undefined) {
            await options.hooks.afterExclusiveReady();
          }
        } catch (err) {
          await releaseExclusiveProjectLock();
          throw err;
        }
      },
    },
    ...(options.validateReplacement !== undefined
      ? { validateReplacement: options.validateReplacement }
      : {}),
    ...(options.isTargetAdmitted !== undefined
      ? { isTargetAdmitted: options.isTargetAdmitted }
      : {}),
  };

  const coordinator: WorksetAdmissionCoordinator =
    createInMemoryWorksetAdmissionCoordinator(coordinatorOptions);

  // Release the project lock after every exclusive body completes. The
  // coordinator clears exclusiveHeld in its own finally; we wrap the public
  // exclusive methods to drop the FS lock in tandem.
  async function withExclusiveLockRelease<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } finally {
      await releaseExclusiveProjectLock();
    }
  }

  const store: WorksetStore = {
    async snapshot(): Promise<WorksetRootsEpoch> {
      // Authoritative tip — peers may have advanced since this process's last set.
      // Local in-memory coordinator state is updated only on set/admit paths;
      // observers always read the complete ref batch.
      return loadRootsEpoch(git, ref);
    },
    setRoots: (roots) => withExclusiveLockRelease(() => coordinator.setRoots(roots)),
    admitLedgerMutation: (input) => coordinator.admitLedgerMutation(input),
    admitExternalEffect: (input) => coordinator.admitExternalEffect(input),
    runAdministrative: (input) =>
      withExclusiveLockRelease(() => coordinator.runAdministrative(input)),
    activeAdmissionCount: () => coordinator.activeAdmissionCount(),
    exclusiveHeld: () => coordinator.exclusiveHeld(),
  };
  return store;
}

async function ensureOrphanRef(git: GitPlumbing, ref: string): Promise<void> {
  const current = await git.readRef(ref);
  if (current !== null) return;
  const commit = await git.commitTree(EMPTY_TREE_OID, null, "ledger: init");
  try {
    await git.updateRef(ref, commit, null);
  } catch {
    // Peer seeded the ref first — either way it exists.
  }
}

async function loadRootsEpoch(
  git: GitPlumbing,
  ref: string,
): Promise<WorksetRootsEpoch> {
  const sha = await git.readRef(ref);
  if (sha === null) return emptyRootsEpoch();
  const names = await git.lsTree(ref);
  if (!names.includes(WORKSET_ROOTS_FILENAME)) return emptyRootsEpoch();
  const text = await git.catFile(ref, WORKSET_ROOTS_FILENAME);
  return parseWorksetRootsDocument(text);
}
