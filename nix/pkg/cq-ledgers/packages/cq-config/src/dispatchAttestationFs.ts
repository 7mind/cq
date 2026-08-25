/**
 * The cross-process-safe filesystem production {@link AttestationBackend}
 * (T720, goal G94).
 *
 * Layout, under one root:
 *
 *     <root>/<backend>/<projectKey>/<sha256("<attestationId>#<generation>")>.json
 *     <root>/.locks/<backend>__<projectKey>.lock
 *
 * **Why the file name is a digest.** `attestationId` is minted, but a store must
 * not depend on that: a caller-influenceable value must never become a path
 * component. Hashing the composite handle yields a fixed 64-hex name, so no id
 * can traverse out of the namespace directory, collide by filesystem case
 * folding, or exceed a name limit. The namespace's own two components ARE used
 * verbatim, because {@link assertAttestationNamespace} already restricts them to
 * `[A-Za-z0-9][A-Za-z0-9._-]*` — no separator, no `.`, no `..`.
 *
 * **Cross-process safety** is an `O_EXCL` lockfile per NAMESPACE, held for the
 * whole unit of work, with stale-holder reclaim by pid liveness and a bounded
 * wait — the same discipline as the ledger's `store/lockfile.ts`, kept local
 * because `@cq/ledger` depends on `@cq/config`, not the reverse. Because the
 * lock is per namespace, two projects sharing one root never block each other.
 *
 * **Durability**: every row file is written to a unique temporary name, fsynced,
 * then `rename`d over its target, and the directory entry is fsynced. A crash
 * therefore leaves either the previous revision or the next one, never a torn
 * body. The apply re-reads and compare-and-sets each row's digest before
 * writing, so a peer that somehow wrote without the lock still loses instead of
 * being clobbered.
 *
 * The output lives in the row file's canonical JSON and nowhere else — no
 * parallel output store, no per-output blob file.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  AttestationStorageError,
  AttestationTransportError,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
} from "./dispatchAttestation.js";
import {
  assertAttestationStoreNamespace,
  attestationStorageKey,
  persistAttestationRow,
  rehydrateAttestationRow,
  runAttestationUnitOfWork,
  type AttestationBackend,
  type AttestationJournalEntry,
  type AttestationLoadScope,
  type LoadedAttestationRow,
} from "./dispatchAttestationBackend.js";
import { AsyncMutex } from "./asyncMutex.js";
import type { DispatchHandle } from "./compactDispatchProtocol.js";

/** The directory holding one lockfile per namespace. */
export const ATTESTATION_LOCKS_DIR = ".locks";

/** Default bounded wait for a live lock holder before declaring the store busy. */
export const ATTESTATION_LOCK_TIMEOUT_MS = 5_000;

/** Default poll cadence while waiting for a live holder. */
export const ATTESTATION_LOCK_POLL_MS = 15;

/** The only backends a filesystem attestation store may be bound to. */
const FS_NAMESPACE_BACKENDS: ReadonlySet<string> = new Set(["fs"]);

const ROW_FILE_SUFFIX = ".json";

/** The directory holding one namespace's row files. */
export function fsAttestationNamespaceDir(root: string, namespace: AttestationNamespace): string {
  const resolved = assertAttestationStoreNamespace(namespace);
  return join(root, resolved.backend, resolved.projectKey);
}

/**
 * The row file one handle occupies inside its namespace. Exported because the
 * adapter suite needs to write a revision OUT OF BAND — the only way the
 * journal's digest predicate can be reached on a store whose lock a plain
 * `writeFileSync` ignores — and re-deriving the digest in a test would let the
 * two derivations drift.
 */
export function fsAttestationRowPath(
  root: string,
  namespace: AttestationNamespace,
  handle: DispatchHandle,
): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(new TextEncoder().encode(attestationStorageKey(handle)))
    .digest("hex");
  return join(fsAttestationNamespaceDir(root, namespace), `${digest}${ROW_FILE_SUFFIX}`);
}

/**
 * The on-disk envelope around a row: the content digest beside the canonical
 * body, exactly as the SQL adapters keep `row_digest` beside `body`.
 */
export function fsAttestationRowFileContent(row: AttestationRow): string {
  const persisted = persistAttestationRow(row);
  return `${JSON.stringify({ rowDigest: persisted.rowDigest, body: persisted.body })}\n`;
}

interface LockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
}

export interface FsAttestationBackendOptions {
  readonly namespace: AttestationNamespace;
  /** The root the layout above is rooted at. Created on demand. */
  readonly root: string;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
  /** Override for tests. Defaults to `process.kill(pid, 0)`. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Override for tests. Defaults to `process.pid`. */
  readonly selfPid?: number;
}

/** One row file's on-disk identity. */
interface RowFile extends LoadedAttestationRow {
  readonly path: string;
}

/**
 * The filesystem attestation backend. Bound to ONE namespace; another
 * namespace's rows live in a sibling directory it never reads and cannot reach.
 */
export class FsAttestationBackend implements AttestationBackend {
  readonly namespace: AttestationNamespace;
  readonly root: string;

  private readonly namespaceDir: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly selfPid: number;
  private readonly mutex = new AsyncMutex();
  private closed = false;

  constructor(options: FsAttestationBackendOptions) {
    this.namespace = assertFsNamespace(options.namespace);
    this.root = options.root;
    this.namespaceDir = fsAttestationNamespaceDir(options.root, this.namespace);
    this.lockPath = join(
      options.root,
      ATTESTATION_LOCKS_DIR,
      `${this.namespace.backend}__${this.namespace.projectKey}.lock`,
    );
    this.lockTimeoutMs = options.lockTimeoutMs ?? ATTESTATION_LOCK_TIMEOUT_MS;
    this.lockPollMs = options.lockPollMs ?? ATTESTATION_LOCK_POLL_MS;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.selfPid = options.selfPid ?? process.pid;
  }

  /** The rows of THIS namespace, for a caller inspecting durable state. */
  storedRows(): readonly AttestationRow[] {
    return Object.freeze(this.readAll().map((entry) => entry.row));
  }

  /** Every file this backend owns under its namespace directory. */
  storageArtifacts(): readonly string[] {
    return Object.freeze([...this.listRowFiles()].sort());
  }

  /** Every persisted byte, for a caller asserting what the store does NOT hold. */
  rawStorageDump(): string {
    return this.storageArtifacts()
      .map((name) => readFileSync(join(this.namespaceDir, name), "utf8"))
      .join("\n");
  }

  transact<T>(
    scope: AttestationLoadScope,
    body: (store: AttestationStore) => T | Promise<T>,
  ): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new AttestationTransportError(`attestation store "${this.namespaceDir}" is closed`);
      }
      this.ensureDirs();
      const release = await this.acquireLock();
      try {
        return await runAttestationUnitOfWork(
          this.namespace,
          scope,
          {
            load: (loadScope) => this.loadScoped(loadScope),
            apply: (journal) => {
              this.applyJournal(journal);
            },
          },
          body,
        );
      } finally {
        await release();
      }
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  // --- loading ------------------------------------------------------------

  /**
   * Read exactly the rows `scope` admits.
   *
   * The per-scope narrowing here is an EFFICIENCY property, not a guard, and
   * mutation M40 proved it: widening a `handle` load to every row in the
   * namespace changes no observable outcome, because
   * {@link BufferedAttestationStore} refuses every lookup outside the scope
   * regardless of what was loaded. What the narrowing buys is not reading N row
   * files to answer one handle. The correctness half lives in the buffer, where
   * it is reachable and asserted.
   */
  private loadScoped(scope: AttestationLoadScope): readonly LoadedAttestationRow[] {
    switch (scope.kind) {
      case "none":
        return Object.freeze([]);
      case "handle": {
        const found = this.readOne(scope.handle);
        return Object.freeze(found === undefined ? [] : [found]);
      }
      case "namespace":
        return this.readAll();
      case "capability":
        return Object.freeze(
          this.readAll().filter(
            (entry) =>
              entry.row.kind === "envelope" &&
              entry.row.resultCapabilityHash === scope.capabilityHash,
          ),
        );
      case "prepare": {
        const reprepare = scope.reprepareOf;
        return Object.freeze(
          this.readAll().filter(
            (entry) =>
              entry.row.idempotencyKey === scope.idempotencyKey ||
              (reprepare !== undefined &&
                entry.row.attestationId === reprepare.attestationId &&
                entry.row.generation === reprepare.generation),
          ),
        );
      }
    }
  }

  private rowPath(handle: DispatchHandle): string {
    return fsAttestationRowPath(this.root, this.namespace, handle);
  }

  private readOne(handle: DispatchHandle): RowFile | undefined {
    const path = this.rowPath(handle);
    const text = this.readIfPresent(path);
    if (text === undefined) {
      return undefined;
    }
    return { path, ...this.parseRowFile(path, text) };
  }

  private readAll(): readonly RowFile[] {
    const entries: RowFile[] = [];
    for (const name of this.listRowFiles()) {
      const path = join(this.namespaceDir, name);
      const text = this.readIfPresent(path);
      if (text === undefined) {
        continue;
      }
      entries.push({ path, ...this.parseRowFile(path, text) });
    }
    entries.sort((a, b) =>
      attestationStorageKey(a.row).localeCompare(attestationStorageKey(b.row)),
    );
    return Object.freeze(entries);
  }

  private listRowFiles(): readonly string[] {
    try {
      return readdirSync(this.namespaceDir).filter((name) => name.endsWith(ROW_FILE_SUFFIX));
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        return [];
      }
      throw asFsBackendError(error);
    }
  }

  private readIfPresent(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        return undefined;
      }
      throw asFsBackendError(error);
    }
  }

  /**
   * A row file carries `{ rowDigest, body }`, so the stored digest is checked
   * against the body exactly as the SQL adapters check their `row_digest`
   * column: a body that does not digest to it is corruption, not a state.
   */
  private parseRowFile(path: string, text: string): LoadedAttestationRow {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch (error) {
      throw new AttestationStorageError(
        `attestation file "${path}" is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new AttestationStorageError(`attestation file "${path}" is not an object`);
    }
    const record = envelope as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(record, "rowDigest") || !Object.hasOwn(record, "body")) {
      throw new AttestationStorageError(
        `attestation file "${path}" has no rowDigest/body envelope`,
      );
    }
    const digest = record["rowDigest"];
    const body = record["body"];
    if (typeof digest !== "string" || typeof body !== "string") {
      throw new AttestationStorageError(`attestation file "${path}" has a malformed envelope`);
    }
    return Object.freeze({
      row: rehydrateAttestationRow(this.namespace, body, digest),
      rowDigest: digest,
    });
  }

  // --- applying -----------------------------------------------------------

  private applyJournal(journal: readonly AttestationJournalEntry[]): void {
    for (const entry of journal) {
      switch (entry.kind) {
        case "insert": {
          const path = this.rowPath(entry.row);
          if (this.readIfPresent(path) !== undefined) {
            throw new AttestationStorageError(
              `attestation "${attestationStorageKey(entry.row)}" already exists`,
            );
          }
          this.assertIdempotencyKeyUnheld(entry.row.idempotencyKey, path);
          this.assertCapabilityHashUnheld(entry.row.resultCapabilityHash, path);
          this.writeRow(path, entry.row);
          break;
        }
        case "replace": {
          const path = this.rowPath(entry.handle);
          this.assertDurableDigest(path, entry.handle, entry.expectedDigest);
          this.writeRow(path, entry.row);
          break;
        }
        case "remove": {
          const path = this.rowPath(entry.handle);
          this.assertDurableDigest(path, entry.handle, entry.expectedDigest);
          try {
            // Same-directory unlink; the entry-level fsync below makes the
            // removal durable rather than merely visible.
            unlinkSync(path);
          } catch (error) {
            throw asFsBackendError(error);
          }
          this.fsyncDir(this.namespaceDir);
          break;
        }
      }
    }
  }

  /**
   * The durable half of the idempotency horizon, enforced by the ADAPTER: the
   * SQL backends get it from a unique index, and a filesystem has none, so the
   * insert re-reads every sibling row under the namespace lock.
   */
  private assertIdempotencyKeyUnheld(idempotencyKey: string, exceptPath: string): void {
    for (const entry of this.readAll()) {
      if (entry.path !== exceptPath && entry.row.idempotencyKey === idempotencyKey) {
        throw new AttestationStorageError(
          `idempotency key "${idempotencyKey}" is already held by ` +
            `"${attestationStorageKey(entry.row)}"`,
        );
      }
    }
  }

  /**
   * The filesystem stand-in for the SQL adapters' unique capability-hash index:
   * two LIVE rows must never be resolvable by one capability. A tombstone keeps
   * no hash at all, so a collapsed row never participates.
   */
  private assertCapabilityHashUnheld(capabilityHash: string, exceptPath: string): void {
    for (const entry of this.readAll()) {
      if (
        entry.path !== exceptPath &&
        entry.row.kind === "envelope" &&
        entry.row.resultCapabilityHash === capabilityHash
      ) {
        throw new AttestationStorageError(
          `capability hash is already held by "${attestationStorageKey(entry.row)}"`,
        );
      }
    }
  }

  private assertDurableDigest(path: string, handle: DispatchHandle, expectedDigest: string): void {
    const text = this.readIfPresent(path);
    if (text === undefined) {
      throw new AttestationStorageError(
        `no attestation "${attestationStorageKey(handle)}" to write`,
      );
    }
    const current = this.parseRowFile(path, text);
    if (current.rowDigest !== expectedDigest) {
      throw new AttestationStorageError(
        `lost update on attestation "${attestationStorageKey(handle)}"`,
      );
    }
  }

  private writeRow(path: string, row: AttestationRow): void {
    const payload = fsAttestationRowFileContent(row);
    const tmp = `${path}.tmp-${String(this.selfPid)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const fd = openSync(tmp, "wx");
      try {
        writeAllSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort: the temp file never became the row.
      }
      throw asFsBackendError(error);
    }
    this.fsyncDir(this.namespaceDir);
  }

  private fsyncDir(dir: string): void {
    let fd: number;
    try {
      fd = openSync(dir, "r");
    } catch (error) {
      throw asFsBackendError(error);
    }
    try {
      fsyncSync(fd);
    } catch {
      // Some filesystems refuse fsync on a directory fd (EINVAL). The rename
      // itself is already atomic; this is a durability upgrade, not a
      // correctness requirement.
    } finally {
      closeSync(fd);
    }
  }

  private ensureDirs(): void {
    try {
      mkdirSync(this.namespaceDir, { recursive: true });
      mkdirSync(join(this.root, ATTESTATION_LOCKS_DIR), { recursive: true });
    } catch (error) {
      throw asFsBackendError(error);
    }
  }

  // --- the cross-process lock --------------------------------------------

  /**
   * Take the namespace's lock, waiting out a LIVE holder up to
   * `lockTimeoutMs` and reclaiming a DEAD one. `O_EXCL` is the sole arbiter, so
   * two waiters can never both win.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    const release = async (): Promise<void> => {
      await fs.unlink(this.lockPath).catch(() => undefined);
    };
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      if (await this.tryLock()) {
        return release;
      }
      const holder = this.readHolder();
      if (holder !== undefined && !this.isPidAlive(holder.pid)) {
        await fs.unlink(this.lockPath).catch(() => undefined);
        if (await this.tryLock()) {
          return release;
        }
      }
      if (Date.now() >= deadline) {
        throw new AttestationTransportError(
          `attestation store "${this.namespaceDir}" is locked by pid ` +
            `${String(holder?.pid ?? 0)} on ${holder?.hostname ?? "unknown"}`,
        );
      }
      await sleep(this.lockPollMs);
    }
  }

  private async tryLock(): Promise<boolean> {
    const holder: LockHolder = {
      pid: this.selfPid,
      hostname: hostname(),
      startedAt: Date.now(),
    };
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.lockPath, "wx");
    } catch (error) {
      if (errnoOf(error) === "EEXIST") {
        return false;
      }
      throw asFsBackendError(error);
    }
    try {
      await handle.writeFile(JSON.stringify(holder), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  private readHolder(): LockHolder | undefined {
    const text = this.readIfPresent(this.lockPath);
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A holder mid-write between O_EXCL and writeFile. Never reclaim on a
      // transient body — that would yank a live holder's lock.
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const pid = record["pid"];
    if (typeof pid !== "number") {
      return undefined;
    }
    return {
      pid,
      hostname: typeof record["hostname"] === "string" ? record["hostname"] : "unknown",
      startedAt: typeof record["startedAt"] === "number" ? record["startedAt"] : 0,
    };
  }
}

function assertFsNamespace(namespace: AttestationNamespace): AttestationNamespace {
  const resolved = assertAttestationStoreNamespace(namespace);
  if (!FS_NAMESPACE_BACKENDS.has(resolved.backend)) {
    throw new AttestationStorageError(
      `a filesystem attestation store serves the "fs" backend, not "${resolved.backend}"`,
    );
  }
  return resolved;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return errnoOf(error) === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Codes that mean the store refused a write rather than being unreachable. */
const FS_STORAGE_CODES: ReadonlySet<string> = new Set(["EEXIST", "ENOTDIR", "EISDIR"]);

/**
 * Classify a filesystem failure. Exported so the adapter suite can assert the
 * classification rather than infer it from a message.
 */
export function asFsBackendError(error: unknown): Error {
  if (error instanceof AttestationStorageError || error instanceof AttestationTransportError) {
    return error;
  }
  const code = errnoOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code !== undefined && FS_STORAGE_CODES.has(code)) {
    return new AttestationStorageError(`filesystem attestation store refused a write: ${message}`);
  }
  return new AttestationTransportError(`filesystem attestation store unreachable: ${message}`);
}

/** A short write is legal on a POSIX fd, so the loop is not decoration. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written);
  }
}
