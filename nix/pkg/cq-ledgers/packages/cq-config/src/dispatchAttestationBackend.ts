/**
 * The namespaced production {@link AttestationStore} engine (T720, goal G94).
 *
 * T685 landed the lifecycle contract, the service logic and a STRICT in-memory
 * dummy behind one injected port, and deferred four things to this task
 * ({@link DISPATCH_ATTESTATION_DEFERRED}): the namespaced production adapters,
 * real-backend durability and crash recovery, cross-process concurrent key reuse
 * under a REAL lock, and scheduled sweep wiring. This module is the part all
 * three adapters share; the backends themselves are
 * {@link ./dispatchAttestationSqlite}, {@link ./dispatchAttestationFs} and
 * {@link ./dispatchAttestationPostgres}.
 *
 * **Why a unit of work and not three hand-written stores.** {@link AttestationStore}
 * is SYNCHRONOUS by construction: the service reads a row, decides a transition
 * and compare-and-sets it in one straight-line call, and T685's whole guard set
 * depends on that. bun:sqlite and `node:fs` are natively synchronous;
 * PostgreSQL is not. Rather than fork the contract per backend — or, worse, let
 * a Postgres adapter answer a read from a stale cache and lose a write — every
 * adapter runs each service operation as ONE serialized unit of work:
 *
 *  1. take the backend's real, cross-process EXCLUSIVE lock for the namespace
 *     (`BEGIN IMMEDIATE`, an `O_EXCL` lockfile, `pg_advisory_xact_lock`);
 *  2. load exactly the rows the operation is allowed to see
 *     ({@link AttestationLoadScope}) into a {@link BufferedAttestationStore};
 *  3. run the SYNCHRONOUS service call against that buffer, which journals the
 *     writes it decided instead of performing them;
 *  4. apply the journal durably, each entry carrying the digest of the revision
 *     it observed, so the durable write is itself a compare-and-set;
 *  5. commit — or roll the whole thing back on any throw.
 *
 * The lock makes step 2's snapshot valid through step 4, which is what turns
 * "concurrent key reuse" and "cleanup versus store/confirm/fetch/retry" into
 * decided outcomes instead of races. The journal's per-entry expected digest is
 * belt-and-braces on top: a backend that somehow lost the lock still refuses a
 * lost update rather than clobbering a row.
 *
 * **The buffer is deliberately narrow.** A unit of work loads a SCOPE, and the
 * buffer REFUSES any lookup outside it ({@link AttestationStorageError}) instead
 * of answering "absent". A permissive adapter that silently answered `undefined`
 * for an unloaded row would make the service's own guards look satisfied while
 * quietly changing the outcome — the exact failure mode T685 hit when its strict
 * dummy's guards masked service-side guards.
 *
 * **Scope building never pre-empts the service's own ordering.** A malformed
 * handle, capability or idempotency key resolves to a scope the service will not
 * consult (`none`, or `prepare` without its re-prepare handle) rather than
 * throwing while the scope is built. D174 fixed `fetch_dispatch_result` to
 * enforce namespace THEN actor; if this module threw on a malformed handle first,
 * the backend-bound surface would report a different failure than the in-process
 * service for the same request, and the D174 ordering would hold only in
 * unit tests.
 *
 * **Namespacing never comes from a request.** A backend is opened FOR one
 * {@link AttestationNamespace} and every row it stores, loads, or accepts is
 * keyed by `{backend, projectKey}`. Two namespaces sharing one physical location
 * cannot see each other's rows, cannot collide on an idempotency key, and cannot
 * resolve each other's capability hashes.
 *
 * **Not every ledger backend can hold attestations.**
 * {@link ATTESTATION_STORE_BACKENDS} names the three that can;
 * {@link ATTESTATION_EXCLUDED_BACKENDS} names the ones that must fail at
 * REGISTRATION, before a dispatch is ever prepared, rather than half-working.
 */

import {
  AttestationContractError,
  AttestationNamespaceError,
  AttestationStorageError,
  assertAttestationNamespace,
  assertDispatchHandle,
  attestationNamespacesEqual,
  attestationRowDigest,
  formatAttestationNamespace,
  isAttestationTombstone,
  resultCapabilityHash,
  abortDispatch,
  authorizeDispatchGitConflict,
  authorizeDispatchGitEffect,
  confirmDispatchCompletion,
  fetchDispatchResult,
  fetchDispatchInput,
  gitEffectBindingForResultCapability,
  gitEffectBindingForHandle,
  prepareDispatch,
  storeDispatchResult,
  sweepAttestations,
  DISPATCH_ATTESTATION_DEFERRED,
  type AbortDispatchRequest,
  type AuthorizeDispatchGitEffectRequest,
  type AuthorizeDispatchGitConflictRequest,
  type AuthorizedDispatchGitEffect,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
  type AttestationSweepReport,
  type ConfirmDispatchCompletionOutcome,
  type ConfirmDispatchCompletionRequest,
  type DispatchNow,
  type DispatchRandomBytes,
  type FetchDispatchResultRequest,
  type FetchDispatchInputRequest,
  type DispatchGitEffectBinding,
  type PrepareDispatchOutcome,
  type PrepareDispatchRequest,
  type StoreDispatchResultOutcome,
} from "./dispatchAttestation.js";
import { LEDGER_BACKENDS } from "./types.js";
import type {
  AbortedDispatchResult,
  DispatchHandle,
  FetchDispatchResult,
  MaterializedDispatchInput,
  StoreDispatchResult,
} from "./compactDispatchProtocol.js";

// ---------------------------------------------------------------------------
// Which ledger backends may hold attestations at all
// ---------------------------------------------------------------------------

/**
 * The ledger backends with a production attestation adapter: the out-of-tree
 * bun:sqlite XDG primary, the cross-process-safe filesystem store, and
 * PostgreSQL.
 */
export const ATTESTATION_STORE_BACKENDS = ["xdg", "fs", "postgres"] as const;

export type AttestationStoreBackend = (typeof ATTESTATION_STORE_BACKENDS)[number];

const ATTESTATION_STORE_BACKEND_SET: ReadonlySet<string> = new Set(ATTESTATION_STORE_BACKENDS);

/**
 * The ledger backends that deliberately have NO attestation adapter, with the
 * reason each is refused. Both must fail at registration — before a dispatch is
 * prepared — rather than accept a prepare they cannot serve.
 *
 *  - `git-object` stores whole serialized ledger blobs in git objects. It has no
 *    row-level compare-and-set and no cross-process write lock, so a dispatch
 *    prepared against it could lose a stored result to a concurrent writer.
 *  - `remote` is a CLIENT of a ledger service, not a store. Its attestations
 *    live in the server's own namespace; a local adapter over it would mint
 *    capabilities bound to rows nobody durably holds.
 */
export const ATTESTATION_EXCLUDED_BACKENDS = ["git-object", "remote"] as const;

export type AttestationExcludedBackend = (typeof ATTESTATION_EXCLUDED_BACKENDS)[number];

/**
 * Why each excluded backend is refused. Exported so a test can assert that the
 * DECLARED reason actually reaches the caller: a refusal that fell through to
 * the generic "unknown ledger backend" branch would still be a refusal, and a
 * test asserting only "it throws" would pass while the exclusion table did
 * nothing. (Found by mutation M1 — see the module note on D174.)
 */
export const ATTESTATION_EXCLUSION_REASONS: ReadonlyMap<string, string> = new Map([
  [
    "git-object",
    "the git-object backend has no row-level compare-and-set and no cross-process write lock, " +
      "so a stored result could be lost to a concurrent writer",
  ],
  [
    "remote",
    "the remote backend is a ledger-service client, not a store: its attestations belong to the " +
      "server's own namespace",
  ],
] as const);

/**
 * The in-memory {@link AttestationStore} is a TEST DOUBLE
 * ({@link ./dispatchAttestationDummy}), not a backend: it survives no restart
 * and is visible to no peer process, so it can never hold a real capability.
 * It is named here so "the in-memory store is excluded" is an asserted fact
 * rather than an omission.
 */
export const ATTESTATION_IN_MEMORY_BACKEND = "in-memory" as const;

/**
 * A backend that cannot hold attestations was named where one is required.
 *
 * Extends {@link AttestationContractError} because that is exactly what this is:
 * an authoring defect in a declaration, caught at registration. Being part of the
 * declared error taxonomy also means {@link isAttestationDomainError} recognises
 * it, so no adapter can rewrite it into a driver failure — the D177 class of bug.
 * (A coverage test over the package's exported error classes found it sitting
 * outside the taxonomy.)
 */
export class AttestationBackendUnsupportedError extends AttestationContractError {
  readonly backend: string;

  constructor(backend: string, detail: string) {
    super(`backend "${backend}"`, `cannot hold dispatch attestations: ${detail}`);
    this.name = "AttestationBackendUnsupportedError";
    this.backend = backend;
  }
}

/**
 * Module-load invariant: every declared ledger backend is EITHER adapted or
 * explicitly excluded with a reason, and the two sets are disjoint. Adding a
 * sixth ledger backend without deciding whether it can hold attestations fails
 * at import time rather than at a dispatch. Its value is the sorted coverage.
 */
export function assertAttestationBackendCoverage(
  backends: readonly string[],
  adapted: readonly string[],
  excluded: readonly string[],
  reasons: ReadonlyMap<string, string>,
): readonly string[] {
  const declared = [...backends].sort();
  const decided = [...adapted, ...excluded].sort();
  if (declared.join(",") !== decided.join(",")) {
    throw new AttestationContractError(
      "ATTESTATION_STORE_BACKENDS",
      `ledger backends [${declared.join(", ")}] are not exactly the adapted plus excluded ` +
        `backends [${decided.join(", ")}]`,
    );
  }
  const overlap = adapted.filter((backend) => excluded.includes(backend));
  if (overlap.length > 0) {
    throw new AttestationContractError(
      "ATTESTATION_EXCLUDED_BACKENDS",
      `backends [${overlap.join(", ")}] are both adapted and excluded`,
    );
  }
  for (const backend of excluded) {
    if (!reasons.has(backend)) {
      throw new AttestationContractError(
        "ATTESTATION_EXCLUDED_BACKENDS",
        `excluded backend "${backend}" declares no reason`,
      );
    }
  }
  return Object.freeze(decided);
}

export const ATTESTATION_BACKEND_COVERAGE: readonly string[] = assertAttestationBackendCoverage(
  LEDGER_BACKENDS,
  ATTESTATION_STORE_BACKENDS,
  ATTESTATION_EXCLUDED_BACKENDS,
  ATTESTATION_EXCLUSION_REASONS,
);

/**
 * Registration guard: resolve `backend` to one that has a production adapter, or
 * refuse. Set/Map membership throughout, so no `Object.prototype` member name
 * ("constructor", "toString", "__proto__", …) resolves a backend or a reason.
 */
export function assertAttestationStoreBackend(backend: string): AttestationStoreBackend {
  if (typeof backend !== "string") {
    throw new AttestationBackendUnsupportedError(String(backend), "expected a ledger backend name");
  }
  if (ATTESTATION_STORE_BACKEND_SET.has(backend)) {
    return backend as AttestationStoreBackend;
  }
  const reason = ATTESTATION_EXCLUSION_REASONS.get(backend);
  if (reason !== undefined) {
    throw new AttestationBackendUnsupportedError(backend, reason);
  }
  if (backend === ATTESTATION_IN_MEMORY_BACKEND) {
    throw new AttestationBackendUnsupportedError(
      backend,
      "the in-memory store is a test double: it survives no restart and no peer process can see it",
    );
  }
  throw new AttestationBackendUnsupportedError(backend, "unknown ledger backend");
}

/**
 * Validate a namespace AND its backend's ability to hold attestations. This is
 * the one entry point an adapter constructor uses, so a `git-object`, `remote`
 * or in-memory namespace is refused BEFORE any row, capability or deadline
 * exists.
 */
export function assertAttestationStoreNamespace(
  namespace: AttestationNamespace,
  path = "namespace",
): AttestationNamespace {
  const resolved = assertAttestationNamespace(namespace, path);
  assertAttestationStoreBackend(resolved.backend);
  return resolved;
}

// ---------------------------------------------------------------------------
// Load scopes — exactly what one unit of work may see
// ---------------------------------------------------------------------------

/**
 * What a unit of work loads and is therefore allowed to look up. Anything else
 * is an {@link AttestationStorageError}, never a silent "absent".
 *
 *  - `handle` — one `{attestationId,generation}` row (confirm / abort / fetch).
 *  - `capability` — the row bound to one stored capability hash (`store_result`).
 *  - `prepare` — every row holding one idempotency key, plus the optional
 *    terminal generation being re-prepared.
 *  - `namespace` — every row in the namespace (the sweep).
 *  - `none` — nothing: the operation is refused before it reaches the store.
 */
export type AttestationLoadScope =
  | { readonly kind: "handle"; readonly handle: DispatchHandle }
  | { readonly kind: "capability"; readonly capabilityHash: string }
  | {
      readonly kind: "prepare";
      readonly idempotencyKey: string;
      readonly reprepareOf?: DispatchHandle;
    }
  | { readonly kind: "namespace" }
  | { readonly kind: "none" };

/** The scope kinds, for a caller that enumerates them. */
export const ATTESTATION_LOAD_SCOPE_KINDS = [
  "handle",
  "capability",
  "prepare",
  "namespace",
  "none",
] as const;

export type AttestationLoadScopeKind = (typeof ATTESTATION_LOAD_SCOPE_KINDS)[number];

function handleKey(handle: DispatchHandle): string {
  return `${handle.attestationId}#${handle.generation}`;
}

function scopeAdmitsHandle(scope: AttestationLoadScope, handle: DispatchHandle): boolean {
  switch (scope.kind) {
    case "namespace":
      return true;
    case "handle":
      return handleKey(scope.handle) === handleKey(handle);
    case "prepare":
      return scope.reprepareOf !== undefined && handleKey(scope.reprepareOf) === handleKey(handle);
    case "capability":
    case "none":
      return false;
  }
}

/**
 * Validate a handle WITHOUT throwing. A malformed handle must reach the SERVICE
 * (which reports it in the right order relative to the namespace and actor
 * checks), so scope building degrades to a scope the service will not consult.
 */
function optionalHandle(handle: unknown): DispatchHandle | undefined {
  try {
    return assertDispatchHandle(handle as DispatchHandle);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The journal — the writes a unit of work decided, not yet durable
// ---------------------------------------------------------------------------

/**
 * One decided write. `expectedDigest` is the {@link attestationRowDigest} of the
 * revision the service OBSERVED, which the durable apply uses as its
 * compare-and-set predicate.
 */
export type AttestationJournalEntry =
  | { readonly kind: "insert"; readonly row: AttestationEnvelope; readonly digest: string }
  | {
      readonly kind: "replace";
      readonly handle: DispatchHandle;
      readonly expectedDigest: string;
      readonly row: AttestationRow;
      readonly digest: string;
    }
  | {
      readonly kind: "remove";
      readonly handle: DispatchHandle;
      readonly expectedDigest: string;
    };

/** The handle one journal entry addresses. */
export function journalEntryHandle(entry: AttestationJournalEntry): DispatchHandle {
  return entry.kind === "insert"
    ? Object.freeze({ attestationId: entry.row.attestationId, generation: entry.row.generation })
    : entry.handle;
}

// ---------------------------------------------------------------------------
// The buffered store the service actually runs against
// ---------------------------------------------------------------------------

/**
 * A synchronous {@link AttestationStore} over ONE unit of work's preloaded rows.
 *
 * It is as strict as the T685 dummy — composite `Map` keys, real content-digest
 * compare-and-set, identity-immutable `replace`, namespace checks on every row
 * crossing the boundary, frozen `rows()` — and adds two invariants the dummy
 * has no need for:
 *
 *  - a lookup OUTSIDE the loaded scope throws instead of answering absent, so a
 *    narrow preload can never quietly change a decision;
 *  - a unit of work journals at most ONE write per handle, which is what makes
 *    the durable apply a straight-line, order-independent compare-and-set.
 */
export class BufferedAttestationStore implements AttestationStore {
  readonly namespace: AttestationNamespace;

  private readonly rowsByHandle = new Map<string, AttestationRow>();
  private readonly entries: AttestationJournalEntry[] = [];
  private readonly touched = new Set<string>();
  private readonly scope: AttestationLoadScope;

  constructor(
    namespace: AttestationNamespace,
    loaded: readonly AttestationRow[],
    scope: AttestationLoadScope,
  ) {
    this.namespace = assertAttestationNamespace(namespace);
    this.scope = scope;
    for (const row of loaded) {
      this.assertOwnNamespace(row);
      const key = handleKey(row);
      if (this.rowsByHandle.has(key)) {
        throw new AttestationStorageError(`duplicate loaded attestation "${key}"`);
      }
      this.rowsByHandle.set(key, row);
    }
  }

  /** The writes this unit of work decided, in decision order. */
  get journal(): readonly AttestationJournalEntry[] {
    return Object.freeze([...this.entries]);
  }

  insert(row: AttestationEnvelope): void {
    this.assertOwnNamespace(row);
    if (row.kind !== "envelope") {
      throw new AttestationStorageError("insert accepts a prepared envelope only");
    }
    const key = handleKey(row);
    if (this.rowsByHandle.has(key)) {
      throw new AttestationStorageError(`attestation "${key}" already exists`);
    }
    for (const existing of this.rowsByHandle.values()) {
      if (existing.idempotencyKey === row.idempotencyKey) {
        throw new AttestationStorageError(
          `idempotency key "${row.idempotencyKey}" is already held by "${handleKey(existing)}"`,
        );
      }
    }
    this.rowsByHandle.set(key, row);
    this.record(key, { kind: "insert", row, digest: attestationRowDigest(row) });
  }

  read(handle: DispatchHandle): AttestationRow | undefined {
    const resolved = assertDispatchHandle(handle);
    this.assertInScope(
      scopeAdmitsHandle(this.scope, resolved),
      `attestation "${handleKey(resolved)}"`,
    );
    return this.rowsByHandle.get(handleKey(resolved));
  }

  readByCapabilityHash(capabilityHash: string): AttestationRow | undefined {
    this.assertInScope(
      this.scope.kind === "namespace" ||
        (this.scope.kind === "capability" && this.scope.capabilityHash === capabilityHash),
      "a capability-hash lookup",
    );
    if (typeof capabilityHash !== "string" || capabilityHash === "") {
      return undefined;
    }
    for (const row of this.rowsByHandle.values()) {
      // What makes an expired envelope unresolvable by a capability is that
      // `AttestationTombstone` has NO `resultCapabilityHash` field — the
      // invariant is enforced by the field's absence, not by this branch, which
      // is here to narrow the union so the comparison typechecks. (A reviewer
      // found this branch to be an equivalent mutant; an earlier comment claimed
      // it was the guard.)
      if (!isAttestationTombstone(row) && row.resultCapabilityHash === capabilityHash) {
        return row;
      }
    }
    return undefined;
  }

  readByIdempotencyKey(idempotencyKey: string): readonly AttestationRow[] {
    this.assertInScope(
      this.scope.kind === "namespace" ||
        (this.scope.kind === "prepare" && this.scope.idempotencyKey === idempotencyKey),
      `idempotency key "${String(idempotencyKey)}"`,
    );
    const found: AttestationRow[] = [];
    for (const row of this.rowsByHandle.values()) {
      if (row.idempotencyKey === idempotencyKey) {
        found.push(row);
      }
    }
    return Object.freeze(found);
  }

  replace(expected: AttestationRow, next: AttestationRow): void {
    this.assertOwnNamespace(next);
    const key = handleKey(expected);
    if (key !== handleKey(next)) {
      throw new AttestationStorageError(
        `replace must not change a row's identity ("${key}" -> "${handleKey(next)}")`,
      );
    }
    const current = this.rowsByHandle.get(key);
    if (current === undefined) {
      throw new AttestationStorageError(`no attestation "${key}" to replace`);
    }
    const currentDigest = attestationRowDigest(current);
    if (currentDigest !== attestationRowDigest(expected)) {
      throw new AttestationStorageError(`lost update on attestation "${key}"`);
    }
    if (current.idempotencyKey !== next.idempotencyKey) {
      throw new AttestationStorageError(`replace must not change the idempotency key of "${key}"`);
    }
    this.rowsByHandle.set(key, next);
    this.record(key, {
      kind: "replace",
      handle: journalHandle(next),
      // The digest of the revision this unit of work OBSERVED, which — because
      // `record` allows at most one write per handle — is always the revision as
      // it was LOADED. (An earlier draft kept a separate map of loaded digests
      // for this; mutation M14 showed the two values can never differ, so the
      // map was redundant machinery with no reachable branch.)
      expectedDigest: currentDigest,
      row: next,
      digest: attestationRowDigest(next),
    });
  }

  remove(handle: DispatchHandle): void {
    const resolved = assertDispatchHandle(handle);
    const key = handleKey(resolved);
    const current = this.rowsByHandle.get(key);
    if (current === undefined) {
      throw new AttestationStorageError(`no attestation "${key}" to remove`);
    }
    this.rowsByHandle.delete(key);
    this.record(key, {
      kind: "remove",
      handle: resolved,
      expectedDigest: attestationRowDigest(current),
    });
  }

  rows(): readonly AttestationRow[] {
    this.assertInScope(this.scope.kind === "namespace", "a whole-namespace scan");
    return Object.freeze([...this.rowsByHandle.values()]);
  }

  private record(key: string, entry: AttestationJournalEntry): void {
    if (this.touched.has(key)) {
      throw new AttestationStorageError(
        `attestation "${key}" was written twice in one unit of work`,
      );
    }
    this.touched.add(key);
    this.entries.push(entry);
  }

  private assertInScope(admitted: boolean, what: string): void {
    if (!admitted) {
      throw new AttestationStorageError(
        `${what} is outside this unit of work's loaded ${this.scope.kind} scope`,
      );
    }
  }

  private assertOwnNamespace(row: AttestationRow): void {
    if (!attestationNamespacesEqual(this.namespace, row.namespace)) {
      throw new AttestationNamespaceError(
        `attestation "${row.attestationId}" belongs to namespace ` +
          `${formatAttestationNamespace(row.namespace)}, not ` +
          `${formatAttestationNamespace(this.namespace)}`,
      );
    }
  }
}

function journalHandle(row: AttestationRow): DispatchHandle {
  return Object.freeze({ attestationId: row.attestationId, generation: row.generation });
}

// ---------------------------------------------------------------------------
// The backend port and the shared unit-of-work runner
// ---------------------------------------------------------------------------

/**
 * A namespaced, durable attestation backend. `transact` runs ONE service
 * operation as a serialized unit of work under the backend's real cross-process
 * lock; nothing else is exposed, because nothing else may touch rows.
 */
export interface AttestationBackend {
  readonly namespace: AttestationNamespace;
  transact<T>(scope: AttestationLoadScope, body: (store: AttestationStore) => T): Promise<T>;
  close(): Promise<void>;
}

/** What a concrete backend must provide inside its own lock/transaction. */
export interface AttestationBackendIO {
  /** Load the rows `scope` admits. Absent rows are simply not returned. */
  load(scope: AttestationLoadScope): readonly AttestationRow[] | Promise<readonly AttestationRow[]>;
  /**
   * Apply the journal durably, each entry compare-and-set against its
   * `expectedDigest`. A refused entry must throw {@link AttestationStorageError}
   * so the surrounding transaction rolls back.
   */
  apply(journal: readonly AttestationJournalEntry[]): void | Promise<void>;
}

/**
 * Run one unit of work: load the scope, run the synchronous service body against
 * a {@link BufferedAttestationStore}, then apply what it journaled. The caller
 * (a concrete backend) holds the lock/transaction around this call, so the
 * loaded snapshot is still valid when the journal lands.
 */
export async function runAttestationUnitOfWork<T>(
  namespace: AttestationNamespace,
  scope: AttestationLoadScope,
  io: AttestationBackendIO,
  body: (store: AttestationStore) => T,
): Promise<T> {
  const loaded = await io.load(scope);
  const store = new BufferedAttestationStore(namespace, loaded, scope);
  const result = body(store);
  const journal = store.journal;
  if (journal.length > 0) {
    await io.apply(journal);
  }
  return result;
}

/**
 * Load exactly what `scope` admits out of a synchronous {@link AttestationStore}
 * — the shared load path for any backend whose medium IS an `AttestationStore`
 * (the in-memory reference). It goes through the port's three lookups rather
 * than filtering `rows()`, so a store whose per-lookup narrowing differs from
 * its whole-namespace scan is caught here instead of looking correct.
 */
export function loadScopeFromStore(
  store: AttestationStore,
  scope: AttestationLoadScope,
): readonly AttestationRow[] {
  switch (scope.kind) {
    case "none":
      return Object.freeze([]);
    case "namespace":
      return Object.freeze([...store.rows()]);
    case "handle": {
      const row = store.read(scope.handle);
      return Object.freeze(row === undefined ? [] : [row]);
    }
    case "capability": {
      const row = store.readByCapabilityHash(scope.capabilityHash);
      return Object.freeze(row === undefined ? [] : [row]);
    }
    case "prepare": {
      const found = new Map<string, AttestationRow>();
      for (const row of store.readByIdempotencyKey(scope.idempotencyKey)) {
        found.set(handleKey(row), row);
      }
      if (scope.reprepareOf !== undefined) {
        const row = store.read(scope.reprepareOf);
        if (row !== undefined) {
          found.set(handleKey(row), row);
        }
      }
      return Object.freeze([...found.values()]);
    }
  }
}

/**
 * Apply one journal against a synchronous {@link AttestationStore} — the shared
 * apply path for any backend whose durable medium IS an `AttestationStore`
 * (the in-memory reference). Each entry re-reads its row and checks the recorded
 * `expectedDigest` before writing, so the digest predicate is enforced here
 * exactly as the SQL adapters enforce it in their `WHERE row_digest = ?`.
 */
export function applyJournalToStore(
  store: AttestationStore,
  journal: readonly AttestationJournalEntry[],
): void {
  for (const entry of journal) {
    if (entry.kind === "insert") {
      store.insert(entry.row);
      continue;
    }
    const current = store.read(entry.handle);
    if (current === undefined) {
      throw new AttestationStorageError(
        `no attestation "${handleKey(entry.handle)}" to ${entry.kind}`,
      );
    }
    if (attestationRowDigest(current) !== entry.expectedDigest) {
      throw new AttestationStorageError(`lost update on attestation "${handleKey(entry.handle)}"`);
    }
    if (entry.kind === "replace") {
      store.replace(current, entry.row);
    } else {
      store.remove(entry.handle);
    }
  }
}

// ---------------------------------------------------------------------------
// The service operations, each as one unit of work on a backend
// ---------------------------------------------------------------------------

/** The injected clock every backend-bound operation reads. */
export interface AttestationBackendDeps {
  readonly now: DispatchNow;
}

/** Prepare additionally mints identity and capability. */
export interface AttestationBackendPrepareDeps extends AttestationBackendDeps {
  readonly randomBytes: DispatchRandomBytes;
  readonly stepOrder?: readonly string[];
}

/**
 * The scope one `prepare_dispatch` may see: the rows holding its idempotency
 * key, plus the terminal generation it re-prepares.
 */
export function prepareLoadScope(request: PrepareDispatchRequest): AttestationLoadScope {
  const key: unknown = request?.idempotencyKey;
  if (typeof key !== "string") {
    return { kind: "none" };
  }
  if (request.reprepareOf === undefined) {
    return { kind: "prepare", idempotencyKey: key };
  }
  const reprepareOf = optionalHandle(request.reprepareOf);
  return reprepareOf === undefined
    ? { kind: "prepare", idempotencyKey: key }
    : { kind: "prepare", idempotencyKey: key, reprepareOf };
}

/**
 * The scope one `store_result` may see: the single row bound to the presented
 * capability's STORED HASH. A malformed token resolves to `none`, so the service
 * raises its own authorization failure without the store being consulted — and
 * the raw token never leaves this function.
 */
export function storeResultLoadScope(submission: StoreDispatchResult): AttestationLoadScope {
  const token: unknown = submission?.resultCapability?.token;
  if (typeof token !== "string") {
    return { kind: "none" };
  }
  try {
    return { kind: "capability", capabilityHash: resultCapabilityHash(token) };
  } catch {
    return { kind: "none" };
  }
}

/**
 * The scope one handle-addressed operation (confirm / abort / fetch) may see. A
 * malformed handle resolves to `none` so the SERVICE decides the failure — see
 * the module note on not pre-empting D174's namespace-then-actor ordering.
 */
export function handleLoadScope(request: DispatchHandle): AttestationLoadScope {
  const handle = optionalHandle(request);
  return handle === undefined ? { kind: "none" } : { kind: "handle", handle };
}

/*
 * The six wrappers below are `async` on purpose, even where every statement
 * before `transact` is synchronous: a caller of a backend-bound operation must
 * be able to handle EVERY failure the same way. Were they plain functions, a
 * malformed handle or idempotency key — rejected while the SCOPE is built,
 * before any store is reached — would throw synchronously while a namespace,
 * storage or transport failure rejected, and half the callers would miss half
 * the failures.
 */

export async function prepareDispatchOn(
  backend: AttestationBackend,
  request: PrepareDispatchRequest,
  deps: AttestationBackendPrepareDeps,
): Promise<PrepareDispatchOutcome> {
  return backend.transact(prepareLoadScope(request), (store) =>
    prepareDispatch(request, {
      store,
      now: deps.now,
      randomBytes: deps.randomBytes,
      ...(deps.stepOrder === undefined ? {} : { stepOrder: deps.stepOrder }),
    }),
  );
}

export async function storeDispatchResultOn(
  backend: AttestationBackend,
  submission: StoreDispatchResult,
  deps: AttestationBackendDeps,
): Promise<StoreDispatchResultOutcome> {
  return backend.transact(storeResultLoadScope(submission), (store) =>
    storeDispatchResult(submission, { store, now: deps.now }),
  );
}

export async function resolveDispatchGitEffectBindingOn(
  backend: AttestationBackend,
  submission: StoreDispatchResult,
): Promise<AuthorizedDispatchGitEffect | undefined> {
  return backend.transact(storeResultLoadScope(submission), (store) =>
    gitEffectBindingForResultCapability(submission, { store, now: () => new Date(0).toISOString() }),
  );
}

export async function resolveDispatchGitEffectBindingForHandleOn(
  backend: AttestationBackend,
  handle: DispatchHandle,
): Promise<DispatchGitEffectBinding | undefined> {
  return backend.transact(handleLoadScope(handle), (store) =>
    gitEffectBindingForHandle(handle, { store, now: () => new Date(0).toISOString() }),
  );
}

/** One-shot child input retrieval, serialized with every other row mutation. */
export async function fetchDispatchInputOn(
  backend: AttestationBackend,
  request: FetchDispatchInputRequest,
  deps: AttestationBackendDeps,
): Promise<MaterializedDispatchInput> {
  return backend.transact(handleLoadScope(request), (store) =>
    fetchDispatchInput(request, { store, now: deps.now }),
  );
}

export async function authorizeDispatchGitEffectOn(
  backend: AttestationBackend,
  request: AuthorizeDispatchGitEffectRequest,
  deps: AttestationBackendDeps,
): Promise<AuthorizedDispatchGitEffect> {
  return backend.transact(handleLoadScope(request), (store) =>
    authorizeDispatchGitEffect(request, { store, now: deps.now }),
  );
}

export async function authorizeDispatchGitConflictOn(
  backend: AttestationBackend,
  request: AuthorizeDispatchGitConflictRequest,
  deps: AttestationBackendDeps,
): Promise<AuthorizedDispatchGitEffect> {
  return backend.transact(handleLoadScope(request), (store) =>
    authorizeDispatchGitConflict(request, { store, now: deps.now }),
  );
}

export async function confirmDispatchCompletionOn(
  backend: AttestationBackend,
  request: ConfirmDispatchCompletionRequest,
  deps: AttestationBackendDeps,
): Promise<ConfirmDispatchCompletionOutcome> {
  return backend.transact(handleLoadScope(request), (store) =>
    confirmDispatchCompletion(request, { store, now: deps.now }),
  );
}

export async function abortDispatchOn(
  backend: AttestationBackend,
  request: AbortDispatchRequest,
  deps: AttestationBackendDeps,
): Promise<AbortedDispatchResult> {
  return backend.transact(handleLoadScope(request), (store) =>
    abortDispatch(request, { store, now: deps.now }),
  );
}

/**
 * The backend-bound lookup. D174: it takes the FULL
 * {@link FetchDispatchResultRequest} — handle plus the namespace it claims plus
 * the trusted actor performing the read — because fetch is the sole
 * body-materialising surface and this wrapper must not be a way around its
 * authorization. Taking a bare handle here (as an earlier draft of this module
 * did) would have reintroduced exactly the D174 hole one layer up.
 */
export async function fetchDispatchResultOn(
  backend: AttestationBackend,
  request: FetchDispatchResultRequest,
  deps: AttestationBackendDeps,
): Promise<FetchDispatchResult> {
  return backend.transact(handleLoadScope(request), (store) =>
    fetchDispatchResult(request, { store, now: deps.now }),
  );
}

export async function sweepAttestationsOn(
  backend: AttestationBackend,
  deps: AttestationBackendDeps,
): Promise<AttestationSweepReport> {
  return backend.transact({ kind: "namespace" }, (store) =>
    sweepAttestations({ store, now: deps.now }),
  );
}

// ---------------------------------------------------------------------------
// Scheduled sweep wiring
// ---------------------------------------------------------------------------

/** A cancellable timer, injected so a test drives the schedule deterministically. */
export interface AttestationSweepTimer {
  schedule(fn: () => void, delayMs: number): void;
  cancel(): void;
}

/** The default timer: a real, unref'd single-shot `setTimeout`. */
export function defaultAttestationSweepTimer(): AttestationSweepTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(fn: () => void, delayMs: number): void {
      handle = setTimeout(fn, delayMs);
      handle.unref?.();
    },
    cancel(): void {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

export interface AttestationSweepScheduleOptions extends AttestationBackendDeps {
  /** How often to sweep. Must be a positive integer number of milliseconds. */
  readonly intervalMs: number;
  readonly timer?: AttestationSweepTimer;
  readonly onReport?: (report: AttestationSweepReport) => void;
  /**
   * Where a failed sweep goes. A sweep failure NEVER stops the schedule and is
   * never swallowed: without a handler it is rethrown, which surfaces as an
   * unhandled rejection rather than silently disabling retention.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * The scheduled sweep (T685's deferred `scheduled-sweep-wiring`). It is a
 * CONVENIENCE over {@link sweepAttestationsOn}, never a correctness dependency:
 * every retention boundary is decided at operation time by the service, so a
 * schedule that never runs changes only how much storage is retained, not what
 * any lookup answers.
 */
export class AttestationSweepScheduler {
  private readonly backend: AttestationBackend;
  private readonly options: AttestationSweepScheduleOptions;
  private readonly timer: AttestationSweepTimer;
  private running = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(backend: AttestationBackend, options: AttestationSweepScheduleOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new AttestationContractError(
        "intervalMs",
        `expected a positive integer sweep interval, got "${String(options.intervalMs)}"`,
      );
    }
    this.backend = backend;
    this.options = options;
    this.timer = options.timer ?? defaultAttestationSweepTimer();
  }

  /** Sweep once, now, outside the schedule. */
  sweepNow(): Promise<AttestationSweepReport> {
    return sweepAttestationsOn(this.backend, { now: this.options.now });
  }

  start(): this {
    if (this.running) {
      return this;
    }
    this.running = true;
    this.arm();
    return this;
  }

  stop(): this {
    this.running = false;
    this.timer.cancel();
    return this;
  }

  /** Resolves once every sweep this scheduler has started has settled. */
  settled(): Promise<void> {
    return this.inFlight;
  }

  private arm(): void {
    this.timer.schedule(() => {
      this.inFlight = this.tick();
    }, this.options.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      const report = await this.sweepNow();
      this.options.onReport?.(report);
    } catch (error) {
      if (this.options.onError === undefined) {
        throw error;
      }
      this.options.onError(error);
    } finally {
      if (this.running) {
        this.arm();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Row serialization shared by every durable adapter
// ---------------------------------------------------------------------------

/**
 * The ONE persisted shape of an attestation row: its namespace-scoped identity,
 * the three indexed lookup keys, the retention instants a sweep needs, the
 * content digest the compare-and-set quotes, and the row itself as canonical
 * JSON. There is deliberately NO second table, file or blob for the output —
 * `body` carries it, so no adapter creates a parallel output store and no
 * capability-bound result can drift from the record that authorized it.
 */
export interface PersistedAttestationRow {
  readonly backend: string;
  readonly projectKey: string;
  readonly attestationId: string;
  readonly generation: number;
  readonly kind: "envelope" | "tombstone";
  readonly idempotencyKey: string;
  /** `null` for a tombstone: an expired envelope keeps NO capability hash. */
  readonly capabilityHash: string | null;
  readonly terminalAt: string | null;
  readonly reuseAfter: string | null;
  readonly rowDigest: string;
  readonly body: string;
}

/** The single column set — and therefore the single output home — of any adapter. */
export const PERSISTED_ATTESTATION_COLUMNS = [
  "backend",
  "project_key",
  "attestation_id",
  "generation",
  "kind",
  "idempotency_key",
  "capability_hash",
  "terminal_at",
  "reuse_after",
  "row_digest",
  "body",
] as const;

/** The one table/collection name every durable adapter uses. */
export const ATTESTATION_TABLE = "dispatch_attestations" as const;

/** Project a row to its persisted shape. */
export function persistAttestationRow(row: AttestationRow): PersistedAttestationRow {
  return Object.freeze({
    backend: row.namespace.backend,
    projectKey: row.namespace.projectKey,
    attestationId: row.attestationId,
    generation: row.generation,
    kind: row.kind,
    idempotencyKey: row.idempotencyKey,
    capabilityHash: isAttestationTombstone(row) ? null : row.resultCapabilityHash,
    terminalAt: isAttestationTombstone(row) ? row.terminalAt : (row.terminalAt ?? null),
    reuseAfter: isAttestationTombstone(row) ? row.reuseAfter : null,
    rowDigest: attestationRowDigest(row),
    body: JSON.stringify(row),
  });
}

/**
 * Rehydrate a row from its persisted body, checking it against the namespace it
 * was loaded for AND against the digest recorded beside it. A body that does not
 * digest to its stored `rowDigest` is CORRUPTION, not a lifecycle state.
 */
export function rehydrateAttestationRow(
  namespace: AttestationNamespace,
  body: string,
  rowDigest: string,
): AttestationRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new AttestationStorageError(
      `stored attestation body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const row = assertStoredRowShape(parsed);
  if (!attestationNamespacesEqual(namespace, row.namespace)) {
    throw new AttestationNamespaceError(
      `stored attestation "${row.attestationId}" belongs to namespace ` +
        `${formatAttestationNamespace(row.namespace)}, not ${formatAttestationNamespace(namespace)}`,
    );
  }
  const digest = attestationRowDigest(row);
  if (digest !== rowDigest) {
    throw new AttestationStorageError(
      `stored attestation "${row.attestationId}" digests to ${digest}, not the recorded ${String(rowDigest)}`,
    );
  }
  return row;
}

const STORED_ROW_KINDS: ReadonlySet<string> = new Set(["envelope", "tombstone"]);
const STORED_SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Field names a stored body may NEVER carry as an OWN property. `JSON.parse`
 * materialises `"__proto__"` as an own, enumerable property rather than walking
 * the prototype setter, so a hostile body would survive parsing — and then a
 * downstream `{...row}` would copy it onto a fresh object where it DOES hit the
 * setter. This package has produced four prototype-pollution instances already;
 * a body read back out of storage is exactly the caller-influenceable input that
 * class arrives through, so it is refused here rather than sanitised later.
 */
const FORBIDDEN_STORED_ROW_KEYS = ["__proto__", "constructor", "prototype"] as const;

/**
 * Minimal shape check on a rehydrated row. `Object.hasOwn` / `Set` throughout:
 * the body is data the store read back, so a `kind` of `"constructor"` must fail
 * here rather than resolve an inherited value.
 */
function assertStoredRowShape(parsed: unknown): AttestationRow {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AttestationStorageError("stored attestation body is not an object");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  for (const forbidden of FORBIDDEN_STORED_ROW_KEYS) {
    if (Object.hasOwn(record, forbidden)) {
      throw new AttestationStorageError(
        `stored attestation body carries a forbidden "${forbidden}" key`,
      );
    }
  }
  for (const field of ["kind", "namespace", "attestationId", "generation", "idempotencyKey"]) {
    if (!Object.hasOwn(record, field)) {
      throw new AttestationStorageError(`stored attestation body has no "${field}"`);
    }
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !STORED_ROW_KINDS.has(kind)) {
    throw new AttestationStorageError(`stored attestation body has kind "${String(kind)}"`);
  }
  const namespace = record["namespace"];
  if (typeof namespace !== "object" || namespace === null) {
    throw new AttestationStorageError("stored attestation body has no namespace object");
  }
  assertAttestationNamespace(namespace as AttestationNamespace, "storedRow.namespace");
  if (kind === "envelope") {
    for (const field of [
      "state",
      "promptProvenance",
      "prepareRequestDigest",
      "input",
      "deadlines",
      "expectedChild",
      "inputCapabilityHash",
      "resultCapabilityHash",
      "createdAt",
    ]) {
      if (!Object.hasOwn(record, field)) {
        throw new AttestationStorageError(`stored attestation envelope has no "${field}"`);
      }
    }
    for (const field of [
      "prepareRequestDigest",
      "inputCapabilityHash",
      "resultCapabilityHash",
    ]) {
      if (typeof record[field] !== "string" || !STORED_SHA256_HEX.test(record[field])) {
        throw new AttestationStorageError(
          `stored attestation envelope has malformed "${field}"`,
        );
      }
    }
    const hasGitHash = Object.hasOwn(record, "gitChangeCapabilityHash");
    const hasGitBinding = Object.hasOwn(record, "gitEffectBinding");
    if (hasGitHash !== hasGitBinding) {
      throw new AttestationStorageError(
        "stored attestation envelope must carry both Git capability hash and effect binding",
      );
    }
    if (hasGitHash) {
      if (
        typeof record["gitChangeCapabilityHash"] !== "string" ||
        !STORED_SHA256_HEX.test(record["gitChangeCapabilityHash"])
      ) {
        throw new AttestationStorageError(
          'stored attestation envelope has malformed "gitChangeCapabilityHash"',
        );
      }
      const binding = record["gitEffectBinding"];
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
        throw new AttestationStorageError(
          'stored attestation envelope has malformed "gitEffectBinding"',
        );
      }
      const bindingRecord = binding as Readonly<Record<string, unknown>>;
      const fields = [
        "taskId",
        "handleToken",
        "handleFingerprint",
        "repositoryRoot",
        "repositoryId",
        "commonDir",
        "worktreePath",
        "branch",
        "ref",
        "baseCommit",
      ] as const;
      if (
        Object.keys(bindingRecord).sort().join(",") !== [...fields].sort().join(",") ||
        fields.some(
          (field) =>
            typeof bindingRecord[field] !== "string" || bindingRecord[field].length === 0,
        ) ||
        !STORED_SHA256_HEX.test(String(bindingRecord["handleFingerprint"])) ||
        !STORED_SHA256_HEX.test(String(bindingRecord["repositoryId"]))
      ) {
        throw new AttestationStorageError(
          'stored attestation envelope has malformed "gitEffectBinding"',
        );
      }
    }
  }
  return Object.freeze(record) as unknown as AttestationRow;
}

/** The composite storage key of one row, inside its namespace. */
export function attestationStorageKey(handle: DispatchHandle): string {
  return handleKey(assertDispatchHandle(handle));
}

// ---------------------------------------------------------------------------
// What T685 deferred here, and where each item landed
// ---------------------------------------------------------------------------

/**
 * Every entry of T685's {@link DISPATCH_ATTESTATION_DEFERRED}, mapped to the
 * concrete thing in this task that discharges it.
 *
 * This exists because "the deferral list is satisfied" is otherwise a claim
 * nobody checks — the same shape of gap as D174, where a declared scope had no
 * enforcement behind it. A test asserts this map covers the deferral list
 * exactly, so a future task cannot quietly drop an item by leaving it unmapped,
 * and cannot add one without saying where it landed.
 */
export const ATTESTATION_DEFERRAL_DISCHARGE: ReadonlyMap<string, string> = new Map([
  [
    "namespaced-production-attestation-store-adapters",
    "SqliteAttestationBackend (xdg), FsAttestationBackend (fs) and PostgresAttestationBackend, " +
      "each bound to ONE AttestationNamespace and sharing this module's unit-of-work engine",
  ],
  [
    "real-backend-durability-and-crash-recovery",
    "persistAttestationRow/rehydrateAttestationRow with a per-row content digest, fsync+rename on " +
      "the filesystem, WAL on bun:sqlite, and the shared contract's restart-at-every-step cases",
  ],
  [
    "cross-process-concurrent-key-reuse-under-a-real-lock",
    "BEGIN IMMEDIATE on a WAL connection, an O_EXCL lockfile with pid-liveness reclaim, and " +
      "pg_advisory_xact_lock — driven from spawned peer PROCESSES, not an in-process mutex",
  ],
  [
    "scheduled-sweep-wiring",
    "AttestationSweepScheduler over sweepAttestationsOn, with an injected timer, a re-arm that " +
      "survives a failed sweep, and no correctness dependency on the schedule ever running",
  ],
] as const);

/**
 * Module-load invariant: the discharge map covers T685's deferral list exactly.
 * Its value is the sorted covered items.
 */
export function assertAttestationDeferralDischarge(
  deferred: readonly string[],
  discharge: ReadonlyMap<string, string>,
): readonly string[] {
  const declared = [...deferred].sort();
  const covered = [...discharge.keys()].sort();
  if (declared.join(",") !== covered.join(",")) {
    throw new AttestationContractError(
      "ATTESTATION_DEFERRAL_DISCHARGE",
      `deferred items [${declared.join(", ")}] are not exactly the discharged items ` +
        `[${covered.join(", ")}]`,
    );
  }
  return Object.freeze(covered);
}

export const ATTESTATION_DEFERRAL_COVERAGE: readonly string[] = assertAttestationDeferralDischarge(
  DISPATCH_ATTESTATION_DEFERRED,
  ATTESTATION_DEFERRAL_DISCHARGE,
);

/**
 * A stable 64-bit advisory-lock key for one namespace, for a backend whose lock
 * primitive is an integer (PostgreSQL's `pg_advisory_xact_lock`).
 *
 * Derived from SHA-256 over `<backend>\0<projectKey>`. The top bit is cleared so
 * the value is a positive `bigint`, which is what a `bigint` lock column accepts.
 *
 * The NUL separator is NOT currently load-bearing, and an earlier draft of this
 * comment claimed it was. {@link LEDGER_BACKENDS} is prefix-free — no backend name
 * is a prefix of another — so plain concatenation is already injective over every
 * namespace that can exist, which is why mutation M20 (deleting the separator)
 * was an equivalent mutant. The honest response was to correct the claim rather
 * than invent a case to justify it. The separator STAYS because it makes
 * injectivity independent of that accident: it holds for any future backend name,
 * including one that is a prefix of another. The prefix-free property the
 * un-separated form would silently depend on is pinned by a test, so adding such
 * a backend name fails loudly instead of quietly serializing two projects on one
 * lock.
 */
export function formatAttestationNamespaceLockKey(namespace: AttestationNamespace): bigint {
  const resolved = assertAttestationNamespace(namespace);
  const digest = new Bun.CryptoHasher("sha256")
    .update(new TextEncoder().encode(`${resolved.backend}\u0000${resolved.projectKey}`))
    .digest("hex");
  return BigInt(`0x${digest.slice(0, 16)}`) & 0x7fff_ffff_ffff_ffffn;
}
