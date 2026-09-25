import { assertCohortEffectEnvelopeV1, cohortEffectTargetRefV1, type CohortEffectEnvelopeV1, type WorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  AttestationBindingError,
  AttestationContractError,
  abortDispatch,
  attestationInstantMs,
  confirmDispatchCompletion,
  fetchDispatchInput,
  fetchDispatchResult,
  isAttestationTombstone,
  provenanceBindingOf,
  storeDispatchResult,
  type AttestationEnvelope,
  type ConfirmDispatchCompletionOutcome,
  type DispatchServiceDeps,
  type StoreDispatchResultOutcome,
} from "./dispatchAttestation.js";
import type { AttestationNamespace } from "./dispatchAttestation.js";
import { DISPATCH_ABORT_REASONS } from "./compactDispatchProtocol.js";
import type {
  AbortedDispatchResult,
  DispatchAbortReason,
  DispatchHandle,
  DispatchJSONValue,
  DispatchPrepared,
  FetchDispatchResult,
  MaterializedDispatchInput,
  NativeCompletionProof,
} from "./compactDispatchProtocol.js";
import {
  buildClaudeCompactNativeLaunch,
  launchClaudePrintAsync,
  type ClaudePrintLaunchOptions,
} from "./claudeDispatchBridge.js";
import {
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
  claudeLaunchGate,
  decideClaudeCompletion,
  type ClaudeChildCorrelation,
} from "./claudeDispatchProtocol.js";
import { isEffort, type ActiveHarness, type Harness, type ReviewerToken } from "./types.js";
import {
  NativeAdapterIncompatibilityError,
  isAuthenticatedCodexNativeQualification,
  isNativeAdapterId,
  type NativeAdapterQualification,
} from "./nativeDispatchQualification.js";
import type { QualifyDispatchStagedCompletionOutcome } from "./dispatchImplementationQueue.js";

export const DISPATCH_TRANSPORTS = ["native", "process"] as const;

export type DispatchTransport = (typeof DISPATCH_TRANSPORTS)[number];

export interface DispatchTransportRouteRequest {
  readonly activeHarness: ActiveHarness;
  readonly targetHarness: Harness;
  readonly forceShellout: boolean;
}

export interface DispatchTransportRoute extends DispatchTransportRouteRequest {
  readonly transport: DispatchTransport;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
}

export function routeDispatchTransport(
  request: DispatchTransportRouteRequest,
): DispatchTransportRoute {
  const transport =
    request.activeHarness === request.targetHarness && !request.forceShellout
      ? "native"
      : "process";
  return Object.freeze({
    activeHarness: request.activeHarness,
    targetHarness: request.targetHarness,
    forceShellout: request.forceShellout,
    transport,
    adapterId: `${request.targetHarness}:${transport}`,
  });
}

export class DispatchTransportRoutingError extends AttestationContractError {
  constructor(message: string) {
    super("dispatch.transport", message);
    this.name = "DispatchTransportRoutingError";
  }
}

export interface DispatchAdapterChildPort {
  materializeInput(): Promise<MaterializedDispatchInput>;
  storeResult(output: DispatchJSONValue): Promise<StoreDispatchResultOutcome>;
}

/**
 * G224 / K331: every state transition `runPreparedDispatch` performs. A server
 * backs it with its own dispatch capability so worktree effect locks, inherited
 * Git receipts, parent-gate cancellation and recovery apply exactly as they do
 * for a parent-driven dispatch; {@link attestationServiceSettlement} is the
 * in-process form over the bare attestation service.
 */
export interface DispatchSettlementPort {
  readEnvelope(handle: DispatchHandle): Promise<AttestationEnvelope | undefined>;
  materializeInput(
    handle: DispatchHandle,
    inputCapability: DispatchPrepared["inputCapability"],
  ): Promise<MaterializedDispatchInput>;
  storeResult(
    resultCapability: DispatchPrepared["resultCapability"],
    output: DispatchJSONValue,
  ): Promise<StoreDispatchResultOutcome>;
  confirm(input: {
    readonly handle: DispatchHandle;
    readonly nativeCompletion: NativeCompletionProof;
    readonly expectedProvenance: ReturnType<typeof provenanceBindingOf>;
  }): Promise<ConfirmDispatchCompletionOutcome>;
  abort(input: {
    readonly handle: DispatchHandle;
    readonly reason: DispatchAbortReason;
    readonly details?: DispatchJSONValue;
  }): Promise<AbortedDispatchResult>;
  fetch(handle: DispatchHandle): Promise<FetchDispatchResult>;
}

export function attestationServiceSettlement(
  namespace: AttestationNamespace,
  deps: DispatchServiceDeps,
): DispatchSettlementPort {
  return Object.freeze({
    readEnvelope: async (handle: DispatchHandle) => {
      const row = deps.store.read(handle);
      return row === undefined || isAttestationTombstone(row) ? undefined : row;
    },
    materializeInput: async (
      handle: DispatchHandle,
      inputCapability: DispatchPrepared["inputCapability"],
    ) => fetchDispatchInput({ namespace, ...handle, inputCapability }, deps),
    storeResult: async (
      resultCapability: DispatchPrepared["resultCapability"],
      output: DispatchJSONValue,
    ) => storeDispatchResult({ resultCapability, output }, deps),
    confirm: async (input: Parameters<DispatchSettlementPort["confirm"]>[0]) =>
      confirmDispatchCompletion(
        {
          namespace,
          ...input.handle,
          nativeCompletion: input.nativeCompletion,
          expectedProvenance: input.expectedProvenance,
        },
        deps,
      ),
    abort: async (input: Parameters<DispatchSettlementPort["abort"]>[0]) =>
      abortDispatch(
        {
          namespace,
          actor: "trusted-parent",
          ...input.handle,
          reason: input.reason,
          ...(input.details === undefined ? {} : { details: input.details }),
        },
        deps,
      ),
    fetch: async (handle: DispatchHandle) =>
      fetchDispatchResult({ namespace, actor: "trusted-parent", ...handle }, deps),
  });
}

export interface DispatchAdapterLaunchContext {
  readonly route: DispatchTransportRoute;
  readonly prepared: DispatchPrepared;
  /** Exact per-role token resolved by cq.toml before transport selection. */
  readonly resolvedModel: ReviewerToken;
  /** Trusted effect subject derived from the persisted prepared input. */
  readonly effectTargetRef: string;
  readonly child: DispatchAdapterChildPort;
}

export interface DispatchAdapterCompletion {
  readonly outcome: "completed";
  readonly handle: DispatchHandle;
  readonly nativeCompletion: NativeCompletionProof;
  readonly handleOnlyEnforcement: "structural" | "prompt-best-effort";
}

export interface DispatchAdapterAbortion {
  readonly outcome: "aborted";
  readonly reason: DispatchAbortReason;
  readonly details?: DispatchJSONValue;
  readonly storeResultAbortReason?: DispatchAbortReason;
}

export type DispatchAdapterLaunchResult = DispatchAdapterCompletion | DispatchAdapterAbortion;

export type DispatchAdapterLauncher = (
  context: DispatchAdapterLaunchContext,
) => DispatchAdapterLaunchResult | Promise<DispatchAdapterLaunchResult>;

export interface DispatchTransportAdapter {
  readonly id: `${Harness}:${DispatchTransport}`;
  readonly targetHarness: Harness;
  readonly transport: DispatchTransport;
  readonly launch: DispatchAdapterLauncher;
}

function createAdapter(
  targetHarness: Harness,
  transport: DispatchTransport,
  launch: DispatchAdapterLauncher,
): DispatchTransportAdapter {
  return Object.freeze({
    id: `${targetHarness}:${transport}`,
    targetHarness,
    transport,
    launch,
  });
}

export function createNativeDispatchAdapter(
  targetHarness: Harness,
  launch: DispatchAdapterLauncher,
): DispatchTransportAdapter {
  return createAdapter(targetHarness, "native", launch);
}

export interface ClaudeProcessAdapterBinding {
  readonly correlation: ClaudeChildCorrelation;
  readonly model: string;
  readonly now: () => string;
  readonly launchOptions: Omit<ClaudePrintLaunchOptions, "worksetEffect">;
}

export type ClaudeProcessAdapterBindingResolver = (
  context: DispatchAdapterLaunchContext,
) => ClaudeProcessAdapterBinding | Promise<ClaudeProcessAdapterBinding>;

export function createClaudeProcessDispatchAdapter(
  effectAdmissionProvider: WorksetEffectAdmissionProvider,
  resolve: ClaudeProcessAdapterBindingResolver,
  /** D559: settles the launched child's process group when the dispatch is aborted. */
  cancellation?: AbortSignal,
): DispatchTransportAdapter {
  return createAdapter("claude", "process", async (context) => {
    const binding = await resolve(context);
    if (binding.model !== context.resolvedModel.model) {
      throw new DispatchTransportRoutingError(
        `Claude process model ${JSON.stringify(binding.model)} does not match resolved model ${JSON.stringify(context.resolvedModel.model)}`,
      );
    }
    const gate = claudeLaunchGate(context.prepared, binding.now());
    if (!gate.launch) {
      return {
        outcome: "aborted",
        reason: gate.abortReason,
        details: { refusal: gate.refusal, detail: gate.detail },
      };
    }
    const handle = handleOf(context.prepared);
    const report = await launchClaudePrintAsync(
      {
        envelope: buildClaudeCompactNativeLaunch({
          roleId: context.prepared.promptProvenance.roleId,
          model: binding.model,
          handle,
          inputCapability: context.prepared.inputCapability,
        }),
        preparedProvenance: provenanceBindingOf(context.prepared),
        expectedCorrelation: binding.correlation,
        resultCapability: context.prepared.resultCapability,
        ...(context.prepared.gitConflictCapability === undefined
          ? {}
          : { gitConflictCapability: context.prepared.gitConflictCapability }),
        // D561: the production Claude launch path builds its own context, so the
        // worker's Git change capability must be threaded here too — the bridge's
        // other entry point carrying it is not the one this adapter uses.
        // D561: the production Claude launch path builds its own context, so the
        // worker's Git change capability must be threaded here too — the bridge's
        // other entry point carrying it is not the one this adapter uses.
        ...(context.prepared.gitChangeCapability === undefined
          ? {}
          : { gitChangeCapability: context.prepared.gitChangeCapability }),
        childWindowMs: gate.childWindowMs,
      },
      {
        ...binding.launchOptions,
        worksetEffect: {
          provider: effectAdmissionProvider,
          targetRef: context.effectTargetRef,
          ...(cancellation === undefined ? {} : { signal: cancellation }),
        },
      },
    );
    if (report.submission?.state === "aborted") {
      return {
        outcome: "aborted",
        reason: report.submission.result.reason,
        ...(report.submission.result.details === undefined
          ? {}
          : { details: report.submission.result.details }),
      };
    }
    const decision = decideClaudeCompletion({
      handle,
      expectedChild: binding.correlation,
      observation: {
        source: "transport",
        mode: CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
        roleId: report.correlation.roleId,
        launchNonce: report.correlation.launchNonce,
        sessionId: report.correlation.sessionId,
        cancelled: report.cancelled,
        terminal: report.terminal,
        finalMessage: report.finalMessage,
        observedAt: report.observedAt,
      },
    });
    if (decision.action === "abort") {
      return { outcome: "aborted", reason: decision.reason, details: decision.details };
    }
    return {
      outcome: "completed",
      handle,
      nativeCompletion: decision.nativeCompletion,
      handleOnlyEnforcement: decision.handleOnlyEnforcement,
    };
  });
}

/** Lifecycle-conformant target-Pi process seam; T1632 supplies its launcher. */
export function createPiProcessDispatchAdapter(
  launch: DispatchAdapterLauncher,
): DispatchTransportAdapter {
  return createAdapter("pi", "process", launch);
}

export class DispatchTransportAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, DispatchTransportAdapter>;
  private readonly nativeIncompatibilities: ReadonlyMap<string, NativeAdapterQualification>;

  constructor(
    adapters: readonly DispatchTransportAdapter[],
    nativeIncompatibilities: readonly NativeAdapterQualification[] = [],
  ) {
    const indexed = new Map<string, DispatchTransportAdapter>();
    for (const adapter of adapters) {
      if (adapter.id !== `${adapter.targetHarness}:${adapter.transport}`) {
        throw new DispatchTransportRoutingError(
          `adapter ${JSON.stringify(adapter.id)} does not match its target and transport`,
        );
      }
      if (indexed.has(adapter.id)) {
        throw new DispatchTransportRoutingError(
          `adapter ${JSON.stringify(adapter.id)} is registered more than once`,
        );
      }
      indexed.set(adapter.id, adapter);
    }
    const incompat = new Map<string, NativeAdapterQualification>();
    for (const qualification of nativeIncompatibilities) {
      if (qualification.status === "incompatible") {
        incompat.set(qualification.adapterId, qualification);
      }
    }
    this.adapters = indexed;
    this.nativeIncompatibilities = incompat;
  }

  resolve(route: DispatchTransportRoute): DispatchTransportAdapter {
    const adapter = this.adapters.get(route.adapterId);
    if (adapter === undefined) {
      const incompatibility = this.nativeIncompatibilities.get(route.adapterId);
      if (incompatibility !== undefined && incompatibility.status === "incompatible") {
        throw new NativeAdapterIncompatibilityError(incompatibility);
      }
      throw new DispatchTransportRoutingError(
        `required ${route.transport} adapter for target ${JSON.stringify(route.targetHarness)} is unavailable`,
      );
    }
    return adapter;
  }

  /** Test seam: whether a native adapter id is currently registered. */
  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }
}

/**
 * Positive-only registry builder (T1698/D263, T1699/D160).
 *
 * Native adapters are kept ONLY when a matching qualification has
 * `status: "qualified"`. Unqualified native adapters are dropped and recorded
 * as typed incompatibilities so resolve fails closed with
 * {@link NativeAdapterIncompatibilityError} rather than a generic missing-adapter
 * error. Process adapters always pass through.
 */
export function buildPositiveOnlyDispatchRegistry(input: {
  readonly adapters: readonly DispatchTransportAdapter[];
  readonly nativeQualifications: readonly NativeAdapterQualification[];
}): DispatchTransportAdapterRegistry {
  const qualifiedNativeIds = new Set(
    input.nativeQualifications
      .filter(
        (entry) =>
          entry.status === "qualified" &&
          (entry.adapterId !== "codex:native" || isAuthenticatedCodexNativeQualification(entry)),
      )
      .map((entry) => entry.adapterId),
  );
  const incompatibilities: NativeAdapterQualification[] = input.nativeQualifications.filter(
    (entry) => entry.status === "incompatible",
  );
  const kept: DispatchTransportAdapter[] = [];
  for (const adapter of input.adapters) {
    if (adapter.transport !== "native") {
      kept.push(adapter);
      continue;
    }
    if (!isNativeAdapterId(adapter.id)) {
      throw new DispatchTransportRoutingError(
        `native adapter id ${JSON.stringify(adapter.id)} is not a known native adapter id`,
      );
    }
    if (!qualifiedNativeIds.has(adapter.id)) {
      // Drop — do not register. If no explicit incompatibility was supplied,
      // synthesize one so resolve still fails with a typed error.
      if (!incompatibilities.some((entry) => entry.adapterId === adapter.id)) {
        incompatibilities.push({
          status: "incompatible",
          adapterId: adapter.id,
          targetHarness: adapter.targetHarness,
          transport: "native",
          reason: "path-scoped-confinement-unproven",
          confinement: "unproven",
          defect:
            adapter.targetHarness === "pi"
              ? "D160"
              : adapter.targetHarness === "codex"
                ? "D307"
                : "D263",
          detail:
            `native adapter ${JSON.stringify(adapter.id)} was not positively qualified ` +
            "(structural provider gates or K238 harness-owned worktree_manage handoff) and was left unregistered",
        });
      }
      continue;
    }
    kept.push(adapter);
  }
  return new DispatchTransportAdapterRegistry(kept, incompatibilities);
}

export class DispatchTransportAbort extends Error {
  constructor(
    readonly reason: DispatchAbortReason,
    readonly details?: DispatchJSONValue,
  ) {
    super(`Dispatch transport requested ${reason}`);
    this.name = "DispatchTransportAbort";
  }
}

export interface RunPreparedDispatchRequest extends DispatchTransportRouteRequest {
  readonly prepared: DispatchPrepared;
  /**
   * Whether this run performs the dispatch's single output materialization.
   * A server driving a dispatch for a parent passes false: the parent's own
   * `fetch_dispatch_result` stays the sole body-returning surface (T682).
   */
  readonly materializeOutput: boolean;
  /** Exact per-role token resolved by cq.toml before transport selection. */
  readonly resolvedModel: ReviewerToken;
  /** Trusted queue composition invoked only after a parent-gated result is durably staged. */
  readonly qualifyStagedCompletion?: RoutedStagedCompletionQualifier;
}

export interface RoutedStagedCompletionObservation {
  readonly handle: DispatchHandle;
  readonly stagedOutputDigest: string;
  readonly expectedChild: {
    readonly childId: string;
    readonly runId: string;
  };
  readonly expectedProvenance: ReturnType<typeof provenanceBindingOf>;
  readonly nativeCompletion: NativeCompletionProof;
}

/**
 * A qualifier either aborts the staged dispatch or leaves it queued for its
 * parent gate. `queued` is what a server reports when its capability owns the
 * qualification and parent-gate coordination (G224).
 */
export type RoutedStagedCompletionOutcome =
  | QualifyDispatchStagedCompletionOutcome
  | { readonly state: "queued" }
  | { readonly state: "aborted"; readonly result: AbortedDispatchResult };

export type RoutedStagedCompletionQualifier = (
  observation: RoutedStagedCompletionObservation,
) => RoutedStagedCompletionOutcome | Promise<RoutedStagedCompletionOutcome>;

function assertResolvedModelBinding(token: ReviewerToken, targetHarness: Harness): void {
  if (token.harness !== targetHarness) {
    throw new DispatchTransportRoutingError(
      `resolved model harness ${JSON.stringify(token.harness)} does not match target ${JSON.stringify(targetHarness)}`,
    );
  }
  if (typeof token.model !== "string" || token.model.trim() === "") {
    throw new DispatchTransportRoutingError("resolved model must name a non-empty model");
  }
  if (targetHarness === "pi") {
    if (typeof token.provider !== "string" || token.provider.trim() === "") {
      throw new DispatchTransportRoutingError("resolved Pi model must name a non-empty provider");
    }
  } else if (token.provider !== null) {
    throw new DispatchTransportRoutingError(
      `resolved ${targetHarness} model must not carry a provider`,
    );
  }
  if (
    token.effort !== undefined &&
    token.effort !== null &&
    !isEffort(targetHarness, token.effort)
  ) {
    throw new DispatchTransportRoutingError(
      `resolved effort ${JSON.stringify(token.effort)} is not valid for target ${JSON.stringify(targetHarness)}`,
    );
  }
}

const DISPATCH_EFFECT_TARGET_FIELDS = [
  { field: "taskId", ledger: "tasks", pattern: /^T[0-9]+$/ },
  { field: "goalId", ledger: "goals", pattern: /^G[0-9]+$/ },
  { field: "defectId", ledger: "defects", pattern: /^D[0-9]+$/ },
  { field: "researchId", ledger: "researches", pattern: /^RS[0-9]+$/ },
] as const;

/** Resolve one dispatch's process-effect target from its validated prepared input. */
export function dispatchEffectTargetRef(input: DispatchJSONValue): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DispatchTransportRoutingError(
      "prepared dispatch input must be an object carrying one effect target id",
    );
  }
  const record = input as Readonly<Record<string, DispatchJSONValue>>;
  const present = DISPATCH_EFFECT_TARGET_FIELDS.filter(({ field }) =>
    Object.hasOwn(record, field),
  );
  if (Object.hasOwn(record, "cohort")) {
    if (present.length !== 0) throw new DispatchTransportRoutingError("cohort dispatch cannot substitute an anchor effect target");
    const cohort = record["cohort"] as unknown as CohortEffectEnvelopeV1;
    assertCohortEffectEnvelopeV1(cohort);
    return cohortEffectTargetRefV1(cohort);
  }
  if (present.length !== 1) {
    throw new DispatchTransportRoutingError(
      `prepared dispatch input must carry exactly one effect target id, found ${present.length}`,
    );
  }
  const target = present[0];
  if (target === undefined) {
    throw new DispatchTransportRoutingError("prepared dispatch effect target disappeared");
  }
  const id = record[target.field];
  if (typeof id !== "string" || !target.pattern.test(id)) {
    throw new DispatchTransportRoutingError(
      `prepared dispatch input ${target.field} is not a canonical ${target.ledger} id`,
    );
  }
  return `${target.ledger}:${id}`;
}

export interface RoutedDispatchConsumed {
  readonly outcome: "consumed";
  readonly route: DispatchTransportRoute;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
  readonly handle: DispatchHandle;
  /** The sole body-bearing value; present exactly when the run materialized the output. */
  readonly output?: DispatchJSONValue;
}

export interface RoutedDispatchAborted {
  readonly outcome: "aborted";
  readonly route: DispatchTransportRoute;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
  readonly handle: DispatchHandle;
  readonly abort: AbortedDispatchResult;
}

export interface RoutedDispatchQueued {
  readonly outcome: "queued";
  readonly route: DispatchTransportRoute;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
  readonly handle: DispatchHandle;
}

export type RoutedDispatchResult =
  | RoutedDispatchConsumed
  | RoutedDispatchAborted
  | RoutedDispatchQueued;

const ABORT_REASON_SET: ReadonlySet<string> = new Set(DISPATCH_ABORT_REASONS);
const DISPATCH_HANDLE_KEYS = ["attestationId", "generation"] as const;
const DISPATCH_HANDLE_KEY_SET: ReadonlySet<string> = new Set(DISPATCH_HANDLE_KEYS);
const NATIVE_COMPLETION_KEYS = ["actor", "childId", "completedAt", "kind", "runId"] as const;
const NATIVE_COMPLETION_KEY_SET: ReadonlySet<string> = new Set(NATIVE_COMPLETION_KEYS);
const NATIVE_COMPLETION_ACTOR_SET: ReadonlySet<string> = new Set([
  "trusted-parent",
  "trusted-extension",
]);

function handleOf(prepared: DispatchPrepared): DispatchHandle {
  return Object.freeze({
    attestationId: prepared.attestationId,
    generation: prepared.generation,
  });
}

async function adapterAbort(
  route: DispatchTransportRoute,
  adapter: DispatchTransportAdapter,
  handle: DispatchHandle,
  reason: DispatchAbortReason,
  details: DispatchJSONValue | undefined,
  settlement: DispatchSettlementPort,
): Promise<RoutedDispatchAborted> {
  const abort = await settlement.abort({
    handle,
    reason,
    ...(details === undefined ? {} : { details }),
  });
  return Object.freeze({
    outcome: "aborted" as const,
    route,
    adapterId: adapter.id,
    handle,
    abort,
  });
}

/**
 * D546: a child whose own dispatch-scoped store recorded a typed abort has
 * already settled the envelope; that abort is authoritative, so the router
 * returns it rather than aborting again or confirming a completion.
 */
async function childSettledAbort(
  route: DispatchTransportRoute,
  adapter: DispatchTransportAdapter,
  handle: DispatchHandle,
  settlement: DispatchSettlementPort,
): Promise<RoutedDispatchAborted | undefined> {
  const row = await settlement.readEnvelope(handle);
  if (row?.state !== "aborted") return undefined;
  const abort = await settlement.fetch(handle);
  if (abort.state !== "aborted") return undefined;
  return Object.freeze({
    outcome: "aborted" as const,
    route,
    adapterId: adapter.id,
    handle,
    abort,
  });
}

async function reconcileStoreResultAbort(
  route: DispatchTransportRoute,
  adapter: DispatchTransportAdapter,
  handle: DispatchHandle,
  reason: DispatchAbortReason,
  settlement: DispatchSettlementPort,
): Promise<RoutedDispatchAborted> {
  const abort = await settlement.fetch(handle);
  if (abort.state !== "aborted" || abort.reason !== reason) {
    throw new AttestationContractError(
      "adapter.storeResultAbortReason",
      `adapter ${JSON.stringify(adapter.id)} reported authoritative abort ${JSON.stringify(reason)} ` +
        `but the dispatch fetched as ${JSON.stringify(abort.state)}` +
        (abort.state === "aborted" ? ` with reason ${JSON.stringify(abort.reason)}` : ""),
    );
  }
  return Object.freeze({
    outcome: "aborted" as const,
    route,
    adapterId: adapter.id,
    handle,
    abort,
  });
}

function assertCompletionShape(
  completion: DispatchAdapterCompletion,
  route: DispatchTransportRoute,
  handle: DispatchHandle,
): void {
  const forbidden = Object.keys(completion).filter(
    (key) => !["outcome", "handle", "nativeCompletion", "handleOnlyEnforcement"].includes(key),
  );
  if (forbidden.length > 0) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "adapter-returned-surplus-fields",
      fields: forbidden.sort(),
    });
  }
  if (
    completion.handle.attestationId !== handle.attestationId ||
    completion.handle.generation !== handle.generation
  ) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "wrong-handle",
      expected: {
        attestationId: handle.attestationId,
        generation: handle.generation,
      },
      observed: {
        attestationId: completion.handle.attestationId,
        generation: completion.handle.generation,
      },
    });
  }
  if (route.transport === "process" && completion.handleOnlyEnforcement !== "structural") {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "process-adapter-not-structurally-handle-only",
    });
  }
  const requiredActor =
    route.transport === "process" || route.targetHarness === "pi"
      ? "trusted-extension"
      : "trusted-parent";
  if (completion.nativeCompletion.actor !== requiredActor) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "completion-actor-does-not-match-transport",
      expected: requiredActor,
      observed: completion.nativeCompletion.actor,
    });
  }
}

function assertNativeCompletionProof(value: unknown): asserts value is NativeCompletionProof {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-native-completion-proof",
      observedType: value === null ? "null" : typeof value,
    });
  }
  const proof = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(proof).sort();
  const missing = NATIVE_COMPLETION_KEYS.filter((field) => !Object.hasOwn(proof, field));
  const surplus = fields.filter((field) => !NATIVE_COMPLETION_KEY_SET.has(field));
  const invalid = NATIVE_COMPLETION_KEYS.filter((field) => {
    const fieldValue = proof[field];
    if (field === "kind") return fieldValue !== "native-completion";
    if (field === "actor") {
      return typeof fieldValue !== "string" || !NATIVE_COMPLETION_ACTOR_SET.has(fieldValue);
    }
    return typeof fieldValue !== "string" || fieldValue.trim() === "";
  });
  if (missing.length > 0 || surplus.length > 0 || invalid.length > 0) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-native-completion-proof",
      fields,
      missing,
      surplus,
      invalid,
    });
  }
  try {
    attestationInstantMs(proof["completedAt"] as string, "adapter.nativeCompletion.completedAt");
  } catch (error) {
    if (!(error instanceof AttestationContractError)) throw error;
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-native-completion-proof",
      fields,
      invalid: ["completedAt"],
    });
  }
}

function assertAdapterLaunchResult(value: unknown): asserts value is DispatchAdapterLaunchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-adapter-result",
      observedType: value === null ? "null" : typeof value,
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["outcome"] === "aborted") {
    const surplus = Object.keys(record).filter(
      (key) => !["outcome", "reason", "details", "storeResultAbortReason"].includes(key),
    );
    const storeResultAbortReason = record["storeResultAbortReason"];
    if (
      typeof record["reason"] !== "string" ||
      !ABORT_REASON_SET.has(record["reason"]) ||
      (storeResultAbortReason !== undefined &&
        (typeof storeResultAbortReason !== "string" ||
          !ABORT_REASON_SET.has(storeResultAbortReason) ||
          storeResultAbortReason !== record["reason"] ||
          record["details"] !== undefined)) ||
      surplus.length > 0
    ) {
      throw new DispatchTransportAbort("protocol-violation", {
        violation: "malformed-adapter-abort",
        fields: Object.keys(record).sort(),
      });
    }
    return;
  }
  if (record["outcome"] !== "completed") {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "unknown-adapter-outcome",
      observed: String(record["outcome"]),
    });
  }
  const handle = record["handle"];
  if (
    handle === null ||
    typeof handle !== "object" ||
    Array.isArray(handle) ||
    (record["handleOnlyEnforcement"] !== "structural" &&
      record["handleOnlyEnforcement"] !== "prompt-best-effort")
  ) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-adapter-completion",
      fields: Object.keys(record).sort(),
    });
  }
  const handleRecord = handle as Readonly<Record<string, unknown>>;
  const handleFields = Object.keys(handleRecord).sort();
  const missingHandleFields = DISPATCH_HANDLE_KEYS.filter(
    (field) => !Object.hasOwn(handleRecord, field),
  );
  const surplusHandleFields = handleFields.filter((field) => !DISPATCH_HANDLE_KEY_SET.has(field));
  if (missingHandleFields.length > 0 || surplusHandleFields.length > 0) {
    throw new DispatchTransportAbort("protocol-violation", {
      violation: "malformed-adapter-completion-handle",
      fields: handleFields,
      missing: missingHandleFields,
      surplus: surplusHandleFields,
    });
  }
  assertNativeCompletionProof(record["nativeCompletion"]);
}

/**
 * Run one already-prepared dispatch through the selected transport. The child
 * port delegates every state transition to the shared attestation service;
 * the adapter owns transport only and cannot introduce another result store.
 */
export async function runPreparedDispatch(
  request: RunPreparedDispatchRequest,
  registry: DispatchTransportAdapterRegistry,
  settlement: DispatchSettlementPort,
): Promise<RoutedDispatchResult> {
  const route = routeDispatchTransport(request);
  assertResolvedModelBinding(request.resolvedModel, request.targetHarness);
  if (request.prepared.promptProvenance.surface !== request.targetHarness) {
    throw new DispatchTransportRoutingError(
      `prepared surface ${JSON.stringify(request.prepared.promptProvenance.surface)} does not ` +
        `match target ${JSON.stringify(request.targetHarness)}`,
    );
  }
  const adapter = registry.resolve(route);
  const handle = handleOf(request.prepared);
  const row = await settlement.readEnvelope(handle);
  if (row === undefined) {
    throw new DispatchTransportRoutingError(
      `prepared dispatch ${handle.attestationId}/${handle.generation} has no live envelope`,
    );
  }
  const effectTargetRef = dispatchEffectTargetRef(row.input);
  const child: DispatchAdapterChildPort = Object.freeze({
    materializeInput: () =>
      settlement.materializeInput(handle, request.prepared.inputCapability),
    storeResult: (output: DispatchJSONValue) =>
      settlement.storeResult(request.prepared.resultCapability, output),
  });

  let result: DispatchAdapterLaunchResult;
  try {
    result = await adapter.launch(
      Object.freeze({
        route,
        prepared: request.prepared,
        resolvedModel: Object.freeze({ ...request.resolvedModel }),
        effectTargetRef,
        child,
      }),
    );
    assertAdapterLaunchResult(result);
    if (result.outcome === "aborted") {
      if (result.storeResultAbortReason !== undefined) {
        return await reconcileStoreResultAbort(
          route,
          adapter,
          handle,
          result.storeResultAbortReason,
          settlement,
        );
      }
      return (
        (await childSettledAbort(route, adapter, handle, settlement)) ??
        (await adapterAbort(route, adapter, handle, result.reason, result.details, settlement))
      );
    }
    assertCompletionShape(result, route, handle);
  } catch (error) {
    if (error instanceof DispatchTransportAbort) {
      return await adapterAbort(route, adapter, handle, error.reason, error.details, settlement);
    }
    throw error;
  }

  const staged = await settlement.readEnvelope(handle);
  if (staged === undefined) {
    throw new DispatchTransportRoutingError(
      `completed dispatch ${handle.attestationId}/${handle.generation} has no live envelope`,
    );
  }
  if (staged.state === "aborted") {
    const settled = await childSettledAbort(route, adapter, handle, settlement);
    if (settled === undefined) {
      throw new DispatchTransportRoutingError(
        `completed dispatch ${handle.attestationId}/${handle.generation} read aborted but fetched otherwise`,
      );
    }
    return settled;
  }
  if (staged.state === "gate-pending") {
    if (
      staged.gateSubmittedOutputDigest === undefined ||
      request.qualifyStagedCompletion === undefined
    ) {
      throw new AttestationContractError(
        "dispatch.qualification",
        "a parent-gated completion requires a trusted staged-completion qualifier",
      );
    }
    const qualification = await request.qualifyStagedCompletion(
      Object.freeze({
        handle,
        stagedOutputDigest: staged.gateSubmittedOutputDigest,
        expectedChild: Object.freeze({ ...staged.expectedChild }),
        expectedProvenance: provenanceBindingOf(request.prepared),
        nativeCompletion: result.nativeCompletion,
      }),
    );
    if (qualification.state === "aborted") {
      return Object.freeze({
        outcome: "aborted" as const,
        route,
        adapterId: adapter.id,
        handle,
        abort: qualification.result,
      });
    }
    return Object.freeze({
      outcome: "queued" as const,
      route,
      adapterId: adapter.id,
      handle,
    });
  }

  let confirmation;
  try {
    confirmation = await settlement.confirm({
      handle,
      nativeCompletion: result.nativeCompletion,
      expectedProvenance: provenanceBindingOf(request.prepared),
    });
  } catch (error) {
    if (error instanceof AttestationBindingError) {
      return await adapterAbort(
        route,
        adapter,
        handle,
        "native-failure",
        { violation: "completion-correlation-mismatch", detail: error.message },
        settlement,
      );
    }
    throw error;
  }
  if (confirmation.state === "aborted") {
    return Object.freeze({
      outcome: "aborted" as const,
      route,
      adapterId: adapter.id,
      handle,
      abort: confirmation.result,
    });
  }

  if (!request.materializeOutput) {
    return Object.freeze({
      outcome: "consumed" as const,
      route,
      adapterId: adapter.id,
      handle,
    });
  }
  const fetched = await settlement.fetch(handle);
  if (fetched.state !== "consumed") {
    throw new AttestationContractError(
      "fetch.state",
      `confirmed dispatch ${JSON.stringify(adapter.id)} fetched as ${JSON.stringify(fetched.state)}`,
    );
  }
  return Object.freeze({
    outcome: "consumed" as const,
    route,
    adapterId: adapter.id,
    handle,
    output: fetched.output,
  });
}
