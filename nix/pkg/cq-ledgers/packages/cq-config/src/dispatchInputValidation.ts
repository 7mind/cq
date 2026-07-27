/**
 * Input-validation PLACEMENT for the compact dispatch contract (T976, goal G94).
 *
 * T682 pinned the OUTPUT side: the ordinary-flow operation vocabulary
 * ({@link DISPATCH_PROTOCOL_OPERATIONS}) contains no `validate_output`, so no
 * ordinary flow requires a model-visible output validation call. This module is
 * the symmetric INPUT-side clause, which nothing in the cutover previously
 * owned:
 *
 * **Ordinary dispatch validates the structured role input AND the declared
 * overlay data (T684's registry) INSIDE prepare — against the role
 * `inputSchema` bound at prepare — FAIL-CLOSED BEFORE any child launches. The
 * parent never issues a separate model-visible `validate_input` call.**
 *
 * Rationale. The parent must call prepare regardless, to obtain the
 * `attestationId` and the scoped result capability
 * ({@link DispatchPrepared}). Folding validation into prepare removes the extra
 * round-trip at zero cost, uniformly on all three surfaces
 * ({@link PROMPT_SURFACES}), and rejects bad input before launch tokens are
 * spent. Pi already validates in-process (T693 — accept only
 * `{roleId,input,overlay?}`; resolve/validate/digest); this module generalizes
 * that to the cross-surface contract so claude and codex inherit it rather than
 * diverging.
 *
 * Child-side self-validation is explicitly NOT the ordinary path: it validates
 * only AFTER launch cost is incurred, and it is a self-report (the D156 class,
 * which has already burned this project). It remains available ONLY for a
 * surface that structurally cannot route input through prepare — e.g. an
 * attested compact self-load child receiving input out-of-band — and such a
 * surface MUST carry an explicit recorded declaration in a
 * {@link ChildSideValidationExceptionRegistry}. The production registry
 * {@link CHILD_SIDE_VALIDATION_EXCEPTIONS} ships EMPTY: no surface currently
 * claims the exception, so every undeclared child-side claim is rejected.
 *
 * A pre-launch rejection is NOT a dispatch lifecycle state. It is a distinct
 * type ({@link DispatchPreLaunchRejection}) tagged `outcome:
 * "pre-launch-rejection"`, deliberately carrying no `state` field, so it can
 * never be read as one of T682's {@link DISPATCH_LIFECYCLE_STATES} — nothing
 * exists yet to have a state, because validation precedes allocation
 * ({@link DISPATCH_PREPARE_STEP_ORDER}).
 *
 * The `validate_input` / `validate_output` MCP tools are NOT removed from the
 * MCP surface ({@link RETAINED_NON_FLOW_MCP_VALIDATORS}); they remain the
 * allowlisted inspection/debug validators used by the Agents tab and the
 * pi/codex harnesses ({@link VALIDATE_INPUT_INSPECTION_CALLERS}). What this
 * clause forbids is an ordinary FLOW requiring one.
 *
 * DEFERRED to T977 ({@link DISPATCH_INPUT_VALIDATION_DEFERRED}): this module is
 * contract level only — `prepare_dispatch` does not exist yet (T695 exposes it
 * over MCP). The live enforcement path, the
 * no-attestation-allocated-on-rejection assertion against a real store, and
 * per-surface claude/codex/pi conformance all land there.
 *
 * This module calls {@link validateAgainstSchema} (Ajv) and is therefore NOT
 * browser-bundleable, like {@link ./validation} and {@link ./dispatchOverlays}.
 */

import { DISPATCHED_ROLE_SIDECARS } from "./promptCatalogStore.js";
import { PROMPT_SURFACES, type PromptSurface } from "./promptCatalog.js";
import { validateAgainstSchema, type ValidationError } from "./validation.js";
import {
  DispatchOverlayError,
  validateDispatchOverlayApplications,
  type DispatchOverlayRegistry,
} from "./dispatchOverlays.js";
import {
  DISPATCH_LIFECYCLE_STATES,
  type DispatchLifecycleState,
  type DispatchOverlayApplication,
  type DispatchedRoleId,
} from "./compactDispatchProtocol.js";

const SAFE_SURFACE_VARIANT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Closed-set membership via Set, so no `Object.prototype` name can pass. */
const SURFACE_SET: ReadonlySet<string> = new Set(PROMPT_SURFACES);
const LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(DISPATCH_LIFECYCLE_STATES);

/**
 * Authoring defect in an input-validation declaration — a malformed child-side
 * exception declaration or a prepare step order that allocates before it
 * validates. Distinct from a {@link DispatchPreLaunchRejection}, which is DATA
 * describing rejected dispatch input, not a broken declaration.
 */
export class DispatchInputValidationError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "DispatchInputValidationError";
  }
}

/**
 * The single tag of a pre-launch rejection. Deliberately absent from
 * {@link DISPATCH_LIFECYCLE_STATES}, and carried in an `outcome` field rather
 * than the lifecycle union's `state` field.
 */
export const DISPATCH_PRE_LAUNCH_OUTCOME = "pre-launch-rejection" as const;

/**
 * Why ordinary dispatch input was rejected before any child launched.
 *
 * The first six are T976's inside-prepare validation failures; the next six are
 * T978's server-side REFS-ASSEMBLY failures (see {@link ./dispatchRefAssembly});
 * the last is T685's LAUNCH-ENVELOPE failure, raised by `prepare` itself when the
 * idempotency key or the timeout is outside the bound contract (see
 * {@link ./dispatchAttestation}). They share ONE rejection type deliberately — a
 * caller distinguishes them by `reason`, never by catching a second rejection
 * shape.
 */
export const DISPATCH_PRE_LAUNCH_REJECTION_REASONS = [
  "unknown-role",
  "unsupported-surface",
  "invalid-role-input",
  "invalid-overlay-data",
  "unknown-validator-placement",
  "undeclared-child-side-validation",
  "invalid-refs-form",
  "inline-narrative-courier",
  "no-ref-assembler",
  "unresolvable-ref",
  "cross-project-ref",
  "invalid-parent-guidance",
  "invalid-launch-envelope",
] as const;

export type DispatchPreLaunchRejectionReason =
  (typeof DISPATCH_PRE_LAUNCH_REJECTION_REASONS)[number];

/**
 * A typed PRE-LAUNCH REJECTION: dispatch input failed validation inside
 * prepare, so no child launched and nothing was allocated. Not a lifecycle
 * state — see {@link PreLaunchRejectionOutcomeIsNotALifecycleState}.
 */
export interface DispatchPreLaunchRejection {
  readonly accepted: false;
  readonly outcome: typeof DISPATCH_PRE_LAUNCH_OUTCOME;
  readonly reason: DispatchPreLaunchRejectionReason;
  /** The failing field path, e.g. `input` or `overlays[0].data`. */
  readonly path: string;
  readonly detail: string;
  /** Validate-then-allocate: nothing is allocated for input that fails. */
  readonly allocated: false;
}

/**
 * Compile-time proof that the pre-launch rejection tag is disjoint from T682's
 * lifecycle-state union: the {@link Extract} below must resolve to `never`, and
 * `NeverOnly` fails to typecheck for anything else. Adding a lifecycle state
 * named `pre-launch-rejection` (or retagging the rejection with a lifecycle
 * value) breaks `tsc`, not just a test.
 */
type NeverOnly<T extends never> = T;
export type PreLaunchRejectionOutcomeIsNotALifecycleState = NeverOnly<
  Extract<DispatchPreLaunchRejection["outcome"], DispatchLifecycleState>
>;

/** Accepted ordinary dispatch input. Carries no attestation and no capability. */
export interface DispatchInputAccepted {
  readonly accepted: true;
  readonly roleId: DispatchedRoleId;
  readonly surface: PromptSurface;
  /** The sidecar contract version the input was validated against (T683). */
  readonly sidecarVersion: number;
  /** Declared overlay ids, in canonical registry declaration order. */
  readonly appliedOverlayIds: readonly string[];
}

export type DispatchInputValidation = DispatchInputAccepted | DispatchPreLaunchRejection;

/**
 * The declared inside-prepare input-validation placement — the single
 * authoritative statement of the T976 rule, in machine-readable form.
 */
export const DISPATCH_INPUT_VALIDATION_PLACEMENT = Object.freeze({
  /** Validation happens inside prepare, not in a separate parent call. */
  placement: "inside-prepare",
  /** Nothing is allocated for input that fails validation. */
  ordering: "validate-then-allocate",
  failureMode: "fail-closed-before-launch",
  /** What prepare validates, against the contract bound at prepare. */
  validated: Object.freeze(["role-input", "declared-overlay-data"] as const),
  boundContract: "role-inputSchema-bound-at-prepare",
  /** The T976 input-side clause, mirroring T682's output-side clause. */
  modelVisibleValidateInputRequired: false,
  /** T682's clause, restated here so both sides read from one declaration. */
  modelVisibleValidateOutputRequired: false,
  /** Child-side self-validation is a declared exception, never the default. */
  childSideSelfValidationIsOrdinaryPath: false,
  uniformAcrossSurfaces: Object.freeze([...PROMPT_SURFACES]),
} as const);

/** The prepare steps that validate. All of them precede every allocation step. */
export const DISPATCH_PREPARE_VALIDATION_STEPS = [
  "resolve-role-contract",
  "validate-role-input",
  "validate-declared-overlay-data",
] as const;

/** The prepare steps that allocate. None may precede a validation step. */
export const DISPATCH_PREPARE_ALLOCATION_STEPS = [
  "allocate-attestation",
  "mint-result-capability",
] as const;

/** The declared prepare step order: validate, then allocate. */
export const DISPATCH_PREPARE_STEP_ORDER = [
  ...DISPATCH_PREPARE_VALIDATION_STEPS,
  ...DISPATCH_PREPARE_ALLOCATION_STEPS,
] as const;

export type DispatchPrepareStep = (typeof DISPATCH_PREPARE_STEP_ORDER)[number];

const VALIDATION_STEP_SET: ReadonlySet<string> = new Set(DISPATCH_PREPARE_VALIDATION_STEPS);
const ALLOCATION_STEP_SET: ReadonlySet<string> = new Set(DISPATCH_PREPARE_ALLOCATION_STEPS);

/**
 * Assert that a candidate prepare step order is a permutation of
 * {@link DISPATCH_PREPARE_STEP_ORDER} in which EVERY validation step precedes
 * EVERY allocation step. Throws {@link DispatchInputValidationError} on an
 * unknown, duplicated, or missing step, or on any order that would allocate for
 * input it has not yet validated.
 */
export function assertValidateThenAllocate(order: readonly string[]): void {
  if (!Array.isArray(order)) {
    throw new DispatchInputValidationError("order", "expected an ordered prepare step list");
  }
  const seen = new Set<string>();
  for (const [index, step] of order.entries()) {
    if (
      typeof step !== "string" ||
      (!VALIDATION_STEP_SET.has(step) && !ALLOCATION_STEP_SET.has(step))
    ) {
      throw new DispatchInputValidationError(
        `order[${index}]`,
        `unknown prepare step "${String(step)}"`,
      );
    }
    if (seen.has(step)) {
      throw new DispatchInputValidationError(`order[${index}]`, `duplicate prepare step "${step}"`);
    }
    seen.add(step);
  }
  if (seen.size !== DISPATCH_PREPARE_STEP_ORDER.length) {
    const missing = DISPATCH_PREPARE_STEP_ORDER.filter((step) => !seen.has(step));
    throw new DispatchInputValidationError("order", `missing prepare step "${missing.join(", ")}"`);
  }
  let lastValidation = -1;
  let firstAllocation = order.length;
  for (const [index, step] of order.entries()) {
    if (VALIDATION_STEP_SET.has(step)) {
      lastValidation = index;
    } else if (index < firstAllocation) {
      firstAllocation = index;
    }
  }
  if (firstAllocation < lastValidation) {
    throw new DispatchInputValidationError(
      `order[${firstAllocation}]`,
      "allocation precedes validation — nothing may be allocated for unvalidated input",
    );
  }
}

/**
 * The MCP validators retained OUTSIDE the ordinary-flow operation vocabulary.
 * They stay on the MCP surface for inspection and debugging; the T682/T976
 * clauses only forbid an ordinary FLOW from requiring one.
 */
export const RETAINED_NON_FLOW_MCP_VALIDATORS = ["validate_input", "validate_output"] as const;

/** The allowlisted non-flow callers of the retained `validate_input` tool. */
export const VALIDATE_INPUT_INSPECTION_CALLERS = [
  "agents-tab",
  "pi-harness",
  "codex-harness",
] as const;

export type ValidateInputInspectionCaller = (typeof VALIDATE_INPUT_INSPECTION_CALLERS)[number];

const INSPECTION_CALLER_SET: ReadonlySet<string> = new Set(VALIDATE_INPUT_INSPECTION_CALLERS);

/**
 * Whether `caller` is an allowlisted inspection/debug consumer of the retained
 * `validate_input` tool. Set-based, so no `Object.prototype` name passes.
 */
export function isAllowlistedValidateInputCaller(caller: string): boolean {
  return typeof caller === "string" && INSPECTION_CALLER_SET.has(caller);
}

/** How a tag crossing an untyped boundary classifies against the two vocabularies. */
export type DispatchOutcomeTagClass = "lifecycle-state" | "pre-launch-rejection" | "unknown";

/**
 * Classify one outcome tag. A pre-launch rejection and a lifecycle state can
 * never classify as each other, and an unrecognized tag — including every
 * `Object.prototype` property name — classifies as `unknown`.
 */
export function classifyDispatchOutcomeTag(tag: string): DispatchOutcomeTagClass {
  if (typeof tag !== "string") {
    return "unknown";
  }
  if (LIFECYCLE_STATE_SET.has(tag)) {
    return "lifecycle-state";
  }
  if (tag === DISPATCH_PRE_LAUNCH_OUTCOME) {
    return "pre-launch-rejection";
  }
  return "unknown";
}

/**
 * Runtime type guard for a pre-launch rejection value. The parameter is the
 * structural supertype `{ accepted }` so the ONE rejection type is recognizable
 * on every pre-launch result union — T976's validation, T976's validator
 * resolution, and T978's refs assembly — without a second guard per module.
 */
export function isDispatchPreLaunchRejection(value: {
  readonly accepted: boolean;
}): value is DispatchPreLaunchRejection {
  return (
    value.accepted === false &&
    Object.hasOwn(value, "outcome") &&
    (value as DispatchPreLaunchRejection).outcome === DISPATCH_PRE_LAUNCH_OUTCOME
  );
}

/**
 * One explicitly recorded exception to the inside-prepare placement: a surface
 * variant that structurally cannot route dispatch input through prepare, so its
 * child validates its own input. Registration is the ONLY way a child-side
 * validator becomes acceptable.
 */
export interface ChildSideValidationException {
  /** Closed identifier of the surface variant, e.g. `attested-compact-self-load`. */
  readonly surfaceVariant: string;
  readonly surface: PromptSurface;
  /** Why input structurally cannot reach prepare on this variant. */
  readonly rationale: string;
  /** Where the exception is recorded (a ledger item id or task id). */
  readonly declaredIn: string;
}

/** Child-side validation exceptions keyed by surface variant, in declaration order. */
export type ChildSideValidationExceptionRegistry = Readonly<
  Record<string, ChildSideValidationException>
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, path: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DispatchInputValidationError(path, `expected a non-empty ${label}`);
  }
}

/**
 * Build a child-side-validation exception registry from explicit declarations,
 * failing closed on an unsafe or duplicate surface variant, an unknown prompt
 * surface, or a missing rationale / declaration reference. The production
 * registry is {@link CHILD_SIDE_VALIDATION_EXCEPTIONS}.
 */
export function createChildSideValidationExceptionRegistry(
  declarations: readonly ChildSideValidationException[],
): ChildSideValidationExceptionRegistry {
  // Null-prototype: surface-variant keys are caller-chosen, so no
  // Object.prototype property may masquerade as a recorded declaration.
  const registry: Record<string, ChildSideValidationException> = Object.create(null) as Record<
    string,
    ChildSideValidationException
  >;
  for (const [index, declaration] of declarations.entries()) {
    const path = `childSideValidation[${index}]`;
    if (!isRecord(declaration)) {
      throw new DispatchInputValidationError(path, "expected an exception declaration object");
    }
    const surfaceVariant = declaration.surfaceVariant;
    if (typeof surfaceVariant !== "string" || !SAFE_SURFACE_VARIANT_PATTERN.test(surfaceVariant)) {
      throw new DispatchInputValidationError(
        `${path}.surfaceVariant`,
        "expected a safe surface-variant identifier",
      );
    }
    if (Object.hasOwn(registry, surfaceVariant)) {
      throw new DispatchInputValidationError(
        `${path}.surfaceVariant`,
        `duplicate surface variant "${surfaceVariant}"`,
      );
    }
    if (typeof declaration.surface !== "string" || !SURFACE_SET.has(declaration.surface)) {
      throw new DispatchInputValidationError(
        `${path}.surface`,
        `unknown prompt surface "${String(declaration.surface)}"`,
      );
    }
    assertNonEmptyString(declaration.rationale, `${path}.rationale`, "rationale");
    assertNonEmptyString(declaration.declaredIn, `${path}.declaredIn`, "declaration reference");
    registry[surfaceVariant] = Object.freeze({
      surfaceVariant,
      surface: declaration.surface,
      rationale: declaration.rationale,
      declaredIn: declaration.declaredIn,
    });
  }
  return Object.freeze(registry);
}

/**
 * The authoritative production registry of child-side-validation exceptions. It
 * ships EMPTY by decision (T976): every shipped surface routes dispatch input
 * through prepare, so every child-side claim is undeclared and rejected. Adding
 * one means adding an explicit declaration HERE.
 */
export const CHILD_SIDE_VALIDATION_EXCEPTIONS: ChildSideValidationExceptionRegistry =
  createChildSideValidationExceptionRegistry([]);

/** Where a surface claims its dispatch-input validation happens. */
export const DISPATCH_INPUT_VALIDATOR_PLACEMENTS = ["inside-prepare", "child-side"] as const;

export type DispatchInputValidatorPlacement = (typeof DISPATCH_INPUT_VALIDATOR_PLACEMENTS)[number];

const PLACEMENT_SET: ReadonlySet<string> = new Set(DISPATCH_INPUT_VALIDATOR_PLACEMENTS);

/** A surface's claim about where it validates dispatch input. */
export interface DispatchInputValidatorClaim {
  readonly placement: DispatchInputValidatorPlacement;
  readonly surfaceVariant: string;
}

export interface InsidePrepareValidatorResolution {
  readonly accepted: true;
  readonly placement: "inside-prepare";
}

export interface ChildSideValidatorResolution {
  readonly accepted: true;
  readonly placement: "child-side";
  readonly declaration: ChildSideValidationException;
}

export type DispatchInputValidatorResolution =
  InsidePrepareValidatorResolution | ChildSideValidatorResolution | DispatchPreLaunchRejection;

/**
 * THE single constructor of a {@link DispatchPreLaunchRejection}. Exported so
 * every pre-launch failure — inside-prepare validation (this module) and
 * server-side refs assembly ({@link ./dispatchRefAssembly}) alike — produces one
 * rejection type with one tag, instead of a second parallel rejection shape.
 */
export function dispatchPreLaunchRejection(
  reason: DispatchPreLaunchRejectionReason,
  path: string,
  detail: string,
): DispatchPreLaunchRejection {
  return Object.freeze({
    accepted: false as const,
    outcome: DISPATCH_PRE_LAUNCH_OUTCOME,
    reason,
    path,
    detail,
    allocated: false as const,
  });
}

const reject = dispatchPreLaunchRejection;

/**
 * Resolve a surface's validator-placement claim. The ordinary
 * `inside-prepare` claim always resolves; a `child-side` claim resolves ONLY
 * against an explicitly recorded declaration in `exceptions`, and otherwise
 * yields a pre-launch rejection — an undeclared child-side validator is never
 * accepted.
 */
export function resolveDispatchInputValidator(
  claim: DispatchInputValidatorClaim,
  exceptions: ChildSideValidationExceptionRegistry,
): DispatchInputValidatorResolution {
  const placement: unknown = claim.placement;
  if (typeof placement !== "string" || !PLACEMENT_SET.has(placement)) {
    return reject(
      "unknown-validator-placement",
      "placement",
      `unknown validator placement "${String(placement)}"`,
    );
  }
  if (placement === "inside-prepare") {
    return Object.freeze({ accepted: true as const, placement: "inside-prepare" as const });
  }
  const surfaceVariant: unknown = claim.surfaceVariant;
  // Object.hasOwn: `in` would accept an Object.prototype name ("constructor",
  // "toString", ...) as a recorded exception and admit an undeclared
  // child-side validator.
  if (
    typeof surfaceVariant !== "string" ||
    !Object.hasOwn(exceptions, surfaceVariant) ||
    exceptions[surfaceVariant] === undefined
  ) {
    return reject(
      "undeclared-child-side-validation",
      "surfaceVariant",
      `child-side input validation is not declared for "${String(surfaceVariant)}"`,
    );
  }
  return Object.freeze({
    accepted: true as const,
    placement: "child-side" as const,
    declaration: exceptions[surfaceVariant],
  });
}

/** The inside-prepare validation input: role input plus declared overlay data. */
export interface DispatchInputValidationRequest {
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly roleId: string;
  readonly input: unknown;
  /** Kept as string so untyped boundary callers get a typed rejection. */
  readonly surface: string;
  /** Declared overlay applications; absent means none. */
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly registry: DispatchOverlayRegistry;
}

function describeErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`)
    .join("; ");
}

/**
 * THE inside-prepare dispatch-input validation entry point (T976). Validates
 * the structured role input against the role's bound `inputSchema` and the
 * declared overlay data against T684's registry, and fails closed BEFORE
 * anything is allocated and BEFORE any child launches.
 *
 * Returns {@link DispatchInputAccepted} — which carries no attestation id and
 * no result capability, because this step allocates nothing — or a typed
 * {@link DispatchPreLaunchRejection}, which is NOT a lifecycle state.
 *
 * The live `prepare_dispatch` enforcement path that calls this, the
 * no-attestation-allocated assertion against a real store, and per-surface
 * conformance are DEFERRED to T977
 * ({@link DISPATCH_INPUT_VALIDATION_DEFERRED}).
 */
export function validateDispatchInput(
  request: DispatchInputValidationRequest,
): DispatchInputValidation {
  const roleId: unknown = request.roleId;
  // Object.hasOwn: `in` or a bare index lookup would resolve an
  // Object.prototype name ("constructor", "toString", ...) to an inherited
  // value and admit a phantom dispatched role.
  if (typeof roleId !== "string" || !Object.hasOwn(DISPATCHED_ROLE_SIDECARS, roleId)) {
    return reject("unknown-role", "roleId", `unknown dispatched role "${String(roleId)}"`);
  }
  const surface: unknown = request.surface;
  if (typeof surface !== "string" || !SURFACE_SET.has(surface)) {
    return reject(
      "unsupported-surface",
      "surface",
      `unsupported prompt surface "${String(surface)}"`,
    );
  }
  const sidecar = DISPATCHED_ROLE_SIDECARS[roleId as DispatchedRoleId];
  const inputResult = validateAgainstSchema(sidecar.inputSchema, request.input);
  if (!inputResult.ok) {
    return reject(
      "invalid-role-input",
      "input",
      `invalid role input: ${describeErrors(inputResult.errors)}`,
    );
  }
  let appliedOverlayIds: readonly string[];
  try {
    appliedOverlayIds = validateDispatchOverlayApplications(
      roleId as DispatchedRoleId,
      surface as PromptSurface,
      request.overlays ?? [],
      request.registry,
    );
  } catch (error) {
    if (error instanceof DispatchOverlayError) {
      return reject("invalid-overlay-data", "overlays", error.message);
    }
    throw error;
  }
  return Object.freeze({
    accepted: true as const,
    roleId: roleId as DispatchedRoleId,
    surface: surface as PromptSurface,
    sidecarVersion: sidecar.version,
    appliedOverlayIds,
  });
}

/** The task that owns the runtime half of this contract. */
export const DISPATCH_INPUT_VALIDATION_DEFERRED_TO = "T977" as const;

/**
 * What this contract-level task deliberately does NOT cover, recorded so it is
 * not silently dropped. Each entry lands in
 * {@link DISPATCH_INPUT_VALIDATION_DEFERRED_TO}.
 */
export const DISPATCH_INPUT_VALIDATION_DEFERRED = Object.freeze([
  "live-prepare-dispatch-enforcement-path",
  "no-attestation-allocated-on-rejection-against-a-real-store",
  "per-surface-claude-codex-pi-conformance",
] as const);
