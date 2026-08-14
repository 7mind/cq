import {
  settleProcessGroups,
  type ProcessGroupRegistration,
  type SettleProcessGroupsOptions,
  type SettleProcessGroupsResult,
} from "./processGroup.ts";
import {
  launchRegisteredProcessGroup,
  type LaunchedRegisteredProcessGroup,
  type RegisteredLaunchBootstrap,
  type RegisteredLaunchBootstrapSpecification,
} from "./registeredLaunch.ts";
import {
  WORKSET_BROKER_EXTERNAL_EFFECT_KINDS,
  WorksetEffectProtocolError,
  WorksetEffectProtocolSession,
  type WorksetBrokerAdmissionHandle,
  type WorksetBrokerExternalEffectKind,
  type WorksetBrokerTerminationReason,
  type WorksetEffectAdmissionProvider,
} from "./worksetEffectProtocol.ts";

export interface WorksetEffectBrokerOptions {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly settlement?: SettleProcessGroupsOptions;
}

export interface LaunchWorksetEffectOptions<TProcess, TExit, TStdio> {
  readonly kind: WorksetBrokerExternalEffectKind;
  readonly targetRef: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: TStdio;
  readonly launchBootstrap: (
    specification: RegisteredLaunchBootstrapSpecification<TStdio>,
  ) => RegisteredLaunchBootstrap<TProcess, TExit>;
  /** Settle dispatcher-owned nested groups before the registered root releases admission. */
  readonly settleRegisteredDescendants?: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface LaunchedWorksetEffect<TProcess, TExit>
  extends LaunchedRegisteredProcessGroup<TProcess, TExit> {
  /** Idempotently request TERM → grace → KILL → settlement. */
  cancel(): Promise<void>;
  /** First cleanup reason to win the target-completion/cancel/timeout race. */
  readonly terminationReason: WorksetBrokerTerminationReason | null;
}

export type StrictInMemoryWorksetEffectEvent =
  | "admission-acquired"
  | "process-group-registered"
  | "guardian-shared"
  | "process-group-settled"
  | "guardian-released"
  | "admission-released"
  | "admission-abandoned";

export interface StrictInMemoryWorksetEffectAdmissionProvider
  extends WorksetEffectAdmissionProvider {
  events(): readonly StrictInMemoryWorksetEffectEvent[];
  activeAdmissionCount(): number;
  waitForIdle(): Promise<void>;
}

interface StrictAdmissionState {
  registered: boolean;
  settled: boolean;
  open: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new Error("@cq/process-control: workset effect timeout must be a bounded non-negative value");
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function abandonAdmission(session: WorksetEffectProtocolSession): Promise<void> {
  if (session.stage !== "admission-held") return;
  await session.abandonBeforeRegistration();
}

/**
 * Runs exactly one enumerated external effect under an opaque admission.
 * Admission acquisition precedes bootstrap launch; registered launch keeps the
 * bootstrap fenced until the provider durably publishes its group. The
 * bootstrap leader acts as the surviving lease guardian. No admission object
 * or provider data enters the child argv, environment, output, or protocol
 * directory.
 */
export class WorksetEffectBroker {
  private readonly provider: WorksetEffectAdmissionProvider;
  private readonly settlement: SettleProcessGroupsOptions;

  constructor(options: WorksetEffectBrokerOptions) {
    this.provider = options.provider;
    this.settlement = options.settlement ?? {};
  }

  async launch<TProcess, TExit, TStdio>(
    options: LaunchWorksetEffectOptions<TProcess, TExit, TStdio>,
  ): Promise<LaunchedWorksetEffect<TProcess, TExit>> {
    validateTimeout(options.timeoutMs);
    const session = new WorksetEffectProtocolSession({
      provider: this.provider,
      kind: options.kind,
      targetRef: options.targetRef,
    });
    await session.acquireAdmission();

    let registration: ProcessGroupRegistration | null = null;
    let terminationReason: WorksetBrokerTerminationReason | null = null;
    let settlementPromise: Promise<void> | null = null;

    const settle = (reason: WorksetBrokerTerminationReason): Promise<void> => {
      if (settlementPromise !== null) return settlementPromise;
      terminationReason = reason;
      settlementPromise = (async () => {
        if (registration === null) {
          throw new WorksetEffectProtocolError(
            "registration-required",
            "workset effect settlement requires its guardian registration",
          );
        }
        session.beginTermination(reason);
        let descendantError: unknown;
        try {
          await options.settleRegisteredDescendants?.();
        } catch (error) {
          descendantError = error;
        }
        let result: SettleProcessGroupsResult | undefined;
        let rootError: unknown;
        try {
          result = await settleProcessGroups([registration], this.settlement);
        } catch (error) {
          rootError = error;
        }
        if (descendantError !== undefined || rootError !== undefined) {
          throw new AggregateError(
            [descendantError, rootError].filter((error) => error !== undefined),
            "@cq/process-control: workset effect could not settle every registered process group",
          );
        }
        if (result === undefined) {
          throw new Error("@cq/process-control: workset effect root settlement returned no result");
        }
        if (result.survivors.length > 0) {
          throw new Error(
            `@cq/process-control: workset effect process group did not settle: ${result.survivors.join(", ")}`,
          );
        }
        await session.markSettled();
      })();
      return settlementPromise;
    };

    let launched: LaunchedRegisteredProcessGroup<TProcess, TExit>;
    try {
      if (signalAborted(options.signal)) {
        await abandonAdmission(session);
        throw options.signal?.reason ?? new Error("@cq/process-control: workset effect cancelled");
      }
      launched = await launchRegisteredProcessGroup({
        argv: options.argv,
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
        launchBootstrap: options.launchBootstrap,
        register: async (candidate) => {
          registration = candidate;
          await session.registerProcessGroup({
            pgid: candidate.pgid,
            leaderPid: candidate.leader.pid,
          });
        },
        shareLeaseWithGuardian: async (candidate) => {
          if (registration?.pgid !== candidate.pgid) {
            throw new WorksetEffectProtocolError(
              "registration-required",
              "registered-launch guardian identity changed before target release",
            );
          }
          await session.shareWithGuardian();
          session.releaseTarget();
        },
        onTargetExit: async () => {
          await settle("normal");
        },
      });
    } catch (launchError) {
      try {
        if (session.stage === "admission-held") {
          await abandonAdmission(session);
        } else if (
          session.stage === "process-group-registered" ||
          session.stage === "target-released"
        ) {
          await settle("broker-death");
          await session.closeAdmission();
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [launchError, cleanupError],
          `@cq/process-control: workset effect launch failed and admission cleanup failed: ${errorMessage(launchError)}`,
        );
      }
      throw launchError;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let asynchronousSettlementError: unknown;
    const requestSettlement = (reason: WorksetBrokerTerminationReason): void => {
      void settle(reason).catch((error: unknown) => {
        asynchronousSettlementError = error;
      });
    };
    const abortListener = (): void => requestSettlement("cancel");
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (signalAborted(options.signal)) requestSettlement("cancel");
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => requestSettlement("timeout"), options.timeoutMs);
      timer.unref?.();
    }

    const exited = (async (): Promise<TExit> => {
      let outcome: TExit;
      try {
        outcome = await launched.exited;
      } catch (launchError) {
        try {
          await settle("broker-death");
          await session.closeAdmission();
        } catch (cleanupError) {
          throw new AggregateError(
            [launchError, cleanupError],
            `@cq/process-control: workset effect failed and settlement failed: ${errorMessage(launchError)}`,
          );
        }
        throw launchError;
      } finally {
        if (timer !== null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortListener);
      }

      await settle("normal");
      if (asynchronousSettlementError !== undefined) throw asynchronousSettlementError;
      await session.closeAdmission();
      return outcome;
    })();

    return {
      process: launched.process,
      registration: launched.registration,
      exited,
      cancel: async () => {
        await settle("cancel");
      },
      get terminationReason(): WorksetBrokerTerminationReason | null {
        return terminationReason;
      },
    };
  }
}

/**
 * Strict provider for shared Blackbox tests. It treats registration as the
 * guardian share: the admission remains active until settlement evidence has
 * been recorded and the guardian share closes.
 */
export function createStrictInMemoryWorksetEffectAdmissionProvider(): StrictInMemoryWorksetEffectAdmissionProvider {
  const active = new Set<StrictAdmissionState>();
  const history: StrictInMemoryWorksetEffectEvent[] = [];
  let nextId = 0;
  let idle = deferred();
  idle.resolve();

  function close(state: StrictAdmissionState): void {
    state.open = false;
    active.delete(state);
    if (active.size === 0) idle.resolve();
  }

  return {
    async acquire(input): Promise<WorksetBrokerAdmissionHandle> {
      if (
        !(WORKSET_BROKER_EXTERNAL_EFFECT_KINDS as readonly string[]).includes(input.kind)
      ) {
        throw new Error(`@cq/process-control: unknown workset effect kind ${String(input.kind)}`);
      }
      if (input.targetRef.trim() === "") {
        throw new Error("@cq/process-control: workset effect target ref must not be blank");
      }
      if (active.size === 0) idle = deferred();
      const state: StrictAdmissionState = {
        registered: false,
        settled: false,
        open: true,
      };
      active.add(state);
      history.push("admission-acquired");
      const handle: WorksetBrokerAdmissionHandle = {
        id: `strict-ee-${String(++nextId)}`,
        epoch: 0,
        kind: input.kind,
        targetRef: input.targetRef,
        registerProcessGroup(registration): void {
          if (!state.open) throw new Error("strict provider: admission already closed");
          if (state.registered) throw new Error("strict provider: process group already registered");
          if (registration.pgid !== registration.leaderPid) {
            throw new Error("strict provider: process group leader must equal PGID");
          }
          state.registered = true;
          history.push("process-group-registered");
        },
        shareWithGuardian(guardian): void {
          if (!state.open) throw new Error("strict provider: admission already closed");
          if (!state.registered) throw new Error("strict provider: process group not registered");
          if (guardian.pgid !== guardian.leaderPid) {
            throw new Error("strict provider: guardian must be the registered group leader");
          }
          history.push("guardian-shared");
        },
        markSettled(): void {
          if (!state.open) throw new Error("strict provider: admission already closed");
          if (!state.registered) throw new Error("strict provider: guardian not registered");
          if (state.settled) throw new Error("strict provider: process group already settled");
          state.settled = true;
          history.push("process-group-settled");
        },
        async releaseAfterSettlement(): Promise<void> {
          if (!state.open) throw new Error("strict provider: admission already closed");
          if (!state.registered || !state.settled) {
            throw new Error("strict provider: settlement evidence required before release");
          }
          history.push("guardian-released", "admission-released");
          close(state);
        },
        async abandonBeforeRegistration(): Promise<void> {
          if (!state.open) throw new Error("strict provider: admission already closed");
          if (state.registered) throw new Error("strict provider: registered admission cannot be abandoned");
          history.push("admission-abandoned");
          close(state);
        },
      };
      return Object.freeze(handle);
    },
    events: () => history.slice(),
    activeAdmissionCount: () => active.size,
    waitForIdle: async () => {
      if (active.size > 0) await idle.promise;
    },
  };
}
