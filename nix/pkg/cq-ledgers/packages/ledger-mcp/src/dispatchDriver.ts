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
  type DispatchJSONValue,
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
  type Tier,
} from "@cq/config";
import type { DispatchCapability, PrepareDispatchToolInput } from "@cq/ledger";

/** Upper bound on one waiting fetch, below every host's MCP tool timeout. */
export const DISPATCH_WAIT_MAX_MS = 45_000;
/** D588: how long a staged worker waits before re-coordinating a partition another front holds. */
export const IMPLEMENTATION_QUEUE_BLOCKED_RETRY_MS = 30_000;

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
export type DispatchModelResolver = (
  roleId: string,
  requestedModel: string | undefined,
  /** D558: the tier the unit of work itself declares, which outranks `[agent_tiers]`. */
  declaredTier?: Tier,
) => {
  readonly token: ReviewerToken;
  readonly formatted: string;
};

export interface DispatchDriverDeps {
  readonly capability: DispatchCapability;
  readonly readEnvelope: (handle: DispatchHandle) => Promise<AttestationEnvelope | undefined>;
  /** The parent's harness: the prompt surface this server serves. */
  readonly activeHarness: Harness;
  readonly resolveModel: DispatchModelResolver;
  /**
   * D558: the tier the dispatched unit of work declares, read from the ledger.
   * Absent when the project cannot be read or nothing declares one.
   */
  readonly declaredTierFor?: (input: StartDispatchInput) => Promise<Tier | undefined>;
  readonly registry: DispatchTransportAdapterRegistry;
  /** D559: stop the live child of a dispatch an abort just made terminal. */
  readonly cancelLaunch?: (handle: DispatchHandle) => void;
  /**
   * D565: a background launch failed AND its settling abort could not land —
   * typically because the dispatch was already terminal. The launch runs
   * unawaited, so this report is the only place either cause is ever seen; it
   * must never throw.
   */
  readonly reportLaunchFailure: (report: {
    readonly handle: DispatchHandle;
    readonly cause: string;
    readonly abortFailure: string;
  }) => void;
  readonly planner: DispatchLaunchPlanner;
  readonly now: () => string;
  /** D588: the pause between coordination attempts while another front holds the partition. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** A started dispatch plus its prepared record, for trusted in-server callers only. */
export interface StartedPreparedDispatch extends StartedDispatch {
  readonly prepared: DispatchPrepared;
}

export interface DispatchDriver {
  start(input: StartDispatchInput): Promise<StartDispatchOutcome>;
  /**
   * D559: settle the live child of a dispatch that has just become terminal. A
   * journal-only abort left the child running to its `childCancelAt` — for a
   * cohort, still committing into a worktree a successor would reuse.
   */
  cancelLaunch(handle: DispatchHandle): void;
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
  /**
   * D589: prepare and launch a guarded-rebase successor whose prepare the
   * capability owns, under a child planned from `seed` and at the token the
   * role's configuration resolves for `input`. The successor keeps its
   * source's prompt `surface`.
   */
  startSuccessor(input: {
    readonly roleId: string;
    readonly surface: Harness;
    readonly input: DispatchJSONValue;
    readonly seed: string;
    readonly timeoutMs: number;
    readonly prepare: (binding: {
      readonly expectedChild: NativeChildIdentity;
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
    deadline: string,
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
      // D565: a worker reporting `fail` needs no gate, so qualification consumed
      // it without queueing it. Coordinating it anyway made the coordinator throw
      // "requires a queued dispatch", and that throw took the server down.
      if (qualified.state === "consumed") return { state: "consumed" };
      const request = {
        ...handle,
        holderId: `${handle.attestationId}:${String(handle.generation)}:cq-dispatch-driver`,
        parentGateCapability,
      };
      // D588: coordination runs this candidate's gate only once it is the
      // partition's front. Nothing else re-coordinates a candidate queued
      // behind another front, so wait here until the dispatch's own deadline
      // and then fail loudly instead of leaving it gate-pending forever.
      let coordinated = await coordinate(request);
      while (
        coordinated.state === "blocked" &&
        coordinated.frontState !== "staged-rebase-retired" &&
        (coordinated.front.attestationId !== handle.attestationId ||
          coordinated.front.generation !== handle.generation)
      ) {
        if (Date.parse(deps.now()) >= Date.parse(deadline)) {
          throw new DispatchDriverError(
            `implementation queue partition stayed held by ${coordinated.front.attestationId}/` +
              `${String(coordinated.front.generation)} (${coordinated.frontState}) until the dispatch deadline ${deadline}`,
          );
        }
        await deps.sleep(IMPLEMENTATION_QUEUE_BLOCKED_RETRY_MS);
        // D589: the front may have lost the process that coordinated it, so
        // drain the partition from here rather than waiting on that process.
        const drained = await coordinate({
          partitionKey: coordinated.partitionKey,
          holderId: request.holderId,
        });
        if ((await deps.readEnvelope(handle))?.state !== "gate-pending") return { state: "queued" };
        coordinated = drained.state === "blocked" ? drained : await coordinate(request);
      }
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
      try {
        await deps.capability.abort({
          ...handle,
          reason: "native-failure",
          details: { source: "dispatch-driver", message },
        });
      } catch (abortError) {
        // D565: this launch runs unawaited, so a rejection escaping here is
        // unhandled and Bun terminates the whole management server — every
        // other dispatch with it. The dispatch is already terminal or will
        // expire at its deadline; report both causes instead of propagating.
        deps.reportLaunchFailure({
          handle,
          cause: message,
          abortFailure: abortError instanceof Error ? abortError.message : String(abortError),
        });
      }
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
              outcome.prepared.childCancelAt,
            ),
          }),
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    return started;
  }

  return {
    cancelLaunch(handle) {
      deps.cancelLaunch?.(handle);
    },
    async start(input) {
      const roleId = roleIdOf(input);
      const declaredTier = deps.declaredTierFor === undefined ? undefined : await deps.declaredTierFor(input);
      const { token, formatted } = deps.resolveModel(roleId, input.model, declaredTier);
      const outcome = await launchWith(roleId, token, formatted, input.idempotencyKey, async ({ expectedChild }) =>
        await deps.capability.prepare({ ...withTargetSurface(input, token.harness), expectedChild }),
      );
      if (!outcome.accepted) return outcome;
      return { accepted: true, handle: outcome.handle, route: outcome.route };
    },

    async startPrepared(input) {
      return await launchWith(input.roleId, input.token, formatReviewerToken(input.token), input.seed, input.prepare);
    },

    async startSuccessor(input) {
      const start: StartDispatchInput = {
        roleId: input.roleId,
        input: input.input,
        idempotencyKey: input.seed,
        timeoutMs: input.timeoutMs,
      };
      const declaredTier = deps.declaredTierFor === undefined ? undefined : await deps.declaredTierFor(start);
      const { token, formatted } = deps.resolveModel(input.roleId, undefined, declaredTier);
      if (token.harness !== input.surface) {
        throw new DispatchDriverError(
          `a ${input.surface} successor resolves to ${formatted}; a successor keeps its source's prompt surface`,
        );
      }
      return await launchWith(input.roleId, token, formatted, input.seed, async ({ expectedChild }) =>
        await input.prepare({ expectedChild }),
      );
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
