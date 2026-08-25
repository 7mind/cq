/**
 * The shared adapter contract, run against T685's STRICT in-memory dummy
 * (T720, goal G94).
 *
 * The dummy is not a production backend — {@link ATTESTATION_IN_MEMORY_BACKEND}
 * is refused at registration — but it IS the store every service-level test in
 * `dispatchAttestation.test.ts` runs against. Holding it to the SAME assertions
 * as the three durable adapters is the point: a dummy that is permissive where a
 * durable store refuses (or refuses where a durable store allows) makes every
 * service-level pass a claim about the dummy rather than about the contract.
 * This is the repo's `dual-tests` convention applied to the attestation port.
 *
 * "The same location" for an in-memory store is one namespace-keyed set of
 * stores owned by the fixture: a `peer` is a SECOND backend handle (its own
 * in-process mutex) over the SAME store, a `restart` rebuilds the store from
 * exactly what a real backend would have persisted, and a `sibling` gets its own
 * store from the same set.
 */

import { describe, expect, test } from "bun:test";
import {
  AttestationTransportError,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  formatAttestationNamespace,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStoreFault,
} from "@cq/config";
import {
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "./attestationStoreContract.js";

/**
 * One in-memory "location": a namespace-keyed set of stores plus a break flag
 * the injected fault hook consults, so `breakBackend` is a real out-of-band
 * failure of the medium rather than a closed handle.
 */
class InMemoryLocation {
  private readonly stores = new Map<string, InMemoryAttestationStore>();
  private broken = false;

  private readonly fault: AttestationStoreFault = () => {
    if (this.broken) {
      throw new AttestationTransportError("the in-memory attestation store was made unreachable");
    }
  };

  store(namespace: AttestationNamespace): InMemoryAttestationStore {
    const key = formatAttestationNamespace(namespace);
    const existing = this.stores.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = new InMemoryAttestationStore(namespace, this.fault);
    this.stores.set(key, created);
    return created;
  }

  /** A fresh handle over this namespace's CURRENT store. */
  handle(namespace: AttestationNamespace): InMemoryAttestationBackend {
    return new InMemoryAttestationBackend(this.store(namespace));
  }

  /**
   * A restart: rebuild the store from its persisted snapshot and hand back a
   * fresh handle over it, so the location and every later handle agree.
   */
  restart(namespace: AttestationNamespace): InMemoryAttestationBackend {
    const key = formatAttestationNamespace(namespace);
    const reopened = InMemoryAttestationStore.rehydrate(
      namespace,
      this.store(namespace).snapshot(),
      this.fault,
    );
    this.stores.set(key, reopened);
    return new InMemoryAttestationBackend(reopened);
  }

  rows(namespace: AttestationNamespace): readonly AttestationRow[] {
    return this.store(namespace).snapshot();
  }

  outOfBandReplace(namespace: AttestationNamespace, row: AttestationRow): void {
    new InMemoryAttestationBackend(this.store(namespace)).outOfBandReplace(row);
  }

  break(): void {
    this.broken = true;
  }
}

const NAMESPACE_BACKEND = "xdg" as const;

runAttestationStoreContract({
  name: "in-memory dummy",
  namespaceBackend: NAMESPACE_BACKEND,
  build(projectKey: string): Promise<AttestationContractFixture> {
    const location = new InMemoryLocation();
    const namespace: AttestationNamespace = { backend: NAMESPACE_BACKEND, projectKey };
    const backend = location.handle(namespace);
    return Promise.resolve({
      backend,
      peer: () => Promise.resolve(location.handle(namespace)),
      restart: () => Promise.resolve(location.restart(namespace)),
      sibling: (key: string) =>
        Promise.resolve(location.handle({ backend: NAMESPACE_BACKEND, projectKey: key })),
      rows: () => Promise.resolve(location.rows(namespace)),
      dump: () => Promise.resolve(JSON.stringify(location.rows(namespace))),
      artifacts: () => Promise.resolve(["in-memory-rows"]),
      breakBackend: () => {
        location.break();
        return Promise.resolve();
      },
      outOfBandReplaceSync(row: AttestationRow): void {
        location.outOfBandReplace(namespace, row);
      },
      dispose: () => backend.close(),
    });
  },
});

// ---------------------------------------------------------------------------
// Properties of the reference backend the shared contract cannot express
// ---------------------------------------------------------------------------

const PROBE_PROVENANCE = {
  roleId: "implement-worker",
  version: 1,
  surface: "claude",
  promptDigest: "a".repeat(64),
  catalogHash: "b".repeat(64),
  inputDigest: "c".repeat(64),
} as const;

const PROBE_DEADLINES = {
  responseStoreNow: "2026-07-27T09:09:30.000Z",
  childCancelAt: "2026-07-27T09:10:00.000Z",
  launchDeadline: "2026-07-27T09:01:00.000Z",
} as const;

describe("the in-memory reference backend is not a production adapter", () => {
  test("a closed handle refuses every unit of work explicitly", async () => {
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "closed-probe" };
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    await backend.close();
    await expect(backend.transact({ kind: "namespace" }, (store) => store.rows())).rejects.toThrow(
      AttestationTransportError,
    );
  });

  test("a failed apply rolls the whole unit of work back", async () => {
    // Two inserts the BUFFER accepts (distinct handles, distinct idempotency
    // keys) but the STORE refuses on the second, because both carry one
    // capability hash. A test double that kept the first entry would let a
    // partially applied journal pass assertions no durable adapter can satisfy.
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "rollback-probe" };
    const store = new InMemoryAttestationStore(namespace);
    const backend = new InMemoryAttestationBackend(store);
    const base = {
      kind: "envelope" as const,
      namespace,
      generation: 1,
      state: "prepared" as const,
      promptProvenance: PROBE_PROVENANCE,
      prepareRequestDigest: "3".repeat(64),
      input: { taskId: "T977" },
      overlays: [],
      deadlines: PROBE_DEADLINES,
      expectedChild: { childId: "c", runId: "r" },
      createdAt: "2026-07-27T09:00:00.000Z",
      inputCapabilityHash: "2".repeat(64),
      resultCapabilityHash: "1".repeat(64),
    };
    await expect(
      backend.transact({ kind: "prepare", idempotencyKey: "unrelated" }, (buffered) => {
        buffered.insert({ ...base, attestationId: `att_${"1".repeat(32)}`, idempotencyKey: "k1" });
        buffered.insert({ ...base, attestationId: `att_${"2".repeat(32)}`, idempotencyKey: "k2" });
      }),
    ).rejects.toThrow(/capability hash is already held/);
    expect(backend.storedRows()).toHaveLength(0);
  });

  test("the dummy refuses two live rows resolvable by ONE capability", () => {
    // The dummy's stand-in for the SQL adapters' unique capability-hash index.
    // Without it, the shared contract's "duplicate capability hash" case could
    // only run against the durable backends, and dummy/production would no
    // longer be held to identical assertions.
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "cap-guard-probe" };
    const store = new InMemoryAttestationStore(namespace);
    const base = {
      kind: "envelope" as const,
      namespace,
      generation: 1,
      state: "prepared" as const,
      promptProvenance: PROBE_PROVENANCE,
      prepareRequestDigest: "6".repeat(64),
      input: { taskId: "T977" },
      overlays: [],
      deadlines: PROBE_DEADLINES,
      expectedChild: { childId: "c", runId: "r" },
      createdAt: "2026-07-27T09:00:00.000Z",
      inputCapabilityHash: "7".repeat(64),
      resultCapabilityHash: "9".repeat(64),
    };
    store.insert({ ...base, attestationId: `att_${"a".repeat(32)}`, idempotencyKey: "ka" });
    expect(() =>
      store.insert({ ...base, attestationId: `att_${"b".repeat(32)}`, idempotencyKey: "kb" }),
    ).toThrow(/capability hash is already held/);
    // A DIFFERENT hash is accepted, so the guard is not simply refusing inserts.
    store.insert({
      ...base,
      attestationId: `att_${"b".repeat(32)}`,
      idempotencyKey: "kb",
      resultCapabilityHash: "8".repeat(64),
    });
    expect(store.snapshot()).toHaveLength(2);
  });
});
