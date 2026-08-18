import { awaitBeforeLaunchDeadline, remainingLaunchDeadlineMs } from "./launchDeadline.ts";

/**
 * T1953 — host effect-broker protocol for workset external effects.
 *
 * Process-control never sees ledger store internals. The broker depends on an
 * injected opaque admission provider. One external effect uses exactly one
 * non-transferable admission; the broker:
 *
 *   1. acquires admission
 *   2. registers the exact target process group before target release
 *   3. releases the target to run
 *   4. on normal completion / cancel / timeout / parent death / broker death:
 *      terminates and settles the registered group (and descendants)
 *   5. only then closes the admission
 *
 * Forbidden: prompt-only prechecks as a substitute for admission, read-to-write
 * upgrades, caller-minted admissions, transfer to children, and multiple
 * observable effects under one admission.
 *
 * The real broker lands in T1979; this module seals the stage machine and the
 * provider surface that T1979 implements.
 */

// ---------------------------------------------------------------------------
// External effect kinds (broker inventory; must stay aligned with @cq/ledger)
// ---------------------------------------------------------------------------

export const WORKSET_BROKER_EXTERNAL_EFFECT_KINDS = [
  "child-dispatch",
  "worktree-create",
  "worktree-remove",
  "branch-create",
  "branch-remove",
  "rebase",
  "merge",
] as const;

export type WorksetBrokerExternalEffectKind = (typeof WORKSET_BROKER_EXTERNAL_EFFECT_KINDS)[number];

export const WORKSET_BROKER_TERMINATION_REASONS = [
  "normal",
  "cancel",
  "timeout",
  "parent-death",
  "broker-death",
] as const;

export type WorksetBrokerTerminationReason = (typeof WORKSET_BROKER_TERMINATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * Ordered broker stages for one effect. Transitions are one-way except that
 * termination may begin from `process-group-registered` or `target-released`.
 */
export const WORKSET_EFFECT_BROKER_STAGES = [
  "unacquired",
  "admission-held",
  "process-group-registered",
  "target-released",
  "terminating",
  "settled",
  "admission-closed",
] as const;

export type WorksetEffectBrokerStage = (typeof WORKSET_EFFECT_BROKER_STAGES)[number];

// ---------------------------------------------------------------------------
// Opaque admission provider (injected; backends implement this)
// ---------------------------------------------------------------------------

export interface WorksetBrokerProcessGroupRegistration {
  readonly pgid: number;
  readonly leaderPid: number;
}

/**
 * Opaque handle returned by the admission provider. The broker must not
 * serialize it into argv, environment, MCP payloads, or logs.
 */
export interface WorksetBrokerAdmissionHandle {
  readonly id: string;
  readonly epoch: number;
  readonly kind: WorksetBrokerExternalEffectKind;
  readonly targetRef: string;
  /**
   * May return a Promise on durable backends (Postgres). Callers must
   * `await Promise.resolve(...)` (D298).
   */
  registerProcessGroup(
    registration: WorksetBrokerProcessGroupRegistration,
    launchDeadlineMs?: number,
  ): void | Promise<void>;
  /** Share the held admission with the already registered bootstrap guardian. */
  shareWithGuardian(
    guardian: WorksetBrokerProcessGroupRegistration,
    launchDeadlineMs?: number,
  ): void | Promise<void>;
  markSettled(): void | Promise<void>;
  releaseAfterSettlement(): Promise<void>;
  /** Close an acquired admission when its fenced bootstrap never registered. */
  abandonBeforeRegistration(): Promise<void>;
}

export interface WorksetEffectAdmissionProvider {
  /**
   * Obtain one non-transferable read admission for exactly one external
   * effect. Provider implementations validate target/epoch under the current
   * workset roots.
   */
  acquire(input: {
    readonly kind: WorksetBrokerExternalEffectKind;
    readonly targetRef: string;
    readonly launchDeadlineMs?: number;
  }): Promise<WorksetBrokerAdmissionHandle>;
}

// ---------------------------------------------------------------------------
// Protocol errors
// ---------------------------------------------------------------------------

export type WorksetEffectProtocolErrorCode =
  | "illegal-stage-transition"
  | "admission-required"
  | "registration-required"
  | "settlement-required"
  | "multiple-effects"
  | "transfer-forbidden"
  | "already-closed";

export class WorksetEffectProtocolError extends Error {
  readonly code: WorksetEffectProtocolErrorCode;
  constructor(code: WorksetEffectProtocolErrorCode, message: string) {
    super(message);
    this.name = "WorksetEffectProtocolError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Single-effect protocol session (pure stage machine + provider)
// ---------------------------------------------------------------------------

export interface WorksetEffectProtocolSessionOptions {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly kind: WorksetBrokerExternalEffectKind;
  readonly targetRef: string;
}

/**
 * Drives one external effect through the broker stage machine. Latch-driven
 * tests use this directly; T1979's WorksetEffectBroker wraps real launches.
 */
export class WorksetEffectProtocolSession {
  readonly kind: WorksetBrokerExternalEffectKind;
  readonly targetRef: string;
  private readonly provider: WorksetEffectAdmissionProvider;
  private stageValue: WorksetEffectBrokerStage = "unacquired";
  private admission: WorksetBrokerAdmissionHandle | null = null;
  private registration: WorksetBrokerProcessGroupRegistration | null = null;
  private guardianShared = false;
  private terminationReason: WorksetBrokerTerminationReason | null = null;
  private effectCount = 0;

  constructor(options: WorksetEffectProtocolSessionOptions) {
    this.provider = options.provider;
    this.kind = options.kind;
    this.targetRef = options.targetRef;
  }

  get stage(): WorksetEffectBrokerStage {
    return this.stageValue;
  }

  get admissionId(): string | null {
    return this.admission?.id ?? null;
  }

  get admissionEpoch(): number | null {
    return this.admission?.epoch ?? null;
  }

  get processGroup(): WorksetBrokerProcessGroupRegistration | null {
    return this.registration;
  }

  get reason(): WorksetBrokerTerminationReason | null {
    return this.terminationReason;
  }

  async acquireAdmission(launchDeadlineMs?: number): Promise<void> {
    this.assertStage("unacquired", "acquireAdmission");
    if (this.effectCount > 0) {
      throw new WorksetEffectProtocolError(
        "multiple-effects",
        "one workset external-effect admission admits exactly one observable effect",
      );
    }
    const handle = await this.provider.acquire({
      kind: this.kind,
      targetRef: this.targetRef,
      ...(launchDeadlineMs === undefined ? {} : { launchDeadlineMs }),
    });
    try {
      remainingLaunchDeadlineMs(launchDeadlineMs, "durable admission acquisition");
    } catch (error) {
      try {
        await handle.abandonBeforeRegistration();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "@cq/process-control: expired admission acquisition could not be abandoned",
        );
      }
      throw error;
    }
    this.admission = handle;
    this.stageValue = "admission-held";
  }

  async abandonBeforeRegistration(): Promise<void> {
    this.assertStage("admission-held", "abandonBeforeRegistration");
    if (this.admission === null) {
      throw new WorksetEffectProtocolError(
        "admission-required",
        "abandonBeforeRegistration requires a held admission",
      );
    }
    await this.admission.abandonBeforeRegistration();
    this.stageValue = "admission-closed";
  }

  async registerProcessGroup(
    registration: WorksetBrokerProcessGroupRegistration,
    launchDeadlineMs?: number,
  ): Promise<void> {
    this.assertStage("admission-held", "registerProcessGroup");
    if (this.admission === null) {
      throw new WorksetEffectProtocolError(
        "admission-required",
        "process-group registration requires a held admission",
      );
    }
    if (registration.pgid !== registration.leaderPid) {
      throw new WorksetEffectProtocolError(
        "illegal-stage-transition",
        "process-group registration requires leaderPid === pgid",
      );
    }
    remainingLaunchDeadlineMs(launchDeadlineMs, "durable process-group registration");
    await awaitBeforeLaunchDeadline(
      Promise.resolve(this.admission.registerProcessGroup(registration, launchDeadlineMs)),
      launchDeadlineMs,
      "durable process-group registration",
    );
    this.registration = {
      pgid: registration.pgid,
      leaderPid: registration.leaderPid,
    };
    this.stageValue = "process-group-registered";
    remainingLaunchDeadlineMs(launchDeadlineMs, "durable process-group registration");
  }

  async shareWithGuardian(launchDeadlineMs?: number): Promise<void> {
    this.assertStage("process-group-registered", "shareWithGuardian");
    if (this.admission === null || this.registration === null) {
      throw new WorksetEffectProtocolError(
        "registration-required",
        "guardian sharing requires a registered process group",
      );
    }
    if (this.guardianShared) {
      throw new WorksetEffectProtocolError(
        "multiple-effects",
        "workset effect admission already has a guardian share",
      );
    }
    remainingLaunchDeadlineMs(launchDeadlineMs, "durable guardian share");
    await awaitBeforeLaunchDeadline(
      Promise.resolve(this.admission.shareWithGuardian(this.registration, launchDeadlineMs)),
      launchDeadlineMs,
      "durable guardian share",
    );
    this.guardianShared = true;
    remainingLaunchDeadlineMs(launchDeadlineMs, "durable guardian share");
  }

  /**
   * Mark the target released to run. Counts as the single observable effect
   * under this admission.
   */
  releaseTarget(): void {
    this.assertStage("process-group-registered", "releaseTarget");
    if (!this.guardianShared) {
      throw new WorksetEffectProtocolError(
        "illegal-stage-transition",
        "releaseTarget requires the registered guardian to share admission",
      );
    }
    this.effectCount += 1;
    this.stageValue = "target-released";
  }

  /**
   * Begin termination for any cleanup reason. Allowed from registered (target
   * never started) or target-released. Settlement must still precede admission
   * close.
   */
  beginTermination(reason: WorksetBrokerTerminationReason): void {
    if (this.stageValue !== "process-group-registered" && this.stageValue !== "target-released") {
      throw new WorksetEffectProtocolError(
        "illegal-stage-transition",
        `beginTermination not allowed from stage ${this.stageValue}`,
      );
    }
    if (!(WORKSET_BROKER_TERMINATION_REASONS as readonly string[]).includes(reason)) {
      throw new WorksetEffectProtocolError(
        "illegal-stage-transition",
        `unknown termination reason: ${String(reason)}`,
      );
    }
    this.terminationReason = reason;
    this.stageValue = "terminating";
  }

  async markSettled(): Promise<void> {
    this.assertStage("terminating", "markSettled");
    if (this.admission === null || this.registration === null) {
      throw new WorksetEffectProtocolError(
        "registration-required",
        "settlement requires a registered process group under a held admission",
      );
    }
    await Promise.resolve(this.admission.markSettled());
    this.stageValue = "settled";
  }

  async closeAdmission(): Promise<void> {
    if (this.stageValue === "admission-closed") {
      throw new WorksetEffectProtocolError("already-closed", "admission already closed");
    }
    if (this.stageValue !== "settled") {
      throw new WorksetEffectProtocolError(
        "settlement-required",
        "cleanup-before-release: admission closes only after the registered process group settles",
      );
    }
    if (this.admission === null) {
      throw new WorksetEffectProtocolError(
        "admission-required",
        "closeAdmission requires a held admission",
      );
    }
    await this.admission.releaseAfterSettlement();
    this.stageValue = "admission-closed";
  }

  /**
   * Convenience path: terminate → settle → close for a given reason. Proves
   * the cleanup-before-release ordering in one call.
   */
  async finish(reason: WorksetBrokerTerminationReason): Promise<void> {
    this.beginTermination(reason);
    await this.markSettled();
    await this.closeAdmission();
  }

  private assertStage(expected: WorksetEffectBrokerStage, operation: string): void {
    if (this.stageValue !== expected) {
      throw new WorksetEffectProtocolError(
        "illegal-stage-transition",
        `${operation} requires stage ${expected}, current stage is ${this.stageValue}`,
      );
    }
  }
}

/**
 * Run one fully ordered brokered effect against a provider. `launch` runs only
 * after process-group registration is published; `settle` must terminate the
 * group before the admission closes.
 */
export async function runWorksetEffectProtocol(input: {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly kind: WorksetBrokerExternalEffectKind;
  readonly targetRef: string;
  readonly registration: WorksetBrokerProcessGroupRegistration;
  readonly launch: () => Promise<void> | void;
  readonly settle: (reason: WorksetBrokerTerminationReason) => Promise<void> | void;
  readonly reason?: WorksetBrokerTerminationReason;
}): Promise<{
  readonly admissionId: string;
  readonly epoch: number;
  readonly reason: WorksetBrokerTerminationReason;
}> {
  const session = new WorksetEffectProtocolSession({
    provider: input.provider,
    kind: input.kind,
    targetRef: input.targetRef,
  });
  await session.acquireAdmission();
  await session.registerProcessGroup(input.registration);
  await session.shareWithGuardian();
  session.releaseTarget();
  await input.launch();
  const reason = input.reason ?? "normal";
  session.beginTermination(reason);
  await input.settle(reason);
  await session.markSettled();
  await session.closeAdmission();
  const admissionId = session.admissionId;
  const epoch = session.admissionEpoch;
  if (admissionId === null || epoch === null) {
    throw new WorksetEffectProtocolError(
      "admission-required",
      "protocol completed without an admission identity",
    );
  }
  return { admissionId, epoch, reason };
}
