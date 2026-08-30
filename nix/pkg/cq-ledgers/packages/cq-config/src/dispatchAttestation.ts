/**
 * Capability-bound result submission and the AttestationStore LIFECYCLE
 * (T685, goal G94).
 *
 * T682 pinned the WIRE shapes of the ref-first protocol, T683 the attested role
 * contracts, T684 the overlay policy, T976 the inside-prepare input validation,
 * and T978 the server-side assembly of that input from refs. What none of them
 * owned is the SERVICE LOGIC behind those shapes: who may call which operation,
 * which state transitions exist, and what a store must retain — and for how
 * long — to answer a lookup. This module is that clause.
 *
 * **Least privilege is the whole point.** A dispatch has exactly two authorized
 * callers ({@link DISPATCH_AUTHORIZATION_SCOPES}):
 *
 *  - the CHILD, holding a high-entropy result capability whose STORED HASH is
 *    bound to one attestation record. It authorizes ONE operation
 *    ({@link RESULT_CAPABILITY_OPERATIONS}) — `store_result`. It cannot confirm
 *    completion, cannot abort, cannot fetch another record, and cannot choose a
 *    namespace or a generation, because {@link StoreDispatchResult} has no field
 *    for any of those and the record is resolved BY CAPABILITY HASH, never by a
 *    caller-supplied id ({@link StoreResultCannotName}).
 *  - the trusted PARENT bridge or Pi extension, which prepares, confirms, aborts
 *    and fetches, and which ALONE can promote a stored result to `consumed`.
 *
 * **Storing a result is not completing a dispatch.** `store_result` moves
 * `prepared → result-stored`. Only a separately authorized
 * `confirm_dispatch_completion`, carrying a native completion proof for the
 * EXPECTED child/run and the provenance the parent believes it launched, moves
 * `result-stored → consumed`. A native completion with no stored result aborts
 * `missing-result`; invalid stored output aborts `invalid-output` ATOMICALLY (the
 * record never passes through `result-stored`); and an abort WINS every
 * cancellation, native, or protocol failure — a later confirm is a terminal
 * conflict, not a promotion.
 *
 * **The store is a PORT, not an implementation.** {@link AttestationStore} is
 * injected; this module owns every decision and the store owns only namespaced
 * rows, compare-and-set, and lookups. The strict in-memory dummy lives in
 * {@link ./dispatchAttestationDummy}; the namespaced production adapters are
 * T720's ({@link DISPATCH_ATTESTATION_DEFERRED}).
 *
 * **Retention is bounded and lossy on purpose.** A terminal record keeps its
 * full envelope for {@link TERMINAL_ENVELOPE_RETENTION_MS} (24h). After that the
 * envelope COLLAPSES to an {@link AttestationTombstone} that retains only the
 * namespace, the idempotency key, the payload/attestation/terminal digests and
 * the timestamps — never the output, the capability hash, the completion proof,
 * the prompt or catalog digest, the schema, or the abort reason body. The
 * tombstone itself is dropped at {@link IDEMPOTENCY_HORIZON_MS} (30d), after
 * which the key is reusable and the lookup answers `attestation-not-found`.
 *
 * Both boundaries are decided at OPERATION time, never by a sweep: a sweep only
 * reclaims storage. In particular a row past the 30d horizon that no sweep has
 * dropped yet does not hold its idempotency key — `prepare_dispatch` reclaims it
 * in the same unit of work that reuses the key, so a durable UNIQUE constraint on
 * `(namespace, idempotencyKey)` can never refuse an insert this module has
 * authorized (T720; see `resolveIdempotencyKeyReclaim`).
 *
 * The clock is injected as `now: () => string` (ISO-8601 UTC), the pattern the
 * surrounding store code already uses (`AbstractLedgerStore`, `FsPersistence`,
 * `InMemoryLedgerStore`), so every deadline, expiry and sweep boundary is driven
 * by a fake clock in tests.
 *
 * This module calls {@link validateDispatchInput} (Ajv), `Bun.CryptoHasher` and
 * `node:crypto`, and is therefore NOT browser-bundleable — like
 * {@link ./validation}, {@link ./dispatchOverlays},
 * {@link ./dispatchInputValidation} and {@link ./dispatchRefAssembly}.
 */

import { timingSafeEqual } from "node:crypto";
import { DISPATCHED_ROLE_SIDECARS } from "./promptCatalogStore.js";
import { IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS } from "./schemas/implement-reviewer.js";
import { implementWorkerStagedOutputSchema } from "./schemas/implement-worker.js";
import { validateAgainstSchema, type ValidationError } from "./validation.js";
import { LEDGER_BACKENDS, type LedgerBackend } from "./types.js";
import { DispatchOverlayError, type DispatchOverlayRegistry } from "./dispatchOverlays.js";
import {
  dispatchPreLaunchRejection,
  validateDispatchInput,
  assertValidateThenAllocate,
  DispatchInputValidationError,
  type DispatchPreLaunchRejection,
  type DispatchPrepareStep,
} from "./dispatchInputValidation.js";
import { canonicalDispatchInputBytes, DispatchRefAssemblyError } from "./dispatchRefAssembly.js";
import {
  DISPATCH_ABORT_REASONS,
  DISPATCH_PROTOCOL_OPERATIONS,
  type AbortDispatch,
  type AbortedDispatchResult,
  type ConsumedDispatchResult,
  type DispatchAbortReason,
  type DispatchDeadlines,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchOverlayApplication,
  type DispatchPrepared,
  type DispatchPromptProvenance,
  type DispatchProtocolOperation,
  type FetchDispatchResult,
  type FetchDispatchInput,
  type InputCapability,
  type GitChangeCapability,
  type GitConflictCapability,
  type MaterializedDispatchInput,
  type NativeCompletionProof,
  type ParentGateCapability,
  type ResultCapability,
  type StoreDispatchResult,
} from "./compactDispatchProtocol.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ATTESTATION_ID_RE = /^att_[A-Za-z0-9_-]{32,}$/;
const INPUT_CAPABILITY_RE = /^cq_input_[A-Za-z0-9_-]{43,}$/;
const RESULT_CAPABILITY_RE = /^cq_result_[A-Za-z0-9_-]{43,}$/;
const PARENT_GATE_CAPABILITY_RE = /^cq_parent_gate_[A-Za-z0-9_-]{43,}$/;
const GIT_CHANGE_CAPABILITY_RE = /^cq_git_[A-Za-z0-9_-]{43,}$/;
const GIT_CONFLICT_CAPABILITY_RE = /^cq_conflict_[A-Za-z0-9_-]{43,}$/;
const DISPATCH_RECOVERY_REFERENCE_RE = /^cq-dispatch-recovery:v1:[0-9a-f]{64}$/;
const DISPATCH_CONTINUATION_REFERENCE_RE = /^cq-dispatch-continuation:v1:[0-9a-f]{64}$/;
const IMPLEMENTATION_EVIDENCE_BOOTSTRAP_REFERENCE_RE =
  /^cq-implementation-evidence-bootstrap:v1:[0-9a-f]{64}$/;
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

// ---------------------------------------------------------------------------
// Explicit error classes — none of these is ever a lifecycle state
// ---------------------------------------------------------------------------

/**
 * An authoring defect in an attestation declaration: a malformed minted id or
 * capability, a non-JSON payload, an unparseable clock reading, a malformed
 * handle at the boundary. Distinct from every failure below, which describes a
 * legitimate caller doing something it is not authorized or able to do.
 */
export class AttestationContractError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "AttestationContractError";
  }
}

/** A record was reached from outside its `{backend,projectKey}` namespace. */
export class AttestationNamespaceError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AttestationNamespaceError";
  }
}

/**
 * The caller does not hold the authorization the operation requires: an unknown
 * or foreign result capability, a capability used for anything but
 * `store_result`, or an untrusted actor claiming a native completion.
 */
export class DispatchAuthorizationError extends Error {
  readonly operation: DispatchProtocolOperation;

  constructor(operation: DispatchProtocolOperation, detail: string) {
    super(`${operation}: ${detail}`);
    this.name = "DispatchAuthorizationError";
    this.operation = operation;
  }
}

/**
 * The trusted caller is authorized but is not confirming the dispatch it
 * launched: a mismatched child/run identity, or a role/version/prompt/input
 * digest that is not the one bound at prepare.
 */
export class AttestationBindingError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "AttestationBindingError";
    this.field = field;
  }
}

/** The addressed attestation generation does not exist in this namespace. */
export class AttestationNotFoundError extends Error {
  constructor(handle: DispatchHandle) {
    super(`no attestation "${handle.attestationId}" at generation ${handle.generation}`);
    this.name = "AttestationNotFoundError";
  }
}

/**
 * The operation conflicts with the record's current state: a second differing
 * store/confirm/abort, an operation on a terminal record, or a re-prepare of a
 * live generation. An IDENTICAL retry is idempotent and never raises this.
 */
export class DispatchStateConflictError extends Error {
  readonly operation: DispatchProtocolOperation;
  readonly state: AttestationEnvelopeState | "terminal-envelope-expired";

  constructor(
    operation: DispatchProtocolOperation,
    state: AttestationEnvelopeState | "terminal-envelope-expired",
    detail: string,
  ) {
    super(`${operation}: ${detail}`);
    this.name = "DispatchStateConflictError";
    this.operation = operation;
    this.state = state;
  }
}

/** The store refused a write: a key conflict, a lost update, a missing row. */
export class AttestationStorageError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AttestationStorageError";
  }
}

/** The store could not be reached. Never degraded into a lifecycle state. */
export class AttestationTransportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AttestationTransportError";
  }
}

/** An idempotency key was reused inside {@link IDEMPOTENCY_HORIZON_MS}. */
export class AttestationKeyReuseError extends AttestationStorageError {
  readonly existing: DispatchHandle;

  constructor(idempotencyKey: string, existing: DispatchHandle) {
    super(
      `idempotency key "${idempotencyKey}" is still held by attestation ` +
        `"${existing.attestationId}" generation ${existing.generation}`,
    );
    this.name = "AttestationKeyReuseError";
    this.existing = existing;
  }
}

export type DispatchRecoveryFailureReason =
  "not-found" | "ambiguous" | "nonterminal" | "unbound" | "expired" | "binding-mismatch";

/** A terminal recovery reference is absent, ambiguous, expired, or no longer exact. */
export class DispatchRecoveryError extends Error {
  readonly reason: DispatchRecoveryFailureReason;

  constructor(reason: DispatchRecoveryFailureReason, detail: string) {
    super(detail);
    this.name = "DispatchRecoveryError";
    this.reason = reason;
  }
}

export type DispatchContinuationFailureReason =
  | "not-found"
  | "ambiguous"
  | "nonterminal"
  | "non-consumed"
  | "unbound"
  | "expired"
  | "binding-mismatch"
  | "unauthorized-lineage"
  | "already-claimed";

/** A consumed continuation reference is absent, stale, foreign, or already spent. */
export class DispatchContinuationError extends Error {
  readonly reason: DispatchContinuationFailureReason;

  constructor(reason: DispatchContinuationFailureReason, detail: string) {
    super(detail);
    this.name = "DispatchContinuationError";
    this.reason = reason;
  }
}

/**
 * Every error class that can escape a dispatch service call as a DECISION about
 * the dispatch, rather than as a failure of the underlying store.
 *
 * It is deliberately not just this module's own classes. A unit of work runs
 * `prepareDispatch` (hence T976's step-order and input validation, and T684's
 * overlay validation) and digests payloads through T978's canonicalizer, so
 * {@link DispatchInputValidationError}, {@link DispatchOverlayError} and
 * {@link DispatchRefAssemblyError} can all surface from inside a transaction too.
 * Every one of them is a statement about the REQUEST, and an adapter that
 * rewrote it as "the store is unreachable" would be as wrong as it was for the
 * classes below.
 *
 * An adapter that must tell "the SERVICE decided this" from "the DRIVER failed"
 * tests against this list rather than enumerating classes at its own call site,
 * so adding a class here cannot silently leave an adapter misclassifying it.
 */
export const ATTESTATION_ERROR_CLASSES = Object.freeze([
  AttestationContractError,
  AttestationNamespaceError,
  DispatchAuthorizationError,
  AttestationBindingError,
  AttestationNotFoundError,
  DispatchStateConflictError,
  AttestationStorageError,
  AttestationTransportError,
  AttestationKeyReuseError,
  DispatchRecoveryError,
  DispatchContinuationError,
  DispatchInputValidationError,
  DispatchOverlayError,
  DispatchRefAssemblyError,
] as const);

/**
 * Whether `error` is one this module raised — a decision about the DISPATCH — as
 * opposed to a failure of the underlying driver.
 *
 * WHY (defect D177): the PostgreSQL adapter wrapped its whole transaction body in
 * a classifier, because `Bun.sql`'s `pool.begin` is the only place a driver error
 * can surface for that backend. The classifier passed through only
 * {@link AttestationStorageError} and {@link AttestationTransportError}, so every
 * OTHER decision the service made inside the unit of work — a foreign namespace,
 * an unauthorized capability, a state conflict, a binding mismatch, a missing
 * record, a malformed handle — was rewritten as "postgres attestation store
 * unreachable". That inverts this module's central promise and leaves a parent
 * unable to distinguish "retry, the store is down" from "you are not authorized".
 * The bun:sqlite and filesystem adapters never had it: they classify at
 * individual query sites, where only driver errors can appear.
 */
export function isAttestationDomainError(error: unknown): boolean {
  return ATTESTATION_ERROR_CLASSES.some((errorClass) => error instanceof errorClass);
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

/**
 * The trusted namespace every attestation record is created in and reached
 * through. A store is bound to exactly ONE namespace; the child never names it
 * (it has no field for it), and a row surfacing from another namespace is an
 * {@link AttestationNamespaceError}, never a lifecycle state.
 */
export type AttestationNamespaceBackend = LedgerBackend | "postgres";

export interface AttestationNamespace {
  readonly backend: AttestationNamespaceBackend;
  readonly projectKey: string;
}

const ATTESTATION_NAMESPACE_BACKEND_SET: ReadonlySet<string> = new Set([
  ...LEDGER_BACKENDS,
  "postgres",
]);

/**
 * Validate a namespace declaration. Set-based backend membership, so no
 * `Object.prototype` name passes as a backend.
 */
export function assertAttestationNamespace(
  namespace: AttestationNamespace,
  path = "namespace",
): AttestationNamespace {
  const backend: unknown = namespace?.backend;
  if (typeof backend !== "string" || !ATTESTATION_NAMESPACE_BACKEND_SET.has(backend)) {
    throw new AttestationContractError(
      `${path}.backend`,
      `unknown ledger backend "${String(backend)}"`,
    );
  }
  const projectKey: unknown = namespace.projectKey;
  if (typeof projectKey !== "string" || !PROJECT_KEY_RE.test(projectKey)) {
    throw new AttestationContractError(
      `${path}.projectKey`,
      `expected a project key, got "${String(projectKey)}"`,
    );
  }
  return Object.freeze({ backend: backend as AttestationNamespaceBackend, projectKey });
}

/** Whether two namespaces are the same `{backend,projectKey}` pair. */
export function attestationNamespacesEqual(
  a: AttestationNamespace,
  b: AttestationNamespace,
): boolean {
  return a.backend === b.backend && a.projectKey === b.projectKey;
}

/** The canonical `<backend>:<projectKey>` spelling of a namespace. */
export function formatAttestationNamespace(namespace: AttestationNamespace): string {
  return `${namespace.backend}:${namespace.projectKey}`;
}

function assertSameNamespace(bound: AttestationNamespace, row: AttestationRow): void {
  if (!attestationNamespacesEqual(bound, row.namespace)) {
    throw new AttestationNamespaceError(
      `attestation "${row.attestationId}" belongs to namespace ` +
        `${formatAttestationNamespace(row.namespace)}, not ${formatAttestationNamespace(bound)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Retention, timing and entropy constants
// ---------------------------------------------------------------------------

/** A terminal record keeps its FULL envelope for 24h after going terminal. */
export const TERMINAL_ENVELOPE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A collapsed tombstone — and therefore its idempotency key — lives 30d. */
export const IDEMPOTENCY_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** The shortest dispatch timeout prepare accepts. */
export const DISPATCH_TIMEOUT_MIN_MS = 60 * 1000;

/** The longest dispatch timeout prepare accepts. */
export const DISPATCH_TIMEOUT_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How far before `childCancelAt` the child is told to store its result. Strictly
 * less than {@link DISPATCH_TIMEOUT_MIN_MS}, so `responseStoreNow` is always
 * after prepare and before `childCancelAt`.
 */
export const RESPONSE_STORE_LEAD_MS = 30 * 1000;

/** How long after prepare the parent has to launch the child. */
export const LAUNCH_DEADLINE_MS = 60 * 1000;

/** Reserved after review work ends so the reviewer can synthesize and store its verdict. */
export const IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS = 60 * 1000;

/** The first timeout that leaves an implement-reviewer a non-negative review phase. */
export const IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS =
  LAUNCH_DEADLINE_MS + RESPONSE_STORE_LEAD_MS + IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS;

export { IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS };

/** Entropy behind a minted attestation id. */
export const ATTESTATION_ID_ENTROPY_BYTES = 24;

/** Entropy behind a minted result capability token. */
export const RESULT_CAPABILITY_ENTROPY_BYTES = 32;

/** Entropy behind the parent-only supervised-gate capability. */
export const PARENT_GATE_CAPABILITY_ENTROPY_BYTES = 32;

/** Entropy behind a minted assembled-input capability token. */
export const INPUT_CAPABILITY_ENTROPY_BYTES = 32;

/** Entropy behind the implement-worker Git change capability. */
export const GIT_CHANGE_CAPABILITY_ENTROPY_BYTES = 32;
export const GIT_CONFLICT_CAPABILITY_ENTROPY_BYTES = 32;

// ---------------------------------------------------------------------------
// Authorization scopes — the distinct privileges the operations require
// ---------------------------------------------------------------------------

export const DISPATCH_AUTHORIZATION_SCOPES = [
  "input-capability",
  "result-capability",
  "trusted-parent",
  "git-effect-capability",
] as const;

export type DispatchAuthorizationScope = (typeof DISPATCH_AUTHORIZATION_SCOPES)[number];

/** The trusted actors that may claim a native completion or abort a dispatch. */
export const TRUSTED_DISPATCH_ACTORS = ["trusted-parent", "trusted-extension"] as const;

export type TrustedDispatchActor = (typeof TRUSTED_DISPATCH_ACTORS)[number];

const TRUSTED_ACTOR_SET: ReadonlySet<string> = new Set(TRUSTED_DISPATCH_ACTORS);

/** The parent service is the sole claimant for managed-worker continuations. */
export const TRUSTED_DISPATCH_CONTINUATION_CLAIMANTS = ["trusted-parent"] as const;

export type TrustedDispatchContinuationClaimant =
  (typeof TRUSTED_DISPATCH_CONTINUATION_CLAIMANTS)[number];

const TRUSTED_CONTINUATION_CLAIMANT_SET: ReadonlySet<string> = new Set(
  TRUSTED_DISPATCH_CONTINUATION_CLAIMANTS,
);

/**
 * Which authorization scope each ordinary-flow operation requires, as a Map so
 * no `Object.prototype` name resolves a scope.
 */
export const DISPATCH_OPERATION_AUTHORIZATION: ReadonlyMap<
  DispatchProtocolOperation,
  DispatchAuthorizationScope
> = new Map([
  ["prepare_dispatch", "trusted-parent"],
  ["fetch_dispatch_input", "input-capability"],
  ["store_result", "result-capability"],
  ["confirm_dispatch_completion", "trusted-parent"],
  ["abort_dispatch", "trusted-parent"],
  ["fetch_dispatch_result", "trusted-parent"],
  ["git_commit", "git-effect-capability"],
  ["git_resolve_continue", "git-effect-capability"],
] as const);

/**
 * The operations a result capability authorizes. EXACTLY ONE: a child that can
 * store a result can do nothing else with that capability.
 */
export const RESULT_CAPABILITY_OPERATIONS = ["store_result"] as const;

const RESULT_CAPABILITY_OPERATION_SET: ReadonlySet<string> = new Set(RESULT_CAPABILITY_OPERATIONS);

/** The one operation an assembled-input capability authorizes. */
export const INPUT_CAPABILITY_OPERATIONS = ["fetch_dispatch_input"] as const;

export const GIT_CHANGE_CAPABILITY_OPERATIONS = ["git_commit"] as const;
export const GIT_CONFLICT_CAPABILITY_OPERATIONS = ["git_resolve_continue"] as const;

const INPUT_CAPABILITY_OPERATION_SET: ReadonlySet<string> = new Set(INPUT_CAPABILITY_OPERATIONS);
const GIT_CHANGE_CAPABILITY_OPERATION_SET: ReadonlySet<string> = new Set(
  GIT_CHANGE_CAPABILITY_OPERATIONS,
);
const GIT_CONFLICT_CAPABILITY_OPERATION_SET: ReadonlySet<string> = new Set(
  GIT_CONFLICT_CAPABILITY_OPERATIONS,
);

/**
 * Module-load invariant: every declared ordinary-flow operation has exactly one
 * authorization scope, and the capability-scoped operations are precisely those
 * mapped to `result-capability`. Declaring an operation without a scope — or
 * widening what a capability authorizes without saying so — fails at import
 * time rather than at a dispatch. Its value is the sorted covered operations.
 */
export function assertDispatchOperationAuthorization(
  operations: readonly string[],
  scopes: ReadonlyMap<string, DispatchAuthorizationScope>,
  inputCapabilityOperations: readonly string[],
  capabilityOperations: readonly string[],
  gitEffectCapabilityOperations: readonly string[] = [
    ...GIT_CHANGE_CAPABILITY_OPERATIONS,
    ...GIT_CONFLICT_CAPABILITY_OPERATIONS,
  ],
): readonly string[] {
  const declared = [...operations].sort();
  const scoped = [...scopes.keys()].sort();
  if (declared.join(",") !== scoped.join(",")) {
    throw new AttestationContractError(
      "DISPATCH_OPERATION_AUTHORIZATION",
      `declared operations [${declared.join(", ")}] do not match the scoped operations [${scoped.join(", ")}]`,
    );
  }
  const capabilityScoped = [...scopes.entries()]
    .filter(([, scope]) => scope === "result-capability")
    .map(([operation]) => operation)
    .sort();
  if (capabilityScoped.join(",") !== [...capabilityOperations].sort().join(",")) {
    throw new AttestationContractError(
      "RESULT_CAPABILITY_OPERATIONS",
      `capability-scoped operations [${capabilityScoped.join(", ")}] do not match the declared ` +
        `capability operations [${[...capabilityOperations].join(", ")}]`,
    );
  }
  const inputCapabilityScoped = [...scopes.entries()]
    .filter(([, scope]) => scope === "input-capability")
    .map(([operation]) => operation)
    .sort();
  if (inputCapabilityScoped.join(",") !== [...inputCapabilityOperations].sort().join(",")) {
    throw new AttestationContractError(
      "INPUT_CAPABILITY_OPERATIONS",
      `input-capability-scoped operations [${inputCapabilityScoped.join(", ")}] do not match the ` +
        `declared input capability operations [${[...inputCapabilityOperations].join(", ")}]`,
    );
  }
  const gitEffectScoped = [...scopes.entries()]
    .filter(([, scope]) => scope === "git-effect-capability")
    .map(([operation]) => operation)
    .sort();
  if (gitEffectScoped.join(",") !== [...gitEffectCapabilityOperations].sort().join(",")) {
    throw new AttestationContractError(
      "GIT_CHANGE_CAPABILITY_OPERATIONS",
      `git-effect-capability operations [${gitEffectScoped.join(", ")}] do not match the declared ` +
        `Git effect operations [${[...gitEffectCapabilityOperations].join(", ")}]`,
    );
  }
  return Object.freeze(scoped);
}

export const DISPATCH_OPERATION_AUTHORIZATION_COVERAGE: readonly string[] =
  assertDispatchOperationAuthorization(
    DISPATCH_PROTOCOL_OPERATIONS,
    DISPATCH_OPERATION_AUTHORIZATION,
    INPUT_CAPABILITY_OPERATIONS,
    RESULT_CAPABILITY_OPERATIONS,
    [...GIT_CHANGE_CAPABILITY_OPERATIONS, ...GIT_CONFLICT_CAPABILITY_OPERATIONS],
  );

/** The scope one operation requires. Throws for anything undeclared. */
export function dispatchOperationScope(operation: string): DispatchAuthorizationScope {
  const scope = DISPATCH_OPERATION_AUTHORIZATION.get(operation as DispatchProtocolOperation);
  if (scope === undefined) {
    throw new AttestationContractError(
      "operation",
      `unknown dispatch operation "${String(operation)}"`,
    );
  }
  return scope;
}

/** Whether a result capability authorizes `operation`. Set-based. */
export function resultCapabilityAuthorizes(operation: string): boolean {
  return typeof operation === "string" && RESULT_CAPABILITY_OPERATION_SET.has(operation);
}

/** Whether an input capability authorizes `operation`. Set-based. */
export function inputCapabilityAuthorizes(operation: string): boolean {
  return typeof operation === "string" && INPUT_CAPABILITY_OPERATION_SET.has(operation);
}

export function gitChangeCapabilityAuthorizes(operation: string): boolean {
  return typeof operation === "string" && GIT_CHANGE_CAPABILITY_OPERATION_SET.has(operation);
}

export function gitConflictCapabilityAuthorizes(operation: string): boolean {
  return typeof operation === "string" && GIT_CONFLICT_CAPABILITY_OPERATION_SET.has(operation);
}

/**
 * Compile-time proof that a result capability submission names NOTHING it must
 * not choose: no namespace, no attestation id, no generation, no abort reason,
 * and no native completion proof. The {@link Extract} must resolve to `never`;
 * adding any such field to {@link StoreDispatchResult} breaks `tsc`.
 */
type NeverOnly<T extends never> = T;
export type StoreResultCannotName = NeverOnly<
  Extract<
    keyof StoreDispatchResult,
    "namespace" | "attestationId" | "generation" | "reason" | "nativeCompletion" | "details"
  >
>;

// ---------------------------------------------------------------------------
// Digests, capability minting, constant-time comparison
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Lowercase hex SHA-256 over T978's canonical input bytes. One canonicalizer
 * serves the input, the stored output and the abort details, so two payloads
 * with the same content always digest identically regardless of key order.
 */
export function dispatchPayloadDigest(payload: DispatchJSONValue): string {
  return sha256Hex(canonicalDispatchInputBytes(payload));
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Utf8(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

/**
 * The stored hash of a result capability. The raw token is NEVER persisted, so
 * a compromised store yields no usable capability.
 */
export function resultCapabilityHash(token: string): string {
  if (typeof token !== "string" || !RESULT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "resultCapability.token",
      "expected a minted result capability token",
    );
  }
  return sha256Utf8(token);
}

export function parentGateCapabilityHash(token: string): string {
  if (typeof token !== "string" || !PARENT_GATE_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "parentGateCapability.token",
      "expected a minted parent gate capability token",
    );
  }
  return sha256Utf8(token);
}

/** The stored hash of an assembled-input capability. The raw token is never persisted. */
export function inputCapabilityHash(token: string): string {
  if (typeof token !== "string" || !INPUT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "inputCapability.token",
      "expected a minted input capability token",
    );
  }
  return sha256Utf8(token);
}

export function gitChangeCapabilityHash(token: string): string {
  if (typeof token !== "string" || !GIT_CHANGE_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "gitChangeCapability.token",
      "expected a minted Git change capability token",
    );
  }
  return sha256Utf8(token);
}

export function gitConflictCapabilityHash(token: string): string {
  if (typeof token !== "string" || !GIT_CONFLICT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "gitConflictCapability.token",
      "expected a minted Git conflict capability token",
    );
  }
  return sha256Utf8(token);
}

/**
 * Constant-time comparison of a presented capability against a STORED HASH
 * (Q273's pattern: hash first, then `timingSafeEqual` over two fixed 32-byte
 * digests, so neither length nor byte position leaks). A malformed token or a
 * malformed stored hash is a format failure decided before any comparison.
 */
export function resultCapabilityMatches(token: string, storedHash: string): boolean {
  // A malformed stored hash is refused BEFORE any comparison: `hexBytes` would
  // otherwise hand `timingSafeEqual` a short buffer and throw. A malformed TOKEN
  // needs no branch of its own — it simply digests to something else and loses.
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(hexBytes(sha256Utf8(token)), hexBytes(storedHash));
}

export function parentGateCapabilityMatches(token: string, storedHash: string): boolean {
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) return false;
  return timingSafeEqual(hexBytes(sha256Utf8(token)), hexBytes(storedHash));
}

/** Constant-time confirmation of a presented input capability against its stored hash. */
export function inputCapabilityMatches(token: string, storedHash: string): boolean {
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(hexBytes(sha256Utf8(token)), hexBytes(storedHash));
}

export function gitChangeCapabilityMatches(token: string, storedHash: string): boolean {
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) return false;
  return timingSafeEqual(hexBytes(sha256Utf8(token)), hexBytes(storedHash));
}

export function gitConflictCapabilityMatches(token: string, storedHash: string): boolean {
  if (typeof storedHash !== "string" || !SHA256_HEX.test(storedHash)) return false;
  return timingSafeEqual(hexBytes(sha256Utf8(token)), hexBytes(storedHash));
}

/** Decode a validated lowercase-hex digest to its 32 raw bytes. */
function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) {
      break;
    }
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) {
      break;
    }
    out += BASE64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

/** The injected entropy source. Returns exactly `count` random bytes. */
export type DispatchRandomBytes = (count: number) => Uint8Array;

/** The production entropy source. */
export function defaultDispatchRandomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

function drawEntropy(randomBytes: DispatchRandomBytes, count: number, path: string): Uint8Array {
  const bytes = randomBytes(count);
  if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
    throw new AttestationContractError(path, `expected ${count} bytes of entropy`);
  }
  return bytes;
}

/** Mint a fresh attestation id from {@link ATTESTATION_ID_ENTROPY_BYTES}. */
export function mintAttestationId(randomBytes: DispatchRandomBytes): string {
  const id = `att_${base64url(drawEntropy(randomBytes, ATTESTATION_ID_ENTROPY_BYTES, "attestationId"))}`;
  if (!ATTESTATION_ID_RE.test(id)) {
    throw new AttestationContractError(
      "attestationId",
      `minted a malformed attestation id "${id}"`,
    );
  }
  return id;
}

/**
 * Mint a fresh high-entropy result capability from
 * {@link RESULT_CAPABILITY_ENTROPY_BYTES}. Scope is pinned to `store-result` —
 * there is no other scope to mint.
 */
export function mintResultCapability(randomBytes: DispatchRandomBytes): ResultCapability {
  const token = `cq_result_${base64url(
    drawEntropy(randomBytes, RESULT_CAPABILITY_ENTROPY_BYTES, "resultCapability.token"),
  )}`;
  if (!RESULT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "resultCapability.token",
      `minted a malformed capability "${token}"`,
    );
  }
  return Object.freeze({ scope: "store-result" as const, token });
}

export function mintParentGateCapability(randomBytes: DispatchRandomBytes): ParentGateCapability {
  const token = `cq_parent_gate_${base64url(
    drawEntropy(randomBytes, PARENT_GATE_CAPABILITY_ENTROPY_BYTES, "parentGateCapability.token"),
  )}`;
  if (!PARENT_GATE_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "parentGateCapability.token",
      `minted a malformed capability "${token}"`,
    );
  }
  return Object.freeze({ scope: "parent-gate" as const, token });
}

/** Mint a fresh one-shot input capability, distinct from result submission. */
export function mintInputCapability(randomBytes: DispatchRandomBytes): InputCapability {
  const token = `cq_input_${base64url(
    drawEntropy(randomBytes, INPUT_CAPABILITY_ENTROPY_BYTES, "inputCapability.token"),
  )}`;
  if (!INPUT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "inputCapability.token",
      `minted a malformed capability "${token}"`,
    );
  }
  return Object.freeze({ scope: "fetch-input" as const, token });
}

export function mintGitChangeCapability(randomBytes: DispatchRandomBytes): GitChangeCapability {
  const token = `cq_git_${base64url(
    drawEntropy(randomBytes, GIT_CHANGE_CAPABILITY_ENTROPY_BYTES, "gitChangeCapability.token"),
  )}`;
  if (!GIT_CHANGE_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "gitChangeCapability.token",
      `minted a malformed capability "${token}"`,
    );
  }
  return Object.freeze({ scope: "git-change" as const, token });
}

export function mintGitConflictCapability(randomBytes: DispatchRandomBytes): GitConflictCapability {
  const token = `cq_conflict_${base64url(
    drawEntropy(randomBytes, GIT_CONFLICT_CAPABILITY_ENTROPY_BYTES, "gitConflictCapability.token"),
  )}`;
  if (!GIT_CONFLICT_CAPABILITY_RE.test(token)) {
    throw new AttestationContractError(
      "gitConflictCapability.token",
      `minted a malformed capability "${token}"`,
    );
  }
  return Object.freeze({ scope: "git-conflict" as const, token });
}

// ---------------------------------------------------------------------------
// Rows: the live envelope and the collapsed tombstone
// ---------------------------------------------------------------------------

/** The four states a LIVE attestation envelope can hold. */
export const ATTESTATION_ENVELOPE_STATES = [
  "prepared",
  "gate-pending",
  "gate-running",
  "result-stored",
  "consumed",
  "aborted",
] as const;

export type AttestationEnvelopeState = (typeof ATTESTATION_ENVELOPE_STATES)[number];

const TERMINAL_ENVELOPE_STATES = ["consumed", "aborted"] as const;

export type AttestationTerminalKind = (typeof TERMINAL_ENVELOPE_STATES)[number];

const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(TERMINAL_ENVELOPE_STATES);

/** The native child identity a confirmation must match. */
export interface NativeChildIdentity {
  readonly childId: string;
  readonly runId: string;
}

/**
 * What a confirming parent must prove it launched: the role contract and the
 * exact prompt and input digests bound at prepare. A mismatch on any of the four
 * is an {@link AttestationBindingError} — a parent can never confirm a dispatch
 * other than the one it launched.
 */
export interface DispatchProvenanceBinding {
  readonly roleId: string;
  readonly version: number;
  readonly promptDigest: string;
  readonly inputDigest: string;
}

/** Immutable broker receipt trusted across a terminal dispatch reprepare. */
export interface DispatchGitChangeReceipt {
  readonly kind: "cq-git-change-receipt";
  readonly version: 1;
  readonly attestationId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly oldHead: string;
  readonly newHead: string;
  readonly tree: string;
  readonly objectOids: readonly string[];
  readonly paths: readonly string[];
  readonly committedAt: string;
}

/**
 * The verified guarded-rebase bridge (D334/T2150), materialized ONLY by the
 * trusted manager from one terminal durable guarded-rebase journal. Callers
 * supply nothing but the opaque {@link DispatchGuardedRebaseBridge.guardedRebase}
 * reference at prepare; every other field is server-resolved and persisted
 * here so a restart, a backend round-trip, and the parent gate all see the
 * exact same bridge.
 */
export interface DispatchGuardedRebaseBridge {
  /** Opaque digest-backed reference: `cq-guarded-rebase:v1:<requestDigest>`. */
  readonly guardedRebase: string;
  /** The parent-supplied stable operation id the journal was minted under. */
  readonly operationId: string;
  /** SHA-256 over the canonical journaled guarded-rebase request. */
  readonly requestDigest: string;
  /** Exact terminal pre-rebase worker result tip the bridge replaces. */
  readonly oldResultCommit: string;
  /** Exact rebase target; the guarded dispatch's diff base. */
  readonly ontoCommit: string;
  /** Verified terminal rebased head; the guarded round's startingCommit. */
  readonly rebasedStartCommit: string;
  /** Clean rebases finalize from the live ref; conflicted ones only via receipts. */
  readonly outcome: "clean" | "conflicted";
  /**
   * Server-resolved permission for the no-new-commit arm: true only when the
   * clean replay carries the byte-identical change (equal stable patch-ids),
   * so resultCommit == rebasedStartCommit with an empty fresh suffix stays
   * indistinguishable from the approved pre-rebase result.
   */
  readonly exactTip: boolean;
  readonly finalizedAt: string;
}

/** Trusted resolver output for a live worktree_manage handle; never child-authored. */
export interface DispatchGitEffectBinding {
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly ref: string;
  readonly baseCommit: string;
  readonly conflictStateDigest?: string;
  /** Exact durable prefix inherited from prior terminal generations. */
  readonly inheritedGitReceipts?: readonly DispatchGitChangeReceipt[];
  /** Server-materialized guarded-rebase bridge (D334); never caller-authored. */
  readonly guardedRebaseBridge?: DispatchGuardedRebaseBridge;
}

/** Trusted live-Git evidence captured while the managed worktree effect lock is held. */
export interface DispatchRecoveryContext {
  readonly liveTip: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
}

/** Trusted live-Git evidence captured while the continuation effect lock is held. */
export type DispatchContinuationContext = DispatchRecoveryContext;

/**
 * Terminal source authority retained for current-recovery sealing.  The
 * discriminator is persisted instead of rediscovering a failure from a
 * caller-provided result after the terminal envelope has collapsed.
 */
export type DispatchCurrentRecoverySource =
  | {
      readonly kind: "aborted";
      readonly version: 1;
      readonly abortReason: DispatchAbortReason;
    }
  | {
      readonly kind: "consumed-fail";
      readonly version: 1;
      readonly status: "fail";
    };

/**
 * Durable authority for one parent-lost implement-worker generation. The
 * reference is public and opaque; this server-held association is the authority.
 */
export interface DispatchRecoveryBinding {
  readonly kind: "cq-dispatch-recovery-binding";
  readonly version: 1;
  readonly recoveryReference: string;
  readonly attestationId: string;
  readonly generation: number;
  readonly terminalDigest: string;
  readonly terminalAt: string;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly implementationEvidenceBootstrapRef?: string;
}

/** Trusted resolution used internally by reprepare; public callers receive only its projection. */
export interface ResolvedDispatchRecovery {
  readonly recoveryReference: string;
  readonly reprepareOf: DispatchHandle;
  readonly terminalAt: string;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly implementationEvidenceBootstrapRef?: string;
}

/** The trusted parent lineage authorized to continue one consumed worker generation. */
export interface DispatchContinuationCallerLineage extends NativeChildIdentity {
  readonly actor: TrustedDispatchActor;
}

/** Durable, single-use continuation authority for one consumed managed worker. */
export interface DispatchContinuationBinding {
  readonly kind: "cq-dispatch-continuation-binding";
  readonly version: 1;
  readonly continuationReference: string;
  readonly attestationId: string;
  readonly generation: number;
  readonly terminalDigest: string;
  readonly terminalAt: string;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly implementationEvidenceBootstrapRef?: string;
  /** Present only when the server-validated consumed worker output was a failure. */
  readonly currentRecoverySource?: DispatchCurrentRecoverySource;
  readonly callerLineage: DispatchContinuationCallerLineage;
}

/** The successor row is itself the atomic, durable claim on the opaque association. */
export interface DispatchContinuationSourceClaim {
  readonly continuationReference: string;
  readonly source: DispatchHandle;
}

/** Trusted resolution used internally by prepare; public callers receive an opaque projection. */
export interface ResolvedDispatchContinuation {
  readonly continuationReference: string;
  readonly reprepareOf: DispatchHandle;
  readonly terminalAt: string;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
  readonly gitReceipts: readonly DispatchGitChangeReceipt[];
  readonly implementationEvidenceBootstrapRef?: string;
}

/** Server-only continuation claim carried into the allocation transaction. */
export interface DispatchContinuationClaim {
  readonly continuationReference: string;
  readonly actor: TrustedDispatchContinuationClaimant;
  readonly liveTip: string;
}

export interface AuthorizedDispatchGitEffect extends DispatchGitEffectBinding {
  readonly attestationId: string;
  readonly generation: number;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly surface: string;
  readonly childCancelAt: string;
}

/** Trusted server-side context for one Codex implement-worker gate supervision. */
export interface AuthorizedSupervisedWorkerGateContext extends AuthorizedDispatchGitEffect {
  readonly roleId: "implement-worker";
  readonly surface: "codex";
  readonly promptProvenance: DispatchPromptProvenance;
  readonly dispatchBaseCommit: string;
  readonly startingCommit: string;
}

function gitEffectBindingPayload(binding: DispatchGitEffectBinding): DispatchJSONValue {
  return {
    taskId: binding.taskId,
    handleToken: binding.handleToken,
    handleFingerprint: binding.handleFingerprint,
    repositoryRoot: binding.repositoryRoot,
    repositoryId: binding.repositoryId,
    commonDir: binding.commonDir,
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    ref: binding.ref,
    baseCommit: binding.baseCommit,
    ...(binding.conflictStateDigest === undefined
      ? {}
      : { conflictStateDigest: binding.conflictStateDigest }),
    ...(binding.inheritedGitReceipts === undefined
      ? {}
      : {
          inheritedGitReceipts: binding.inheritedGitReceipts as unknown as DispatchJSONValue,
        }),
    ...(binding.guardedRebaseBridge === undefined
      ? {}
      : {
          guardedRebaseBridge: {
            guardedRebase: binding.guardedRebaseBridge.guardedRebase,
            operationId: binding.guardedRebaseBridge.operationId,
            requestDigest: binding.guardedRebaseBridge.requestDigest,
            oldResultCommit: binding.guardedRebaseBridge.oldResultCommit,
            ontoCommit: binding.guardedRebaseBridge.ontoCommit,
            rebasedStartCommit: binding.guardedRebaseBridge.rebasedStartCommit,
            outcome: binding.guardedRebaseBridge.outcome,
            exactTip: binding.guardedRebaseBridge.exactTip,
            finalizedAt: binding.guardedRebaseBridge.finalizedAt,
          },
        }),
  };
}

/** The full live record. This is what a store persists per generation. */
export interface AttestationEnvelope {
  readonly kind: "envelope";
  readonly namespace: AttestationNamespace;
  readonly attestationId: string;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly state: AttestationEnvelopeState;
  readonly promptProvenance: DispatchPromptProvenance;
  /** Digest of the complete prepare request, excluding the executable registry. */
  readonly prepareRequestDigest: string;
  /** Prepare-bound typed input, materialized to the child exactly once. */
  readonly input: DispatchJSONValue;
  /** Validated overlay applications in canonical registry order; capabilities are never present. */
  readonly overlays: readonly DispatchOverlayApplication[];
  readonly deadlines: DispatchDeadlines;
  readonly expectedChild: NativeChildIdentity;
  /** HASH of the one-shot input capability. The token itself is never stored. */
  readonly inputCapabilityHash: string;
  readonly inputMaterializedAt?: string;
  /** The HASH of the minted capability. The token itself is never stored. */
  readonly resultCapabilityHash: string;
  /** Parent-only finalization authority; present only for supervised Codex workers. */
  readonly parentGateCapabilityHash?: string;
  readonly gitChangeCapabilityHash?: string;
  readonly gitConflictCapabilityHash?: string;
  readonly gitEffectBinding?: DispatchGitEffectBinding;
  /** Server-bound historical-evidence bootstrap authority, never materialized to the child. */
  readonly implementationEvidenceBootstrapRef?: string;
  readonly createdAt: string;
  readonly storedAt?: string;
  readonly gateSubmittedAt?: string;
  /** Digest of the child-staged payload, retained after the parent adds gate evidence. */
  readonly gateSubmittedOutputDigest?: string;
  readonly gateClaimedAt?: string;
  readonly gateEpoch?: number;
  readonly output?: DispatchJSONValue;
  readonly outputDigest?: string;
  readonly consumedAt?: string;
  /** Persisted one-shot marker written by the first successful fetch CAS. */
  readonly outputMaterializedAt?: string;
  readonly nativeCompletion?: NativeCompletionProof;
  readonly abortedAt?: string;
  readonly abortReason?: DispatchAbortReason;
  readonly abortDetails?: DispatchJSONValue;
  readonly abortDetailsDigest?: string;
  /** When the record went terminal — the clock the 24h/30d windows run from. */
  readonly terminalAt?: string;
  /** Digest binding the terminal outcome; survives the envelope collapse. */
  readonly terminalDigest?: string;
  /** Parent-lost recovery authority, persisted atomically with the terminal transition. */
  readonly dispatchRecoveryBinding?: DispatchRecoveryBinding;
  /** Consumed-worker continuation authority, persisted by the consuming compare-and-set. */
  readonly dispatchContinuationBinding?: DispatchContinuationBinding;
  /** Present only on the generation whose allocation claimed a consumed predecessor. */
  readonly dispatchContinuationClaim?: DispatchContinuationSourceClaim;
}

/**
 * A terminal record whose 24h envelope has expired. It retains the mandatory
 * identity/digest/timestamp fields and, only for an eligible parent-lost
 * worker, its explicit recovery authority. It deliberately drops the output,
 * capability hashes, completion proof, prompt/catalog digests, schema, and
 * abort-reason body. {@link TOMBSTONE_RETAINED_FIELDS} pins the mandatory set.
 */
export interface AttestationTombstone {
  readonly kind: "tombstone";
  readonly namespace: AttestationNamespace;
  readonly attestationId: string;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly terminalKind: AttestationTerminalKind;
  /** Digest of the dispatch payload — the input identity, not the input. */
  readonly inputDigest: string;
  /** Digest binding the terminal outcome, with no reason or output body. */
  readonly terminalDigest: string;
  readonly createdAt: string;
  readonly terminalAt: string;
  /** When the key becomes reusable: `terminalAt + IDEMPOTENCY_HORIZON_MS`. */
  readonly reuseAfter: string;
  /** Explicit recovery authority; an otherwise identical tombstone grants none. */
  readonly dispatchRecoveryBinding?: DispatchRecoveryBinding;
  /** Single-use consumed continuation authority retained to the idempotency horizon. */
  readonly dispatchContinuationBinding?: DispatchContinuationBinding;
  /** Retained so collapse cannot resurrect a predecessor's single-use authority. */
  readonly dispatchContinuationClaim?: DispatchContinuationSourceClaim;
}

export type AttestationRow = AttestationEnvelope | AttestationTombstone;

/** Mandatory fields every collapsed tombstone retains. */
export const TOMBSTONE_RETAINED_FIELDS = [
  "kind",
  "namespace",
  "attestationId",
  "generation",
  "idempotencyKey",
  "terminalKind",
  "inputDigest",
  "terminalDigest",
  "createdAt",
  "terminalAt",
  "reuseAfter",
] as const;

/**
 * What a collapsed tombstone must NEVER retain. Each entry is an envelope field
 * whose presence after expiry would defeat the retention clause.
 */
export const TOMBSTONE_FORBIDDEN_FIELDS = [
  "output",
  "outputDigest",
  "resultCapabilityHash",
  "parentGateCapabilityHash",
  "gitChangeCapabilityHash",
  "gitConflictCapabilityHash",
  "gitEffectBinding",
  "input",
  "overlays",
  "inputCapabilityHash",
  "inputMaterializedAt",
  "nativeCompletion",
  "abortReason",
  "abortDetails",
  "abortDetailsDigest",
  "promptProvenance",
  "prepareRequestDigest",
  "deadlines",
  "expectedChild",
  "state",
  "storedAt",
  "gateSubmittedAt",
  "gateSubmittedOutputDigest",
  "gateClaimedAt",
  "gateEpoch",
  "consumedAt",
  "outputMaterializedAt",
  "abortedAt",
] as const;

/** Runtime discriminator over the two row shapes. */
export function isAttestationTombstone(row: AttestationRow): row is AttestationTombstone {
  return row.kind === "tombstone";
}

/**
 * A row's content digest — the compare-and-set identity. Two rows with the same
 * content digest are the same revision, which makes CAS survive a restart-
 * equivalent rehydration where object identity does not.
 */
export function attestationRowDigest(row: AttestationRow): string {
  return dispatchPayloadDigest(row as unknown as DispatchJSONValue);
}

// ---------------------------------------------------------------------------
// The injected store port
// ---------------------------------------------------------------------------

/** One sweep's effect, for the caller that scheduled it. */
export interface AttestationSweepReport {
  readonly at: string;
  /** Handles whose 24h envelope collapsed to a tombstone in this sweep. */
  readonly envelopesCollapsed: readonly DispatchHandle[];
  /** Handles whose 30d tombstone was dropped in this sweep. */
  readonly tombstonesRemoved: readonly DispatchHandle[];
  readonly rowsRemaining: number;
}

/**
 * The persistence PORT for attestation records, bound to exactly ONE
 * {@link AttestationNamespace}. It owns rows, keys and compare-and-set — never a
 * lifecycle decision: every transition is decided by this module and handed to
 * `replace`.
 *
 * `read`, `readByCapabilityHash` and `readByIdempotencyKey` return `undefined`
 * / an empty list for an absent row rather than throwing, so absence can become
 * a typed lifecycle answer at the one place that is allowed to make it one
 * ({@link fetchDispatchResult}). Every WRITE refusal is an
 * {@link AttestationStorageError}; unreachability is an
 * {@link AttestationTransportError}.
 *
 * The strict dummy is {@link ./dispatchAttestationDummy}; the namespaced
 * production adapters are T720's.
 */
export interface AttestationStore {
  readonly namespace: AttestationNamespace;
  /** Insert a freshly prepared envelope. Refuses a duplicate handle or key. */
  insert(row: AttestationEnvelope): void;
  /** Read one row by `{attestationId,generation}`. */
  read(handle: DispatchHandle): AttestationRow | undefined;
  /** Resolve a row by STORED CAPABILITY HASH — the only child-facing lookup. */
  readByCapabilityHash(capabilityHash: string): AttestationRow | undefined;
  /** Every row holding `idempotencyKey`, live or tombstoned. */
  readByIdempotencyKey(idempotencyKey: string): readonly AttestationRow[];
  /** Compare-and-set. Refuses when the stored revision is not `expected`. */
  replace(expected: AttestationRow, next: AttestationRow): void;
  /** Drop a row entirely (only past the idempotency horizon). */
  remove(handle: DispatchHandle): void;
  /** Every row in this namespace, in insertion order. */
  rows(): readonly AttestationRow[];
}

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

/** The injected clock, matching the surrounding store pattern. */
export type DispatchNow = () => string;

/** Parse an ISO-8601 instant to epoch ms, failing loudly on garbage. */
export function attestationInstantMs(instant: string, path: string): number {
  const ms = typeof instant === "string" ? Date.parse(instant) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new AttestationContractError(
      path,
      `expected an ISO-8601 instant, got "${String(instant)}"`,
    );
  }
  return ms;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

interface Deps {
  readonly store: AttestationStore;
  readonly now: DispatchNow;
}

/** Deps shared by every trusted operation. */
export type DispatchServiceDeps = Deps;

/** Prepare additionally mints identity and capability. */
export interface PrepareDispatchDeps extends Deps {
  readonly randomBytes: DispatchRandomBytes;
  /**
   * The prepare step order actually executed. Defaults to
   * {@link DISPATCH_PREPARE_STEP_ORDER}; passing a scrambled order makes prepare
   * fail through T976's {@link assertValidateThenAllocate}.
   */
  readonly stepOrder?: readonly string[];
}

function readNow(deps: Deps): { readonly at: string; readonly atMs: number } {
  const at = deps.now();
  return { at, atMs: attestationInstantMs(at, "now") };
}

// ---------------------------------------------------------------------------
// prepare_dispatch
// ---------------------------------------------------------------------------

/**
 * What prepare needs. The role input arrives already assembled (T978) — this
 * module binds its digest, it does not re-derive it from refs.
 */
export interface PrepareDispatchRequest {
  readonly namespace: AttestationNamespace;
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly roleId: string;
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly surface: string;
  readonly input: DispatchJSONValue;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly registry: DispatchOverlayRegistry;
  /** The attested packaged-surface digests for this role (T683). */
  readonly promptDigest: string;
  readonly catalogHash: string;
  /** The native child/run the parent is about to launch. */
  readonly expectedChild: NativeChildIdentity;
  /** A TERMINAL prior generation being re-prepared (old-attestation isolation). */
  readonly reprepareOf?: DispatchHandle;
  /** Trusted, manager-resolved binding. Caller input can never supply this field. */
  readonly gitEffectBinding?: DispatchGitEffectBinding;
  /** Trusted, server-resolved claim; public callers can supply only the opaque reference. */
  readonly continuationClaim?: DispatchContinuationClaim;
  /** Trusted fence-authorized generation reservation; never contains the capability token. */
  readonly journalRecoveryReservation?: DispatchJournalRecoveryReservation;
  /** Protected historical-evidence bootstrap authority consumed by this prepare. */
  readonly implementationEvidenceBootstrapRef?: string;
}

export interface DispatchJournalRecoveryReservation {
  readonly fenceRef: string;
  readonly sourceAttestationId: string;
  readonly selectedSourceGeneration: number;
  readonly lineageMaximumGeneration: number;
}

/**
 * Canonical digest of every prepare field that can change the resulting
 * dispatch. The executable overlay registry is excluded; validated overlay ids
 * and data are included.
 */
export function prepareDispatchRequestDigest(request: PrepareDispatchRequest): string {
  return dispatchPayloadDigest({
    roleId: request.roleId,
    surface: request.surface,
    input: request.input,
    idempotencyKey: request.idempotencyKey,
    timeoutMs: request.timeoutMs,
    overlays:
      request.overlays?.map((overlay) => ({
        overlayId: overlay.overlayId,
        data: overlay.data,
      })) ?? [],
    promptDigest: request.promptDigest,
    catalogHash: request.catalogHash,
    expectedChild: {
      childId: request.expectedChild.childId,
      runId: request.expectedChild.runId,
    },
    reprepareOf:
      request.reprepareOf === undefined
        ? null
        : {
            attestationId: request.reprepareOf.attestationId,
            generation: request.reprepareOf.generation,
          },
    gitEffectBinding:
      request.gitEffectBinding === undefined
        ? null
        : gitEffectBindingPayload(request.gitEffectBinding),
    continuationClaim:
      request.continuationClaim === undefined
        ? null
        : {
            continuationReference: request.continuationClaim.continuationReference,
            actor: request.continuationClaim.actor,
            liveTip: request.continuationClaim.liveTip,
          },
    journalRecoveryReservation:
      request.journalRecoveryReservation === undefined
        ? null
        : {
            fenceRef: request.journalRecoveryReservation.fenceRef,
            sourceAttestationId: request.journalRecoveryReservation.sourceAttestationId,
            selectedSourceGeneration: request.journalRecoveryReservation.selectedSourceGeneration,
            lineageMaximumGeneration: request.journalRecoveryReservation.lineageMaximumGeneration,
          },
    implementationEvidenceBootstrapRef: request.implementationEvidenceBootstrapRef ?? null,
  });
}

/**
 * A successful prepare. `prepared` is exactly T682's
 * {@link DispatchPrepared} — the wire shape, unwidened — while the recorded
 * `executedStepOrder` is the operational proof that this call validated
 * everything before it allocated anything.
 */
export interface DispatchPrepareAccepted {
  readonly accepted: true;
  readonly prepared: DispatchPrepared;
  readonly handle: DispatchHandle;
  readonly executedStepOrder: readonly DispatchPrepareStep[];
}

export type PrepareDispatchOutcome = DispatchPrepareAccepted | DispatchPreLaunchRejection;

/** One-line summary of a validation failure, alongside the structured errors. */
function describeErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`)
    .join("; ");
}

function assertDigest(value: string, path: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new AttestationContractError(
      path,
      `expected a lowercase hex sha-256, got "${String(value)}"`,
    );
  }
  return value;
}

function assertChildIdentity(child: NativeChildIdentity, path: string): NativeChildIdentity {
  const childId: unknown = child?.childId;
  const runId: unknown = child?.runId;
  if (typeof childId !== "string" || childId.trim() === "") {
    throw new AttestationContractError(`${path}.childId`, "expected a non-empty native child id");
  }
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new AttestationContractError(`${path}.runId`, "expected a non-empty native run id");
  }
  return Object.freeze({ childId, runId });
}

function assertGitEffectBinding(
  binding: DispatchGitEffectBinding | undefined,
  roleId: string,
): DispatchGitEffectBinding | undefined {
  if (binding === undefined) return undefined;
  if (roleId !== "implement-worker" && roleId !== "implement-conflict-resolver") {
    throw new AttestationContractError(
      "gitEffectBinding",
      "only implement-worker or implement-conflict-resolver may receive a Git effect binding",
    );
  }
  for (const field of [
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
  ] as const) {
    if (typeof binding[field] !== "string" || binding[field].trim() === "") {
      throw new AttestationContractError(
        `gitEffectBinding.${field}`,
        "expected a non-empty string",
      );
    }
  }
  for (const field of ["handleFingerprint", "repositoryId"] as const) {
    assertDigest(binding[field], `gitEffectBinding.${field}`);
  }
  if (roleId === "implement-conflict-resolver") {
    if (binding.conflictStateDigest === undefined) {
      throw new AttestationContractError(
        "gitEffectBinding.conflictStateDigest",
        "implement-conflict-resolver requires a parent-observed conflict state digest",
      );
    }
    assertDigest(binding.conflictStateDigest, "gitEffectBinding.conflictStateDigest");
  } else if (binding.conflictStateDigest !== undefined) {
    throw new AttestationContractError(
      "gitEffectBinding.conflictStateDigest",
      "implement-worker cannot carry a conflict state digest",
    );
  }
  const inheritedGitReceipts = binding.inheritedGitReceipts;
  if (inheritedGitReceipts !== undefined) {
    if (roleId !== "implement-worker" || inheritedGitReceipts.length === 0) {
      throw new AttestationContractError(
        "gitEffectBinding.inheritedGitReceipts",
        "only implement-worker may carry a non-empty inherited receipt chain",
      );
    }
    for (const [index, receipt] of inheritedGitReceipts.entries()) {
      const path = `gitEffectBinding.inheritedGitReceipts[${String(index)}]`;
      if (receipt.kind !== "cq-git-change-receipt" || receipt.version !== 1) {
        throw new AttestationContractError(path, "expected a version-1 Git change receipt");
      }
      for (const field of ["attestationId", "taskId", "operationId", "committedAt"] as const) {
        if (typeof receipt[field] !== "string" || receipt[field].trim() === "") {
          throw new AttestationContractError(`${path}.${field}`, "expected a non-empty string");
        }
      }
      if (!Number.isInteger(receipt.generation) || receipt.generation < 1) {
        throw new AttestationContractError(`${path}.generation`, "expected a positive integer");
      }
      assertDigest(receipt.requestDigest, `${path}.requestDigest`);
      for (const field of ["oldHead", "newHead", "tree"] as const) {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt[field])) {
          throw new AttestationContractError(`${path}.${field}`, "expected a full Git object id");
        }
      }
      if (
        !Array.isArray(receipt.objectOids) ||
        !receipt.objectOids.every((oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) ||
        !Array.isArray(receipt.paths) ||
        !receipt.paths.every((entry) => typeof entry === "string" && entry.length > 0)
      ) {
        throw new AttestationContractError(path, "receipt objectOids or paths are malformed");
      }
    }
  }
  const guardedRebaseBridge = binding.guardedRebaseBridge;
  if (guardedRebaseBridge !== undefined) {
    if (roleId !== "implement-worker") {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge",
        "only implement-worker may carry a guarded-rebase bridge",
      );
    }
    if (
      typeof guardedRebaseBridge.guardedRebase !== "string" ||
      !/^cq-guarded-rebase:v1:[0-9a-f]{64}$/.test(guardedRebaseBridge.guardedRebase)
    ) {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge.guardedRebase",
        "expected an opaque cq-guarded-rebase:v1 reference",
      );
    }
    if (
      typeof guardedRebaseBridge.operationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(guardedRebaseBridge.operationId)
    ) {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge.operationId",
        "expected a stable operation id",
      );
    }
    assertDigest(
      guardedRebaseBridge.requestDigest,
      "gitEffectBinding.guardedRebaseBridge.requestDigest",
    );
    for (const field of ["oldResultCommit", "ontoCommit", "rebasedStartCommit"] as const) {
      if (!/^[0-9a-f]{40}$/.test(guardedRebaseBridge[field])) {
        throw new AttestationContractError(
          `gitEffectBinding.guardedRebaseBridge.${field}`,
          "expected a full commit SHA",
        );
      }
    }
    if (guardedRebaseBridge.outcome !== "clean" && guardedRebaseBridge.outcome !== "conflicted") {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge.outcome",
        "expected clean or conflicted",
      );
    }
    if (typeof guardedRebaseBridge.exactTip !== "boolean") {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge.exactTip",
        "expected a boolean",
      );
    }
    if (
      typeof guardedRebaseBridge.finalizedAt !== "string" ||
      guardedRebaseBridge.finalizedAt.trim() === ""
    ) {
      throw new AttestationContractError(
        "gitEffectBinding.guardedRebaseBridge.finalizedAt",
        "expected a non-empty string",
      );
    }
  }
  return Object.freeze({
    ...binding,
    ...(inheritedGitReceipts === undefined
      ? {}
      : { inheritedGitReceipts: Object.freeze([...inheritedGitReceipts]) }),
    ...(guardedRebaseBridge === undefined
      ? {}
      : { guardedRebaseBridge: Object.freeze({ ...guardedRebaseBridge }) }),
  });
}

const RECOVERY_BINDING_FIELDS = [
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

function dispatchRecoveryReferenceOf(
  binding: Omit<DispatchRecoveryBinding, "recoveryReference">,
): string {
  return `cq-dispatch-recovery:v1:${dispatchPayloadDigest(
    binding as unknown as DispatchJSONValue,
  )}`;
}

/** Validate a persisted recovery association and its self-authenticating reference. */
export function assertDispatchRecoveryBinding(
  value: DispatchRecoveryBinding,
  path = "dispatchRecoveryBinding",
): DispatchRecoveryBinding {
  if (value?.kind !== "cq-dispatch-recovery-binding" || value.version !== 1) {
    throw new AttestationContractError(path, "expected a version-1 dispatch recovery binding");
  }
  if (!DISPATCH_RECOVERY_REFERENCE_RE.test(value.recoveryReference)) {
    throw new AttestationContractError(
      `${path}.recoveryReference`,
      "expected an opaque cq-dispatch-recovery:v1 reference",
    );
  }
  assertDispatchHandle(value, path);
  assertDigest(value.terminalDigest, `${path}.terminalDigest`);
  attestationInstantMs(value.terminalAt, `${path}.terminalAt`);
  if (!/^[0-9a-f]{40}$/.test(value.liveTip)) {
    throw new AttestationContractError(`${path}.liveTip`, "expected a full commit SHA");
  }
  const gitEffectBinding = assertGitEffectBinding(value.gitEffectBinding, "implement-worker");
  if (gitEffectBinding === undefined || gitEffectBinding.conflictStateDigest !== undefined) {
    throw new AttestationContractError(
      `${path}.gitEffectBinding`,
      "expected an implement-worker Git binding",
    );
  }
  if (!Array.isArray(value.gitReceipts)) {
    throw new AttestationContractError(`${path}.gitReceipts`, "expected a receipt array");
  }
  const receipts =
    value.gitReceipts.length === 0
      ? Object.freeze([] as DispatchGitChangeReceipt[])
      : (assertGitEffectBinding(
          { ...gitEffectBinding, inheritedGitReceipts: value.gitReceipts },
          "implement-worker",
        )?.inheritedGitReceipts ?? Object.freeze([]));
  if (receipts.length > 0 && receipts.at(-1)?.newHead !== value.liveTip) {
    throw new AttestationBindingError(
      `${path}.liveTip`,
      "recovery receipt closure does not end at its authenticated live tip",
    );
  }
  if (
    value.implementationEvidenceBootstrapRef !== undefined &&
    !IMPLEMENTATION_EVIDENCE_BOOTSTRAP_REFERENCE_RE.test(value.implementationEvidenceBootstrapRef)
  ) {
    throw new AttestationContractError(
      `${path}.implementationEvidenceBootstrapRef`,
      "expected an opaque implementation evidence bootstrap reference",
    );
  }
  const normalizedWithoutReference = Object.freeze({
    kind: "cq-dispatch-recovery-binding" as const,
    version: 1 as const,
    attestationId: value.attestationId,
    generation: value.generation,
    terminalDigest: value.terminalDigest,
    terminalAt: value.terminalAt,
    gitEffectBinding,
    liveTip: value.liveTip,
    gitReceipts: Object.freeze([...receipts]),
    ...(value.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: value.implementationEvidenceBootstrapRef }),
  });
  const expectedReference = dispatchRecoveryReferenceOf(normalizedWithoutReference);
  if (value.recoveryReference !== expectedReference) {
    throw new AttestationBindingError(
      `${path}.recoveryReference`,
      "reference does not match its durable recovery association",
    );
  }
  return Object.freeze({
    ...normalizedWithoutReference,
    recoveryReference: expectedReference,
  });
}

function dispatchContinuationReferenceOf(
  binding: Omit<DispatchContinuationBinding, "continuationReference">,
): string {
  return `cq-dispatch-continuation:v1:${dispatchPayloadDigest(
    binding as unknown as DispatchJSONValue,
  )}`;
}

export function assertDispatchCurrentRecoverySource(
  value: DispatchCurrentRecoverySource,
  path = "currentRecoverySource",
): DispatchCurrentRecoverySource {
  if (value?.version !== 1) {
    throw new AttestationContractError(
      `${path}.version`,
      "expected current-recovery source version 1",
    );
  }
  if (value.kind === "aborted") {
    if (!DISPATCH_ABORT_REASONS.includes(value.abortReason)) {
      throw new AttestationContractError(
        `${path}.abortReason`,
        "expected one dispatch abort reason",
      );
    }
    return Object.freeze({
      kind: "aborted" as const,
      version: 1 as const,
      abortReason: value.abortReason,
    });
  }
  if (value.kind === "consumed-fail" && value.status === "fail") {
    return Object.freeze({
      kind: "consumed-fail" as const,
      version: 1 as const,
      status: "fail" as const,
    });
  }
  throw new AttestationContractError(path, "expected a recognized current-recovery source");
}

/** Validate one persisted consumed-continuation association and its opaque reference. */
export function assertDispatchContinuationBinding(
  value: DispatchContinuationBinding,
  path = "dispatchContinuationBinding",
): DispatchContinuationBinding {
  if (value?.kind !== "cq-dispatch-continuation-binding" || value.version !== 1) {
    throw new AttestationContractError(path, "expected a version-1 dispatch continuation binding");
  }
  if (!DISPATCH_CONTINUATION_REFERENCE_RE.test(value.continuationReference)) {
    throw new AttestationContractError(
      `${path}.continuationReference`,
      "expected an opaque cq-dispatch-continuation:v1 reference",
    );
  }
  assertDispatchHandle(value, path);
  assertDigest(value.terminalDigest, `${path}.terminalDigest`);
  attestationInstantMs(value.terminalAt, `${path}.terminalAt`);
  if (!/^[0-9a-f]{40}$/.test(value.liveTip)) {
    throw new AttestationContractError(`${path}.liveTip`, "expected a full commit SHA");
  }
  const gitEffectBinding = assertGitEffectBinding(value.gitEffectBinding, "implement-worker");
  if (gitEffectBinding === undefined || gitEffectBinding.conflictStateDigest !== undefined) {
    throw new AttestationContractError(
      `${path}.gitEffectBinding`,
      "expected an implement-worker Git binding",
    );
  }
  if (!Array.isArray(value.gitReceipts)) {
    throw new AttestationContractError(`${path}.gitReceipts`, "expected a receipt array");
  }
  const receipts =
    value.gitReceipts.length === 0
      ? Object.freeze([] as DispatchGitChangeReceipt[])
      : (assertGitEffectBinding(
          { ...gitEffectBinding, inheritedGitReceipts: value.gitReceipts },
          "implement-worker",
        )?.inheritedGitReceipts ?? Object.freeze([]));
  if (receipts.length > 0 && receipts.at(-1)?.newHead !== value.liveTip) {
    throw new AttestationBindingError(
      `${path}.liveTip`,
      "continuation receipt closure does not end at its authenticated live tip",
    );
  }
  if (
    value.implementationEvidenceBootstrapRef !== undefined &&
    !IMPLEMENTATION_EVIDENCE_BOOTSTRAP_REFERENCE_RE.test(value.implementationEvidenceBootstrapRef)
  ) {
    throw new AttestationContractError(
      `${path}.implementationEvidenceBootstrapRef`,
      "expected an opaque implementation evidence bootstrap reference",
    );
  }
  if (!TRUSTED_ACTOR_SET.has(value.callerLineage?.actor)) {
    throw new AttestationContractError(`${path}.callerLineage.actor`, "expected a trusted actor");
  }
  const child = assertChildIdentity(value.callerLineage, `${path}.callerLineage`);
  const currentRecoverySource =
    value.currentRecoverySource === undefined
      ? undefined
      : assertDispatchCurrentRecoverySource(
          value.currentRecoverySource,
          `${path}.currentRecoverySource`,
        );
  const normalizedWithoutReference = Object.freeze({
    kind: "cq-dispatch-continuation-binding" as const,
    version: 1 as const,
    attestationId: value.attestationId,
    generation: value.generation,
    terminalDigest: value.terminalDigest,
    terminalAt: value.terminalAt,
    gitEffectBinding,
    liveTip: value.liveTip,
    gitReceipts: Object.freeze([...receipts]),
    ...(value.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: value.implementationEvidenceBootstrapRef }),
    ...(currentRecoverySource === undefined ? {} : { currentRecoverySource }),
    callerLineage: Object.freeze({ actor: value.callerLineage.actor, ...child }),
  });
  const expectedReference = dispatchContinuationReferenceOf(normalizedWithoutReference);
  if (value.continuationReference !== expectedReference) {
    throw new AttestationBindingError(
      `${path}.continuationReference`,
      "reference does not match its durable continuation association",
    );
  }
  return Object.freeze({
    ...normalizedWithoutReference,
    continuationReference: expectedReference,
  });
}

function dispatchInputStartingCommit(row: AttestationEnvelope): string {
  if (typeof row.input !== "object" || row.input === null || Array.isArray(row.input)) {
    throw new AttestationContractError("row.input", "implement-worker input must be an object");
  }
  const startingCommit = (row.input as Readonly<Record<string, unknown>>)["startingCommit"];
  if (typeof startingCommit !== "string" || !/^[0-9a-f]{40}$/.test(startingCommit)) {
    throw new AttestationContractError("row.input.startingCommit", "expected a full commit SHA");
  }
  return startingCommit;
}

function createDispatchRecoveryBinding(
  row: AttestationEnvelope,
  terminalAt: string,
  terminalDigest: string,
  context: DispatchRecoveryContext,
): DispatchRecoveryBinding {
  if (row.promptProvenance.roleId !== "implement-worker" || row.gitEffectBinding === undefined) {
    throw new AttestationContractError(
      "recoveryContext",
      "only a manager-bound implement-worker can persist dispatch recovery",
    );
  }
  const liveTip = context.liveTip;
  if (!/^[0-9a-f]{40}$/.test(liveTip)) {
    throw new AttestationContractError("recoveryContext.liveTip", "expected a full commit SHA");
  }
  const receipts = context.gitReceipts;
  if (!Array.isArray(receipts)) {
    throw new AttestationContractError("recoveryContext.gitReceipts", "expected a receipt array");
  }
  if (receipts.length > 0) {
    assertGitEffectBinding(
      { ...row.gitEffectBinding, inheritedGitReceipts: receipts },
      "implement-worker",
    );
  }
  const inherited = row.gitEffectBinding.inheritedGitReceipts ?? [];
  if (
    dispatchPayloadDigest(receipts.slice(0, inherited.length) as unknown as DispatchJSONValue) !==
    dispatchPayloadDigest(inherited as unknown as DispatchJSONValue)
  ) {
    throw new AttestationBindingError(
      "recoveryContext.gitReceipts",
      "receipt closure does not retain the exact inherited prefix",
    );
  }
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.taskId !== row.gitEffectBinding.taskId) {
      throw new AttestationBindingError(
        `recoveryContext.gitReceipts[${String(index)}].taskId`,
        "receipt carries a foreign task identity",
      );
    }
    const previous = receipts[index - 1];
    if (previous !== undefined && receipt.oldHead !== previous.newHead) {
      throw new AttestationBindingError(
        `recoveryContext.gitReceipts[${String(index)}].oldHead`,
        "receipt closure is not contiguous",
      );
    }
    if (
      index >= inherited.length &&
      (receipt.attestationId !== row.attestationId || receipt.generation !== row.generation)
    ) {
      throw new AttestationBindingError(
        `recoveryContext.gitReceipts[${String(index)}]`,
        "new receipt is not bound to the terminal generation",
      );
    }
  }
  const startingCommit = dispatchInputStartingCommit(row);
  if (receipts.length === 0) {
    if (liveTip !== startingCommit) {
      throw new AttestationBindingError(
        "recoveryContext.liveTip",
        "an advanced live tip requires a complete durable receipt closure",
      );
    }
  } else {
    if (receipts.at(-1)?.newHead !== liveTip) {
      throw new AttestationBindingError(
        "recoveryContext.gitReceipts",
        "receipt closure does not end at the live tip",
      );
    }
    if (
      !receipts.some(
        (receipt) => receipt.oldHead === startingCommit || receipt.newHead === startingCommit,
      )
    ) {
      throw new AttestationBindingError(
        "recoveryContext.gitReceipts",
        "receipt closure does not contain the generation starting commit",
      );
    }
  }
  const withoutReference = Object.freeze({
    kind: "cq-dispatch-recovery-binding" as const,
    version: 1 as const,
    attestationId: row.attestationId,
    generation: row.generation,
    terminalDigest,
    terminalAt,
    gitEffectBinding: row.gitEffectBinding,
    liveTip,
    gitReceipts: Object.freeze([...receipts]),
    ...(row.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: row.implementationEvidenceBootstrapRef }),
  });
  return Object.freeze({
    ...withoutReference,
    recoveryReference: dispatchRecoveryReferenceOf(withoutReference),
  });
}

function createDispatchContinuationBinding(
  row: AttestationEnvelope,
  terminalAt: string,
  terminalDigest: string,
  proof: NativeCompletionProof,
  context: DispatchContinuationContext,
): DispatchContinuationBinding {
  const validated = createDispatchRecoveryBinding(row, terminalAt, terminalDigest, context);
  const currentRecoverySource =
    row.output !== null && typeof row.output === "object" && !Array.isArray(row.output)
      ? (row.output as Readonly<Record<string, DispatchJSONValue>>)["status"] === "fail"
        ? assertDispatchCurrentRecoverySource({
            kind: "consumed-fail",
            version: 1,
            status: "fail",
          })
        : undefined
      : undefined;
  const withoutReference = Object.freeze({
    kind: "cq-dispatch-continuation-binding" as const,
    version: 1 as const,
    attestationId: row.attestationId,
    generation: row.generation,
    terminalDigest,
    terminalAt,
    gitEffectBinding: validated.gitEffectBinding,
    liveTip: validated.liveTip,
    gitReceipts: validated.gitReceipts,
    ...(validated.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: validated.implementationEvidenceBootstrapRef }),
    ...(currentRecoverySource === undefined ? {} : { currentRecoverySource }),
    callerLineage: Object.freeze({
      actor: proof.actor,
      childId: proof.childId,
      runId: proof.runId,
    }),
  });
  return Object.freeze({
    ...withoutReference,
    continuationReference: dispatchContinuationReferenceOf(withoutReference),
  });
}

/**
 * THE prepare entry point (T685). It flows THROUGH T976's inside-prepare
 * validation — never around it — validates the launch envelope against the
 * bound contract, and only then allocates: one namespaced attestation record
 * carrying the exact role/version/prompt/input digests, the authoritative
 * deadlines, and a high-entropy result capability whose STORED HASH is bound to
 * that record.
 *
 * Validation failures are T976's ONE {@link DispatchPreLaunchRejection} type and
 * allocate nothing. Namespace, storage and transport failures stay explicit
 * errors — none of them is a lifecycle state.
 */
export function prepareDispatch(
  request: PrepareDispatchRequest,
  deps: PrepareDispatchDeps,
): PrepareDispatchOutcome {
  const namespace = assertAttestationNamespace(request.namespace);
  if (!attestationNamespacesEqual(namespace, deps.store.namespace)) {
    throw new AttestationNamespaceError(
      `prepare is scoped to namespace ${formatAttestationNamespace(namespace)} but the store is ` +
        `bound to ${formatAttestationNamespace(deps.store.namespace)}`,
    );
  }
  const executed: DispatchPrepareStep[] = [];

  // --- validation phase -------------------------------------------------
  // `resolve-role-contract` covers the launch envelope too: `idempotencyKey`
  // and `timeoutMs` are validated against the bound contract here, before any
  // allocation step exists to be reached.
  executed.push("resolve-role-contract");
  const idempotencyKey: unknown = request.idempotencyKey;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() === "" ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return dispatchPreLaunchRejection(
      "invalid-launch-envelope",
      "idempotencyKey",
      `expected a non-empty idempotency key of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  const timeoutMs: unknown = request.timeoutMs;
  const timeoutMinMs =
    request.roleId === "implement-reviewer"
      ? IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS
      : DISPATCH_TIMEOUT_MIN_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < timeoutMinMs ||
    (timeoutMs as number) > DISPATCH_TIMEOUT_MAX_MS
  ) {
    return dispatchPreLaunchRejection(
      "invalid-launch-envelope",
      "timeoutMs",
      `expected an integer timeout within [${timeoutMinMs}, ${DISPATCH_TIMEOUT_MAX_MS}] ms, ` +
        `got "${String(timeoutMs)}"`,
    );
  }

  let preparedInput = request.input;
  let prepareInstant: { readonly at: string; readonly atMs: number } | undefined;
  if (request.roleId === "implement-reviewer") {
    if (
      typeof request.input !== "object" ||
      request.input === null ||
      Array.isArray(request.input)
    ) {
      const invalid = validateDispatchInput({
        roleId: request.roleId,
        input: request.input,
        surface: request.surface,
        ...(request.overlays === undefined ? {} : { overlays: request.overlays }),
        registry: request.registry,
      });
      if (invalid.accepted) {
        throw new AttestationContractError(
          "input",
          "implement-reviewer schema accepted a non-object input",
        );
      }
      return invalid;
    }
    for (const field of IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS) {
      if (Object.hasOwn(request.input, field)) {
        return dispatchPreLaunchRejection(
          "invalid-role-input",
          `input.${field}`,
          `caller must omit server-bound implement-reviewer timing field "${field}"`,
        );
      }
    }
    prepareInstant = readNow(deps);
    const responseStoreNowMs = prepareInstant.atMs + (timeoutMs as number) - RESPONSE_STORE_LEAD_MS;
    preparedInput = Object.freeze({
      ...request.input,
      responseStoreNow: isoAt(responseStoreNowMs),
      gateCompleteBy: isoAt(responseStoreNowMs - IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS),
      synthesisStoreReserveMs: IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS,
    }) as DispatchJSONValue;
  }

  executed.push("validate-role-input", "validate-declared-overlay-data");
  const validation = validateDispatchInput({
    roleId: request.roleId,
    input: preparedInput,
    surface: request.surface,
    ...(request.overlays === undefined ? {} : { overlays: request.overlays }),
    registry: request.registry,
  });
  if (!validation.accepted) {
    return validation;
  }

  const promptDigest = assertDigest(request.promptDigest, "promptDigest");
  const catalogHash = assertDigest(request.catalogHash, "catalogHash");
  const expectedChild = assertChildIdentity(request.expectedChild, "expectedChild");
  const gitEffectBinding = assertGitEffectBinding(request.gitEffectBinding, validation.roleId);
  const implementationEvidenceBootstrapRef = request.implementationEvidenceBootstrapRef;
  if (
    implementationEvidenceBootstrapRef !== undefined &&
    (!IMPLEMENTATION_EVIDENCE_BOOTSTRAP_REFERENCE_RE.test(implementationEvidenceBootstrapRef) ||
      validation.roleId !== "implement-worker" ||
      gitEffectBinding === undefined)
  ) {
    throw new AttestationContractError(
      "implementationEvidenceBootstrapRef",
      "expected protected implement-worker bootstrap authority",
    );
  }
  const inputDigest = dispatchPayloadDigest(preparedInput);
  const requestedOverlays = new Map(
    (request.overlays ?? []).map((application) => [application.overlayId, application]),
  );
  const overlays = Object.freeze(
    validation.appliedOverlayIds.map((overlayId) => {
      const application = requestedOverlays.get(overlayId);
      if (application === undefined) {
        throw new AttestationContractError(
          "overlays",
          `validated overlay "${overlayId}" has no source application`,
        );
      }
      return Object.freeze({
        overlayId,
        data: structuredClone(application.data),
      });
    }),
  );

  // --- allocation phase -------------------------------------------------
  const { at, atMs } = prepareInstant ?? readNow(deps);
  const generation = resolveGeneration(request, atMs, deps);
  // Rows whose idempotency horizon has passed no longer HOLD the key, but they
  // are still physically present until a sweep runs. They are reclaimed here, in
  // this unit of work, so reuse is decided purely by the clock — see
  // `resolveIdempotencyKeyReclaim`.
  const reclaimable = resolveIdempotencyKeyReclaim(idempotencyKey, atMs, deps);

  executed.push("allocate-attestation");
  const attestationId =
    request.reprepareOf === undefined
      ? mintAttestationId(deps.randomBytes)
      : request.reprepareOf.attestationId;

  executed.push("mint-input-capability");
  const inputCapability = mintInputCapability(deps.randomBytes);

  executed.push("mint-result-capability");
  const resultCapability = mintResultCapability(deps.randomBytes);
  const parentGateCapability =
    validation.roleId === "implement-worker" &&
    validation.surface === "codex" &&
    gitEffectBinding !== undefined
      ? mintParentGateCapability(deps.randomBytes)
      : undefined;
  const gitChangeCapability =
    gitEffectBinding === undefined || validation.roleId !== "implement-worker"
      ? undefined
      : mintGitChangeCapability(deps.randomBytes);
  const gitConflictCapability =
    gitEffectBinding === undefined || validation.roleId !== "implement-conflict-resolver"
      ? undefined
      : mintGitConflictCapability(deps.randomBytes);

  // T976's declared ordering clause, asserted against what THIS call actually
  // executed. The recorded order is returned on `executedStepOrder`, where the
  // caller (and the suite) pins it against DISPATCH_PREPARE_STEP_ORDER.
  assertValidateThenAllocate(deps.stepOrder ?? executed);

  const deadlines: DispatchDeadlines = Object.freeze({
    responseStoreNow: isoAt(atMs + (timeoutMs as number) - RESPONSE_STORE_LEAD_MS),
    childCancelAt: isoAt(atMs + (timeoutMs as number)),
    launchDeadline: isoAt(atMs + LAUNCH_DEADLINE_MS),
  });
  const promptProvenance: DispatchPromptProvenance = Object.freeze({
    roleId: validation.roleId,
    version: validation.sidecarVersion,
    surface: validation.surface,
    promptDigest,
    catalogHash,
    inputDigest,
  });
  const prepareRequestDigest = prepareDispatchRequestDigest({
    ...request,
    input: preparedInput,
  });
  // Drop the reclaimed rows BEFORE the insert: a durable store enforces the
  // idempotency horizon's other half with a UNIQUE (namespace, idempotency_key)
  // constraint, so an expired row still occupying the key would refuse an insert
  // the service has already authorized.
  for (const stale of reclaimable) {
    deps.store.remove(stale);
  }
  const next = Object.freeze({
    kind: "envelope" as const,
    namespace,
    attestationId,
    generation,
    idempotencyKey,
    state: "prepared" as const,
    promptProvenance,
    prepareRequestDigest,
    input: preparedInput,
    overlays,
    deadlines,
    expectedChild,
    inputCapabilityHash: inputCapabilityHash(inputCapability.token),
    resultCapabilityHash: resultCapabilityHash(resultCapability.token),
    ...(parentGateCapability === undefined
      ? {}
      : { parentGateCapabilityHash: parentGateCapabilityHash(parentGateCapability.token) }),
    ...(gitChangeCapability === undefined
      ? {}
      : { gitChangeCapabilityHash: gitChangeCapabilityHash(gitChangeCapability.token) }),
    ...(gitConflictCapability === undefined
      ? {}
      : { gitConflictCapabilityHash: gitConflictCapabilityHash(gitConflictCapability.token) }),
    ...(gitEffectBinding === undefined ? {} : { gitEffectBinding }),
    ...(implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef }),
    ...(request.continuationClaim === undefined
      ? {}
      : {
          dispatchContinuationClaim: Object.freeze({
            continuationReference: request.continuationClaim.continuationReference,
            source: Object.freeze({
              attestationId: request.reprepareOf!.attestationId,
              generation: request.reprepareOf!.generation,
            }),
          }),
        }),
    createdAt: at,
  });
  deps.store.insert(next);
  return Object.freeze({
    accepted: true as const,
    prepared: Object.freeze({
      attestationId,
      generation,
      ...deadlines,
      promptProvenance,
      inputCapability,
      resultCapability,
      ...(parentGateCapability === undefined ? {} : { parentGateCapability }),
      ...(gitChangeCapability === undefined ? {} : { gitChangeCapability }),
      ...(gitConflictCapability === undefined ? {} : { gitConflictCapability }),
    }),
    handle: Object.freeze({ attestationId, generation }),
    executedStepOrder: Object.freeze(executed),
  });
}

function resolveGeneration(
  request: PrepareDispatchRequest,
  atMs: number,
  deps: PrepareDispatchDeps,
): number {
  const reprepareOf = request.reprepareOf;
  const reservation = request.journalRecoveryReservation;
  if (reservation !== undefined) {
    if (
      reprepareOf === undefined ||
      reprepareOf.attestationId !== reservation.sourceAttestationId ||
      reprepareOf.generation !== reservation.selectedSourceGeneration ||
      !/^cq-dispatch-lineage-cutover-fence:v1:[0-9a-f]{64}$/u.test(reservation.fenceRef) ||
      !Number.isInteger(reservation.selectedSourceGeneration) ||
      reservation.selectedSourceGeneration < 1 ||
      !Number.isInteger(reservation.lineageMaximumGeneration) ||
      reservation.lineageMaximumGeneration < reservation.selectedSourceGeneration ||
      request.continuationClaim !== undefined
    ) {
      throw new AttestationContractError(
        "journalRecoveryReservation",
        "journal recovery reservation is inconsistent with its sealed source lineage",
      );
    }
    const lineageRows = deps.store
      .rows()
      .filter((row) => row.attestationId === reservation.sourceAttestationId);
    const active = lineageRows.find(
      (row): row is AttestationEnvelope =>
        !isAttestationTombstone(row) && !TERMINAL_STATE_SET.has(row.state),
    );
    if (active !== undefined) {
      throw new DispatchStateConflictError(
        "prepare_dispatch",
        active.state,
        `journal recovery lineage generation ${String(active.generation)} is still live`,
      );
    }
    const observedMaximum = lineageRows.reduce(
      (maximum, row) => Math.max(maximum, row.generation),
      reservation.lineageMaximumGeneration,
    );
    return observedMaximum + 1;
  }
  if (reprepareOf === undefined) {
    if (request.continuationClaim !== undefined) {
      throw new AttestationContractError(
        "continuationClaim",
        "a continuation claim requires its server-resolved terminal generation",
      );
    }
    return 1;
  }
  const previous = requireRow(reprepareOf, deps);
  if (!isAttestationTombstone(previous) && !TERMINAL_STATE_SET.has(previous.state)) {
    throw new DispatchStateConflictError(
      "prepare_dispatch",
      previous.state,
      `attestation "${reprepareOf.attestationId}" generation ${reprepareOf.generation} is still live; ` +
        "a generation may only be re-prepared after the previous one is terminal",
    );
  }
  if (request.continuationClaim === undefined) {
    return reprepareOf.generation + 1;
  }
  const claim = request.continuationClaim;
  if (!DISPATCH_CONTINUATION_REFERENCE_RE.test(claim.continuationReference)) {
    throw new AttestationContractError(
      "continuationClaim.continuationReference",
      "expected an opaque cq-dispatch-continuation:v1 reference",
    );
  }
  if (!TRUSTED_CONTINUATION_CLAIMANT_SET.has(claim.actor)) {
    throw new DispatchContinuationError(
      "unauthorized-lineage",
      `untrusted continuation claimant "${String(claim.actor)}"`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(claim.liveTip)) {
    throw new AttestationContractError("continuationClaim.liveTip", "expected a full commit SHA");
  }
  const association = continuationBindingOfRow(previous, atMs, "reject");
  if (
    association === undefined ||
    association.continuationReference !== claim.continuationReference
  ) {
    throw new DispatchContinuationError(
      "binding-mismatch",
      "continuation claim does not match the server-resolved terminal generation",
    );
  }
  if (continuationClaimedBy(association.continuationReference, deps) !== undefined) {
    throw new DispatchContinuationError(
      "already-claimed",
      "dispatch continuation has already allocated its successor generation",
    );
  }
  if (
    request.gitEffectBinding === undefined ||
    !continuationMatchesLiveBinding(association, request.gitEffectBinding, claim.liveTip)
  ) {
    throw new DispatchContinuationError(
      "binding-mismatch",
      "dispatch continuation no longer matches the managed binding or live tip",
    );
  }
  return reprepareOf.generation + 1;
}

function continuationClaimedBy(
  continuationReference: string,
  deps: Deps,
): DispatchHandle | undefined {
  const claims = deps.store
    .rows()
    .filter(
      (row) => row.dispatchContinuationClaim?.continuationReference === continuationReference,
    );
  if (claims.length > 1) {
    throw new DispatchContinuationError(
      "binding-mismatch",
      "multiple durable successor rows claim one dispatch continuation",
    );
  }
  return claims.length === 0 ? undefined : handleOf(claims[0]!);
}

/**
 * The instant a row stops holding its idempotency key, or `undefined` while the
 * row is still LIVE (and therefore holds it indefinitely). A tombstone carries
 * the instant explicitly; a terminal envelope that no sweep has collapsed yet
 * derives the same instant from `terminalAt`, so the two agree and neither
 * depends on a sweep having run.
 */
function idempotencyHorizonOf(row: AttestationRow): number | undefined {
  if (isAttestationTombstone(row)) {
    return attestationInstantMs(row.reuseAfter, "reuseAfter");
  }
  if (row.terminalAt === undefined) {
    return undefined;
  }
  return attestationInstantMs(row.terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS;
}

/**
 * Decide whether `idempotencyKey` is free, and return the rows that must be
 * RECLAIMED for it to be — those past {@link IDEMPOTENCY_HORIZON_MS}, which
 * {@link fetchDispatchResult} already answers `attestation-not-found` for.
 *
 * Reclaiming is not housekeeping, it is the operation-time half of the horizon.
 * A store enforces key uniqueness DURABLY (a unique index, or a scan of the
 * namespace directory under its lock), so a row whose horizon has passed but
 * which a sweep has not yet dropped would refuse an insert this function has
 * already authorized — the key would be free according to every lookup and held
 * according to the store, until an unrelated sweep happened to run. T685 asserted
 * reuse only AFTER a sweep, so this gap survived; T720's shared adapter contract,
 * which requires every operation-time check to be independent of sweeps, is what
 * exposed it.
 */
function resolveIdempotencyKeyReclaim(
  idempotencyKey: string,
  atMs: number,
  deps: Deps,
): readonly DispatchHandle[] {
  const reclaimable: DispatchHandle[] = [];
  for (const row of deps.store.readByIdempotencyKey(idempotencyKey)) {
    assertSameNamespace(deps.store.namespace, row);
    const horizon = idempotencyHorizonOf(row);
    if (horizon === undefined || atMs < horizon) {
      throw new AttestationKeyReuseError(idempotencyKey, handleOf(row));
    }
    reclaimable.push(handleOf(row));
  }
  return Object.freeze(reclaimable);
}

function handleOf(row: AttestationRow): DispatchHandle {
  return Object.freeze({ attestationId: row.attestationId, generation: row.generation });
}

// ---------------------------------------------------------------------------
// Handle resolution
// ---------------------------------------------------------------------------

/**
 * Validate a lookup handle. A malformed handle is an authoring/boundary defect,
 * never the `attestation-not-found` lifecycle answer — only a WELL-FORMED
 * unknown handle can be answered with a state.
 */
export function assertDispatchHandle(handle: DispatchHandle, path = "handle"): DispatchHandle {
  const attestationId: unknown = handle?.attestationId;
  if (typeof attestationId !== "string" || !ATTESTATION_ID_RE.test(attestationId)) {
    throw new AttestationContractError(
      `${path}.attestationId`,
      `expected an attestation id, got "${String(attestationId)}"`,
    );
  }
  const generation: unknown = handle.generation;
  if (!Number.isInteger(generation) || (generation as number) < 1) {
    throw new AttestationContractError(
      `${path}.generation`,
      `expected a positive integer generation, got "${String(generation)}"`,
    );
  }
  return Object.freeze({ attestationId, generation: generation as number });
}

function readRow(handle: DispatchHandle, deps: Deps): AttestationRow | undefined {
  const row = deps.store.read(assertDispatchHandle(handle));
  if (row === undefined) {
    return undefined;
  }
  assertSameNamespace(deps.store.namespace, row);
  return row;
}

function requireRow(handle: DispatchHandle, deps: Deps): AttestationRow {
  const row = readRow(handle, deps);
  if (row === undefined) {
    throw new AttestationNotFoundError(assertDispatchHandle(handle));
  }
  return row;
}

// ---------------------------------------------------------------------------
// fetch_dispatch_input — one-shot input-capability operation
// ---------------------------------------------------------------------------

export interface FetchDispatchInputRequest extends FetchDispatchInput {
  readonly namespace: AttestationNamespace;
}

const FETCH_INPUT: DispatchProtocolOperation = "fetch_dispatch_input";

/**
 * Materialize the prepare-bound typed input exactly once. The handle narrows the
 * durable row and the distinct input capability authorizes only this operation.
 * A stolen, foreign, malformed, or already-consumed capability fails without
 * returning input and without changing lifecycle state.
 */
export function fetchDispatchInput(
  request: FetchDispatchInputRequest,
  deps: DispatchServiceDeps,
): MaterializedDispatchInput {
  assertTrustedNamespace(request.namespace, deps, FETCH_INPUT);
  const capability = request?.inputCapability;
  if (capability?.scope !== "fetch-input") {
    throw new DispatchAuthorizationError(
      FETCH_INPUT,
      `an input capability authorizes only ${[...INPUT_CAPABILITY_OPERATIONS].join(", ")}`,
    );
  }
  const token: unknown = capability.token;
  if (typeof token !== "string" || !INPUT_CAPABILITY_RE.test(token)) {
    throw new DispatchAuthorizationError(FETCH_INPUT, "malformed input capability");
  }
  const handle = assertDispatchHandle(request);
  const row = readRow(handle, deps);
  if (
    row === undefined ||
    isAttestationTombstone(row) ||
    !inputCapabilityMatches(token, row.inputCapabilityHash)
  ) {
    throw new DispatchAuthorizationError(FETCH_INPUT, "unknown or foreign input capability");
  }
  if (row.inputMaterializedAt !== undefined) {
    throw new DispatchStateConflictError(
      FETCH_INPUT,
      row.state,
      `input for attestation "${row.attestationId}" was already materialized at ${row.inputMaterializedAt}`,
    );
  }
  if (row.state !== "prepared") {
    throw new DispatchStateConflictError(
      FETCH_INPUT,
      row.state,
      `input for attestation "${row.attestationId}" may only be materialized while prepared`,
    );
  }
  const { at } = readNow(deps);
  const next: AttestationEnvelope = Object.freeze({
    ...row,
    inputMaterializedAt: at,
  });
  deps.store.replace(row, next);
  return Object.freeze({
    state: "input-materialized" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    input: row.input,
    promptProvenance: row.promptProvenance,
    materializedAt: at,
  });
}

export interface AuthorizeDispatchGitEffectRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly gitChangeCapability: GitChangeCapability;
}

/** Read-only authorization recheck used before broker snapshot and ref CAS. */
export function authorizeDispatchGitEffect(
  request: AuthorizeDispatchGitEffectRequest,
  deps: DispatchServiceDeps,
): AuthorizedDispatchGitEffect {
  assertTrustedNamespace(request.namespace, deps, "git_commit");
  const capability = request.gitChangeCapability;
  if (capability?.scope !== "git-change") {
    throw new DispatchAuthorizationError("git_commit", "expected a Git change capability");
  }
  if (typeof capability.token !== "string" || !GIT_CHANGE_CAPABILITY_RE.test(capability.token)) {
    throw new DispatchAuthorizationError("git_commit", "malformed Git change capability");
  }
  const row = requireRow(request, deps);
  if (
    isAttestationTombstone(row) ||
    row.gitChangeCapabilityHash === undefined ||
    !gitChangeCapabilityMatches(capability.token, row.gitChangeCapabilityHash)
  ) {
    throw new DispatchAuthorizationError("git_commit", "unknown or foreign Git change capability");
  }
  if (row.state !== "prepared" || row.inputMaterializedAt === undefined) {
    throw new DispatchStateConflictError(
      "git_commit",
      row.state,
      `Git effects require a live prepared dispatch with materialized input`,
    );
  }
  const { atMs } = readNow(deps);
  if (atMs > attestationInstantMs(row.deadlines.childCancelAt, "deadlines.childCancelAt")) {
    throw new DispatchStateConflictError("git_commit", row.state, "Git change capability expired");
  }
  if (row.promptProvenance.roleId !== "implement-worker" || row.gitEffectBinding === undefined) {
    throw new DispatchAuthorizationError(
      "git_commit",
      "dispatch has no implement-worker Git binding",
    );
  }
  return Object.freeze({
    ...row.gitEffectBinding,
    attestationId: row.attestationId,
    generation: row.generation,
    roleId: "implement-worker" as const,
    surface: row.promptProvenance.surface,
    childCancelAt: row.deadlines.childCancelAt,
  });
}

export interface AuthorizeDispatchGitConflictRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  readonly gitConflictCapability: GitConflictCapability;
}

/** Resolver-only authorization recheck before conflict snapshot and continuation. */
export function authorizeDispatchGitConflict(
  request: AuthorizeDispatchGitConflictRequest,
  deps: DispatchServiceDeps,
): AuthorizedDispatchGitEffect {
  assertTrustedNamespace(request.namespace, deps, "git_resolve_continue");
  const capability = request.gitConflictCapability;
  if (capability?.scope !== "git-conflict") {
    throw new DispatchAuthorizationError(
      "git_resolve_continue",
      "expected a Git conflict capability",
    );
  }
  if (typeof capability.token !== "string" || !GIT_CONFLICT_CAPABILITY_RE.test(capability.token)) {
    throw new DispatchAuthorizationError(
      "git_resolve_continue",
      "malformed Git conflict capability",
    );
  }
  const row = requireRow(request, deps);
  if (
    isAttestationTombstone(row) ||
    row.gitConflictCapabilityHash === undefined ||
    !gitConflictCapabilityMatches(capability.token, row.gitConflictCapabilityHash)
  ) {
    throw new DispatchAuthorizationError(
      "git_resolve_continue",
      "unknown or foreign Git conflict capability",
    );
  }
  if (row.state !== "prepared" || row.inputMaterializedAt === undefined) {
    throw new DispatchStateConflictError(
      "git_resolve_continue",
      row.state,
      "Git conflict effects require a live prepared dispatch with materialized input",
    );
  }
  const { atMs } = readNow(deps);
  if (atMs > attestationInstantMs(row.deadlines.childCancelAt, "deadlines.childCancelAt")) {
    throw new DispatchStateConflictError(
      "git_resolve_continue",
      row.state,
      "Git conflict capability expired",
    );
  }
  if (
    row.promptProvenance.roleId !== "implement-conflict-resolver" ||
    row.gitEffectBinding === undefined
  ) {
    throw new DispatchAuthorizationError(
      "git_resolve_continue",
      "dispatch has no implement-conflict-resolver Git binding",
    );
  }
  return Object.freeze({
    ...row.gitEffectBinding,
    attestationId: row.attestationId,
    generation: row.generation,
    roleId: "implement-conflict-resolver" as const,
    surface: row.promptProvenance.surface,
    childCancelAt: row.deadlines.childCancelAt,
  });
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

function terminalDigestOf(
  kind: AttestationTerminalKind,
  detail: Readonly<Record<string, DispatchJSONValue>>,
): string {
  return dispatchPayloadDigest({ terminalKind: kind, ...detail });
}

const BACKEND_OWNED_ABORTED_RESULTS = new WeakSet<object>();

export function isBackendOwnedAbortedDispatchResult(
  value: unknown,
): value is AbortedDispatchResult {
  return typeof value === "object" && value !== null && BACKEND_OWNED_ABORTED_RESULTS.has(value);
}

function abortedResultOf(row: AttestationEnvelope): AbortedDispatchResult {
  if (row.state !== "aborted" || row.abortedAt === undefined || row.abortReason === undefined) {
    throw new AttestationContractError("row", `expected an aborted envelope, got "${row.state}"`);
  }
  const aborted = Object.freeze({
    state: "aborted" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    abortedAt: row.abortedAt,
    reason: row.abortReason,
    ...(row.abortDetails === undefined ? {} : { details: row.abortDetails }),
  });
  BACKEND_OWNED_ABORTED_RESULTS.add(aborted);
  return aborted;
}

/**
 * Project a consumed envelope onto the HANDLE-ONLY confirm view (D173).
 *
 * Kept separate from {@link consumedResultOf} on purpose: fetch is the one
 * surface allowed to materialise `output`, so the two projections must not share
 * a code path that could reintroduce the body here.
 */
function confirmedViewOf(row: AttestationEnvelope): ConfirmedDispatchResultView {
  if (row.state !== "consumed" || row.consumedAt === undefined || row.outputDigest === undefined) {
    throw new AttestationContractError("row", `expected a consumed envelope, got "${row.state}"`);
  }
  return Object.freeze({
    state: "consumed" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    consumedAt: row.consumedAt,
    outputDigest: row.outputDigest,
  });
}

const BACKEND_OWNED_CONSUMED_RESULTS = new WeakSet<object>();

/** Only the attestation backend's one-shot fetch projection enters this set. */
export function isBackendOwnedConsumedDispatchResult(
  value: unknown,
): value is ConsumedDispatchResult {
  return typeof value === "object" && value !== null && BACKEND_OWNED_CONSUMED_RESULTS.has(value);
}

function consumedResultOf(row: AttestationEnvelope): ConsumedDispatchResult {
  if (
    row.state !== "consumed" ||
    row.consumedAt === undefined ||
    row.output === undefined ||
    row.nativeCompletion === undefined
  ) {
    throw new AttestationContractError("row", `expected a consumed envelope, got "${row.state}"`);
  }
  const consumed = Object.freeze({
    state: "consumed" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    consumedAt: row.consumedAt,
    output: row.output,
    promptProvenance: row.promptProvenance,
    nativeCompletion: row.nativeCompletion,
  });
  BACKEND_OWNED_CONSUMED_RESULTS.add(consumed);
  return consumed;
}

/**
 * Write one atomic abort over `row`. Used by the explicit abort operation AND by
 * every internal path that must abort instead of storing or consuming: a
 * deadline-crossing submission, invalid output, and a native completion with no
 * stored result. The transition is a SINGLE compare-and-set from the observed
 * revision, so an invalid store never passes through `result-stored`.
 */
function writeAbort(
  row: AttestationEnvelope,
  at: string,
  reason: DispatchAbortReason,
  details: DispatchJSONValue | undefined,
  deps: Deps,
  recoveryContext?: DispatchRecoveryContext,
): AbortedDispatchResult {
  if (recoveryContext !== undefined && reason !== "parent-lost") {
    throw new AttestationContractError(
      "recoveryContext",
      "dispatch recovery is valid only for a parent-lost abort",
    );
  }
  const recoveryEligible =
    row.promptProvenance.roleId === "implement-worker" && row.gitEffectBinding !== undefined;
  if (reason === "parent-lost" && recoveryEligible && recoveryContext === undefined) {
    throw new AttestationContractError(
      "recoveryContext",
      "a manager-bound parent-lost implement-worker requires recovery evidence",
    );
  }
  const terminalDigest = terminalDigestOf("aborted", {
    reason,
    detailsDigest: details === undefined ? null : dispatchPayloadDigest(details),
  });
  const dispatchRecoveryBinding =
    recoveryContext === undefined
      ? undefined
      : createDispatchRecoveryBinding(row, at, terminalDigest, recoveryContext);
  const next: AttestationEnvelope = Object.freeze({
    kind: "envelope" as const,
    namespace: row.namespace,
    attestationId: row.attestationId,
    generation: row.generation,
    idempotencyKey: row.idempotencyKey,
    state: "aborted" as const,
    promptProvenance: row.promptProvenance,
    prepareRequestDigest: row.prepareRequestDigest,
    input: row.input,
    overlays: row.overlays,
    deadlines: row.deadlines,
    expectedChild: row.expectedChild,
    inputCapabilityHash: row.inputCapabilityHash,
    ...(row.inputMaterializedAt === undefined
      ? {}
      : { inputMaterializedAt: row.inputMaterializedAt }),
    resultCapabilityHash: row.resultCapabilityHash,
    ...(row.gitChangeCapabilityHash === undefined
      ? {}
      : { gitChangeCapabilityHash: row.gitChangeCapabilityHash }),
    ...(row.gitConflictCapabilityHash === undefined
      ? {}
      : { gitConflictCapabilityHash: row.gitConflictCapabilityHash }),
    ...(row.gitEffectBinding === undefined ? {} : { gitEffectBinding: row.gitEffectBinding }),
    createdAt: row.createdAt,
    // A pre-abort stored result stays visible for the 24h envelope, but it is
    // NOT consumable: only `consumed` carries output on a fetch.
    ...(row.storedAt === undefined ? {} : { storedAt: row.storedAt }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.outputDigest === undefined ? {} : { outputDigest: row.outputDigest }),
    abortedAt: at,
    abortReason: reason,
    ...(details === undefined ? {} : { abortDetails: details }),
    ...(details === undefined ? {} : { abortDetailsDigest: dispatchPayloadDigest(details) }),
    terminalAt: at,
    terminalDigest,
    ...(dispatchRecoveryBinding === undefined ? {} : { dispatchRecoveryBinding }),
  });
  deps.store.replace(row, next);
  return abortedResultOf(next);
}

// ---------------------------------------------------------------------------
// store_result — the ONLY capability-scoped operation
// ---------------------------------------------------------------------------

/**
 * A capability-bound submission either records the result or ATOMICALLY aborts
 * (invalid output, or a submission that arrives past `childCancelAt`). It can
 * never consume: `consumed` is not in this union.
 */
export type StoreDispatchResultOutcome =
  | { readonly state: "gate-pending"; readonly result: GatePendingResultView }
  | { readonly state: "result-stored"; readonly result: StoredDispatchResultView }
  | { readonly state: "aborted"; readonly result: AbortedDispatchResult };

/** The child-visible acknowledgement of a stored result. Carries no capability. */
export interface StoredDispatchResultView {
  readonly state: "result-stored";
  readonly attestationId: string;
  readonly generation: number;
  readonly storedAt: string;
  readonly outputDigest: string;
}

/** Child-visible acknowledgement that its validated result is durably staged. */
export interface GatePendingResultView {
  readonly state: "gate-pending";
  readonly attestationId: string;
  readonly generation: number;
  readonly submittedAt: string;
  readonly outputDigest: string;
}

/** Typed validation details attached to an `invalid-output` abort. */
export interface InvalidOutputAbortDetails {
  readonly roleId: string;
  readonly version: number;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  /** One-line rendering of `errors`, for a caller that only logs the abort. */
  readonly summary: string;
}

const STORE_RESULT: DispatchProtocolOperation = "store_result";

/** Trusted pre-lock lookup used to put store_result under the same handle lock as Git effects. */
export function gitEffectBindingForResultCapability(
  submission: StoreDispatchResult,
  deps: DispatchServiceDeps,
): AuthorizedDispatchGitEffect | undefined {
  const token = submission?.resultCapability?.token;
  if (typeof token !== "string" || !RESULT_CAPABILITY_RE.test(token)) return undefined;
  const row = deps.store.readByCapabilityHash(resultCapabilityHash(token));
  if (
    row === undefined ||
    isAttestationTombstone(row) ||
    !resultCapabilityMatches(token, row.resultCapabilityHash)
  ) {
    return undefined;
  }
  if (row.gitEffectBinding === undefined) return undefined;
  if (
    row.promptProvenance.roleId !== "implement-worker" &&
    row.promptProvenance.roleId !== "implement-conflict-resolver"
  ) {
    throw new AttestationContractError(
      "row.promptProvenance.roleId",
      "a stored Git effect binding must belong to an implementation Git role",
    );
  }
  return Object.freeze({
    ...row.gitEffectBinding,
    attestationId: row.attestationId,
    generation: row.generation,
    roleId: row.promptProvenance.roleId,
    surface: row.promptProvenance.surface,
    childCancelAt: row.deadlines.childCancelAt,
  });
}

/**
 * Resolve the runner-only gate context from the result capability. No field in
 * child output selects this context; every identity comes from the prepared row.
 */
export function supervisedWorkerGateContextForResultCapability(
  submission: StoreDispatchResult,
  deps: DispatchServiceDeps,
): AuthorizedSupervisedWorkerGateContext | undefined {
  const authorization = gitEffectBindingForResultCapability(submission, deps);
  if (
    authorization === undefined ||
    authorization.roleId !== "implement-worker" ||
    authorization.surface !== "codex"
  ) {
    return undefined;
  }
  const token = submission.resultCapability.token;
  const row = deps.store.readByCapabilityHash(resultCapabilityHash(token));
  if (row === undefined || isAttestationTombstone(row)) {
    throw new DispatchAuthorizationError(STORE_RESULT, "unknown result capability");
  }
  if (
    (row.state !== "prepared" &&
      row.state !== "gate-pending" &&
      row.state !== "gate-running" &&
      row.state !== "result-stored") ||
    row.inputMaterializedAt === undefined
  ) {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      "supervised gate requires a live prepared dispatch with materialized input",
    );
  }
  const context = supervisedWorkerGateContextOf(row);
  if (context === undefined) {
    throw new AttestationContractError("row", "expected a supervised Codex worker binding");
  }
  return context;
}

function supervisedWorkerGateContextOf(
  row: AttestationEnvelope,
): AuthorizedSupervisedWorkerGateContext | undefined {
  if (
    row.gitEffectBinding === undefined ||
    row.promptProvenance.roleId !== "implement-worker" ||
    row.promptProvenance.surface !== "codex"
  ) {
    return undefined;
  }
  if (row.input === null || typeof row.input !== "object" || Array.isArray(row.input)) {
    throw new AttestationContractError("row.input", "implement-worker input must be an object");
  }
  const dispatchBaseCommit = (row.input as Readonly<Record<string, DispatchJSONValue>>)[
    "baseCommit"
  ];
  if (typeof dispatchBaseCommit !== "string" || !/^[0-9a-f]{40}$/.test(dispatchBaseCommit)) {
    throw new AttestationContractError(
      "row.input.baseCommit",
      "Codex implement-worker supervision requires a full dispatch base commit",
    );
  }
  const startingCommit = (row.input as Readonly<Record<string, DispatchJSONValue>>)[
    "startingCommit"
  ];
  if (typeof startingCommit !== "string" || !/^[0-9a-f]{40}$/.test(startingCommit)) {
    throw new AttestationContractError(
      "row.input.startingCommit",
      "Codex implement-worker supervision requires a full starting commit",
    );
  }
  return Object.freeze({
    ...row.gitEffectBinding,
    attestationId: row.attestationId,
    generation: row.generation,
    roleId: "implement-worker" as const,
    surface: "codex" as const,
    childCancelAt: row.deadlines.childCancelAt,
    promptProvenance: row.promptProvenance,
    dispatchBaseCommit,
    startingCommit,
  });
}

export interface ParentGateFinalizeRequest extends DispatchHandle {
  readonly parentGateCapability: ParentGateCapability;
}

export interface ClaimedParentGate {
  readonly state: "gate-running";
  readonly gateEpoch: number;
  readonly output: DispatchJSONValue;
  readonly context: AuthorizedSupervisedWorkerGateContext;
}

export type ClaimParentGateOutcome =
  | ClaimedParentGate
  | { readonly state: "result-stored"; readonly result: StoredDispatchResultView };

export interface CompleteParentGateRequest extends ParentGateFinalizeRequest {
  readonly gateEpoch: number;
  readonly output: DispatchJSONValue;
}

function requireParentGateRow(
  request: ParentGateFinalizeRequest,
  deps: DispatchServiceDeps,
): AttestationEnvelope {
  if (
    request.parentGateCapability?.scope !== "parent-gate" ||
    typeof request.parentGateCapability.token !== "string" ||
    !PARENT_GATE_CAPABILITY_RE.test(request.parentGateCapability.token)
  ) {
    throw new DispatchAuthorizationError(STORE_RESULT, "malformed parent gate capability");
  }
  const row = requireRow(assertDispatchHandle(request), deps);
  if (isAttestationTombstone(row)) {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      "terminal-envelope-expired",
      `attestation "${row.attestationId}" is terminal and its envelope has expired`,
    );
  }
  if (
    row.parentGateCapabilityHash === undefined ||
    !parentGateCapabilityMatches(request.parentGateCapability.token, row.parentGateCapabilityHash)
  ) {
    throw new DispatchAuthorizationError(STORE_RESULT, "unknown parent gate capability");
  }
  return row;
}

/** Claim or reclaim the durable parent-owned gate under the worktree effect lock. */
export function claimParentGate(
  request: ParentGateFinalizeRequest,
  deps: DispatchServiceDeps,
): ClaimParentGateOutcome {
  const row = requireParentGateRow(request, deps);
  if (row.state === "result-stored") {
    return Object.freeze({ state: "result-stored" as const, result: storedViewOf(row) });
  }
  if (row.state !== "gate-pending" && row.state !== "gate-running") {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `attestation "${row.attestationId}" has no staged parent gate`,
    );
  }
  if (row.output === undefined || row.gateSubmittedAt === undefined) {
    throw new AttestationContractError("row", "a staged parent gate must carry output and time");
  }
  const context = supervisedWorkerGateContextOf(row);
  if (context === undefined) {
    throw new AttestationContractError("row", "a staged parent gate must bind a Codex worker");
  }
  const { at } = readNow(deps);
  const gateEpoch = (row.gateEpoch ?? 0) + 1;
  const next: AttestationEnvelope = Object.freeze({
    ...row,
    state: "gate-running" as const,
    gateEpoch,
    gateClaimedAt: at,
  });
  deps.store.replace(row, next);
  return Object.freeze({
    state: "gate-running" as const,
    gateEpoch,
    output: row.output,
    context,
  });
}

/** Publish runner-owned gate evidence only for the exact claimed epoch. */
export function completeParentGate(
  request: CompleteParentGateRequest,
  deps: DispatchServiceDeps,
): StoredDispatchResultView {
  const row = requireParentGateRow(request, deps);
  const outputDigest = dispatchPayloadDigest(request.output);
  if (row.state === "result-stored") {
    if (row.gateEpoch !== request.gateEpoch) {
      throw new DispatchStateConflictError(
        STORE_RESULT,
        row.state,
        `parent gate epoch ${String(request.gateEpoch)} lost to ${String(row.gateEpoch)}`,
      );
    }
    if (row.outputDigest === outputDigest) return storedViewOf(row);
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `attestation "${row.attestationId}" already finalized a different result`,
    );
  }
  if (row.state !== "gate-running") {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `attestation "${row.attestationId}" has no claimed parent gate`,
    );
  }
  if (row.gateEpoch !== request.gateEpoch) {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `parent gate epoch ${String(request.gateEpoch)} lost to ${String(row.gateEpoch)}`,
    );
  }
  const sidecar = DISPATCHED_ROLE_SIDECARS[row.promptProvenance.roleId];
  const validation = validateAgainstSchema(sidecar.outputSchema, request.output);
  if (!validation.ok) {
    throw new AttestationContractError(
      "output",
      `parent gate produced invalid output: ${describeErrors(validation.errors)}`,
    );
  }
  const { at } = readNow(deps);
  const next: AttestationEnvelope = Object.freeze({
    ...row,
    state: "result-stored" as const,
    storedAt: at,
    output: request.output,
    outputDigest,
  });
  deps.store.replace(row, next);
  return storedViewOf(next);
}

/** Trusted pre-lock lookup used to serialize abort with a bound Git effect. */
export function gitEffectBindingForHandle(
  handle: DispatchHandle,
  deps: DispatchServiceDeps,
): DispatchGitEffectBinding | undefined {
  const row = deps.store.read(handle);
  return row === undefined || isAttestationTombstone(row) ? undefined : row.gitEffectBinding;
}

/**
 * THE capability-bound child submission (T685). It resolves its record BY
 * CAPABILITY HASH — the child names no id, no generation and no namespace — and
 * resolves the PREPARED output schema internally from the record's role
 * contract, so the child cannot choose what it is validated against either.
 *
 * A valid submission records `result-stored`. Invalid output aborts
 * `invalid-output` with typed validation details, atomically. A submission
 * arriving after the authoritative `childCancelAt` aborts `deadline-exceeded`.
 * An identical retry is idempotent; a retry with DIFFERENT output is a
 * {@link DispatchStateConflictError}. Nothing here can confirm completion.
 */
export function storeDispatchResult(
  submission: StoreDispatchResult,
  deps: DispatchServiceDeps,
): StoreDispatchResultOutcome {
  const capability = submission?.resultCapability;
  if (capability?.scope !== "store-result") {
    throw new DispatchAuthorizationError(
      STORE_RESULT,
      `a result capability authorizes only ${[...RESULT_CAPABILITY_OPERATIONS].join(", ")}`,
    );
  }
  const token: unknown = capability.token;
  if (typeof token !== "string" || !RESULT_CAPABILITY_RE.test(token)) {
    throw new DispatchAuthorizationError(STORE_RESULT, "malformed result capability");
  }
  const { at, atMs } = readNow(deps);
  const row = deps.store.readByCapabilityHash(resultCapabilityHash(token));
  if (row === undefined) {
    throw new DispatchAuthorizationError(STORE_RESULT, "unknown result capability");
  }
  assertSameNamespace(deps.store.namespace, row);
  if (isAttestationTombstone(row)) {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      "terminal-envelope-expired",
      `attestation "${row.attestationId}" is terminal and its envelope has expired`,
    );
  }
  // Constant-time confirmation against the STORED HASH. The lookup above already
  // matched, so this is belt-and-braces against an adapter that resolves loosely.
  if (!resultCapabilityMatches(token, row.resultCapabilityHash)) {
    throw new DispatchAuthorizationError(STORE_RESULT, "unknown result capability");
  }

  const outputDigest = dispatchPayloadDigest(submission.output);
  if (
    row.parentGateCapabilityHash !== undefined &&
    (row.state === "gate-pending" || row.state === "gate-running" || row.state === "result-stored")
  ) {
    if (row.gateSubmittedOutputDigest === outputDigest) {
      return Object.freeze({ state: "gate-pending" as const, result: gatePendingViewOf(row) });
    }
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `a different result is already staged for attestation "${row.attestationId}"`,
    );
  }
  if (row.state === "result-stored") {
    if (row.outputDigest === outputDigest) {
      return Object.freeze({ state: "result-stored" as const, result: storedViewOf(row) });
    }
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `a different result is already stored for attestation "${row.attestationId}"`,
    );
  }
  if (row.state !== "prepared") {
    throw new DispatchStateConflictError(
      STORE_RESULT,
      row.state,
      `attestation "${row.attestationId}" is already ${row.state}`,
    );
  }

  // The authoritative deadline is read ONCE, at operation entry. Output
  // validation below may cross `childCancelAt`; the outcome is still decided by
  // the entry instant, so a submission that arrived in time is never retro-aborted
  // and one that arrived late is never rescued by a fast validation.
  if (atMs > attestationInstantMs(row.deadlines.childCancelAt, "deadlines.childCancelAt")) {
    return Object.freeze({
      state: "aborted" as const,
      result: writeAbort(
        row,
        at,
        "deadline-exceeded",
        {
          childCancelAt: row.deadlines.childCancelAt,
          submittedAt: at,
        },
        deps,
      ),
    });
  }

  // The prepared output contract, resolved INTERNALLY from the bound role.
  // Object.hasOwn: the role id comes off a STORED row, so a value colliding with
  // an Object.prototype member ("constructor", "toString", ...) must fail here
  // rather than resolve an inherited value and be validated against nothing.
  if (!Object.hasOwn(DISPATCHED_ROLE_SIDECARS, row.promptProvenance.roleId)) {
    throw new AttestationContractError(
      "row.promptProvenance.roleId",
      `attestation "${row.attestationId}" names unknown role "${String(row.promptProvenance.roleId)}"`,
    );
  }
  const sidecar = DISPATCHED_ROLE_SIDECARS[row.promptProvenance.roleId];
  const result = validateAgainstSchema(
    row.parentGateCapabilityHash === undefined
      ? sidecar.outputSchema
      : implementWorkerStagedOutputSchema,
    submission.output,
  );
  if (!result.ok) {
    const details: InvalidOutputAbortDetails = {
      roleId: row.promptProvenance.roleId,
      version: row.promptProvenance.version,
      errors: result.errors.map((error) => ({ path: error.path, message: error.message })),
      summary: describeErrors(result.errors),
    };
    return Object.freeze({
      state: "aborted" as const,
      result: writeAbort(row, at, "invalid-output", details as unknown as DispatchJSONValue, deps),
    });
  }

  const next: AttestationEnvelope = Object.freeze(
    row.parentGateCapabilityHash === undefined
      ? {
          ...row,
          state: "result-stored" as const,
          storedAt: at,
          output: submission.output,
          outputDigest,
        }
      : {
          ...row,
          state: "gate-pending" as const,
          gateSubmittedAt: at,
          gateSubmittedOutputDigest: outputDigest,
          output: submission.output,
          outputDigest,
        },
  );
  deps.store.replace(row, next);
  return next.state === "gate-pending"
    ? Object.freeze({ state: "gate-pending" as const, result: gatePendingViewOf(next) })
    : Object.freeze({ state: "result-stored" as const, result: storedViewOf(next) });
}

function gatePendingViewOf(row: AttestationEnvelope): GatePendingResultView {
  if (row.gateSubmittedAt === undefined || row.gateSubmittedOutputDigest === undefined) {
    throw new AttestationContractError("row", "expected a gate-pending envelope");
  }
  return Object.freeze({
    state: "gate-pending" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    submittedAt: row.gateSubmittedAt,
    outputDigest: row.gateSubmittedOutputDigest,
  });
}

function storedViewOf(row: AttestationEnvelope): StoredDispatchResultView {
  if (row.storedAt === undefined || row.outputDigest === undefined) {
    throw new AttestationContractError("row", "expected a stored envelope");
  }
  return Object.freeze({
    state: "result-stored" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    storedAt: row.storedAt,
    outputDigest: row.outputDigest,
  });
}

/**
 * The typed validation details of an `invalid-output` abort, or `undefined` when
 * the abort had another cause. Exported so a caller reads the details through a
 * declared shape rather than re-parsing the JSON body.
 */
export function invalidOutputDetailsOf(
  result: AbortedDispatchResult,
): InvalidOutputAbortDetails | undefined {
  if (result.reason !== "invalid-output" || result.details === undefined) {
    return undefined;
  }
  return result.details as unknown as InvalidOutputAbortDetails;
}

// ---------------------------------------------------------------------------
// confirm_dispatch_completion — the ONLY promotion to consumed
// ---------------------------------------------------------------------------

/**
 * A trusted completion confirmation. It carries the native proof AND the
 * provenance the parent believes it launched, so a parent can never confirm the
 * completion of a dispatch other than its own.
 */
export interface ConfirmDispatchCompletionRequest {
  readonly namespace: AttestationNamespace;
  readonly attestationId: string;
  readonly generation: number;
  readonly nativeCompletion: NativeCompletionProof;
  readonly expectedProvenance: DispatchProvenanceBinding;
  /** Server-derived while holding the exact managed-worktree effect lock. */
  readonly continuationContext?: DispatchContinuationContext;
}

/**
 * A confirmation either promotes the stored result to `consumed` or ABORTS
 * `missing-result` — a native completion with nothing stored is not a success.
 */
/**
 * The trusted-parent acknowledgement of a promotion to `consumed` — HANDLE-ONLY
 * (D173). It deliberately mirrors {@link StoredDispatchResultView}: state,
 * handle, instant, digest, and NO output body.
 *
 * WHY (D173, found by the T713 probe): confirm previously returned
 * {@link ConsumedDispatchResult}, whose `output` carries the full body. Confirm
 * is NOT optional — it is the only `result-stored → consumed` promotion — so
 * every dispatch's parent surface handed back the entire payload. Measured on a
 * 45,833-byte payload: confirm returned 46,510 bytes with the body present,
 * against a 250-byte handle-only `store_result` ack. That is a SECOND, mandatory
 * body-returning surface, and it defeats ref-first independently of how well the
 * child behaves — T682's contract requires the body reach the parent model ONCE,
 * on fetch.
 *
 * `fetch_dispatch_result` remains the SOLE body-returning surface. The digest is
 * kept here so a parent can bind the promotion to the payload it will later
 * fetch, without materialising it.
 */
export interface ConfirmedDispatchResultView {
  readonly state: "consumed";
  readonly attestationId: string;
  readonly generation: number;
  readonly consumedAt: string;
  readonly outputDigest: string;
}

export type ConfirmDispatchCompletionOutcome =
  | { readonly state: "consumed"; readonly result: ConfirmedDispatchResultView }
  | { readonly state: "aborted"; readonly result: AbortedDispatchResult };

const CONFIRM: DispatchProtocolOperation = "confirm_dispatch_completion";

interface ConfirmDispatchContext {
  readonly proof: NativeCompletionProof;
  readonly row: AttestationEnvelope;
}

function confirmDispatchContext(
  request: ConfirmDispatchCompletionRequest,
  deps: DispatchServiceDeps,
): ConfirmDispatchContext {
  assertTrustedNamespace(request.namespace, deps, CONFIRM);
  const proof = assertNativeCompletion(request.nativeCompletion);
  const handle = assertDispatchHandle(request);
  const row = requireRow(handle, deps);
  if (isAttestationTombstone(row)) {
    throw new DispatchStateConflictError(
      CONFIRM,
      "terminal-envelope-expired",
      `attestation "${row.attestationId}" is terminal and its envelope has expired`,
    );
  }
  assertProvenanceBinding(request.expectedProvenance, row);
  if (proof.childId !== row.expectedChild.childId || proof.runId !== row.expectedChild.runId) {
    throw new AttestationBindingError(
      "nativeCompletion",
      `completion claims child/run "${proof.childId}"/"${proof.runId}" but attestation ` +
        `"${row.attestationId}" expects "${row.expectedChild.childId}"/"${row.expectedChild.runId}"`,
    );
  }
  return { proof, row };
}

function consumedConfirmationReplay(
  context: ConfirmDispatchContext,
): Extract<ConfirmDispatchCompletionOutcome, { readonly state: "consumed" }> | undefined {
  if (context.row.state !== "consumed") return undefined;
  const existing = context.row.nativeCompletion;
  if (
    existing !== undefined &&
    existing.actor === context.proof.actor &&
    existing.childId === context.proof.childId &&
    existing.runId === context.proof.runId &&
    existing.completedAt === context.proof.completedAt
  ) {
    return Object.freeze({
      state: "consumed" as const,
      result: confirmedViewOf(context.row),
    });
  }
  throw new DispatchStateConflictError(
    CONFIRM,
    context.row.state,
    `attestation "${context.row.attestationId}" is already consumed under a different completion proof`,
  );
}

/** Return an identical consumed confirmation without attempting a new transition. */
export function replayConfirmedDispatchCompletion(
  request: ConfirmDispatchCompletionRequest,
  deps: DispatchServiceDeps,
): Extract<ConfirmDispatchCompletionOutcome, { readonly state: "consumed" }> | undefined {
  return consumedConfirmationReplay(confirmDispatchContext(request, deps));
}

/**
 * THE trusted promotion (T685) — the ONLY path from `result-stored` to
 * `consumed`, and unreachable with a result capability.
 *
 * A native completion for a record with no stored result aborts
 * `missing-result`. An identical confirmation retry is idempotent; a different
 * child/run, or a confirmation of an already-terminal record, is a typed
 * conflict that cannot consume. A mismatched role/version/prompt/input digest is
 * an {@link AttestationBindingError}.
 */
export function confirmDispatchCompletion(
  request: ConfirmDispatchCompletionRequest,
  deps: DispatchServiceDeps,
): ConfirmDispatchCompletionOutcome {
  const context = confirmDispatchContext(request, deps);
  const { proof, row } = context;
  const { at } = readNow(deps);
  const replay = consumedConfirmationReplay(context);
  if (replay !== undefined) return replay;
  if (row.state === "aborted") {
    // Abort WINS: a terminal abort is never promoted, whatever completed.
    throw new DispatchStateConflictError(
      CONFIRM,
      row.state,
      `attestation "${row.attestationId}" is aborted (${String(row.abortReason)}) and cannot be consumed`,
    );
  }
  if (row.state === "prepared") {
    return Object.freeze({
      state: "aborted" as const,
      result: writeAbort(
        row,
        at,
        "missing-result",
        {
          completedAt: proof.completedAt,
          childId: proof.childId,
          runId: proof.runId,
        },
        deps,
      ),
    });
  }
  if (row.state === "gate-pending" || row.state === "gate-running") {
    throw new DispatchStateConflictError(
      CONFIRM,
      row.state,
      `attestation "${row.attestationId}" still requires parent gate finalization`,
    );
  }
  if (row.output === undefined || row.outputDigest === undefined) {
    throw new AttestationContractError("row", "a result-stored envelope must carry its output");
  }
  const terminalDigest = terminalDigestOf("consumed", {
    outputDigest: row.outputDigest,
    childId: proof.childId,
    runId: proof.runId,
    completedAt: proof.completedAt,
  });
  const continuationBinding =
    row.promptProvenance.roleId === "implement-worker" && row.gitEffectBinding !== undefined
      ? request.continuationContext === undefined
        ? (() => {
            throw new AttestationContractError(
              "continuationContext",
              "consuming a manager-bound implement-worker requires locked continuation evidence",
            );
          })()
        : createDispatchContinuationBinding(
            row,
            at,
            terminalDigest,
            proof,
            request.continuationContext,
          )
      : undefined;
  const next: AttestationEnvelope = Object.freeze({
    ...row,
    state: "consumed" as const,
    consumedAt: at,
    nativeCompletion: proof,
    terminalAt: at,
    terminalDigest,
    ...(continuationBinding === undefined
      ? {}
      : { dispatchContinuationBinding: continuationBinding }),
  });
  deps.store.replace(row, next);
  return Object.freeze({ state: "consumed" as const, result: confirmedViewOf(next) });
}

function assertTrustedNamespace(
  namespace: AttestationNamespace,
  deps: Deps,
  operation: DispatchProtocolOperation,
): void {
  const resolved = assertAttestationNamespace(namespace);
  if (!attestationNamespacesEqual(resolved, deps.store.namespace)) {
    throw new AttestationNamespaceError(
      `${operation} is scoped to namespace ${formatAttestationNamespace(resolved)} but the store is ` +
        `bound to ${formatAttestationNamespace(deps.store.namespace)}`,
    );
  }
}

function assertNativeCompletion(proof: NativeCompletionProof): NativeCompletionProof {
  if (proof?.kind !== "native-completion") {
    throw new DispatchAuthorizationError(CONFIRM, "expected a native-completion proof");
  }
  const actor: unknown = proof.actor;
  // Set membership: no Object.prototype name passes as a trusted actor.
  if (typeof actor !== "string" || !TRUSTED_ACTOR_SET.has(actor)) {
    throw new DispatchAuthorizationError(CONFIRM, `untrusted completion actor "${String(actor)}"`);
  }
  const child = assertChildIdentity(proof, "nativeCompletion");
  const completedAt: unknown = proof.completedAt;
  attestationInstantMs(completedAt as string, "nativeCompletion.completedAt");
  return Object.freeze({
    kind: "native-completion" as const,
    actor: actor as TrustedDispatchActor,
    childId: child.childId,
    runId: child.runId,
    completedAt: completedAt as string,
  });
}

function assertProvenanceBinding(
  expected: DispatchProvenanceBinding,
  row: AttestationEnvelope,
): void {
  if (expected === undefined || expected === null) {
    throw new AttestationBindingError(
      "expectedProvenance",
      "expected the launched provenance binding",
    );
  }
  const bound = row.promptProvenance;
  for (const field of ["roleId", "version", "promptDigest", "inputDigest"] as const) {
    if (expected[field] !== bound[field]) {
      throw new AttestationBindingError(
        `expectedProvenance.${field}`,
        `attestation "${row.attestationId}" was prepared with ${field} "${String(bound[field])}", ` +
          `not "${String(expected[field])}"`,
      );
    }
  }
}

/** The provenance binding a confirming parent must present for one prepare. */
export function provenanceBindingOf(prepared: DispatchPrepared): DispatchProvenanceBinding {
  return Object.freeze({
    roleId: prepared.promptProvenance.roleId,
    version: prepared.promptProvenance.version,
    promptDigest: prepared.promptProvenance.promptDigest,
    inputDigest: prepared.promptProvenance.inputDigest,
  });
}

// ---------------------------------------------------------------------------
// abort_dispatch
// ---------------------------------------------------------------------------

export interface AbortDispatchRequest extends AbortDispatch {
  readonly namespace: AttestationNamespace;
  /** Who is aborting. Only a trusted actor may. */
  readonly actor: TrustedDispatchActor;
  /** Trusted server-only evidence captured under the managed worktree effect lock. */
  readonly recoveryContext?: DispatchRecoveryContext;
}

const ABORT: DispatchProtocolOperation = "abort_dispatch";

const ABORT_REASON_SET: ReadonlySet<string> = new Set([
  "cancelled",
  "native-failure",
  "protocol-violation",
  "invalid-output",
  "missing-result",
  "deadline-exceeded",
  "parent-lost",
  "operational-abstention",
]);

/**
 * THE trusted terminal abort (T685). It wins from `prepared` AND from
 * `result-stored` — a stored result is not consumable after an abort — and it
 * accepts the FULL failure body verbatim in `details`, echoed back by
 * {@link fetchDispatchResult} for as long as the 24h envelope lives.
 *
 * An identical abort retry (same reason, same details) is idempotent; a
 * different reason or body, or an abort of a consumed record, is a typed
 * terminal conflict.
 */
export function abortDispatch(
  request: AbortDispatchRequest,
  deps: DispatchServiceDeps,
): AbortedDispatchResult {
  assertTrustedNamespace(request.namespace, deps, ABORT);
  const actor: unknown = request.actor;
  if (typeof actor !== "string" || !TRUSTED_ACTOR_SET.has(actor)) {
    throw new DispatchAuthorizationError(ABORT, `untrusted abort actor "${String(actor)}"`);
  }
  const reason: unknown = request.reason;
  if (typeof reason !== "string" || !ABORT_REASON_SET.has(reason)) {
    throw new AttestationContractError("reason", `unknown abort reason "${String(reason)}"`);
  }
  const handle = assertDispatchHandle(request);
  const row = requireRow(handle, deps);
  if (isAttestationTombstone(row)) {
    throw new DispatchStateConflictError(
      ABORT,
      "terminal-envelope-expired",
      `attestation "${row.attestationId}" is terminal and its envelope has expired`,
    );
  }
  const details = request.details;
  if (row.state === "aborted") {
    const sameReason = row.abortReason === reason;
    const sameDetails =
      details === undefined
        ? row.abortDetailsDigest === undefined
        : row.abortDetailsDigest === dispatchPayloadDigest(details);
    if (sameReason && sameDetails) {
      return abortedResultOf(row);
    }
    throw new DispatchStateConflictError(
      ABORT,
      row.state,
      `attestation "${row.attestationId}" is already aborted (${String(row.abortReason)})`,
    );
  }
  if (row.state === "result-stored" && row.parentGateCapabilityHash !== undefined) {
    throw new DispatchStateConflictError(
      ABORT,
      row.state,
      `attestation "${row.attestationId}" has a finalized parent gate and cannot be aborted`,
    );
  }
  if (row.state === "consumed") {
    throw new DispatchStateConflictError(
      ABORT,
      row.state,
      `attestation "${row.attestationId}" is already consumed and cannot be aborted`,
    );
  }
  const { at } = readNow(deps);
  return writeAbort(row, at, reason as DispatchAbortReason, details, deps, request.recoveryContext);
}

// ---------------------------------------------------------------------------
// fetch_dispatch_result
// ---------------------------------------------------------------------------

/**
 * The trusted-parent read request (D174). Mirrors {@link AbortDispatchRequest}:
 * the handle, plus the namespace it claims and the actor performing the read.
 */
export interface FetchDispatchResultRequest extends DispatchHandle {
  readonly namespace: AttestationNamespace;
  /** Who is reading. Only a trusted actor may materialise the output body. */
  readonly actor: TrustedDispatchActor;
}

const FETCH: DispatchProtocolOperation = "fetch_dispatch_result";

/**
 * THE typed one-shot lookup (T685/D188). It never launches and never interprets
 * absence as a child failure. The first fetch of a consumed envelope persists
 * `outputMaterializedAt` with a compare-and-set before returning the body; a
 * repeat fetch returns `output-already-materialized` without the body.
 *
 * The two retention boundaries are visible here BEFORE a sweep runs: a terminal
 * record more than {@link TERMINAL_ENVELOPE_RETENTION_MS} old answers
 * `terminal-envelope-expired`, and one past {@link IDEMPOTENCY_HORIZON_MS}
 * answers `attestation-not-found`. Namespace, authorization, transport and
 * storage failures stay explicit errors and can never appear in this union.
 */
export function fetchDispatchResult(
  request: FetchDispatchResultRequest,
  deps: DispatchServiceDeps,
): FetchDispatchResult {
  // D174: fetch is declared `trusted-parent` by dispatchOperationScope, and now
  // ENFORCES it — previously its arity was (handle, deps) with no namespace and
  // no actor, so the declaration was documentation rather than a guard and the
  // only real boundary was who happened to hold `deps.store`. Fetch is the SOLE
  // body-materialising surface, so it is exactly where a check matters most.
  // Same shape as abort_dispatch, deliberately: namespace THEN actor.
  assertTrustedNamespace(request.namespace, deps, FETCH);
  const actor: unknown = request.actor;
  if (typeof actor !== "string" || !TRUSTED_ACTOR_SET.has(actor)) {
    throw new DispatchAuthorizationError(FETCH, `untrusted fetch actor "${String(actor)}"`);
  }
  const resolved = assertDispatchHandle(request);
  const { at, atMs } = readNow(deps);
  const row = readRow(resolved, deps);
  if (row === undefined) {
    return Object.freeze({ state: "attestation-not-found" as const, ...resolved });
  }
  if (isAttestationTombstone(row)) {
    if (atMs >= attestationInstantMs(row.reuseAfter, "reuseAfter")) {
      return Object.freeze({ state: "attestation-not-found" as const, ...resolved });
    }
    return Object.freeze({
      state: "terminal-envelope-expired" as const,
      ...resolved,
      terminalKind: row.terminalKind,
      reuseAfter: row.reuseAfter,
    });
  }
  if (row.terminalAt !== undefined) {
    const terminalMs = attestationInstantMs(row.terminalAt, "terminalAt");
    if (atMs >= terminalMs + IDEMPOTENCY_HORIZON_MS) {
      return Object.freeze({ state: "attestation-not-found" as const, ...resolved });
    }
    if (atMs >= terminalMs + TERMINAL_ENVELOPE_RETENTION_MS) {
      return Object.freeze({
        state: "terminal-envelope-expired" as const,
        ...resolved,
        terminalKind: row.state === "consumed" ? ("consumed" as const) : ("aborted" as const),
        reuseAfter: isoAt(terminalMs + IDEMPOTENCY_HORIZON_MS),
      });
    }
  }
  switch (row.state) {
    case "prepared":
      return Object.freeze({
        state: "prepared" as const,
        ...resolved,
        ...row.deadlines,
        promptProvenance: row.promptProvenance,
      });
    case "gate-pending":
    case "gate-running":
      if (row.gateSubmittedAt === undefined) {
        throw new AttestationContractError("row", "a staged gate must carry gateSubmittedAt");
      }
      return Object.freeze({
        state: row.state,
        ...resolved,
        submittedAt: row.gateSubmittedAt,
        promptProvenance: row.promptProvenance,
      });
    case "result-stored":
      if (row.storedAt === undefined) {
        throw new AttestationContractError("row", "a result-stored envelope must carry storedAt");
      }
      return Object.freeze({
        state: "result-stored" as const,
        ...resolved,
        storedAt: row.storedAt,
        promptProvenance: row.promptProvenance,
      });
    case "consumed": {
      if (row.outputMaterializedAt !== undefined) {
        return Object.freeze({
          state: "output-already-materialized" as const,
          ...resolved,
          materializedAt: row.outputMaterializedAt,
        });
      }
      const consumed = consumedResultOf(row);
      deps.store.replace(row, Object.freeze({ ...row, outputMaterializedAt: at }));
      return consumed;
    }
    case "aborted":
      return abortedResultOf(row);
  }
}

// ---------------------------------------------------------------------------
// Managed-handle terminal dispatch recovery
// ---------------------------------------------------------------------------

export interface DiscoverDispatchRecoveryRequest {
  readonly namespace: AttestationNamespace;
  readonly actor: TrustedDispatchActor;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
}

export interface ResolveDispatchRecoveryRequest extends DiscoverDispatchRecoveryRequest {
  readonly recoveryReference: string;
}

function assertRecoveryRequest(
  request: DiscoverDispatchRecoveryRequest,
  deps: Deps,
): DispatchGitEffectBinding {
  assertTrustedNamespace(request.namespace, deps, "prepare_dispatch");
  if (!TRUSTED_ACTOR_SET.has(request.actor)) {
    throw new DispatchAuthorizationError(
      "prepare_dispatch",
      `untrusted recovery actor "${String(request.actor)}"`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(request.liveTip)) {
    throw new AttestationContractError("liveTip", "expected a full commit SHA");
  }
  const binding = assertGitEffectBinding(request.gitEffectBinding, "implement-worker");
  if (binding === undefined || binding.conflictStateDigest !== undefined) {
    throw new AttestationContractError(
      "gitEffectBinding",
      "expected a live implement-worker manager binding",
    );
  }
  return binding;
}

function recoveryBindingOfRow(
  row: AttestationRow,
  atMs: number,
  expired: "omit" | "reject",
): DispatchRecoveryBinding | undefined {
  const binding = row.dispatchRecoveryBinding;
  if (binding === undefined) return undefined;
  if (isAttestationTombstone(row)) {
    if (atMs >= attestationInstantMs(row.reuseAfter, "reuseAfter")) {
      if (expired === "omit") return undefined;
      throw new DispatchRecoveryError("expired", "dispatch recovery binding has expired");
    }
    if (row.terminalKind !== "aborted") {
      throw new DispatchRecoveryError(
        "binding-mismatch",
        "dispatch recovery tombstone is not an aborted terminal generation",
      );
    }
  } else {
    if (row.terminalAt === undefined || !TERMINAL_STATE_SET.has(row.state)) {
      throw new DispatchRecoveryError(
        "nonterminal",
        "dispatch recovery binding is attached to a nonterminal generation",
      );
    }
    if (atMs >= attestationInstantMs(row.terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS) {
      if (expired === "omit") return undefined;
      throw new DispatchRecoveryError("expired", "dispatch recovery binding has expired");
    }
    if (row.state !== "aborted" || row.abortReason !== "parent-lost") {
      throw new DispatchRecoveryError(
        "binding-mismatch",
        "dispatch recovery binding is not attached to a parent-lost abort",
      );
    }
  }
  const resolved = assertDispatchRecoveryBinding(binding);
  if (
    resolved.attestationId !== row.attestationId ||
    resolved.generation !== row.generation ||
    resolved.terminalDigest !== row.terminalDigest ||
    resolved.terminalAt !== row.terminalAt
  ) {
    throw new DispatchRecoveryError(
      "binding-mismatch",
      "dispatch recovery terminal identity differs from its attestation row",
    );
  }
  return resolved;
}

function recoveryMatchesLiveBinding(
  recovery: DispatchRecoveryBinding,
  current: DispatchGitEffectBinding,
  liveTip: string,
): boolean {
  return (
    recovery.liveTip === liveTip &&
    RECOVERY_BINDING_FIELDS.every((field) => recovery.gitEffectBinding[field] === current[field])
  );
}

function resolvedRecoveryOf(binding: DispatchRecoveryBinding): ResolvedDispatchRecovery {
  return Object.freeze({
    recoveryReference: binding.recoveryReference,
    reprepareOf: Object.freeze({
      attestationId: binding.attestationId,
      generation: binding.generation,
    }),
    terminalAt: binding.terminalAt,
    gitEffectBinding: binding.gitEffectBinding,
    liveTip: binding.liveTip,
    gitReceipts: Object.freeze([...binding.gitReceipts]),
    ...(binding.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: binding.implementationEvidenceBootstrapRef }),
  });
}

/** Discover the latest unambiguous parent-lost generation for one exact managed handle. */
export function discoverDispatchRecovery(
  request: DiscoverDispatchRecoveryRequest,
  deps: DispatchServiceDeps,
): ResolvedDispatchRecovery {
  const current = assertRecoveryRequest(request, deps);
  const { atMs } = readNow(deps);
  const candidates = deps.store
    .rows()
    .map((row) => recoveryBindingOfRow(row, atMs, "omit"))
    .filter(
      (binding): binding is DispatchRecoveryBinding =>
        binding !== undefined && recoveryMatchesLiveBinding(binding, current, request.liveTip),
    );
  if (candidates.length === 0) {
    throw new DispatchRecoveryError(
      "not-found",
      "no parent-lost dispatch recovery is bound to this managed handle and live tip",
    );
  }
  const attestationIds = new Set(candidates.map((binding) => binding.attestationId));
  if (attestationIds.size !== 1) {
    throw new DispatchRecoveryError(
      "ambiguous",
      "multiple terminal dispatch lineages match this managed handle and live tip",
    );
  }
  candidates.sort((left, right) => right.generation - left.generation);
  return resolvedRecoveryOf(candidates[0]!);
}

/** Resolve an opaque recovery reference against the current exact managed binding. */
export function resolveDispatchRecovery(
  request: ResolveDispatchRecoveryRequest,
  deps: DispatchServiceDeps,
): ResolvedDispatchRecovery {
  const current = assertRecoveryRequest(request, deps);
  if (!DISPATCH_RECOVERY_REFERENCE_RE.test(request.recoveryReference)) {
    throw new AttestationContractError(
      "recoveryReference",
      "expected an opaque cq-dispatch-recovery:v1 reference",
    );
  }
  const { atMs } = readNow(deps);
  const matches = deps.store
    .rows()
    .filter((row) => row.dispatchRecoveryBinding?.recoveryReference === request.recoveryReference)
    .map((row) => recoveryBindingOfRow(row, atMs, "reject"))
    .filter(
      (binding): binding is DispatchRecoveryBinding =>
        binding?.recoveryReference === request.recoveryReference,
    );
  if (matches.length === 0) {
    throw new DispatchRecoveryError("not-found", "dispatch recovery reference is not bound");
  }
  if (matches.length !== 1) {
    throw new DispatchRecoveryError("ambiguous", "dispatch recovery reference is ambiguous");
  }
  const binding = matches[0]!;
  if (!recoveryMatchesLiveBinding(binding, current, request.liveTip)) {
    throw new DispatchRecoveryError(
      "binding-mismatch",
      "dispatch recovery reference does not match the current managed handle or live tip",
    );
  }
  return resolvedRecoveryOf(binding);
}

// ---------------------------------------------------------------------------
// Consumed managed-worker continuation
// ---------------------------------------------------------------------------

export interface DiscoverDispatchContinuationRequest {
  readonly namespace: AttestationNamespace;
  readonly actor: TrustedDispatchContinuationClaimant;
  readonly gitEffectBinding: DispatchGitEffectBinding;
  readonly liveTip: string;
}

export interface ResolveDispatchContinuationRequest extends DiscoverDispatchContinuationRequest {
  readonly continuationReference: string;
}

function assertContinuationRequest(
  request: DiscoverDispatchContinuationRequest,
  deps: Deps,
): DispatchGitEffectBinding {
  assertTrustedNamespace(request.namespace, deps, "prepare_dispatch");
  if (!TRUSTED_CONTINUATION_CLAIMANT_SET.has(request.actor)) {
    throw new DispatchAuthorizationError(
      "prepare_dispatch",
      `untrusted continuation claimant "${String(request.actor)}"`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(request.liveTip)) {
    throw new AttestationContractError("liveTip", "expected a full commit SHA");
  }
  const binding = assertGitEffectBinding(request.gitEffectBinding, "implement-worker");
  if (binding === undefined || binding.conflictStateDigest !== undefined) {
    throw new AttestationContractError(
      "gitEffectBinding",
      "expected a live implement-worker manager binding",
    );
  }
  return binding;
}

function continuationBindingOfRow(
  row: AttestationRow,
  atMs: number,
  expired: "omit" | "reject",
): DispatchContinuationBinding | undefined {
  const binding = row.dispatchContinuationBinding;
  if (binding === undefined) return undefined;
  if (isAttestationTombstone(row)) {
    if (atMs >= attestationInstantMs(row.reuseAfter, "reuseAfter")) {
      if (expired === "omit") return undefined;
      throw new DispatchContinuationError("expired", "dispatch continuation has expired");
    }
    if (row.terminalKind !== "consumed") {
      throw new DispatchContinuationError(
        "non-consumed",
        "dispatch continuation tombstone is not a consumed generation",
      );
    }
  } else {
    if (row.terminalAt === undefined || !TERMINAL_STATE_SET.has(row.state)) {
      throw new DispatchContinuationError(
        "nonterminal",
        "dispatch continuation is attached to a nonterminal generation",
      );
    }
    if (atMs >= attestationInstantMs(row.terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS) {
      if (expired === "omit") return undefined;
      throw new DispatchContinuationError("expired", "dispatch continuation has expired");
    }
    if (row.state !== "consumed") {
      throw new DispatchContinuationError(
        "non-consumed",
        "dispatch continuation is not attached to a consumed generation",
      );
    }
  }
  const resolved = assertDispatchContinuationBinding(binding);
  if (
    resolved.attestationId !== row.attestationId ||
    resolved.generation !== row.generation ||
    resolved.terminalDigest !== row.terminalDigest ||
    resolved.terminalAt !== row.terminalAt
  ) {
    throw new DispatchContinuationError(
      "binding-mismatch",
      "dispatch continuation terminal identity differs from its attestation row",
    );
  }
  return resolved;
}

function continuationMatchesLiveBinding(
  continuation: DispatchContinuationBinding,
  current: DispatchGitEffectBinding,
  liveTip: string,
): boolean {
  return (
    continuation.liveTip === liveTip &&
    RECOVERY_BINDING_FIELDS.every(
      (field) => continuation.gitEffectBinding[field] === current[field],
    )
  );
}

function resolvedContinuationOf(
  binding: DispatchContinuationBinding,
): ResolvedDispatchContinuation {
  return Object.freeze({
    continuationReference: binding.continuationReference,
    reprepareOf: Object.freeze({
      attestationId: binding.attestationId,
      generation: binding.generation,
    }),
    terminalAt: binding.terminalAt,
    gitEffectBinding: binding.gitEffectBinding,
    liveTip: binding.liveTip,
    gitReceipts: Object.freeze([...binding.gitReceipts]),
    ...(binding.implementationEvidenceBootstrapRef === undefined
      ? {}
      : { implementationEvidenceBootstrapRef: binding.implementationEvidenceBootstrapRef }),
  });
}

/** Discover exactly one unclaimed consumed continuation for the live manager handle. */
export function discoverDispatchContinuation(
  request: DiscoverDispatchContinuationRequest,
  deps: DispatchServiceDeps,
): ResolvedDispatchContinuation {
  const current = assertContinuationRequest(request, deps);
  const { atMs } = readNow(deps);
  const candidates = deps.store
    .rows()
    .map((row) => continuationBindingOfRow(row, atMs, "omit"))
    .filter(
      (binding): binding is DispatchContinuationBinding =>
        binding !== undefined &&
        continuationClaimedBy(binding.continuationReference, deps) === undefined &&
        continuationMatchesLiveBinding(binding, current, request.liveTip),
    );
  if (candidates.length === 0) {
    throw new DispatchContinuationError(
      "not-found",
      "no unclaimed consumed continuation is bound to this managed handle and live tip",
    );
  }
  if (candidates.length !== 1) {
    throw new DispatchContinuationError(
      "ambiguous",
      "multiple consumed continuations match this managed handle and live tip",
    );
  }
  return resolvedContinuationOf(candidates[0]!);
}

/** Resolve an opaque continuation reference against one exact live manager binding. */
export function resolveDispatchContinuation(
  request: ResolveDispatchContinuationRequest,
  deps: DispatchServiceDeps,
): ResolvedDispatchContinuation {
  const current = assertContinuationRequest(request, deps);
  if (!DISPATCH_CONTINUATION_REFERENCE_RE.test(request.continuationReference)) {
    throw new AttestationContractError(
      "continuationReference",
      "expected an opaque cq-dispatch-continuation:v1 reference",
    );
  }
  const { atMs } = readNow(deps);
  const matches = deps.store
    .rows()
    .filter(
      (row) =>
        row.dispatchContinuationBinding?.continuationReference === request.continuationReference,
    )
    .map((row) => continuationBindingOfRow(row, atMs, "reject"))
    .filter(
      (binding): binding is DispatchContinuationBinding =>
        binding?.continuationReference === request.continuationReference,
    );
  if (matches.length === 0) {
    throw new DispatchContinuationError(
      "not-found",
      "dispatch continuation reference is not bound",
    );
  }
  if (matches.length !== 1) {
    throw new DispatchContinuationError(
      "ambiguous",
      "dispatch continuation reference is ambiguous",
    );
  }
  const binding = matches[0]!;
  if (continuationClaimedBy(binding.continuationReference, deps) !== undefined) {
    throw new DispatchContinuationError(
      "already-claimed",
      "dispatch continuation has already allocated its successor generation",
    );
  }
  if (!continuationMatchesLiveBinding(binding, current, request.liveTip)) {
    throw new DispatchContinuationError(
      "binding-mismatch",
      "dispatch continuation does not match the current managed handle or live tip",
    );
  }
  return resolvedContinuationOf(binding);
}

// ---------------------------------------------------------------------------
// Sweep: the 24h envelope collapse and the 30d tombstone drop
// ---------------------------------------------------------------------------

/**
 * Collapse one terminal envelope to the minimal tombstone. Retains the
 * mandatory {@link TOMBSTONE_RETAINED_FIELDS} and an eligible recovery binding;
 * the output, capability hashes, completion proof, prompt/catalog digests and
 * abort-reason body are dropped and unrecoverable.
 */
export function collapseAttestationEnvelope(row: AttestationEnvelope): AttestationTombstone {
  if (row.terminalAt === undefined || row.terminalDigest === undefined) {
    throw new AttestationContractError("row", `expected a terminal envelope, got "${row.state}"`);
  }
  if (!TERMINAL_STATE_SET.has(row.state)) {
    throw new AttestationContractError("row.state", `"${row.state}" is not a terminal state`);
  }
  const terminalMs = attestationInstantMs(row.terminalAt, "terminalAt");
  return Object.freeze({
    kind: "tombstone" as const,
    namespace: row.namespace,
    attestationId: row.attestationId,
    generation: row.generation,
    idempotencyKey: row.idempotencyKey,
    terminalKind: row.state as AttestationTerminalKind,
    inputDigest: row.promptProvenance.inputDigest,
    terminalDigest: row.terminalDigest,
    createdAt: row.createdAt,
    terminalAt: row.terminalAt,
    reuseAfter: isoAt(terminalMs + IDEMPOTENCY_HORIZON_MS),
    ...(row.dispatchRecoveryBinding === undefined
      ? {}
      : { dispatchRecoveryBinding: row.dispatchRecoveryBinding }),
    ...(row.dispatchContinuationBinding === undefined
      ? {}
      : { dispatchContinuationBinding: row.dispatchContinuationBinding }),
    ...(row.dispatchContinuationClaim === undefined
      ? {}
      : { dispatchContinuationClaim: row.dispatchContinuationClaim }),
  });
}

/**
 * Sweep the namespace at the injected clock: collapse every terminal envelope
 * whose 24h retention has elapsed, and DROP every tombstone past its 30d
 * horizon (which releases its idempotency key). Both boundaries are inclusive,
 * so a record swept at exactly `terminalAt + 24h` collapses and one at exactly
 * `terminalAt + 30d` is removed. Idempotent: a second sweep at the same instant
 * reports nothing further.
 */
export function sweepAttestations(deps: DispatchServiceDeps): AttestationSweepReport {
  const { at, atMs } = readNow(deps);
  const collapsed: DispatchHandle[] = [];
  const removed: DispatchHandle[] = [];
  for (const row of [...deps.store.rows()]) {
    assertSameNamespace(deps.store.namespace, row);
    if (isAttestationTombstone(row)) {
      if (atMs >= attestationInstantMs(row.reuseAfter, "reuseAfter")) {
        deps.store.remove(handleOf(row));
        removed.push(handleOf(row));
      }
      continue;
    }
    if (row.terminalAt === undefined) {
      continue;
    }
    const terminalMs = attestationInstantMs(row.terminalAt, "terminalAt");
    if (atMs >= terminalMs + IDEMPOTENCY_HORIZON_MS) {
      deps.store.remove(handleOf(row));
      removed.push(handleOf(row));
      continue;
    }
    if (atMs >= terminalMs + TERMINAL_ENVELOPE_RETENTION_MS) {
      deps.store.replace(row, collapseAttestationEnvelope(row));
      collapsed.push(handleOf(row));
    }
  }
  return Object.freeze({
    at,
    envelopesCollapsed: Object.freeze(collapsed),
    tombstonesRemoved: Object.freeze(removed),
    rowsRemaining: deps.store.rows().length,
  });
}

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/** The task that owns the namespaced production AttestationStore adapters. */
export const DISPATCH_ATTESTATION_DEFERRED_TO = "T720" as const;

/**
 * What this contract-level task deliberately does NOT cover, recorded so it is
 * not silently dropped. Each entry lands in
 * {@link DISPATCH_ATTESTATION_DEFERRED_TO}, except the MCP exposure, which is
 * T695's.
 */
export const DISPATCH_ATTESTATION_DEFERRED = Object.freeze([
  "namespaced-production-attestation-store-adapters",
  "real-backend-durability-and-crash-recovery",
  "cross-process-concurrent-key-reuse-under-a-real-lock",
  "scheduled-sweep-wiring",
] as const);

/** The task that exposes these operations over MCP. */
export const DISPATCH_ATTESTATION_MCP_DEFERRED_TO = "T695" as const;
