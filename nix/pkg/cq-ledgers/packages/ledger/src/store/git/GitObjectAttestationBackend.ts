/**
 * Dispatch attestations stored beside the ledger on its orphan Git ref.
 *
 * One namespace occupies one canonical JSON document. A transaction holds a
 * real cross-process lock while it reads the ref tip, runs the shared buffered
 * unit of work, writes a replacement tree, and advances the ref with Git's
 * compare-and-swap `update-ref`. The lock serializes cooperating attestation
 * writers; the ref CAS fails closed if any other Git-object writer moved the
 * shared ref meanwhile.
 */

import * as path from "node:path";
import {
  AttestationStorageError,
  AttestationTransportError,
  assertAttestationStoreNamespace,
  attestationRowDigest,
  attestationStorageKey,
  persistAttestationRow,
  rehydrateAttestationRow,
  runAttestationUnitOfWork,
  type AttestationBackend,
  type AttestationJournalEntry,
  type AttestationLoadScope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
  type LoadedAttestationRow,
} from "@cq/config";
import { LEDGER_STORAGE_DIRNAME } from "../../constants.js";
import { LedgerBusyError } from "../../types.js";
import { Lockfile, type LockfileOpts } from "../lockfile.js";
import { AsyncMutex } from "../mutex.js";
import { GitCommandError, GitPlumbing, StaleRefError, type TreeEntry } from "./GitPlumbing.js";

const DEFAULT_BRANCH = "cq-ledger";
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BLOB_MODE = "100644";
const DOCUMENT_VERSION = 1;
const TREE_PREFIX = "attestations/git-object";
const LOCK_KEY_PREFIX = "dispatch-attestations-";

interface StoredRowEnvelope {
  readonly rowDigest: string;
  readonly body: string;
}

interface StoredDocument {
  readonly version: 1;
  readonly rows: readonly StoredRowEnvelope[];
}

interface GitObjectAttestationSnapshot {
  readonly head: string | null;
  readonly entries: readonly TreeEntry[];
  readonly rows: readonly LoadedAttestationRow[];
  readonly raw: string;
}

export interface GitObjectAttestationBackendOptions {
  readonly namespace: AttestationNamespace;
  readonly repoRoot: string;
  /** Short orphan branch name. Defaults to the ledger's `cq-ledger`. */
  readonly ref?: string;
  readonly git?: GitPlumbing;
  readonly lockfile?: LockfileOpts;
}

export class GitObjectAttestationBackend implements AttestationBackend {
  readonly namespace: AttestationNamespace;
  readonly repoRoot: string;

  private readonly git: GitPlumbing;
  private readonly ref: string;
  private readonly treePath: string;
  private readonly locksDir: string;
  private readonly lockKey: string;
  private readonly lockfile: Lockfile;
  private readonly mutex = new AsyncMutex();
  private closed = false;

  constructor(options: GitObjectAttestationBackendOptions) {
    this.namespace = assertGitObjectNamespace(options.namespace);
    this.repoRoot = options.repoRoot;
    this.ref = `refs/heads/${options.ref ?? DEFAULT_BRANCH}`;
    this.treePath = `${TREE_PREFIX}/${this.namespace.projectKey}.json`;
    this.locksDir = path.join(options.repoRoot, LEDGER_STORAGE_DIRNAME, ".locks");
    this.lockKey = `${LOCK_KEY_PREFIX}${this.namespace.projectKey}`;
    this.lockfile = new Lockfile(options.lockfile ?? {});
    this.git =
      options.git ?? GitPlumbing.withCwd(options.repoRoot, path.join(options.repoRoot, ".git"));
  }

  transact<T>(
    scope: AttestationLoadScope,
    body: (store: AttestationStore) => T | Promise<T>,
  ): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new AttestationTransportError(
          `git-object attestation store "${this.ref}:${this.treePath}" is closed`,
        );
      }
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.lockfile.acquire(this.locksDir, this.lockKey);
        const snapshot = await this.readSnapshot();
        return await runAttestationUnitOfWork(
          this.namespace,
          scope,
          {
            load: (loadScope) => this.loadScoped(snapshot.rows, loadScope),
            apply: (journal) => this.applyJournal(snapshot, journal),
          },
          body,
        );
      } catch (error) {
        throw asGitObjectAttestationError(error);
      } finally {
        await release?.();
      }
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  async storedRows(): Promise<readonly AttestationRow[]> {
    return this.transact({ kind: "namespace" }, (store) => store.rows());
  }

  async rawStorageDump(): Promise<string> {
    return this.mutex.run(async () => (await this.readSnapshot()).raw);
  }

  async storageArtifacts(): Promise<readonly string[]> {
    return this.mutex.run(async () => {
      const snapshot = await this.readSnapshot();
      return Object.freeze(
        snapshot.entries.filter((entry) => entry.path === this.treePath).map((entry) => entry.path),
      );
    });
  }

  private async readSnapshot(): Promise<GitObjectAttestationSnapshot> {
    await this.git.assertRepository();
    const head = await this.git.readRef(this.ref);
    if (head === null) {
      return Object.freeze({ head, entries: Object.freeze([]), rows: Object.freeze([]), raw: "" });
    }
    const entries = Object.freeze(await this.git.lsTreeEntries(head));
    if (!entries.some((entry) => entry.path === this.treePath)) {
      return Object.freeze({ head, entries, rows: Object.freeze([]), raw: "" });
    }
    const raw = await this.git.catFile(head, this.treePath);
    const rows = this.parseDocument(raw);
    return Object.freeze({ head, entries, rows, raw });
  }

  private parseDocument(raw: string): readonly LoadedAttestationRow[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AttestationStorageError(
        `git-object attestation document is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AttestationStorageError("git-object attestation document is not an object");
    }
    const document = parsed as Readonly<Record<string, unknown>>;
    if (document["version"] !== DOCUMENT_VERSION || !Array.isArray(document["rows"])) {
      throw new AttestationStorageError(
        "git-object attestation document has an unsupported version or malformed rows",
      );
    }
    const rows = document["rows"].map((value, index): LoadedAttestationRow => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new AttestationStorageError(
          `git-object attestation document row ${String(index)} is not an object`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      const rowDigest = record["rowDigest"];
      const body = record["body"];
      if (typeof rowDigest !== "string" || typeof body !== "string") {
        throw new AttestationStorageError(
          `git-object attestation document row ${String(index)} is malformed`,
        );
      }
      return Object.freeze({
        row: rehydrateAttestationRow(this.namespace, body, rowDigest),
        rowDigest,
      });
    });
    this.assertUniqueRows(rows);
    return Object.freeze(rows);
  }

  private loadScoped(
    rows: readonly LoadedAttestationRow[],
    scope: AttestationLoadScope,
  ): readonly LoadedAttestationRow[] {
    switch (scope.kind) {
      case "none":
        return Object.freeze([]);
      case "namespace":
        return rows;
      case "handle":
        return Object.freeze(rows.filter((entry) => sameHandle(entry.row, scope.handle)));
      case "capability":
        return Object.freeze(
          rows.filter(
            (entry) =>
              entry.row.kind === "envelope" &&
              entry.row.resultCapabilityHash === scope.capabilityHash,
          ),
        );
      case "prepare":
        return Object.freeze(
          rows.filter(
            (entry) =>
              entry.row.idempotencyKey === scope.idempotencyKey ||
              (scope.reprepareOf !== undefined && sameHandle(entry.row, scope.reprepareOf)),
          ),
        );
    }
  }

  private async applyJournal(
    snapshot: GitObjectAttestationSnapshot,
    journal: readonly AttestationJournalEntry[],
  ): Promise<void> {
    const rows = new Map(
      snapshot.rows.map((entry) => [attestationStorageKey(entry.row), entry] as const),
    );
    for (const entry of journal) {
      const key = attestationStorageKey(entry.kind === "insert" ? entry.row : entry.handle);
      if (entry.kind === "insert") {
        if (rows.has(key)) {
          throw new AttestationStorageError(`attestation "${key}" already exists`);
        }
        this.assertUniqueCandidate(rows, entry.row, key);
        rows.set(key, Object.freeze({ row: entry.row, rowDigest: entry.digest }));
        continue;
      }
      const current = rows.get(key);
      if (current === undefined) {
        throw new AttestationStorageError(`no attestation "${key}" to ${entry.kind}`);
      }
      if (current.rowDigest !== entry.expectedDigest) {
        throw new AttestationStorageError(`lost update on attestation "${key}"`);
      }
      if (entry.kind === "remove") {
        rows.delete(key);
      } else {
        this.assertUniqueCandidate(rows, entry.row, key);
        rows.set(key, Object.freeze({ row: entry.row, rowDigest: entry.digest }));
      }
    }
    await this.writeSnapshot(snapshot, [...rows.values()]);
  }

  private assertUniqueRows(rows: readonly LoadedAttestationRow[]): void {
    const byKey = new Map<string, LoadedAttestationRow>();
    for (const entry of rows) {
      const key = attestationStorageKey(entry.row);
      if (byKey.has(key)) {
        throw new AttestationStorageError(`duplicate git-object attestation "${key}"`);
      }
      this.assertUniqueCandidate(byKey, entry.row, key);
      byKey.set(key, entry);
    }
  }

  private assertUniqueCandidate(
    rows: ReadonlyMap<string, LoadedAttestationRow>,
    candidate: AttestationRow,
    candidateKey: string,
  ): void {
    for (const [key, entry] of rows) {
      if (key === candidateKey) continue;
      if (entry.row.idempotencyKey === candidate.idempotencyKey) {
        throw new AttestationStorageError(
          `idempotency key "${candidate.idempotencyKey}" is already held by "${key}"`,
        );
      }
      if (
        candidate.kind === "envelope" &&
        entry.row.kind === "envelope" &&
        entry.row.resultCapabilityHash === candidate.resultCapabilityHash
      ) {
        throw new AttestationStorageError(`capability hash is already held by "${key}"`);
      }
    }
  }

  private async writeSnapshot(
    snapshot: GitObjectAttestationSnapshot,
    rows: readonly LoadedAttestationRow[],
  ): Promise<void> {
    const kept = snapshot.entries.filter((entry) => entry.path !== this.treePath);
    if (rows.length > 0) {
      const blob = await this.git.hashObject(serializeDocument(rows));
      kept.push({ mode: BLOB_MODE, sha: blob, path: this.treePath });
    }
    const tree = kept.length === 0 ? EMPTY_TREE_OID : await this.git.writeTree(kept);
    const commit = await this.git.commitTree(
      tree,
      snapshot.head,
      `attestations: update ${this.namespace.projectKey}`,
    );
    await this.git.updateRef(this.ref, commit, snapshot.head);
  }
}

function serializeDocument(rows: readonly LoadedAttestationRow[]): string {
  const storedRows = [...rows]
    .sort((left, right) =>
      attestationStorageKey(left.row).localeCompare(attestationStorageKey(right.row)),
    )
    .map((entry): StoredRowEnvelope => {
      const persisted = persistAttestationRow(entry.row);
      if (
        persisted.rowDigest !== entry.rowDigest ||
        attestationRowDigest(entry.row) !== entry.rowDigest
      ) {
        throw new AttestationStorageError(
          `attestation "${attestationStorageKey(entry.row)}" has a mismatched revision digest`,
        );
      }
      return Object.freeze({ rowDigest: persisted.rowDigest, body: persisted.body });
    });
  const document: StoredDocument = Object.freeze({
    version: DOCUMENT_VERSION,
    rows: Object.freeze(storedRows),
  });
  return `${JSON.stringify(document)}\n`;
}

function sameHandle(
  row: AttestationRow,
  handle: { readonly attestationId: string; readonly generation: number },
): boolean {
  return row.attestationId === handle.attestationId && row.generation === handle.generation;
}

function assertGitObjectNamespace(namespace: AttestationNamespace): AttestationNamespace {
  const resolved = assertAttestationStoreNamespace(namespace);
  if (resolved.backend !== "git-object") {
    throw new AttestationStorageError(
      `a Git-object attestation store serves the "git-object" backend, not "${resolved.backend}"`,
    );
  }
  return resolved;
}

function asGitObjectAttestationError(error: unknown): Error {
  if (error instanceof AttestationStorageError || error instanceof AttestationTransportError) {
    return error;
  }
  if (error instanceof StaleRefError) {
    return new AttestationStorageError(
      `git-object attestation transaction lost its ref compare-and-set: ${error.message}`,
    );
  }
  if (error instanceof GitCommandError || error instanceof LedgerBusyError) {
    return new AttestationTransportError(
      `git-object attestation store is unreachable: ${error.message}`,
    );
  }
  return error instanceof Error
    ? error
    : new AttestationTransportError(`git-object attestation store failed with ${String(error)}`);
}
