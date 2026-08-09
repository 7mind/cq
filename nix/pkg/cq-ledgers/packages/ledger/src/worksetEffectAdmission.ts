/**
 * T1953 — linearizable ledger and external-effect admission semantics.
 *
 * One project-wide contract with two concrete admission forms:
 *
 * 1. Ledger mutation — validates targets and epoch inside the adapter
 *    transaction / project lock and holds admission through acknowledgement.
 * 2. External effect — runs only through the host effect broker. The broker
 *    obtains a non-transferable read admission, registers the exact target
 *    process group before release, and holds admission until the group and
 *    descendants settle.
 *
 * Workset `set` obtains exclusive admission, validates the full replacement,
 * atomically commits ordered roots plus a monotonically advanced epoch, and
 * returns only after older admissions close. That commit revokes every
 * not-yet-admitted effect.
 *
 * Administrative operations (restore/reset/erase/migrate/reinitialization)
 * are exclusive administrative effects under trusted management authority:
 * they obtain the same exclusive admission as `set`, wait for every in-flight
 * ledger mutation and brokered effect (and every registered process group) to
 * settle before the destructive phase, and hold admission through completion.
 *
 * Durable backends (T1954+) and the real process-control broker (T1979)
 * implement this contract; the in-memory coordinator below is the Behavioral-
 * Active reference used by latch-driven race fixtures.
 */

// ---------------------------------------------------------------------------
// Effect-kind inventory
// ---------------------------------------------------------------------------

/** Plan-lifecycle mutations admitted as ledger mutations. */
export const WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS = [
  "claim-plan",
  "publish-plan-draft",
  "release-plan-claim",
  "finalize-plan",
] as const;

export type WorksetPlanLifecycleMutationKind =
  (typeof WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS)[number];

/** Generic and owned ledger writes. */
export const WORKSET_LEDGER_WRITE_MUTATION_KINDS = [
  "generic-write",
  "owned-write",
] as const;

export type WorksetLedgerWriteMutationKind =
  (typeof WORKSET_LEDGER_WRITE_MUTATION_KINDS)[number];

/** Every ledger-mutation effect kind. */
export const WORKSET_LEDGER_MUTATION_KINDS = [
  ...WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
  ...WORKSET_LEDGER_WRITE_MUTATION_KINDS,
] as const;

export type WorksetLedgerMutationKind =
  (typeof WORKSET_LEDGER_MUTATION_KINDS)[number];

/**
 * External effects — must run only through the host effect broker under a
 * non-transferable read admission held until process-group settlement.
 */
export const WORKSET_EXTERNAL_EFFECT_KINDS = [
  "child-dispatch",
  "worktree-create",
  "worktree-remove",
  "branch-create",
  "branch-remove",
  "rebase",
  "merge",
] as const;

export type WorksetExternalEffectKind =
  (typeof WORKSET_EXTERNAL_EFFECT_KINDS)[number];

/**
 * Administrative destructive operations — exclusive administrative effects
 * under trusted management authority (t18).
 */
export const WORKSET_ADMINISTRATIVE_EFFECT_KINDS = [
  "restore",
  "reset",
  "erase",
  "backend-migration",
  "divergence-reinitialization",
] as const;

export type WorksetAdministrativeEffectKind =
  (typeof WORKSET_ADMINISTRATIVE_EFFECT_KINDS)[number];

/** Union of every enumerated workset effect kind. */
export const WORKSET_EFFECT_KINDS = [
  ...WORKSET_LEDGER_MUTATION_KINDS,
  ...WORKSET_EXTERNAL_EFFECT_KINDS,
  ...WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
] as const;

export type WorksetEffectKind = (typeof WORKSET_EFFECT_KINDS)[number];

export type WorksetAdmissionForm =
  | "ledger-mutation"
  | "external-effect"
  | "exclusive-set"
  | "exclusive-administrative";

export const WORKSET_ADMISSION_FORMS = [
  "ledger-mutation",
  "external-effect",
  "exclusive-set",
  "exclusive-administrative",
] as const satisfies readonly WorksetAdmissionForm[];

/** Patterns the contract forbids. */
export const WORKSET_FORBIDDEN_ADMISSION_PATTERNS = [
  "prompt-only-precheck",
  "read-to-write-upgrade",
  "caller-minted-admission",
  "transfer-to-children",
  "multiple-observable-effects-under-one-admission",
] as const;

export type WorksetForbiddenAdmissionPattern =
  (typeof WORKSET_FORBIDDEN_ADMISSION_PATTERNS)[number];

/** Settlement / cleanup reasons that still require cleanup-before-release. */
export const WORKSET_EFFECT_TERMINATION_REASONS = [
  "normal",
  "cancel",
  "timeout",
  "parent-death",
  "broker-death",
] as const;

export type WorksetEffectTerminationReason =
  (typeof WORKSET_EFFECT_TERMINATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Kind → form mapping
// ---------------------------------------------------------------------------

const LEDGER_MUTATION_KIND_SET: ReadonlySet<string> = new Set(
  WORKSET_LEDGER_MUTATION_KINDS,
);
const EXTERNAL_EFFECT_KIND_SET: ReadonlySet<string> = new Set(
  WORKSET_EXTERNAL_EFFECT_KINDS,
);
const ADMINISTRATIVE_EFFECT_KIND_SET: ReadonlySet<string> = new Set(
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
);

export function admissionFormForEffectKind(
  kind: WorksetEffectKind,
): WorksetAdmissionForm {
  if (LEDGER_MUTATION_KIND_SET.has(kind)) return "ledger-mutation";
  if (EXTERNAL_EFFECT_KIND_SET.has(kind)) return "external-effect";
  if (ADMINISTRATIVE_EFFECT_KIND_SET.has(kind)) return "exclusive-administrative";
  throw new WorksetAdmissionError(
    "invalid-replacement",
    `unknown workset effect kind: ${String(kind)}`,
  );
}

// ---------------------------------------------------------------------------
// Management authority (opaque; full credential model is t18 / T1978)
// ---------------------------------------------------------------------------

/**
 * Opaque trusted management authority. Only {@link mintWorksetManagementAuthority}
 * produces a value the coordinator accepts; structural lookalikes fail. Trust is
 * membership in an unexported WeakSet — a forged plain object never qualifies.
 */
export type WorksetManagementAuthority = {
  readonly __worksetManagementAuthority: true;
};

const trustedManagementAuthorities = new WeakSet<object>();

/** Trusted host / test mint. Callers cannot forge a trusted token. */
export function mintWorksetManagementAuthority(): WorksetManagementAuthority {
  const token: WorksetManagementAuthority = {
    __worksetManagementAuthority: true,
  };
  trustedManagementAuthorities.add(token);
  return token;
}

export function isTrustedWorksetManagementAuthority(
  value: unknown,
): value is WorksetManagementAuthority {
  return typeof value === "object" && value !== null && trustedManagementAuthorities.has(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WorksetAdmissionErrorCode =
  | "revoked"
  | "stale-epoch"
  | "invalid-replacement"
  | "management-authority-required"
  | "admission-closed"
  | "admission-not-registered"
  | "process-group-not-settled"
  | "process-group-already-registered"
  | "caller-minted-admission"
  | "read-to-write-upgrade"
  | "multiple-observable-effects"
  | "transfer-forbidden"
  | "target-excluded"
  | "exclusive-busy";

export class WorksetAdmissionError extends Error {
  readonly code: WorksetAdmissionErrorCode;
  constructor(code: WorksetAdmissionErrorCode, message: string) {
    super(message);
    this.name = "WorksetAdmissionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public snapshot / handles
// ---------------------------------------------------------------------------

export interface WorksetRootsEpoch {
  readonly roots: readonly string[];
  readonly epoch: number;
}

export interface WorksetProcessGroupRegistration {
  /** Process-group id (leader pgid). */
  readonly pgid: number;
  /** Leader pid; must equal pgid for a detached group leader. */
  readonly leaderPid: number;
}

export interface WorksetLedgerMutationAdmission {
  readonly form: "ledger-mutation";
  readonly id: string;
  readonly kind: WorksetLedgerMutationKind;
  readonly epoch: number;
  readonly roots: readonly string[];
  readonly targets: readonly string[];
  /** Release admission after the mutation acknowledgement is durable. */
  acknowledge(): Promise<void>;
}

export interface WorksetExternalEffectAdmission {
  readonly form: "external-effect";
  readonly id: string;
  readonly kind: WorksetExternalEffectKind;
  readonly epoch: number;
  readonly roots: readonly string[];
  readonly targetRef: string;
  /**
   * Publish the exact target process-group registration while admission is
   * held and before the target is released to run.
   */
  registerProcessGroup(registration: WorksetProcessGroupRegistration): void;
  /** True once {@link registerProcessGroup} has succeeded. */
  readonly processGroupRegistered: boolean;
  /** Mark the registered group (and descendants) settled. */
  markSettled(): void;
  readonly settled: boolean;
  /**
   * Close admission only after registration + settlement. Enforces
   * cleanup-before-release for every termination reason.
   */
  releaseAfterSettlement(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Coordinator contract
// ---------------------------------------------------------------------------

export interface WorksetAdmissionCoordinatorHooks {
  /** Fires after exclusive lock is held and active admissions have drained. */
  readonly afterExclusiveReady?: () => Promise<void> | void;
  /** Fires immediately before a non-exclusive admission is granted. */
  readonly beforeAdmissionGrant?: () => Promise<void> | void;
  /** Fires immediately before roots/epoch commit under exclusive admission. */
  readonly beforeCommit?: () => Promise<void> | void;
  /** Fires immediately before an administrative destructive phase runs. */
  readonly beforeAdministrativeDestructive?: () => Promise<void> | void;
}

/** Process-visible admission lease published by durable backends (T1955+). */
export interface WorksetPublishedAdmissionLease {
  readonly id: string;
  readonly form: "ledger-mutation" | "external-effect";
  readonly kind: string;
  readonly epoch: number;
  readonly roots: readonly string[];
  readonly targets: readonly string[];
  readonly targetRef?: string;
}

export interface CreateInMemoryWorksetAdmissionCoordinatorOptions {
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  /**
   * Validate a complete replacement before commit. Throwing rejects the
   * replacement without mutating roots or epoch.
   */
  readonly validateReplacement?: (roots: readonly string[]) => void;
  /**
   * Decide whether a target is inside the admitted root set. Default: empty
   * roots are unrestricted; otherwise the target must equal a root or start
   * with `${root}/` or be listed verbatim.
   */
  readonly isTargetAdmitted?: (
    target: string,
    roots: readonly string[],
  ) => boolean;
  /**
   * Seed roots/epoch (default empty roots at epoch 0). Durable backends pass
   * the snapshot loaded from storage so the first in-process view matches disk.
   */
  readonly initial?: WorksetRootsEpoch;
  /**
   * Persist the prospective next complete roots/epoch pair inside the exclusive
   * section after validation and before the in-memory commit. Throwing aborts
   * without mutating memory or admitGeneration (prior state stays authoritative).
   */
  readonly persistCommit?: (next: WorksetRootsEpoch) => Promise<void> | void;
  /**
   * Reload the authoritative roots/epoch before computing the next epoch inside
   * exclusive admission. Used by durable backends so a peer's CAS advance is
   * observed before local epoch+1. Must not run while local admissions are live
   * (exclusive already drained them).
   */
  readonly reloadBeforeCommit?: () =>
    | WorksetRootsEpoch
    | Promise<WorksetRootsEpoch>;
  /**
   * Reload authoritative roots/epoch immediately before a non-exclusive grant
   * when this process holds no live admissions. Durable backends use this so a
   * peer's committed tip is visible to the next admit.
   */
  readonly reloadBeforeAdmit?: () =>
    | WorksetRootsEpoch
    | Promise<WorksetRootsEpoch>;
  /**
   * After local active admissions drain and exclusive is held — wait for peer
   * (cross-process) admissions before running the exclusive body. Durable
   * backends block set/admin on process-visible leases here. Must NOT hold a
   * mutual exclusion lock that admission publish also needs across this wait
   * (acquire that lock only once leases are observed empty, inside this hook).
   */
  readonly waitForPeerAdmissions?: () => Promise<void> | void;
  /**
   * Publish a process-visible admission lease after the in-process slot is
   * reserved. Throwing rolls back the local slot.
   */
  readonly publishAdmission?: (
    lease: WorksetPublishedAdmissionLease,
  ) => Promise<void> | void;
  /**
   * After publish, confirm the lease still matches authoritative storage (peer
   * tip unchanged). Throw {@link WorksetAdmissionError}(`revoked`) to roll back.
   */
  readonly confirmAdmission?: (
    lease: WorksetPublishedAdmissionLease,
  ) => Promise<void> | void;
  /** Retract a previously published admission lease (best-effort on close). */
  readonly retractAdmission?: (id: string) => Promise<void> | void;
  /**
   * Durable backends record process-group registration on the published lease
   * so crash reclaim can observe the group identity.
   */
  readonly noteAdmissionProcessGroup?: (
    id: string,
    registration: WorksetProcessGroupRegistration,
  ) => void;
  /** Durable backends mark the published lease settled for crash reclaim. */
  readonly noteAdmissionSettled?: (id: string) => void;
}

export interface WorksetAdmissionCoordinator {
  snapshot(): WorksetRootsEpoch;
  /**
   * Admit one ledger mutation. Validates targets against the current epoch's
   * roots and holds until {@link WorksetLedgerMutationAdmission.acknowledge}.
   */
  admitLedgerMutation(input: {
    readonly kind: WorksetLedgerMutationKind;
    readonly targets: readonly string[];
  }): Promise<WorksetLedgerMutationAdmission>;
  /**
   * Admit one external effect (broker-facing). The broker must register the
   * process group before target release and release only after settlement.
   */
  admitExternalEffect(input: {
    readonly kind: WorksetExternalEffectKind;
    readonly targetRef: string;
  }): Promise<WorksetExternalEffectAdmission>;
  /**
   * Exclusive workset replacement. Waits for older admissions, validates the
   * full batch, commits ordered roots + epoch+1, revokes not-yet-admitted
   * effects, then returns the new snapshot.
   */
  setRoots(roots: readonly string[]): Promise<WorksetRootsEpoch>;
  /**
   * Exclusive administrative effect under trusted management authority.
   * Waits for every in-flight admission (and thus every registered process
   * group) before running `destructivePhase`, and holds exclusive admission
   * through completion.
   */
  runAdministrative(input: {
    readonly kind: WorksetAdministrativeEffectKind;
    readonly authority: unknown;
    readonly destructivePhase: () => Promise<void> | void;
  }): Promise<void>;
  /** Test/observation: number of currently held admissions. */
  activeAdmissionCount(): number;
  /** Test/observation: whether exclusive admission is held. */
  exclusiveHeld(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultIsTargetAdmitted(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  for (const root of roots) {
    if (target === root) return true;
    if (target.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Canonicalize a root replacement: full replacement (not merge), drop exact
 * duplicates while preserving first-seen order. Empty list is unrestricted.
 */
export function canonicalizeWorksetRootReplacement(
  roots: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of roots) {
    if (typeof raw !== "string") {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset root replacement members must be strings",
      );
    }
    if (raw.length === 0) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        "workset root replacement rejects empty root strings",
      );
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// In-memory reference coordinator
// ---------------------------------------------------------------------------

const liveAdmissions = new WeakSet<object>();

export function isLiveWorksetAdmission(value: unknown): boolean {
  return typeof value === "object" && value !== null && liveAdmissions.has(value);
}

/** Register a coordinator-granted handle so {@link isLiveWorksetAdmission} accepts it. */
export function registerLiveWorksetAdmission(handle: object): void {
  liveAdmissions.add(handle);
}

/** Drop a handle from the live set after close/release. */
export function unregisterLiveWorksetAdmission(handle: object): void {
  liveAdmissions.delete(handle);
}

export function createInMemoryWorksetAdmissionCoordinator(
  options: CreateInMemoryWorksetAdmissionCoordinatorOptions = {},
): WorksetAdmissionCoordinator {
  const hooks = options.hooks ?? {};
  const isTargetAdmitted = options.isTargetAdmitted ?? defaultIsTargetAdmitted;
  const validateReplacement = options.validateReplacement;
  const persistCommit = options.persistCommit;
  const reloadBeforeCommit = options.reloadBeforeCommit;
  const reloadBeforeAdmit = options.reloadBeforeAdmit;
  const waitForPeerAdmissions = options.waitForPeerAdmissions;
  const publishAdmission = options.publishAdmission;
  const confirmAdmission = options.confirmAdmission;
  const retractAdmission = options.retractAdmission;
  const noteAdmissionProcessGroup = options.noteAdmissionProcessGroup;
  const noteAdmissionSettled = options.noteAdmissionSettled;

  const initial = options.initial;
  if (initial !== undefined) {
    if (!Number.isInteger(initial.epoch) || initial.epoch < 0) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `workset initial epoch must be a non-negative integer, got ${String(initial.epoch)}`,
      );
    }
  }
  let roots: string[] =
    initial !== undefined ? canonicalizeWorksetRootReplacement(initial.roots) : [];
  let epoch: number = initial !== undefined ? initial.epoch : 0;
  /** Bumped on every successful exclusive commit; revokes in-flight admits. */
  let admitGeneration = 0;

  let exclusiveHeldFlag = false;
  let exclusiveTail: Promise<void> = Promise.resolve();

  type ActiveRecord = {
    readonly id: string;
    readonly form: "ledger-mutation" | "external-effect";
    readonly closed: { promise: Promise<void>; resolve: () => void };
    processGroup: WorksetProcessGroupRegistration | null;
    settled: boolean;
  };
  const active = new Map<string, ActiveRecord>();
  let nextAdmissionId = 0;

  const waiters = new Set<() => void>();
  function notify(): void {
    for (const wake of [...waiters]) wake();
  }

  function waitUntil(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        if (!predicate()) return;
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
    });
  }

  function snapshot(): WorksetRootsEpoch {
    return { roots: roots.slice(), epoch };
  }

  function activeAdmissionCount(): number {
    return active.size;
  }

  function exclusiveHeld(): boolean {
    return exclusiveHeldFlag;
  }

  async function runExclusive<T>(body: () => Promise<T>): Promise<T> {
    const prior = exclusiveTail;
    const gate = deferred();
    exclusiveTail = gate.promise;
    await prior;
    exclusiveHeldFlag = true;
    notify();
    try {
      await waitUntil(() => active.size === 0);
      if (waitForPeerAdmissions !== undefined) {
        await waitForPeerAdmissions();
      }
      if (hooks.afterExclusiveReady !== undefined) {
        await hooks.afterExclusiveReady();
      }
      return await body();
    } finally {
      exclusiveHeldFlag = false;
      notify();
      gate.resolve();
    }
  }

  /**
   * Grant a non-exclusive admission and **synchronously** reserve a slot in
   * `active` before returning. The post-grant / pre-`active.set` window is the
   * linearizability hole that let `setRoots` commit while an admit was still
   * outside `active` (exclusive waits on `active.size === 0`). No `await` is
   * allowed between the final exclusive/generation checks and the insert.
   */
  async function beginNonExclusiveAdmit(form: ActiveRecord["form"]): Promise<{
    id: string;
    record: ActiveRecord;
    generation: number;
    epoch: number;
    roots: readonly string[];
  }> {
    // Capture once: any exclusive commit that advances generation while we wait
    // revokes this attempt (do not re-sample generation on retry loops).
    const generationAtEntry = admitGeneration;
    for (;;) {
      await waitUntil(() => !exclusiveHeldFlag);
      if (hooks.beforeAdmissionGrant !== undefined) {
        await hooks.beforeAdmissionGrant();
      }
      // Adopt authoritative storage before grant when this process is idle so a
      // peer tip is visible. Skip when local admissions already pin an epoch.
      if (reloadBeforeAdmit !== undefined && active.size === 0 && !exclusiveHeldFlag) {
        const loaded = await reloadBeforeAdmit();
        if (!Number.isInteger(loaded.epoch) || loaded.epoch < 0) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            `workset reload epoch must be a non-negative integer, got ${String(loaded.epoch)}`,
          );
        }
        // Re-check after the await: exclusive may have started.
        if (exclusiveHeldFlag) continue;
        if (admitGeneration !== generationAtEntry) {
          throw new WorksetAdmissionError(
            "revoked",
            "workset admission revoked by exclusive commit before grant",
          );
        }
        if (active.size === 0) {
          roots = canonicalizeWorksetRootReplacement(loaded.roots);
          epoch = loaded.epoch;
        }
      }
      // Atomic grant: re-check then insert with zero awaits in between.
      if (admitGeneration !== generationAtEntry) {
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      if (exclusiveHeldFlag) {
        // Exclusive took the lock after the latch; retry (generation still current).
        continue;
      }
      const id =
        form === "ledger-mutation"
          ? `lm-${++nextAdmissionId}`
          : `ee-${++nextAdmissionId}`;
      const closed = deferred();
      const record: ActiveRecord = {
        id,
        form,
        closed,
        processGroup: null,
        settled: form === "ledger-mutation",
      };
      active.set(id, record);
      notify();
      // Exclusive cannot pass active.size===0 while we hold the slot. A
      // generation bump here would mean we lost a race that should be
      // impossible under that invariant — still fail closed.
      if (admitGeneration !== generationAtEntry) {
        closeActive(id);
        throw new WorksetAdmissionError(
          "revoked",
          "workset admission revoked by exclusive commit before grant",
        );
      }
      return {
        id,
        record,
        generation: admitGeneration,
        epoch,
        roots: roots.slice(),
      };
    }
  }

  function closeActive(id: string): void {
    const record = active.get(id);
    if (record === undefined) return;
    active.delete(id);
    record.closed.resolve();
    notify();
    if (retractAdmission !== undefined) {
      // Best-effort retract; durable backends must not fail closed on release
      // after the in-process slot is already gone — surface async errors via
      // the returned promise of acknowledge/release paths that await it.
      void Promise.resolve(retractAdmission(id)).catch(() => {
        /* ignore retract races with crash reclaim */
      });
    }
  }

  async function closeActiveAndRetract(id: string): Promise<void> {
    const record = active.get(id);
    if (record === undefined) {
      if (retractAdmission !== undefined) {
        await retractAdmission(id);
      }
      return;
    }
    active.delete(id);
    record.closed.resolve();
    notify();
    if (retractAdmission !== undefined) {
      await retractAdmission(id);
    }
  }

  async function admitLedgerMutation(input: {
    readonly kind: WorksetLedgerMutationKind;
    readonly targets: readonly string[];
  }): Promise<WorksetLedgerMutationAdmission> {
    if (!(WORKSET_LEDGER_MUTATION_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown ledger mutation kind: ${String(input.kind)}`,
      );
    }
    const granted = await beginNonExclusiveAdmit("ledger-mutation");
    try {
      for (const target of input.targets) {
        if (!isTargetAdmitted(target, granted.roots)) {
          throw new WorksetAdmissionError(
            "target-excluded",
            `ledger mutation target "${target}" is outside the admitted workset`,
          );
        }
      }
      if (publishAdmission !== undefined) {
        const lease: WorksetPublishedAdmissionLease = {
          id: granted.id,
          form: "ledger-mutation",
          kind: input.kind,
          epoch: granted.epoch,
          roots: granted.roots,
          targets: input.targets.slice(),
        };
        await publishAdmission(lease);
        if (confirmAdmission !== undefined) {
          await confirmAdmission(lease);
        }
      }
    } catch (err) {
      await closeActiveAndRetract(granted.id);
      throw err;
    }
    const { id } = granted;

    let open = true;
    const handle: WorksetLedgerMutationAdmission = {
      form: "ledger-mutation",
      id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots,
      targets: input.targets.slice(),
      async acknowledge(): Promise<void> {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "ledger mutation admission already acknowledged",
          );
        }
        open = false;
        liveAdmissions.delete(handle);
        await closeActiveAndRetract(id);
      },
    };
    liveAdmissions.add(handle);
    Object.freeze(handle);
    return handle;
  }

  async function admitExternalEffect(input: {
    readonly kind: WorksetExternalEffectKind;
    readonly targetRef: string;
  }): Promise<WorksetExternalEffectAdmission> {
    if (!(WORKSET_EXTERNAL_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown external effect kind: ${String(input.kind)}`,
      );
    }
    const granted = await beginNonExclusiveAdmit("external-effect");
    try {
      if (!isTargetAdmitted(input.targetRef, granted.roots)) {
        throw new WorksetAdmissionError(
          "target-excluded",
          `external effect target "${input.targetRef}" is outside the admitted workset`,
        );
      }
      if (publishAdmission !== undefined) {
        const lease: WorksetPublishedAdmissionLease = {
          id: granted.id,
          form: "external-effect",
          kind: input.kind,
          epoch: granted.epoch,
          roots: granted.roots,
          targets: [input.targetRef],
          targetRef: input.targetRef,
        };
        await publishAdmission(lease);
        if (confirmAdmission !== undefined) {
          await confirmAdmission(lease);
        }
      }
    } catch (err) {
      await closeActiveAndRetract(granted.id);
      throw err;
    }
    const { id, record } = granted;

    let open = true;
    const handle: WorksetExternalEffectAdmission = {
      form: "external-effect",
      id,
      kind: input.kind,
      epoch: granted.epoch,
      roots: granted.roots,
      targetRef: input.targetRef,
      get processGroupRegistered(): boolean {
        return record.processGroup !== null;
      },
      get settled(): boolean {
        return record.settled;
      },
      registerProcessGroup(registration: WorksetProcessGroupRegistration): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot register a process group on a closed external-effect admission",
          );
        }
        if (record.processGroup !== null) {
          throw new WorksetAdmissionError(
            "process-group-already-registered",
            "external-effect admission already has a registered process group",
          );
        }
        if (registration.pgid !== registration.leaderPid) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            "process-group registration requires leaderPid === pgid",
          );
        }
        record.processGroup = {
          pgid: registration.pgid,
          leaderPid: registration.leaderPid,
        };
        if (noteAdmissionProcessGroup !== undefined) {
          noteAdmissionProcessGroup(id, record.processGroup);
        }
      },
      markSettled(): void {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "cannot settle a closed external-effect admission",
          );
        }
        if (record.processGroup === null) {
          throw new WorksetAdmissionError(
            "admission-not-registered",
            "cannot settle before process-group registration",
          );
        }
        record.settled = true;
        if (noteAdmissionSettled !== undefined) {
          noteAdmissionSettled(id);
        }
      },
      async releaseAfterSettlement(): Promise<void> {
        if (!open) {
          throw new WorksetAdmissionError(
            "admission-closed",
            "external-effect admission already released",
          );
        }
        if (record.processGroup === null) {
          throw new WorksetAdmissionError(
            "admission-not-registered",
            "external-effect admission requires process-group registration before release",
          );
        }
        if (!record.settled) {
          throw new WorksetAdmissionError(
            "process-group-not-settled",
            "external-effect admission requires process-group settlement before release",
          );
        }
        open = false;
        liveAdmissions.delete(handle);
        await closeActiveAndRetract(id);
      },
    };
    liveAdmissions.add(handle);
    Object.freeze(handle);
    return handle;
  }

  async function setRoots(nextRoots: readonly string[]): Promise<WorksetRootsEpoch> {
    return runExclusive(async () => {
      if (reloadBeforeCommit !== undefined) {
        const loaded = await reloadBeforeCommit();
        if (!Number.isInteger(loaded.epoch) || loaded.epoch < 0) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            `workset reload epoch must be a non-negative integer, got ${String(loaded.epoch)}`,
          );
        }
        roots = canonicalizeWorksetRootReplacement(loaded.roots);
        epoch = loaded.epoch;
      }
      const canonical = canonicalizeWorksetRootReplacement(nextRoots);
      if (validateReplacement !== undefined) {
        validateReplacement(canonical);
      }
      if (hooks.beforeCommit !== undefined) {
        await hooks.beforeCommit();
      }
      const next: WorksetRootsEpoch = { roots: canonical, epoch: epoch + 1 };
      if (persistCommit !== undefined) {
        // Durable write BEFORE memory commit. Throw leaves memory + generation
        // unchanged so the prior authoritative state survives.
        await persistCommit(next);
      }
      // Atomic commit: roots + epoch together; revoke in-flight admits.
      roots = canonical.slice();
      epoch = next.epoch;
      admitGeneration += 1;
      notify();
      return snapshot();
    });
  }

  async function runAdministrative(input: {
    readonly kind: WorksetAdministrativeEffectKind;
    readonly authority: unknown;
    readonly destructivePhase: () => Promise<void> | void;
  }): Promise<void> {
    if (!(WORKSET_ADMINISTRATIVE_EFFECT_KINDS as readonly string[]).includes(input.kind)) {
      throw new WorksetAdmissionError(
        "invalid-replacement",
        `unknown administrative effect kind: ${String(input.kind)}`,
      );
    }
    if (!isTrustedWorksetManagementAuthority(input.authority)) {
      throw new WorksetAdmissionError(
        "management-authority-required",
        `administrative effect "${input.kind}" requires trusted management authority`,
      );
    }
    await runExclusive(async () => {
      // active.size === 0 ⇒ every brokered effect settled and released.
      if (hooks.beforeAdministrativeDestructive !== undefined) {
        await hooks.beforeAdministrativeDestructive();
      }
      await input.destructivePhase();
      // Administrative destruction does not by itself advance the workset
      // epoch; lifecycle tasks (T1959/T1960) define root transitions. The
      // exclusive hold still revokes not-yet-admitted effects so none
      // interleave with the destructive phase.
      admitGeneration += 1;
      notify();
    });
  }

  return {
    snapshot,
    admitLedgerMutation,
    admitExternalEffect,
    setRoots,
    runAdministrative,
    activeAdmissionCount,
    exclusiveHeld,
  };
}

/**
 * Assert that a value is not a coordinator-granted live admission. Used by
 * tests and future surfaces to reject caller-minted lookalikes.
 */
export function assertCallerCannotMintAdmission(value: unknown): void {
  if (isLiveWorksetAdmission(value)) {
    throw new WorksetAdmissionError(
      "transfer-forbidden",
      "workset admissions are non-transferable and must not be re-supplied as caller-minted grants",
    );
  }
  // Structural lookalikes without live membership are simply not admissions.
  if (
    typeof value === "object" &&
    value !== null &&
    "form" in value &&
    ((value as { form: unknown }).form === "ledger-mutation" ||
      (value as { form: unknown }).form === "external-effect")
  ) {
    throw new WorksetAdmissionError(
      "caller-minted-admission",
      "caller-minted workset admission lookalikes are rejected",
    );
  }
}
