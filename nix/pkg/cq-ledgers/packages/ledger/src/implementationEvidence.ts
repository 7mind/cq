import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  implementReviewerSidecar,
  implementationAuditorSidecar,
  implementWorkerSupervisedGateEvidenceSchema,
  validateAgainstSchema,
  validateParentGateAttestation,
  validateSupervisedWorkerGateEvidenceForReview,
  type DispatchHandle,
  type DispatchJSONValue,
  type DispatchPrepared,
  type ImplementWorkerSupervisedGateEvidence,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
  type ParentGateAttestation,
} from "@cq/config";
import type {
  MergeEffectBinding,
  WorksetEffectAdmissionProvider,
  WorksetBrokerAdmissionHandle,
} from "@cq/process-control";
import { Lockfile, type LockfileOpts } from "./store/lockfile.js";
import { REVIEWS_LEDGER, TASKS_LEDGER } from "./constants.js";
import type { CreateItemInit, LedgerStore, UpdateItemPatch } from "./store/LedgerStore.js";
import type { WorksetGenericMutationTx } from "./store/genericMutationTransaction.js";
import type { WorksetRootsEpoch } from "./worksetEffectAdmission.js";
import type { WorksetOwnedWriteTx } from "./worksetOwnedLifecycle.js";
import { ItemNotFoundError, LedgerError } from "./types.js";

export const IMPLEMENTATION_EVIDENCE_VERSION = 1 as const;
export const IMPLEMENTATION_EVIDENCE_SERVICE_PROTOCOL_VERSION = 2 as const;

export const IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY = [
  "prepare_implementation_review_panel",
  "prepare_implementation_review_attempt",
  "execute_external_implementation_review_attempt",
  "finalize_implementation_review_attempt",
  "prepare_implementation_review_fallback",
  "prepare_implementation_audit_panel",
  "prepare_implementation_audit_attempt",
  "execute_external_implementation_audit_attempt",
  "finalize_implementation_audit_attempt",
  "prepare_implementation_audit_fallback",
  "advance_implementation_evidence_bootstrap",
  "arm_implementation_evidence_activation",
  "apply_implementation_audit_manifest",
  "get_implementation_evidence_activation_status",
  "continue_implementation_evidence_activation",
  "get_implementation_evidence_service_status",
  "prepare_implementation_completion",
  "record_implementation_completion",
] as const;

export const FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT = {
  version: 1 as const,
  outcomeKinds: ["verdict", "operational-abstention"] as const,
  verdictSchema: "implement-reviewer-output" as const,
  maxOutcomesPerFinalization: 1 as const,
};

const FULL_SHA = /^[0-9a-f]{40}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TASK_REF = /^tasks:(T[0-9]+)$/u;
const COMPLETION_REF = /^cq-implementation-completion:v1:[0-9a-f]{64}$/u;
const PANEL_REF = /^cq-implementation-review-panel:v1:[0-9a-f]{64}$/u;
const ATTEMPT_REF = /^cq-implementation-review-attempt:v1:[0-9a-f]{64}$/u;
const AUDIT_PANEL_REF = /^cq-implementation-audit-panel:v1:[0-9a-f]{64}$/u;
const AUDIT_ATTEMPT_REF = /^cq-implementation-audit-attempt:v1:[0-9a-f]{64}$/u;
const BOOTSTRAP_REF = /^cq-implementation-evidence-bootstrap:v1:[0-9a-f]{64}$/u;
const ACTIVATION_REQUIREMENT_REF =
  /^cq-implementation-evidence-activation-requirement:v1:[0-9a-f]{64}$/u;
const ACTIVATION_REF = /^cq-implementation-evidence-activation:v1:[0-9a-f]{64}$/u;
const ACTIVATION_CONTINUATION_REF =
  /^cq-implementation-evidence-activation-continuation:v1:[0-9a-f]{64}$/u;

export const IMPLEMENTATION_EVIDENCE_ACTIVATION_MANIFEST_V2 =
  "d347-implementation-evidence-activation-v2" as const;

export type ImplementationReviewTerminalState =
  "approved" | "disapproved" | "operational-abstention";

export interface ImplementationReviewerIdentity {
  readonly alias: string;
  readonly harness: string;
  readonly model: string;
  readonly provider: string | null;
  readonly effort?: string | null;
  readonly launch: "native" | "adapter";
  readonly adapterId: string;
}

export interface ImplementationReviewPanelRecord {
  readonly version: 1;
  readonly panelRef: string;
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly rosterDigest: string;
  readonly roster: readonly ImplementationReviewerIdentity[];
  readonly attemptRefs: readonly string[];
  readonly fallbackAttemptRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export interface ExternalImplementationReviewExecution {
  readonly executionRef: string;
  readonly adapterIdentity: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly parseResult:
    | { readonly kind: "valid-verdict"; readonly verdict: DispatchJSONValue }
    | {
        readonly kind: "operational-abstention";
        readonly reason: "unavailable" | "failed" | "empty" | "malformed";
        readonly detail: string;
      };
  readonly executedAt: string;
}

export interface ImplementationReviewAttemptRecord {
  readonly version: 1;
  readonly attemptRef: string;
  readonly panelRef: string;
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly position: number;
  readonly identity: ImplementationReviewerIdentity;
  readonly fallback: boolean;
  readonly fallbackTrigger: string | null;
  readonly fallbackExclusions: readonly string[];
  readonly preparedDispatch: DispatchPrepared | null;
  /** Attestation retained when the bound native dispatch reached a consumed terminal result. */
  readonly retainedAttestation?: string | null;
  /** Durable pre-shellout claim: a crash may abstain but must never relaunch the adapter. */
  readonly executionReservation?: {
    readonly executionRef: string;
    readonly operationId: string;
    readonly requestDigest: string;
    readonly reservedAt: string;
    readonly expiresAt: string;
  } | null;
  readonly execution: ExternalImplementationReviewExecution | null;
  readonly terminalState: ImplementationReviewTerminalState | null;
  readonly verdictDigest: string | null;
  readonly verdict: DispatchJSONValue | null;
  readonly operations: Readonly<Record<string, string>>;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export type ImplementationCompletionState =
  "prepared" | "merge-started" | "merged" | "recording" | "superseded" | "recorded";

export interface ImplementationCompletionRecord {
  readonly version: 1;
  readonly completionRef: string;
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly resultCommit: string;
  readonly repositoryHead: string;
  readonly baseCommit: string;
  readonly startingCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly workerResult: DispatchJSONValue;
  readonly reviewAttemptRefs: readonly string[];
  readonly completion: string;
  readonly logPaths: readonly string[];
  readonly finalizedManifest: string;
  readonly verification: DispatchJSONValue;
  readonly mergeOperationId: string;
  readonly evidenceFingerprint: string;
  readonly supersedesCompletionRef: string | null;
  readonly state: ImplementationCompletionState;
  readonly reviewRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly preparedAt: string;
  readonly mergeStartedAt: string | null;
  readonly mergedAt: string | null;
  readonly recordedAt: string | null;
  readonly recordOperationId: string | null;
}

export interface PackagedImplementationAuditRecord {
  readonly recordKey: string;
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly finalizedManifest: string;
  readonly historicalReview: DispatchJSONValue | null;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly repositoryHead: string;
  readonly diff: string;
  readonly acceptance: DispatchJSONValue;
  readonly gateObservations: DispatchJSONValue;
  readonly requiredObservations: readonly string[];
}

export interface PackagedImplementationEvidenceActivation {
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly evidenceTaskKey: "t-evidence";
  readonly auditTaskKey: "t-historical-evidence";
  readonly activationTaskKey: "t-activate-evidence";
}

export interface PackagedImplementationAuditManifest {
  readonly version: 1;
  readonly manifestId: string;
  readonly sourceDigest: string;
  readonly records: readonly PackagedImplementationAuditRecord[];
  readonly activation: PackagedImplementationEvidenceActivation | null;
  readonly nonAuthorizingProvenance?: readonly {
    readonly taskRef: string;
    readonly requiredAncestorCommit: string;
    readonly historicalReview: DispatchJSONValue;
    readonly authorizes: false;
  }[];
}

export interface ImplementationAuditPanelRecord {
  readonly version: 1;
  readonly panelRef: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly recordKey: string;
  readonly taskRef: string;
  readonly repositoryHead: string;
  readonly rosterDigest: string;
  readonly roster: readonly ImplementationReviewerIdentity[];
  readonly attemptRefs: readonly string[];
  readonly fallbackAttemptRef: string | null;
  readonly auditInput: DispatchJSONValue;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export interface ExternalImplementationAuditExecution {
  readonly executionRef: string;
  readonly adapterIdentity: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly parseResult:
    | { readonly kind: "valid-verdict"; readonly verdict: DispatchJSONValue }
    | {
        readonly kind: "operational-abstention";
        readonly reason: "unavailable" | "failed" | "empty" | "malformed";
        readonly detail: string;
      };
  readonly executedAt: string;
}

export interface ImplementationAuditAttemptRecord {
  readonly version: 1;
  readonly attemptRef: string;
  readonly panelRef: string;
  readonly taskRef: string;
  readonly position: number;
  readonly identity: ImplementationReviewerIdentity;
  readonly fallback: boolean;
  readonly fallbackTrigger: string | null;
  readonly fallbackExclusions: readonly string[];
  readonly preparedDispatch: DispatchPrepared | null;
  readonly retainedAttestation: string | null;
  readonly executionReservation: {
    readonly executionRef: string;
    readonly operationId: string;
    readonly requestDigest: string;
    readonly reservedAt: string;
    readonly expiresAt: string;
  } | null;
  readonly execution: ExternalImplementationAuditExecution | null;
  readonly terminalState: ImplementationReviewTerminalState | null;
  readonly verdictDigest: string | null;
  readonly verdict: DispatchJSONValue | null;
  readonly operations: Readonly<Record<string, string>>;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export interface ImplementationAuditRecord {
  readonly version: 1;
  readonly auditRef: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly recordKey: string;
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly finalizedManifest: string;
  readonly historicalReview: DispatchJSONValue | null;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly repositoryHead: string;
  readonly sourceDigest: string;
  readonly evidenceFingerprint: string;
  readonly attemptRefs: readonly string[];
  readonly terminalState: ImplementationReviewTerminalState;
  readonly author: string;
  readonly session: string | null;
  readonly appliedAt: string;
}

export interface ImplementationEvidenceActivationRequirementRecord {
  readonly version: 1;
  readonly requirementRef: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly semanticManifestDigest: string;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly evidenceTaskRef: string;
  readonly auditTaskRef: string;
  readonly activationTaskRef: string;
  readonly boundaryCommit: string;
  readonly taskRefs: readonly string[];
  readonly state: "armed" | "fulfilled" | "superseded";
  readonly activationRef: string | null;
  readonly supersededRequirementRef?: string | null;
  readonly supersededByRequirementRef?: string | null;
  readonly supersededAt?: string | null;
  readonly previousRequirementRef: string | null;
  readonly continuationRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly armedAt: string;
  readonly fulfilledAt: string | null;
}

export interface ImplementationEvidenceActivationRecord {
  readonly version: 1;
  readonly activationRef: string;
  readonly requirementRef: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly repositoryHead: string;
  readonly evidenceFingerprint: string;
  readonly auditRefs: readonly string[];
  readonly taskRefs: readonly string[];
  readonly author: string;
  readonly session: string | null;
  readonly activatedAt: string;
}

export interface ImplementationEvidenceActivationContinuationRecord {
  readonly version: 1;
  readonly continuationRef: string;
  readonly previousContinuationRef: string | null;
  readonly previousRequirementRef: string;
  readonly requirementRef: string;
  readonly activationRef: string;
  readonly taskRef: string;
  readonly completionRef: string;
  readonly fromHead: string;
  readonly repositoryHead: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly continuedAt: string;
}

export type ImplementationEvidenceBootstrapPhase = "historical-dispatch" | "activation-handoff";

export interface ImplementationEvidenceBootstrapTaskAuthority {
  readonly taskRef: string;
  readonly status: string;
  readonly resultCommit: string | null;
  readonly ready: boolean;
  readonly actionKey?: string | null;
}

export interface ImplementationEvidenceBootstrapAuthority {
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly mappings: {
    readonly evidenceTaskRef: string;
    readonly historicalTaskRef: string;
    readonly activationTaskRef: string;
  };
  readonly evidenceTask: ImplementationEvidenceBootstrapTaskAuthority;
  readonly historicalTask: ImplementationEvidenceBootstrapTaskAuthority;
  readonly activationTask: ImplementationEvidenceBootstrapTaskAuthority;
}

export interface ImplementationEvidenceBootstrapRecord {
  readonly version: 1;
  readonly bootstrapRef: string;
  readonly phase: ImplementationEvidenceBootstrapPhase;
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly repositoryHead: string;
  readonly evidenceTaskRef: string;
  readonly historicalTaskRef: string;
  readonly activationTaskRef: string;
  readonly evidenceResultCommit: string;
  readonly historicalResultCommit: string | null;
  readonly expectedServiceCommit: string;
  readonly taskRefs: readonly string[];
  readonly actionRef: string | null;
  readonly handoffRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export interface ImplementationAuditManifestApplicationRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly repositoryHead: string;
  readonly activation: "none" | "activated" | "existing";
  readonly requirementRef: string | null;
  readonly evidenceFingerprint: string;
  readonly auditRefs: readonly string[];
  readonly taskRefs: readonly string[];
  readonly author: string;
  readonly session: string | null;
  readonly appliedAt: string;
}

export interface ImplementationEvidenceSnapshot {
  readonly version: 1;
  readonly panels: Readonly<Record<string, ImplementationReviewPanelRecord>>;
  readonly attempts: Readonly<Record<string, ImplementationReviewAttemptRecord>>;
  readonly completions: Readonly<Record<string, ImplementationCompletionRecord>>;
  readonly auditPanels: Readonly<Record<string, ImplementationAuditPanelRecord>>;
  readonly auditAttempts: Readonly<Record<string, ImplementationAuditAttemptRecord>>;
  readonly implementationAudits: Readonly<Record<string, ImplementationAuditRecord>>;
  readonly auditManifestApplications: Readonly<
    Record<string, ImplementationAuditManifestApplicationRecord>
  >;
  readonly activationRequirements: Readonly<
    Record<string, ImplementationEvidenceActivationRequirementRecord>
  >;
  readonly activations: Readonly<Record<string, ImplementationEvidenceActivationRecord>>;
  readonly activationContinuations: Readonly<
    Record<string, ImplementationEvidenceActivationContinuationRecord>
  >;
  readonly bootstraps: Readonly<Record<string, ImplementationEvidenceBootstrapRecord>>;
}

interface MutableImplementationEvidenceSnapshot {
  version: 1;
  panels: Record<string, ImplementationReviewPanelRecord>;
  attempts: Record<string, ImplementationReviewAttemptRecord>;
  completions: Record<string, ImplementationCompletionRecord>;
  auditPanels: Record<string, ImplementationAuditPanelRecord>;
  auditAttempts: Record<string, ImplementationAuditAttemptRecord>;
  implementationAudits: Record<string, ImplementationAuditRecord>;
  auditManifestApplications: Record<string, ImplementationAuditManifestApplicationRecord>;
  activationRequirements: Record<string, ImplementationEvidenceActivationRequirementRecord>;
  activations: Record<string, ImplementationEvidenceActivationRecord>;
  activationContinuations: Record<string, ImplementationEvidenceActivationContinuationRecord>;
  bootstraps: Record<string, ImplementationEvidenceBootstrapRecord>;
}

const mutateEvidence = Symbol("cq.implementation-evidence.mutate");
const authorizedImplementationEvidenceMutations = new WeakSet<object>();

/** Internal predicate consumed by core's generic-write denial. */
export function isAuthorizedImplementationEvidenceMutation(value: object): boolean {
  return authorizedImplementationEvidenceMutations.has(value);
}

/** Protected store: callers can observe snapshots but cannot obtain a generic write method. */
export interface ImplementationEvidenceStore {
  snapshot(): Promise<ImplementationEvidenceSnapshot>;
  [mutateEvidence]<T>(
    mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
  ): Promise<T>;
}

type AtomicGenericLedgerStore = LedgerStore & {
  runAtomicGenericMutation<T>(
    mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
    readRoots?: () => Promise<WorksetRootsEpoch>,
  ): Promise<T>;
};

function implementationTaskIsActivated(
  snapshot: ImplementationEvidenceSnapshot,
  taskRef: string,
): boolean {
  return (
    Object.values(snapshot.panels).some((panel) => panel.taskRef === taskRef) ||
    Object.values(snapshot.completions).some((completion) => completion.taskRef === taskRef) ||
    Object.values(snapshot.auditPanels).some((panel) => panel.taskRef === taskRef) ||
    Object.values(snapshot.implementationAudits).some((audit) => audit.taskRef === taskRef) ||
    Object.values(snapshot.activationRequirements).some((requirement) =>
      requirement.taskRefs.includes(taskRef),
    ) ||
    Object.values(snapshot.bootstraps).some(
      (bootstrap) =>
        bootstrap.phase === "historical-dispatch" &&
        bootstrap.historicalTaskRef === taskRef &&
        bootstrap.taskRefs.length === 1 &&
        bootstrap.taskRefs[0] === taskRef,
    )
  );
}

function assertGenericImplementationTaskMutationAllowed(
  snapshot: ImplementationEvidenceSnapshot,
  item: ReturnType<LedgerStore["fetchItem"]>,
  patch: UpdateItemPatch,
): void {
  if (isAuthorizedImplementationEvidenceMutation(patch)) return;
  const taskRef = `${TASKS_LEDGER}:${item.id}`;
  if (!implementationTaskIsActivated(snapshot, taskRef)) return;
  if (
    patch.status === "done" ||
    patch.status === "abandoned" ||
    (item.status === "done" && typeof item.fields["resultCommit"] === "string")
  ) {
    throw new LedgerError(
      `Git-producing task ${taskRef} may mutate only through protected implementation evidence`,
    );
  }
}

/**
 * Bind protected activation authority to the generic store write boundary.
 * Legacy tasks remain writable until a review panel, bootstrap admission, or
 * completion journal activates the task; protected completion uses the
 * separate authorized atomic-owned mutation path.
 */
export function protectLedgerStoreWithImplementationEvidence(
  store: LedgerStore,
  evidenceStore: ImplementationEvidenceStore,
): LedgerStore {
  const candidate = store as AtomicGenericLedgerStore;
  const rawAtomicGenericMutation = Reflect.get(candidate, "runAtomicGenericMutation") as
    AtomicGenericLedgerStore["runAtomicGenericMutation"] | undefined;

  return new Proxy(candidate, {
    get(target, property) {
      if (property === "updateItem") {
        return async (ledgerId: string, itemId: string, patch: UpdateItemPatch) => {
          if (ledgerId === TASKS_LEDGER) {
            const snapshot = await evidenceStore.snapshot();
            assertGenericImplementationTaskMutationAllowed(
              snapshot,
              target.fetchItem(ledgerId, itemId),
              patch,
            );
          }
          return await target.updateItem(ledgerId, itemId, patch);
        };
      }
      if (property === "runAtomicGenericMutation" && rawAtomicGenericMutation !== undefined) {
        return async <T>(
          mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
          readRoots?: () => Promise<WorksetRootsEpoch>,
        ): Promise<T> => {
          const snapshot = await evidenceStore.snapshot();
          return (await rawAtomicGenericMutation.call(
            target,
            (tx, roots) =>
              mutate(
                {
                  ...tx,
                  updateItem: (ledgerId, itemId, patch) => {
                    if (ledgerId === TASKS_LEDGER) {
                      assertGenericImplementationTaskMutationAllowed(
                        snapshot,
                        tx.fetchItem(ledgerId, itemId),
                        patch,
                      );
                    }
                    return tx.updateItem(ledgerId, itemId, patch);
                  },
                },
                roots,
              ),
            readRoots,
          )) as T;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function emptyState(): MutableImplementationEvidenceSnapshot {
  return {
    version: IMPLEMENTATION_EVIDENCE_VERSION,
    panels: {},
    attempts: {},
    completions: {},
    auditPanels: {},
    auditAttempts: {},
    implementationAudits: {},
    auditManifestApplications: {},
    activationRequirements: {},
    activations: {},
    activationContinuations: {},
    bootstraps: {},
  };
}

function cloneState(state: ImplementationEvidenceSnapshot): MutableImplementationEvidenceSnapshot {
  return structuredClone(state) as MutableImplementationEvidenceSnapshot;
}

class SerialBoundary {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Strict hand-written dummy used by the shared evidence-store contract. */
export function createInMemoryImplementationEvidenceStore(
  initial: ImplementationEvidenceSnapshot = emptyState(),
): ImplementationEvidenceStore {
  let state = cloneState(initial);
  const boundary = new SerialBoundary();
  return {
    async snapshot() {
      return cloneState(state);
    },
    async [mutateEvidence]<T>(
      mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
    ): Promise<T> {
      return await boundary.run(async () => {
        const draft = cloneState(state);
        const result = await mutation(draft);
        state = draft;
        return result;
      });
    },
  };
}

function parseStoredState(value: unknown): MutableImplementationEvidenceSnapshot {
  if (!object(value)) throw new Error("implementation evidence store root must be an object");
  if (
    value["version"] !== 1 ||
    !object(value["panels"]) ||
    !object(value["attempts"]) ||
    !object(value["completions"]) ||
    (value["auditPanels"] !== undefined && !object(value["auditPanels"])) ||
    (value["auditAttempts"] !== undefined && !object(value["auditAttempts"])) ||
    (value["implementationAudits"] !== undefined && !object(value["implementationAudits"])) ||
    (value["auditManifestApplications"] !== undefined &&
      !object(value["auditManifestApplications"])) ||
    (value["activationRequirements"] !== undefined && !object(value["activationRequirements"])) ||
    (value["activations"] !== undefined && !object(value["activations"])) ||
    (value["activationContinuations"] !== undefined && !object(value["activationContinuations"])) ||
    (value["bootstraps"] !== undefined && !object(value["bootstraps"]))
  ) {
    throw new Error("implementation evidence store has an unsupported or malformed version");
  }
  const stored = structuredClone(
    value,
  ) as unknown as Partial<MutableImplementationEvidenceSnapshot>;
  return {
    version: 1,
    panels: stored.panels ?? {},
    attempts: stored.attempts ?? {},
    completions: stored.completions ?? {},
    auditPanels: stored.auditPanels ?? {},
    auditAttempts: stored.auditAttempts ?? {},
    implementationAudits: stored.implementationAudits ?? {},
    auditManifestApplications: stored.auditManifestApplications ?? {},
    activationRequirements: stored.activationRequirements ?? {},
    activations: stored.activations ?? {},
    activationContinuations: stored.activationContinuations ?? {},
    bootstraps: stored.bootstraps ?? {},
  };
}

export interface CreateFsImplementationEvidenceStoreOptions {
  readonly path: string;
  readonly lockfile?: LockfileOpts;
}

interface ImplementationEvidenceJournalPayload {
  readonly kind: "cq-implementation-evidence-journal-entry";
  readonly version: 1;
  readonly sequence: number;
  readonly priorDigest: string | null;
  readonly snapshot: MutableImplementationEvidenceSnapshot;
}

interface ImplementationEvidenceJournalEntry extends ImplementationEvidenceJournalPayload {
  readonly digest: string;
}

interface ImplementationEvidenceJournalTip {
  readonly state: MutableImplementationEvidenceSnapshot;
  readonly sequence: number;
  readonly digest: string | null;
}

const IMPLEMENTATION_EVIDENCE_JOURNAL_ENTRY = /^([0-9]{16})-([0-9a-f]{64})\.json$/u;

function parseJournalEntry(value: unknown, filename: string): ImplementationEvidenceJournalEntry {
  if (
    !object(value) ||
    !exactKeys(value, ["kind", "version", "sequence", "priorDigest", "snapshot", "digest"]) ||
    value["kind"] !== "cq-implementation-evidence-journal-entry" ||
    value["version"] !== 1 ||
    typeof value["sequence"] !== "number" ||
    !Number.isSafeInteger(value["sequence"]) ||
    (typeof value["priorDigest"] !== "string" && value["priorDigest"] !== null) ||
    typeof value["digest"] !== "string"
  ) {
    throw new Error(`implementation evidence journal entry ${filename} is malformed`);
  }
  const rawPayload = {
    kind: "cq-implementation-evidence-journal-entry" as const,
    version: 1 as const,
    sequence: value["sequence"] as number,
    priorDigest: value["priorDigest"] as string | null,
    snapshot: value["snapshot"],
  };
  const expectedDigest = digest(rawPayload);
  if (value["digest"] !== expectedDigest) {
    throw new Error(`implementation evidence journal entry ${filename} failed authentication`);
  }
  const payload: ImplementationEvidenceJournalPayload = {
    ...rawPayload,
    snapshot: parseStoredState(value["snapshot"]),
  };
  return { ...payload, digest: expectedDigest };
}

/** Protected append-only journal adapter; generic ledger fields cannot reach its entries. */
export function createFsImplementationEvidenceStore(
  options: CreateFsImplementationEvidenceStoreOptions,
): ImplementationEvidenceStore {
  const boundary = new SerialBoundary();
  const lockfile = new Lockfile(options.lockfile);
  const parent = dirname(options.path);
  const locks = join(parent, ".locks");
  const read = async (): Promise<ImplementationEvidenceJournalTip> => {
    let names: string[];
    try {
      names = await fs.readdir(options.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: emptyState(), sequence: 0, digest: null };
      }
      throw error;
    }
    const unexpected = names.filter(
      (name) => !IMPLEMENTATION_EVIDENCE_JOURNAL_ENTRY.test(name) && !name.startsWith(".tmp-"),
    );
    if (unexpected.length !== 0) {
      throw new Error(
        `implementation evidence journal contains unexpected entries: ${unexpected.join(", ")}`,
      );
    }
    const entries = names.filter((name) => IMPLEMENTATION_EVIDENCE_JOURNAL_ENTRY.test(name)).sort();
    let sequence = 0;
    let priorDigest: string | null = null;
    let state = emptyState();
    for (const filename of entries) {
      const match = IMPLEMENTATION_EVIDENCE_JOURNAL_ENTRY.exec(filename);
      if (match === null)
        throw new Error(`implementation evidence journal entry ${filename} is malformed`);
      const entry = parseJournalEntry(
        JSON.parse(await fs.readFile(join(options.path, filename), "utf8")),
        filename,
      );
      const expectedSequence = sequence + 1;
      if (
        entry.sequence !== expectedSequence ||
        Number(match[1]) !== expectedSequence ||
        match[2] !== entry.digest ||
        entry.priorDigest !== priorDigest
      ) {
        throw new Error(`implementation evidence journal entry ${filename} breaks the hash chain`);
      }
      sequence = entry.sequence;
      priorDigest = entry.digest;
      state = entry.snapshot;
    }
    return { state, sequence, digest: priorDigest };
  };
  const append = async (
    state: MutableImplementationEvidenceSnapshot,
    prior: ImplementationEvidenceJournalTip,
  ): Promise<void> => {
    await fs.mkdir(options.path, { recursive: true });
    const payload: ImplementationEvidenceJournalPayload = {
      kind: "cq-implementation-evidence-journal-entry",
      version: 1,
      sequence: prior.sequence + 1,
      priorDigest: prior.digest,
      snapshot: state,
    };
    const entry: ImplementationEvidenceJournalEntry = { ...payload, digest: digest(payload) };
    const filename = `${String(entry.sequence).padStart(16, "0")}-${entry.digest}.json`;
    const temporary = join(options.path, `.tmp-${process.pid}-${randomUUID()}`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, join(options.path, filename));
    const directory = await fs.open(options.path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  return {
    async snapshot() {
      return cloneState((await read()).state);
    },
    async [mutateEvidence]<T>(
      mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
    ): Promise<T> {
      return await boundary.run(async () => {
        const release = await lockfile.acquire(locks, "implementation-evidence");
        try {
          const prior = await read();
          const draft = cloneState(prior.state);
          const result = await mutation(draft);
          await append(draft, prior);
          return result;
        } finally {
          await release();
        }
      });
    },
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("implementation evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("implementation evidence contains a non-JSON value");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function opaqueRef(prefix: string, value: unknown): string {
  return `${prefix}:v1:${digest(value)}`;
}

function assertOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new Error("operation_id must be one stable operation id");
}

function taskIdFromRef(taskRef: string): string {
  const match = TASK_REF.exec(taskRef);
  if (match?.[1] === undefined) throw new Error("task_ref must be one canonical task ref");
  return match[1];
}

function assertFullSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be one full lowercase commit SHA`);
}

function handleOf(dispatch: DispatchPrepared): DispatchHandle {
  return { attestationId: dispatch.attestationId, generation: dispatch.generation };
}

function sameHandle(left: DispatchHandle, right: DispatchHandle): boolean {
  return left.attestationId === right.attestationId && left.generation === right.generation;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = [...allowed].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ReviewerValidationContext {
  readonly baseCommit: string | null;
  readonly trustedGate: boolean;
}

function reviewerValidationContext(
  worker: ImplementationWorkerObservation,
  reviewerInput?: DispatchJSONValue,
): ReviewerValidationContext {
  const workerInput = object(worker.input) ? worker.input : {};
  const workerOutput = object(worker.output) ? worker.output : {};
  const baseCommit =
    typeof workerInput["baseCommit"] === "string" && FULL_SHA.test(workerInput["baseCommit"])
      ? workerInput["baseCommit"]
      : null;
  const branch = workerOutput["branch"];
  const worktreePath = workerOutput["actualWorktreePath"];
  const supervisedGate = workerOutput["supervisedGateEvidence"];
  const trustedSupervisedGate =
    typeof branch === "string" &&
    typeof worktreePath === "string" &&
    object(supervisedGate) &&
    typeof workerOutput["resultCommit"] === "string" &&
    validateSupervisedWorkerGateEvidenceForReview(
      supervisedGate as unknown as ImplementWorkerSupervisedGateEvidence,
      {
        taskId: typeof workerInput["taskId"] === "string" ? workerInput["taskId"] : "",
        resultCommit: workerOutput["resultCommit"],
        branch,
        worktreePath,
      },
    );
  const parentGate = object(reviewerInput) ? reviewerInput["parentGateAttestation"] : undefined;
  const trustedParentGate =
    object(parentGate) &&
    typeof workerOutput["resultCommit"] === "string" &&
    validateParentGateAttestation(
      parentGate as unknown as ParentGateAttestation,
      workerOutput["resultCommit"],
    );
  return { baseCommit, trustedGate: trustedSupervisedGate || trustedParentGate };
}

function validateReviewerVerdict(
  value: unknown,
  expectedTaskId: string,
  expectedResultCommit: string,
  context: ReviewerValidationContext,
): value is DispatchJSONValue {
  if (!object(value)) return false;
  if (!validateAgainstSchema(implementReviewerSidecar.outputSchema, value).ok) return false;
  if (value["taskId"] !== expectedTaskId) return false;
  if (!stringArray(value["criticism"]) || !stringArray(value["questions"])) return false;
  if (
    value["verdict"] === "approve" &&
    (value["criticism"].length !== 0 || value["questions"].length !== 0)
  )
    return false;
  const resultEvidence = value["resultCommitEvidence"];
  const baseAncestry = value["baseAncestry"];
  if (!object(resultEvidence) || !object(baseAncestry)) return false;
  if (value["verdict"] === "approve") {
    if (
      (value["gateReRan"] === true &&
        (typeof value["gateDurationMs"] !== "number" ||
          !Number.isFinite(value["gateDurationMs"]) ||
          value["gateDurationMs"] <= 0)) ||
      (value["gateReRan"] === false && !context.trustedGate)
    )
      return false;
    if (value["resultCommitVerified"] !== true) return false;
    if (!exactKeys(resultEvidence, ["status", "resultCommit", "branchTip"])) return false;
    if (resultEvidence["status"] !== "verified") return false;
    if (
      resultEvidence["resultCommit"] !== expectedResultCommit ||
      resultEvidence["branchTip"] !== expectedResultCommit
    )
      return false;
    if (!exactKeys(baseAncestry, ["status", "relation", "baseCommit", "resultCommit", "mergeBase"]))
      return false;
    if (
      baseAncestry["status"] !== "verified" ||
      baseAncestry["resultCommit"] !== expectedResultCommit
    )
      return false;
    if (baseAncestry["relation"] !== "equal" && baseAncestry["relation"] !== "descendant")
      return false;
    if (
      ![baseAncestry["baseCommit"], baseAncestry["mergeBase"]].every(
        (entry) => typeof entry === "string" && FULL_SHA.test(entry),
      )
    )
      return false;
    if (context.baseCommit === null || baseAncestry["baseCommit"] !== context.baseCommit)
      return false;
    if (baseAncestry["mergeBase"] !== baseAncestry["baseCommit"]) return false;
    if (
      (baseAncestry["relation"] === "equal" &&
        baseAncestry["baseCommit"] !== expectedResultCommit) ||
      (baseAncestry["relation"] === "descendant" &&
        baseAncestry["baseCommit"] === expectedResultCommit)
    )
      return false;
  }
  return true;
}

function parseAdapterVerdict(
  stdout: string,
  taskId: string,
  resultCommit: string,
  context: ReviewerValidationContext,
): ExternalImplementationReviewExecution["parseResult"] {
  const trimmed = stdout.trim();
  if (trimmed === "")
    return { kind: "operational-abstention", reason: "empty", detail: "adapter stdout was empty" };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const payload = fenced?.[1]?.trim() ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!validateReviewerVerdict(parsed, taskId, resultCommit, context)) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: "adapter result did not satisfy the implement-reviewer contract",
    };
  }
  return { kind: "valid-verdict", verdict: parsed };
}

export function implementationAuditManifestDigest(
  manifest: PackagedImplementationAuditManifest,
): string {
  return digest(manifest);
}

/**
 * Bind the immutable audit meaning while excluding the two documented fields
 * that are regenerated at an integration-head transition.
 */
export function implementationAuditManifestSemanticDigest(
  manifest: PackagedImplementationAuditManifest,
): string {
  return digest({
    version: manifest.version,
    manifestId: manifest.manifestId,
    records: manifest.records.map(({ repositoryHead: _repositoryHead, ...record }) => record),
    activation: manifest.activation,
    nonAuthorizingProvenance: manifest.nonAuthorizingProvenance ?? [],
  });
}

function assertPackagedAuditManifest(
  manifest: PackagedImplementationAuditManifest,
  manifestId: string,
): void {
  if (
    manifest.version !== 1 ||
    manifest.manifestId !== manifestId ||
    !/^[0-9a-f]{64}$/u.test(manifest.sourceDigest) ||
    manifest.records.length === 0
  ) {
    throw new Error("packaged implementation audit manifest is malformed");
  }
  const recordKeys = new Set<string>();
  const taskRefs = new Set<string>();
  for (const record of manifest.records) {
    taskIdFromRef(record.taskRef);
    if (!/^goals:G[0-9]+$/u.test(record.ownerGoalRef))
      throw new Error("packaged audit owner goal ref is malformed");
    assertFullSha(record.baseCommit, "audit base_commit");
    assertFullSha(record.resultCommit, "audit result_commit");
    assertFullSha(record.repositoryHead, "audit repository_head");
    if (
      record.recordKey.length === 0 ||
      record.finalizedManifest.length === 0 ||
      recordKeys.has(record.recordKey) ||
      taskRefs.has(record.taskRef) ||
      record.requiredObservations.length === 0 ||
      new Set(record.requiredObservations).size !== record.requiredObservations.length
    ) {
      throw new Error("packaged implementation audit records are incomplete or duplicated");
    }
    recordKeys.add(record.recordKey);
    taskRefs.add(record.taskRef);
  }
  const sorted = [...manifest.records].sort((left, right) =>
    left.taskRef.localeCompare(right.taskRef, undefined, { numeric: true }),
  );
  if (sorted.some((record, index) => record.recordKey !== manifest.records[index]?.recordKey))
    throw new Error("packaged implementation audit records must be in sorted task order");
  if (manifest.activation !== null) {
    const activation = manifest.activation;
    if (
      !/^goals:G[0-9]+$/u.test(activation.goalRef) ||
      !/^[0-9a-f]{64}$/u.test(activation.finalizedManifestDigest) ||
      activation.evidenceTaskKey !== "t-evidence" ||
      activation.auditTaskKey !== "t-historical-evidence" ||
      activation.activationTaskKey !== "t-activate-evidence"
    ) {
      throw new Error("packaged implementation evidence activation is malformed");
    }
  }
  for (const provenance of manifest.nonAuthorizingProvenance ?? []) {
    taskIdFromRef(provenance.taskRef);
    assertFullSha(provenance.requiredAncestorCommit, "non-authorizing ancestor commit");
    if (
      provenance.authorizes !== false ||
      !object(provenance.historicalReview) ||
      taskRefs.has(provenance.taskRef)
    )
      throw new Error("packaged non-authorizing implementation provenance is malformed");
  }
}

function implementationAuditInput(
  manifest: PackagedImplementationAuditManifest,
  manifestDigest: string,
  record: PackagedImplementationAuditRecord,
  roster: readonly ImplementationReviewerIdentity[],
): DispatchJSONValue {
  return {
    manifestId: manifest.manifestId,
    manifestDigest,
    recordKey: record.recordKey,
    taskId: taskIdFromRef(record.taskRef),
    taskRef: record.taskRef,
    ownerGoalRef: record.ownerGoalRef,
    finalizedManifest: record.finalizedManifest,
    historicalReview: record.historicalReview,
    baseCommit: record.baseCommit,
    resultCommit: record.resultCommit,
    repositoryHead: record.repositoryHead,
    diff: record.diff,
    acceptance: record.acceptance,
    gateObservations: record.gateObservations,
    auditRoster: structuredClone(roster) as unknown as DispatchJSONValue,
    requiredObservations: [...record.requiredObservations],
  };
}

function validateAuditorVerdict(
  value: unknown,
  panel: ImplementationAuditPanelRecord,
): value is DispatchJSONValue {
  if (!object(value) || !object(panel.auditInput)) return false;
  if (!validateAgainstSchema(implementationAuditorSidecar.outputSchema, value).ok) return false;
  if (
    value["taskId"] !== taskIdFromRef(panel.taskRef) ||
    value["manifestDigest"] !== panel.manifestDigest ||
    value["baseCommit"] !== panel.auditInput["baseCommit"] ||
    value["resultCommit"] !== panel.auditInput["resultCommit"] ||
    value["repositoryHead"] !== panel.repositoryHead
  )
    return false;
  const required = panel.auditInput["requiredObservations"];
  const observations = value["observations"];
  if (!stringArray(required) || !Array.isArray(observations)) return false;
  const names = observations.map((entry) => (object(entry) ? entry["name"] : null));
  if (JSON.stringify(names) !== JSON.stringify(required)) return false;
  return (
    value["verdict"] !== "approve" ||
    observations.every((entry) => object(entry) && entry["status"] === "verified")
  );
}

function parseAuditAdapterVerdict(
  stdout: string,
  panel: ImplementationAuditPanelRecord,
): ExternalImplementationAuditExecution["parseResult"] {
  const trimmed = stdout.trim();
  if (trimmed === "")
    return { kind: "operational-abstention", reason: "empty", detail: "adapter stdout was empty" };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const payload = fenced?.[1]?.trim() ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!validateAuditorVerdict(parsed, panel)) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: "adapter result did not satisfy the implementation-auditor contract",
    };
  }
  return { kind: "valid-verdict", verdict: parsed };
}

interface OperationProvenance {
  readonly operationId: string;
  readonly author: string;
  readonly session?: string;
}

export interface PrepareImplementationReviewPanelInput extends OperationProvenance {
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
}

export interface PrepareImplementationReviewAttemptInput extends OperationProvenance {
  readonly panelRef: string;
  readonly attemptRef: string;
}

export interface ExecuteExternalImplementationReviewAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface FinalizeImplementationReviewAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface PrepareImplementationReviewFallbackInput extends OperationProvenance {
  readonly panelRef: string;
}

export interface PrepareImplementationCompletionInput extends OperationProvenance {
  readonly taskRef: string;
  readonly expectedRepositoryHead: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly reviewAttemptRefs: readonly string[];
  readonly completion: string;
  readonly logPaths: readonly string[];
  readonly mergeOperationId: string;
  readonly supersedesCompletionRef?: string;
}

export interface RecordImplementationCompletionInput extends OperationProvenance {
  readonly taskRef: string;
  readonly expectedRepositoryHead: string;
}

export interface PrepareImplementationAuditPanelInput extends OperationProvenance {
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly recordKey: string;
  readonly expectedRepositoryHead: string;
}

export interface PrepareImplementationAuditAttemptInput extends OperationProvenance {
  readonly panelRef: string;
  readonly attemptRef: string;
}

export interface ExecuteExternalImplementationAuditAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface FinalizeImplementationAuditAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface PrepareImplementationAuditFallbackInput extends OperationProvenance {
  readonly panelRef: string;
}

export interface ArmImplementationEvidenceActivationInput extends OperationProvenance {
  readonly goalRef: string;
  readonly manifestId: string;
  readonly expectedRepositoryHead: string;
}

export interface ApplyImplementationAuditManifestInput extends OperationProvenance {
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly expectedRepositoryHead: string;
  readonly auditAttemptRefs: readonly string[];
}

export interface ImplementationEvidenceActivationStatusInput {
  readonly goalRef: string;
  readonly manifestId: string;
  readonly expectedRepositoryHead: string;
}

export interface ContinueImplementationEvidenceActivationInput extends OperationProvenance {
  readonly goalRef: string;
  readonly manifestId: string;
  readonly priorRequirementRef: string;
  readonly completedTaskRef: string;
  readonly completionRef: string;
  readonly expectedFromHead: string;
  readonly expectedRepositoryHead: string;
}

export interface AdvanceImplementationEvidenceBootstrapInput extends OperationProvenance {
  readonly goalRef: string;
  readonly finalizedManifestDigest: string;
  readonly expectedRepositoryHead: string;
  readonly expectedPhase: ImplementationEvidenceBootstrapPhase;
}

export interface MaterializeImplementationEvidenceBootstrapHandoffInput {
  readonly activationTaskRef: string;
  readonly expectedServiceCommit: string;
  readonly author: string;
  readonly session?: string;
}

export interface MaterializedImplementationEvidenceBootstrapHandoff {
  readonly state: "created" | "existing";
  readonly actionRef: string;
  readonly handoffRef: string;
}

export interface ImplementationEvidenceActivationManifestBinding {
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly finalizedManifestDigest: string;
}

export interface ImplementationAuditObservation {
  readonly state: "consumed" | "aborted" | "missing";
  readonly input?: DispatchJSONValue;
  readonly output?: DispatchJSONValue;
  readonly retainedAttestation?: string;
}

export interface ImplementationActivationCohort {
  readonly finalizedManifestDigest: string;
  readonly evidenceTaskRef: string;
  readonly auditTaskRef: string;
  readonly activationTaskRef: string;
  readonly boundaryCommit: string;
  readonly taskRefs: readonly string[];
}

export interface ImplementationWorkerObservation {
  readonly state: "consumed" | "aborted" | "missing";
  readonly input?: DispatchJSONValue;
  readonly output?: DispatchJSONValue;
}

export interface ImplementationReviewObservation {
  readonly state: "consumed" | "aborted" | "missing";
  readonly input?: DispatchJSONValue;
  readonly output?: DispatchJSONValue;
  readonly retainedAttestation?: string;
}

export interface ExternalReviewProcessObservation {
  readonly adapterIdentity: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ImplementationTaskAuthority {
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly status: string;
  readonly finalizedManifest: string;
}

export interface ImplementationVerificationObservation {
  readonly baseCommit: string;
  readonly startingCommit: string;
  readonly clean: boolean;
  readonly ancestryVerified: boolean;
  readonly receiptsVerified: boolean;
  readonly acceptanceVerified: boolean;
  readonly gateVerified: boolean;
  readonly details: DispatchJSONValue;
}

export interface ImplementationCompletionLedgerResult {
  readonly reviewRef: string;
}

export interface ImplementationCompletionReviewAuthority {
  readonly reviewRef: string;
  readonly status: string;
  readonly implementationEvidence: string;
}

export type ImplementationEvidenceFaultBoundary =
  | "before-activation-requirement-write"
  | "before-implementation-audit-write"
  | "before-activation-write"
  | "before-activation-requirement-fulfillment-write"
  | "before-activation-continuation-write"
  | "before-audit-manifest-application-write"
  | "after-audit-manifest-application-commit";

export interface ImplementationEvidenceFaultContext {
  readonly operationId: string;
  readonly recordRef: string | null;
}

export type ImplementationEvidenceFaultInjector = (
  boundary: ImplementationEvidenceFaultBoundary,
  context: ImplementationEvidenceFaultContext,
) => void | Promise<void>;

export interface ImplementationEvidenceServiceDependencies {
  readonly store: ImplementationEvidenceStore;
  readonly resolveReviewerRoster: () => readonly ImplementationReviewerIdentity[];
  readonly nativeFallback: ImplementationReviewerIdentity;
  readonly now?: () => string;
  readonly prepareNativeReview: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationReviewPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
    readonly operationId: string;
  }) => Promise<DispatchPrepared>;
  readonly fetchNativeReview: (
    dispatch: DispatchPrepared,
  ) => Promise<ImplementationReviewObservation>;
  readonly executeExternalReview: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationReviewPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
  }) => Promise<ExternalReviewProcessObservation>;
  /** A persisted reservation must settle after the same timeout as its shellout. */
  readonly executionReservationTimeoutMs?: number;
  readonly fetchWorker: (dispatch: DispatchHandle) => Promise<ImplementationWorkerObservation>;
  readonly readTaskAuthority: (taskRef: string) => Promise<ImplementationTaskAuthority>;
  readonly repositoryHead: () => Promise<string>;
  /** Production Git proof used when replacing a stale prepared journal. */
  readonly isResultDescendantOfRepositoryHead?: (input: {
    readonly repositoryHead: string;
    readonly resultCommit: string;
  }) => Promise<boolean>;
  readonly verifyImplementation: (input: {
    readonly task: ImplementationTaskAuthority;
    readonly resultCommit: string;
    readonly worker: ImplementationWorkerObservation;
    readonly attempts: readonly ImplementationReviewAttemptRecord[];
  }) => Promise<ImplementationVerificationObservation>;
  readonly recordLedgerCompletion: (input: {
    readonly task: ImplementationTaskAuthority;
    readonly completion: ImplementationCompletionRecord;
    readonly author: string;
    readonly session?: string;
  }) => Promise<ImplementationCompletionLedgerResult>;
  readonly readCompletionReview?: (
    reviewRef: string,
  ) => Promise<ImplementationCompletionReviewAuthority>;
  readonly resolveAuditRoster?: () => readonly ImplementationReviewerIdentity[];
  readonly readAuditManifest?: (manifestId: string) => Promise<PackagedImplementationAuditManifest>;
  readonly prepareNativeAudit?: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationAuditPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
    readonly operationId: string;
  }) => Promise<DispatchPrepared>;
  readonly fetchNativeAudit?: (
    dispatch: DispatchPrepared,
  ) => Promise<ImplementationAuditObservation>;
  readonly executeExternalAudit?: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationAuditPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
  }) => Promise<ExternalReviewProcessObservation>;
  readonly resolveActivationCohort?: (input: {
    readonly goalRef: string;
    readonly manifest: PackagedImplementationAuditManifest;
    readonly repositoryHead: string;
  }) => Promise<ImplementationActivationCohort>;
  readonly isCommitRetained?: (input: {
    readonly repositoryHead: string;
    readonly resultCommit: string;
  }) => Promise<boolean>;
  readonly faultInjector?: ImplementationEvidenceFaultInjector;
  /** Captured once when the deployed service starts; never supplied by a caller. */
  readonly startupBuildCommit?: string;
  readonly implementationEvidenceProtocolVersion?: number;
  readonly packagedManifestInventory?: readonly string[];
  readonly readBootstrapAuthority?: () => Promise<ImplementationEvidenceBootstrapAuthority>;
  readonly materializeBootstrapActivationHandoff?: (
    input: MaterializeImplementationEvidenceBootstrapHandoffInput,
  ) => Promise<MaterializedImplementationEvidenceBootstrapHandoff>;
}

function operationReplay(
  operations: Readonly<Record<string, string>>,
  operationId: string,
  requestDigest: string,
): boolean {
  const existing = operations[operationId];
  if (existing === undefined) return false;
  if (existing !== requestDigest)
    throw new Error(`operation_id ${operationId} was reused with a different request`);
  return true;
}

function withOperation(
  attempt: ImplementationReviewAttemptRecord,
  operationId: string,
  requestDigest: string,
): ImplementationReviewAttemptRecord {
  return { ...attempt, operations: { ...attempt.operations, [operationId]: requestDigest } };
}

function sortedUniqueTaskRefs(taskRefs: readonly string[], label: string): readonly string[] {
  if (taskRefs.length === 0 || new Set(taskRefs).size !== taskRefs.length)
    throw new Error(`${label} must be one non-empty unique task cohort`);
  taskRefs.forEach(taskIdFromRef);
  const sorted = [...taskRefs].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  if (sorted.some((taskRef, index) => taskRef !== taskRefs[index]))
    throw new Error(`${label} must be in sorted task order`);
  return sorted;
}

function qualifyingHistoricalReview(
  review: DispatchJSONValue | null,
  record: PackagedImplementationAuditRecord,
): boolean {
  if (
    !object(review) ||
    review["taskId"] !== taskIdFromRef(record.taskRef) ||
    review["verdict"] !== "approve" ||
    !validateAgainstSchema(implementReviewerSidecar.outputSchema, review).ok
  )
    return false;
  const result = review["resultCommitEvidence"];
  const ancestry = review["baseAncestry"];
  return (
    object(result) &&
    result["status"] === "verified" &&
    result["resultCommit"] === record.resultCommit &&
    result["branchTip"] === record.resultCommit &&
    object(ancestry) &&
    ancestry["status"] === "verified" &&
    (ancestry["relation"] === "equal" || ancestry["relation"] === "descendant") &&
    ancestry["baseCommit"] === record.baseCommit &&
    ancestry["resultCommit"] === record.resultCommit &&
    ancestry["mergeBase"] === record.baseCommit
  );
}

export async function implementationEvidenceActivationStatusFromStore(
  store: ImplementationEvidenceStore,
  input: ImplementationEvidenceActivationStatusInput,
  repositoryHead: string,
  manifestBinding: ImplementationEvidenceActivationManifestBinding,
) {
  const state = await store.snapshot();
  const requirementCandidates = Object.values(state.activationRequirements).filter(
    (candidate) => candidate.goalRef === input.goalRef && candidate.manifestId === input.manifestId,
  );
  const lineageTips = activationRequirementLineageTips(requirementCandidates);
  const armedRequirements = lineageTips.filter(
    (candidate) => candidate.state === "armed",
  );
  if (armedRequirements.length > 1)
    throw new Error("multiple implementation evidence activation requirements are armed");
  const currentRequirements = lineageTips.filter(
    (candidate) =>
      candidate.manifestDigest === manifestBinding.manifestDigest &&
      candidate.sourceDigest === manifestBinding.sourceDigest &&
      candidate.finalizedManifestDigest === manifestBinding.finalizedManifestDigest &&
      candidate.boundaryCommit === repositoryHead,
  );
  if (currentRequirements.length > 1)
    throw new Error("multiple current implementation evidence activation requirements exist");
  const matchingRequirements = lineageTips.filter(
    (candidate) =>
      candidate.manifestDigest === manifestBinding.manifestDigest &&
      candidate.sourceDigest === manifestBinding.sourceDigest &&
      candidate.finalizedManifestDigest === manifestBinding.finalizedManifestDigest,
  );
  const requirement =
    armedRequirements[0] ??
    currentRequirements[0] ??
    latestActivationRequirement(matchingRequirements) ??
    latestActivationRequirement(lineageTips);
  if (requirement === undefined) {
    return {
      status: "absent" as const,
      manifestId: input.manifestId,
      goalRef: input.goalRef,
      repositoryHead,
      requirementRef: null,
      activationRef: null,
      taskRefs: [],
    };
  }
  if (
    requirement.boundaryCommit !== repositoryHead ||
    requirement.manifestDigest !== manifestBinding.manifestDigest ||
    requirement.sourceDigest !== manifestBinding.sourceDigest ||
    requirement.finalizedManifestDigest !== manifestBinding.finalizedManifestDigest
  )
    return {
      status: "stale" as const,
      manifestId: input.manifestId,
      goalRef: input.goalRef,
      repositoryHead,
      requirementRef: requirement.requirementRef,
      activationRef: requirement.activationRef,
      taskRefs: requirement.taskRefs,
    };
  return {
    status: requirement.state === "fulfilled" ? ("active" as const) : ("pending" as const),
    manifestId: input.manifestId,
    goalRef: input.goalRef,
    repositoryHead,
    requirementRef: requirement.requirementRef,
    activationRef: requirement.activationRef,
    taskRefs: requirement.taskRefs,
  };
}

function activationRequirementLineageTips(
  requirements: readonly ImplementationEvidenceActivationRequirementRecord[],
): readonly ImplementationEvidenceActivationRequirementRecord[] {
  const predecessors = new Set(
    requirements.flatMap((requirement) =>
      [requirement.previousRequirementRef, requirement.supersededRequirementRef].filter(
        (reference): reference is string => reference !== null && reference !== undefined,
      ),
    ),
  );
  return requirements.filter(
    (requirement) =>
      requirement.state !== "superseded" && !predecessors.has(requirement.requirementRef),
  );
}

function latestActivationRequirement(
  requirements: readonly ImplementationEvidenceActivationRequirementRecord[],
): ImplementationEvidenceActivationRequirementRecord | undefined {
  return [...requirements].sort(
    (left, right) =>
      left.armedAt.localeCompare(right.armedAt) ||
      left.requirementRef.localeCompare(right.requirementRef),
  ).at(-1);
}

function finalizedReviewOutcome(attempt: ImplementationReviewAttemptRecord) {
  if (attempt.terminalState === null)
    throw new Error("implementation review attempt is not terminal");
  if (attempt.terminalState === "operational-abstention")
    return { kind: "operational-abstention" as const };
  if (attempt.verdict === null)
    throw new Error("terminal implementation review attempt omitted its verdict");
  return { kind: "verdict" as const, verdict: attempt.verdict };
}

function assertBootstrapAuthority(authority: ImplementationEvidenceBootstrapAuthority): void {
  if (!/^goals:G[0-9]+$/u.test(authority.goalRef))
    throw new Error("bootstrap authority has a malformed goal ref");
  if (!/^[0-9a-f]{64}$/u.test(authority.finalizedManifestDigest))
    throw new Error("bootstrap authority has a malformed finalized manifest digest");
  const mappings = authority.mappings;
  const refs = [mappings.evidenceTaskRef, mappings.historicalTaskRef, mappings.activationTaskRef];
  refs.forEach(taskIdFromRef);
  if (new Set(refs).size !== refs.length)
    throw new Error("bootstrap authority task mappings are not distinct");
  if (
    authority.evidenceTask.taskRef !== mappings.evidenceTaskRef ||
    authority.historicalTask.taskRef !== mappings.historicalTaskRef ||
    authority.activationTask.taskRef !== mappings.activationTaskRef
  )
    throw new Error("bootstrap task authority does not match the finalized mapping");
}

function bootstrapResponse(
  record: ImplementationEvidenceBootstrapRecord,
  status: "admitted" | "operator-action-required" | "existing",
) {
  if (record.phase === "historical-dispatch") {
    return {
      status,
      bootstrapRef: record.bootstrapRef,
      taskRefs: record.taskRefs,
      expectedServiceCommit: record.expectedServiceCommit,
    };
  }
  if (record.actionRef === null || record.handoffRef === null)
    throw new Error("activation bootstrap record omitted its action or handoff");
  return {
    status,
    bootstrapRef: record.bootstrapRef,
    actionRef: record.actionRef,
    handoffRef: record.handoffRef,
    activationTaskRef: record.activationTaskRef,
    expectedServiceCommit: record.expectedServiceCommit,
  };
}

function implementationEvidenceBootstrapPhase(
  authority: ImplementationEvidenceBootstrapAuthority,
): "evidence-dispatch" | "historical-dispatch" | "activation-handoff" | "complete" {
  if (authority.evidenceTask.status === "planned") return "evidence-dispatch";
  if (
    authority.evidenceTask.status === "done" &&
    authority.historicalTask.status === "planned" &&
    authority.activationTask.status === "planned"
  )
    return "historical-dispatch";
  if (
    authority.evidenceTask.status === "done" &&
    authority.historicalTask.status === "done" &&
    authority.activationTask.status === "planned"
  )
    return "activation-handoff";
  if (
    authority.evidenceTask.status === "done" &&
    authority.historicalTask.status === "done" &&
    authority.activationTask.status === "done"
  )
    return "complete";
  throw new Error("implementation evidence bootstrap task statuses are inconsistent");
}

function assertProtectedHistoricalBootstrapCompletion(
  snapshot: ImplementationEvidenceSnapshot,
  authority: ImplementationEvidenceBootstrapAuthority,
  historicalResultCommit: string,
): void {
  if (historicalResultCommit === authority.evidenceTask.resultCommit)
    throw new Error(
      "historical task result commit must be distinct from the evidence service build",
    );
  const admissions = Object.values(snapshot.bootstraps).filter(
    (record) =>
      record.phase === "historical-dispatch" &&
      record.goalRef === authority.goalRef &&
      record.finalizedManifestDigest === authority.finalizedManifestDigest &&
      record.evidenceTaskRef === authority.evidenceTask.taskRef &&
      record.historicalTaskRef === authority.historicalTask.taskRef &&
      record.activationTaskRef === authority.activationTask.taskRef &&
      record.evidenceResultCommit === authority.evidenceTask.resultCommit &&
      record.expectedServiceCommit === authority.evidenceTask.resultCommit &&
      record.taskRefs.length === 1 &&
      record.taskRefs[0] === authority.historicalTask.taskRef,
  );
  if (admissions.length !== 1)
    throw new Error("historical task lacks one exact protected bootstrap admission");
  const completions = Object.values(snapshot.completions).filter(
    (completion) =>
      completion.taskRef === authority.historicalTask.taskRef && completion.state === "recorded",
  );
  if (completions.length !== 1 || completions[0]!.resultCommit !== historicalResultCommit)
    throw new Error("historical task result is not bound to one recorded protected completion");
}

export async function assertImplementationEvidenceBootstrapDispatchAdmission(
  store: ImplementationEvidenceStore,
  bootstrapRef: string,
  taskRef: string,
): Promise<ImplementationEvidenceBootstrapRecord> {
  if (!BOOTSTRAP_REF.test(bootstrapRef))
    throw new Error("implementation evidence bootstrap ref is malformed");
  taskIdFromRef(taskRef);
  const record = (await store.snapshot()).bootstraps[bootstrapRef];
  if (record === undefined) throw new Error("implementation evidence bootstrap ref is missing");
  if (
    record.phase !== "historical-dispatch" ||
    record.taskRefs.length !== 1 ||
    record.taskRefs[0] !== taskRef ||
    record.historicalTaskRef !== taskRef
  )
    throw new Error("implementation evidence bootstrap ref does not admit this task");
  return record;
}

export async function implementationEvidenceBootstrapAdmissionForTask(
  store: ImplementationEvidenceStore,
  taskRef: string,
): Promise<ImplementationEvidenceBootstrapRecord | null> {
  taskIdFromRef(taskRef);
  const matches = Object.values((await store.snapshot()).bootstraps).filter(
    (record) =>
      record.phase === "historical-dispatch" &&
      record.taskRefs.length === 1 &&
      record.taskRefs[0] === taskRef,
  );
  if (matches.length > 1)
    throw new Error("multiple implementation evidence bootstrap admissions target this task");
  return matches[0] ?? null;
}

export class ImplementationEvidenceService {
  private readonly deps: ImplementationEvidenceServiceDependencies;
  private readonly now: () => string;
  private readonly executionReservationTimeoutMs: number;

  constructor(dependencies: ImplementationEvidenceServiceDependencies) {
    this.deps = dependencies;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.executionReservationTimeoutMs =
      dependencies.executionReservationTimeoutMs ?? IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS;
    if (
      !Number.isSafeInteger(this.executionReservationTimeoutMs) ||
      this.executionReservationTimeoutMs <= 0
    )
      throw new Error("implementation reviewer reservation timeout must be a positive integer");
    if (dependencies.nativeFallback.launch !== "native")
      throw new Error("implementation fallback reviewer must be native");
  }

  private async fault(
    boundary: ImplementationEvidenceFaultBoundary,
    context: ImplementationEvidenceFaultContext,
  ): Promise<void> {
    if (this.deps.faultInjector !== undefined) {
      await this.deps.faultInjector(boundary, context);
    }
  }

  private reviewerRoster(): readonly ImplementationReviewerIdentity[] {
    const roster = structuredClone(this.deps.resolveReviewerRoster());
    if (roster.length === 0) throw new Error("implementation reviewer roster must not be empty");
    return roster;
  }

  private auditRoster(): readonly ImplementationReviewerIdentity[] {
    const roster = structuredClone(
      this.deps.resolveAuditRoster?.() ?? this.deps.resolveReviewerRoster(),
    );
    if (roster.length === 0) throw new Error("implementation auditor roster must not be empty");
    return roster;
  }

  private async auditManifest(
    manifestId: string,
    expectedDigest?: string,
  ): Promise<{ manifest: PackagedImplementationAuditManifest; manifestDigest: string }> {
    if (manifestId.length === 0) throw new Error("manifest_id must not be empty");
    if (this.deps.readAuditManifest === undefined)
      throw new Error("packaged implementation audit registry is unavailable");
    const manifest = structuredClone(await this.deps.readAuditManifest(manifestId));
    assertPackagedAuditManifest(manifest, manifestId);
    const manifestDigest = implementationAuditManifestDigest(manifest);
    if (expectedDigest !== undefined && manifestDigest !== expectedDigest)
      throw new Error("packaged implementation audit manifest digest changed");
    return { manifest, manifestDigest };
  }

  private async assertAuditAuthorityCurrent(
    manifestId: string,
    manifestDigest: string,
    repositoryHead: string,
    records: readonly PackagedImplementationAuditRecord[],
  ): Promise<void> {
    await this.auditManifest(manifestId, manifestDigest);
    if ((await this.deps.repositoryHead()) !== repositoryHead)
      throw new Error("repository head changed before protected implementation audit write");
    if (this.deps.isCommitRetained === undefined) return;
    for (const record of records) {
      if (
        !(await this.deps.isCommitRetained({ repositoryHead, resultCommit: record.resultCommit }))
      )
        throw new Error(
          `historical implementation result commit for ${record.taskRef} is not retained`,
        );
    }
  }

  private async assertActivationTasksActionable(
    goalRef: string,
    cohort: ImplementationActivationCohort,
  ): Promise<void> {
    for (const taskRef of [cohort.evidenceTaskRef, cohort.auditTaskRef, cohort.activationTaskRef])
      taskIdFromRef(taskRef);
    for (const taskRef of [cohort.evidenceTaskRef, cohort.auditTaskRef]) {
      const task = await this.deps.readTaskAuthority(taskRef);
      if (task.taskRef !== taskRef || task.ownerGoalRef !== goalRef || task.status !== "done")
        throw new Error("implementation evidence bootstrap tasks must be done before arming");
    }
    const activationTask = await this.deps.readTaskAuthority(cohort.activationTaskRef);
    if (
      activationTask.taskRef !== cohort.activationTaskRef ||
      activationTask.ownerGoalRef !== goalRef ||
      activationTask.status === "done"
    )
      throw new Error("implementation evidence activation task is not actionable");
  }

  private async assertActivationAuthorityCurrent(
    goalRef: string,
    manifestId: string,
    manifestDigest: string,
    repositoryHead: string,
    cohort: ImplementationActivationCohort,
  ): Promise<void> {
    const { manifest } = await this.auditManifest(manifestId, manifestDigest);
    if ((await this.deps.repositoryHead()) !== repositoryHead)
      throw new Error("repository head changed before protected implementation activation write");
    if (this.deps.resolveActivationCohort === undefined)
      throw new Error("finalized-manifest activation resolver is unavailable");
    const current = await this.deps.resolveActivationCohort({
      goalRef,
      manifest,
      repositoryHead,
    });
    if (canonical(current) !== canonical(cohort))
      throw new Error("finalized implementation activation authority changed before arming");
    await this.assertActivationTasksActionable(goalRef, current);
  }

  private async assertNativeAuditApprovalBound(
    panel: ImplementationAuditPanelRecord,
    attempt: ImplementationAuditAttemptRecord,
  ): Promise<void> {
    if (
      attempt.preparedDispatch === null ||
      attempt.retainedAttestation !== attempt.preparedDispatch.attestationId ||
      this.deps.fetchNativeAudit === undefined
    )
      throw new Error(`native audit approval for ${panel.taskRef} is not dispatch-bound`);
    const observation = await this.deps.fetchNativeAudit(attempt.preparedDispatch);
    if (
      observation.state !== "consumed" ||
      observation.retainedAttestation !== attempt.preparedDispatch.attestationId ||
      observation.output === undefined ||
      canonical(observation.output) !== canonical(attempt.verdict) ||
      !validateAuditorVerdict(observation.output, panel)
    )
      throw new Error(`native audit approval for ${panel.taskRef} is not dispatch-bound`);
  }

  async prepareAuditPanel(input: PrepareImplementationAuditPanelInput) {
    assertOperationId(input.operationId);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    if (!/^[0-9a-f]{64}$/u.test(input.manifestDigest))
      throw new Error("manifest_digest must be one lowercase SHA-256 digest");
    const { manifest, manifestDigest } = await this.auditManifest(
      input.manifestId,
      input.manifestDigest,
    );
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head changed before implementation audit preparation");
    const record = manifest.records.find((candidate) => candidate.recordKey === input.recordKey);
    if (record === undefined) throw new Error("packaged implementation audit record is missing");
    if (record.repositoryHead !== repositoryHead)
      throw new Error("packaged implementation audit repository head is stale");
    if (
      this.deps.isCommitRetained !== undefined &&
      !(await this.deps.isCommitRetained({
        repositoryHead,
        resultCommit: record.resultCommit,
      }))
    )
      throw new Error("historical implementation result commit is not retained");
    const roster = this.auditRoster();
    const rosterDigest = digest(roster);
    const request = { ...input, manifestDigest, record, roster };
    const requestDigest = digest(request);
    const panelRef = opaqueRef("cq-implementation-audit-panel", request);
    const attemptRefs = roster.map((identity, position) =>
      opaqueRef("cq-implementation-audit-attempt", { panelRef, position, identity }),
    );
    const auditInput = implementationAuditInput(manifest, manifestDigest, record, roster);
    return await this.deps.store[mutateEvidence](async (state) => {
      await this.assertAuditAuthorityCurrent(manifest.manifestId, manifestDigest, repositoryHead, [
        record,
      ]);
      for (const panel of Object.values(state.auditPanels)) {
        if (panel.operationId !== input.operationId) continue;
        if (panel.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different audit panel`,
          );
        return {
          status: "existing" as const,
          panelRef: panel.panelRef,
          manifestId: panel.manifestId,
          recordKey: panel.recordKey,
          taskRef: panel.taskRef,
          rosterDigest: panel.rosterDigest,
          attemptRefs: panel.attemptRefs,
        };
      }
      const createdAt = this.now();
      const panel: ImplementationAuditPanelRecord = {
        version: 1,
        panelRef,
        manifestId: manifest.manifestId,
        manifestDigest,
        recordKey: record.recordKey,
        taskRef: record.taskRef,
        repositoryHead,
        rosterDigest,
        roster,
        attemptRefs,
        fallbackAttemptRef: null,
        auditInput,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        createdAt,
      };
      state.auditPanels[panelRef] = panel;
      roster.forEach((identity, position) => {
        const attemptRef = attemptRefs[position]!;
        state.auditAttempts[attemptRef] = {
          version: 1,
          attemptRef,
          panelRef,
          taskRef: record.taskRef,
          position,
          identity,
          fallback: false,
          fallbackTrigger: null,
          fallbackExclusions: [],
          preparedDispatch: null,
          retainedAttestation: null,
          executionReservation: null,
          execution: null,
          terminalState: null,
          verdictDigest: null,
          verdict: null,
          operations: {},
          author: input.author,
          session: input.session ?? null,
          createdAt,
        };
      });
      return {
        status: "prepared" as const,
        panelRef,
        manifestId: manifest.manifestId,
        recordKey: record.recordKey,
        taskRef: record.taskRef,
        rosterDigest,
        attemptRefs,
      };
    });
  }

  async prepareAuditAttempt(input: PrepareImplementationAuditAttemptInput) {
    assertOperationId(input.operationId);
    if (!AUDIT_PANEL_REF.test(input.panelRef) || !AUDIT_ATTEMPT_REF.test(input.attemptRef))
      throw new Error("invalid implementation audit reference");
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.auditPanels[input.panelRef];
    const attempt = snapshot.auditAttempts[input.attemptRef];
    if (panel === undefined || attempt === undefined || attempt.panelRef !== panel.panelRef)
      throw new Error("audit attempt does not belong to the panel");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest))
      return this.preparedAuditAttemptResponse("existing", attempt);
    if (attempt.terminalState !== null) throw new Error("audit attempt is already terminal");
    let preparedDispatch: DispatchPrepared | null = null;
    if (attempt.identity.launch === "native") {
      if (this.deps.prepareNativeAudit === undefined)
        throw new Error("native implementation audit dispatch is unavailable");
      preparedDispatch = await this.deps.prepareNativeAudit({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
        operationId: input.operationId,
      });
    }
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.auditAttempts[input.attemptRef];
      if (current === undefined || current.panelRef !== input.panelRef)
        throw new Error("audit attempt changed during preparation");
      if (operationReplay(current.operations, input.operationId, requestDigest))
        return this.preparedAuditAttemptResponse("existing", current);
      if (current.terminalState !== null) throw new Error("audit attempt is already terminal");
      if (
        current.preparedDispatch !== null &&
        preparedDispatch !== null &&
        !sameHandle(handleOf(current.preparedDispatch), handleOf(preparedDispatch))
      )
        throw new Error("audit attempt dispatch identity changed");
      const updated: ImplementationAuditAttemptRecord = {
        ...current,
        preparedDispatch: current.preparedDispatch ?? preparedDispatch,
        operations: { ...current.operations, [input.operationId]: requestDigest },
      };
      state.auditAttempts[input.attemptRef] = updated;
      return this.preparedAuditAttemptResponse("prepared", updated);
    });
  }

  private preparedAuditAttemptResponse(
    status: "prepared" | "existing",
    attempt: ImplementationAuditAttemptRecord,
  ) {
    if (attempt.identity.launch === "adapter")
      return { status, attemptRef: attempt.attemptRef, launch: "adapter" as const };
    if (attempt.preparedDispatch === null)
      throw new Error("native audit attempt has no bound dispatch");
    return {
      status,
      attemptRef: attempt.attemptRef,
      launch: "native" as const,
      dispatch: attempt.preparedDispatch,
    };
  }

  private async recoverExpiredExternalAuditExecution(attemptRef: string): Promise<string | null> {
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.auditAttempts[attemptRef];
      if (
        current === undefined ||
        current.execution !== null ||
        current.executionReservation === null ||
        !this.reservationExpired(current.executionReservation)
      ) {
        return null;
      }
      const execution: ExternalImplementationAuditExecution = {
        executionRef: current.executionReservation.executionRef,
        adapterIdentity: current.identity.adapterId,
        stdout: "",
        stderr: "",
        exitCode: null,
        parseResult: {
          kind: "operational-abstention",
          reason: "unavailable",
          detail:
            "external audit execution reservation expired before an execution receipt was recorded",
        },
        executedAt: this.now(),
      };
      state.auditAttempts[attemptRef] = { ...current, execution };
      return execution.executionRef;
    });
  }

  async executeExternalAuditAttempt(input: ExecuteExternalImplementationAuditAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.auditAttempts[input.attemptRef];
    if (attempt === undefined || attempt.identity.launch !== "adapter")
      throw new Error("attempt is not a configured external audit");
    const panel = snapshot.auditPanels[attempt.panelRef];
    if (panel === undefined) throw new Error("audit panel is missing");
    if (Object.keys(attempt.operations).length === 0)
      throw new Error("external audit attempt was not prepared");
    const requestDigest = digest(input);
    const expiredExecutionRef = await this.recoverExpiredExternalAuditExecution(input.attemptRef);
    if (expiredExecutionRef !== null) {
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: expiredExecutionRef,
      };
    }
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      const executionRef =
        attempt.execution?.executionRef ?? attempt.executionReservation?.executionRef;
      if (executionRef === undefined) throw new Error("external audit replay has no receipt");
      return { status: "existing" as const, attemptRef: attempt.attemptRef, executionRef };
    }
    const executionRef = opaqueRef("cq-implementation-audit-execution", {
      attemptRef: attempt.attemptRef,
      operationId: input.operationId,
      requestDigest,
    });
    const reservation = await this.deps.store[mutateEvidence](async (state) => {
      const current = state.auditAttempts[input.attemptRef];
      if (current === undefined) throw new Error("audit attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        const existingRef =
          current.execution?.executionRef ?? current.executionReservation?.executionRef;
        if (existingRef === undefined) throw new Error("external audit replay has no receipt");
        return { existing: true as const, executionRef: existingRef };
      }
      if (current.terminalState !== null)
        throw new Error("external audit attempt is already terminal");
      if (current.execution !== null)
        throw new Error("external audit attempt already has an execution receipt");
      if (current.executionReservation !== null)
        throw new Error("external audit attempt already has a durable execution reservation");
      const reservedAt = this.now();
      const reservedAtMs = Date.parse(reservedAt);
      if (!Number.isFinite(reservedAtMs))
        throw new Error("implementation auditor reservation clock returned an invalid timestamp");
      const updated: ImplementationAuditAttemptRecord = {
        ...current,
        executionReservation: {
          executionRef,
          operationId: input.operationId,
          requestDigest,
          reservedAt,
          expiresAt: new Date(reservedAtMs + this.executionReservationTimeoutMs).toISOString(),
        },
        operations: { ...current.operations, [input.operationId]: requestDigest },
      };
      state.auditAttempts[input.attemptRef] = updated;
      return { existing: false as const, executionRef };
    });
    if (reservation.existing) {
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: reservation.executionRef,
      };
    }
    let observation: ExternalReviewProcessObservation;
    try {
      if (this.deps.executeExternalAudit === undefined)
        throw new Error("external implementation audit adapter is unavailable");
      observation = await this.deps.executeExternalAudit({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
      });
    } catch (error) {
      observation = {
        adapterIdentity: attempt.identity.adapterId,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
    if (observation.adapterIdentity !== attempt.identity.adapterId)
      throw new Error("external audit adapter identity changed");
    const parsed = parseAuditAdapterVerdict(observation.stdout, panel);
    const parseResult =
      parsed.kind === "valid-verdict" || observation.exitCode === 0
        ? parsed
        : {
            kind: "operational-abstention" as const,
            reason: "failed" as const,
            detail: `adapter exited ${String(observation.exitCode)}: ${parsed.detail}`,
          };
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.auditAttempts[input.attemptRef];
      if (current === undefined) throw new Error("audit attempt disappeared");
      if (current.execution !== null) {
        if (!operationReplay(current.operations, input.operationId, requestDigest))
          throw new Error("external audit attempt already has an execution receipt");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          executionRef: current.execution.executionRef,
        };
      }
      if (current.terminalState !== null) throw new Error("audit attempt is already terminal");
      if (
        current.executionReservation?.executionRef !== executionRef ||
        current.executionReservation.operationId !== input.operationId ||
        current.executionReservation.requestDigest !== requestDigest
      )
        throw new Error("external audit reservation changed before settlement");
      state.auditAttempts[input.attemptRef] = {
        ...current,
        execution: {
          executionRef,
          adapterIdentity: observation.adapterIdentity,
          stdout: observation.stdout,
          stderr: observation.stderr,
          exitCode: observation.exitCode,
          parseResult,
          executedAt: this.now(),
        },
      };
      return {
        status: "executed" as const,
        attemptRef: current.attemptRef,
        executionRef,
      };
    });
  }

  async finalizeAuditAttempt(input: FinalizeImplementationAuditAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.auditAttempts[input.attemptRef];
    if (attempt === undefined) throw new Error("implementation audit attempt is missing");
    const panel = snapshot.auditPanels[attempt.panelRef];
    if (panel === undefined) throw new Error("implementation audit panel is missing");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      if (attempt.terminalState === null)
        throw new Error("audit finalization replay is incomplete");
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        terminalState: attempt.terminalState,
      };
    }
    if (attempt.terminalState !== null) throw new Error("audit attempt is already terminal");
    let verdict: DispatchJSONValue | null = null;
    let retainedAttestation: string | null = null;
    let terminalState: ImplementationReviewTerminalState = "operational-abstention";
    if (attempt.identity.launch === "native") {
      if (attempt.preparedDispatch === null || this.deps.fetchNativeAudit === undefined)
        throw new Error("native implementation audit attempt was not prepared");
      const observation = await this.deps.fetchNativeAudit(attempt.preparedDispatch);
      if (
        observation.state === "consumed" &&
        typeof observation.retainedAttestation === "string" &&
        observation.retainedAttestation === attempt.preparedDispatch.attestationId &&
        observation.output !== undefined &&
        validateAuditorVerdict(observation.output, panel)
      ) {
        verdict = observation.output;
        retainedAttestation = observation.retainedAttestation;
        terminalState =
          object(verdict) && verdict["verdict"] === "approve" ? "approved" : "disapproved";
      }
    } else if (attempt.execution?.parseResult.kind === "valid-verdict") {
      verdict = attempt.execution.parseResult.verdict;
      terminalState =
        object(verdict) && verdict["verdict"] === "approve" ? "approved" : "disapproved";
    }
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.auditAttempts[input.attemptRef];
      if (current === undefined) throw new Error("audit attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        if (current.terminalState === null)
          throw new Error("audit finalization replay is incomplete");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          terminalState: current.terminalState,
        };
      }
      if (current.terminalState !== null) throw new Error("audit attempt is already terminal");
      const updated: ImplementationAuditAttemptRecord = {
        ...current,
        retainedAttestation,
        terminalState,
        verdict,
        verdictDigest: verdict === null ? null : digest(verdict),
        operations: { ...current.operations, [input.operationId]: requestDigest },
      };
      state.auditAttempts[input.attemptRef] = updated;
      return {
        status: "finalized" as const,
        attemptRef: updated.attemptRef,
        terminalState,
      };
    });
  }

  async prepareAuditFallback(input: PrepareImplementationAuditFallbackInput) {
    assertOperationId(input.operationId);
    if (!AUDIT_PANEL_REF.test(input.panelRef))
      throw new Error("invalid implementation audit panel ref");
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.auditPanels[input.panelRef];
    if (panel === undefined) throw new Error("implementation audit panel is missing");
    const configured = panel.attemptRefs.map((ref) => snapshot.auditAttempts[ref]);
    if (
      configured.some(
        (attempt) => attempt === undefined || attempt.terminalState !== "operational-abstention",
      )
    )
      throw new Error("native audit fallback requires terminal abstention by the entire roster");
    const requestDigest = digest(input);
    const fallbackRef = opaqueRef("cq-implementation-audit-attempt", {
      panelRef: panel.panelRef,
      fallback: true,
      identity: this.deps.nativeFallback,
    });
    const existing = snapshot.auditAttempts[fallbackRef];
    if (
      existing !== undefined &&
      operationReplay(existing.operations, input.operationId, requestDigest)
    ) {
      if (existing.preparedDispatch === null) throw new Error("audit fallback dispatch is missing");
      return {
        status: "existing" as const,
        attemptRef: fallbackRef,
        dispatch: existing.preparedDispatch,
      };
    }
    if (this.deps.prepareNativeAudit === undefined)
      throw new Error("native implementation audit dispatch is unavailable");
    const preparedDispatch = await this.deps.prepareNativeAudit({
      attemptRef: fallbackRef,
      panel,
      identity: this.deps.nativeFallback,
      operationId: input.operationId,
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      const currentPanel = state.auditPanels[input.panelRef];
      if (currentPanel === undefined) throw new Error("implementation audit panel disappeared");
      const current = state.auditAttempts[fallbackRef];
      if (current !== undefined) {
        if (!operationReplay(current.operations, input.operationId, requestDigest))
          throw new Error("implementation audit fallback identity already exists");
        if (current.preparedDispatch === null)
          throw new Error("audit fallback dispatch is missing");
        return {
          status: "existing" as const,
          attemptRef: fallbackRef,
          dispatch: current.preparedDispatch,
        };
      }
      const createdAt = this.now();
      state.auditAttempts[fallbackRef] = {
        version: 1,
        attemptRef: fallbackRef,
        panelRef: currentPanel.panelRef,
        taskRef: currentPanel.taskRef,
        position: currentPanel.attemptRefs.length,
        identity: this.deps.nativeFallback,
        fallback: true,
        fallbackTrigger: "all-configured-auditors-abstained",
        fallbackExclusions: [...currentPanel.attemptRefs],
        preparedDispatch,
        retainedAttestation: null,
        executionReservation: null,
        execution: null,
        terminalState: null,
        verdictDigest: null,
        verdict: null,
        operations: { [input.operationId]: requestDigest },
        author: input.author,
        session: input.session ?? null,
        createdAt,
      };
      state.auditPanels[input.panelRef] = { ...currentPanel, fallbackAttemptRef: fallbackRef };
      return { status: "prepared" as const, attemptRef: fallbackRef, dispatch: preparedDispatch };
    });
  }

  async advanceEvidenceBootstrap(input: AdvanceImplementationEvidenceBootstrapInput) {
    assertOperationId(input.operationId);
    if (!/^goals:G[0-9]+$/u.test(input.goalRef))
      throw new Error("goal_ref must be one canonical goal ref");
    if (!/^[0-9a-f]{64}$/u.test(input.finalizedManifestDigest))
      throw new Error("finalized_manifest_digest must be one lowercase SHA-256 digest");
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    if (
      input.expectedPhase !== "historical-dispatch" &&
      input.expectedPhase !== "activation-handoff"
    )
      throw new Error("expected_phase is not a supported implementation evidence bootstrap phase");
    const requestDigest = digest(input);
    const snapshot = await this.deps.store.snapshot();
    const replay = Object.values(snapshot.bootstraps).find(
      (record) => record.operationId === input.operationId,
    );
    if (replay !== undefined) {
      if (replay.requestDigest !== requestDigest)
        throw new Error(`operation_id ${input.operationId} was reused with a different bootstrap`);
      return bootstrapResponse(replay, "existing");
    }
    if (
      this.deps.startupBuildCommit === undefined ||
      this.deps.readBootstrapAuthority === undefined
    )
      throw new Error("implementation evidence bootstrap authority is unavailable");
    assertFullSha(this.deps.startupBuildCommit, "startup build commit");
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head changed before implementation evidence bootstrap advance");
    const authority = await this.deps.readBootstrapAuthority();
    assertBootstrapAuthority(authority);
    if (authority.goalRef !== input.goalRef)
      throw new Error("bootstrap goal does not match protected finalized-manifest authority");
    if (authority.finalizedManifestDigest !== input.finalizedManifestDigest)
      throw new Error("bootstrap finalized manifest digest changed");
    if (authority.evidenceTask.status !== "done" || authority.evidenceTask.resultCommit === null)
      throw new Error("fresh implementation evidence task is not done");
    assertFullSha(authority.evidenceTask.resultCommit, "evidence task result commit");
    if (authority.evidenceTask.resultCommit !== this.deps.startupBuildCommit)
      throw new Error(
        "deployed service build does not equal the fresh evidence task result commit",
      );

    let expectedServiceCommit: string;
    let historicalResultCommit: string | null = null;
    let taskRefs: readonly string[] = [];
    let materialized: MaterializedImplementationEvidenceBootstrapHandoff | null = null;
    if (input.expectedPhase === "historical-dispatch") {
      if (repositoryHead !== authority.evidenceTask.resultCommit)
        throw new Error(
          "historical dispatch requires the fresh evidence result at repository head",
        );
      if (
        authority.historicalTask.status !== "planned" ||
        authority.historicalTask.resultCommit !== null ||
        !authority.historicalTask.ready
      )
        throw new Error("fresh historical evidence task is not ordinarily ready");
      if (authority.activationTask.status !== "planned")
        throw new Error("activation task changed before historical dispatch");
      expectedServiceCommit = authority.evidenceTask.resultCommit;
      taskRefs = [authority.historicalTask.taskRef];
    } else {
      if (
        authority.historicalTask.status !== "done" ||
        authority.historicalTask.resultCommit === null
      )
        throw new Error("fresh historical evidence task is not done");
      assertFullSha(authority.historicalTask.resultCommit, "historical task result commit");
      historicalResultCommit = authority.historicalTask.resultCommit;
      if (repositoryHead !== historicalResultCommit)
        throw new Error("activation handoff requires the historical result at repository head");
      if (
        authority.activationTask.status !== "planned" ||
        authority.activationTask.resultCommit !== null ||
        !authority.activationTask.ready
      )
        throw new Error("fresh activation task is not ordinarily ready");
      if (authority.activationTask.actionKey !== "activate-implementation-evidence")
        throw new Error(
          "activation task must use the activate-implementation-evidence operator action",
        );
      assertProtectedHistoricalBootstrapCompletion(snapshot, authority, historicalResultCommit);
      if (this.deps.materializeBootstrapActivationHandoff === undefined)
        throw new Error("implementation evidence activation handoff is unavailable");
      expectedServiceCommit = historicalResultCommit;
      materialized = await this.deps.materializeBootstrapActivationHandoff({
        activationTaskRef: authority.activationTask.taskRef,
        expectedServiceCommit,
        author: input.author,
        ...(input.session === undefined ? {} : { session: input.session }),
      });
      if (
        !/^operatorActions:OA[0-9]+$/u.test(materialized.actionRef) ||
        !/^handoffs:HO[0-9]+$/u.test(materialized.handoffRef)
      )
        throw new Error("activation handoff returned malformed action authority");
    }
    const bootstrapRef = opaqueRef("cq-implementation-evidence-bootstrap", {
      request: input,
      mappings: authority.mappings,
      evidenceResultCommit: authority.evidenceTask.resultCommit,
      historicalResultCommit,
      expectedServiceCommit,
      taskRefs,
      actionRef: materialized?.actionRef ?? null,
      handoffRef: materialized?.handoffRef ?? null,
    });
    const record: ImplementationEvidenceBootstrapRecord = {
      version: 1,
      bootstrapRef,
      phase: input.expectedPhase,
      goalRef: input.goalRef,
      finalizedManifestDigest: input.finalizedManifestDigest,
      repositoryHead,
      evidenceTaskRef: authority.evidenceTask.taskRef,
      historicalTaskRef: authority.historicalTask.taskRef,
      activationTaskRef: authority.activationTask.taskRef,
      evidenceResultCommit: authority.evidenceTask.resultCommit,
      historicalResultCommit,
      expectedServiceCommit,
      taskRefs,
      actionRef: materialized?.actionRef ?? null,
      handoffRef: materialized?.handoffRef ?? null,
      operationId: input.operationId,
      requestDigest,
      author: input.author,
      session: input.session ?? null,
      createdAt: this.now(),
    };
    return await this.deps.store[mutateEvidence](async (state) => {
      const racedReplay = Object.values(state.bootstraps).find(
        (candidate) => candidate.operationId === input.operationId,
      );
      if (racedReplay !== undefined) {
        if (racedReplay.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different bootstrap`,
          );
        return bootstrapResponse(racedReplay, "existing");
      }
      const phaseConflict = Object.values(state.bootstraps).find(
        (candidate) =>
          candidate.goalRef === input.goalRef &&
          candidate.finalizedManifestDigest === input.finalizedManifestDigest &&
          candidate.phase === input.expectedPhase,
      );
      if (phaseConflict !== undefined)
        throw new Error("bootstrap phase is already bound to a different operation_id");
      state.bootstraps[bootstrapRef] = record;
      return bootstrapResponse(
        record,
        input.expectedPhase === "historical-dispatch" ? "admitted" : "operator-action-required",
      );
    });
  }

  async evidenceServiceStatus() {
    if (
      this.deps.startupBuildCommit === undefined ||
      this.deps.implementationEvidenceProtocolVersion === undefined ||
      this.deps.packagedManifestInventory === undefined ||
      this.deps.readBootstrapAuthority === undefined
    )
      throw new Error("implementation evidence service identity is unavailable");
    assertFullSha(this.deps.startupBuildCommit, "startup build commit");
    const repositoryHead = await this.deps.repositoryHead();
    assertFullSha(repositoryHead, "repository head");
    const authority = await this.deps.readBootstrapAuthority();
    assertBootstrapAuthority(authority);
    const inventory = [...this.deps.packagedManifestInventory];
    if (
      inventory.length === 0 ||
      new Set(inventory).size !== inventory.length ||
      inventory.some((entry) => entry.trim() === "")
    )
      throw new Error("packaged implementation evidence manifest inventory is malformed");
    const state = await this.deps.store.snapshot();
    const candidates = Object.values(state.activationRequirements).filter(
      (entry) => entry.goalRef === authority.goalRef,
    );
    const lineageTips = activationRequirementLineageTips(candidates);
    const armed = lineageTips.filter((entry) => entry.state === "armed");
    if (armed.length > 1)
      throw new Error("multiple implementation evidence activation requirements are armed");
    const current = lineageTips.filter(
      (entry) =>
        entry.finalizedManifestDigest === authority.finalizedManifestDigest &&
        entry.boundaryCommit === repositoryHead,
    );
    if (current.length > 1)
      throw new Error("multiple current implementation evidence activation requirements exist");
    const latest = latestActivationRequirement(lineageTips);
    const requirement = armed[0] ?? current[0] ?? latest;
    const activationState =
      requirement === undefined
        ? { status: "absent" as const, requirementRef: null, activationRef: null }
        : requirement.finalizedManifestDigest !== authority.finalizedManifestDigest ||
            requirement.boundaryCommit !== repositoryHead
          ? {
              status: "stale" as const,
              requirementRef: requirement.requirementRef,
              activationRef: requirement.activationRef,
            }
          : {
              status:
                requirement.state === "fulfilled" ? ("active" as const) : ("pending" as const),
              requirementRef: requirement.requirementRef,
              activationRef: requirement.activationRef,
            };
    return {
      version: 1 as const,
      startupBuildCommit: this.deps.startupBuildCommit,
      repositoryHead,
      protocolVersion: this.deps.implementationEvidenceProtocolVersion,
      goalRef: authority.goalRef,
      finalizedManifestDigest: authority.finalizedManifestDigest,
      mappings: authority.mappings,
      bootstrapPhase: implementationEvidenceBootstrapPhase(authority),
      activationState,
      packagedManifestInventory: inventory,
      operationInventory: [...IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY],
      finalizedReviewOutcomeContract: FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT,
    };
  }

  async armEvidenceActivation(input: ArmImplementationEvidenceActivationInput) {
    assertOperationId(input.operationId);
    if (!/^goals:G[0-9]+$/u.test(input.goalRef))
      throw new Error("goal_ref must be one canonical goal ref");
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    const { manifest, manifestDigest } = await this.auditManifest(input.manifestId);
    const records = manifest.records.map(({ recordKey, taskRef }) => ({ recordKey, taskRef }));
    const semanticManifestDigest = implementationAuditManifestSemanticDigest(manifest);
    if (manifest.activation === null || manifest.activation.goalRef !== input.goalRef)
      throw new Error("packaged manifest has no matching implementation evidence activation");
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head changed before implementation evidence activation arm");
    if (this.deps.resolveActivationCohort === undefined)
      throw new Error("finalized-manifest activation resolver is unavailable");
    const cohort = await this.deps.resolveActivationCohort({
      goalRef: input.goalRef,
      manifest,
      repositoryHead,
    });
    assertFullSha(cohort.boundaryCommit, "activation boundary_commit");
    if (
      cohort.boundaryCommit !== repositoryHead ||
      cohort.finalizedManifestDigest !== manifest.activation.finalizedManifestDigest
    )
      throw new Error("finalized implementation manifest or activation boundary changed");
    const taskRefs = sortedUniqueTaskRefs(cohort.taskRefs, "activation taskRefs");
    if (
      !taskRefs.includes(cohort.evidenceTaskRef) ||
      !taskRefs.includes(cohort.auditTaskRef) ||
      cohort.activationTaskRef === cohort.evidenceTaskRef ||
      cohort.activationTaskRef === cohort.auditTaskRef
    )
      throw new Error("activation cohort does not bind the finalized bootstrap task mappings");
    await this.assertActivationTasksActionable(input.goalRef, cohort);
    const request = {
      ...input,
      manifestDigest,
      sourceDigest: manifest.sourceDigest,
      finalizedManifestDigest: cohort.finalizedManifestDigest,
      taskRefs,
    };
    const requestDigest = digest(request);
    const requirementRef = opaqueRef("cq-implementation-evidence-activation-requirement", request);
    return await this.deps.store[mutateEvidence](async (state) => {
      for (const requirement of Object.values(state.activationRequirements)) {
        if (requirement.operationId !== input.operationId) continue;
        if (requirement.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different activation requirement`,
          );
        return {
          status: "existing" as const,
          requirementRef: requirement.requirementRef,
          manifestId: requirement.manifestId,
          manifestDigest: requirement.manifestDigest,
          records,
          supersededRequirementRef: requirement.supersededRequirementRef ?? null,
          goalRef: requirement.goalRef,
          finalizedManifestDigest: requirement.finalizedManifestDigest,
          evidenceTaskRef: requirement.evidenceTaskRef,
          auditTaskRef: requirement.auditTaskRef,
          activationTaskRef: requirement.activationTaskRef,
          boundaryCommit: requirement.boundaryCommit,
          taskRefs: requirement.taskRefs,
        };
      }
      const scopedRequirements = Object.values(state.activationRequirements).filter(
        (requirement) =>
          requirement.goalRef === input.goalRef && requirement.manifestId === input.manifestId,
      );
      const lineageTips = activationRequirementLineageTips(scopedRequirements);
      const armedRequirements = lineageTips.filter(
        (requirement) => requirement.state === "armed",
      );
      if (armedRequirements.length > 1)
        throw new Error("multiple implementation evidence activation requirements are armed");
      const fulfilledTips = lineageTips.filter(
        (requirement) =>
          requirement.state === "fulfilled" &&
          requirement.semanticManifestDigest === semanticManifestDigest &&
          requirement.finalizedManifestDigest === cohort.finalizedManifestDigest &&
          requirement.evidenceTaskRef === cohort.evidenceTaskRef &&
          requirement.auditTaskRef === cohort.auditTaskRef &&
          requirement.activationTaskRef === cohort.activationTaskRef &&
          canonical(requirement.taskRefs) === canonical(taskRefs),
      );
      if (fulfilledTips.length > 1)
        throw new Error("multiple matching implementation evidence requirement lineages exist");
      const blocking = armedRequirements[0] ?? fulfilledTips[0];
      let supersededRequirementRef: string | null = null;
      if (blocking !== undefined) {
        const hasPreparedEvidence =
          Object.values(state.auditPanels).some(
            (panel) =>
              panel.manifestId === blocking.manifestId &&
              panel.manifestDigest === blocking.manifestDigest &&
              panel.repositoryHead === blocking.boundaryCommit,
          ) ||
          Object.values(state.implementationAudits).some(
            (audit) =>
              audit.manifestId === blocking.manifestId &&
              audit.manifestDigest === blocking.manifestDigest &&
              audit.repositoryHead === blocking.boundaryCommit,
          ) ||
          Object.values(state.auditManifestApplications).some(
            (application) =>
              application.manifestId === blocking.manifestId &&
              application.manifestDigest === blocking.manifestDigest &&
              application.repositoryHead === blocking.boundaryCommit,
          );
        const priorActivation =
          blocking.activationRef === null
            ? undefined
            : state.activations[blocking.activationRef];
        const fulfilledApplication = Object.values(state.auditManifestApplications).find(
          (application) =>
            application.requirementRef === blocking.requirementRef &&
            application.repositoryHead === blocking.boundaryCommit &&
            application.activation !== "none",
        );
        const retainedBoundary =
          this.deps.isCommitRetained !== undefined &&
          await this.deps.isCommitRetained({
            repositoryHead,
            resultCommit: blocking.boundaryCommit,
          });
        if (
          blocking.boundaryCommit === repositoryHead ||
          blocking.semanticManifestDigest !== semanticManifestDigest ||
          blocking.finalizedManifestDigest !== cohort.finalizedManifestDigest ||
          blocking.evidenceTaskRef !== cohort.evidenceTaskRef ||
          blocking.auditTaskRef !== cohort.auditTaskRef ||
          blocking.activationTaskRef !== cohort.activationTaskRef ||
          canonical(blocking.taskRefs) !== canonical(taskRefs) ||
          (blocking.state === "armed" &&
            (blocking.activationRef !== null ||
              blocking.fulfilledAt !== null ||
              hasPreparedEvidence)) ||
          (blocking.state === "fulfilled" &&
            (blocking.activationRef === null ||
              blocking.fulfilledAt === null ||
              priorActivation?.requirementRef !== blocking.requirementRef ||
              priorActivation.repositoryHead !== blocking.boundaryCommit ||
              fulfilledApplication === undefined)) ||
          !retainedBoundary
        )
          throw new Error("a different implementation evidence activation requirement is pending");
        supersededRequirementRef = blocking.requirementRef;
        state.activationRequirements[blocking.requirementRef] = {
          ...blocking,
          state: "superseded",
          supersededByRequirementRef: requirementRef,
          supersededAt: this.now(),
        };
      }
      await this.fault("before-activation-requirement-write", {
        operationId: input.operationId,
        recordRef: requirementRef,
      });
      await this.assertActivationAuthorityCurrent(
        input.goalRef,
        manifest.manifestId,
        manifestDigest,
        repositoryHead,
        cohort,
      );
      state.activationRequirements[requirementRef] = {
        version: 1,
        requirementRef,
        manifestId: manifest.manifestId,
        manifestDigest,
        sourceDigest: manifest.sourceDigest,
        semanticManifestDigest,
        goalRef: input.goalRef,
        finalizedManifestDigest: cohort.finalizedManifestDigest,
        evidenceTaskRef: cohort.evidenceTaskRef,
        auditTaskRef: cohort.auditTaskRef,
        activationTaskRef: cohort.activationTaskRef,
        boundaryCommit: cohort.boundaryCommit,
        taskRefs,
        state: "armed",
        activationRef: null,
        supersededRequirementRef,
        previousRequirementRef: null,
        continuationRef: null,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        armedAt: this.now(),
        fulfilledAt: null,
      };
      return {
        status: "armed" as const,
        requirementRef,
        manifestId: manifest.manifestId,
        manifestDigest,
        records,
        supersededRequirementRef,
        goalRef: input.goalRef,
        finalizedManifestDigest: cohort.finalizedManifestDigest,
        evidenceTaskRef: cohort.evidenceTaskRef,
        auditTaskRef: cohort.auditTaskRef,
        activationTaskRef: cohort.activationTaskRef,
        boundaryCommit: cohort.boundaryCommit,
        taskRefs,
      };
    });
  }

  async applyAuditManifest(input: ApplyImplementationAuditManifestInput) {
    assertOperationId(input.operationId);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    if (!/^[0-9a-f]{64}$/u.test(input.manifestDigest))
      throw new Error("manifest_digest must be one lowercase SHA-256 digest");
    const { manifest, manifestDigest } = await this.auditManifest(
      input.manifestId,
      input.manifestDigest,
    );
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head changed before audit manifest application");
    const snapshot = await this.deps.store.snapshot();
    const applicationRequestDigest = digest(input);
    const replay = snapshot.auditManifestApplications[input.operationId];
    if (replay !== undefined) {
      if (replay.requestDigest !== applicationRequestDigest)
        throw new Error(
          `operation_id ${input.operationId} was reused with a different audit manifest application`,
        );
      return {
        status: "existing" as const,
        manifestId: replay.manifestId,
        manifestDigest: replay.manifestDigest,
        repositoryHead: replay.repositoryHead,
        activation: replay.activation === "activated" ? ("existing" as const) : replay.activation,
        requirementRef: replay.requirementRef,
        evidenceFingerprint: replay.evidenceFingerprint,
        auditRefs: replay.auditRefs,
        taskRefs: replay.taskRefs,
      };
    }
    const expectedAttemptRefs: string[] = [];
    const auditCandidates: Array<{
      readonly record: PackagedImplementationAuditRecord;
      readonly attemptRefs: readonly string[];
      readonly terminalState: ImplementationReviewTerminalState;
    }> = [];
    for (const record of manifest.records) {
      if (
        this.deps.isCommitRetained !== undefined &&
        !(await this.deps.isCommitRetained({ repositoryHead, resultCommit: record.resultCommit }))
      )
        throw new Error(
          `historical implementation result commit for ${record.taskRef} is not retained`,
        );
      if (qualifyingHistoricalReview(record.historicalReview, record)) {
        auditCandidates.push({ record, attemptRefs: [], terminalState: "approved" });
        continue;
      }
      const panels = Object.values(snapshot.auditPanels).filter(
        (panel) =>
          panel.manifestId === manifest.manifestId &&
          panel.manifestDigest === manifestDigest &&
          panel.recordKey === record.recordKey &&
          panel.taskRef === record.taskRef &&
          panel.repositoryHead === repositoryHead,
      );
      if (panels.length !== 1)
        throw new Error(`exactly one finalized audit panel is required for ${record.taskRef}`);
      const panel = panels[0]!;
      const refs = [
        ...panel.attemptRefs,
        ...(panel.fallbackAttemptRef === null ? [] : [panel.fallbackAttemptRef]),
      ];
      const attempts = refs.map((ref) => snapshot.auditAttempts[ref]);
      if (attempts.some((attempt) => attempt === undefined || attempt.terminalState === null))
        throw new Error(`audit panel for ${record.taskRef} is nonterminal`);
      const terminals = attempts.map((attempt) => attempt!.terminalState!);
      if (terminals.includes("disapproved"))
        throw new Error(`audit panel for ${record.taskRef} was disapproved`);
      if (!terminals.includes("approved"))
        throw new Error(`audit panel for ${record.taskRef} has no authenticated approval`);
      for (const attempt of attempts) {
        if (attempt!.identity.launch === "native" && attempt!.verdict !== null)
          await this.assertNativeAuditApprovalBound(panel, attempt!);
      }
      expectedAttemptRefs.push(...refs);
      auditCandidates.push({ record, attemptRefs: refs, terminalState: "approved" });
    }
    if (JSON.stringify(input.auditAttemptRefs) !== JSON.stringify(expectedAttemptRefs))
      throw new Error("audit_attempt_refs must be the complete ordered manifest attempt set");
    const auditRefs = auditCandidates.map(({ record, attemptRefs }) =>
      opaqueRef("cq-implementation-audit", {
        manifestId: manifest.manifestId,
        manifestDigest,
        sourceDigest: manifest.sourceDigest,
        record,
        attemptRefs,
      }),
    );
    const evidenceFingerprint = digest({
      manifestId: manifest.manifestId,
      manifestDigest,
      sourceDigest: manifest.sourceDigest,
      repositoryHead,
      auditRefs,
      taskRefs: manifest.records.map((record) => record.taskRef),
    });
    const result = await this.deps.store[mutateEvidence](async (state) => {
      const existingApplication = state.auditManifestApplications[input.operationId];
      if (existingApplication !== undefined) {
        if (existingApplication.requestDigest !== applicationRequestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different audit manifest application`,
          );
        return {
          status: "existing" as const,
          manifestId: existingApplication.manifestId,
          manifestDigest: existingApplication.manifestDigest,
          repositoryHead: existingApplication.repositoryHead,
          activation:
            existingApplication.activation === "activated"
              ? ("existing" as const)
              : existingApplication.activation,
          requirementRef: existingApplication.requirementRef,
          evidenceFingerprint: existingApplication.evidenceFingerprint,
          auditRefs: existingApplication.auditRefs,
          taskRefs: existingApplication.taskRefs,
        };
      }
      const requirementCandidates = Object.values(state.activationRequirements).filter(
        (candidate) =>
          candidate.manifestId === manifest.manifestId &&
          candidate.boundaryCommit === repositoryHead,
      );
      const armedRequirements = requirementCandidates.filter(
        (candidate) => candidate.state === "armed",
      );
      if (armedRequirements.length > 1)
        throw new Error("multiple implementation evidence activation requirements are armed");
      const requirement =
        armedRequirements[0] ??
        requirementCandidates.find(
          (candidate) =>
            candidate.manifestDigest === manifestDigest &&
            candidate.sourceDigest === manifest.sourceDigest &&
            candidate.goalRef === manifest.activation?.goalRef &&
            candidate.finalizedManifestDigest === manifest.activation?.finalizedManifestDigest,
        );
      if (manifest.activation !== null && requirement === undefined)
        throw new Error("implementation evidence activation requirement is missing");
      if (
        requirement !== undefined &&
        (requirement.manifestDigest !== manifestDigest ||
          requirement.sourceDigest !== manifest.sourceDigest ||
          requirement.goalRef !== manifest.activation?.goalRef ||
          requirement.finalizedManifestDigest !== manifest.activation.finalizedManifestDigest)
      )
        throw new Error("audit manifest does not match the armed activation requirement");
      let existingCount = 0;
      for (const [index, { record, attemptRefs, terminalState }] of auditCandidates.entries()) {
        const auditRef = auditRefs[index]!;
        const existing = state.implementationAudits[auditRef];
        if (existing !== undefined) {
          if (existing.evidenceFingerprint !== digest({ record, attemptRefs, manifestDigest }))
            throw new Error("stored implementation audit does not match the packaged record");
          existingCount += 1;
          continue;
        }
        await this.fault("before-implementation-audit-write", {
          operationId: input.operationId,
          recordRef: auditRef,
        });
        state.implementationAudits[auditRef] = {
          version: 1,
          auditRef,
          manifestId: manifest.manifestId,
          manifestDigest,
          recordKey: record.recordKey,
          taskRef: record.taskRef,
          ownerGoalRef: record.ownerGoalRef,
          finalizedManifest: record.finalizedManifest,
          historicalReview: record.historicalReview,
          baseCommit: record.baseCommit,
          resultCommit: record.resultCommit,
          repositoryHead: record.repositoryHead,
          sourceDigest: manifest.sourceDigest,
          evidenceFingerprint: digest({ record, attemptRefs, manifestDigest }),
          attemptRefs,
          terminalState,
          author: input.author,
          session: input.session ?? null,
          appliedAt: this.now(),
        };
      }
      let activation: "none" | "activated" | "existing" = "none";
      let requirementRef: string | null = null;
      if (requirement !== undefined) {
        requirementRef = requirement.requirementRef;
        const taskRefs = manifest.records.map((record) => record.taskRef);
        if (JSON.stringify(taskRefs) !== JSON.stringify(requirement.taskRefs))
          throw new Error(
            "audit manifest cohort does not exactly fulfill the activation requirement",
          );
        const activationRef = opaqueRef("cq-implementation-evidence-activation", {
          requirementRef,
          manifestId: manifest.manifestId,
          manifestDigest,
          repositoryHead,
          evidenceFingerprint,
          auditRefs,
          taskRefs,
        });
        const existingActivation = state.activations[activationRef];
        if (existingActivation === undefined) {
          await this.fault("before-activation-write", {
            operationId: input.operationId,
            recordRef: activationRef,
          });
          state.activations[activationRef] = {
            version: 1,
            activationRef,
            requirementRef,
            manifestId: manifest.manifestId,
            manifestDigest,
            repositoryHead,
            evidenceFingerprint,
            auditRefs,
            taskRefs,
            author: input.author,
            session: input.session ?? null,
            activatedAt: this.now(),
          };
          activation = "activated";
        } else {
          activation = "existing";
        }
        await this.fault("before-activation-requirement-fulfillment-write", {
          operationId: input.operationId,
          recordRef: requirementRef,
        });
        state.activationRequirements[requirementRef] = {
          ...requirement,
          state: "fulfilled",
          activationRef,
          fulfilledAt: requirement.fulfilledAt ?? this.now(),
        };
      }
      const status =
        existingCount === auditCandidates.length ? ("existing" as const) : ("applied" as const);
      const taskRefs = manifest.records.map((record) => record.taskRef);
      await this.fault("before-audit-manifest-application-write", {
        operationId: input.operationId,
        recordRef: input.operationId,
      });
      state.auditManifestApplications[input.operationId] = {
        version: 1,
        operationId: input.operationId,
        requestDigest: applicationRequestDigest,
        manifestId: manifest.manifestId,
        manifestDigest,
        repositoryHead,
        activation,
        requirementRef,
        evidenceFingerprint,
        auditRefs,
        taskRefs,
        author: input.author,
        session: input.session ?? null,
        appliedAt: this.now(),
      };
      await this.assertAuditAuthorityCurrent(
        manifest.manifestId,
        manifestDigest,
        repositoryHead,
        manifest.records,
      );
      return {
        status,
        manifestId: manifest.manifestId,
        manifestDigest,
        repositoryHead,
        activation,
        requirementRef,
        evidenceFingerprint,
        auditRefs,
        taskRefs,
      };
    });
    await this.fault("after-audit-manifest-application-commit", {
      operationId: input.operationId,
      recordRef: input.operationId,
    });
    return result;
  }

  async evidenceActivationStatus(input: ImplementationEvidenceActivationStatusInput) {
    if (!/^goals:G[0-9]+$/u.test(input.goalRef))
      throw new Error("goal_ref must be one canonical goal ref");
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head does not match the bounded activation status probe");
    const { manifest, manifestDigest } = await this.auditManifest(input.manifestId);
    if (manifest.activation === null || manifest.activation.goalRef !== input.goalRef)
      throw new Error("packaged manifest has no matching implementation evidence activation");
    return await implementationEvidenceActivationStatusFromStore(
      this.deps.store,
      input,
      repositoryHead,
      {
        manifestDigest,
        sourceDigest: manifest.sourceDigest,
        finalizedManifestDigest: manifest.activation.finalizedManifestDigest,
      },
    );
  }

  async continueEvidenceActivation(input: ContinueImplementationEvidenceActivationInput) {
    assertOperationId(input.operationId);
    if (!/^goals:G[0-9]+$/u.test(input.goalRef))
      throw new Error("goal_ref must be one canonical goal ref");
    if (input.manifestId !== IMPLEMENTATION_EVIDENCE_ACTIVATION_MANIFEST_V2)
      throw new Error("activation continuation requires the immutable v2 manifest");
    if (!ACTIVATION_REQUIREMENT_REF.test(input.priorRequirementRef))
      throw new Error("prior_requirement_ref is malformed");
    taskIdFromRef(input.completedTaskRef);
    if (!COMPLETION_REF.test(input.completionRef)) throw new Error("completion_ref is malformed");
    assertFullSha(input.expectedFromHead, "expected_from_head");
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    if (input.expectedFromHead === input.expectedRepositoryHead)
      throw new Error("activation continuation requires one distinct repository transition");
    const requestDigest = digest(input);
    const response = (
      record: ImplementationEvidenceActivationContinuationRecord,
      status: "continued" | "existing",
    ) => ({
      status,
      continuationRef: record.continuationRef,
      previousRequirementRef: record.previousRequirementRef,
      requirementRef: record.requirementRef,
      activationRef: record.activationRef,
      taskRef: record.taskRef,
      completionRef: record.completionRef,
      fromHead: record.fromHead,
      repositoryHead: record.repositoryHead,
    });
    const initial = await this.deps.store.snapshot();
    const replay = Object.values(initial.activationContinuations).find(
      (record) => record.operationId === input.operationId,
    );
    if (replay !== undefined) {
      if (replay.requestDigest !== requestDigest)
        throw new Error(
          `operation_id ${input.operationId} was reused with a different continuation`,
        );
      return response(replay, "existing");
    }
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("repository head changed before activation continuation");
    const prior = initial.activationRequirements[input.priorRequirementRef];
    if (
      prior === undefined ||
      prior.manifestId !== input.manifestId ||
      prior.goalRef !== input.goalRef ||
      prior.state !== "fulfilled" ||
      prior.activationRef === null ||
      prior.boundaryCommit !== input.expectedFromHead
    ) {
      throw new Error("prior v2 activation is absent, pending, or stale at the expected head");
    }
    if (
      typeof prior.semanticManifestDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(prior.semanticManifestDigest)
    )
      throw new Error("prior v2 activation omitted its semantic manifest binding");
    const requirementChain: ImplementationEvidenceActivationRequirementRecord[] = [];
    const seenRequirements = new Set<string>();
    let chainRequirement: ImplementationEvidenceActivationRequirementRecord | undefined = prior;
    while (chainRequirement !== undefined) {
      if (seenRequirements.has(chainRequirement.requirementRef))
        throw new Error("prior v2 activation continuation chain is malformed");
      seenRequirements.add(chainRequirement.requirementRef);
      requirementChain.push(chainRequirement);
      const chainActivation =
        chainRequirement.activationRef === null
          ? undefined
          : initial.activations[chainRequirement.activationRef];
      if (
        chainActivation === undefined ||
        chainActivation.requirementRef !== chainRequirement.requirementRef ||
        chainActivation.manifestId !== chainRequirement.manifestId ||
        chainActivation.manifestDigest !== chainRequirement.manifestDigest ||
        chainActivation.repositoryHead !== chainRequirement.boundaryCommit ||
        canonical(chainActivation.taskRefs) !== canonical(chainRequirement.taskRefs)
      )
        throw new Error("prior v2 activation payload is absent or inconsistent");
      const expectedChainActivationFingerprint = digest({
        manifestId: chainActivation.manifestId,
        manifestDigest: chainActivation.manifestDigest,
        sourceDigest: chainRequirement.sourceDigest,
        repositoryHead: chainActivation.repositoryHead,
        auditRefs: chainActivation.auditRefs,
        taskRefs: chainActivation.taskRefs,
      });
      if (chainActivation.evidenceFingerprint !== expectedChainActivationFingerprint)
        throw new Error("prior v2 activation evidence fingerprint is inconsistent");
      if (chainRequirement.previousRequirementRef === null) {
        if (chainRequirement.continuationRef !== null)
          throw new Error("prior v2 activation continuation chain is malformed");
        break;
      }
      if (chainRequirement.continuationRef === null)
        throw new Error("prior v2 activation continuation chain is malformed");
      const continuation = initial.activationContinuations[chainRequirement.continuationRef];
      const previous: ImplementationEvidenceActivationRequirementRecord | undefined =
        initial.activationRequirements[chainRequirement.previousRequirementRef];
      if (
        continuation === undefined ||
        previous === undefined ||
        continuation.continuationRef !== chainRequirement.continuationRef ||
        continuation.previousContinuationRef !== previous.continuationRef ||
        continuation.previousRequirementRef !== previous.requirementRef ||
        continuation.requirementRef !== chainRequirement.requirementRef ||
        continuation.activationRef !== chainActivation.activationRef ||
        continuation.fromHead !== previous.boundaryCommit ||
        continuation.repositoryHead !== chainRequirement.boundaryCommit
      )
        throw new Error("prior v2 activation continuation chain is malformed");
      const expectedChainTaskRefs = [...previous.taskRefs, continuation.taskRef].sort(
        (left, right) => left.localeCompare(right, undefined, { numeric: true }),
      );
      if (
        previous.taskRefs.includes(continuation.taskRef) ||
        canonical(chainRequirement.taskRefs) !== canonical(expectedChainTaskRefs)
      )
        throw new Error("prior v2 activation continuation task chain is malformed");
      chainRequirement = previous;
    }
    const rootRequirement = requirementChain.at(-1)!;
    const priorActivation = initial.activations[prior.activationRef];
    const rootActivation = initial.activations[rootRequirement.activationRef!];
    if (priorActivation === undefined || rootActivation === undefined)
      throw new Error("prior v2 activation payload is absent or inconsistent");
    for (const requirement of requirementChain) {
      const activation = initial.activations[requirement.activationRef!];
      if (
        requirement.manifestId !== rootRequirement.manifestId ||
        requirement.semanticManifestDigest !== rootRequirement.semanticManifestDigest ||
        requirement.goalRef !== rootRequirement.goalRef ||
        requirement.finalizedManifestDigest !== rootRequirement.finalizedManifestDigest ||
        requirement.evidenceTaskRef !== rootRequirement.evidenceTaskRef ||
        requirement.auditTaskRef !== rootRequirement.auditTaskRef ||
        requirement.activationTaskRef !== rootRequirement.activationTaskRef ||
        activation === undefined ||
        canonical(activation.auditRefs) !== canonical(rootActivation.auditRefs)
      )
        throw new Error("prior v2 activation continuation semantics changed");
    }
    const { manifest, manifestDigest } = await this.auditManifest(input.manifestId);
    const semanticManifestDigest = implementationAuditManifestSemanticDigest(manifest);
    if (
      semanticManifestDigest !== prior.semanticManifestDigest ||
      manifest.activation === null ||
      manifest.activation.goalRef !== prior.goalRef ||
      manifest.activation.finalizedManifestDigest !== prior.finalizedManifestDigest
    )
      throw new Error("packaged v2 activation semantics changed across the head transition");
    for (const requirement of requirementChain) {
      const boundManifest: PackagedImplementationAuditManifest = {
        ...manifest,
        sourceDigest: requirement.sourceDigest,
        records: manifest.records.map((record) => ({
          ...record,
          repositoryHead: requirement.boundaryCommit,
        })),
      };
      if (implementationAuditManifestDigest(boundManifest) !== requirement.manifestDigest)
        throw new Error("prior v2 activation manifest bindings are inconsistent");
    }
    const rootManifest: PackagedImplementationAuditManifest = {
      ...manifest,
      sourceDigest: rootRequirement.sourceDigest,
      records: manifest.records.map((record) => ({
        ...record,
        repositoryHead: rootRequirement.boundaryCommit,
      })),
    };
    if (
      rootActivation.auditRefs.length !== rootManifest.records.length ||
      canonical(rootActivation.taskRefs) !==
        canonical(rootManifest.records.map((record) => record.taskRef))
    )
      throw new Error("prior v2 activation audit cohort is incomplete");
    for (const [index, auditRef] of rootActivation.auditRefs.entries()) {
      const audit = initial.implementationAudits[auditRef];
      const record = rootManifest.records[index];
      if (audit === undefined || record === undefined)
        throw new Error("prior v2 activation ordered audit set is incomplete or unauthenticated");
      const expectedAuditRef = opaqueRef("cq-implementation-audit", {
        manifestId: rootRequirement.manifestId,
        manifestDigest: rootRequirement.manifestDigest,
        sourceDigest: rootRequirement.sourceDigest,
        record,
        attemptRefs: audit.attemptRefs,
      });
      const expectedAuditFingerprint = digest({
        record,
        attemptRefs: audit.attemptRefs,
        manifestDigest: rootRequirement.manifestDigest,
      });
      const expectedAuditBinding = {
        version: 1,
        auditRef: expectedAuditRef,
        manifestId: rootRequirement.manifestId,
        manifestDigest: rootRequirement.manifestDigest,
        recordKey: record.recordKey,
        taskRef: record.taskRef,
        ownerGoalRef: record.ownerGoalRef,
        finalizedManifest: record.finalizedManifest,
        historicalReview: record.historicalReview,
        baseCommit: record.baseCommit,
        resultCommit: record.resultCommit,
        repositoryHead: record.repositoryHead,
        sourceDigest: rootRequirement.sourceDigest,
        evidenceFingerprint: expectedAuditFingerprint,
        attemptRefs: audit.attemptRefs,
        terminalState: "approved",
      };
      const observedAuditBinding = {
        version: audit.version,
        auditRef: audit.auditRef,
        manifestId: audit.manifestId,
        manifestDigest: audit.manifestDigest,
        recordKey: audit.recordKey,
        taskRef: audit.taskRef,
        ownerGoalRef: audit.ownerGoalRef,
        finalizedManifest: audit.finalizedManifest,
        historicalReview: audit.historicalReview,
        baseCommit: audit.baseCommit,
        resultCommit: audit.resultCommit,
        repositoryHead: audit.repositoryHead,
        sourceDigest: audit.sourceDigest,
        evidenceFingerprint: audit.evidenceFingerprint,
        attemptRefs: audit.attemptRefs,
        terminalState: audit.terminalState,
      };
      if (
        record.taskRef !== rootRequirement.taskRefs[index] ||
        canonical(observedAuditBinding) !== canonical(expectedAuditBinding)
      )
        throw new Error("prior v2 activation ordered audit set is incomplete or unauthenticated");
    }
    if (this.deps.resolveActivationCohort === undefined)
      throw new Error("finalized-manifest activation resolver is unavailable");
    const currentCohort = await this.deps.resolveActivationCohort({
      goalRef: input.goalRef,
      manifest,
      repositoryHead,
    });
    const expectedCurrentTaskRefs = [...prior.taskRefs, input.completedTaskRef].sort(
      (left, right) => left.localeCompare(right, undefined, { numeric: true }),
    );
    if (
      prior.taskRefs.includes(input.completedTaskRef) ||
      canonical(currentCohort.taskRefs) !== canonical(expectedCurrentTaskRefs) ||
      currentCohort.boundaryCommit !== repositoryHead ||
      currentCohort.finalizedManifestDigest !== prior.finalizedManifestDigest ||
      currentCohort.evidenceTaskRef !== prior.evidenceTaskRef ||
      currentCohort.auditTaskRef !== prior.auditTaskRef ||
      currentCohort.activationTaskRef !== prior.activationTaskRef
    )
      throw new Error("completed task is not the unique next finalized-manifest Git member");
    const task = await this.deps.readTaskAuthority(input.completedTaskRef);
    const finalizedManifestBytes = new Set(
      manifest.records.map((record) => record.finalizedManifest),
    );
    if (
      task.taskRef !== input.completedTaskRef ||
      task.ownerGoalRef !== input.goalRef ||
      task.status !== "done" ||
      finalizedManifestBytes.size !== 1 ||
      !finalizedManifestBytes.has(task.finalizedManifest)
    )
      throw new Error("completed task does not retain exact finalized-manifest authority");
    const completions = Object.values(initial.completions).filter(
      (completion) => completion.taskRef === input.completedTaskRef,
    );
    if (completions.length !== 1 || completions[0]!.completionRef !== input.completionRef)
      throw new Error("completed task lacks one immutable protected completion journal");
    const completion = completions[0]!;
    if (
      completion.state !== "recorded" ||
      completion.reviewRef === null ||
      completion.ownerGoalRef !== input.goalRef ||
      completion.repositoryHead !== input.expectedFromHead ||
      completion.baseCommit !== input.expectedFromHead ||
      !FULL_SHA.test(completion.startingCommit) ||
      completion.resultCommit !== repositoryHead
    )
      throw new Error("protected completion does not bind the prior activation head transition");
    if (
      Object.values(initial.activationContinuations).some(
        (continuation) => continuation.completionRef === completion.completionRef,
      )
    )
      throw new Error("completion is already bound to another activation transition");
    if (!object(completion.workerResult))
      throw new Error("protected completion omitted its consumed worker result");
    const workerResult = completion.workerResult;
    const gate = workerResult["supervisedGateEvidence"];
    if (
      !object(gate) ||
      !validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, gate).ok ||
      workerResult["gateDurationMs"] !== undefined ||
      gate["taskId"] !== taskIdFromRef(input.completedTaskRef) ||
      gate["baseCommit"] !== input.expectedFromHead ||
      gate["startingCommit"] !== completion.startingCommit ||
      gate["resultCommit"] !== repositoryHead ||
      gate["gateExitCode"] !== 0 ||
      gate["failCount"] !== 0 ||
      typeof gate["passCount"] !== "number" ||
      gate["passCount"] <= 0
    )
      throw new Error("protected completion lacks runner-owned green gate evidence");
    const receipts = workerResult["gitReceipts"];
    if (!Array.isArray(receipts) || receipts.length === 0)
      throw new Error("protected completion lacks a result receipt chain");
    let receiptHead = input.expectedFromHead;
    const receiptLineage = new Set([receiptHead]);
    for (const value of receipts) {
      if (
        !object(value) ||
        value["kind"] !== "cq-git-change-receipt" ||
        value["taskId"] !== taskIdFromRef(input.completedTaskRef) ||
        value["oldHead"] !== receiptHead ||
        typeof value["newHead"] !== "string" ||
        !FULL_SHA.test(value["newHead"])
      )
        throw new Error("protected completion result receipt chain is not contiguous");
      receiptHead = value["newHead"];
      receiptLineage.add(receiptHead);
    }
    if (receiptHead !== repositoryHead)
      throw new Error("protected completion result receipt chain skips the repository head");
    if (!receiptLineage.has(completion.startingCommit))
      throw new Error(
        "protected completion starting commit is absent from the result receipt lineage",
      );
    if (
      this.deps.isCommitRetained === undefined ||
      !(await this.deps.isCommitRetained({
        repositoryHead,
        resultCommit: input.expectedFromHead,
      }))
    )
      throw new Error("activation continuation is not a retained fast-forward transition");
    if (
      !(await this.deps.isCommitRetained({
        repositoryHead: completion.startingCommit,
        resultCommit: input.expectedFromHead,
      })) ||
      !(await this.deps.isCommitRetained({
        repositoryHead,
        resultCommit: completion.startingCommit,
      }))
    )
      throw new Error(
        "protected completion starting commit is not retained on the protected transition",
      );
    if (this.deps.readCompletionReview === undefined)
      throw new Error("terminal implementation review authority is unavailable");
    const review = await this.deps.readCompletionReview(completion.reviewRef);
    const expectedReviewEvidence = {
      version: 1,
      completionRef: completion.completionRef,
      taskRef: completion.taskRef,
      resultCommit: completion.resultCommit,
      evidenceFingerprint: completion.evidenceFingerprint,
      reviewAttemptRefs: completion.reviewAttemptRefs,
    };
    let observedReviewEvidence: unknown;
    try {
      observedReviewEvidence = JSON.parse(review.implementationEvidence);
    } catch {
      throw new Error("terminal go-ahead review has malformed implementation evidence");
    }
    if (
      review.reviewRef !== completion.reviewRef ||
      review.status !== "go-ahead" ||
      canonical(observedReviewEvidence) !== canonical(expectedReviewEvidence)
    )
      throw new Error("terminal go-ahead review is absent or does not bind the completion");
    const currentTaskRefs = expectedCurrentTaskRefs;
    const evidenceFingerprint = digest({
      manifestId: manifest.manifestId,
      manifestDigest,
      sourceDigest: manifest.sourceDigest,
      repositoryHead,
      auditRefs: rootActivation.auditRefs,
      taskRefs: currentTaskRefs,
    });
    const requirementRef = opaqueRef("cq-implementation-evidence-activation-requirement", {
      request: input,
      manifestDigest,
      sourceDigest: manifest.sourceDigest,
      semanticManifestDigest,
      priorActivationRef: priorActivation.activationRef,
    });
    const activationRef = opaqueRef("cq-implementation-evidence-activation", {
      requirementRef,
      manifestId: manifest.manifestId,
      manifestDigest,
      repositoryHead,
      priorActivationRef: priorActivation.activationRef,
      evidenceFingerprint,
      auditRefs: rootActivation.auditRefs,
      taskRefs: currentTaskRefs,
    });
    const continuationRef = opaqueRef("cq-implementation-evidence-activation-continuation", {
      request: input,
      previousContinuationRef: prior.continuationRef,
      previousRequirementRef: prior.requirementRef,
      requirementRef,
      activationRef,
    });
    if (
      !ACTIVATION_REQUIREMENT_REF.test(requirementRef) ||
      !ACTIVATION_REF.test(activationRef) ||
      !ACTIVATION_CONTINUATION_REF.test(continuationRef)
    )
      throw new Error("activation continuation produced malformed protected references");
    const continuedAt = this.now();
    const continuation: ImplementationEvidenceActivationContinuationRecord = {
      version: 1,
      continuationRef,
      previousContinuationRef: prior.continuationRef,
      previousRequirementRef: prior.requirementRef,
      requirementRef,
      activationRef,
      taskRef: input.completedTaskRef,
      completionRef: completion.completionRef,
      fromHead: input.expectedFromHead,
      repositoryHead,
      operationId: input.operationId,
      requestDigest,
      author: input.author,
      session: input.session ?? null,
      continuedAt,
    };
    return await this.deps.store[mutateEvidence](async (state) => {
      const racedReplay = Object.values(state.activationContinuations).find(
        (record) => record.operationId === input.operationId,
      );
      if (racedReplay !== undefined) {
        if (racedReplay.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different continuation`,
          );
        return response(racedReplay, "existing");
      }
      if (
        canonical(state.activationRequirements[prior.requirementRef]) !== canonical(prior) ||
        canonical(state.activations[priorActivation.activationRef]) !==
          canonical(priorActivation) ||
        canonical(state.completions[completion.completionRef]) !== canonical(completion)
      )
        throw new Error("activation continuation authority changed before append");
      if (
        Object.values(state.activationContinuations).some(
          (record) => record.completionRef === completion.completionRef,
        )
      )
        throw new Error("completion is already bound to another activation transition");
      if ((await this.deps.repositoryHead()) !== repositoryHead)
        throw new Error("repository head changed before activation continuation append");
      const currentManifest = await this.auditManifest(input.manifestId, manifestDigest);
      if (
        implementationAuditManifestSemanticDigest(currentManifest.manifest) !==
        semanticManifestDigest
      )
        throw new Error("packaged v2 activation semantics changed before continuation append");
      await this.fault("before-activation-continuation-write", {
        operationId: input.operationId,
        recordRef: continuationRef,
      });
      state.activationRequirements[requirementRef] = {
        ...prior,
        requirementRef,
        manifestDigest,
        sourceDigest: manifest.sourceDigest,
        semanticManifestDigest,
        boundaryCommit: repositoryHead,
        taskRefs: currentTaskRefs,
        state: "fulfilled",
        activationRef,
        previousRequirementRef: prior.requirementRef,
        continuationRef,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        armedAt: continuedAt,
        fulfilledAt: continuedAt,
      };
      state.activations[activationRef] = {
        ...priorActivation,
        activationRef,
        requirementRef,
        manifestDigest,
        repositoryHead,
        evidenceFingerprint,
        auditRefs: rootActivation.auditRefs,
        taskRefs: currentTaskRefs,
        author: input.author,
        session: input.session ?? null,
        activatedAt: continuedAt,
      };
      state.activationContinuations[continuationRef] = continuation;
      return response(continuation, "continued");
    });
  }

  async assertGenericTaskTerminalizationAllowed(taskRef: string): Promise<void> {
    taskIdFromRef(taskRef);
    const state = await this.deps.store.snapshot();
    if (implementationTaskIsActivated(state, taskRef)) {
      throw new Error(
        `Git-producing task ${taskRef} may terminalize only through protected implementation evidence`,
      );
    }
  }

  async prepareReviewPanel(input: PrepareImplementationReviewPanelInput) {
    assertOperationId(input.operationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.resultCommit, "result_commit");
    const roster = this.reviewerRoster();
    const rosterDigest = digest(roster);
    const request = { ...input, roster };
    const requestDigest = digest(request);
    const panelRef = opaqueRef("cq-implementation-review-panel", request);
    const attemptRefs = roster.map((identity, position) =>
      opaqueRef("cq-implementation-review-attempt", { panelRef, position, identity }),
    );
    return await this.deps.store[mutateEvidence](async (state) => {
      for (const panel of Object.values(state.panels)) {
        if (panel.operationId !== input.operationId) continue;
        if (panel.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different review panel`,
          );
        return {
          status: "existing" as const,
          panelRef: panel.panelRef,
          taskRef: panel.taskRef,
          resultCommit: panel.resultCommit,
          rosterDigest: panel.rosterDigest,
          attemptRefs: panel.attemptRefs,
        };
      }
      const createdAt = this.now();
      const panel: ImplementationReviewPanelRecord = {
        version: 1,
        panelRef,
        taskRef: input.taskRef,
        resultCommit: input.resultCommit,
        workerDispatch: structuredClone(input.workerDispatch),
        rosterDigest,
        roster,
        attemptRefs,
        fallbackAttemptRef: null,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        createdAt,
      };
      state.panels[panelRef] = panel;
      roster.forEach((identity, position) => {
        const attemptRef = attemptRefs[position]!;
        state.attempts[attemptRef] = {
          version: 1,
          attemptRef,
          panelRef,
          taskRef: input.taskRef,
          resultCommit: input.resultCommit,
          position,
          identity,
          fallback: false,
          fallbackTrigger: null,
          fallbackExclusions: [],
          preparedDispatch: null,
          retainedAttestation: null,
          executionReservation: null,
          execution: null,
          terminalState: null,
          verdictDigest: null,
          verdict: null,
          operations: {},
          author: input.author,
          session: input.session ?? null,
          createdAt,
        };
      });
      return {
        status: "prepared" as const,
        panelRef,
        taskRef: input.taskRef,
        resultCommit: input.resultCommit,
        rosterDigest,
        attemptRefs,
      };
    });
  }

  async prepareReviewAttempt(input: PrepareImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    if (!PANEL_REF.test(input.panelRef) || !ATTEMPT_REF.test(input.attemptRef))
      throw new Error("invalid implementation review reference");
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.panels[input.panelRef];
    const attempt = snapshot.attempts[input.attemptRef];
    if (panel === undefined || attempt === undefined || attempt.panelRef !== panel.panelRef)
      throw new Error("review attempt does not belong to the panel");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest))
      return this.preparedAttemptResponse("existing", attempt);
    let preparedDispatch: DispatchPrepared | null = null;
    if (attempt.identity.launch === "native")
      preparedDispatch = await this.deps.prepareNativeReview({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
        operationId: input.operationId,
      });
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined || current.panelRef !== input.panelRef)
        throw new Error("review attempt changed during preparation");
      if (operationReplay(current.operations, input.operationId, requestDigest))
        return this.preparedAttemptResponse("existing", current);
      if (
        current.preparedDispatch !== null &&
        preparedDispatch !== null &&
        !sameHandle(handleOf(current.preparedDispatch), handleOf(preparedDispatch))
      )
        throw new Error("review attempt dispatch identity changed");
      const updated = withOperation(
        { ...current, preparedDispatch: current.preparedDispatch ?? preparedDispatch },
        input.operationId,
        requestDigest,
      );
      state.attempts[input.attemptRef] = updated;
      return this.preparedAttemptResponse("prepared", updated);
    });
  }

  private preparedAttemptResponse(
    status: "prepared" | "existing",
    attempt: ImplementationReviewAttemptRecord,
  ) {
    if (attempt.identity.launch === "adapter")
      return { status, attemptRef: attempt.attemptRef, launch: "adapter" as const };
    if (attempt.preparedDispatch === null)
      throw new Error("native review attempt has no bound dispatch");
    return {
      status,
      attemptRef: attempt.attemptRef,
      launch: "native" as const,
      dispatch: attempt.preparedDispatch,
    };
  }

  private reservationExpired(
    reservation: NonNullable<ImplementationReviewAttemptRecord["executionReservation"]>,
  ): boolean {
    const expiresAt = Date.parse(reservation.expiresAt);
    const now = Date.parse(this.now());
    return !Number.isFinite(expiresAt) || !Number.isFinite(now) || now >= expiresAt;
  }

  private async recoverExpiredExternalReviewExecution(attemptRef: string): Promise<string | null> {
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[attemptRef];
      if (
        current === undefined ||
        current.execution !== null ||
        current.executionReservation === null ||
        current.executionReservation === undefined ||
        !this.reservationExpired(current.executionReservation)
      ) {
        return null;
      }
      const execution: ExternalImplementationReviewExecution = {
        executionRef: current.executionReservation.executionRef,
        adapterIdentity: current.identity.adapterId,
        stdout: "",
        stderr: "",
        exitCode: null,
        parseResult: {
          kind: "operational-abstention",
          reason: "unavailable",
          detail:
            "external review execution reservation expired before an execution receipt was recorded",
        },
        executedAt: this.now(),
      };
      state.attempts[attemptRef] = { ...current, execution };
      return execution.executionRef;
    });
  }

  async executeExternalReviewAttempt(input: ExecuteExternalImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.attempts[input.attemptRef];
    if (attempt === undefined || attempt.identity.launch !== "adapter")
      throw new Error("attempt is not a configured external review");
    if (Object.keys(attempt.operations).length === 0)
      throw new Error("external review attempt was not prepared");
    const panel = snapshot.panels[attempt.panelRef];
    if (panel === undefined) throw new Error("review panel is missing");
    const requestDigest = digest(input);
    const expiredExecutionRef = await this.recoverExpiredExternalReviewExecution(input.attemptRef);
    if (expiredExecutionRef !== null) {
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: expiredExecutionRef,
      };
    }
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      if (attempt.execution === null) {
        if (attempt.executionReservation === null || attempt.executionReservation === undefined)
          throw new Error("external review replay has no durable execution reservation");
        return {
          status: "existing" as const,
          attemptRef: attempt.attemptRef,
          executionRef: attempt.executionReservation.executionRef,
        };
      }
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: attempt.execution.executionRef,
      };
    }
    if (attempt.terminalState !== null)
      throw new Error("external review attempt is already terminal");
    if (attempt.execution !== null)
      throw new Error("external review attempt already has an execution receipt");
    const reservation = await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined) throw new Error("review attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        if (current.execution !== null) {
          return { existing: true as const, executionRef: current.execution.executionRef };
        }
        if (current.executionReservation !== null && current.executionReservation !== undefined) {
          return {
            existing: true as const,
            executionRef: current.executionReservation.executionRef,
          };
        }
        throw new Error("external review replay has no durable execution reservation");
      }
      if (current.terminalState !== null)
        throw new Error("external review attempt is already terminal");
      if (current.execution !== null)
        throw new Error("external review attempt already has an execution receipt");
      if (current.executionReservation !== null && current.executionReservation !== undefined)
        throw new Error("external review attempt already has a durable execution reservation");
      const executionRef = opaqueRef("cq-implementation-review-execution", {
        attemptRef: current.attemptRef,
        operationId: input.operationId,
        requestDigest,
      });
      const reservedAt = this.now();
      const reservedAtMs = Date.parse(reservedAt);
      if (!Number.isFinite(reservedAtMs))
        throw new Error("implementation reviewer reservation clock returned an invalid timestamp");
      state.attempts[input.attemptRef] = withOperation(
        {
          ...current,
          executionReservation: {
            executionRef,
            operationId: input.operationId,
            requestDigest,
            reservedAt,
            expiresAt: new Date(reservedAtMs + this.executionReservationTimeoutMs).toISOString(),
          },
        },
        input.operationId,
        requestDigest,
      );
      return { existing: false as const, executionRef };
    });
    if (reservation.existing) {
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: reservation.executionRef,
      };
    }
    const worker = await this.deps.fetchWorker(panel.workerDispatch);
    const validationContext = reviewerValidationContext(worker);
    let observation: ExternalReviewProcessObservation | null = null;
    let unavailable: unknown;
    try {
      observation = await this.deps.executeExternalReview({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
      });
    } catch (error) {
      unavailable = error;
    }
    const executedAt = this.now();
    const parseResult =
      observation === null
        ? {
            kind: "operational-abstention" as const,
            reason: "unavailable" as const,
            detail: unavailable instanceof Error ? unavailable.message : String(unavailable),
          }
        : observation.adapterIdentity !== attempt.identity.adapterId
          ? {
              kind: "operational-abstention" as const,
              reason: "failed" as const,
              detail: `configured adapter identity ${attempt.identity.adapterId} resolved as ${observation.adapterIdentity}`,
            }
          : parseAdapterVerdict(
              observation.stdout,
              taskIdFromRef(panel.taskRef),
              panel.resultCommit,
              validationContext,
            );
    const executionBase = {
      adapterIdentity: observation?.adapterIdentity ?? attempt.identity.adapterId,
      stdout: observation?.stdout ?? "",
      stderr: observation?.stderr ?? "",
      exitCode: observation?.exitCode ?? null,
      parseResult,
      executedAt,
    };
    const execution: ExternalImplementationReviewExecution = {
      executionRef: reservation.executionRef,
      ...executionBase,
    };
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined) throw new Error("review attempt disappeared");
      if (current.execution !== null) {
        if (!operationReplay(current.operations, input.operationId, requestDigest))
          throw new Error("external review attempt already has an execution receipt");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          executionRef: current.execution.executionRef,
        };
      }
      if (current.terminalState !== null)
        throw new Error("external review attempt is already terminal");
      if (
        current.executionReservation === null ||
        current.executionReservation === undefined ||
        current.executionReservation.executionRef !== reservation.executionRef ||
        current.executionReservation.operationId !== input.operationId ||
        current.executionReservation.requestDigest !== requestDigest
      )
        throw new Error("external review execution reservation changed before receipt recording");
      state.attempts[input.attemptRef] = { ...current, execution };
      return {
        status: "executed" as const,
        attemptRef: current.attemptRef,
        executionRef: execution.executionRef,
      };
    });
  }

  async finalizeReviewAttempt(input: FinalizeImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.attempts[input.attemptRef];
    if (attempt === undefined) throw new Error("implementation review attempt is missing");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      if (attempt.terminalState === null)
        throw new Error("finalize replay has no terminal receipt");
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        terminalState: attempt.terminalState,
        outcome: finalizedReviewOutcome(attempt),
      };
    }
    let verdict: DispatchJSONValue | null = null;
    let retainedAttestation: string | null = null;
    const panel = snapshot.panels[attempt.panelRef];
    if (panel === undefined) throw new Error("review panel is missing");
    const worker = await this.deps.fetchWorker(panel.workerDispatch);
    if (attempt.identity.launch === "native") {
      if (attempt.preparedDispatch === null)
        throw new Error("native review attempt was not prepared");
      const observation = await this.deps.fetchNativeReview(attempt.preparedDispatch);
      if (
        observation.state === "consumed" &&
        typeof observation.retainedAttestation === "string" &&
        observation.retainedAttestation === attempt.preparedDispatch.attestationId &&
        validateReviewerVerdict(
          observation.output,
          taskIdFromRef(attempt.taskRef),
          attempt.resultCommit,
          reviewerValidationContext(worker, observation.input),
        )
      ) {
        verdict = observation.output;
        retainedAttestation = observation.retainedAttestation;
      }
    } else if (attempt.execution?.parseResult.kind === "valid-verdict")
      verdict = attempt.execution.parseResult.verdict;
    const terminalState: ImplementationReviewTerminalState =
      verdict === null
        ? "operational-abstention"
        : (verdict as Record<string, unknown>)["verdict"] === "approve"
          ? "approved"
          : "disapproved";
    const verdictDigest = verdict === null ? null : digest(verdict);
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined) throw new Error("implementation review attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        if (current.terminalState === null)
          throw new Error("finalize replay has no terminal receipt");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          terminalState: current.terminalState,
          outcome: finalizedReviewOutcome(current),
        };
      }
      if (current.terminalState !== null)
        throw new Error(
          "implementation review attempt is already terminal under another operation",
        );
      state.attempts[input.attemptRef] = withOperation(
        { ...current, terminalState, verdictDigest, verdict, retainedAttestation },
        input.operationId,
        requestDigest,
      );
      return {
        status: "recorded" as const,
        attemptRef: current.attemptRef,
        terminalState,
        outcome:
          verdict === null
            ? { kind: "operational-abstention" as const }
            : { kind: "verdict" as const, verdict },
      };
    });
  }

  async prepareReviewFallback(input: PrepareImplementationReviewFallbackInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.panels[input.panelRef];
    if (panel === undefined) throw new Error("implementation review panel is missing");
    const configured = panel.attemptRefs.map((ref) => snapshot.attempts[ref]);
    if (configured.some((attempt) => attempt?.terminalState !== "operational-abstention"))
      throw new Error("native fallback requires every configured attempt to terminally abstain");
    const requestDigest = digest(input);
    const existingRef = panel.fallbackAttemptRef;
    if (existingRef !== null) {
      const existing = snapshot.attempts[existingRef];
      if (
        existing === undefined ||
        !operationReplay(existing.operations, input.operationId, requestDigest) ||
        existing.preparedDispatch === null
      )
        throw new Error("implementation review panel already has a different fallback");
      return {
        status: "existing" as const,
        attemptRef: existing.attemptRef,
        dispatch: existing.preparedDispatch,
      };
    }
    const exclusions = configured.map((attempt) => attempt!.identity.adapterId);
    const attemptRef = opaqueRef("cq-implementation-review-attempt", {
      panelRef: panel.panelRef,
      fallback: true,
      exclusions,
    });
    const seed: ImplementationReviewAttemptRecord = {
      version: 1,
      attemptRef,
      panelRef: panel.panelRef,
      taskRef: panel.taskRef,
      resultCommit: panel.resultCommit,
      position: panel.attemptRefs.length,
      identity: structuredClone(this.deps.nativeFallback),
      fallback: true,
      fallbackTrigger: "all-configured-attempts-operationally-abstained",
      fallbackExclusions: exclusions,
      preparedDispatch: null,
      retainedAttestation: null,
      executionReservation: null,
      execution: null,
      terminalState: null,
      verdictDigest: null,
      verdict: null,
      operations: {},
      author: input.author,
      session: input.session ?? null,
      createdAt: this.now(),
    };
    const dispatch = await this.deps.prepareNativeReview({
      attemptRef,
      panel,
      identity: seed.identity,
      operationId: input.operationId,
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      const currentPanel = state.panels[input.panelRef];
      if (currentPanel === undefined) throw new Error("implementation review panel disappeared");
      if (currentPanel.fallbackAttemptRef !== null)
        throw new Error("implementation review fallback raced with another operation");
      const stored = withOperation(
        { ...seed, preparedDispatch: dispatch },
        input.operationId,
        requestDigest,
      );
      state.attempts[attemptRef] = stored;
      state.panels[input.panelRef] = { ...currentPanel, fallbackAttemptRef: attemptRef };
      return { status: "prepared" as const, attemptRef, dispatch };
    });
  }

  async prepareCompletion(input: PrepareImplementationCompletionInput) {
    assertOperationId(input.operationId);
    assertOperationId(input.mergeOperationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    assertFullSha(input.resultCommit, "result_commit");
    if (input.completion.trim() === "") throw new Error("completion must not be empty");
    if (new Set(input.reviewAttemptRefs).size !== input.reviewAttemptRefs.length)
      throw new Error("review_attempt_refs must not contain duplicates");
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("expected_repository_head does not match the integration ref");
    if (
      input.supersedesCompletionRef !== undefined &&
      this.deps.isResultDescendantOfRepositoryHead !== undefined &&
      !(await this.deps.isResultDescendantOfRepositoryHead({
        repositoryHead,
        resultCommit: input.resultCommit,
      }))
    )
      throw new Error(
        "superseding completion result is not rebased onto the current repository head",
      );
    const task = await this.deps.readTaskAuthority(input.taskRef);
    if (task.taskRef !== input.taskRef || task.status !== "wip")
      throw new Error("implementation completion requires the exact active wip task");
    const worker = await this.deps.fetchWorker(input.workerDispatch);
    if (
      worker.state !== "consumed" ||
      !object(worker.output) ||
      worker.output["status"] !== "pass" ||
      worker.output["resultCommit"] !== input.resultCommit
    )
      throw new Error("worker_dispatch does not bind a consumed passing result");
    const workerResult = worker.output;
    const snapshot = await this.deps.store.snapshot();
    const attempts = input.reviewAttemptRefs.map((ref) => snapshot.attempts[ref]);
    if (attempts.some((attempt) => attempt === undefined))
      throw new Error("review_attempt_refs contains an unknown attempt");
    const boundAttempts = attempts as ImplementationReviewAttemptRecord[];
    const panelRefs = new Set(boundAttempts.map((attempt) => attempt.panelRef));
    if (panelRefs.size !== 1) throw new Error("review attempts must belong to one panel");
    const panel = snapshot.panels[boundAttempts[0]!.panelRef];
    if (
      panel === undefined ||
      panel.taskRef !== input.taskRef ||
      panel.resultCommit !== input.resultCommit ||
      !sameHandle(panel.workerDispatch, input.workerDispatch)
    )
      throw new Error("review panel does not match task, result, and worker dispatch");
    const expectedAttempts = [
      ...panel.attemptRefs,
      ...(panel.fallbackAttemptRef === null ? [] : [panel.fallbackAttemptRef]),
    ];
    if (canonical(expectedAttempts) !== canonical(input.reviewAttemptRefs))
      throw new Error("review_attempt_refs must be the complete ordered finalized panel");
    if (
      boundAttempts.some(
        (attempt) => attempt.terminalState === null || attempt.terminalState === "disapproved",
      )
    )
      throw new Error("every review attempt must be terminal and none may disapprove");
    if (!boundAttempts.some((attempt) => attempt.terminalState === "approved"))
      throw new Error("at least one authenticated review attempt must approve");
    const verification = await this.deps.verifyImplementation({
      task,
      resultCommit: input.resultCommit,
      worker,
      attempts: boundAttempts,
    });
    assertFullSha(verification.baseCommit, "verified base commit");
    assertFullSha(verification.startingCommit, "verified starting commit");
    if (
      !verification.clean ||
      !verification.ancestryVerified ||
      !verification.receiptsVerified ||
      !verification.acceptanceVerified ||
      !verification.gateVerified
    )
      throw new Error("implementation verification did not satisfy every completion invariant");
    const evidence = {
      version: 1,
      taskRef: input.taskRef,
      ownerGoalRef: task.ownerGoalRef,
      finalizedManifest: task.finalizedManifest,
      repositoryHead,
      resultCommit: input.resultCommit,
      baseCommit: verification.baseCommit,
      startingCommit: verification.startingCommit,
      workerDispatch: input.workerDispatch,
      workerResult,
      reviewAttemptRefs: input.reviewAttemptRefs,
      attempts: boundAttempts.map((attempt) => ({
        attemptRef: attempt.attemptRef,
        position: attempt.position,
        identity: attempt.identity,
        terminalState: attempt.terminalState,
        verdictDigest: attempt.verdictDigest,
        fallback: attempt.fallback,
        fallbackTrigger: attempt.fallbackTrigger,
        fallbackExclusions: attempt.fallbackExclusions,
        retainedAttestation: attempt.retainedAttestation ?? null,
      })),
      verification,
      completion: input.completion,
      logPaths: input.logPaths,
      mergeOperationId: input.mergeOperationId,
    };
    const evidenceFingerprint = digest(evidence);
    const requestDigest = digest({ ...input, evidenceFingerprint });
    const completionRef = opaqueRef("cq-implementation-completion", {
      taskRef: input.taskRef,
      operationId: input.operationId,
      evidenceFingerprint,
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      for (const existing of Object.values(state.completions)) {
        if (existing.operationId !== input.operationId) continue;
        if (existing.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different completion`,
          );
        return this.preparedCompletionResponse("existing", existing);
      }
      const activeForTask = Object.values(state.completions).filter(
        (entry) =>
          entry.taskRef === input.taskRef &&
          entry.state !== "superseded" &&
          entry.state !== "recorded",
      );
      if (input.supersedesCompletionRef === undefined) {
        if (activeForTask.length !== 0)
          throw new Error("task already has an active implementation completion journal");
      } else {
        const prior = state.completions[input.supersedesCompletionRef];
        if (prior === undefined || prior.taskRef !== input.taskRef || prior.state !== "prepared")
          throw new Error(
            "supersedes_completion_ref must name the same task's unmerged prepared journal",
          );
        if (activeForTask.length !== 1 || activeForTask[0]!.completionRef !== prior.completionRef)
          throw new Error("superseded completion is not the unique active task journal");
        if (
          input.resultCommit === prior.resultCommit ||
          canonical(input.reviewAttemptRefs) === canonical(prior.reviewAttemptRefs)
        )
          throw new Error(
            "superseding completion requires a rebased result and fresh authenticated review",
          );
        state.completions[prior.completionRef] = { ...prior, state: "superseded" };
      }
      const record: ImplementationCompletionRecord = {
        version: 1,
        completionRef,
        taskRef: input.taskRef,
        ownerGoalRef: task.ownerGoalRef,
        resultCommit: input.resultCommit,
        repositoryHead,
        baseCommit: verification.baseCommit,
        startingCommit: verification.startingCommit,
        workerDispatch: structuredClone(input.workerDispatch),
        workerResult,
        reviewAttemptRefs: [...input.reviewAttemptRefs],
        completion: input.completion,
        logPaths: [...input.logPaths],
        finalizedManifest: task.finalizedManifest,
        verification: verification.details,
        mergeOperationId: input.mergeOperationId,
        evidenceFingerprint,
        supersedesCompletionRef: input.supersedesCompletionRef ?? null,
        state: "prepared",
        reviewRef: null,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        preparedAt: this.now(),
        mergeStartedAt: null,
        mergedAt: null,
        recordedAt: null,
        recordOperationId: null,
      };
      state.completions[completionRef] = record;
      return this.preparedCompletionResponse("prepared", record);
    });
  }

  private preparedCompletionResponse(
    status: "prepared" | "existing",
    record: ImplementationCompletionRecord,
  ) {
    return {
      status,
      completionRef: record.completionRef,
      taskRef: record.taskRef,
      resultCommit: record.resultCommit,
      repositoryHead: record.repositoryHead,
      evidenceFingerprint: record.evidenceFingerprint,
    };
  }

  async assertMergeAdmission(
    binding: MergeEffectBinding,
    observedHead: string,
  ): Promise<ImplementationCompletionRecord> {
    return await assertImplementationCompletionMergeAdmission(
      this.deps.store,
      binding,
      observedHead,
    );
  }

  async markMergeStarted(completionRef: string, observedHead: string): Promise<void> {
    await markImplementationCompletionMergeStarted(
      this.deps.store,
      completionRef,
      observedHead,
      this.now,
    );
  }

  async markMerged(completionRef: string, observedHead: string): Promise<void> {
    await markImplementationCompletionMerged(
      this.deps.store,
      completionRef,
      observedHead,
      this.now,
    );
  }

  async mergeAcknowledgement(completionRef: string) {
    return await implementationCompletionMergeAcknowledgement(this.deps.store, completionRef);
  }

  private async revalidateCompletion(
    completion: ImplementationCompletionRecord,
  ): Promise<ImplementationTaskAuthority> {
    const task = await this.deps.readTaskAuthority(completion.taskRef);
    if (
      task.taskRef !== completion.taskRef ||
      task.ownerGoalRef !== completion.ownerGoalRef ||
      task.finalizedManifest !== completion.finalizedManifest ||
      (task.status !== "wip" && !(completion.state === "recording" && task.status === "done"))
    ) {
      throw new Error("task authority changed after completion preparation");
    }
    const worker = await this.deps.fetchWorker(completion.workerDispatch);
    if (
      worker.state !== "consumed" ||
      !object(worker.output) ||
      worker.output["status"] !== "pass" ||
      worker.output["resultCommit"] !== completion.resultCommit ||
      canonical(worker.output) !== canonical(completion.workerResult)
    ) {
      throw new Error("worker evidence changed after completion preparation");
    }
    const snapshot = await this.deps.store.snapshot();
    const attempts = completion.reviewAttemptRefs.map((ref) => snapshot.attempts[ref]);
    if (attempts.some((attempt) => attempt === undefined)) {
      throw new Error("finalized review attempt disappeared after completion preparation");
    }
    const boundAttempts = attempts as ImplementationReviewAttemptRecord[];
    const panelRefs = new Set(boundAttempts.map((attempt) => attempt.panelRef));
    const panel = panelRefs.size === 1 ? snapshot.panels[boundAttempts[0]!.panelRef] : undefined;
    if (
      panel === undefined ||
      panel.taskRef !== completion.taskRef ||
      panel.resultCommit !== completion.resultCommit ||
      !sameHandle(panel.workerDispatch, completion.workerDispatch)
    ) {
      throw new Error("review panel changed after completion preparation");
    }
    const expectedRefs = [
      ...panel.attemptRefs,
      ...(panel.fallbackAttemptRef === null ? [] : [panel.fallbackAttemptRef]),
    ];
    if (canonical(expectedRefs) !== canonical(completion.reviewAttemptRefs)) {
      throw new Error("finalized review attempt order changed after completion preparation");
    }
    for (const [index, attempt] of boundAttempts.entries()) {
      const configured = index < panel.attemptRefs.length;
      if (
        attempt.attemptRef !== completion.reviewAttemptRefs[index] ||
        attempt.panelRef !== panel.panelRef ||
        attempt.taskRef !== completion.taskRef ||
        attempt.resultCommit !== completion.resultCommit ||
        attempt.position !== index ||
        (configured && canonical(attempt.identity) !== canonical(panel.roster[index])) ||
        configured === attempt.fallback ||
        attempt.terminalState === null ||
        attempt.terminalState === "disapproved"
      ) {
        throw new Error("finalized review attempt integrity check failed");
      }
      if (attempt.verdict === null) {
        if (attempt.verdictDigest !== null || attempt.terminalState !== "operational-abstention") {
          throw new Error("review abstention receipt is inconsistent");
        }
      } else {
        let nativeReceiptIsBound = true;
        let reviewerInput: DispatchJSONValue | undefined;
        if (attempt.identity.launch === "native") {
          if (attempt.preparedDispatch === null) nativeReceiptIsBound = false;
          else {
            const observation = await this.deps.fetchNativeReview(attempt.preparedDispatch);
            nativeReceiptIsBound =
              observation.state === "consumed" &&
              observation.retainedAttestation === attempt.preparedDispatch.attestationId &&
              attempt.retainedAttestation === observation.retainedAttestation &&
              canonical(observation.output) === canonical(attempt.verdict);
            reviewerInput = observation.input;
          }
        }
        const adapterReceiptIsBound =
          attempt.identity.launch !== "adapter" ||
          (attempt.execution?.parseResult.kind === "valid-verdict" &&
            canonical(attempt.execution.parseResult.verdict) === canonical(attempt.verdict));
        if (
          attempt.verdictDigest !== digest(attempt.verdict) ||
          !nativeReceiptIsBound ||
          !adapterReceiptIsBound ||
          !validateReviewerVerdict(
            attempt.verdict,
            taskIdFromRef(completion.taskRef),
            completion.resultCommit,
            reviewerValidationContext(worker, reviewerInput),
          ) ||
          attempt.terminalState !==
            ((attempt.verdict as Record<string, unknown>)["verdict"] === "approve"
              ? "approved"
              : "disapproved")
        ) {
          throw new Error("review verdict receipt is inconsistent");
        }
      }
    }
    if (!boundAttempts.some((attempt) => attempt.terminalState === "approved")) {
      throw new Error("finalized review set no longer contains an approval");
    }
    if (
      panel.fallbackAttemptRef !== null &&
      boundAttempts
        .slice(0, panel.attemptRefs.length)
        .some((attempt) => attempt.terminalState !== "operational-abstention")
    ) {
      throw new Error("review fallback is no longer justified by configured abstentions");
    }
    const verification = await this.deps.verifyImplementation({
      task,
      resultCommit: completion.resultCommit,
      worker,
      attempts: boundAttempts,
    });
    if (
      verification.baseCommit !== completion.baseCommit ||
      verification.startingCommit !== completion.startingCommit ||
      !verification.clean ||
      !verification.ancestryVerified ||
      !verification.receiptsVerified ||
      !verification.acceptanceVerified ||
      !verification.gateVerified ||
      canonical(verification.details) !== canonical(completion.verification)
    ) {
      throw new Error("implementation verification changed after completion preparation");
    }
    const evidenceFingerprint = digest({
      version: 1,
      taskRef: completion.taskRef,
      ownerGoalRef: task.ownerGoalRef,
      finalizedManifest: task.finalizedManifest,
      repositoryHead: completion.repositoryHead,
      resultCommit: completion.resultCommit,
      baseCommit: verification.baseCommit,
      startingCommit: verification.startingCommit,
      workerDispatch: completion.workerDispatch,
      workerResult: worker.output,
      reviewAttemptRefs: completion.reviewAttemptRefs,
      attempts: boundAttempts.map((attempt) => ({
        attemptRef: attempt.attemptRef,
        position: attempt.position,
        identity: attempt.identity,
        terminalState: attempt.terminalState,
        verdictDigest: attempt.verdictDigest,
        fallback: attempt.fallback,
        fallbackTrigger: attempt.fallbackTrigger,
        fallbackExclusions: attempt.fallbackExclusions,
        retainedAttestation: attempt.retainedAttestation ?? null,
      })),
      verification,
      completion: completion.completion,
      logPaths: completion.logPaths,
      mergeOperationId: completion.mergeOperationId,
    });
    if (evidenceFingerprint !== completion.evidenceFingerprint) {
      throw new Error("implementation evidence fingerprint changed before recording");
    }
    return task;
  }

  async recordCompletion(input: RecordImplementationCompletionInput) {
    assertOperationId(input.operationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    const head = await this.deps.repositoryHead();
    if (head !== input.expectedRepositoryHead)
      throw new Error("expected_repository_head does not match the integration ref");
    const snapshot = await this.deps.store.snapshot();
    const taskCompletions = Object.values(snapshot.completions).filter(
      (entry) => entry.taskRef === input.taskRef,
    );
    const active = taskCompletions.filter(
      (entry) => entry.state !== "superseded" && entry.state !== "recorded",
    );
    const recorded = taskCompletions.filter((entry) => entry.state === "recorded");
    if (active.length === 0 && recorded.length === 1) {
      const completion = recorded[0]!;
      return {
        status: "existing" as const,
        completionRef: completion.completionRef,
        reviewRef: completion.reviewRef!,
        taskRef: completion.taskRef,
        resultCommit: completion.resultCommit,
        repositoryHead: completion.resultCommit,
        evidenceFingerprint: completion.evidenceFingerprint,
      };
    }
    if (active.length !== 1)
      throw new Error("task must have exactly one active completion journal");
    let completion = active[0]!;
    if (completion.state === "prepared") {
      if (head === completion.repositoryHead)
        return {
          status: "merge-required" as const,
          completionRef: completion.completionRef,
          taskRef: completion.taskRef,
          resultCommit: completion.resultCommit,
          repositoryHead: head,
          evidenceFingerprint: completion.evidenceFingerprint,
        };
      if (head !== completion.resultCommit)
        return {
          status: "reprepare-required" as const,
          completionRef: completion.completionRef,
          taskRef: completion.taskRef,
          resultCommit: completion.resultCommit,
          preparedRepositoryHead: completion.repositoryHead,
          repositoryHead: head,
          evidenceFingerprint: completion.evidenceFingerprint,
        };
      await this.markMergeStarted(completion.completionRef, head);
      completion = (await this.deps.store.snapshot()).completions[completion.completionRef]!;
    }
    if (completion.state === "merge-started" && head === completion.repositoryHead)
      return {
        status: "merge-required" as const,
        completionRef: completion.completionRef,
        taskRef: completion.taskRef,
        resultCommit: completion.resultCommit,
        repositoryHead: head,
        evidenceFingerprint: completion.evidenceFingerprint,
      };
    if (head !== completion.resultCommit)
      throw new Error("merge-started or merged completion has an unrelated integration ref");
    if (completion.state === "merge-started") {
      await this.markMerged(completion.completionRef, head);
      completion = (await this.deps.store.snapshot()).completions[completion.completionRef]!;
    }
    if (completion.state !== "merged" && completion.state !== "recording")
      throw new Error("implementation completion is not recordable");
    await this.revalidateCompletion(completion);
    completion = await this.deps.store[mutateEvidence](async (state) => {
      const current = state.completions[completion.completionRef];
      if (current === undefined)
        throw new Error("implementation completion disappeared before recording");
      if (current.state === "merged") {
        const recording: ImplementationCompletionRecord = {
          ...current,
          state: "recording",
          recordOperationId: input.operationId,
        };
        state.completions[current.completionRef] = recording;
        return recording;
      }
      if (current.state !== "recording" || current.recordOperationId !== input.operationId) {
        throw new Error(
          "implementation completion is already claimed by another recording operation",
        );
      }
      return current;
    });
    const task = await this.deps.readTaskAuthority(completion.taskRef);
    if (
      task.taskRef !== completion.taskRef ||
      task.ownerGoalRef !== completion.ownerGoalRef ||
      task.finalizedManifest !== completion.finalizedManifest
    )
      throw new Error("task authority changed after completion preparation");
    const ledgerResult = await this.deps.recordLedgerCompletion({
      task,
      completion,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.completions[completion.completionRef];
      if (current === undefined)
        throw new Error("implementation completion disappeared during recording");
      if (current.state === "recorded") {
        if (current.reviewRef !== ledgerResult.reviewRef)
          throw new Error("recorded completion review identity changed");
        return {
          status: "existing" as const,
          completionRef: current.completionRef,
          reviewRef: current.reviewRef,
          taskRef: current.taskRef,
          resultCommit: current.resultCommit,
          repositoryHead: current.resultCommit,
          evidenceFingerprint: current.evidenceFingerprint,
        };
      }
      if (current.state !== "recording" || current.recordOperationId !== input.operationId)
        throw new Error("implementation completion changed during ledger recording");
      const recorded: ImplementationCompletionRecord = {
        ...current,
        state: "recorded",
        reviewRef: ledgerResult.reviewRef,
        recordedAt: this.now(),
      };
      state.completions[current.completionRef] = recorded;
      return {
        status: "recorded" as const,
        completionRef: recorded.completionRef,
        reviewRef: ledgerResult.reviewRef,
        taskRef: recorded.taskRef,
        resultCommit: recorded.resultCommit,
        repositoryHead: recorded.resultCommit,
        evidenceFingerprint: recorded.evidenceFingerprint,
      };
    });
  }
}

export async function assertImplementationCompletionMergeAdmission(
  store: ImplementationEvidenceStore,
  binding: MergeEffectBinding,
  observedHead: string,
): Promise<ImplementationCompletionRecord> {
  if (!COMPLETION_REF.test(binding.completionRef))
    throw new Error("merge completionRef is malformed");
  const snapshot = await store.snapshot();
  const completion = snapshot.completions[binding.completionRef];
  if (completion === undefined) throw new Error("merge completion journal is missing");
  if (
    completion.taskRef !== binding.targetRef ||
    completion.resultCommit !== binding.commit ||
    completion.mergeOperationId !== binding.mergeOperationId
  )
    throw new Error("merge coordinates do not match the protected completion journal");
  const blocking = Object.values(snapshot.completions).find(
    (entry) =>
      entry.completionRef !== completion.completionRef &&
      (entry.state === "merge-started" || entry.state === "merged"),
  );
  if (blocking !== undefined)
    throw new Error(
      `implementation completion ${blocking.completionRef} blocks another repository merge until recording`,
    );
  if (
    completion.state !== "prepared" &&
    completion.state !== "merge-started" &&
    completion.state !== "merged"
  )
    throw new Error("implementation completion journal is not merge-admissible");
  if (observedHead !== completion.repositoryHead && observedHead !== completion.resultCommit)
    throw new Error("repository HEAD is unrelated to the prepared completion journal");
  return completion;
}

export async function markImplementationCompletionMergeStarted(
  store: ImplementationEvidenceStore,
  completionRef: string,
  observedHead: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await store[mutateEvidence](async (state) => {
    const completion = state.completions[completionRef];
    if (completion === undefined) throw new Error("merge completion journal disappeared");
    const blocking = Object.values(state.completions).find(
      (entry) =>
        entry.completionRef !== completion.completionRef &&
        (entry.state === "merge-started" ||
          entry.state === "merged" ||
          entry.state === "recording"),
    );
    if (blocking !== undefined) {
      throw new Error(
        `implementation completion ${blocking.completionRef} blocks another repository merge until recording`,
      );
    }
    if (
      observedHead === completion.resultCommit &&
      (completion.state === "prepared" || completion.state === "merge-started")
    ) {
      const instant = now();
      state.completions[completionRef] = {
        ...completion,
        state: "merged",
        mergeStartedAt: completion.mergeStartedAt ?? instant,
        mergedAt: completion.mergedAt ?? instant,
      };
      return;
    }
    if (observedHead === completion.resultCommit && completion.state === "merged") return;
    if (observedHead !== completion.repositoryHead)
      throw new Error("repository HEAD changed before merge launch");
    if (completion.state === "prepared")
      state.completions[completionRef] = {
        ...completion,
        state: "merge-started",
        mergeStartedAt: now(),
      };
    else if (completion.state !== "merge-started")
      throw new Error("completion cannot enter merge-started from its current state");
  });
}

export async function markImplementationCompletionMerged(
  store: ImplementationEvidenceStore,
  completionRef: string,
  observedHead: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await store[mutateEvidence](async (state) => {
    const completion = state.completions[completionRef];
    if (completion === undefined) throw new Error("merge completion journal disappeared");
    if (observedHead !== completion.resultCommit)
      throw new Error("integration ref did not settle at the prepared resultCommit");
    if (completion.state === "merged") return;
    if (completion.state !== "merge-started")
      throw new Error("completion was not merge-started before merge settlement");
    state.completions[completionRef] = { ...completion, state: "merged", mergedAt: now() };
  });
}

export async function implementationCompletionMergeAcknowledgement(
  store: ImplementationEvidenceStore,
  completionRef: string,
  status: "merged" | "existing" = "merged",
) {
  const completion = (await store.snapshot()).completions[completionRef];
  if (completion === undefined || completion.state !== "merged")
    throw new Error("implementation completion is not durably merged");
  return {
    status,
    completionRef: completion.completionRef,
    taskRef: completion.taskRef,
    resultCommit: completion.resultCommit,
    repositoryHead: completion.resultCommit,
    mergeOperationId: completion.mergeOperationId,
    evidenceFingerprint: completion.evidenceFingerprint,
  };
}

/**
 * Protected terminal ledger write. The review is created first and exact
 * replay validates it before the authorized task transition, so response loss
 * converges without allowing generic evidence or task completion writes.
 */
export async function recordProtectedImplementationCompletion(
  store: LedgerStore,
  task: ImplementationTaskAuthority,
  completion: ImplementationCompletionRecord,
  provenance: { readonly author: string; readonly session?: string },
): Promise<ImplementationCompletionLedgerResult> {
  if (completion.state !== "merged" && completion.state !== "recording") {
    throw new Error("protected ledger completion requires a merged journal");
  }
  if (completion.taskRef !== task.taskRef || completion.ownerGoalRef !== task.ownerGoalRef)
    throw new Error("protected ledger completion task authority mismatch");
  const taskId = taskIdFromRef(task.taskRef);
  const reviewId = `R${taskId.slice(1)}`;
  const implementationEvidence = JSON.stringify({
    version: 1,
    completionRef: completion.completionRef,
    taskRef: completion.taskRef,
    resultCommit: completion.resultCommit,
    evidenceFingerprint: completion.evidenceFingerprint,
    reviewAttemptRefs: completion.reviewAttemptRefs,
  });
  const reviewInit: CreateItemInit = {
    id: reviewId,
    status: "go-ahead",
    fields: {
      summary: completion.completion,
      implementationEvidence,
      ledgerRefs: [completion.taskRef, completion.ownerGoalRef] as string[],
      sourceRefs: [...completion.reviewAttemptRefs],
      sessionLogs: [...completion.logPaths],
    },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  const patch: UpdateItemPatch = {
    status: "done",
    fields: {
      resultCommit: completion.resultCommit,
      completion: completion.completion,
      sessionLogs: [...completion.logPaths],
    },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedImplementationEvidenceMutations.add(reviewInit);
  authorizedImplementationEvidenceMutations.add(patch);
  const atomic = store as LedgerStore & {
    runAtomicOwnedMutation?<T>(mutate: (tx: WorksetOwnedWriteTx) => T | Promise<T>): Promise<T>;
  };
  if (atomic.runAtomicOwnedMutation === undefined) {
    throw new Error("protected implementation completion requires an atomic ledger adapter");
  }
  return await atomic.runAtomicOwnedMutation((tx) => {
    const currentTask = tx.fetchItem(TASKS_LEDGER, taskId);
    let existingReview;
    try {
      existingReview = tx.fetchItem(REVIEWS_LEDGER, reviewId);
    } catch (error) {
      if (!(error instanceof ItemNotFoundError)) throw error;
    }
    if (existingReview === undefined) {
      tx.createItemOwnerless(REVIEWS_LEDGER, currentTask.milestoneId, reviewInit);
    } else if (
      existingReview.status !== "go-ahead" ||
      existingReview.fields["implementationEvidence"] !== implementationEvidence
    ) {
      throw new Error("terminal implementation review id belongs to different evidence");
    }
    if (currentTask.status !== "done") tx.updateItem(TASKS_LEDGER, taskId, patch);
    else if (currentTask.fields["resultCommit"] !== completion.resultCommit)
      throw new Error("done task carries a different resultCommit");
    return { reviewRef: `${REVIEWS_LEDGER}:${reviewId}` };
  });
}

export function canonicalImplementationCompletionMergeLine(
  value: Awaited<ReturnType<typeof implementationCompletionMergeAcknowledgement>>,
): string {
  return `CQ_IMPLEMENTATION_COMPLETION_MERGE=${JSON.stringify(value)}`;
}

export interface ImplementationCompletionMergeAdmissionProviderOptions {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly store: ImplementationEvidenceStore;
  readonly binding: MergeEffectBinding;
  readonly repositoryHead: () => Promise<string>;
  readonly now?: () => string;
}

/**
 * Wrap the ordinary workset provider with journal transitions while preserving
 * the same admission through process registration, ref update, settlement,
 * durable `merged`, and release.
 */
export function implementationCompletionMergeAdmissionProviderFromStore(
  options: ImplementationCompletionMergeAdmissionProviderOptions,
): WorksetEffectAdmissionProvider {
  return {
    async acquire(input): Promise<WorksetBrokerAdmissionHandle> {
      if (input.kind !== "merge" || input.targetRef !== options.binding.targetRef)
        throw new Error("implementation completion provider admits only its bound merge");
      await assertImplementationCompletionMergeAdmission(
        options.store,
        options.binding,
        await options.repositoryHead(),
      );
      const underlying = await options.provider.acquire(input);
      return {
        id: underlying.id,
        epoch: underlying.epoch,
        kind: underlying.kind,
        targetRef: underlying.targetRef,
        registerProcessGroup: async (registration, deadline) =>
          await underlying.registerProcessGroup(registration, deadline),
        shareWithGuardian: async (guardian, deadline) => {
          await markImplementationCompletionMergeStarted(
            options.store,
            options.binding.completionRef,
            await options.repositoryHead(),
            options.now,
          );
          await underlying.shareWithGuardian(guardian, deadline);
        },
        markSettled: async () => {
          await underlying.markSettled();
          const observedHead = await options.repositoryHead();
          const completion = (await options.store.snapshot()).completions[
            options.binding.completionRef
          ];
          if (completion === undefined) throw new Error("merge completion journal disappeared");
          if (observedHead === completion.repositoryHead) return;
          await markImplementationCompletionMerged(
            options.store,
            options.binding.completionRef,
            observedHead,
            options.now,
          );
        },
        releaseAfterSettlement: async () => await underlying.releaseAfterSettlement(),
        abandonBeforeRegistration: async () => await underlying.abandonBeforeRegistration(),
      };
    },
  };
}
