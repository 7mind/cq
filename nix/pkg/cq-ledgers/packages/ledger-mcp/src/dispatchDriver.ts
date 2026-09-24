/**
 * G224 / K331 / K332 — CQ-driven dispatch. The parent names a role and its
 * typed input; this driver resolves the role's model from trusted
 * configuration, prepares against the TARGET harness's prompt surface, launches
 * through that harness's process adapter, and settles through the server's own
 * dispatch capability. The parent never holds a capability and never launches.
 *
 * `start` returns as soon as the launch is underway. The parent then calls
 * `fetch_dispatch_result` with a bounded `waitMs`: `waitFor` holds that call
 * until this server's in-flight launch settles or the wait elapses, and the
 * ordinary durable fetch answers. So no MCP call outlives a host's tool
 * timeout, the answer survives a server restart, and the parent's fetch stays
 * the single body-returning surface (T682): the driver never materializes.
 */

import {
  formatReviewerToken,
  runPreparedDispatch,
  type AttestationEnvelope,
  type DispatchHandle,
  type DispatchPrepared,
  type DispatchPreLaunchRejection,
  type PrepareDispatchOutcome,
  type DispatchSettlementPort,
  type DispatchTransportAdapterRegistry,
  type Harness,
  type NativeChildIdentity,
  type ReviewerToken,
  type RoutedStagedCompletionQualifier,
} from "@cq/config";
import type { DispatchCapability, PrepareDispatchToolInput } from "@cq/ledger";

/** Upper bound on one waiting fetch, below every host's MCP tool timeout. */
export const DISPATCH_WAIT_MAX_MS = 45_000;

export type StartDispatchInput = Omit<PrepareDispatchToolInput, "expectedChild" | "surface"> & {
  /** A panel or tier token the configuration makes dispatchable; defaults to the role's tier token. */
  readonly model?: string;
};

export interface StartedDispatch {
  readonly accepted: true;
  readonly handle: DispatchHandle;
  readonly route: {
    readonly activeHarness: Harness;
    readonly targetHarness: Harness;
    readonly model: string;
  };
}

export type StartDispatchOutcome = StartedDispatch | DispatchPreLaunchRejection;

export interface DispatchWaitInput extends DispatchHandle {
  readonly waitMs: number;
}

/** One launch's harness-specific child correlation, minted before prepare binds it. */
export interface PlannedDispatchLaunch {
  readonly expectedChild: NativeChildIdentity;
  /**
   * The same identity in the shape a staged worker's qualification checks:
   * `expectedChild.childId` is `<roleId>#<correlationId>` on every harness.
   */
  readonly qualificationIdentity: {
    readonly correlationId: string;
    readonly childThreadId: string;
    readonly runId: string;
  };
  /** Make the correlation available to the target adapter's binding resolver. */
  bind(handle: DispatchHandle): void;
  release(handle: DispatchHandle): void;
}

export interface DispatchLaunchPlanner {
  /** `seed` is the dispatch's idempotency key: a replay must plan the same child. */
  plan(targetHarness: Harness, roleId: string, seed: string): PlannedDispatchLaunch;
}

/** Resolves which token a role runs at; throws when a requested token is not dispatchable. */
export type DispatchModelResolver = (roleId: string, requestedModel: string | undefined) => {
  readonly token: ReviewerToken;
  readonly formatted: string;
};

export interface DispatchDriverDeps {
  readonly capability: DispatchCapability;
  readonly readEnvelope: (handle: DispatchHandle) => Promise<AttestationEnvelope | undefined>;
  /** The parent's harness: the prompt surface this server serves. */
  readonly activeHarness: Harness;
  readonly resolveModel: DispatchModelResolver;
  readonly registry: DispatchTransportAdapterRegistry;
  readonly planner: DispatchLaunchPlanner;
  readonly now: () => string;
}

/** A started dispatch plus its prepared record, for trusted in-server callers only. */
export interface StartedPreparedDispatch extends StartedDispatch {
  readonly prepared: DispatchPrepared;
}

export interface DispatchDriver {
  start(input: StartDispatchInput): Promise<StartDispatchOutcome>;
  /**
   * Launch a dispatch whose prepare a trusted in-server caller owns (native
   * implementation-evidence attempts), at an explicit token. `seed` is the
   * caller's idempotency key.
   */
  startPrepared(input: {
    readonly roleId: string;
    readonly token: ReviewerToken;
    readonly seed: string;
    readonly prepare: (binding: {
      readonly expectedChild: NativeChildIdentity;
      readonly surface: Harness;
    }) => Promise<PrepareDispatchOutcome>;
  }): Promise<StartedPreparedDispatch | DispatchPreLaunchRejection>;
  /** Resolve when this server's launch of the handle settles, or after `waitMs`. */
  waitFor(input: DispatchWaitInput): Promise<void>;
}

export class DispatchDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchDriverError";
  }
}

function handleKey(handle: DispatchHandle): string {
  return `${handle.attestationId}:${String(handle.generation)}`;
}

function roleIdOf(input: StartDispatchInput): string {
  if (input.roleId !== undefined) return input.roleId;
  const refs = input.refs;
  if (refs !== null && typeof refs === "object" && !Array.isArray(refs)) {
    const roleId = (refs as Readonly<Record<string, unknown>>)["roleId"];
    if (typeof roleId === "string" && roleId !== "") return roleId;
  }
  throw new DispatchDriverError("start_dispatch requires roleId or refs naming a roleId");
}

function withTargetSurface(input: StartDispatchInput, targetHarness: Harness): PrepareDispatchToolInput {
  const { model: _model, ...prepare } = input;
  if (prepare.refs === undefined) return { ...prepare, surface: targetHarness } as PrepareDispatchToolInput;
  const refs = prepare.refs as Readonly<Record<string, unknown>>;
  if (refs["surface"] !== undefined && refs["surface"] !== targetHarness) {
    throw new DispatchDriverError(
      `refs.surface ${JSON.stringify(refs["surface"])} does not match the role's configured harness ${JSON.stringify(targetHarness)}`,
    );
  }
  return { ...prepare, refs: { ...refs, surface: targetHarness } } as PrepareDispatchToolInput;
}

function settlementThrough(
  capability: DispatchCapability,
  readEnvelope: DispatchDriverDeps["readEnvelope"],
): DispatchSettlementPort {
  return Object.freeze({
    readEnvelope,
    materializeInput: async (handle, inputCapability) =>
      await capability.fetchInput({ ...handle, inputCapability }),
    storeResult: async (resultCapability, output) =>
      await capability.storeResult({ resultCapability, output }),
    confirm: async (input) =>
      await capability.confirmCompletion({
        ...input.handle,
        nativeCompletion: input.nativeCompletion,
        expectedProvenance: input.expectedProvenance,
      }),
    abort: async (input) =>
      await capability.abort({
        ...input.handle,
        reason: input.reason,
        ...(input.details === undefined ? {} : { details: input.details }),
      }),
    fetch: async (handle) => await capability.fetch(handle),
  } satisfies DispatchSettlementPort);
}

export function createDispatchDriver(deps: DispatchDriverDeps): DispatchDriver {
  const settlement = settlementThrough(deps.capability, deps.readEnvelope);
  const inFlight = new Map<string, Promise<void>>();

  /**
   * A worker whose result the store staged for its parent gate: qualify it with
   * the identity bound at prepare, then run the parent gate - what the Codex
   * launcher does inside its own process. The parent-gate capability never
   * leaves this server.
   */
  function stagedWorkerQualifier(
    handle: DispatchHandle,
    roleId: string,
    planned: PlannedDispatchLaunch,
    parentGateCapability: NonNullable<DispatchPrepared["parentGateCapability"]>,
  ): RoutedStagedCompletionQualifier {
    return async (observation) => {
      const qualify = deps.capability.qualifyImplementationCandidate;
      const coordinate = deps.capability.coordinateImplementationCandidate;
      if (qualify === undefined || coordinate === undefined) {
        throw new DispatchDriverError("this server cannot run a staged worker's parent gate");
      }
      const qualified = await qualify({
        ...handle,
        roleId,
        correlationId: planned.qualificationIdentity.correlationId,
        childThreadId: planned.qualificationIdentity.childThreadId,
        expectedRunId: planned.qualificationIdentity.runId,
        outcome: "completed",
        exitStatus: 0,
        observedAt: deps.now(),
        promptDigest: observation.expectedProvenance.promptDigest,
      });
      if (qualified.state === "aborted") return { state: "aborted", result: qualified.result };
      await coordinate({
        ...handle,
        holderId: `${handle.attestationId}:${String(handle.generation)}:cq-dispatch-driver`,
        parentGateCapability,
      });
      return { state: "queued" };
    };
  }

  async function launch(
    handle: DispatchHandle,
    planned: PlannedDispatchLaunch,
    request: Parameters<typeof runPreparedDispatch>[0],
  ): Promise<void> {
    planned.bind(handle);
    try {
      await runPreparedDispatch(request, deps.registry, settlement);
    } catch (error) {
      // A launch that throws after prepare would otherwise leave the dispatch
      // prepared until its deadline; settle it now with the cause.
      const message = error instanceof Error ? error.message : String(error);
      await deps.capability.abort({
        ...handle,
        reason: "native-failure",
        details: { source: "dispatch-driver", message },
      });
    } finally {
      planned.release(handle);
    }
  }

  /**
   * Prepare through `prepareWith` with a planned child, then launch - unless the
   * dispatch is already in flight here or no longer `prepared` (an idempotent
   * replay of a started, running or finished dispatch never launches twice).
   */
  async function launchWith(
    roleId: string,
    token: ReviewerToken,
    formatted: string,
    seed: string,
    prepareWith: (binding: {
      readonly expectedChild: NativeChildIdentity;
      readonly surface: Harness;
    }) => Promise<PrepareDispatchOutcome>,
  ): Promise<StartedPreparedDispatch | DispatchPreLaunchRejection> {
    const targetHarness = token.harness;
    const planned = deps.planner.plan(targetHarness, roleId, seed);
    const outcome = await prepareWith({ expectedChild: planned.expectedChild, surface: targetHarness });
    if (!outcome.accepted) return outcome;
    const handle = outcome.handle;
    const key = handleKey(handle);
    const started = {
      accepted: true as const,
      handle,
      route: { activeHarness: deps.activeHarness, targetHarness, model: formatted },
      prepared: outcome.prepared,
    };
    if (inFlight.has(key) || (await deps.readEnvelope(handle))?.state !== "prepared") return started;
    const running = launch(handle, planned, {
      prepared: outcome.prepared,
      resolvedModel: token,
      activeHarness: deps.activeHarness,
      targetHarness,
      // K331: a server can host only process adapters.
      forceShellout: true,
      materializeOutput: false,
      ...(outcome.prepared.parentGateCapability === undefined
        ? {}
        : {
            qualifyStagedCompletion: stagedWorkerQualifier(
              handle,
              roleId,
              planned,
              outcome.prepared.parentGateCapability,
            ),
          }),
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    return started;
  }

  return {
    async start(input) {
      const roleId = roleIdOf(input);
      const { token, formatted } = deps.resolveModel(roleId, input.model);
      const outcome = await launchWith(roleId, token, formatted, input.idempotencyKey, async ({ expectedChild }) =>
        await deps.capability.prepare({ ...withTargetSurface(input, token.harness), expectedChild }),
      );
      if (!outcome.accepted) return outcome;
      return { accepted: true, handle: outcome.handle, route: outcome.route };
    },

    async startPrepared(input) {
      return await launchWith(input.roleId, input.token, formatReviewerToken(input.token), input.seed, input.prepare);
    },

    async waitFor(input) {
      if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > DISPATCH_WAIT_MAX_MS) {
        throw new DispatchDriverError(`waitMs must be an integer within [0, ${DISPATCH_WAIT_MAX_MS}]`);
      }
      const running = inFlight.get(handleKey(input));
      if (running === undefined) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, input.waitMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
