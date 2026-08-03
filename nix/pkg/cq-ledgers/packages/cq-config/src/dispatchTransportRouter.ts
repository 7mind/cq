import {
  AttestationBindingError,
  AttestationContractError,
  abortDispatch,
  attestationInstantMs,
  confirmDispatchCompletion,
  fetchDispatchInput,
  fetchDispatchResult,
  provenanceBindingOf,
  storeDispatchResult,
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
import {
  CodexRoleBoundaryError,
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  type CodexRoleBoundaryRequest,
  type CodexRoleSandboxMode,
} from "./codexRoleBoundary.js";
import {
  CODEX_FALLBACK_DELIVERY_MODE,
  codexLaunchGate,
  decideCodexCompletion,
  type CodexChildCorrelation,
} from "./codexDispatchProtocol.js";
import type { ActiveHarness, Harness } from "./types.js";

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
    ...request,
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
  materializeInput(): MaterializedDispatchInput;
  storeResult(output: DispatchJSONValue): StoreDispatchResultOutcome;
}

export interface DispatchAdapterLaunchContext {
  readonly route: DispatchTransportRoute;
  readonly prepared: DispatchPrepared;
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
  readonly launchOptions: ClaudePrintLaunchOptions;
}

export type ClaudeProcessAdapterBindingResolver = (
  context: DispatchAdapterLaunchContext,
) => ClaudeProcessAdapterBinding;

export function createClaudeProcessDispatchAdapter(
  resolve: ClaudeProcessAdapterBindingResolver,
): DispatchTransportAdapter {
  return createAdapter("claude", "process", async (context) => {
    const binding = resolve(context);
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
        childWindowMs: gate.childWindowMs,
      },
      binding.launchOptions,
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

export interface CodexProcessAdapterBoundary {
  readonly roleInstructions: string;
  readonly cwd: string;
  readonly ledgerCwd: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandboxMode: CodexRoleSandboxMode;
  readonly promptRoot: string;
  readonly ledgerCommand: string;
  readonly codexExecutable: string;
}

export interface CodexProcessAdapterBinding {
  readonly boundary: CodexProcessAdapterBoundary;
  readonly correlation: CodexChildCorrelation;
  readonly now: () => string;
}

export type CodexProcessAdapterBindingResolver = (
  context: DispatchAdapterLaunchContext,
) => CodexProcessAdapterBinding;

export function createCodexProcessDispatchAdapter(
  resolve: CodexProcessAdapterBindingResolver,
): DispatchTransportAdapter {
  return createAdapter("codex", "process", async (context) => {
    const binding = resolve(context);
    const gate = codexLaunchGate(context.prepared, binding.now());
    if (!gate.launch) {
      return {
        outcome: "aborted",
        reason: gate.abortReason,
        details: { refusal: gate.refusal, detail: gate.detail },
      };
    }
    const handle = handleOf(context.prepared);
    const promptDigest = new Bun.CryptoHasher("sha256")
      .update(binding.boundary.roleInstructions)
      .digest("hex");
    if (promptDigest !== context.prepared.promptProvenance.promptDigest) {
      throw new DispatchTransportRoutingError(
        `Codex role instructions digest ${JSON.stringify(promptDigest)} does not match prepared ` +
          `digest ${JSON.stringify(context.prepared.promptProvenance.promptDigest)}`,
      );
    }
    const request: CodexRoleBoundaryRequest = {
      ...binding.boundary,
      roleId: context.prepared.promptProvenance.roleId,
      handle,
      inputCapability: context.prepared.inputCapability,
      resultCapability: context.prepared.resultCapability,
      timeoutMs: gate.childWindowMs,
    };
    const plan = createCodexRoleBoundaryPlan(request);
    try {
      const observed = await executeCodexRoleBoundary(plan, binding.correlation.correlationId);
      const observedAt = binding.now();
      const decision = decideCodexCompletion({
        handle,
        expectedChild: binding.correlation,
        observation: {
          source: "transport",
          mode: CODEX_FALLBACK_DELIVERY_MODE,
          agentType: observed.observation.agentType,
          correlationId: observed.observation.correlationId,
          // Fresh `codex exec` runs mint their own child thread; completion stays bound to this parent-minted run identity.
          threadId: binding.correlation.threadId,
          outcome: observed.observation.outcome,
          exitStatus: observed.observation.exitStatus,
          finalMessage: JSON.stringify(observed.handle),
          observedAt,
        },
      });
      if (decision.action === "abort") {
        return { outcome: "aborted", reason: decision.reason, details: decision.details };
      }
      return {
        outcome: "completed",
        handle: observed.handle,
        nativeCompletion: decision.nativeCompletion,
        handleOnlyEnforcement: "structural",
      };
    } catch (error) {
      return codexProcessBoundaryFailure(error);
    }
  });
}

function codexProcessBoundaryFailure(error: unknown): DispatchAdapterAbortion {
  const boundaryError = findCodexRoleBoundaryError(error);
  if (boundaryError?.diagnostic !== undefined) {
    return {
      outcome: "aborted",
      reason: "protocol-violation",
      details: {
        source: "codex-role-boundary",
        verdict: boundaryError.diagnostic.verdict,
        detailCode: boundaryError.diagnostic.detailCode,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/child exceeded .* ms window/u.test(message)) {
    return {
      outcome: "aborted",
      reason: "deadline-exceeded",
      details: { source: "codex-role-boundary", message },
    };
  }
  if (/wrapper received SIG(?:INT|TERM)/u.test(message)) {
    return {
      outcome: "aborted",
      reason: "cancelled",
      details: { source: "codex-role-boundary", message },
    };
  }
  return {
    outcome: "aborted",
    reason: "native-failure",
    details: { source: "codex-role-boundary", message },
  };
}

function findCodexRoleBoundaryError(error: unknown): CodexRoleBoundaryError | undefined {
  if (error instanceof CodexRoleBoundaryError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findCodexRoleBoundaryError(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Lifecycle-conformant target-Pi process seam; T1632 supplies its launcher. */
export function createPiProcessDispatchAdapter(
  launch: DispatchAdapterLauncher,
): DispatchTransportAdapter {
  return createAdapter("pi", "process", launch);
}

export class DispatchTransportAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, DispatchTransportAdapter>;

  constructor(adapters: readonly DispatchTransportAdapter[]) {
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
    this.adapters = indexed;
  }

  resolve(route: DispatchTransportRoute): DispatchTransportAdapter {
    const adapter = this.adapters.get(route.adapterId);
    if (adapter === undefined) {
      throw new DispatchTransportRoutingError(
        `required ${route.transport} adapter for target ${JSON.stringify(route.targetHarness)} is unavailable`,
      );
    }
    return adapter;
  }
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
  readonly namespace: AttestationNamespace;
  readonly prepared: DispatchPrepared;
}

export interface RoutedDispatchConsumed {
  readonly outcome: "consumed";
  readonly route: DispatchTransportRoute;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
  readonly handle: DispatchHandle;
  /** The sole body-bearing value, returned by the authoritative consumed fetch. */
  readonly output: DispatchJSONValue;
}

export interface RoutedDispatchAborted {
  readonly outcome: "aborted";
  readonly route: DispatchTransportRoute;
  readonly adapterId: `${Harness}:${DispatchTransport}`;
  readonly handle: DispatchHandle;
  readonly abort: AbortedDispatchResult;
}

export type RoutedDispatchResult = RoutedDispatchConsumed | RoutedDispatchAborted;

const ABORT_REASON_SET: ReadonlySet<string> = new Set(DISPATCH_ABORT_REASONS);
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

function adapterAbort(
  request: RunPreparedDispatchRequest,
  route: DispatchTransportRoute,
  adapter: DispatchTransportAdapter,
  handle: DispatchHandle,
  reason: DispatchAbortReason,
  details: DispatchJSONValue | undefined,
  deps: DispatchServiceDeps,
): RoutedDispatchAborted {
  const abort = abortDispatch(
    {
      namespace: request.namespace,
      actor: "trusted-parent",
      ...handle,
      reason,
      ...(details === undefined ? {} : { details }),
    },
    deps,
  );
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
      (key) => !["outcome", "reason", "details"].includes(key),
    );
    if (
      typeof record["reason"] !== "string" ||
      !ABORT_REASON_SET.has(record["reason"]) ||
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
  deps: DispatchServiceDeps,
): Promise<RoutedDispatchResult> {
  const route = routeDispatchTransport(request);
  if (request.prepared.promptProvenance.surface !== request.targetHarness) {
    throw new DispatchTransportRoutingError(
      `prepared surface ${JSON.stringify(request.prepared.promptProvenance.surface)} does not ` +
        `match target ${JSON.stringify(request.targetHarness)}`,
    );
  }
  const adapter = registry.resolve(route);
  const handle = handleOf(request.prepared);
  const child: DispatchAdapterChildPort = Object.freeze({
    materializeInput: () =>
      fetchDispatchInput(
        {
          namespace: request.namespace,
          ...handle,
          inputCapability: request.prepared.inputCapability,
        },
        deps,
      ),
    storeResult: (output: DispatchJSONValue) =>
      storeDispatchResult({ resultCapability: request.prepared.resultCapability, output }, deps),
  });

  let result: DispatchAdapterLaunchResult;
  try {
    result = await adapter.launch(Object.freeze({ route, prepared: request.prepared, child }));
    assertAdapterLaunchResult(result);
    if (result.outcome === "aborted") {
      return adapterAbort(request, route, adapter, handle, result.reason, result.details, deps);
    }
    assertCompletionShape(result, route, handle);
  } catch (error) {
    if (error instanceof DispatchTransportAbort) {
      return adapterAbort(request, route, adapter, handle, error.reason, error.details, deps);
    }
    throw error;
  }

  let confirmation;
  try {
    confirmation = confirmDispatchCompletion(
      {
        namespace: request.namespace,
        ...handle,
        nativeCompletion: result.nativeCompletion,
        expectedProvenance: provenanceBindingOf(request.prepared),
      },
      deps,
    );
  } catch (error) {
    if (error instanceof AttestationBindingError) {
      return adapterAbort(
        request,
        route,
        adapter,
        handle,
        "native-failure",
        { violation: "completion-correlation-mismatch", detail: error.message },
        deps,
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

  const fetched = fetchDispatchResult(
    { namespace: request.namespace, actor: "trusted-parent", ...handle },
    deps,
  );
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
