/**
 * The shared attestation-backend engine: registration guards, load scopes, row
 * serialization, the lock key and the scheduled sweep (T720, goal G94).
 *
 * The lifecycle itself is covered by the shared adapter contract, run against
 * every backend (`attestationStore-*.test.ts`). What this file covers is the
 * parts of the engine that are NOT per-backend, and in particular the two things
 * a mutation table cannot see (T685 passed 119 mutations and still shipped D173
 * and D174):
 *
 *  - **a declaration with nothing behind it.** Every entry in
 *    {@link ATTESTATION_EXCLUDED_BACKENDS} must really THROW at registration, and
 *    every kind in {@link ATTESTATION_LOAD_SCOPE_KINDS} must really narrow what a
 *    unit of work can look up. Declaring either without enforcing it is exactly
 *    the D174 failure mode.
 *  - **an over-wide return.** {@link persistAttestationRow} is the one place a row
 *    becomes bytes, so it is where "the token is never persisted" and "a tombstone
 *    keeps no capability hash" are asserted on the serialized shape rather than on
 *    the in-memory object.
 */

import { describe, expect, test } from "bun:test";
import {
  ATTESTATION_BACKEND_COVERAGE,
  ATTESTATION_DEFERRAL_COVERAGE,
  ATTESTATION_DEFERRAL_DISCHARGE,
  ATTESTATION_EXCLUDED_BACKENDS,
  ATTESTATION_EXCLUSION_REASONS,
  DISPATCH_ATTESTATION_DEFERRED,
  DISPATCH_ATTESTATION_MCP_DEFERRED_TO,
  assertAttestationDeferralDischarge,
  ATTESTATION_IN_MEMORY_BACKEND,
  ATTESTATION_LOAD_SCOPE_KINDS,
  ATTESTATION_STORE_BACKENDS,
  ATTESTATION_TABLE,
  AttestationBackendUnsupportedError,
  AttestationContractError,
  AttestationNamespaceError,
  AttestationStorageError,
  AttestationSweepScheduler,
  AttestationTransportError,
  BufferedAttestationStore,
  IDEMPOTENCY_HORIZON_MS,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  LEDGER_BACKENDS,
  PERSISTED_ATTESTATION_COLUMNS,
  applyJournalToStore,
  assertAttestationBackendCoverage,
  assertAttestationStoreBackend,
  assertAttestationStoreNamespace,
  attestationRowDigest,
  attestationStorageKey,
  collapseAttestationEnvelope,
  formatAttestationNamespaceLockKey,
  handleLoadScope,
  journalEntryHandle,
  loadScopeFromStore,
  persistAttestationRow,
  prepareLoadScope,
  rehydrateAttestationRow,
  runAttestationUnitOfWork,
  storeResultLoadScope,
  type AttestationEnvelope,
  type AttestationJournalEntry,
  type AttestationLoadScope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationSweepReport,
  type AttestationSweepTimer,
  type PrepareDispatchRequest,
  type ResultCapability,
  type StoreDispatchResult,
} from "@cq/config";
import { PROTOTYPE_NAMES } from "./attestationStoreContract.js";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "backend-unit" };
const OTHER: AttestationNamespace = { backend: "xdg", projectKey: "somewhere-else" };
const ID_A = `att_${"a".repeat(32)}`;
const ID_B = `att_${"b".repeat(32)}`;
const CAP_A = "1".repeat(64);
const CAP_B = "2".repeat(64);

function envelope(overrides: Partial<AttestationEnvelope> = {}): AttestationEnvelope {
  return {
    kind: "envelope",
    namespace: NAMESPACE,
    attestationId: ID_A,
    generation: 1,
    idempotencyKey: "key-a",
    state: "prepared",
    promptProvenance: {
      roleId: "implement-worker",
      version: 1,
      surface: "claude",
      promptDigest: "c".repeat(64),
      catalogHash: "d".repeat(64),
      inputDigest: "e".repeat(64),
    },
    deadlines: {
      responseStoreNow: "2026-07-27T09:09:30.000Z",
      childCancelAt: "2026-07-27T09:10:00.000Z",
      launchDeadline: "2026-07-27T09:01:00.000Z",
    },
    expectedChild: { childId: "child", runId: "run" },
    resultCapabilityHash: CAP_A,
    createdAt: "2026-07-27T09:00:00.000Z",
    ...overrides,
  };
}

function buffered(
  scope: AttestationLoadScope,
  loaded: readonly AttestationRow[] = [],
): BufferedAttestationStore {
  return new BufferedAttestationStore(NAMESPACE, loaded, scope);
}

// ---------------------------------------------------------------------------
// Registration: which backends may hold attestations at all
// ---------------------------------------------------------------------------

describe("attestation backend registration", () => {
  test("every ledger backend is either adapted or excluded WITH a reason", () => {
    expect([...ATTESTATION_BACKEND_COVERAGE]).toEqual([...LEDGER_BACKENDS].sort());
    expect([...ATTESTATION_STORE_BACKENDS, ...ATTESTATION_EXCLUDED_BACKENDS].sort()).toEqual(
      [...LEDGER_BACKENDS].sort(),
    );
  });

  test("the coverage assertion refuses a divergent declaration", () => {
    // A sixth ledger backend nobody decided about.
    expect(() =>
      assertAttestationBackendCoverage(
        [...LEDGER_BACKENDS, "brand-new"],
        ATTESTATION_STORE_BACKENDS,
        ATTESTATION_EXCLUDED_BACKENDS,
        new Map([
          ["git-object", "r"],
          ["remote", "r"],
        ]),
      ),
    ).toThrow(AttestationContractError);
    // A backend claimed as BOTH adapted and excluded. (The declared list has to
    // match the decided one first, or the earlier branch fires instead.)
    expect(() =>
      assertAttestationBackendCoverage(["fs", "fs"], ["fs"], ["fs"], new Map([["fs", "r"]])),
    ).toThrow(/both adapted and excluded/);
    // An exclusion with no reason.
    expect(() =>
      assertAttestationBackendCoverage(["fs", "remote"], ["fs"], ["remote"], new Map()),
    ).toThrow(/declares no reason/);
  });

  test("EVERY declared exclusion really throws — the declaration is not decoration", () => {
    // The D174 failure mode, applied to backends: a list of excluded backends
    // that nothing checks would let a `git-object` dispatch be prepared and then
    // half-work. Each entry is driven, and its reason must reach the caller.
    for (const backend of ATTESTATION_EXCLUDED_BACKENDS) {
      const settled = ((): Error => {
        try {
          assertAttestationStoreBackend(backend);
        } catch (error) {
          return error as Error;
        }
        throw new Error(`excluded backend "${backend}" was accepted`);
      })();
      expect(settled, backend).toBeInstanceOf(AttestationBackendUnsupportedError);
      expect(settled.message, backend).toContain(backend);
      // The DECLARED reason must reach the caller. Asserting only "it throws"
      // is not enough: with the exclusion branch removed, the call still throws
      // — it just falls through to the generic "unknown ledger backend" branch,
      // and the whole exclusion table becomes decoration. (Mutation M1.)
      const reason = ATTESTATION_EXCLUSION_REASONS.get(backend);
      expect(reason, `excluded backend "${backend}" declares no reason`).toBeDefined();
      expect(settled.message, backend).toContain(reason!);
      expect(settled.message, backend).not.toContain("unknown ledger backend");
    }
    // …and every ADAPTED backend really resolves.
    for (const backend of ATTESTATION_STORE_BACKENDS) {
      expect(assertAttestationStoreBackend(backend), backend).toBe(backend);
    }
  });

  test("EVERY item T685 deferred here is mapped to what discharges it", () => {
    // "The deferral list is satisfied" is otherwise a claim nobody checks — the
    // same shape as D174, a declared scope with no enforcement behind it.
    expect([...ATTESTATION_DEFERRAL_COVERAGE]).toEqual([...DISPATCH_ATTESTATION_DEFERRED].sort());
    for (const item of DISPATCH_ATTESTATION_DEFERRED) {
      const discharge = ATTESTATION_DEFERRAL_DISCHARGE.get(item);
      expect(discharge, item).toBeDefined();
      expect(discharge!.length, item).toBeGreaterThan(40);
    }
    // An unmapped deferral, or a discharge for something nobody deferred, fails
    // at import time rather than being noticed by a reader.
    expect(() =>
      assertAttestationDeferralDischarge(["something-new"], ATTESTATION_DEFERRAL_DISCHARGE),
    ).toThrow(AttestationContractError);
    expect(() => assertAttestationDeferralDischarge([], new Map([["stray", "x"]]))).toThrow(
      AttestationContractError,
    );
    // The MCP exposure is NOT this task's, and must not be claimed as discharged.
    expect(ATTESTATION_DEFERRAL_DISCHARGE.has("mcp-exposure")).toBe(false);
    expect(DISPATCH_ATTESTATION_MCP_DEFERRED_TO).toBe("T695");
  });

  test("the in-memory store is excluded as a test double, by name", () => {
    expect(() => assertAttestationStoreBackend(ATTESTATION_IN_MEMORY_BACKEND)).toThrow(
      /test double/,
    );
  });

  test("no Object.prototype member name resolves a backend or an exclusion reason", () => {
    for (const name of PROTOTYPE_NAMES) {
      const settled = ((): Error => {
        try {
          assertAttestationStoreBackend(name);
        } catch (error) {
          return error as Error;
        }
        throw new Error(`prototype name "${name}" was accepted as a backend`);
      })();
      expect(settled, name).toBeInstanceOf(AttestationBackendUnsupportedError);
      // "unknown ledger backend" — NOT an inherited exclusion reason, and NOT
      // the in-memory branch.
      expect(settled.message, name).toContain("unknown ledger backend");
    }
  });

  test("namespace validation runs before the backend check and both must pass", () => {
    expect(assertAttestationStoreNamespace(NAMESPACE)).toEqual(NAMESPACE);
    expect(() =>
      assertAttestationStoreNamespace({ backend: "git-object", projectKey: "p" }),
    ).toThrow(AttestationBackendUnsupportedError);
    for (const name of PROTOTYPE_NAMES) {
      expect(
        () => assertAttestationStoreNamespace({ backend: name as never, projectKey: "p" }),
        name,
      ).toThrow(AttestationContractError);
    }
    // A prototype name that satisfies the project-key grammar is a perfectly
    // ordinary PROJECT key and must round-trip as one …
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"] as const) {
      expect(
        assertAttestationStoreNamespace({ backend: "fs", projectKey: name }).projectKey,
        name,
      ).toBe(name);
    }
    // … while `__proto__` is refused for an unrelated reason that happens to
    // help: the grammar requires an alphanumeric first character.
    expect(() =>
      assertAttestationStoreNamespace({ backend: "fs", projectKey: "__proto__" }),
    ).toThrow(/expected a project key/);
  });
});

// ---------------------------------------------------------------------------
// Load scopes: every declared kind really narrows
// ---------------------------------------------------------------------------

describe("load scopes narrow what one unit of work can see", () => {
  test("every declared scope kind is exercised, and each refuses what it excludes", () => {
    const row = envelope();
    const exercised = new Set<string>();

    // `none` admits nothing at all.
    exercised.add("none");
    const none = buffered({ kind: "none" });
    expect(() => none.read(row)).toThrow(AttestationStorageError);
    expect(() => none.readByCapabilityHash(CAP_A)).toThrow(AttestationStorageError);
    expect(() => none.readByIdempotencyKey("key-a")).toThrow(AttestationStorageError);
    expect(() => none.rows()).toThrow(AttestationStorageError);

    // `handle` admits exactly one handle.
    exercised.add("handle");
    const handle = buffered({ kind: "handle", handle: row }, [row]);
    expect(handle.read(row)).toEqual(row);
    expect(() => handle.read({ attestationId: ID_B, generation: 1 })).toThrow(
      AttestationStorageError,
    );
    expect(() => handle.readByCapabilityHash(CAP_A)).toThrow(AttestationStorageError);
    expect(() => handle.rows()).toThrow(AttestationStorageError);

    // `capability` admits exactly one hash.
    exercised.add("capability");
    const cap = buffered({ kind: "capability", capabilityHash: CAP_A }, [row]);
    expect(cap.readByCapabilityHash(CAP_A)).toEqual(row);
    expect(() => cap.readByCapabilityHash(CAP_B)).toThrow(AttestationStorageError);
    expect(() => cap.read(row)).toThrow(AttestationStorageError);

    // `prepare` admits exactly one key, plus its re-prepare handle.
    exercised.add("prepare");
    const prepare = buffered({ kind: "prepare", idempotencyKey: "key-a" }, [row]);
    expect(prepare.readByIdempotencyKey("key-a")).toEqual([row]);
    expect(() => prepare.readByIdempotencyKey("key-b")).toThrow(AttestationStorageError);
    expect(() => prepare.read(row)).toThrow(AttestationStorageError);
    const reprepare = buffered({ kind: "prepare", idempotencyKey: "key-a", reprepareOf: row }, [
      row,
    ]);
    expect(reprepare.read(row)).toEqual(row);

    // `namespace` admits everything.
    exercised.add("namespace");
    const all = buffered({ kind: "namespace" }, [row]);
    expect(all.rows()).toEqual([row]);
    expect(all.read(row)).toEqual(row);
    expect(all.readByCapabilityHash(CAP_A)).toEqual(row);
    expect(all.readByIdempotencyKey("key-a")).toEqual([row]);

    expect([...exercised].sort()).toEqual([...ATTESTATION_LOAD_SCOPE_KINDS].sort());
  });

  test("an out-of-scope lookup THROWS rather than answering absent", () => {
    // Answering `undefined` is the hazard: the service's own guards would look
    // satisfied while the decision quietly changed.
    const store = buffered({ kind: "handle", handle: { attestationId: ID_A, generation: 1 } }, []);
    expect(store.read({ attestationId: ID_A, generation: 1 })).toBeUndefined();
    expect(() => store.read({ attestationId: ID_A, generation: 2 })).toThrow(
      /outside this unit of work's loaded handle scope/,
    );
  });

  test("the buffer refuses a foreign row on the way in and on the way out", () => {
    expect(() => buffered({ kind: "namespace" }, [envelope({ namespace: OTHER })])).toThrow(
      AttestationNamespaceError,
    );
    const store = buffered({ kind: "namespace" }, [envelope()]);
    expect(() => store.insert(envelope({ attestationId: ID_B, namespace: OTHER }))).toThrow(
      AttestationNamespaceError,
    );
  });

  test("a unit of work may write each handle at most ONCE", () => {
    // What makes the durable apply a straight-line, order-independent
    // compare-and-set: two writes to one handle would make the journal's
    // expected digest ambiguous.
    const row = envelope();
    const store = buffered({ kind: "namespace" }, [row]);
    const next = { ...row, state: "result-stored" as const, storedAt: row.createdAt };
    store.replace(row, next);
    expect(() => store.replace(next, { ...next, consumedAt: row.createdAt })).toThrow(
      /written twice in one unit of work/,
    );
  });

  test("the buffer itself refuses a duplicate key among the rows it LOADED", () => {
    // Reached only with the service out of the way. Through `prepareDispatch`
    // this branch is unreachable: the service resolves the very same rows via
    // `readByIdempotencyKey` and refuses (or reclaims) first, so mutation M12 —
    // deleting this scan — killed nothing until this case existed. It is kept as
    // the buffer's half of the invariant every durable adapter also enforces:
    // one live idempotency key, one row, whatever decided the transition.
    const row = envelope();
    const store = buffered({ kind: "prepare", idempotencyKey: "key-a" }, [row]);
    expect(() => store.insert(envelope({ attestationId: ID_B }))).toThrow(
      /idempotency key "key-a" is already held by/,
    );
    // A free key at the same handle-free slot is accepted.
    store.insert(envelope({ attestationId: ID_B, idempotencyKey: "key-b" }));
    expect(store.journal).toHaveLength(1);
  });

  test("the buffer itself refuses a duplicate HANDLE among the rows it LOADED", () => {
    const row = envelope();
    const store = buffered({ kind: "prepare", idempotencyKey: "key-a" }, [row]);
    expect(() => store.insert(envelope({ idempotencyKey: "key-b" }))).toThrow(/already exists/);
  });

  test("the buffer accepts only a prepared ENVELOPE, never a tombstone", () => {
    // A tombstone is a SWEEP product, never an insert: only `replace` may put
    // one in place, and only over the terminal envelope it collapses.
    const store = buffered({ kind: "namespace" }, []);
    expect(() => store.insert({ ...envelope(), kind: "tombstone" } as never)).toThrow(
      /accepts a prepared envelope only/,
    );
  });

  test("replace refuses to change a row's identity or its idempotency key", () => {
    const row = envelope();
    const store = buffered({ kind: "namespace" }, [row]);
    expect(() => store.replace(row, { ...row, generation: 2 })).toThrow(
      /must not change a row's identity/,
    );
    expect(() => store.replace(row, { ...row, idempotencyKey: "other" })).toThrow(
      /must not change the idempotency key/,
    );
  });

  test("replace is a content-digest compare-and-set, not an object-identity check", () => {
    const row = envelope();
    const store = buffered({ kind: "namespace" }, [row]);
    // A structurally identical but distinct object still matches: this is what
    // makes the CAS survive a restart-equivalent rehydration.
    store.replace({ ...row }, { ...row, state: "result-stored", storedAt: row.createdAt });
    // A stale revision loses.
    const stale = envelope({ createdAt: "2020-01-01T00:00:00.000Z" });
    const other = buffered({ kind: "namespace" }, [row]);
    expect(() => other.replace(stale, { ...stale, state: "aborted" })).toThrow(/lost update/);
  });

  test("the journal quotes the LOADED revision's digest, not the buffered one", () => {
    const row = envelope();
    const store = buffered({ kind: "namespace" }, [row]);
    store.replace(row, { ...row, state: "result-stored", storedAt: row.createdAt });
    const [entry] = store.journal;
    if (entry === undefined || entry.kind !== "replace") throw new Error("expected a replace");
    expect(entry.expectedDigest).toBe(attestationRowDigest(row));
    expect(journalEntryHandle(entry)).toEqual({ attestationId: ID_A, generation: 1 });
  });

  test("journalEntryHandle names the handle of every entry kind", () => {
    const row = envelope();
    const insert: AttestationJournalEntry = {
      kind: "insert",
      row,
      digest: attestationRowDigest(row),
    };
    const remove: AttestationJournalEntry = {
      kind: "remove",
      handle: { attestationId: ID_B, generation: 7 },
      expectedDigest: CAP_A,
    };
    expect(journalEntryHandle(insert)).toEqual({ attestationId: ID_A, generation: 1 });
    expect(journalEntryHandle(remove)).toEqual({ attestationId: ID_B, generation: 7 });
  });
});

// ---------------------------------------------------------------------------
// Scope BUILDING never pre-empts the service's own failure ordering
// ---------------------------------------------------------------------------

describe("scope building degrades instead of throwing", () => {
  test("a malformed handle resolves to `none`, so the SERVICE reports it", () => {
    // D174 made fetch enforce namespace THEN actor. Were the scope builder to
    // throw on a malformed handle first, the backend-bound surface would report a
    // different failure than the in-process service for the same request, and
    // that ordering would hold only in unit tests.
    for (const attestationId of [...PROTOTYPE_NAMES, "", "not-an-id", 7, null, undefined]) {
      expect(
        handleLoadScope({ attestationId, generation: 1 } as never).kind,
        String(attestationId),
      ).toBe("none");
    }
    for (const generation of [0, -1, 1.5, "1", null, undefined]) {
      expect(
        handleLoadScope({ attestationId: ID_A, generation } as never).kind,
        String(generation),
      ).toBe("none");
    }
    expect(handleLoadScope({ attestationId: ID_A, generation: 2 })).toEqual({
      kind: "handle",
      handle: { attestationId: ID_A, generation: 2 },
    });
  });

  test("a malformed capability token resolves to `none` and never leaves the builder", () => {
    for (const token of [...PROTOTYPE_NAMES, "", "cq_result_short", 7, null, undefined]) {
      expect(
        storeResultLoadScope({ resultCapability: { scope: "store-result", token } } as never).kind,
        String(token),
      ).toBe("none");
    }
    expect(storeResultLoadScope({} as StoreDispatchResult).kind).toBe("none");
    // A well-formed token resolves to its HASH — the raw token is never carried.
    const token = `cq_result_${"A".repeat(43)}`;
    const scope = storeResultLoadScope({
      resultCapability: { scope: "store-result", token } as ResultCapability,
      output: null,
    });
    expect(scope.kind).toBe("capability");
    expect(JSON.stringify(scope)).not.toContain(token);
  });

  test("a malformed re-prepare handle drops only that part of the prepare scope", () => {
    const base = { idempotencyKey: "k" } as PrepareDispatchRequest;
    expect(prepareLoadScope(base)).toEqual({ kind: "prepare", idempotencyKey: "k" });
    expect(
      prepareLoadScope({ ...base, reprepareOf: { attestationId: "bad", generation: 1 } } as never),
    ).toEqual({ kind: "prepare", idempotencyKey: "k" });
    expect(
      prepareLoadScope({
        ...base,
        reprepareOf: { attestationId: ID_A, generation: 1 },
      } as PrepareDispatchRequest),
    ).toEqual({
      kind: "prepare",
      idempotencyKey: "k",
      reprepareOf: { attestationId: ID_A, generation: 1 },
    });
    // A non-string key resolves to `none`.
    expect(prepareLoadScope({ idempotencyKey: 7 } as never).kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Row serialization: the one place a row becomes bytes
// ---------------------------------------------------------------------------

describe("persisted row serialization", () => {
  test("a live envelope persists its capability HASH and no token", () => {
    const row = envelope();
    const persisted = persistAttestationRow(row);
    expect(Object.keys(persisted).length).toBe(PERSISTED_ATTESTATION_COLUMNS.length);
    expect(persisted.capabilityHash).toBe(CAP_A);
    expect(persisted.terminalAt).toBeNull();
    expect(persisted.reuseAfter).toBeNull();
    expect(persisted.rowDigest).toBe(attestationRowDigest(row));
    // The body is the WHOLE row and the only home for the output.
    expect(JSON.parse(persisted.body)).toEqual(row);
  });

  test("a tombstone persists NO capability hash, so no capability can resolve it", () => {
    const terminal = envelope({
      state: "aborted",
      abortedAt: "2026-07-27T09:05:00.000Z",
      abortReason: "cancelled",
      terminalAt: "2026-07-27T09:05:00.000Z",
      terminalDigest: "f".repeat(64),
    });
    const tombstone = collapseAttestationEnvelope(terminal);
    const persisted = persistAttestationRow(tombstone);
    expect(persisted.capabilityHash).toBeNull();
    expect(persisted.reuseAfter).toBe(tombstone.reuseAfter);
    expect(persisted.terminalAt).toBe(tombstone.terminalAt);
    expect(persisted.body).not.toContain(CAP_A);
  });

  test("rehydration checks the namespace AND the recorded digest", () => {
    const row = envelope();
    const persisted = persistAttestationRow(row);
    expect(rehydrateAttestationRow(NAMESPACE, persisted.body, persisted.rowDigest)).toEqual(row);
    expect(() => rehydrateAttestationRow(OTHER, persisted.body, persisted.rowDigest)).toThrow(
      AttestationNamespaceError,
    );
    expect(() => rehydrateAttestationRow(NAMESPACE, persisted.body, "0".repeat(64))).toThrow(
      /digests to/,
    );
    expect(() => rehydrateAttestationRow(NAMESPACE, "{{{", persisted.rowDigest)).toThrow(
      /not JSON/,
    );
    expect(() => rehydrateAttestationRow(NAMESPACE, "[]", persisted.rowDigest)).toThrow(
      /not an object/,
    );
    expect(() => rehydrateAttestationRow(NAMESPACE, "{}", persisted.rowDigest)).toThrow(
      /has no "kind"/,
    );
  });

  test("a stored body whose kind is an Object.prototype member is refused BY THE KIND CHECK", () => {
    for (const kind of PROTOTYPE_NAMES) {
      const parsed = {
        kind,
        namespace: NAMESPACE,
        attestationId: ID_A,
        generation: 1,
        idempotencyKey: "k",
      };
      // The digest is the CORRECT one for this body, so the digest check cannot
      // refuse it: the only thing left is the kind check. (Mutation M17 survived
      // while this passed a deliberately wrong digest — the assertion held for
      // the wrong reason, which is precisely what a generic `toThrow` hides.)
      const digest = attestationRowDigest(parsed as unknown as AttestationRow);
      expect(
        () => rehydrateAttestationRow(NAMESPACE, JSON.stringify(parsed), digest),
        kind,
      ).toThrow(/has kind "/);
    }
    // A well-formed kind with the correct digest goes through, so the check is
    // not simply refusing everything.
    const row = envelope();
    const persisted = persistAttestationRow(row);
    expect(rehydrateAttestationRow(NAMESPACE, persisted.body, persisted.rowDigest)).toEqual(row);
  });

  test("a stored body carrying a forbidden prototype key is refused, not sanitised", () => {
    for (const forbidden of ["__proto__", "constructor", "prototype"]) {
      const body = `{"kind":"envelope","namespace":{"backend":"xdg","projectKey":"backend-unit"},"attestationId":"${ID_A}","generation":1,"idempotencyKey":"k","${forbidden}":{"polluted":true}}`;
      expect(() => rehydrateAttestationRow(NAMESPACE, body, "0".repeat(64)), forbidden).toThrow(
        /forbidden "/,
      );
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("the storage key is the composite handle and rejects a malformed one", () => {
    expect(attestationStorageKey({ attestationId: ID_A, generation: 3 })).toBe(`${ID_A}#3`);
    for (const name of PROTOTYPE_NAMES) {
      expect(() => attestationStorageKey({ attestationId: name, generation: 1 }), name).toThrow(
        AttestationContractError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The advisory-lock key
// ---------------------------------------------------------------------------

describe("the namespace advisory-lock key", () => {
  test("is a positive bigint, stable, and separated so no two namespaces collide", () => {
    const key = formatAttestationNamespaceLockKey({ backend: "postgres", projectKey: "proj" });
    expect(key).toBeGreaterThan(0n);
    expect(key).toBeLessThanOrEqual(0x7fff_ffff_ffff_ffffn);
    expect(formatAttestationNamespaceLockKey({ backend: "postgres", projectKey: "proj" })).toBe(
      key,
    );
    expect(formatAttestationNamespaceLockKey({ backend: "fs", projectKey: "a-b" })).not.toBe(
      formatAttestationNamespaceLockKey({ backend: "fs", projectKey: "a" }),
    );
    expect(formatAttestationNamespaceLockKey({ backend: "fs", projectKey: "p" })).not.toBe(
      formatAttestationNamespaceLockKey({ backend: "xdg", projectKey: "p" }),
    );
  });

  test("is injective over EVERY namespace pair drawn from the adapted backends", () => {
    const keys = new Map<string, string>();
    for (const backend of ATTESTATION_STORE_BACKENDS) {
      // Project keys chosen so that a naive `backend + projectKey` would have to
      // work hard to stay injective: they start with, and repeat, other backends'
      // names and separators.
      for (const projectKey of ["p", "p-x", "px", "fs", "xdg", "postgres", "a-b", "a", "b"]) {
        const key = String(formatAttestationNamespaceLockKey({ backend, projectKey }));
        const previous = keys.get(key);
        expect(
          previous,
          `${backend}:${projectKey} collides with ${String(previous)}`,
        ).toBeUndefined();
        keys.set(key, `${backend}:${projectKey}`);
      }
    }
    expect(keys.size).toBe(ATTESTATION_STORE_BACKENDS.length * 9);
  });

  test("LEDGER_BACKENDS is prefix-free, so no backend name can absorb a project key", () => {
    // Pinned because the un-separated form of the lock key would depend on it
    // silently. With the NUL separator the lock key does not, but any OTHER
    // place that concatenates a backend and a key would — so a future backend
    // name that IS a prefix of another must fail here, loudly.
    for (const a of LEDGER_BACKENDS) {
      for (const b of LEDGER_BACKENDS) {
        if (a === b) {
          continue;
        }
        expect(b.startsWith(a), `backend "${a}" is a prefix of "${b}"`).toBe(false);
      }
    }
  });

  test("refuses a namespace it cannot validate", () => {
    expect(() =>
      formatAttestationNamespaceLockKey({ backend: "nope" as never, projectKey: "p" }),
    ).toThrow(AttestationContractError);
  });
});

// ---------------------------------------------------------------------------
// The unit-of-work runner and the store-backed apply
// ---------------------------------------------------------------------------

describe("the unit-of-work runner", () => {
  test("applies nothing when the body journaled nothing", async () => {
    let applied = 0;
    const result = await runAttestationUnitOfWork(
      NAMESPACE,
      { kind: "namespace" },
      {
        load: () => [envelope()],
        apply: () => {
          applied += 1;
        },
      },
      (store) => store.rows().length,
    );
    expect(result).toBe(1);
    expect(applied).toBe(0);
  });

  test("a throwing body never reaches apply", async () => {
    let applied = 0;
    await expect(
      runAttestationUnitOfWork(
        NAMESPACE,
        { kind: "namespace" },
        {
          load: () => [],
          apply: () => {
            applied += 1;
          },
        },
        () => {
          throw new Error("body failed");
        },
      ),
    ).rejects.toThrow("body failed");
    expect(applied).toBe(0);
  });

  test("the store-backed apply enforces the recorded digest", () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const row = envelope();
    store.insert(row);
    // A replace quoting a digest the store no longer holds is a lost update.
    expect(() =>
      applyJournalToStore(store, [
        {
          kind: "replace",
          handle: { attestationId: ID_A, generation: 1 },
          expectedDigest: "0".repeat(64),
          row: { ...row, state: "aborted" },
          digest: "1".repeat(64),
        },
      ]),
    ).toThrow(/lost update/);
    // A remove of an absent row is refused, not silently ignored.
    expect(() =>
      applyJournalToStore(store, [
        {
          kind: "remove",
          handle: { attestationId: ID_B, generation: 1 },
          expectedDigest: attestationRowDigest(row),
        },
      ]),
    ).toThrow(/to remove/);
    // The correct digest lands.
    applyJournalToStore(store, [
      {
        kind: "remove",
        handle: { attestationId: ID_A, generation: 1 },
        expectedDigest: attestationRowDigest(row),
      },
    ]);
    expect(store.snapshot()).toHaveLength(0);
  });

  test("the store-backed load goes through the port's own lookups", () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const row = envelope();
    store.insert(row);
    expect(loadScopeFromStore(store, { kind: "none" })).toEqual([]);
    expect(loadScopeFromStore(store, { kind: "namespace" })).toEqual([row]);
    expect(loadScopeFromStore(store, { kind: "handle", handle: row })).toEqual([row]);
    expect(
      loadScopeFromStore(store, { kind: "handle", handle: { attestationId: ID_B, generation: 1 } }),
    ).toEqual([]);
    expect(loadScopeFromStore(store, { kind: "capability", capabilityHash: CAP_A })).toEqual([row]);
    expect(loadScopeFromStore(store, { kind: "capability", capabilityHash: CAP_B })).toEqual([]);
    expect(loadScopeFromStore(store, { kind: "prepare", idempotencyKey: "key-a" })).toEqual([row]);
    expect(loadScopeFromStore(store, { kind: "prepare", idempotencyKey: "nope" })).toEqual([]);
    // A re-prepare handle that ALSO holds the key is returned once, not twice.
    expect(
      loadScopeFromStore(store, { kind: "prepare", idempotencyKey: "key-a", reprepareOf: row }),
    ).toEqual([row]);
  });
});

// ---------------------------------------------------------------------------
// The scheduled sweep — a convenience, never a correctness dependency
// ---------------------------------------------------------------------------

/** A timer a test fires by hand, so the schedule is fully deterministic. */
class ManualTimer implements AttestationSweepTimer {
  private pending: (() => void) | undefined;
  cancelled = 0;
  scheduled = 0;

  schedule(fn: () => void): void {
    this.scheduled += 1;
    this.pending = fn;
  }

  cancel(): void {
    this.cancelled += 1;
    this.pending = undefined;
  }

  fire(): void {
    const fn = this.pending;
    if (fn === undefined) {
      throw new Error("nothing scheduled");
    }
    this.pending = undefined;
    fn();
  }
}

describe("the scheduled sweep", () => {
  function scheduled(
    timer: ManualTimer,
    onError?: (error: unknown) => void,
  ): { readonly scheduler: AttestationSweepScheduler; readonly reports: AttestationSweepReport[] } {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE));
    const reports: AttestationSweepReport[] = [];
    const scheduler = new AttestationSweepScheduler(backend, {
      intervalMs: IDEMPOTENCY_HORIZON_MS,
      timer,
      now: () => new Date().toISOString(),
      onReport: (report) => reports.push(report),
      ...(onError === undefined ? {} : { onError }),
    });
    return { scheduler, reports };
  }

  test("refuses a non-positive or non-integer interval", () => {
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE));
    for (const intervalMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new AttestationSweepScheduler(backend, {
            intervalMs,
            now: () => new Date().toISOString(),
          }),
        String(intervalMs),
      ).toThrow(AttestationContractError);
    }
  });

  test("re-arms after each tick and stops cleanly", async () => {
    const timer = new ManualTimer();
    const { scheduler, reports } = scheduled(timer);
    scheduler.start();
    // start() is idempotent: a second call must not arm a second timer.
    scheduler.start();
    expect(timer.scheduled).toBe(1);
    timer.fire();
    await scheduler.settled();
    expect(reports).toHaveLength(1);
    expect(timer.scheduled).toBe(2);
    scheduler.stop();
    expect(timer.cancelled).toBe(1);
    // stop() really cancelled the armed timer: there is nothing left to fire, so
    // no further sweep can run.
    expect(() => timer.fire()).toThrow("nothing scheduled");
    expect(timer.scheduled).toBe(2);
  });

  test("a failed sweep goes to onError and NEVER stops the schedule", async () => {
    const timer = new ManualTimer();
    const errors: unknown[] = [];
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE));
    await backend.close();
    const scheduler = new AttestationSweepScheduler(backend, {
      intervalMs: 1_000,
      timer,
      now: () => new Date().toISOString(),
      onError: (error) => errors.push(error),
    });
    scheduler.start();
    timer.fire();
    await scheduler.settled();
    expect(errors).toHaveLength(1);
    // Still armed: retention must not be silently disabled by one failure.
    expect(timer.scheduled).toBe(2);
    scheduler.stop();
  });

  test("with no onError the ORIGINAL failure is rethrown rather than swallowed", async () => {
    const timer = new ManualTimer();
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE));
    await backend.close();
    const scheduler = new AttestationSweepScheduler(backend, {
      intervalMs: 1_000,
      timer,
      now: () => new Date().toISOString(),
    });
    scheduler.start();
    timer.fire();
    // The error class matters, not merely that something rejected: a bare
    // `rejects.toThrow()` also accepts a substituted TypeError from a broken
    // rethrow path, which is how mutation M26 first survived.
    await expect(scheduler.settled()).rejects.toThrow(AttestationTransportError);
    // Silently disabling retention is the failure mode this guards: the schedule
    // is still armed, so the next interval retries.
    expect(timer.scheduled).toBe(2);
    scheduler.stop();
  });

  test("sweepNow works with the schedule never started", async () => {
    const timer = new ManualTimer();
    const { scheduler } = scheduled(timer);
    const report = await scheduler.sweepNow();
    expect(report.rowsRemaining).toBe(0);
    expect(timer.scheduled).toBe(0);
  });

  test("the table name is one shared constant, so no adapter invents a second store", () => {
    expect(ATTESTATION_TABLE).toBe("dispatch_attestations");
  });
});
