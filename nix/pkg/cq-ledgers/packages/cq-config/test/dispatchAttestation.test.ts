import { describe, expect, test } from "bun:test";
import {
  ABORT_DISPATCH_SCHEMA,
  ATTESTATION_ENVELOPE_STATES,
  ATTESTATION_ID_ENTROPY_BYTES,
  ATTESTATION_STORE_OPERATIONS,
  AttestationBindingError,
  AttestationContractError,
  AttestationKeyReuseError,
  AttestationNamespaceError,
  AttestationNotFoundError,
  AttestationStorageError,
  AttestationTransportError,
  CONFIRM_DISPATCH_COMPLETION_SCHEMA,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCH_ABORT_REASONS,
  DISPATCH_ATTESTATION_DEFERRED,
  DISPATCH_ATTESTATION_DEFERRED_TO,
  DISPATCH_ATTESTATION_MCP_DEFERRED_TO,
  DISPATCH_AUTHORIZATION_SCOPES,
  DISPATCH_LIFECYCLE_STATES,
  DISPATCH_OPERATION_AUTHORIZATION,
  DISPATCH_OPERATION_AUTHORIZATION_COVERAGE,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_PREPARED_SCHEMA,
  DISPATCH_PREPARE_STEP_ORDER,
  DISPATCH_PROTOCOL_OPERATIONS,
  DISPATCH_TIMEOUT_MAX_MS,
  DISPATCH_TIMEOUT_MIN_MS,
  DispatchAuthorizationError,
  DispatchInputValidationError,
  DispatchStateConflictError,
  FETCH_DISPATCH_RESULT_SCHEMA,
  FakeDispatchClock,
  IDEMPOTENCY_HORIZON_MS,
  InMemoryAttestationStore,
  LAUNCH_DEADLINE_MS,
  RESPONSE_STORE_LEAD_MS,
  RESULT_CAPABILITY_ENTROPY_BYTES,
  RESULT_CAPABILITY_OPERATIONS,
  STORE_DISPATCH_RESULT_SCHEMA,
  TERMINAL_ENVELOPE_RETENTION_MS,
  TOMBSTONE_FORBIDDEN_FIELDS,
  TOMBSTONE_RETAINED_FIELDS,
  TRUSTED_DISPATCH_ACTORS,
  abortDispatch,
  assertAttestationNamespace,
  assertDispatchHandle,
  assertDispatchOperationAuthorization,
  assembleDispatchInput,
  attestationInstantMs,
  attestationNamespacesEqual,
  attestationRowDigest,
  collapseAttestationEnvelope,
  confirmDispatchCompletion,
  defaultDispatchRandomBytes,
  dispatchInputDigest,
  dispatchOperationScope,
  dispatchPayloadDigest,
  fetchDispatchResult,
  formatAttestationNamespace,
  invalidOutputDetailsOf,
  isAttestationTombstone,
  mintAttestationId,
  mintResultCapability,
  prepareDispatch,
  provenanceBindingOf,
  resultCapabilityAuthorizes,
  resultCapabilityHash,
  resultCapabilityMatches,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  sweepAttestations,
  validateAgainstSchema,
  type AbortDispatchRequest,
  type AttestationEnvelope,
  type AttestationNamespace,
  type AttestationRow,
  type AttestationStore,
  type AttestationStoreOperation,
  type ConfirmDispatchCompletionRequest,
  type DispatchHandle,
  type FetchDispatchResultRequest,
  type TrustedDispatchActor,
  type DispatchJSONValue,
  type DispatchNarrativeItem,
  type DispatchNarrativeSource,
  type DispatchPrepareAccepted,
  type DispatchPrepared,
  type DispatchServiceDeps,
  type NativeCompletionProof,
  type PrepareDispatchDeps,
  type PrepareDispatchRequest,
  type PrepareDispatchOutcome,
  type ResultCapability,
  type StoreDispatchResult,
} from "@cq/config";

/** Every `Object.prototype` property name that a naive membership test admits. */
const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
] as const;

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const OTHER_PROJECT: AttestationNamespace = { backend: "xdg", projectKey: "some-other-repo" };
const OTHER_BACKEND: AttestationNamespace = { backend: "postgres", projectKey: "cq-ledger-suite" };

const T0 = "2026-07-27T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const TIMEOUT_MS = 600_000;
const CHILD = { childId: "child-a26c08d1", runId: "run-0001" } as const;

const INPUT: DispatchJSONValue = {
  taskId: "T685",
  headline: "Define capability-bound result submission and the AttestationStore lifecycle",
  description: "Ledger-owned service logic over an injected store port.",
  acceptance: "The contract and strict-dummy tests prove the authorization scopes and transitions.",
  worktreePath: "/tmp/wt-T685",
  branch: "implement/T685",
  baseCommit: "0be2cc034dd490d484bdac0dfad5efb9be52c068",
};

const OUTPUT: DispatchJSONValue = {
  taskId: "T685",
  status: "pass",
  resultCommit: "0be2cc034dd490d484bdac0dfad5efb9be52c068",
  branch: "implement/T685",
  filesTouched: ["packages/cq-config/src/dispatchAttestation.ts"],
  checkSummary: "3621 pass / 142 skip / 0 fail",
  summary: "Contract, port and strict dummy landed.",
  gateDurationMs: 1,
};

const OTHER_OUTPUT: DispatchJSONValue = {
  ...(OUTPUT as object),
  status: "fail",
  blockedReason: "x",
} as DispatchJSONValue;

const COMPLETION: NativeCompletionProof = {
  kind: "native-completion",
  actor: "trusted-parent",
  childId: CHILD.childId,
  runId: CHILD.runId,
  completedAt: "2026-07-27T09:05:00.000Z",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly clock: FakeDispatchClock;
  readonly store: InMemoryAttestationStore;
  readonly deps: DispatchServiceDeps;
  readonly prepareDeps: PrepareDispatchDeps;
  readonly replaced: readonly AttestationRow[];
}

function harness(
  options: {
    readonly namespace?: AttestationNamespace;
    readonly start?: string;
    readonly fault?: (operation: AttestationStoreOperation) => void;
    readonly seed?: number;
  } = {},
): Harness {
  const clock = new FakeDispatchClock(options.start ?? T0);
  const namespace = options.namespace ?? NAMESPACE;
  const store =
    options.fault === undefined
      ? new InMemoryAttestationStore(namespace)
      : new InMemoryAttestationStore(namespace, options.fault);
  // Record every revision the service writes, so an "atomic" transition can be
  // proven never to have passed through an intermediate state.
  const replaced: AttestationRow[] = [];
  const insert = store.insert.bind(store);
  const replace = store.replace.bind(store);
  store.insert = (row: AttestationEnvelope): void => {
    insert(row);
    replaced.push(row);
  };
  store.replace = (expected: AttestationRow, next: AttestationRow): void => {
    replace(expected, next);
    replaced.push(next);
  };
  const deps: DispatchServiceDeps = { store, now: clock.now };
  return {
    clock,
    store,
    deps,
    prepareDeps: {
      store,
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(options.seed ?? 0),
    },
    replaced,
  };
}

function prepareRequest(overrides: Readonly<Record<string, unknown>> = {}): PrepareDispatchRequest {
  return {
    namespace: NAMESPACE,
    roleId: "implement-worker",
    surface: "claude",
    input: INPUT,
    idempotencyKey: "T685-round-0",
    timeoutMs: TIMEOUT_MS,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST,
    catalogHash: CATALOG_HASH,
    expectedChild: CHILD,
    ...overrides,
  } as PrepareDispatchRequest;
}

function acceptedOf(outcome: PrepareDispatchOutcome): DispatchPrepareAccepted {
  if (!outcome.accepted) {
    throw new Error(`expected a prepared dispatch, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

function rejectionOf(outcome: PrepareDispatchOutcome) {
  if (outcome.accepted) {
    throw new Error("expected a pre-launch rejection");
  }
  return outcome;
}

function prepared(h: Harness, overrides: Readonly<Record<string, unknown>> = {}): DispatchPrepared {
  return acceptedOf(prepareDispatch(prepareRequest(overrides), h.prepareDeps)).prepared;
}

function submission(
  capability: ResultCapability,
  output: DispatchJSONValue = OUTPUT,
): StoreDispatchResult {
  return { resultCapability: capability, output };
}

function confirmation(
  p: DispatchPrepared,
  overrides: Partial<ConfirmDispatchCompletionRequest> = {},
): ConfirmDispatchCompletionRequest {
  return {
    namespace: NAMESPACE,
    attestationId: p.attestationId,
    generation: p.generation,
    nativeCompletion: COMPLETION,
    expectedProvenance: provenanceBindingOf(p),
    ...overrides,
  };
}

function abortRequest(
  p: DispatchPrepared,
  overrides: Partial<AbortDispatchRequest> = {},
): AbortDispatchRequest {
  return {
    namespace: NAMESPACE,
    attestationId: p.attestationId,
    generation: p.generation,
    actor: "trusted-parent",
    reason: "cancelled",
    ...overrides,
  };
}

function handleOf(p: DispatchPrepared): DispatchHandle {
  return { attestationId: p.attestationId, generation: p.generation };
}

/**
 * D174: fetch is now a trusted-parent operation requiring namespace + actor, so
 * every read states who is asking. Default to the ordinary trusted parent.
 */
function fetchRequest(
  p: DispatchPrepared,
  overrides: { namespace?: AttestationNamespace; actor?: TrustedDispatchActor } = {},
): FetchDispatchResultRequest {
  // Object.hasOwn, not `??`: a test passing null/undefined must reach the guard
  // rather than have the default silently substituted (and this package has a
  // prototype-exposure history, so `in` is avoided too).
  return {
    ...handleOf(p),
    namespace: Object.hasOwn(overrides, "namespace")
      ? (overrides.namespace as AttestationNamespace)
      : NAMESPACE,
    actor: Object.hasOwn(overrides, "actor")
      ? (overrides.actor as TrustedDispatchActor)
      : "trusted-parent",
  };
}

function envelopeOf(h: Harness, p: DispatchPrepared): AttestationEnvelope {
  const row = h.store.rows().find((candidate) => candidate.attestationId === p.attestationId);
  if (row === undefined || isAttestationTombstone(row)) {
    throw new Error("expected a live envelope");
  }
  return row;
}

/**
 * A store with NO guards of its own: it answers every read with `row` and
 * accepts every write silently. It models a third-party adapter that does not
 * re-check anything, so the SERVICE's own guards are the only thing standing —
 * without it the strict dummy's checks mask them.
 */
class LyingStore implements AttestationStore {
  constructor(
    readonly namespace: AttestationNamespace,
    private readonly row: AttestationRow | undefined,
  ) {}

  insert(): void {}

  read(): AttestationRow | undefined {
    return this.row;
  }

  readByCapabilityHash(): AttestationRow | undefined {
    return this.row;
  }

  readByIdempotencyKey(): readonly AttestationRow[] {
    return this.row === undefined ? [] : [this.row];
  }

  replace(): void {}

  remove(): void {}

  rows(): readonly AttestationRow[] {
    return this.row === undefined ? [] : [this.row];
  }
}

/** Drive one dispatch to `result-stored`. */
function storeOne(h: Harness, p: DispatchPrepared, output: DispatchJSONValue = OUTPUT) {
  return storeDispatchResult(submission(p.resultCapability, output), h.deps);
}

// ---------------------------------------------------------------------------
// Type-level proofs (mutating any of these breaks tsc, not just a test)
// ---------------------------------------------------------------------------
type Expect<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;

/** A capability submission names no namespace, id, generation, reason or proof. */
type _StoreResultCannotName = Expect<
  IsNever<
    Extract<
      keyof StoreDispatchResult,
      "namespace" | "attestationId" | "generation" | "reason" | "nativeCompletion" | "details"
    >
  >
>;
/** A capability submission can never yield the consumed state. */
type _StoreCannotConsume = Expect<
  IsNever<Extract<ReturnType<typeof storeDispatchResult>["state"], "consumed">>
>;
/** Only a confirmation yields `consumed`. */
type _ConfirmCanConsume = Expect<
  Extract<ReturnType<typeof confirmDispatchCompletion>["state"], "consumed"> extends "consumed"
    ? true
    : false
>;
/** A tombstone carries no output, capability, proof or reason body. */
type _TombstoneCarriesNoBody = Expect<
  IsNever<
    Extract<
      keyof import("@cq/config").AttestationTombstone,
      | "output"
      | "resultCapabilityHash"
      | "nativeCompletion"
      | "abortReason"
      | "abortDetails"
      | "promptProvenance"
    >
  >
>;
/** A conflict is an Error class, never a lifecycle-bearing fetch result. */
type _ConflictIsNotAState = Expect<
  NotAssignable<DispatchStateConflictError, import("@cq/config").FetchDispatchResult>
>;

const TYPE_LEVEL_PROOFS: readonly [
  _StoreResultCannotName,
  _StoreCannotConsume,
  _ConfirmCanConsume,
  _TombstoneCarriesNoBody,
  _ConflictIsNotAState,
] = [true, true, true, true, true];

// ---------------------------------------------------------------------------

describe("distinct authorization scopes", () => {
  test("the type-level proofs hold", () => {
    expect(TYPE_LEVEL_PROOFS).toEqual([true, true, true, true, true]);
  });

  test("every ordinary-flow operation has exactly one declared scope", () => {
    expect(DISPATCH_AUTHORIZATION_SCOPES).toEqual(["result-capability", "trusted-parent"]);
    expect(DISPATCH_OPERATION_AUTHORIZATION_COVERAGE).toEqual(
      [...DISPATCH_PROTOCOL_OPERATIONS].sort(),
    );
    for (const operation of DISPATCH_PROTOCOL_OPERATIONS) {
      expect(DISPATCH_AUTHORIZATION_SCOPES, operation).toContain(dispatchOperationScope(operation));
    }
    expect(dispatchOperationScope("store_result")).toBe("result-capability");
    for (const operation of DISPATCH_PROTOCOL_OPERATIONS.filter((o) => o !== "store_result")) {
      expect(dispatchOperationScope(operation), operation).toBe("trusted-parent");
    }
  });

  test("a result capability authorizes store_result and NOTHING else", () => {
    expect(RESULT_CAPABILITY_OPERATIONS).toEqual(["store_result"]);
    expect(resultCapabilityAuthorizes("store_result")).toBe(true);
    for (const operation of [
      "confirm_dispatch_completion",
      "abort_dispatch",
      "fetch_dispatch_result",
      "prepare_dispatch",
      ...PROTOTYPE_NAMES,
      "",
    ]) {
      expect(resultCapabilityAuthorizes(operation), operation).toBe(false);
    }
  });

  test("no prototype-exposed operation name resolves a phantom scope", () => {
    for (const operation of [...PROTOTYPE_NAMES, "", "store_results"]) {
      expect(() => dispatchOperationScope(operation), operation).toThrow(AttestationContractError);
      expect(() => dispatchOperationScope(operation)).toThrow(
        `operation: unknown dispatch operation "${operation}"`,
      );
      expect(DISPATCH_OPERATION_AUTHORIZATION.get(operation as never)).toBeUndefined();
    }
  });

  test("only a trusted actor may claim a completion or abort", () => {
    expect(TRUSTED_DISPATCH_ACTORS).toEqual(["trusted-parent", "trusted-extension"]);
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    for (const actor of [...PROTOTYPE_NAMES, "child", "", undefined, 7]) {
      expect(
        () =>
          confirmDispatchCompletion(
            confirmation(p, { nativeCompletion: { ...COMPLETION, actor: actor as never } }),
            h.deps,
          ),
        String(actor),
      ).toThrow(DispatchAuthorizationError);
      expect(
        () => abortDispatch(abortRequest(p, { actor: actor as never }), h.deps),
        String(actor),
      ).toThrow(DispatchAuthorizationError);
    }
    // Both declared actors are accepted.
    for (const actor of TRUSTED_DISPATCH_ACTORS) {
      const fresh = harness();
      const q = prepared(fresh);
      storeOne(fresh, q);
      const outcome = confirmDispatchCompletion(
        confirmation(q, { nativeCompletion: { ...COMPLETION, actor } }),
        fresh.deps,
      );
      expect(outcome.state, actor).toBe("consumed");
    }
  });

  test("a non-native or malformed completion proof is refused", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    for (const proof of [
      { ...COMPLETION, kind: "self-report" },
      { ...COMPLETION, kind: "constructor" },
      undefined,
      null,
      "native-completion",
    ]) {
      expect(
        () =>
          confirmDispatchCompletion(confirmation(p, { nativeCompletion: proof as never }), h.deps),
        JSON.stringify(proof),
      ).toThrow(DispatchAuthorizationError);
    }
    for (const completedAt of ["", "yesterday", 7]) {
      expect(() =>
        confirmDispatchCompletion(
          confirmation(p, {
            nativeCompletion: { ...COMPLETION, completedAt: completedAt as never },
          }),
          h.deps,
        ),
      ).toThrow(AttestationContractError);
    }
  });
});

describe("prepare validates role, input and timeout, then allocates", () => {
  test("a prepared dispatch matches T682's wire shape exactly", () => {
    const h = harness();
    const accepted = acceptedOf(prepareDispatch(prepareRequest(), h.prepareDeps));
    expect(validateAgainstSchema(DISPATCH_PREPARED_SCHEMA, accepted.prepared).ok).toBe(true);
    expect(accepted.prepared.promptProvenance).toEqual({
      roleId: "implement-worker",
      version: DISPATCHED_ROLE_SIDECARS["implement-worker"].version,
      surface: "claude",
      promptDigest: PROMPT_DIGEST,
      catalogHash: CATALOG_HASH,
      inputDigest: dispatchPayloadDigest(INPUT),
    });
    expect(accepted.handle).toEqual({
      attestationId: accepted.prepared.attestationId,
      generation: 1,
    });
    expect(h.store.rows()).toHaveLength(1);
  });

  test("the input digest binds exactly what T978's assembly produced", () => {
    const task: DispatchNarrativeItem = {
      id: "T685",
      status: "wip",
      fields: {
        headline: "Define capability-bound result submission and the AttestationStore lifecycle",
        description: "Ledger-owned service logic over an injected store port.",
        acceptance:
          "The contract and strict-dummy tests prove the authorization scopes and transitions.",
      },
    };
    const source: DispatchNarrativeSource = {
      projectKey: NAMESPACE.projectKey,
      readItem: (ledger, id) => (ledger === "tasks" && id === "T685" ? task : undefined),
    };
    const assembly = assembleDispatchInput(
      {
        roleId: "implement-worker",
        surface: "claude",
        projectKey: NAMESPACE.projectKey,
        taskId: "T685",
        coordinates: {
          worktreePath: "/tmp/wt-T685",
          branch: "implement/T685",
          baseCommit: "0be2cc034dd490d484bdac0dfad5efb9be52c068",
        },
      },
      { source, registry: DISPATCH_OVERLAY_REGISTRY },
    );
    if (!assembly.accepted) {
      throw new Error(`expected an assembly, got ${assembly.reason}`);
    }
    const h = harness();
    const p = prepared(h, { input: assembly.input });
    expect(p.promptProvenance.inputDigest).toBe(assembly.inputDigest);
    expect(p.promptProvenance.inputDigest).toBe(dispatchInputDigest(assembly.input));
    // A single differing narrative byte gives a different bound digest.
    const tampered = { ...(assembly.input as object), acceptance: "something else" };
    expect(dispatchPayloadDigest(tampered as DispatchJSONValue)).not.toBe(assembly.inputDigest);
  });

  test("the authoritative deadlines are derived from the injected clock", () => {
    const h = harness();
    const p = prepared(h);
    expect(p.childCancelAt).toBe(new Date(T0_MS + TIMEOUT_MS).toISOString());
    expect(p.responseStoreNow).toBe(
      new Date(T0_MS + TIMEOUT_MS - RESPONSE_STORE_LEAD_MS).toISOString(),
    );
    expect(p.launchDeadline).toBe(new Date(T0_MS + LAUNCH_DEADLINE_MS).toISOString());
    expect(attestationInstantMs(p.responseStoreNow, "x")).toBeLessThan(
      attestationInstantMs(p.childCancelAt, "x"),
    );
    expect(attestationInstantMs(p.responseStoreNow, "x")).toBeGreaterThan(T0_MS);
    // The caller cannot supply them: a later clock yields later deadlines.
    const later = harness({ start: "2026-07-27T10:00:00.000Z" });
    expect(prepared(later).childCancelAt).not.toBe(p.childCancelAt);
    expect(RESPONSE_STORE_LEAD_MS).toBeLessThan(DISPATCH_TIMEOUT_MIN_MS);
  });

  test("prepare flows THROUGH T976's inside-prepare validation and allocates nothing on failure", () => {
    const h = harness();
    for (const [overrides, reason] of [
      [{ roleId: "advance" }, "unknown-role"],
      [{ roleId: "constructor" }, "unknown-role"],
      [{ surface: "terminal" }, "unsupported-surface"],
      [{ input: { taskId: "T685" } }, "invalid-role-input"],
      [{ overlays: [{ overlayId: "nope", data: {} }] }, "invalid-overlay-data"],
    ] as const) {
      const rejection = rejectionOf(prepareDispatch(prepareRequest(overrides), h.prepareDeps));
      expect(rejection.reason, JSON.stringify(overrides)).toBe(reason);
      expect(rejection.allocated).toBe(false);
      expect(Object.hasOwn(rejection, "resultCapability")).toBe(false);
    }
    expect(h.store.rows()).toHaveLength(0);
  });

  test("an invalid launch envelope is a typed pre-launch rejection, not a state", () => {
    const h = harness();
    for (const timeoutMs of [
      0,
      -1,
      1.5,
      "600000",
      DISPATCH_TIMEOUT_MIN_MS - 1,
      DISPATCH_TIMEOUT_MAX_MS + 1,
      Number.NaN,
    ]) {
      const rejection = rejectionOf(prepareDispatch(prepareRequest({ timeoutMs }), h.prepareDeps));
      expect(rejection.reason, String(timeoutMs)).toBe("invalid-launch-envelope");
      expect(rejection.path).toBe("timeoutMs");
    }
    for (const idempotencyKey of ["", "   ", "x".repeat(257), 7, undefined]) {
      const rejection = rejectionOf(
        prepareDispatch(prepareRequest({ idempotencyKey }), h.prepareDeps),
      );
      expect(rejection.reason, String(idempotencyKey)).toBe("invalid-launch-envelope");
      expect(rejection.path).toBe("idempotencyKey");
    }
    // The exact boundaries are accepted.
    for (const timeoutMs of [DISPATCH_TIMEOUT_MIN_MS, DISPATCH_TIMEOUT_MAX_MS]) {
      const fresh = harness();
      expect(prepareDispatch(prepareRequest({ timeoutMs }), fresh.prepareDeps).accepted).toBe(true);
    }
    expect(h.store.rows()).toHaveLength(0);
    // And it is never a lifecycle state.
    const rejection = rejectionOf(prepareDispatch(prepareRequest({ timeoutMs: 0 }), h.prepareDeps));
    expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, rejection).ok).toBe(false);
    expect(DISPATCH_LIFECYCLE_STATES).not.toContain(rejection.outcome as never);
  });

  test("prepare honours validate-then-allocate and records the order it executed", () => {
    const h = harness();
    const accepted = acceptedOf(prepareDispatch(prepareRequest(), h.prepareDeps));
    expect(accepted.executedStepOrder).toEqual([...DISPATCH_PREPARE_STEP_ORDER]);
    // A scrambled order fails through T976's assertion, and allocates no row.
    const scrambled = harness();
    expect(() =>
      prepareDispatch(prepareRequest(), {
        ...scrambled.prepareDeps,
        stepOrder: [
          "allocate-attestation",
          "resolve-role-contract",
          "validate-role-input",
          "validate-declared-overlay-data",
          "mint-result-capability",
        ],
      }),
    ).toThrow(DispatchInputValidationError);
    expect(scrambled.store.rows()).toHaveLength(0);
  });

  test("a malformed digest, child identity or namespace is an explicit contract error", () => {
    const h = harness();
    for (const promptDigest of ["", "zz", "A".repeat(64), 7]) {
      expect(() => prepareDispatch(prepareRequest({ promptDigest }), h.prepareDeps)).toThrow(
        AttestationContractError,
      );
    }
    expect(() => prepareDispatch(prepareRequest({ catalogHash: "nope" }), h.prepareDeps)).toThrow(
      "catalogHash:",
    );
    for (const expectedChild of [{ childId: "", runId: "r" }, { childId: "c", runId: "  " }, {}]) {
      expect(() => prepareDispatch(prepareRequest({ expectedChild }), h.prepareDeps)).toThrow(
        AttestationContractError,
      );
    }
    for (const backend of [...PROTOTYPE_NAMES, "sqlite3", ""]) {
      expect(
        () =>
          prepareDispatch(
            prepareRequest({ namespace: { backend, projectKey: "p" } }),
            h.prepareDeps,
          ),
        backend,
      ).toThrow(`namespace.backend: unknown ledger backend "${backend}"`);
    }
    for (const projectKey of ["", "-leading", "x".repeat(129)]) {
      expect(() =>
        prepareDispatch(
          prepareRequest({ namespace: { backend: "xdg", projectKey } }),
          h.prepareDeps,
        ),
      ).toThrow("namespace.projectKey:");
    }
    expect(h.store.rows()).toHaveLength(0);
  });

  test("a minted capability is high-entropy, scoped, and stored ONLY as a hash", () => {
    expect(RESULT_CAPABILITY_ENTROPY_BYTES).toBe(32);
    expect(ATTESTATION_ID_ENTROPY_BYTES).toBe(24);
    const h = harness();
    const p = prepared(h);
    expect(p.resultCapability.scope).toBe("store-result");
    expect(p.resultCapability.token).toMatch(/^cq_result_[A-Za-z0-9_-]{43,}$/);
    expect(p.attestationId).toMatch(/^att_[A-Za-z0-9_-]{32,}$/);

    const row = envelopeOf(h, p);
    expect(row.resultCapabilityHash).toBe(resultCapabilityHash(p.resultCapability.token));
    expect(row.resultCapabilityHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token is NOWHERE in what the store persists.
    expect(JSON.stringify(h.store.snapshot())).not.toContain(p.resultCapability.token);
    // Nor in any lifecycle answer.
    expect(JSON.stringify(fetchDispatchResult(fetchRequest(p), h.deps))).not.toContain(
      p.resultCapability.token,
    );
    storeOne(h, p);
    const consumed = confirmDispatchCompletion(confirmation(p), h.deps);
    expect(JSON.stringify(consumed)).not.toContain(p.resultCapability.token);
    expect(JSON.stringify(fetchDispatchResult(fetchRequest(p), h.deps))).not.toContain(
      p.resultCapability.token,
    );
    expect(JSON.stringify(h.store.snapshot())).not.toContain(p.resultCapability.token);
  });

  test("the minters refuse a low-entropy or malformed source", () => {
    const short = (): Uint8Array => new Uint8Array(4);
    expect(() => mintAttestationId(short)).toThrow(
      `attestationId: expected ${ATTESTATION_ID_ENTROPY_BYTES} bytes of entropy`,
    );
    expect(() => mintResultCapability(short)).toThrow(
      `resultCapability.token: expected ${RESULT_CAPABILITY_ENTROPY_BYTES} bytes of entropy`,
    );
    expect(() => mintResultCapability(() => "nope" as never)).toThrow(AttestationContractError);
    // The production source yields distinct, well-formed values.
    const first = mintResultCapability(defaultDispatchRandomBytes);
    const second = mintResultCapability(defaultDispatchRandomBytes);
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^cq_result_[A-Za-z0-9_-]{43,}$/);
    expect(mintAttestationId(defaultDispatchRandomBytes)).not.toBe(
      mintAttestationId(defaultDispatchRandomBytes),
    );
  });

  test("capability comparison is hash-based and refuses malformed inputs", () => {
    const capability = mintResultCapability(sequentialDispatchRandomBytes(7));
    const hash = resultCapabilityHash(capability.token);
    expect(resultCapabilityMatches(capability.token, hash)).toBe(true);
    expect(
      resultCapabilityMatches(mintResultCapability(sequentialDispatchRandomBytes(9)).token, hash),
    ).toBe(false);
    for (const token of [
      "",
      "cq_result_short",
      `${capability.token}x`.slice(0, 5),
      ...PROTOTYPE_NAMES,
    ]) {
      expect(resultCapabilityMatches(token, hash), token).toBe(false);
    }
    for (const stored of ["", "nope", "A".repeat(64), hash.slice(0, 63)]) {
      expect(resultCapabilityMatches(capability.token, stored), stored).toBe(false);
    }
    expect(() => resultCapabilityHash("nope")).toThrow(AttestationContractError);
  });
});

describe("prepared -> result-stored -> consumed", () => {
  test("the happy path walks exactly those three states", () => {
    const h = harness();
    const p = prepared(h);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("prepared");

    h.clock.advance(60_000);
    const stored = storeOne(h, p);
    expect(stored.state).toBe("result-stored");
    if (stored.state !== "result-stored") throw new Error("unreachable");
    expect(stored.result.storedAt).toBe(new Date(T0_MS + 60_000).toISOString());
    expect(stored.result.outputDigest).toBe(dispatchPayloadDigest(OUTPUT));
    const afterStore = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(afterStore.state).toBe("result-stored");
    // A stored result is NOT yet readable as output.
    expect(Object.hasOwn(afterStore, "output")).toBe(false);

    h.clock.advance(30_000);
    const consumed = confirmDispatchCompletion(confirmation(p), h.deps);
    expect(consumed.state).toBe("consumed");
    if (consumed.state !== "consumed") throw new Error("unreachable");
    // D173: confirm's ack is HANDLE-ONLY — it must not carry the body, because
    // confirm runs on EVERY dispatch and a second body-returning parent surface
    // defeats ref-first. The digest binds the promotion to the payload.
    expect(Object.hasOwn(consumed.result, "output")).toBe(false);
    expect(Object.hasOwn(consumed.result, "nativeCompletion")).toBe(false);
    expect(Object.hasOwn(consumed.result, "promptProvenance")).toBe(false);
    expect(consumed.result.outputDigest).toBe(dispatchPayloadDigest(OUTPUT));
    // The body appears exactly once, on fetch — the SOLE body-returning surface.
    const consumedRead = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(consumedRead.state).toBe("consumed");
    if (consumedRead.state !== "consumed") throw new Error("unreachable");
    expect(consumedRead.output).toEqual(OUTPUT);
    expect(consumedRead.nativeCompletion).toEqual(COMPLETION);
    expect(consumedRead.promptProvenance).toEqual(p.promptProvenance);
    expect(h.store.rows()).toHaveLength(1);
  });

  test("storing a result cannot consume, and the child never names the record", () => {
    const h = harness();
    const p = prepared(h);
    const stored = storeOne(h, p);
    // The whole submission is `{resultCapability, output}` — nothing else.
    const wire = submission(p.resultCapability);
    expect(Object.keys(wire).sort()).toEqual(["output", "resultCapability"]);
    expect(validateAgainstSchema(STORE_DISPATCH_RESULT_SCHEMA, wire).ok).toBe(true);
    for (const extra of [
      "attestationId",
      "generation",
      "namespace",
      "reason",
      "nativeCompletion",
    ]) {
      expect(
        validateAgainstSchema(STORE_DISPATCH_RESULT_SCHEMA, { ...wire, [extra]: "x" }).ok,
        extra,
      ).toBe(false);
    }
    // …and the acknowledgement it gets back is not a consumable result.
    expect(stored.state).toBe("result-stored");
    expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, stored.result).ok).toBe(false);
    // Only the separately authorized confirmation promotes it.
    expect(confirmDispatchCompletion(confirmation(p), h.deps).state).toBe("consumed");
  });

  test("the output schema is resolved INTERNALLY from the prepared role contract", () => {
    const h = harness();
    const p = prepared(h);
    // A payload valid for ANOTHER role's output contract is still invalid here.
    const reviewerOutput = { verdict: "go-ahead", criticism: [], questions: [], defects: [] };
    expect(
      validateAgainstSchema(
        DISPATCHED_ROLE_SIDECARS["implement-worker"].outputSchema,
        reviewerOutput,
      ).ok,
    ).toBe(false);
    const outcome = storeOne(h, p, reviewerOutput as DispatchJSONValue);
    expect(outcome.state).toBe("aborted");
    if (outcome.state !== "aborted") throw new Error("unreachable");
    expect(invalidOutputDetailsOf(outcome.result)?.roleId).toBe("implement-worker");
    expect(invalidOutputDetailsOf(outcome.result)?.version).toBe(
      DISPATCHED_ROLE_SIDECARS["implement-worker"].version,
    );
  });
});

describe("abort wins, from every non-terminal state", () => {
  test("abort from prepared, with the full failure body echoed", () => {
    const h = harness();
    const p = prepared(h);
    const body: DispatchJSONValue = {
      exitCode: 137,
      stderr: "harness killed the child",
      transcript: ["line one", "line two"],
    };
    h.clock.advance(1000);
    const aborted = abortDispatch(
      abortRequest(p, { reason: "native-failure", details: body }),
      h.deps,
    );
    expect(aborted.state).toBe("aborted");
    expect(aborted.reason).toBe("native-failure");
    expect(aborted.details).toEqual(body);
    const fetched = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(fetched).toEqual(aborted);
    expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, fetched).ok).toBe(true);
  });

  test("abort from result-stored leaves NO consumable output (cancellation after store)", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const aborted = abortDispatch(abortRequest(p, { reason: "cancelled" }), h.deps);
    expect(aborted.reason).toBe("cancelled");
    const fetched = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(fetched.state).toBe("aborted");
    expect(Object.hasOwn(fetched, "output")).toBe(false);
    // And the stored result can never be promoted afterwards — abort wins.
    expect(() => confirmDispatchCompletion(confirmation(p), h.deps)).toThrow(
      DispatchStateConflictError,
    );
    expect(() => confirmDispatchCompletion(confirmation(p), h.deps)).toThrow(
      "is aborted (cancelled) and cannot be consumed",
    );
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("aborted");
  });

  test("every declared abort reason is accepted, and nothing else is", () => {
    for (const reason of DISPATCH_ABORT_REASONS) {
      const h = harness();
      const p = prepared(h);
      expect(abortDispatch(abortRequest(p, { reason }), h.deps).reason, reason).toBe(reason);
    }
    const h = harness();
    const p = prepared(h);
    for (const reason of [...PROTOTYPE_NAMES, "", "nope", 7, undefined]) {
      expect(
        () => abortDispatch(abortRequest(p, { reason: reason as never }), h.deps),
        String(reason),
      ).toThrow(`reason: unknown abort reason "${String(reason)}"`);
    }
    expect(
      validateAgainstSchema(ABORT_DISPATCH_SCHEMA, { ...handleOf(p), reason: "cancelled" }).ok,
    ).toBe(true);
  });

  test("parent loss aborts a live dispatch from either state", () => {
    for (const stage of ["prepared", "result-stored"] as const) {
      const h = harness();
      const p = prepared(h);
      if (stage === "result-stored") {
        storeOne(h, p);
      }
      const aborted = abortDispatch(
        abortRequest(p, { reason: "parent-lost", details: { lastSeen: T0 } }),
        h.deps,
      );
      expect(aborted.reason, stage).toBe("parent-lost");
      expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("aborted");
    }
  });

  test("invalid output aborts ATOMICALLY — the record never becomes result-stored", () => {
    const h = harness();
    const p = prepared(h);
    const outcome = storeOne(h, p, { taskId: "T685", status: "maybe" } as DispatchJSONValue);
    expect(outcome.state).toBe("aborted");
    if (outcome.state !== "aborted") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("invalid-output");
    const details = invalidOutputDetailsOf(outcome.result);
    expect(details?.errors.length).toBeGreaterThan(0);
    expect(details?.errors.every((error) => typeof error.message === "string")).toBe(true);
    // The one-line summary renders exactly the structured errors.
    expect(details?.summary).toBe(
      details?.errors
        .map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`)
        .join("; "),
    );
    expect(details?.summary.length).toBeGreaterThan(0);
    // No revision the store ever held was `result-stored`.
    expect(
      h.replaced.map((row) => (isAttestationTombstone(row) ? "tombstone" : row.state)),
    ).toEqual(["prepared", "aborted"]);
    const fetched = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(fetched.state).toBe("aborted");
    expect(Object.hasOwn(fetched, "output")).toBe(false);
    expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, fetched).ok).toBe(true);
  });

  test("a native completion with no stored result aborts missing-result", () => {
    const h = harness();
    const p = prepared(h);
    const outcome = confirmDispatchCompletion(confirmation(p), h.deps);
    expect(outcome.state).toBe("aborted");
    if (outcome.state !== "aborted") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("missing-result");
    expect(outcome.result.details).toEqual({
      completedAt: COMPLETION.completedAt,
      childId: CHILD.childId,
      runId: CHILD.runId,
    });
    // It is terminal: a later store cannot resurrect it.
    expect(() => storeOne(h, p)).toThrow(DispatchStateConflictError);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("aborted");
  });

  test("a submission arriving past the authoritative deadline aborts", () => {
    const h = harness();
    const p = prepared(h);
    h.clock.set(p.childCancelAt);
    // Exactly AT childCancelAt is still in time.
    const onTime = storeOne(h, p);
    expect(onTime.state).toBe("result-stored");

    const late = harness();
    const q = prepared(late);
    late.clock.set(q.childCancelAt).advance(1);
    const outcome = storeOne(late, q);
    expect(outcome.state).toBe("aborted");
    if (outcome.state !== "aborted") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("deadline-exceeded");
    expect(outcome.result.details).toEqual({
      childCancelAt: q.childCancelAt,
      submittedAt: late.clock.peek(),
    });
    // A deadline abort's body is NOT validation details — reading it as such
    // would misreport a late submission as a contract violation.
    expect(invalidOutputDetailsOf(outcome.result)).toBeUndefined();
  });

  test("a validation that CROSSES the deadline is decided by the entry instant", () => {
    // A clock that leaps a full day on every read: if the deadline were sampled
    // again after output validation, an on-time submission would abort.
    const clock = new FakeDispatchClock(T0);
    const store = new InMemoryAttestationStore(NAMESPACE);
    const leaping = (): string => {
      const at = clock.peek();
      clock.advance(24 * 60 * 60 * 1000);
      return at;
    };
    const p = acceptedOf(
      prepareDispatch(prepareRequest(), {
        store,
        now: leaping,
        randomBytes: sequentialDispatchRandomBytes(3),
      }),
    ).prepared;
    const deps: DispatchServiceDeps = { store, now: leaping };
    const entry = clock.peek();
    expect(attestationInstantMs(entry, "x")).toBeGreaterThan(
      attestationInstantMs(p.childCancelAt, "x"),
    );
    // The record was prepared at T0 with a 10-minute window; the SECOND read is
    // already a day late, so only a single entry-time sample can keep this in
    // time — and it does not, because the entry sample itself is late here.
    const late = storeDispatchResult(submission(p.resultCapability), deps);
    expect(late.state).toBe("aborted");

    // The symmetric case: entry in time, validation crossing the deadline.
    const h = harness();
    const q = prepared(h);
    h.clock.set(q.childCancelAt);
    const before = h.clock.reads;
    const outcome = storeOne(h, q);
    // Exactly ONE clock read per operation is what makes the outcome stable.
    expect(h.clock.reads - before).toBe(1);
    expect(outcome.state).toBe("result-stored");
    // And a later fetch does NOT retro-abort it.
    h.clock.advance(60 * 60 * 1000);
    expect(fetchDispatchResult(fetchRequest(q), h.deps).state).toBe("result-stored");
  });
});

describe("mismatches fail typed and cannot consume", () => {
  test("an unknown, foreign, or malformed capability is refused", () => {
    const h = harness();
    const p = prepared(h);
    const foreign = harness({ seed: 99 });
    const q = prepared(foreign);
    expect(q.resultCapability.token).not.toBe(p.resultCapability.token);

    // Another dispatch's capability cannot store here.
    expect(() => storeDispatchResult(submission(q.resultCapability), h.deps)).toThrow(
      DispatchAuthorizationError,
    );
    expect(() => storeDispatchResult(submission(q.resultCapability), h.deps)).toThrow(
      "store_result: unknown result capability",
    );
    for (const token of ["cq_result_" + "x".repeat(43), `${p.resultCapability.token}TAMPERED`]) {
      expect(
        () => storeDispatchResult(submission({ scope: "store-result", token }), h.deps),
        token,
      ).toThrow(DispatchAuthorizationError);
    }
    for (const token of ["", "nope", ...PROTOTYPE_NAMES]) {
      expect(
        () => storeDispatchResult(submission({ scope: "store-result", token }), h.deps),
        token,
      ).toThrow("malformed result capability");
    }
    for (const scope of ["confirm-completion", "abort", "", ...PROTOTYPE_NAMES]) {
      expect(
        () =>
          storeDispatchResult(
            submission({ scope: scope as never, token: p.resultCapability.token }),
            h.deps,
          ),
        scope,
      ).toThrow("a result capability authorizes only store_result");
    }
    // Nothing was consumed by any of it.
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("prepared");
  });

  test("a mismatched child or run cannot confirm", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    for (const proof of [
      { ...COMPLETION, childId: "another-child" },
      { ...COMPLETION, runId: "run-9999" },
      { ...COMPLETION, childId: "another-child", runId: "run-9999" },
    ]) {
      expect(
        () => confirmDispatchCompletion(confirmation(p, { nativeCompletion: proof }), h.deps),
        JSON.stringify(proof),
      ).toThrow(AttestationBindingError);
    }
    expect(() =>
      confirmDispatchCompletion(
        confirmation(p, { nativeCompletion: { ...COMPLETION, childId: "another-child" } }),
        h.deps,
      ),
    ).toThrow(`expects "${CHILD.childId}"/"${CHILD.runId}"`);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
  });

  test("a mismatched role, version, prompt or input digest cannot confirm", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const binding = provenanceBindingOf(p);
    for (const [field, value] of [
      ["roleId", "implement-reviewer"],
      ["version", 99],
      ["promptDigest", "c".repeat(64)],
      ["inputDigest", "d".repeat(64)],
    ] as const) {
      expect(
        () =>
          confirmDispatchCompletion(
            confirmation(p, { expectedProvenance: { ...binding, [field]: value } }),
            h.deps,
          ),
        field,
      ).toThrow(AttestationBindingError);
      expect(() =>
        confirmDispatchCompletion(
          confirmation(p, { expectedProvenance: { ...binding, [field]: value } }),
          h.deps,
        ),
      ).toThrow(`expectedProvenance.${field}:`);
    }
    expect(() =>
      confirmDispatchCompletion(
        confirmation(p, { expectedProvenance: undefined as never }),
        h.deps,
      ),
    ).toThrow("expected the launched provenance binding");
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
  });

  test("a mismatched generation cannot confirm, abort or be fetched as the live record", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const stale: DispatchHandle = { attestationId: p.attestationId, generation: 2 };
    expect(fetchDispatchResult({ ...stale, namespace: NAMESPACE, actor: "trusted-parent" }, h.deps).state).toBe("attestation-not-found");
    expect(() => confirmDispatchCompletion(confirmation(p, { generation: 2 }), h.deps)).toThrow(
      AttestationNotFoundError,
    );
    expect(() => abortDispatch(abortRequest(p, { generation: 2 }), h.deps)).toThrow(
      AttestationNotFoundError,
    );
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
  });

  test("a malformed handle is an explicit error, never attestation-not-found", () => {
    const h = harness();
    for (const attestationId of [...PROTOTYPE_NAMES, "", "att_short", "T685", 7, null]) {
      expect(
        () => fetchDispatchResult({ attestationId, generation: 1, namespace: NAMESPACE, actor: "trusted-parent" } as never, h.deps),
        String(attestationId),
      ).toThrow(AttestationContractError);
    }
    for (const generation of [0, -1, 1.5, "1", Number.NaN, undefined]) {
      expect(
        () =>
          fetchDispatchResult(
            {
              attestationId: `att_${"x".repeat(32)}`,
              generation,
              namespace: NAMESPACE,
              actor: "trusted-parent",
            } as never,
            h.deps,
          ),
        String(generation),
      ).toThrow("handle.generation:");
    }
    // A WELL-FORMED unknown handle IS the lifecycle answer.
    const unknown = { attestationId: `att_${"y".repeat(32)}`, generation: 1 };
    expect(fetchDispatchResult({ ...unknown, namespace: NAMESPACE, actor: "trusted-parent" }, h.deps)).toEqual({
      state: "attestation-not-found",
      ...unknown,
    });
    expect(assertDispatchHandle(unknown)).toEqual(unknown);
  });
});

describe("identical retries are idempotent, conflicting retries stay conflicts", () => {
  test("an identical store retry is idempotent; a different output conflicts", () => {
    const h = harness();
    const p = prepared(h);
    const first = storeOne(h, p);
    const writes = h.replaced.length;
    const retry = storeOne(h, p);
    expect(retry).toEqual(first);
    // An idempotent retry writes nothing.
    expect(h.replaced).toHaveLength(writes);

    expect(() => storeOne(h, p, OTHER_OUTPUT)).toThrow(DispatchStateConflictError);
    expect(() => storeOne(h, p, OTHER_OUTPUT)).toThrow("a different result is already stored");
    const fetched = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(fetched.state).toBe("result-stored");
    expect(h.store.rows()).toHaveLength(1);
  });

  test("an identical confirm retry is idempotent; a different proof conflicts", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const first = confirmDispatchCompletion(confirmation(p), h.deps);
    const writes = h.replaced.length;
    expect(confirmDispatchCompletion(confirmation(p), h.deps)).toEqual(first);
    expect(h.replaced).toHaveLength(writes);
    expect(() =>
      confirmDispatchCompletion(
        confirmation(p, {
          nativeCompletion: { ...COMPLETION, completedAt: "2026-07-27T09:09:00.000Z" },
        }),
        h.deps,
      ),
    ).toThrow("already consumed under a different completion proof");
    expect(() =>
      confirmDispatchCompletion(
        confirmation(p, { nativeCompletion: { ...COMPLETION, actor: "trusted-extension" } }),
        h.deps,
      ),
    ).toThrow(DispatchStateConflictError);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("consumed");
  });

  test("an identical abort retry is idempotent; a different reason or body conflicts", () => {
    const h = harness();
    const p = prepared(h);
    const body: DispatchJSONValue = { exitCode: 1 };
    const first = abortDispatch(
      abortRequest(p, { reason: "native-failure", details: body }),
      h.deps,
    );
    const writes = h.replaced.length;
    expect(
      abortDispatch(
        abortRequest(p, { reason: "native-failure", details: { exitCode: 1 } }),
        h.deps,
      ),
    ).toEqual(first);
    expect(h.replaced).toHaveLength(writes);
    for (const conflicting of [
      { reason: "cancelled" as const, details: body },
      { reason: "native-failure" as const, details: { exitCode: 2 } },
      { reason: "native-failure" as const },
    ]) {
      expect(
        () => abortDispatch(abortRequest(p, conflicting), h.deps),
        JSON.stringify(conflicting),
      ).toThrow(DispatchStateConflictError);
    }
    // A detail-free abort is idempotent on the same terms.
    const bare = harness();
    const q = prepared(bare);
    const abortedBare = abortDispatch(abortRequest(q, { reason: "cancelled" }), bare.deps);
    expect(abortDispatch(abortRequest(q, { reason: "cancelled" }), bare.deps)).toEqual(abortedBare);
    expect(() =>
      abortDispatch(abortRequest(q, { reason: "cancelled", details: { x: 1 } }), bare.deps),
    ).toThrow(DispatchStateConflictError);
  });

  test("a consumed record refuses a later abort or store (terminal conflict)", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    confirmDispatchCompletion(confirmation(p), h.deps);
    expect(() => abortDispatch(abortRequest(p), h.deps)).toThrow(
      "already consumed and cannot be aborted",
    );
    expect(() => storeOne(h, p)).toThrow("is already consumed");
    expect(() => storeOne(h, p, OTHER_OUTPUT)).toThrow(DispatchStateConflictError);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("consumed");
  });

  test("no retry ever grows the row count (bounded rows)", () => {
    const h = harness();
    const p = prepared(h);
    for (let i = 0; i < 5; i += 1) {
      storeOne(h, p);
      fetchDispatchResult(fetchRequest(p), h.deps);
    }
    confirmDispatchCompletion(confirmation(p), h.deps);
    for (let i = 0; i < 5; i += 1) {
      confirmDispatchCompletion(confirmation(p), h.deps);
      expect(() => abortDispatch(abortRequest(p), h.deps)).toThrow(DispatchStateConflictError);
    }
    expect(h.store.rows()).toHaveLength(1);
  });
});

describe("fetch distinguishes every lifecycle state", () => {
  test("all six states are produced and each validates against T682's schema", () => {
    const observed = new Map<string, unknown>();

    const preparedH = harness();
    const p1 = prepared(preparedH);
    observed.set("prepared", fetchDispatchResult(fetchRequest(p1), preparedH.deps));

    const storedH = harness();
    const p2 = prepared(storedH);
    storeOne(storedH, p2);
    observed.set("result-stored", fetchDispatchResult(fetchRequest(p2), storedH.deps));

    const consumedH = harness();
    const p3 = prepared(consumedH);
    storeOne(consumedH, p3);
    confirmDispatchCompletion(confirmation(p3), consumedH.deps);
    observed.set("consumed", fetchDispatchResult(fetchRequest(p3), consumedH.deps));

    const abortedH = harness();
    const p4 = prepared(abortedH);
    abortDispatch(
      abortRequest(p4, { reason: "protocol-violation", details: { got: "prose" } }),
      abortedH.deps,
    );
    observed.set("aborted", fetchDispatchResult(fetchRequest(p4), abortedH.deps));

    const expiredH = harness();
    const p5 = prepared(expiredH);
    abortDispatch(abortRequest(p5), expiredH.deps);
    expiredH.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    observed.set("terminal-envelope-expired", fetchDispatchResult(fetchRequest(p5), expiredH.deps));

    observed.set(
      "attestation-not-found",
      fetchDispatchResult(
        {
          attestationId: `att_${"z".repeat(32)}`,
          generation: 1,
          namespace: NAMESPACE,
          actor: "trusted-parent",
        },
        preparedH.deps,
      ),
    );

    expect([...observed.keys()].sort()).toEqual([...DISPATCH_LIFECYCLE_STATES].sort());
    for (const [state, result] of observed) {
      expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, result).ok, state).toBe(true);
      expect((result as { readonly state: string }).state, state).toBe(state);
    }
    // Consumed is the ONLY state carrying output, and aborted the only one
    // carrying a reason.
    for (const [state, result] of observed) {
      expect(Object.hasOwn(result as object, "output"), state).toBe(state === "consumed");
      expect(Object.hasOwn(result as object, "reason"), state).toBe(state === "aborted");
    }
  });

  test("absence is never read as a child failure", () => {
    const h = harness();
    const missing = fetchDispatchResult(
      {
        attestationId: `att_${"q".repeat(32)}`,
        generation: 1,
        namespace: NAMESPACE,
        actor: "trusted-parent",
      },
      h.deps,
    );
    expect(missing.state).toBe("attestation-not-found");
    expect(Object.hasOwn(missing, "reason")).toBe(false);
    expect(Object.keys(missing).sort()).toEqual(["attestationId", "generation", "state"]);
    // It is a DIFFERENT answer from every abort reason.
    for (const reason of DISPATCH_ABORT_REASONS) {
      expect(missing.state, reason).not.toBe(reason);
    }
  });

  test("fetch NEVER mutates the record", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const before = h.store.snapshot().map(attestationRowDigest);
    const writes = h.replaced.length;
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(1000);
      fetchDispatchResult(fetchRequest(p), h.deps);
    }
    expect(h.store.snapshot().map(attestationRowDigest)).toEqual(before);
    expect(h.replaced).toHaveLength(writes);
  });
});

describe("namespace, auth, transport and storage errors stay explicit", () => {
  test("a namespace mismatch is an explicit error on every trusted operation", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    for (const namespace of [OTHER_PROJECT, OTHER_BACKEND]) {
      const label = formatAttestationNamespace(namespace);
      expect(() => prepareDispatch(prepareRequest({ namespace }), h.prepareDeps), label).toThrow(
        AttestationNamespaceError,
      );
      expect(
        () => confirmDispatchCompletion(confirmation(p, { namespace }), h.deps),
        label,
      ).toThrow(AttestationNamespaceError);
      expect(() => abortDispatch(abortRequest(p, { namespace }), h.deps), label).toThrow(
        AttestationNamespaceError,
      );
    }
    expect(() => abortDispatch(abortRequest(p, { namespace: OTHER_PROJECT }), h.deps)).toThrow(
      `abort_dispatch is scoped to namespace ${formatAttestationNamespace(OTHER_PROJECT)}`,
    );
    // None of it is a lifecycle state.
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
  });

  test("a row surfacing from a FOREIGN namespace is refused, not served", () => {
    // A deliberately mis-wired adapter: it holds this namespace but hands back a
    // row stamped with another. Only the service-side namespace guard stops it.
    const h = harness();
    const p = prepared(h);
    const foreignRow: AttestationEnvelope = { ...envelopeOf(h, p), namespace: OTHER_PROJECT };
    // A store with NO checks of its own, so ONLY the service-side namespace
    // guard can refuse the row — the strict dummy would otherwise mask it.
    const miswired = new LyingStore(NAMESPACE, foreignRow);
    const deps: DispatchServiceDeps = { store: miswired, now: h.clock.now };
    expect(() => fetchDispatchResult(fetchRequest(p), deps)).toThrow(AttestationNamespaceError);
    expect(() => storeDispatchResult(submission(p.resultCapability), deps)).toThrow(
      AttestationNamespaceError,
    );
    expect(() => confirmDispatchCompletion(confirmation(p), deps)).toThrow(
      AttestationNamespaceError,
    );
    expect(() => abortDispatch(abortRequest(p), deps)).toThrow(AttestationNamespaceError);
    expect(() => sweepAttestations(deps)).toThrow(AttestationNamespaceError);
    expect(() =>
      prepareDispatch(prepareRequest({ idempotencyKey: "T685-round-1" }), {
        store: miswired,
        now: h.clock.now,
        randomBytes: sequentialDispatchRandomBytes(5),
      }),
    ).toThrow(AttestationNamespaceError);
  });

  test("a stored row naming a prototype-exposed role validates against NOTHING", () => {
    // The role id comes off the RECORD, so it reaches the sidecar table as a
    // caller-influenced key — the D169 class. It must fail loudly instead of
    // resolving `Object.prototype.constructor` and validating output against it.
    const h = harness();
    const p = prepared(h);
    const row = envelopeOf(h, p);
    for (const roleId of PROTOTYPE_NAMES) {
      const deps: DispatchServiceDeps = {
        store: new LyingStore(NAMESPACE, {
          ...row,
          promptProvenance: { ...row.promptProvenance, roleId: roleId as never },
        }),
        now: h.clock.now,
      };
      expect(() => storeDispatchResult(submission(p.resultCapability), deps), roleId).toThrow(
        AttestationContractError,
      );
      expect(() => storeDispatchResult(submission(p.resultCapability), deps)).toThrow(
        `names unknown role "${roleId}"`,
      );
    }
  });

  test("the operation-authorization coverage assertion refuses a divergent declaration", () => {
    // The production declarations agree …
    expect(
      assertDispatchOperationAuthorization(
        DISPATCH_PROTOCOL_OPERATIONS,
        DISPATCH_OPERATION_AUTHORIZATION,
        RESULT_CAPABILITY_OPERATIONS,
      ),
    ).toEqual([...DISPATCH_PROTOCOL_OPERATIONS].sort());
    // … an unscoped operation is refused …
    expect(() =>
      assertDispatchOperationAuthorization(
        [...DISPATCH_PROTOCOL_OPERATIONS, "resume_dispatch"],
        DISPATCH_OPERATION_AUTHORIZATION,
        RESULT_CAPABILITY_OPERATIONS,
      ),
    ).toThrow("do not match the scoped operations");
    // … a scope for an undeclared operation is refused …
    expect(() =>
      assertDispatchOperationAuthorization(
        DISPATCH_PROTOCOL_OPERATIONS,
        new Map([
          ...DISPATCH_OPERATION_AUTHORIZATION,
          ["resume_dispatch", "trusted-parent"],
        ] as never),
        RESULT_CAPABILITY_OPERATIONS,
      ),
    ).toThrow("DISPATCH_OPERATION_AUTHORIZATION");
    // … and SILENTLY widening what a capability authorizes is refused.
    expect(() =>
      assertDispatchOperationAuthorization(
        DISPATCH_PROTOCOL_OPERATIONS,
        new Map([
          ...DISPATCH_OPERATION_AUTHORIZATION,
          ["abort_dispatch", "result-capability"],
        ] as never),
        RESULT_CAPABILITY_OPERATIONS,
      ),
    ).toThrow("do not match the declared capability operations");
    expect(() =>
      assertDispatchOperationAuthorization(
        DISPATCH_PROTOCOL_OPERATIONS,
        DISPATCH_OPERATION_AUTHORIZATION,
        [],
      ),
    ).toThrow("RESULT_CAPABILITY_OPERATIONS");
  });

  test("a LOOSELY resolving adapter cannot authorize a submission", () => {
    // An adapter that resolves a capability by anything other than the exact
    // stored hash — here, the first row it holds. The service's own constant-time
    // confirmation against `resultCapabilityHash` is the ONLY thing between such
    // an adapter and a stolen-capability write.
    const h = harness();
    const p = prepared(h);
    const row = envelopeOf(h, p);
    const loose: typeof h.store = Object.create(h.store) as typeof h.store;
    loose.readByCapabilityHash = () => row;
    const deps: DispatchServiceDeps = { store: loose, now: h.clock.now };
    const foreign = mintResultCapability(sequentialDispatchRandomBytes(4242));
    expect(resultCapabilityHash(foreign.token)).not.toBe(row.resultCapabilityHash);
    expect(() => storeDispatchResult(submission(foreign), deps)).toThrow(
      "store_result: unknown result capability",
    );
    // The record is untouched, and the RIGHT capability still works.
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("prepared");
    expect(storeDispatchResult(submission(p.resultCapability), deps).state).toBe("result-stored");
  });

  test("a CORRUPT row is refused loudly rather than served as a lifecycle answer", () => {
    const h = harness();
    const p = prepared(h);
    const row = envelopeOf(h, p);
    const serve = (corrupt: AttestationRow): DispatchServiceDeps => {
      const store: typeof h.store = Object.create(h.store) as typeof h.store;
      store.read = () => corrupt;
      return { store, now: h.clock.now };
    };
    // `consumed` with no output, `result-stored` with no storedAt, `aborted` with
    // no reason: each is an impossible revision, and each fails fast.
    for (const corrupt of [
      { ...row, state: "consumed" as const, consumedAt: T0 },
      { ...row, state: "result-stored" as const },
      { ...row, state: "aborted" as const, abortedAt: T0 },
    ]) {
      expect(() => fetchDispatchResult(fetchRequest(p), serve(corrupt)), corrupt.state).toThrow(
        AttestationContractError,
      );
    }
    // A corrupt deadline is likewise refused instead of silently passing.
    expect(() =>
      storeDispatchResult(submission(p.resultCapability), {
        store: Object.assign(Object.create(h.store) as typeof h.store, {
          readByCapabilityHash: () => ({
            ...row,
            deadlines: { ...row.deadlines, childCancelAt: "whenever" },
          }),
        }),
        now: h.clock.now,
      }),
    ).toThrow("deadlines.childCancelAt:");
    // A corrupt terminal timestamp cannot be swept either.
    expect(() =>
      sweepAttestations({
        store: Object.assign(Object.create(h.store) as typeof h.store, {
          rows: () => [{ ...row, state: "aborted" as const, terminalAt: "never" }],
        }),
        now: h.clock.now,
      }),
    ).toThrow("terminalAt:");
  });

  test("the dummy refuses to hold a foreign-namespace row at all", () => {
    const store = new InMemoryAttestationStore(NAMESPACE);
    const h = harness();
    const p = prepared(h);
    const foreign: AttestationEnvelope = { ...envelopeOf(h, p), namespace: OTHER_PROJECT };
    expect(() => store.insert(foreign)).toThrow(AttestationNamespaceError);
    expect(() => InMemoryAttestationStore.rehydrate(NAMESPACE, [foreign])).toThrow(
      AttestationNamespaceError,
    );
    expect(attestationNamespacesEqual(NAMESPACE, OTHER_PROJECT)).toBe(false);
    expect(attestationNamespacesEqual(NAMESPACE, { ...NAMESPACE })).toBe(true);
    expect(formatAttestationNamespace(NAMESPACE)).toBe("xdg:cq-ledger-suite");
    expect(assertAttestationNamespace(NAMESPACE)).toEqual(NAMESPACE);
  });

  test("a transport failure propagates untouched on every operation", () => {
    for (const operation of ATTESTATION_STORE_OPERATIONS) {
      let armed = false;
      const h = harness({
        fault: (op) => {
          if (armed && op === operation) {
            throw new AttestationTransportError(`store unreachable during ${op}`);
          }
        },
      });
      const p = prepared(h);
      armed = true;
      const attempts = [
        () => prepareDispatch(prepareRequest({ idempotencyKey: "T685-round-1" }), h.prepareDeps),
        () => storeDispatchResult(submission(p.resultCapability), h.deps),
        () => confirmDispatchCompletion(confirmation(p), h.deps),
        () => abortDispatch(abortRequest(p), h.deps),
        () => fetchDispatchResult(fetchRequest(p), h.deps),
        () => sweepAttestations(h.deps),
        // Past both retention windows, so a sweep reaches `remove` as well.
        () =>
          sweepAttestations({
            ...h.deps,
            now: () => h.clock.advance(IDEMPOTENCY_HORIZON_MS).peek(),
          }),
      ];
      let observed = 0;
      for (const attempt of attempts) {
        try {
          attempt();
        } catch (error) {
          if (error instanceof AttestationTransportError) {
            observed += 1;
          }
        }
      }
      // At least one operation reaches the faulted store method, and when it
      // does the transport error surfaces as itself.
      expect(observed, operation).toBeGreaterThan(0);
    }
  });

  test("a lost update is an explicit storage error, not a silent clobber", () => {
    const h = harness();
    const p = prepared(h);
    const stale = envelopeOf(h, p);
    storeOne(h, p);
    // A writer holding the pre-store revision loses.
    expect(() => h.store.replace(stale, { ...stale, state: "aborted" })).toThrow(
      AttestationStorageError,
    );
    expect(() => h.store.replace(stale, { ...stale, state: "aborted" })).toThrow("lost update");
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
    // And the dummy refuses an identity-changing or key-changing replace.
    const current = envelopeOf(h, p);
    expect(() => h.store.replace(current, { ...current, generation: 2 })).toThrow(
      "must not change a row's identity",
    );
    expect(() => h.store.replace(current, { ...current, idempotencyKey: "other" })).toThrow(
      "must not change the idempotency key",
    );
    expect(() => h.store.remove({ attestationId: `att_${"n".repeat(32)}`, generation: 1 })).toThrow(
      AttestationStorageError,
    );
  });

  test("the store refuses a duplicate handle or a duplicate idempotency key", () => {
    // The service checks the key first, so these are the STORE's own backstops —
    // the ones a production adapter must reproduce. Driven directly, because a
    // service that behaves correctly never reaches them.
    const h = harness();
    const p = prepared(h);
    const row = envelopeOf(h, p);
    expect(() => h.store.insert(row)).toThrow(AttestationStorageError);
    expect(() => h.store.insert(row)).toThrow(`attestation "${p.attestationId}#1" already exists`);
    const sameKeyOtherHandle: AttestationEnvelope = {
      ...row,
      attestationId: `att_${"k".repeat(32)}`,
    };
    expect(() => h.store.insert(sameKeyOtherHandle)).toThrow(
      `idempotency key "T685-round-0" is already held by "${p.attestationId}#1"`,
    );
    // A free key at a free handle but the SAME capability hash is refused too:
    // T720 gave the dummy the production adapters' unique capability-hash guard,
    // so two live rows can never be resolvable by ONE capability here either.
    expect(() =>
      h.store.insert({ ...sameKeyOtherHandle, idempotencyKey: "T685-round-1" }),
    ).toThrow(`capability hash is already held by "${p.attestationId}#1"`);
    // A different key, handle AND capability is accepted, and nothing was lost.
    h.store.insert({
      ...sameKeyOtherHandle,
      idempotencyKey: "T685-round-1",
      resultCapabilityHash: "f".repeat(64),
    });
    expect(h.store.rows()).toHaveLength(2);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("prepared");

    // Only a prepared ENVELOPE may be inserted — a tombstone is a sweep product.
    abortDispatch(abortRequest(p), h.deps);
    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    sweepAttestations(h.deps);
    const tombstone = h.store.snapshot().find(isAttestationTombstone)!;
    expect(() => h.store.insert(tombstone as never)).toThrow(
      "insert accepts a prepared envelope only",
    );

    // `rows()` is a COPY: no caller can splice storage from under the service.
    const rows = h.store.rows() as AttestationRow[];
    expect(() => rows.push(tombstone)).toThrow();
    expect(h.store.rows()).toHaveLength(2);
  });

  test("the fake clock refuses to run backwards", () => {
    const clock = new FakeDispatchClock(T0);
    expect(clock.peek()).toBe(T0);
    expect(clock.reads).toBe(0);
    expect(clock.now()).toBe(T0);
    expect(clock.reads).toBe(1);
    expect(() => clock.advance(-1)).toThrow(AttestationContractError);
    expect(() => clock.advance(Number.NaN)).toThrow("expected a non-negative delta");
    expect(clock.peek()).toBe(T0);
    expect(clock.advance(1000).peek()).toBe(new Date(T0_MS + 1000).toISOString());
    expect(clock.set(T0).epochMs).toBe(T0_MS);
    expect(() => new FakeDispatchClock("not a time")).toThrow(AttestationContractError);
  });
});

describe("idempotency keys, generations and old-attestation isolation", () => {
  test("concurrent reuse of one idempotency key allocates exactly ONE attestation", () => {
    const h = harness();
    const first = acceptedOf(prepareDispatch(prepareRequest(), h.prepareDeps));
    expect(() => prepareDispatch(prepareRequest(), h.prepareDeps)).toThrow(
      AttestationKeyReuseError,
    );
    expect(() => prepareDispatch(prepareRequest(), h.prepareDeps)).toThrow(
      `idempotency key "T685-round-0" is still held by attestation "${first.prepared.attestationId}"`,
    );
    expect(h.store.rows()).toHaveLength(1);
    // A different key is free.
    expect(
      prepareDispatch(prepareRequest({ idempotencyKey: "T685-round-1" }), h.prepareDeps).accepted,
    ).toBe(true);
    expect(h.store.rows()).toHaveLength(2);
    // Reuse is refused while the record is TERMINAL but within the horizon too.
    abortDispatch(abortRequest(first.prepared), h.deps);
    expect(() => prepareDispatch(prepareRequest(), h.prepareDeps)).toThrow(
      AttestationKeyReuseError,
    );
  });

  test("no prototype-exposed idempotency key resolves a phantom holder", () => {
    for (const idempotencyKey of PROTOTYPE_NAMES) {
      const h = harness();
      // The key is unheld, so the FIRST prepare must succeed …
      const accepted = acceptedOf(
        prepareDispatch(prepareRequest({ idempotencyKey }), h.prepareDeps),
      );
      expect(h.store.readByIdempotencyKey(idempotencyKey)).toHaveLength(1);
      // … and only the second is refused, by the row that actually holds it.
      expect(
        () => prepareDispatch(prepareRequest({ idempotencyKey }), h.prepareDeps),
        idempotencyKey,
      ).toThrow(`is still held by attestation "${accepted.prepared.attestationId}"`);
      // A DIFFERENT prototype name is not confused with this one.
      const other = PROTOTYPE_NAMES.find((name) => name !== idempotencyKey)!;
      expect(h.store.readByIdempotencyKey(other)).toHaveLength(0);
    }
  });

  test("no prototype-exposed capability hash or handle resolves a row", () => {
    const h = harness();
    const p = prepared(h);
    for (const name of [...PROTOTYPE_NAMES, ""]) {
      expect(h.store.readByCapabilityHash(name), name).toBeUndefined();
      expect(h.store.read({ attestationId: name, generation: 1 }), name).toBeUndefined();
    }
    expect(h.store.readByCapabilityHash(envelopeOf(h, p).resultCapabilityHash)).toBeDefined();
  });

  test("a generation may only be re-prepared once the previous one is terminal", () => {
    const h = harness();
    const first = prepared(h);
    for (const stage of ["prepared", "result-stored"] as const) {
      if (stage === "result-stored") {
        storeOne(h, first);
      }
      expect(
        () =>
          prepareDispatch(
            prepareRequest({ idempotencyKey: "T685-round-1", reprepareOf: handleOf(first) }),
            h.prepareDeps,
          ),
        stage,
      ).toThrow(DispatchStateConflictError);
    }
    abortDispatch(abortRequest(first, { reason: "cancelled" }), h.deps);
    const second = acceptedOf(
      prepareDispatch(
        prepareRequest({ idempotencyKey: "T685-round-1", reprepareOf: handleOf(first) }),
        h.prepareDeps,
      ),
    );
    expect(second.prepared.attestationId).toBe(first.attestationId);
    expect(second.prepared.generation).toBe(2);
    expect(second.prepared.resultCapability.token).not.toBe(first.resultCapability.token);
    expect(h.store.rows()).toHaveLength(2);
    // Re-preparing an unknown generation is not found.
    expect(() =>
      prepareDispatch(
        prepareRequest({
          idempotencyKey: "T685-round-2",
          reprepareOf: { attestationId: first.attestationId, generation: 9 },
        }),
        h.prepareDeps,
      ),
    ).toThrow(AttestationNotFoundError);
  });

  test("the OLD generation is isolated from every operation on the new one", () => {
    const h = harness();
    const first = prepared(h);
    abortDispatch(abortRequest(first, { reason: "cancelled" }), h.deps);
    const second = acceptedOf(
      prepareDispatch(
        prepareRequest({ idempotencyKey: "T685-round-1", reprepareOf: handleOf(first) }),
        h.prepareDeps,
      ),
    ).prepared;

    // The OLD capability cannot touch the new generation, and the old row keeps
    // its own terminal answer.
    expect(() => storeDispatchResult(submission(first.resultCapability), h.deps)).toThrow(
      DispatchStateConflictError,
    );
    expect(fetchDispatchResult(fetchRequest(first), h.deps).state).toBe("aborted");

    // The NEW capability drives the new generation to consumed, leaving the old
    // row untouched.
    const oldDigest = attestationRowDigest(h.store.snapshot().find((row) => row.generation === 1)!);
    storeOne(h, second);
    confirmDispatchCompletion(confirmation(second), h.deps);
    expect(fetchDispatchResult(fetchRequest(second), h.deps).state).toBe("consumed");
    expect(fetchDispatchResult(fetchRequest(first), h.deps).state).toBe("aborted");
    expect(attestationRowDigest(h.store.snapshot().find((row) => row.generation === 1)!)).toBe(
      oldDigest,
    );
    // Confirming the old generation with the NEW provenance is still refused.
    expect(() =>
      confirmDispatchCompletion(
        confirmation(second, { generation: 1, expectedProvenance: provenanceBindingOf(second) }),
        h.deps,
      ),
    ).toThrow(DispatchStateConflictError);
  });
});

describe("the 24h envelope, the 30d tombstone, and exact boundaries", () => {
  test("the two retention windows are the declared constants", () => {
    expect(TERMINAL_ENVELOPE_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(IDEMPOTENCY_HORIZON_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(TERMINAL_ENVELOPE_RETENTION_MS).toBeLessThan(IDEMPOTENCY_HORIZON_MS);
  });

  test("the envelope survives to the exact boundary and expires ON it", () => {
    for (const terminal of ["consumed", "aborted"] as const) {
      const h = harness();
      const p = prepared(h);
      if (terminal === "consumed") {
        storeOne(h, p);
        confirmDispatchCompletion(confirmation(p), h.deps);
      } else {
        abortDispatch(abortRequest(p, { reason: "cancelled", details: { note: "body" } }), h.deps);
      }
      const terminalAt = h.clock.epochMs;

      h.clock.set(new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS - 1).toISOString());
      expect(fetchDispatchResult(fetchRequest(p), h.deps).state, terminal).toBe(terminal);
      expect(sweepAttestations(h.deps).envelopesCollapsed).toEqual([]);

      h.clock.set(new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
      const expired = fetchDispatchResult(fetchRequest(p), h.deps);
      expect(expired.state, terminal).toBe("terminal-envelope-expired");
      if (expired.state !== "terminal-envelope-expired") throw new Error("unreachable");
      expect(expired.terminalKind).toBe(terminal);
      expect(expired.reuseAfter).toBe(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS).toISOString());
      expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, expired).ok).toBe(true);
    }
  });

  test("the sweep collapses the envelope to the minimal tombstone", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    const consumed = confirmDispatchCompletion(confirmation(p), h.deps);
    if (consumed.state !== "consumed") throw new Error("unreachable");
    const terminalAt = h.clock.epochMs;
    const before = envelopeOf(h, p);

    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    const report = sweepAttestations(h.deps);
    expect(report.envelopesCollapsed).toEqual([handleOf(p)]);
    expect(report.tombstonesRemoved).toEqual([]);
    expect(report.rowsRemaining).toBe(1);
    expect(report.at).toBe(new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());

    const row = h.store.snapshot()[0]!;
    expect(isAttestationTombstone(row)).toBe(true);
    expect(Object.keys(row).sort()).toEqual([...TOMBSTONE_RETAINED_FIELDS].sort());
    for (const field of TOMBSTONE_FORBIDDEN_FIELDS) {
      expect(Object.hasOwn(row, field), field).toBe(false);
    }
    if (!isAttestationTombstone(row)) throw new Error("unreachable");
    expect(row.terminalKind).toBe("consumed");
    expect(row.inputDigest).toBe(before.promptProvenance.inputDigest);
    expect(before.terminalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.terminalDigest).toBe(before.terminalDigest!);
    expect(row.idempotencyKey).toBe("T685-round-0");
    expect(row.reuseAfter).toBe(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS).toISOString());

    // No output, capability, proof, prompt digest, schema or reason body remains.
    const serialized = JSON.stringify(row);
    for (const secret of [
      "0be2cc034dd490d484bdac0dfad5efb9be52c068",
      p.resultCapability.token,
      before.resultCapabilityHash,
      PROMPT_DIGEST,
      CATALOG_HASH,
      COMPLETION.childId,
      COMPLETION.runId,
      "3621 pass",
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
    // The sweep is idempotent at the same instant.
    const again = sweepAttestations(h.deps);
    expect(again.envelopesCollapsed).toEqual([]);
    expect(again.rowsRemaining).toBe(1);
  });

  test("an expired ABORT drops its reason body entirely", () => {
    const h = harness();
    const p = prepared(h);
    const body: DispatchJSONValue = { stderr: "SUPER-SECRET-FAILURE-BODY", exitCode: 137 };
    abortDispatch(abortRequest(p, { reason: "native-failure", details: body }), h.deps);
    expect(JSON.stringify(h.store.snapshot())).toContain("SUPER-SECRET-FAILURE-BODY");
    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    sweepAttestations(h.deps);
    expect(JSON.stringify(h.store.snapshot())).not.toContain("SUPER-SECRET-FAILURE-BODY");
    const fetched = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(fetched.state).toBe("terminal-envelope-expired");
    expect(Object.hasOwn(fetched, "reason")).toBe(false);
    expect(Object.hasOwn(fetched, "details")).toBe(false);
  });

  test("the tombstone is dropped ON the 30d boundary, releasing its key", () => {
    const h = harness();
    const p = prepared(h);
    abortDispatch(abortRequest(p), h.deps);
    const terminalAt = h.clock.epochMs;
    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    sweepAttestations(h.deps);

    h.clock.set(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS - 1).toISOString());
    expect(sweepAttestations(h.deps).tombstonesRemoved).toEqual([]);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("terminal-envelope-expired");
    expect(() => prepareDispatch(prepareRequest(), h.prepareDeps)).toThrow(
      AttestationKeyReuseError,
    );

    h.clock.set(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS).toISOString());
    // The lookup answers not-found even before the sweep physically drops it.
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("attestation-not-found");
    const report = sweepAttestations(h.deps);
    expect(report.tombstonesRemoved).toEqual([handleOf(p)]);
    expect(report.rowsRemaining).toBe(0);
    expect(h.store.rows()).toHaveLength(0);
    // And the key is reusable again.
    expect(prepareDispatch(prepareRequest(), h.prepareDeps).accepted).toBe(true);
  });

  test("a terminal record never swept still answers by the two boundaries", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    confirmDispatchCompletion(confirmation(p), h.deps);
    const terminalAt = h.clock.epochMs;
    // No sweep at all: the envelope is physically intact …
    h.clock.set(new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS).toISOString());
    expect(isAttestationTombstone(h.store.snapshot()[0]!)).toBe(false);
    // … yet the lookup already refuses to serve its body.
    const expired = fetchDispatchResult(fetchRequest(p), h.deps);
    expect(expired.state).toBe("terminal-envelope-expired");
    expect(Object.hasOwn(expired, "output")).toBe(false);
    h.clock.set(new Date(terminalAt + IDEMPOTENCY_HORIZON_MS).toISOString());
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("attestation-not-found");
    // A sweep past the horizon drops the un-collapsed envelope outright.
    const report = sweepAttestations(h.deps);
    expect(report.tombstonesRemoved).toEqual([handleOf(p)]);
    expect(report.envelopesCollapsed).toEqual([]);
  });

  test("an expired envelope refuses every capability-bound and trusted operation", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    abortDispatch(abortRequest(p, { reason: "cancelled" }), h.deps);
    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    sweepAttestations(h.deps);
    // The tombstone holds no capability hash, so the capability resolves nothing.
    expect(() => storeDispatchResult(submission(p.resultCapability), h.deps)).toThrow(
      "store_result: unknown result capability",
    );
    for (const attempt of [
      () => confirmDispatchCompletion(confirmation(p), h.deps),
      () => abortDispatch(abortRequest(p), h.deps),
    ]) {
      expect(attempt).toThrow(DispatchStateConflictError);
      expect(attempt).toThrow("its envelope has expired");
    }
  });

  test("collapsing a non-terminal envelope is an authoring defect", () => {
    const h = harness();
    const p = prepared(h);
    expect(() => collapseAttestationEnvelope(envelopeOf(h, p))).toThrow(AttestationContractError);
    storeOne(h, p);
    expect(() => collapseAttestationEnvelope(envelopeOf(h, p))).toThrow(
      'expected a terminal envelope, got "result-stored"',
    );
    // A sweep leaves both live states alone.
    h.clock.advance(IDEMPOTENCY_HORIZON_MS * 2);
    const report = sweepAttestations(h.deps);
    expect(report.envelopesCollapsed).toEqual([]);
    expect(report.tombstonesRemoved).toEqual([]);
    expect(fetchDispatchResult(fetchRequest(p), h.deps).state).toBe("result-stored");
  });

  test("a sweep bounds the row set across many dispatches", () => {
    const h = harness();
    const handles: DispatchHandle[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = prepared(h, { idempotencyKey: `T685-round-${i}` });
      handles.push(handleOf(p));
      if (i % 2 === 0) {
        abortDispatch(abortRequest(p), h.deps);
      }
    }
    expect(h.store.rows()).toHaveLength(6);
    h.clock.advance(TERMINAL_ENVELOPE_RETENTION_MS);
    expect(sweepAttestations(h.deps).envelopesCollapsed).toHaveLength(3);
    h.clock.advance(IDEMPOTENCY_HORIZON_MS);
    const report = sweepAttestations(h.deps);
    expect(report.tombstonesRemoved).toHaveLength(3);
    expect(report.rowsRemaining).toBe(3);
    // The three live ones are untouched.
    for (const [index, handle] of handles.entries()) {
      const expected = index % 2 === 0 ? "attestation-not-found" : "prepared";
      expect(fetchDispatchResult({ ...handle, namespace: NAMESPACE, actor: "trusted-parent" }, h.deps).state, String(index)).toBe(expected);
    }
  });
});

describe("restart-equivalent rehydration", () => {
  test("a rehydrated store answers identically and still authorizes the capability", () => {
    const live = harness();
    const p = prepared(live);
    const staleRevision = envelopeOf(live, p);
    storeOne(live, p);
    const beforeFetch = fetchDispatchResult(fetchRequest(p), live.deps);

    const restarted = InMemoryAttestationStore.rehydrate(NAMESPACE, live.store.snapshot());
    const clock = new FakeDispatchClock(live.clock.peek());
    const deps: DispatchServiceDeps = { store: restarted, now: clock.now };
    // The rehydrated rows are FRESH objects with identical content — which is
    // exactly why compare-and-set is digest-based rather than identity-based.
    expect(restarted.read(handleOf(p))).not.toBe(live.store.read(handleOf(p)));
    expect(restarted.snapshot().map(attestationRowDigest)).toEqual(
      live.store.snapshot().map(attestationRowDigest),
    );
    expect(fetchDispatchResult(fetchRequest(p), deps)).toEqual(beforeFetch);
    // The capability still works, because only its HASH was persisted.
    expect(JSON.stringify(restarted.snapshot())).not.toContain(p.resultCapability.token);
    const retry = storeDispatchResult(submission(p.resultCapability), deps);
    expect(retry.state).toBe("result-stored");
    // …and the lifecycle continues across the restart.
    const consumed = confirmDispatchCompletion(confirmation(p), deps);
    expect(consumed.state).toBe("consumed");
    if (consumed.state !== "consumed") throw new Error("unreachable");
    expect(consumed.result.outputDigest).toBe(dispatchPayloadDigest(OUTPUT));
    const readBack = fetchDispatchResult(fetchRequest(p), deps);
    if (readBack.state !== "consumed") throw new Error("unreachable");
    expect(readBack.output).toEqual(OUTPUT);
    // A stale revision still loses its compare-and-set after the restart.
    expect(() => restarted.replace(staleRevision, { ...staleRevision, state: "aborted" })).toThrow(
      AttestationStorageError,
    );
  });

  test("rehydration carries the terminal windows across the restart", () => {
    const live = harness();
    const p = prepared(live);
    abortDispatch(abortRequest(live && p, { reason: "protocol-violation" }), live.deps);
    const terminalAt = live.clock.epochMs;
    const restarted = InMemoryAttestationStore.rehydrate(NAMESPACE, live.store.snapshot());
    const clock = new FakeDispatchClock(
      new Date(terminalAt + TERMINAL_ENVELOPE_RETENTION_MS).toISOString(),
    );
    const deps: DispatchServiceDeps = { store: restarted, now: clock.now };
    expect(fetchDispatchResult(fetchRequest(p), deps).state).toBe("terminal-envelope-expired");
    expect(sweepAttestations(deps).envelopesCollapsed).toEqual([handleOf(p)]);
    // A second restart over the tombstone keeps the same answer.
    const twice = InMemoryAttestationStore.rehydrate(NAMESPACE, restarted.snapshot());
    expect(fetchDispatchResult(fetchRequest(p), { store: twice, now: clock.now }).state).toBe(
      "terminal-envelope-expired",
    );
    expect(() =>
      InMemoryAttestationStore.rehydrate(NAMESPACE, [...twice.snapshot(), ...twice.snapshot()]),
    ).toThrow("duplicate rehydrated attestation");
  });
});

describe("what T685 defers", () => {
  test("the deferred work is recorded, not dropped", () => {
    expect(DISPATCH_ATTESTATION_DEFERRED_TO).toBe("T720");
    expect(DISPATCH_ATTESTATION_MCP_DEFERRED_TO).toBe("T695");
    expect(DISPATCH_ATTESTATION_DEFERRED).toEqual([
      "namespaced-production-attestation-store-adapters",
      "real-backend-durability-and-crash-recovery",
      "cross-process-concurrent-key-reuse-under-a-real-lock",
      "scheduled-sweep-wiring",
    ]);
  });

  test("the envelope states are exactly the four non-lookup lifecycle states", () => {
    expect(ATTESTATION_ENVELOPE_STATES).toEqual([
      "prepared",
      "result-stored",
      "consumed",
      "aborted",
    ]);
    for (const state of ATTESTATION_ENVELOPE_STATES) {
      expect(DISPATCH_LIFECYCLE_STATES, state).toContain(state);
    }
    // The two lookup-only states are never an envelope state.
    for (const state of ["terminal-envelope-expired", "attestation-not-found"]) {
      expect(ATTESTATION_ENVELOPE_STATES, state).not.toContain(state as never);
    }
  });

  test("the confirmation wire shape still matches T682", () => {
    const h = harness();
    const p = prepared(h);
    expect(
      validateAgainstSchema(CONFIRM_DISPATCH_COMPLETION_SCHEMA, {
        ...handleOf(p),
        nativeCompletion: COMPLETION,
      }).ok,
    ).toBe(true);
  });
});

describe("D173/D174: parent-surface body containment and fetch authorization", () => {
  /**
   * The T713 probe's decisive measurement, turned into a mechanical assertion:
   * marker presence per surface, on a payload big enough that a leak is obvious.
   */
  // The role's outputSchema constrains these fields, so rather than invent an
  // oversized payload we assert on a DISTINCTIVE substring of the ordinary valid
  // output. The invariant under test is body PRESENCE per surface, not size.
  const BODY_MARKER = "Contract, port and strict dummy landed.";

  test("D173: fetch-after-confirm is the ONLY parent surface carrying the body", () => {
    const h = harness();
    const p = prepared(h);
    expect(JSON.stringify(OUTPUT)).toContain(BODY_MARKER); // fixture sanity

    const preparedJson = JSON.stringify(p);
    const ackJson = JSON.stringify(storeDispatchResult(submission(p.resultCapability), h.deps));
    const beforeConfirm = JSON.stringify(fetchDispatchResult(fetchRequest(p), h.deps));
    h.clock.advance(30_000);
    const confirmJson = JSON.stringify(confirmDispatchCompletion(confirmation(p), h.deps));
    const afterConfirm = JSON.stringify(fetchDispatchResult(fetchRequest(p), h.deps));

    expect(preparedJson).not.toContain(BODY_MARKER);
    expect(ackJson).not.toContain(BODY_MARKER); // child-visible ack
    expect(beforeConfirm).not.toContain(BODY_MARKER); // result-stored
    expect(confirmJson).not.toContain(BODY_MARKER); // THE D173 REGRESSION
    expect(afterConfirm).toContain(BODY_MARKER); // by design: the one read

    // Independent signal: the mandatory surface must stay strictly smaller than
    // the one authorized read, whatever the payload happens to be.
    expect(confirmJson.length).toBeLessThan(afterConfirm.length);
  });

  test("D174: fetch refuses an untrusted actor and a foreign namespace", () => {
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);

    for (const actor of [...PROTOTYPE_NAMES, "", "parent", "child", 7, null, undefined]) {
      expect(
        () => fetchDispatchResult(fetchRequest(p, { actor: actor as never }), h.deps),
        String(actor),
      ).toThrow(DispatchAuthorizationError);
    }
    expect(() =>
      fetchDispatchResult(
        fetchRequest(p, { namespace: { backend: "xdg", projectKey: "someone-elses-project" } }),
        h.deps,
      ),
    ).toThrow(AttestationNamespaceError);

    // The legitimate trusted actors still read.
    for (const actor of TRUSTED_DISPATCH_ACTORS) {
      expect(fetchDispatchResult(fetchRequest(p, { actor }), h.deps).state).toBe("result-stored");
    }
  });

  test("D174: EVERY trusted-parent operation rejects a FOREIGN namespace", () => {
    const FOREIGN = { backend: "xdg" as const, projectKey: "someone-elses-project" };
    const trustedOps = DISPATCH_PROTOCOL_OPERATIONS.filter(
      (op) => dispatchOperationScope(op) === "trusted-parent",
    );
    expect(trustedOps.length).toBeGreaterThan(0);
    const probes: Record<string, () => unknown> = {
      prepare_dispatch: () => {
        const h = harness();
        return prepareDispatch(prepareRequest({ namespace: FOREIGN }), h.prepareDeps);
      },
      confirm_dispatch_completion: () => {
        const h = harness();
        const p = prepared(h);
        storeOne(h, p);
        return confirmDispatchCompletion(confirmation(p, { namespace: FOREIGN }), h.deps);
      },
      abort_dispatch: () => {
        const h = harness();
        const p = prepared(h);
        return abortDispatch(abortRequest(p, { namespace: FOREIGN }), h.deps);
      },
      fetch_dispatch_result: () => {
        const h = harness();
        const p = prepared(h);
        return fetchDispatchResult(fetchRequest(p, { namespace: FOREIGN }), h.deps);
      },
    };
    for (const op of trustedOps) {
      const probe = probes[op];
      expect(probe, `no namespace probe for trusted-parent operation "${op}"`).toBeDefined();
      expect(probe!, op).toThrow(AttestationNamespaceError);
    }
  });

  test("D174: every trusted-parent operation acting on an EXISTING record also checks the actor", () => {
    // prepare_dispatch is excluded BY DESIGN: it creates the record, so there is
    // no prior actor binding to verify. Everything that touches an existing
    // record must verify one, or the declared scope is decoration.
    const h = harness();
    const p = prepared(h);
    storeOne(h, p);
    expect(() =>
      confirmDispatchCompletion(
        confirmation(p, {
          nativeCompletion: { ...COMPLETION, actor: "not-a-trusted-actor" as never },
        }),
        h.deps,
      ),
    ).toThrow();
    expect(() =>
      abortDispatch(abortRequest(p, { actor: "not-a-trusted-actor" as never }), h.deps),
    ).toThrow(DispatchAuthorizationError);
    expect(() =>
      fetchDispatchResult(fetchRequest(p, { actor: "not-a-trusted-actor" as never }), h.deps),
    ).toThrow(DispatchAuthorizationError);
  });
});
