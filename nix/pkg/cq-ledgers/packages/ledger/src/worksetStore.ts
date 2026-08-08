/**
 * T1954 — narrow workset root/admission storage capability.
 *
 * Separate from graph derivation ({@link closeWorkset} / {@link projectWorkset}):
 * a backend stores only the epoch-tagged ordered set of canonical roots and
 * admits ledger mutations plus broker-owned external effects under the t3
 * linearization contract ({@link WorksetAdmissionCoordinator}).
 *
 * Durable state is roots + epoch only. `set([])` is the sole unrestricted
 * configuration. A complete replacement is resolved and validated before
 * commit; one invalid member leaves roots and epoch unchanged.
 *
 * Backend legs (T1955+) implement {@link WorksetStore}. The in-memory dummy
 * below is the Behavioral-Active Blackbox reference the shared contract always
 * runs against.
 */

import {
  createInMemoryWorksetAdmissionCoordinator,
  type CreateInMemoryWorksetAdmissionCoordinatorOptions,
  type WorksetAdministrativeEffectKind,
  type WorksetAdmissionCoordinator,
  type WorksetAdmissionCoordinatorHooks,
  type WorksetExternalEffectAdmission,
  type WorksetExternalEffectKind,
  type WorksetLedgerMutationAdmission,
  type WorksetLedgerMutationKind,
  type WorksetRootsEpoch,
} from "./worksetEffectAdmission.js";

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/**
 * Narrow typed storage capability for workset roots and effect admissions.
 *
 * `snapshot` may be sync or async so durable backends can reload under a lock
 * without forcing every caller through a separate refresh step. Observers must
 * treat the returned value as one complete roots/epoch pair — never a torn
 * half-write.
 */
export interface WorksetStore {
  snapshot(): WorksetRootsEpoch | Promise<WorksetRootsEpoch>;
  /**
   * Exclusive full replacement. Canonicalizes (ordered, de-duplicated),
   * validates the complete batch, then commits roots and epoch+1 together.
   */
  setRoots(roots: readonly string[]): Promise<WorksetRootsEpoch>;
  /**
   * Transactional ledger-mutation admission held through acknowledgement.
   */
  admitLedgerMutation(input: {
    readonly kind: WorksetLedgerMutationKind;
    readonly targets: readonly string[];
  }): Promise<WorksetLedgerMutationAdmission>;
  /**
   * Broker-owned external-effect admission. One admission admits exactly one
   * observable effect; the broker registers the process group and releases
   * only after settlement.
   */
  admitExternalEffect(input: {
    readonly kind: WorksetExternalEffectKind;
    readonly targetRef: string;
  }): Promise<WorksetExternalEffectAdmission>;
  /**
   * Exclusive administrative effect under trusted management authority.
   */
  runAdministrative(input: {
    readonly kind: WorksetAdministrativeEffectKind;
    readonly authority: unknown;
    readonly destructivePhase: () => Promise<void> | void;
  }): Promise<void>;
  /** Observation: currently held (not-yet-closed) admissions. */
  activeAdmissionCount(): number;
  /** Observation: exclusive set/admin admission held. */
  exclusiveHeld(): boolean;
}

export interface CreateInMemoryWorksetStoreOptions {
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  /**
   * Validate a complete canonical replacement before commit. Throwing rejects
   * the batch without mutating roots or epoch. Graph/active-state checks belong
   * here (or in a higher layer that supplies this hook) — not inside the store.
   */
  readonly validateReplacement?: (roots: readonly string[]) => void;
  /**
   * Decide whether a target is inside the admitted root set. Default: empty
   * roots are unrestricted; otherwise the target must equal a root or start
   * with `${root}/`.
   */
  readonly isTargetAdmitted?: (
    target: string,
    roots: readonly string[],
  ) => boolean;
}

/**
 * Await a complete roots/epoch pair from any store. Contract tests and
 * callers that must not observe torn state use this helper exclusively.
 */
export async function readWorksetRootsEpoch(
  store: WorksetStore,
): Promise<WorksetRootsEpoch> {
  return await store.snapshot();
}

/**
 * Strict hand-written in-memory dummy. Holds roots and epoch in process
 * memory only; admissions are runtime leases (not durable rows). Race and
 * linearization semantics are those of
 * {@link createInMemoryWorksetAdmissionCoordinator}.
 */
export function createInMemoryWorksetStore(
  options: CreateInMemoryWorksetStoreOptions = {},
): WorksetStore {
  const coordinatorOptions: CreateInMemoryWorksetAdmissionCoordinatorOptions = {
    hooks: options.hooks,
    validateReplacement: options.validateReplacement,
    isTargetAdmitted: options.isTargetAdmitted,
  };
  const coordinator: WorksetAdmissionCoordinator =
    createInMemoryWorksetAdmissionCoordinator(coordinatorOptions);
  // Structural: coordinator is a WorksetStore (sync snapshot ⊆ union).
  return coordinator;
}

/**
 * Type predicate: every {@link WorksetAdmissionCoordinator} is a
 * {@link WorksetStore}. Useful when a host already holds a coordinator.
 */
export function worksetStoreFromCoordinator(
  coordinator: WorksetAdmissionCoordinator,
): WorksetStore {
  return coordinator;
}
