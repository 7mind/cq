/**
 * T1955 — filesystem-backed {@link WorksetStore}.
 *
 * Durable state is roots + epoch (+ admitGeneration) under
 * `<root>/.cq/workset/roots.json`, written only via {@link atomicWrite}.
 * Active admissions are process-safe lease files under
 * `<root>/.cq/workset/admissions/`. Exclusive set/admin serialises across
 * processes via an exclusive-holder marker plus the project advisory lock for
 * short critical sections (create/delete admission, commit roots).
 *
 * Linearization matches the in-memory coordinator (T1953/T1954): exclusive
 * waits for live admissions (reclaiming only dead holders whose registered
 * process groups have settled); successful commit advances epoch and
 * admitGeneration together and revokes not-yet-granted admits.
 */

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WORKSET_LEDGER_MUTATION_KINDS,
  WorksetAdmissionError,
  canonicalizeWorksetRootReplacement,
  isTrustedWorksetManagementAuthority,
  registerLiveWorksetAdmission,
  unregisterLiveWorksetAdmission,
  type WorksetAdministrativeEffectKind,
  type WorksetAdmissionCoordinatorHooks,
  type WorksetExternalEffectAdmission,
  type WorksetExternalEffectKind,
  type WorksetLedgerMutationAdmission,
  type WorksetLedgerMutationKind,
  type WorksetProcessGroupRegistration,
  type WorksetRootsEpoch,
} from "../worksetEffectAdmission.js";
import type { WorksetStore } from "../worksetStore.js";
import { LEDGER_STORAGE_DIRNAME } from "../constants.js";
import { atomicWrite as defaultAtomicWrite } from "./fsAtomic.js";
import { Lockfile, type LockfileOpts } from "./lockfile.js";
import { AsyncMutex } from "./mutex.js";

// ---------------------------------------------------------------------------
// Layout / constants
// ---------------------------------------------------------------------------

const WORKSET_DIRNAME = "workset";
const ROOTS_FILENAME = "roots.json";
const ADMISSIONS_DIRNAME = "admissions";
const EXCLUSIVE_HOLDER_FILENAME = "exclusive-holder.json";
const WORKSET_LOCK_ID = "workset";
const ROOTS_FORMAT_VERSION = 1 as const;

/** Default poll cadence while waiting on exclusive/admissions. */
const DEFAULT_POLL_INTERVAL_MS = 15;

// ---------------------------------------------------------------------------
// On-disk records
// ---------------------------------------------------------------------------

interface DurableRootsDocument {
  readonly version: typeof ROOTS_FORMAT_VERSION;
  readonly roots: readonly string[];
  readonly epoch: number;
  /** Bumped on exclusive commit / admin; revokes in-flight grant attempts. */
  readonly admitGeneration: number;
}

interface ExclusiveHolderDocument {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
  readonly kind: "exclusive-set" | "exclusive-administrative";
}

type AdmissionFormDisk = "ledger-mutation" | "external-effect";

interface AdmissionDocument {
  readonly id: string;
  readonly form: AdmissionFormDisk;
  readonly kind: string;
  readonly epoch: number;
  readonly roots: readonly string[];
  readonly targets?: readonly string[];
  readonly targetRef?: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: number;
  readonly generation: number;
  processGroup: WorksetProcessGroupRegistration | null;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateFsWorksetStoreOptions {
  /** Project root (server --cwd). State lives under `<root>/.cq/workset/`. */
  readonly root: string;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly validateReplacement?: (roots: readonly string[]) => void;
  readonly isTargetAdmitted?: (
    target: string,
    roots: readonly string[],
  ) => boolean;
  /** Lockfile injection (shared with FsLedgerStore tests). */
  readonly lockfile?: LockfileOpts;
  /** Override atomic write (failure-injection tests). */
  readonly atomicWrite?: (filePath: string, text: string) => Promise<void>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly isProcessGroupAlive?: (pgid: number) => boolean;
  readonly selfPid?: number;
  readonly selfHostname?: string;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultIsTargetAdmitted(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  for (const root of roots) {
    if (target === root) return true;
    if (target.startsWith(`${root}/`)) return true;
  }
  return false;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function defaultIsProcessGroupAlive(pgid: number): boolean {
  try {
    // Negative pid = process group on POSIX.
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function emptyRootsDocument(): DurableRootsDocument {
  return {
    version: ROOTS_FORMAT_VERSION,
    roots: [],
    epoch: 0,
    admitGeneration: 0,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a filesystem {@link WorksetStore} bound to `<root>/.cq/workset/`.
 */
export function createFsWorksetStore(options: CreateFsWorksetStoreOptions): WorksetStore {
  const root = options.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("createFsWorksetStore: root is required");
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`createFsWorksetStore: root must be absolute, got ${JSON.stringify(root)}`);
  }

  const hooks = options.hooks ?? {};
  const isTargetAdmitted = options.isTargetAdmitted ?? defaultIsTargetAdmitted;
  const validateReplacement = options.validateReplacement;
  const writeAtomic = options.atomicWrite ?? defaultAtomicWrite;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const isProcessGroupAlive = options.isProcessGroupAlive ?? defaultIsProcessGroupAlive;
  const selfPid = options.selfPid ?? process.pid;
  const selfHostname = options.selfHostname ?? os.hostname();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const worksetDir = path.join(docsDir, WORKSET_DIRNAME);
  const rootsPath = path.join(worksetDir, ROOTS_FILENAME);
  const admissionsDir = path.join(worksetDir, ADMISSIONS_DIRNAME);
  const exclusiveHolderPath = path.join(worksetDir, EXCLUSIVE_HOLDER_FILENAME);
  const locksDir = path.join(docsDir, ".locks");

  const lockfile = new Lockfile(options.lockfile ?? {});
  const mutex = new AsyncMutex();

  /** Local exclusive flag for this process (sync observation + wait loops). */
  let localExclusiveHeld = false;
  /** In-process exclusive queue so same-process set/admin serialise without thrashing the disk. */
  let exclusiveTail: Promise<void> = Promise.resolve();
  let nextAdmissionSeq = 0;

  // -------------------------------------------------------------------------
  // Disk IO
  // -------------------------------------------------------------------------

  async function ensureLayout(): Promise<void> {
    await fs.mkdir(admissionsDir, { recursive: true });
    await fs.mkdir(locksDir, { recursive: true });
  }

  function readRootsSync(): DurableRootsDocument {
    try {
      const text = fsSync.readFileSync(rootsPath, "utf8");
      return parseRootsDocument(text);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyRootsDocument();
      throw e;
    }
  }

  async function readRoots(): Promise<DurableRootsDocument> {
    try {
      const text = await fs.readFile(rootsPath, "utf8");
      return parseRootsDocument(text);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyRootsDocument();
      throw e;
    }
  }

  function parseRootsDocument(text: string): DurableRootsDocument {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Torn/partial file should not happen under atomicWrite; fail closed to empty
      // only when the file is empty — otherwise surface the error.
      if (text.trim().length === 0) return emptyRootsDocument();
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset roots.json is not valid JSON",
      );
    }
    if (raw === null || typeof raw !== "object") {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset roots.json must be an object",
      );
    }
    const obj = raw as Record<string, unknown>;
    const epoch = obj["epoch"];
    const admitGeneration = obj["admitGeneration"];
    const roots = obj["roots"];
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset roots.json epoch must be a non-negative integer",
      );
    }
    if (
      typeof admitGeneration !== "number" ||
      !Number.isInteger(admitGeneration) ||
      admitGeneration < 0
    ) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset roots.json admitGeneration must be a non-negative integer",
      );
    }
    if (!Array.isArray(roots) || roots.some((r) => typeof r !== "string")) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset roots.json roots must be a string array",
      );
    }
    return {
      version: ROOTS_FORMAT_VERSION,
      roots: roots.slice() as string[],
      epoch,
      admitGeneration,
    };
  }

  async function writeRootsDocument(doc: DurableRootsDocument): Promise<void> {
    await ensureLayout();
    const payload: DurableRootsDocument = {
      version: ROOTS_FORMAT_VERSION,
      roots: doc.roots.slice(),
      epoch: doc.epoch,
      admitGeneration: doc.admitGeneration,
    };
    await writeAtomic(rootsPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function admissionPath(id: string): string {
    // ids are store-minted; reject path separators defensively.
    if (id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `refusing unsafe admission id ${JSON.stringify(id)}`,
      );
    }
    return path.join(admissionsDir, `${id}.json`);
  }

  async function writeAdmissionDocument(doc: AdmissionDocument): Promise<void> {
    await ensureLayout();
    await writeAtomic(admissionPath(doc.id), `${JSON.stringify(doc, null, 2)}\n`);
  }

  async function readAdmissionDocument(id: string): Promise<AdmissionDocument | null> {
    try {
      const text = await fs.readFile(admissionPath(id), "utf8");
      return JSON.parse(text) as AdmissionDocument;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw e;
    }
  }

  async function deleteAdmissionDocument(id: string): Promise<void> {
    await fs.unlink(admissionPath(id)).catch(() => undefined);
  }

  async function listAdmissionDocuments(): Promise<AdmissionDocument[]> {
    await ensureLayout();
    let names: string[];
    try {
      names = await fs.readdir(admissionsDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw e;
    }
    const out: AdmissionDocument[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const text = await fs.readFile(path.join(admissionsDir, name), "utf8");
        out.push(JSON.parse(text) as AdmissionDocument);
      } catch {
        // skip unreadable / mid-write; next poll will see the settled file
      }
    }
    return out;
  }

  function listAdmissionDocumentsSync(): AdmissionDocument[] {
    try {
      const names = fsSync.readdirSync(admissionsDir);
      const out: AdmissionDocument[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const text = fsSync.readFileSync(path.join(admissionsDir, name), "utf8");
          out.push(JSON.parse(text) as AdmissionDocument);
        } catch {
          // skip
        }
      }
      return out;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw e;
    }
  }

  function readExclusiveHolderSync(): ExclusiveHolderDocument | null {
    try {
      const text = fsSync.readFileSync(exclusiveHolderPath, "utf8");
      const obj = JSON.parse(text) as ExclusiveHolderDocument;
      if (typeof obj.pid !== "number") return null;
      return obj;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      return null;
    }
  }

  async function readExclusiveHolder(): Promise<ExclusiveHolderDocument | null> {
    try {
      const text = await fs.readFile(exclusiveHolderPath, "utf8");
      const obj = JSON.parse(text) as ExclusiveHolderDocument;
      if (typeof obj.pid !== "number") return null;
      return obj;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      return null;
    }
  }

  async function writeExclusiveHolder(
    kind: ExclusiveHolderDocument["kind"],
  ): Promise<void> {
    await ensureLayout();
    const doc: ExclusiveHolderDocument = {
      pid: selfPid,
      hostname: selfHostname,
      startedAt: now(),
      kind,
    };
    await writeAtomic(exclusiveHolderPath, `${JSON.stringify(doc)}\n`);
  }

  async function clearExclusiveHolder(): Promise<void> {
    await fs.unlink(exclusiveHolderPath).catch(() => undefined);
  }

  /**
   * True when some live process holds exclusive (local flag or durable marker).
   */
  function exclusiveHeldNow(): boolean {
    if (localExclusiveHeld) return true;
    const holder = readExclusiveHolderSync();
    if (holder === null) return false;
    return isPidAlive(holder.pid);
  }

  /**
   * Reclaim a dead admission when cleanup-before-release allows it:
   * - ledger-mutation: holder death ⇒ closed
   * - external-effect without process group: holder death ⇒ closed
   * - external-effect with unsettled process group: wait until pg is dead, then close
   * - external-effect settled: holder death ⇒ closed
   */
  async function reclaimIfCloseable(doc: AdmissionDocument): Promise<boolean> {
    if (isPidAlive(doc.pid)) return false;
    if (doc.form === "ledger-mutation") {
      await deleteAdmissionDocument(doc.id);
      return true;
    }
    // external-effect
    if (doc.processGroup === null) {
      // Broker died before registration — no process group to settle.
      await deleteAdmissionDocument(doc.id);
      return true;
    }
    if (doc.settled) {
      await deleteAdmissionDocument(doc.id);
      return true;
    }
    // Registered, not settled: wait until the process group is gone (settled by death).
    if (!isProcessGroupAlive(doc.processGroup.pgid)) {
      await deleteAdmissionDocument(doc.id);
      return true;
    }
    return false;
  }

  async function countLiveAdmissions(): Promise<number> {
    const docs = await listAdmissionDocuments();
    let live = 0;
    for (const doc of docs) {
      const reclaimed = await reclaimIfCloseable(doc);
      if (!reclaimed) live += 1;
    }
    return live;
  }

  async function withProjectLock<T>(fn: () => Promise<T>): Promise<T> {
    return mutex.run(async () => {
      await ensureLayout();
      const release = await lockfile.acquire(locksDir, WORKSET_LOCK_ID);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
    for (;;) {
      if (await predicate()) return;
      await sleep(pollIntervalMs);
    }
  }

  // -------------------------------------------------------------------------
  // WorksetStore surface
  // -------------------------------------------------------------------------

  async function snapshot(): Promise<WorksetRootsEpoch> {
    const doc = await readRoots();
    return { roots: doc.roots.slice(), epoch: doc.epoch };
  }

  function activeAdmissionCount(): number {
    const docs = listAdmissionDocumentsSync();
    let n = 0;
    for (const doc of docs) {
      if (isPidAlive(doc.pid)) {
        n += 1;
        continue;
      }
      // Dead holder still counts while an unsettled process group is alive
      // (cleanup-before-release / broker death).
      if (
        doc.form === "external-effect" &&
        doc.processGroup !== null &&
        !doc.settled &&
        isProcessGroupAlive(doc.processGroup.pgid)
      ) {
        n += 1;
      }
    }
    return n;
  }

  function exclusiveHeld(): boolean {
    return exclusiveHeldNow();
  }

  async function runExclusive<T>(
    kind: ExclusiveHolderDocument["kind"],
    body: () => Promise<T>,
  ): Promise<T> {
    const prior = exclusiveTail;
    const gate = deferred();
    exclusiveTail = gate.promise;
    await prior;
    // Mark exclusive immediately after the in-process queue (matches the
    // in-memory coordinator). Observers and non-exclusive admits must see
    // exclusiveHeld() before any subsequent await (peer-holder wait, drain).
    localExclusiveHeld = true;
    try {
      // Wait for any peer exclusive holder to clear before we claim the marker.
      await waitUntil(async () => {
        const holder = await readExclusiveHolder();
        if (holder === null) return true;
        if (holder.pid === selfPid) return true;
        if (!isPidAlive(holder.pid)) {
          // Dead exclusive holder: reclaim.
          await clearExclusiveHolder();
          return true;
        }
        return false;
      });
      await writeExclusiveHolder(kind);
      // Drain live admissions (process-safe).
      await waitUntil(async () => (await countLiveAdmissions()) === 0);
      if (hooks.afterExclusiveReady !== undefined) {
        await hooks.afterExclusiveReady();
      }
      return await body();
    } finally {
      localExclusiveHeld = false;
      await clearExclusiveHolder();
      gate.resolve();
    }
  }

  async function beginNonExclusiveAdmit(form: AdmissionFormDisk): Promise<{
    id: string;
    epoch: number;
    roots: readonly string[];
    generation: number;
  }> {
    const rootsAtEntry = await readRoots();
    const generationAtEntry = rootsAtEntry.admitGeneration;

    for (;;) {
      await waitUntil(() => !exclusiveHeldNow());
      if (hooks.beforeAdmissionGrant !== undefined) {
        await hooks.beforeAdmissionGrant();
      }

      const granted = await withProjectLock(async () => {
        // Re-check under lock: exclusive / generation.
        const current = await readRoots();
        if (current.admitGeneration !== generationAtEntry) {
          throw new WorksetAdmissionError(
            "revoked",
            "workset admission revoked by exclusive commit before grant",
          );
        }
        if (exclusiveHeldNow() && !localExclusiveHeld) {
          // Peer exclusive — retry outside lock.
          return null;
        }
        // If WE hold exclusive, non-exclusive admit must not grant (set is running).
        if (localExclusiveHeld) {
          return null;
        }
        const holder = await readExclusiveHolder();
        if (holder !== null && isPidAlive(holder.pid)) {
          return null;
        }

        const id =
          form === "ledger-mutation"
            ? `lm-${selfPid}-${++nextAdmissionSeq}-${now()}`
            : `ee-${selfPid}-${++nextAdmissionSeq}-${now()}`;
        const doc: AdmissionDocument = {
          id,
          form,
          kind: "", // filled by caller before publish — placeholder overwritten below
          epoch: current.epoch,
          roots: current.roots.slice(),
          pid: selfPid,
          hostname: selfHostname,
          createdAt: now(),
          generation: current.admitGeneration,
          processGroup: null,
          settled: form === "ledger-mutation",
        };
        // Caller fills kind/targets after grant; write a provisional record so
        // exclusive cannot pass active-count while we finish validation.
        await writeAdmissionDocument(doc);
        return {
          id,
          epoch: current.epoch,
          roots: current.roots.slice() as string[],
          generation: current.admitGeneration,
        };
      });

      if (granted === null) {
        // Contended with exclusive; retry.
        continue;
      }
      // Generation could only change under exclusive which waits for our file —
      // still fail closed if somehow advanced.
      const post = await readRoots();
      if (post.admitGeneration !== generationAtEntry) {
        await deleteAdmissionDocument(granted.id);
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      return granted;
    }
  }

  async function admitLedgerMutation(input: {
    readonly kind: WorksetLedgerMutationKind;
    readonly targets: readonly string[];
  }): Promise<WorksetLedgerMutationAdmission> {
    if (!(WORKSET_LEDGER_MUTATION_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown ledger mutation kind: ${String(input.kind)}`,
      );
    }
    const granted = await beginNonExclusiveAdmit("ledger-mutation");
    try {
      for (const target of input.targets) {
        if (!isTargetAdmitted(target, granted.roots)) {
          throw new WorksetAdmissionError(
            "target-excluded",
            `ledger mutation target "${target}" is outside the admitted workset`,
          );
        }
      }
    } catch (err) {
      await deleteAdmissionDocument(granted.id);
      throw err;
    }

    // Persist final kind/targets.
    await withProjectLock(async () => {
      const existing = await readAdmissionDocument(granted.id);
      if (existing === null) {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission disappeared before finalisation",
        );
      }
      const finalDoc: AdmissionDocument = {
        ...existing,
        kind: input.kind,
        targets: input.targets.slice(),
      };
      await writeAdmissionDocument(finalDoc);
    });

    let open = true;
    const handle: WorksetLedgerMutationAdmission = {
      form: "ledger-mutation",
      id: granted.id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots,
      targets: input.targets.slice(),
      async acknowledge(): Promise<void> {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "ledger mutation admission already acknowledged",
          );
        }
        open = false;
        unregisterLiveWorksetAdmission(handle);
        await withProjectLock(async () => {
          await deleteAdmissionDocument(granted.id);
        });
      },
    };
    registerLiveWorksetAdmission(handle);
    Object.freeze(handle);
    return handle;
  }

  async function admitExternalEffect(input: {
    readonly kind: WorksetExternalEffectKind;
    readonly targetRef: string;
  }): Promise<WorksetExternalEffectAdmission> {
    if (!(WORKSET_EXTERNAL_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown external effect kind: ${String(input.kind)}`,
      );
    }
    const granted = await beginNonExclusiveAdmit("external-effect");
    if (!isTargetAdmitted(input.targetRef, granted.roots)) {
      await deleteAdmissionDocument(granted.id);
      throw new WorksetAdmissionError(
        "target-excluded",
        `external effect target "${input.targetRef}" is outside the admitted workset`,
      );
    }

    await withProjectLock(async () => {
      const existing = await readAdmissionDocument(granted.id);
      if (existing === null) {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission disappeared before finalisation",
        );
      }
      const finalDoc: AdmissionDocument = {
        ...existing,
        kind: input.kind,
        targetRef: input.targetRef,
      };
      await writeAdmissionDocument(finalDoc);
    });

    // Local mirror for sync getters on the handle.
    let processGroup: WorksetProcessGroupRegistration | null = null;
    let settled = false;
    let open = true;

    const handle: WorksetExternalEffectAdmission = {
      form: "external-effect",
      id: granted.id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots,
      targetRef: input.targetRef,
      get processGroupRegistered(): boolean {
        return processGroup !== null;
      },
      get settled(): boolean {
        return settled;
      },
      registerProcessGroup(registration: WorksetProcessGroupRegistration): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot register a process group on a closed external-effect admission",
          );
        }
        if (processGroup !== null) {
          throw new WorksetAdmissionError(
            "process-group-already-registered",
            "external-effect admission already has a registered process group",
          );
        }
        if (registration.pgid !== registration.leaderPid) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            "process-group registration requires leaderPid === pgid",
          );
        }
        processGroup = {
          pgid: registration.pgid,
          leaderPid: registration.leaderPid,
        };
        // Fire-and-observe: registration must be durable before target release.
        // Use a synchronous write so the broker cannot race past durability.
        const docPath = admissionPath(granted.id);
        const existingText = fsSync.readFileSync(docPath, "utf8");
        const existing = JSON.parse(existingText) as AdmissionDocument;
        const next: AdmissionDocument = {
          ...existing,
          processGroup,
          settled,
        };
        // Best-effort durable write; tests may inject atomicWrite async path via
        // release/ack, but registration is on the critical broker path.
        const tmp = `${docPath}.tmp-${selfPid}-${now()}`;
        fsSync.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        fsSync.renameSync(tmp, docPath);
      },
      markSettled(): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot settle a closed external-effect admission",
          );
        }
        if (processGroup === null) {
          throw new WorksetAdmissionError(
            "admission-not-registered",
            "cannot settle before process-group registration",
          );
        }
        settled = true;
        const docPath = admissionPath(granted.id);
        const existingText = fsSync.readFileSync(docPath, "utf8");
        const existing = JSON.parse(existingText) as AdmissionDocument;
        const next: AdmissionDocument = {
          ...existing,
          processGroup,
          settled: true,
        };
        const tmp = `${docPath}.tmp-${selfPid}-${now()}`;
        fsSync.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        fsSync.renameSync(tmp, docPath);
      },
      async releaseAfterSettlement(): Promise<void> {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "external-effect admission already released",
          );
        }
        if (processGroup === null) {
          throw new WorksetAdmissionError(
            "admission-not-registered",
            "external-effect admission requires process-group registration before release",
          );
        }
        if (!settled) {
          throw new WorksetAdmissionError(
            "process-group-not-settled",
            "external-effect admission requires process-group settlement before release",
          );
        }
        open = false;
        unregisterLiveWorksetAdmission(handle);
        await withProjectLock(async () => {
          await deleteAdmissionDocument(granted.id);
        });
      },
    };
    registerLiveWorksetAdmission(handle);
    Object.freeze(handle);
    return handle;
  }

  async function setRoots(nextRoots: readonly string[]): Promise<WorksetRootsEpoch> {
    return runExclusive("exclusive-set", async () => {
      const canonical = canonicalizeWorksetRootReplacement(nextRoots);
      if (validateReplacement !== undefined) {
        validateReplacement(canonical);
      }
      if (hooks.beforeCommit !== undefined) {
        await hooks.beforeCommit();
      }
      return withProjectLock(async () => {
        const current = await readRoots();
        const next: DurableRootsDocument = {
          version: ROOTS_FORMAT_VERSION,
          roots: canonical,
          epoch: current.epoch + 1,
          admitGeneration: current.admitGeneration + 1,
        };
        await writeRootsDocument(next);
        return { roots: next.roots.slice(), epoch: next.epoch };
      });
    });
  }

  async function runAdministrative(input: {
    readonly kind: WorksetAdministrativeEffectKind;
    readonly authority: unknown;
    readonly destructivePhase: () => Promise<void> | void;
  }): Promise<void> {
    if (!(WORKSET_ADMINISTRATIVE_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown administrative effect kind: ${String(input.kind)}`,
      );
    }
    if (!isTrustedWorksetManagementAuthority(input.authority)) {
      throw new WorksetAdmissionError(
        "management-authority-required",
        `administrative effect "${input.kind}" requires trusted management authority`,
      );
    }
    await runExclusive("exclusive-administrative", async () => {
      if (hooks.beforeAdministrativeDestructive !== undefined) {
        await hooks.beforeAdministrativeDestructive();
      }
      await input.destructivePhase();
      await withProjectLock(async () => {
        const current = await readRoots();
        const next: DurableRootsDocument = {
          version: ROOTS_FORMAT_VERSION,
          roots: current.roots.slice(),
          epoch: current.epoch,
          admitGeneration: current.admitGeneration + 1,
        };
        await writeRootsDocument(next);
      });
    });
  }

  return {
    snapshot,
    setRoots,
    admitLedgerMutation,
    admitExternalEffect,
    runAdministrative,
    activeAdmissionCount,
    exclusiveHeld,
  };
}
