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
  type ResultCapability,
  type StoreDispatchResult,
} from "./compactDispatchProtocol.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ATTESTATION_ID_RE = /^att_[A-Za-z0-9_-]{32,}$/;
const INPUT_CAPABILITY_RE = /^cq_input_[A-Za-z0-9_-]{43,}$/;
const RESULT_CAPABILITY_RE = /^cq_result_[A-Za-z0-9_-]{43,}$/;
const GIT_CHANGE_CAPABILITY_RE = /^cq_git_[A-Za-z0-9_-]{43,}$/;
const GIT_CONFLICT_CAPABILITY_RE = /^cq_conflict_[A-Za-z0-9_-]{43,}$/;
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
export interface AttestationNamespace {
  readonly backend: LedgerBackend;
  readonly projectKey: string;
}

const LEDGER_BACKEND_SET: ReadonlySet<string> = new Set(LEDGER_BACKENDS);

/**
 * Validate a namespace declaration. Set-based backend membership, so no
 * `Object.prototype` name passes as a backend.
 */
export function assertAttestationNamespace(
  namespace: AttestationNamespace,
  path = "namespace",
): AttestationNamespace {
  const backend: unknown = namespace?.backend;
  if (typeof backend !== "string" || !LEDGER_BACKEND_SET.has(backend)) {
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
  return Object.freeze({ backend: backend as LedgerBackend, projectKey });
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
}

export interface AuthorizedDispatchGitEffect extends DispatchGitEffectBinding {
  readonly attestationId: string;
  readonly generation: number;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly surface: string;
  readonly childCancelAt: string;
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
  readonly deadlines: DispatchDeadlines;
  readonly expectedChild: NativeChildIdentity;
  /** HASH of the one-shot input capability. The token itself is never stored. */
  readonly inputCapabilityHash: string;
  readonly inputMaterializedAt?: string;
  /** The HASH of the minted capability. The token itself is never stored. */
  readonly resultCapabilityHash: string;
  readonly gitChangeCapabilityHash?: string;
  readonly gitConflictCapabilityHash?: string;
  readonly gitEffectBinding?: DispatchGitEffectBinding;
  readonly createdAt: string;
  readonly storedAt?: string;
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
}

/**
 * A terminal record whose 24h envelope has expired. It retains ONLY the
 * namespace, the idempotency key, the payload/attestation/terminal digests and
 * the timestamps — deliberately NOT the output, the capability hash, the
 * completion proof, the prompt or catalog digest, the schema, or the abort
 * reason body. {@link TOMBSTONE_RETAINED_FIELDS} pins the key set.
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
}

export type AttestationRow = AttestationEnvelope | AttestationTombstone;

/** Exactly what a collapsed tombstone retains. Asserted by the collapse. */
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
  "gitChangeCapabilityHash",
  "gitConflictCapabilityHash",
  "gitEffectBinding",
  "input",
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
      throw new AttestationContractError(`gitEffectBinding.${field}`, "expected a non-empty string");
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
  return Object.freeze({ ...binding });
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
  const inputDigest = dispatchPayloadDigest(preparedInput);

  // --- allocation phase -------------------------------------------------
  const { at, atMs } = prepareInstant ?? readNow(deps);
  const generation = resolveGeneration(request.reprepareOf, deps);
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
  deps.store.insert(
    Object.freeze({
      kind: "envelope" as const,
      namespace,
      attestationId,
      generation,
      idempotencyKey,
      state: "prepared" as const,
      promptProvenance,
      prepareRequestDigest,
      input: preparedInput,
      deadlines,
      expectedChild,
      inputCapabilityHash: inputCapabilityHash(inputCapability.token),
      resultCapabilityHash: resultCapabilityHash(resultCapability.token),
      ...(gitChangeCapability === undefined
        ? {}
        : { gitChangeCapabilityHash: gitChangeCapabilityHash(gitChangeCapability.token) }),
      ...(gitConflictCapability === undefined
        ? {}
        : { gitConflictCapabilityHash: gitConflictCapabilityHash(gitConflictCapability.token) }),
      ...(gitEffectBinding === undefined ? {} : { gitEffectBinding }),
      createdAt: at,
    }),
  );
  return Object.freeze({
    accepted: true as const,
    prepared: Object.freeze({
      attestationId,
      generation,
      ...deadlines,
      promptProvenance,
      inputCapability,
      resultCapability,
      ...(gitChangeCapability === undefined ? {} : { gitChangeCapability }),
      ...(gitConflictCapability === undefined ? {} : { gitConflictCapability }),
    }),
    handle: Object.freeze({ attestationId, generation }),
    executedStepOrder: Object.freeze(executed),
  });
}

function resolveGeneration(
  reprepareOf: DispatchHandle | undefined,
  deps: PrepareDispatchDeps,
): number {
  if (reprepareOf === undefined) {
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
  return reprepareOf.generation + 1;
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
    throw new DispatchAuthorizationError("git_commit", "dispatch has no implement-worker Git binding");
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
    throw new DispatchAuthorizationError("git_resolve_continue", "malformed Git conflict capability");
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

function abortedResultOf(row: AttestationEnvelope): AbortedDispatchResult {
  if (row.state !== "aborted" || row.abortedAt === undefined || row.abortReason === undefined) {
    throw new AttestationContractError("row", `expected an aborted envelope, got "${row.state}"`);
  }
  return Object.freeze({
    state: "aborted" as const,
    attestationId: row.attestationId,
    generation: row.generation,
    abortedAt: row.abortedAt,
    reason: row.abortReason,
    ...(row.abortDetails === undefined ? {} : { details: row.abortDetails }),
  });
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
): AbortedDispatchResult {
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
    terminalDigest: terminalDigestOf("aborted", {
      reason,
      detailsDigest: details === undefined ? null : dispatchPayloadDigest(details),
    }),
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
  const result = validateAgainstSchema(sidecar.outputSchema, submission.output);
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

  const next: AttestationEnvelope = Object.freeze({
    ...row,
    state: "result-stored" as const,
    storedAt: at,
    output: submission.output,
    outputDigest,
  });
  deps.store.replace(row, next);
  return Object.freeze({ state: "result-stored" as const, result: storedViewOf(next) });
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
  const { at } = readNow(deps);
  if (row.state === "consumed") {
    const existing = row.nativeCompletion;
    if (
      existing !== undefined &&
      existing.actor === proof.actor &&
      existing.childId === proof.childId &&
      existing.runId === proof.runId &&
      existing.completedAt === proof.completedAt
    ) {
      return Object.freeze({ state: "consumed" as const, result: confirmedViewOf(row) });
    }
    throw new DispatchStateConflictError(
      CONFIRM,
      row.state,
      `attestation "${row.attestationId}" is already consumed under a different completion proof`,
    );
  }
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
  if (row.output === undefined || row.outputDigest === undefined) {
    throw new AttestationContractError("row", "a result-stored envelope must carry its output");
  }
  const next: AttestationEnvelope = Object.freeze({
    ...row,
    state: "consumed" as const,
    consumedAt: at,
    nativeCompletion: proof,
    terminalAt: at,
    terminalDigest: terminalDigestOf("consumed", {
      outputDigest: row.outputDigest,
      childId: proof.childId,
      runId: proof.runId,
      completedAt: proof.completedAt,
    }),
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
  if (row.state === "consumed") {
    throw new DispatchStateConflictError(
      ABORT,
      row.state,
      `attestation "${row.attestationId}" is already consumed and cannot be aborted`,
    );
  }
  const { at } = readNow(deps);
  return writeAbort(row, at, reason as DispatchAbortReason, details, deps);
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
// Sweep: the 24h envelope collapse and the 30d tombstone drop
// ---------------------------------------------------------------------------

/**
 * Collapse one terminal envelope to the minimal tombstone. Retains ONLY
 * {@link TOMBSTONE_RETAINED_FIELDS}; the output, the capability hash, the
 * completion proof, the prompt/catalog digests and the abort reason body are
 * dropped and unrecoverable.
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
