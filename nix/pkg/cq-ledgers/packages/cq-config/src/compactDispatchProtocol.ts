import { DISPATCHED_ROLE_IDS, DISPATCHED_ROLE_SIDECARS } from "./promptCatalogStore.js";
import { PROMPT_SURFACES, type JSONSchema, type PromptSurface } from "./promptCatalog.js";
import {
  DISPATCH_OVERLAY_REGISTRY,
  dispatchOverlayListSchema,
  type DispatchOverlayRegistry,
} from "./dispatchOverlays.js";
import { IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS } from "./schemas/implement-reviewer.js";

/** The dispatched-role ids accepted by the compact launch boundary. */
export type DispatchedRoleId = keyof typeof DISPATCHED_ROLE_SIDECARS;

/** JSON-compatible data carried as a role input, role output, overlay, or abort detail. */
export type DispatchJSONValue =
  | null
  | boolean
  | number
  | string
  | readonly DispatchJSONValue[]
  | { readonly [key: string]: DispatchJSONValue };

/** One runtime overlay application. The authoritative registry starts empty. */
export interface DispatchOverlayApplication {
  readonly overlayId: string;
  readonly data: DispatchJSONValue;
}

/**
 * The sole ordinary dispatched-subagent launch request. Role input stays
 * structured under `input`; prompt bytes, schemas, arbitrary task prose,
 * namespace, generation, and protocol negotiation have no fields here.
 */
export interface CompactDispatchLaunch {
  readonly roleId: DispatchedRoleId;
  readonly input: DispatchJSONValue;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly overlays?: readonly DispatchOverlayApplication[];
}

/** Stable public identity for one prepared dispatch generation. */
export interface DispatchHandle {
  readonly attestationId: string;
  readonly generation: number;
}

/** The child-facing capability authorizes exactly one result submission operation. */
export interface ResultCapability {
  readonly scope: "store-result";
  readonly token: string;
}

/** The child-facing capability authorizes exactly one assembled-input retrieval. */
export interface InputCapability {
  readonly scope: "fetch-input";
  readonly token: string;
}

/** Implement-worker-only authority for the trusted Git change broker. */
export interface GitChangeCapability {
  readonly scope: "git-change";
  readonly token: string;
}

/** Implement-conflict-resolver-only authority for one observed rebase continuation. */
export interface GitConflictCapability {
  readonly scope: "git-conflict";
  readonly token: string;
}

/** Compact prompt identity returned by prepare without prompt or schema materialization. */
export interface DispatchPromptProvenance {
  readonly roleId: DispatchedRoleId;
  readonly version: number;
  readonly surface: PromptSurface;
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly inputDigest: string;
}

/** Authoritative dispatch timing established by prepare. */
export interface DispatchDeadlines {
  readonly responseStoreNow: string;
  readonly childCancelAt: string;
  readonly launchDeadline: string;
}

/** Successful prepare response, including separate least-privilege child capabilities. */
export interface DispatchPrepared extends DispatchHandle, DispatchDeadlines {
  readonly promptProvenance: DispatchPromptProvenance;
  readonly inputCapability: InputCapability;
  readonly resultCapability: ResultCapability;
  readonly gitChangeCapability?: GitChangeCapability;
  readonly gitConflictCapability?: GitConflictCapability;
}

/** One-shot, capability-bound child retrieval of the prepare-bound typed input. */
export interface FetchDispatchInput extends DispatchHandle {
  readonly inputCapability: InputCapability;
}

/** The only successful response from {@link FetchDispatchInput}. */
export interface MaterializedDispatchInput extends DispatchHandle {
  readonly state: "input-materialized";
  readonly input: DispatchJSONValue;
  readonly promptProvenance: DispatchPromptProvenance;
  readonly materializedAt: string;
}

/** Capability-bound child result submission. */
export interface StoreDispatchResult {
  readonly resultCapability: ResultCapability;
  readonly output: DispatchJSONValue;
}

/** Proof supplied only by the trusted native parent bridge or Pi extension. */
export interface NativeCompletionProof {
  readonly kind: "native-completion";
  readonly actor: "trusted-parent" | "trusted-extension";
  readonly childId: string;
  readonly runId: string;
  readonly completedAt: string;
}

/** Trusted promotion request from result-stored to consumed. */
export interface ConfirmDispatchCompletion extends DispatchHandle {
  readonly nativeCompletion: NativeCompletionProof;
}

export const DISPATCH_ABORT_REASONS = [
  "cancelled",
  "native-failure",
  "protocol-violation",
  "invalid-output",
  "missing-result",
  "deadline-exceeded",
  "parent-lost",
] as const;

export type DispatchAbortReason = (typeof DISPATCH_ABORT_REASONS)[number];

/** Trusted terminal abort request. */
export interface AbortDispatch extends DispatchHandle {
  readonly reason: DispatchAbortReason;
  readonly details?: DispatchJSONValue;
}

export const DISPATCH_LIFECYCLE_STATES = [
  "prepared",
  "result-stored",
  "consumed",
  "aborted",
  "terminal-envelope-expired",
  "attestation-not-found",
] as const;

export type DispatchLifecycleState = (typeof DISPATCH_LIFECYCLE_STATES)[number];

export const FETCH_DISPATCH_RESULT_STATES = [
  ...DISPATCH_LIFECYCLE_STATES,
  "output-already-materialized",
] as const;

export type FetchDispatchResultState = (typeof FETCH_DISPATCH_RESULT_STATES)[number];

export interface PreparedDispatchResult extends DispatchHandle, DispatchDeadlines {
  readonly state: "prepared";
  readonly promptProvenance: DispatchPromptProvenance;
}

export interface ResultStoredDispatchResult extends DispatchHandle {
  readonly state: "result-stored";
  readonly storedAt: string;
  readonly promptProvenance: DispatchPromptProvenance;
}

export interface ConsumedDispatchResult extends DispatchHandle {
  readonly state: "consumed";
  readonly consumedAt: string;
  readonly output: DispatchJSONValue;
  readonly promptProvenance: DispatchPromptProvenance;
  readonly nativeCompletion: NativeCompletionProof;
}

export interface AbortedDispatchResult extends DispatchHandle {
  readonly state: "aborted";
  readonly abortedAt: string;
  readonly reason: DispatchAbortReason;
  readonly details?: DispatchJSONValue;
}

export interface TerminalEnvelopeExpiredDispatchResult extends DispatchHandle {
  readonly state: "terminal-envelope-expired";
  readonly terminalKind: "consumed" | "aborted";
  readonly reuseAfter: string;
}

export interface AttestationNotFoundDispatchResult extends DispatchHandle {
  readonly state: "attestation-not-found";
}

export interface OutputAlreadyMaterializedDispatchResult extends DispatchHandle {
  readonly state: "output-already-materialized";
  readonly materializedAt: string;
}

/**
 * A lookup reports only lifecycle states. Authorization, transport, and storage
 * failures remain errors at their respective boundary and cannot masquerade as
 * a state in this union.
 */
export type FetchDispatchResult =
  | PreparedDispatchResult
  | ResultStoredDispatchResult
  | ConsumedDispatchResult
  | AbortedDispatchResult
  | TerminalEnvelopeExpiredDispatchResult
  | AttestationNotFoundDispatchResult
  | OutputAlreadyMaterializedDispatchResult;

/** The complete ordinary-flow operation vocabulary for the breaking cutover. */
export const DISPATCH_PROTOCOL_OPERATIONS = [
  "prepare_dispatch",
  "fetch_dispatch_input",
  "store_result",
  "confirm_dispatch_completion",
  "abort_dispatch",
  "fetch_dispatch_result",
  "git_commit",
  "git_resolve_continue",
] as const;

export type DispatchProtocolOperation = (typeof DISPATCH_PROTOCOL_OPERATIONS)[number];

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
export const DISPATCH_UTC_TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const ATTESTATION_ID_PATTERN = "^att_[A-Za-z0-9_-]{32,}$";
const INPUT_CAPABILITY_PATTERN = "^cq_input_[A-Za-z0-9_-]{43,}$";
const RESULT_CAPABILITY_PATTERN = "^cq_result_[A-Za-z0-9_-]{43,}$";
const GIT_CHANGE_CAPABILITY_PATTERN = "^cq_git_[A-Za-z0-9_-]{43,}$";
const GIT_CONFLICT_CAPABILITY_PATTERN = "^cq_conflict_[A-Za-z0-9_-]{43,}$";

const handleProperties = {
  attestationId: { type: "string", pattern: ATTESTATION_ID_PATTERN },
  generation: { type: "integer", minimum: 1 },
} as const;

const deadlineProperties = {
  responseStoreNow: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
  childCancelAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
  launchDeadline: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
} as const;

const promptProvenanceSchema = {
  type: "object",
  properties: {
    roleId: { type: "string", enum: [...DISPATCHED_ROLE_IDS] },
    version: { type: "integer", minimum: 1 },
    surface: { type: "string", enum: [...PROMPT_SURFACES] },
    promptDigest: { type: "string", pattern: SHA256_PATTERN },
    catalogHash: { type: "string", pattern: SHA256_PATTERN },
    inputDigest: { type: "string", pattern: SHA256_PATTERN },
  },
  required: ["roleId", "version", "surface", "promptDigest", "catalogHash", "inputDigest"],
  additionalProperties: false,
} as const;

const resultCapabilitySchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["store-result"] },
    token: { type: "string", pattern: RESULT_CAPABILITY_PATTERN },
  },
  required: ["scope", "token"],
  additionalProperties: false,
} as const;

const inputCapabilitySchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["fetch-input"] },
    token: { type: "string", pattern: INPUT_CAPABILITY_PATTERN },
  },
  required: ["scope", "token"],
  additionalProperties: false,
} as const;

const gitChangeCapabilitySchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["git-change"] },
    token: { type: "string", pattern: GIT_CHANGE_CAPABILITY_PATTERN },
  },
  required: ["scope", "token"],
  additionalProperties: false,
} as const;

const gitConflictCapabilitySchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["git-conflict"] },
    token: { type: "string", pattern: GIT_CONFLICT_CAPABILITY_PATTERN },
  },
  required: ["scope", "token"],
  additionalProperties: false,
} as const;

const nativeCompletionSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["native-completion"] },
    actor: { type: "string", enum: ["trusted-parent", "trusted-extension"] },
    childId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    completedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
  },
  required: ["kind", "actor", "childId", "runId", "completedAt"],
  additionalProperties: false,
} as const;

function launchBranch(
  roleId: string,
  inputSchema: JSONSchema,
  registry: DispatchOverlayRegistry,
): JSONSchema {
  return {
    type: "object",
    properties: {
      roleId: { type: "string", enum: [roleId] },
      input: inputSchema,
      idempotencyKey: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "\\S",
      },
      timeoutMs: { type: "integer", minimum: 1 },
      overlays: dispatchOverlayListSchema(roleId, registry),
    },
    required: ["roleId", "input", "idempotencyKey", "timeoutMs"],
    additionalProperties: false,
  };
}

function callerInputSchema(roleId: string, inputSchema: JSONSchema): JSONSchema {
  if (roleId !== "implement-reviewer") return inputSchema;

  const properties = { ...(inputSchema.properties ?? {}) };
  for (const field of IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS) delete properties[field];
  const required = (inputSchema.required ?? []).filter(
    (field) => !IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS.includes(field as never),
  );
  return { ...inputSchema, properties, required };
}

/**
 * Role-aware launch schema over an explicit overlay registry (T684). Each
 * branch embeds the authoritative input sidecar, so a valid role id with
 * another role's input fails before launch, and derives its `overlays` list
 * from the registry, so an undeclared overlay id, another role's overlay, or
 * invalid overlay data also fails before launch.
 */
export function compactDispatchLaunchSchemaFor(registry: DispatchOverlayRegistry): JSONSchema {
  return {
    $schema: DRAFT_2020_12,
    $id: "cq:compact-dispatch/launch",
    title: "compact dispatched-subagent launch",
    oneOf: Object.entries(DISPATCHED_ROLE_SIDECARS).map(([roleId, sidecar]) =>
      launchBranch(roleId, callerInputSchema(roleId, sidecar.inputSchema), registry),
    ),
  };
}

/**
 * The launch schema over the production overlay registry, which ships empty
 * (T684 — no concrete runtime-overlay use case exists), so only an absent or
 * empty `overlays` list can pass.
 */
export const COMPACT_DISPATCH_LAUNCH_SCHEMA: JSONSchema =
  compactDispatchLaunchSchemaFor(DISPATCH_OVERLAY_REGISTRY);

/** Handle-only ordinary launch completion. */
export const DISPATCH_HANDLE_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/handle",
  title: "dispatch handle",
  type: "object",
  properties: handleProperties,
  required: ["attestationId", "generation"],
  additionalProperties: false,
};

/** Successful prepare response. */
export const DISPATCH_PREPARED_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/prepared",
  title: "prepared dispatch",
  type: "object",
  properties: {
    ...handleProperties,
    ...deadlineProperties,
    promptProvenance: promptProvenanceSchema,
    inputCapability: inputCapabilitySchema,
    resultCapability: resultCapabilitySchema,
    gitChangeCapability: gitChangeCapabilitySchema,
    gitConflictCapability: gitConflictCapabilitySchema,
  },
  required: [
    "attestationId",
    "generation",
    "responseStoreNow",
    "childCancelAt",
    "launchDeadline",
    "promptProvenance",
    "inputCapability",
    "resultCapability",
  ],
  additionalProperties: false,
};

/** Child-facing one-shot assembled-input retrieval. */
export const FETCH_DISPATCH_INPUT_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/fetch-input",
  title: "fetch dispatch input",
  type: "object",
  properties: {
    ...handleProperties,
    inputCapability: inputCapabilitySchema,
  },
  required: ["attestationId", "generation", "inputCapability"],
  additionalProperties: false,
};

/** Successful assembled-input materialization. A second retrieval is an error. */
export const MATERIALIZED_DISPATCH_INPUT_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/materialized-input",
  title: "materialized dispatch input",
  type: "object",
  properties: {
    state: { type: "string", enum: ["input-materialized"] },
    ...handleProperties,
    input: {},
    promptProvenance: promptProvenanceSchema,
    materializedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
  },
  required: ["state", "attestationId", "generation", "input", "promptProvenance", "materializedAt"],
  additionalProperties: false,
};

/** Child-facing, capability-bound store_result input. */
export const STORE_DISPATCH_RESULT_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/store-result",
  title: "store dispatch result",
  type: "object",
  properties: {
    resultCapability: resultCapabilitySchema,
    output: {},
  },
  required: ["resultCapability", "output"],
  additionalProperties: false,
};

/** Trusted native-completion confirmation input. */
export const CONFIRM_DISPATCH_COMPLETION_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/confirm-completion",
  title: "confirm dispatch completion",
  type: "object",
  properties: {
    ...handleProperties,
    nativeCompletion: nativeCompletionSchema,
  },
  required: ["attestationId", "generation", "nativeCompletion"],
  additionalProperties: false,
};

/** Trusted terminal abort input. */
export const ABORT_DISPATCH_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/abort",
  title: "abort dispatch",
  type: "object",
  properties: {
    ...handleProperties,
    reason: { type: "string", enum: [...DISPATCH_ABORT_REASONS] },
    details: {},
  },
  required: ["attestationId", "generation", "reason"],
  additionalProperties: false,
};

function fetchVariant(
  state: FetchDispatchResultState,
  properties: Readonly<Record<string, JSONSchema>>,
  required: readonly string[],
): JSONSchema {
  return {
    type: "object",
    properties: {
      state: { type: "string", enum: [state] },
      ...handleProperties,
      ...properties,
    },
    required: ["state", "attestationId", "generation", ...required],
    additionalProperties: false,
  };
}

/**
 * Typed fetch result. Error classes remain outside this closed lifecycle union;
 * no missing lookup can be interpreted as a native child failure.
 */
export const FETCH_DISPATCH_RESULT_SCHEMA: JSONSchema = {
  $schema: DRAFT_2020_12,
  $id: "cq:compact-dispatch/fetch-result",
  title: "fetch dispatch result",
  oneOf: [
    fetchVariant(
      "prepared",
      {
        ...deadlineProperties,
        promptProvenance: promptProvenanceSchema,
      },
      ["responseStoreNow", "childCancelAt", "launchDeadline", "promptProvenance"],
    ),
    fetchVariant(
      "result-stored",
      {
        storedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
        promptProvenance: promptProvenanceSchema,
      },
      ["storedAt", "promptProvenance"],
    ),
    fetchVariant(
      "consumed",
      {
        consumedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
        output: {},
        promptProvenance: promptProvenanceSchema,
        nativeCompletion: nativeCompletionSchema,
      },
      ["consumedAt", "output", "promptProvenance", "nativeCompletion"],
    ),
    fetchVariant(
      "aborted",
      {
        abortedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
        reason: { type: "string", enum: [...DISPATCH_ABORT_REASONS] },
        details: {},
      },
      ["abortedAt", "reason"],
    ),
    fetchVariant(
      "terminal-envelope-expired",
      {
        terminalKind: { type: "string", enum: ["consumed", "aborted"] },
        reuseAfter: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
      },
      ["terminalKind", "reuseAfter"],
    ),
    fetchVariant("attestation-not-found", {}, []),
    fetchVariant(
      "output-already-materialized",
      {
        materializedAt: { type: "string", pattern: DISPATCH_UTC_TIMESTAMP_PATTERN },
      },
      ["materializedAt"],
    ),
  ],
};
