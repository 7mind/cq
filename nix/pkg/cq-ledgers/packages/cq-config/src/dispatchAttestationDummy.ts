/**
 * The STRICT in-memory {@link AttestationStore} dummy (T685, goal G94).
 *
 * A hand-written dummy, not a generated mock: it implements the same port the
 * namespaced production adapters will (T720), and it is deliberately STRICTER
 * than a production store needs to be, so a service-logic defect fails here
 * rather than silently succeeding:
 *
 *  - no lookup is an object property read: rows live in a `Map` under a COMPOSITE
 *    `<attestationId>#<generation>` key, and the idempotency-key and
 *    capability-hash lookups scan with `===`. Neither a caller-chosen id nor a
 *    caller-chosen key can therefore resolve an `Object.prototype` member
 *    ("constructor", "__proto__", …) as a phantom row — the prototype-pollution
 *    class that has already produced three instances in this package. The
 *    composite key space alone makes a collision impossible; the `Map` is
 *    belt-and-braces on top of it;
 *  - `insert` refuses a duplicate handle AND a duplicate live idempotency key;
 *  - `replace` is a real compare-and-set over
 *    {@link attestationRowDigest}, so a lost update is an
 *    {@link AttestationStorageError} rather than a silently clobbered row —
 *    and it survives a restart-equivalent rehydration, where object identity
 *    would not;
 *  - `replace` refuses to change a row's identity (handle or namespace);
 *  - every row crossing the boundary is checked against the store's bound
 *    namespace, so a namespace confusion is an {@link AttestationNamespaceError};
 *  - `rows()` hands back a frozen copy, so no caller can mutate storage
 *    in place;
 *  - an injected {@link AttestationStoreFault} hook makes transport and storage
 *    failures reproducible, proving they stay EXPLICIT instead of degrading into
 *    a lifecycle state.
 *
 * {@link InMemoryAttestationStore.snapshot} and
 * {@link InMemoryAttestationStore.rehydrate} give the restart-equivalence test
 * its round trip: only what a real store would persist survives, which is why a
 * rehydrated store still authorizes the original capability (it holds the HASH)
 * and still answers every lookup identically.
 */

import {
  AttestationContractError,
  AttestationNamespaceError,
  AttestationStorageError,
  AttestationTransportError,
  attestationInstantMs,
  assertAttestationNamespace,
  attestationNamespacesEqual,
  attestationRowDigest,
  formatAttestationNamespace,
  isAttestationTombstone,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
} from "./dispatchAttestation.js";
import {
  applyJournalToStore,
  loadScopeFromStore,
  runAttestationUnitOfWork,
  type AttestationBackend,
  type AttestationLoadScope,
} from "./dispatchAttestationBackend.js";
import { AsyncMutex } from "./asyncMutex.js";
import type { DispatchHandle } from "./compactDispatchProtocol.js";

/** The store operations a fault hook can be triggered on. */
export const ATTESTATION_STORE_OPERATIONS = [
  "insert",
  "read",
  "readByCapabilityHash",
  "readByIdempotencyKey",
  "replace",
  "remove",
  "rows",
] as const;

export type AttestationStoreOperation = (typeof ATTESTATION_STORE_OPERATIONS)[number];

/**
 * Injected fault hook, called at the START of every store operation. Throw from
 * it to simulate a transport or storage failure; return to proceed.
 */
export type AttestationStoreFault = (operation: AttestationStoreOperation) => void;

function handleKey(handle: DispatchHandle): string {
  return `${handle.attestationId}#${handle.generation}`;
}

/**
 * The injected FAKE CLOCK the lifecycle tests drive. It only ever moves when a
 * test moves it, so every deadline, 24h envelope and 30d horizon boundary is
 * exact rather than approximate, and `reads` makes "the operation samples the
 * clock once" an observable property rather than a claim.
 */
export class FakeDispatchClock {
  private ms: number;
  private observed = 0;

  constructor(start: string) {
    this.ms = attestationInstantMs(start, "start");
  }

  /** The injected `now: () => string`, bound so it can be passed as a value. */
  readonly now = (): string => {
    this.observed += 1;
    return new Date(this.ms).toISOString();
  };

  /** The current instant WITHOUT counting a read. */
  peek(): string {
    return new Date(this.ms).toISOString();
  }

  /** Epoch ms of the current instant. */
  get epochMs(): number {
    return this.ms;
  }

  /** How many times {@link now} has been read. */
  get reads(): number {
    return this.observed;
  }

  /** Move the clock forward. Negative deltas are an authoring defect. */
  advance(deltaMs: number): this {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new AttestationContractError(
        "advance",
        `expected a non-negative delta, got "${deltaMs}"`,
      );
    }
    this.ms += deltaMs;
    return this;
  }

  /** Jump to an explicit instant. */
  set(instant: string): this {
    this.ms = attestationInstantMs(instant, "instant");
    return this;
  }
}

/**
 * A deterministic entropy source: byte `i` of draw `n` is a pure function of
 * both, so minted ids and capabilities are reproducible across a test run while
 * still being distinct per draw. NEVER a production entropy source.
 */
export function sequentialDispatchRandomBytes(seed = 0): (count: number) => Uint8Array {
  let draw = seed;
  return (count: number): Uint8Array => {
    draw += 1;
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      bytes[i] = (draw * 31 + i * 7) % 256;
    }
    return bytes;
  };
}

/** The strict in-memory attestation store. One instance, one namespace. */
export class InMemoryAttestationStore implements AttestationStore {
  readonly namespace: AttestationNamespace;

  /** Rows by `<attestationId>#<generation>`; a Map, never a plain object. */
  private readonly byHandle = new Map<string, AttestationRow>();
  /**
   * The injected fault hook. Public because a rehydration — the dummy's
   * restart-equivalent — must carry it forward: a restart that silently dropped
   * the hook would make an injected transport failure stop reproducing halfway
   * through a test, which is worse than not having the hook at all.
   */
  readonly fault: AttestationStoreFault | undefined;

  constructor(namespace: AttestationNamespace, fault?: AttestationStoreFault) {
    this.namespace = assertAttestationNamespace(namespace);
    this.fault = fault;
  }

  /**
   * Rehydrate a store from what a real backend would have persisted — the
   * restart-equivalent path. Rows are re-validated against the namespace.
   */
  static rehydrate(
    namespace: AttestationNamespace,
    rows: readonly AttestationRow[],
    fault?: AttestationStoreFault,
  ): InMemoryAttestationStore {
    const store = new InMemoryAttestationStore(namespace, fault);
    for (const row of rows) {
      store.assertOwnNamespace(row);
      const key = handleKey(row);
      if (store.byHandle.has(key)) {
        throw new AttestationStorageError(`duplicate rehydrated attestation "${key}"`);
      }
      store.byHandle.set(key, Object.freeze({ ...row }) as AttestationRow);
    }
    return store;
  }

  /** Exactly the rows a real backend would persist, in insertion order. */
  snapshot(): readonly AttestationRow[] {
    return Object.freeze([...this.byHandle.values()]);
  }

  insert(row: AttestationEnvelope): void {
    this.trip("insert");
    this.assertOwnNamespace(row);
    if (row.kind !== "envelope") {
      throw new AttestationStorageError("insert accepts a prepared envelope only");
    }
    const key = handleKey(row);
    if (this.byHandle.has(key)) {
      throw new AttestationStorageError(`attestation "${key}" already exists`);
    }
    for (const existing of this.byHandle.values()) {
      if (existing.idempotencyKey === row.idempotencyKey) {
        throw new AttestationStorageError(
          `idempotency key "${row.idempotencyKey}" is already held by "${handleKey(existing)}"`,
        );
      }
      // T720: the dummy's stand-in for the production adapters' unique
      // capability-hash index. Without it, "two live rows resolvable by ONE
      // capability" would be refused only by the durable stores, and the shared
      // adapter contract could not hold the dummy to the same assertion.
      if (
        !isAttestationTombstone(existing) &&
        existing.resultCapabilityHash === row.resultCapabilityHash
      ) {
        throw new AttestationStorageError(
          `capability hash is already held by "${handleKey(existing)}"`,
        );
      }
    }
    this.byHandle.set(key, row);
  }

  read(handle: DispatchHandle): AttestationRow | undefined {
    this.trip("read");
    return this.byHandle.get(handleKey(handle));
  }

  readByCapabilityHash(capabilityHash: string): AttestationRow | undefined {
    this.trip("readByCapabilityHash");
    if (typeof capabilityHash !== "string" || capabilityHash === "") {
      return undefined;
    }
    for (const row of this.byHandle.values()) {
      // What makes an expired envelope unresolvable by a capability is that
      // `AttestationTombstone` has NO `resultCapabilityHash` field — the
      // invariant is the field's absence, not this branch, which narrows the
      // union so the comparison typechecks. (Equivalent mutant; the earlier
      // comment claimed the branch was the guard.)
      if (!isAttestationTombstone(row) && row.resultCapabilityHash === capabilityHash) {
        return row;
      }
    }
    return undefined;
  }

  readByIdempotencyKey(idempotencyKey: string): readonly AttestationRow[] {
    this.trip("readByIdempotencyKey");
    const found: AttestationRow[] = [];
    for (const row of this.byHandle.values()) {
      if (row.idempotencyKey === idempotencyKey) {
        found.push(row);
      }
    }
    return Object.freeze(found);
  }

  replace(expected: AttestationRow, next: AttestationRow): void {
    this.trip("replace");
    this.assertOwnNamespace(next);
    const key = handleKey(expected);
    if (key !== handleKey(next)) {
      throw new AttestationStorageError(
        `replace must not change a row's identity ("${key}" -> "${handleKey(next)}")`,
      );
    }
    const current = this.byHandle.get(key);
    if (current === undefined) {
      throw new AttestationStorageError(`no attestation "${key}" to replace`);
    }
    // Compare-and-set over the row's CONTENT digest, so a concurrent writer that
    // already advanced the row loses instead of clobbering it.
    if (attestationRowDigest(current) !== attestationRowDigest(expected)) {
      throw new AttestationStorageError(`lost update on attestation "${key}"`);
    }
    if (current.idempotencyKey !== next.idempotencyKey) {
      throw new AttestationStorageError(`replace must not change the idempotency key of "${key}"`);
    }
    this.byHandle.set(key, next);
  }

  remove(handle: DispatchHandle): void {
    this.trip("remove");
    const key = handleKey(handle);
    if (!this.byHandle.delete(key)) {
      throw new AttestationStorageError(`no attestation "${key}" to remove`);
    }
  }

  rows(): readonly AttestationRow[] {
    this.trip("rows");
    return Object.freeze([...this.byHandle.values()]);
  }

  private trip(operation: AttestationStoreOperation): void {
    this.fault?.(operation);
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

// ---------------------------------------------------------------------------
// The in-memory reference BACKEND (T720)
// ---------------------------------------------------------------------------

/**
 * An {@link AttestationBackend} over one {@link InMemoryAttestationStore}, so the
 * strict dummy can be driven through the SAME shared adapter contract as the
 * three production stores (T720) rather than through a parallel set of
 * assertions. It reuses the production unit-of-work runner verbatim: the same
 * scope narrowing, the same {@link BufferedAttestationStore}, the same
 * journal-with-expected-digest apply. What it does NOT have is durability or
 * cross-process visibility, which is exactly why
 * {@link ATTESTATION_IN_MEMORY_BACKEND} is refused at registration.
 *
 * `apply` restores the pre-apply snapshot on any failure, so a partially applied
 * journal cannot leave the dummy in a state no durable adapter could reach — a
 * rolled-back transaction is the behaviour the contract asserts, and a test
 * double that quietly kept half a sweep would make that assertion vacuous.
 */
export class InMemoryAttestationBackend implements AttestationBackend {
  private readonly mutex = new AsyncMutex();
  private store: InMemoryAttestationStore;
  private closed = false;

  constructor(store: InMemoryAttestationStore) {
    this.store = store;
  }

  get namespace(): AttestationNamespace {
    return this.store.namespace;
  }

  /** The rows this backend holds, in insertion order. */
  storedRows(): readonly AttestationRow[] {
    return this.store.snapshot();
  }

  /**
   * Replace the live store with one rehydrated from what a real backend would
   * have persisted — the dummy's restart-equivalent.
   */
  rehydrate(): this {
    this.store = this.reopen(this.store.snapshot());
    return this;
  }

  /** Write one revision WITHOUT a unit of work — the out-of-band writer. */
  outOfBandReplace(row: AttestationRow): void {
    const current = this.store.read(row);
    if (current === undefined) {
      throw new AttestationStorageError(`no attestation to replace out of band`);
    }
    this.store.replace(current, row);
  }

  transact<T>(
    scope: AttestationLoadScope,
    body: (store: AttestationStore) => T | Promise<T>,
  ): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) {
        throw new AttestationTransportError("the in-memory attestation store is closed");
      }
      return runAttestationUnitOfWork(
        this.namespace,
        scope,
        {
          load: (loadScope) => loadScopeFromStore(this.store, loadScope),
          apply: (journal) => {
            const before = this.store.snapshot();
            try {
              applyJournalToStore(this.store, journal);
            } catch (error) {
              this.store = this.reopen(before);
              throw error;
            }
          },
        },
        body,
      );
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Rebuild the store over `rows`, carrying the injected fault hook forward. */
  private reopen(rows: readonly AttestationRow[]): InMemoryAttestationStore {
    return InMemoryAttestationStore.rehydrate(this.store.namespace, rows, this.store.fault);
  }
}
