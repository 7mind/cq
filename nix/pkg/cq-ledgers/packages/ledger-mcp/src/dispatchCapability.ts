import {
  CODEX_CORRELATION_SEPARATOR,
  CODEX_STAGED_TIMING_BASIS,
  DISPATCH_INPUT_VALIDATION_DEFERRED,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_REF_ASSEMBLY_DEFERRED,
  DISPATCH_TIMEOUT_MAX_MS,
  DISPATCH_TIMEOUT_MIN_MS,
  IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
  IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  implementWorkerSupervisedGateEvidenceSchema,
  IDEMPOTENCY_HORIZON_MS,
  AttestationKeyReuseError,
  AttestationBackendUnsupportedError,
  DispatchStateConflictError,
  abortDispatchOn,
  claimParentGateOn,
  claimQualifiedParentGateOn,
  completeParentGateOn,
  completeQualifiedParentGateOn,
  discoverDispatchContinuationOn,
  discoverDispatchRecovery,
  authorizeDispatchGitConflictOn,
  authorizeDispatchGitEffectOn,
  assembleDispatchInput,
  attestationInstantMs,
  confirmDispatchCompletionOn,
  enqueueImplementationCandidateOn,
  replayConfirmedDispatchCompletionOn,
  defaultDispatchRandomBytes,
  dispatchPayloadDigest,
  dispatchPreLaunchRejection,
  fetchDispatchInputOn,
  fetchDispatchResultOn,
  isAttestationTombstone,
  loadConfig,
  parentGateCapabilityMatches,
  prepareDispatchOn,
  prepareDispatchRequestDigest,
  qualifyDispatchStagedCompletionOn,
  requestParentGateCancellationOn,
  releaseImplementationCompletionLease,
  reserveImplementationCompletionLease,
  resolveDispatchGitEffectBindingOn,
  resolveSupervisedWorkerGateContextOn,
  resolveDispatchGitEffectBindingForHandleOn,
  resolveDispatchRecoveryOn,
  resolveDispatchContinuationOn,
  storeDispatchResultOn,
  upgradeLiveImplementationQueueRows,
  validateAgainstSchema,
  validateDispatchInput,
  type AttestationBackend,
  type AttestationEnvelope,
  type DispatchNarrativeSource,
  type DispatchJSONValue,
  type DispatchPrepareAccepted,
  type DispatchPrepared,
  type DispatchPreLaunchRejection,
  type PrepareDispatchOutcome,
  type PrepareDispatchRequest,
  type LegacyImplementationResolution,
  type UpgradeLiveImplementationQueueSummary,
} from "@cq/config";
import type { SQL } from "bun";
import { resolve } from "node:path";
import {
  assertAttestationConstructionSupported,
  assertManagedWorktreeDispatchBindingLive,
  assertManagedWorktreeWipClosure,
  assertImplementationEvidenceBootstrapDispatchAdmission,
  implementationEvidenceBootstrapAdmissionForTask,
  attestationNamespaceForTrustedHubProject,
  currentRecoveryJournalRoot,
  createAttestationStoreForConstruction,
  createDispatchNarrativeSource,
  commitManagedWorktreeChanges,
  continueManagedWorktreeRebase,
  gitRebaseConflictStateDigest,
  GuardedRebaseRejection,
  materializeGuardedRebaseBridge,
  reverifyGuardedRebaseBridge,
  redactSecrets,
  validateGitConflictContinuationResultEvidence,
  validateGitChangeBrokerResultEvidence,
  resolveManagedWorktreeDispatchBinding,
  resolveManagedWorktreeLineageBinding,
  observeManagedWorktreeLiveTip,
  resolveInheritedGitChangeReceipts,
  runGuardedRebase,
  runLedgerWorksetGitEffect,
  SupervisedWorkerGateRejectedError,
  withManagedWorktreeEffectLock,
  superviseImplementWorkerGate,
  settleWorktreeGateCommands,
  resolveSingleProjectAttestationNamespace,
  dispatchLineageFenceAuthorizes,
  dispatchLineageFenceFromRecoveryJournal,
  dispatchLineageFenceMatches,
  FsCurrentRecoverySealJournalStore,
  journalRecoveryRequiredForFence,
  TASKS_LEDGER,
  type CurrentRecoverySealJournalStore,
  type DispatchLineageCutoverFence,
  type DispatchCapability,
  type CoordinateImplementationCandidateOutcome,
  type GitChangeBrokerReceipt,
  type QualifyImplementationCandidateInput,
  type GitChangeBrokerResultEvidence,
  type GitRebaseConflictState,
  type GitConflictContinuationResultEvidence,
  type LedgerStore,
  type ImplementationEvidenceStore,
  type ImplementationCandidateAuthorityReceipt,
  type ImplementationCandidateCompletionReservationBinding,
  type LedgerServerConstruction,
  type ManagedWorktreeDispatchBinding,
  type ResolvedLedgerStore,
  type SupervisedWorkerGateRunner,
  type SingleProjectConstruction,
} from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";
import {
  assertManagedRecoveryTipEligible,
  captureCurrentDispatchRecoverySealUnderLock,
  currentRecoveryTaskEvidence,
  currentRecoveryTaskSpecificationDigest,
} from "./dispatchRecoverySeal.js";
import {
  ImplementationCandidateCoordinator,
  ImplementationCandidateQueueAdapter,
  type ImplementationCandidateCoordinatorOperations,
  type PendingStagedRebaseCheckpoint,
} from "./implementationCandidateQueue.js";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

function dispatchObject(
  value: DispatchJSONValue | undefined,
): value is Readonly<Record<string, DispatchJSONValue>> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function ledgerLogWriter(
  store: LedgerStore | undefined,
): ((path: string, content: string) => Promise<void>) | undefined {
  if (store === undefined) return undefined;
  const candidate = (store as { readonly putLog?: unknown }).putLog;
  if (typeof candidate !== "function") return undefined;
  const putLog = candidate as (path: string, content: string) => Promise<void>;
  return (path, content) => putLog.call(store, path, content);
}

async function readOnlyGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repositoryRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) {
    throw new Error(`read-only Git observation failed: ${stderr.trim()}`);
  }
  const value = stdout.trim();
  if (value === "") throw new Error("read-only Git observation returned an empty value");
  return value;
}

async function readOnlyGitAllowEmpty(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const child = Bun.spawn(["git", "-C", repositoryRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`read-only Git observation failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function readProtectedIntegrationHead(
  repositoryRoot: string,
  integrationRef: string,
): Promise<string> {
  if (!/^refs\/heads\/.+$/u.test(integrationRef)) {
    throw new Error("implementation candidate integration ref is not a protected branch ref");
  }
  const head = await readOnlyGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${integrationRef}^{commit}`,
  ]);
  if (!FULL_GIT_SHA.test(head)) {
    throw new Error("implementation candidate protected ref did not resolve to a commit");
  }
  return head;
}

function exactGoalRef(store: LedgerStore, taskId: string): string {
  const task = store.fetchItem(TASKS_LEDGER, taskId);
  const goalRefs = (
    Array.isArray(task.fields["ledgerRefs"]) ? task.fields["ledgerRefs"] : []
  ).filter(
    (entry): entry is string => typeof entry === "string" && /^goals:[A-Za-z0-9._-]+$/u.test(entry),
  );
  if (goalRefs.length !== 1 || goalRefs[0] === undefined) {
    throw new Error(`task ${taskId} must bind exactly one finalized goal`);
  }
  return goalRefs[0];
}

function assertProcessQualificationObservation(input: QualifyImplementationCandidateInput): void {
  for (const [field, value] of [
    ["roleId", input.roleId],
    ["correlationId", input.correlationId],
    ["childThreadId", input.childThreadId],
    ["expectedRunId", input.expectedRunId],
    ["promptDigest", input.promptDigest],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`implementation candidate ${field} must be non-empty`);
    }
  }
  if (input.outcome !== "completed" && input.outcome !== "transport-failed") {
    throw new Error("implementation candidate outcome is not a Codex terminal observation");
  }
  if (!Number.isInteger(input.exitStatus)) {
    throw new Error("implementation candidate exitStatus must be an integer");
  }
  attestationInstantMs(input.observedAt, "implementationCandidate.observedAt");
  if (!SHA256_DIGEST.test(input.promptDigest)) {
    throw new Error("implementation candidate promptDigest must be a SHA-256 digest");
  }
}

function stagingDeadlineAfter(durationMs: number, phase: string): number {
  const deadlineMs = Date.now() + durationMs;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new Error(`Codex store_result ${phase} deadline exceeds the safe integer range`);
  }
  return deadlineMs;
}

async function withinStagingDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  phase: string,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Codex store_result exceeded its ${phase} deadline`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Codex store_result exceeded its ${phase} deadline`)),
          remainingMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DispatchCapabilityOptions {
  readonly backend: AttestationBackend;
  readonly promptArtifactStore: PromptArtifactStore;
  readonly narrativeSource?: DispatchNarrativeSource;
  readonly now?: () => string;
  readonly randomBytes?: (count: number) => Uint8Array;
  /** Enables the implement-worker Git broker for a local project repository. */
  readonly repositoryRoot?: string;
  readonly ledgerStore?: LedgerStore;
  readonly worktreeStateDir?: string;
  /** Host-owned gate adapter; tests inject a deterministic contract dummy. */
  readonly supervisedWorkerGateRunner?: SupervisedWorkerGateRunner;
  /** Recovery authority journal; defaults to the managed registry when repository-bound. */
  readonly recoveryJournal?: CurrentRecoverySealJournalStore;
  /** Test seam for an unexpected bridge-materialization failure; production uses the ledger implementation. */
  readonly materializeGuardedRebaseBridge?: typeof materializeGuardedRebaseBridge;
  readonly implementationEvidenceStore?: ImplementationEvidenceStore;
  /** Construction-owned execution boundary; PostgreSQL hubs are metadata-only. */
  readonly implementationExecutorMode?: "local-xdg" | "metadata-only";
  /** Trusted local owner for the exact guarded-rebase successor prepared by this runtime. */
  readonly implementationSuccessorLauncher?: (input: {
    readonly prepared: DispatchPrepared;
    readonly managed: ManagedWorktreeDispatchBinding;
    readonly expectedChild: { readonly childId: string; readonly runId: string };
    readonly timeoutMs: number;
  }) => Promise<void>;
}

export type ImplementationExecutorOperation = "prepare" | "qualify" | "acquire" | "gate" | "git";

export class ImplementationExecutorUnavailableError extends Error {
  readonly code = "executor-unavailable" as const;

  constructor(readonly operation: ImplementationExecutorOperation) {
    super(
      `implementation executor unavailable for ${operation}: local XDG repository and evidence authority are required`,
    );
    this.name = "ImplementationExecutorUnavailableError";
  }
}

const PARENT_GATE_CANCELLATION_POLL_MS = 5;
const PARENT_GATE_DIAGNOSTIC_BYTE_LIMIT = 1_024;

function durableParentGateDiagnostic(error: unknown): string {
  const redacted = redactSecrets(error instanceof Error ? error.message : String(error));
  let byteCount = 0;
  let end = 0;
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteCount + characterBytes > PARENT_GATE_DIAGNOSTIC_BYTE_LIMIT) break;
    byteCount += characterBytes;
    end += character.length;
  }
  return redacted.slice(0, end);
}

function brokerResultEvidence(
  output: DispatchJSONValue,
): GitChangeBrokerResultEvidence | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("broker-capable worker result must be an object carrying receipt evidence");
  }
  const result = output as Record<string, DispatchJSONValue>;
  if (result["status"] !== "pass") return undefined;
  if (
    typeof result["taskId"] !== "string" ||
    typeof result["resultCommit"] !== "string" ||
    typeof result["branch"] !== "string" ||
    typeof result["actualWorktreePath"] !== "string" ||
    !Array.isArray(result["filesTouched"]) ||
    !result["filesTouched"].every((entry) => typeof entry === "string") ||
    !Array.isArray(result["gitReceipts"])
  ) {
    throw new Error("broker-capable passing worker result lacks a complete receipt chain");
  }
  const lineage = result["gitLineage"];
  if (lineage !== undefined) {
    if (lineage === null || typeof lineage !== "object" || Array.isArray(lineage)) {
      throw new Error("broker-capable passing worker result carries a malformed gitLineage");
    }
    const record = lineage as Readonly<Record<string, unknown>>;
    if (
      Object.keys(record).sort().join(",") !==
        ["exactTip", "guardedRebase", "kind", "ontoCommit", "rebasedStartCommit"]
          .sort()
          .join(",") ||
      record["kind"] !== "guarded-rebase" ||
      typeof record["guardedRebase"] !== "string" ||
      typeof record["ontoCommit"] !== "string" ||
      typeof record["rebasedStartCommit"] !== "string" ||
      typeof record["exactTip"] !== "boolean"
    ) {
      throw new Error("broker-capable passing worker result carries a malformed gitLineage");
    }
  }
  return {
    taskId: result["taskId"],
    resultCommit: result["resultCommit"] as string,
    branch: result["branch"],
    actualWorktreePath: result["actualWorktreePath"],
    filesTouched: result["filesTouched"] as string[],
    gitReceipts: result["gitReceipts"] as unknown as GitChangeBrokerResultEvidence["gitReceipts"],
    ...(lineage === undefined
      ? {}
      : {
          gitLineage: lineage as unknown as NonNullable<
            GitChangeBrokerResultEvidence["gitLineage"]
          >,
        }),
  };
}

function guardedRebaseLineageOf(bridge: {
  readonly guardedRebase: string;
  readonly oldResultCommit: string;
  readonly ontoCommit: string;
  readonly rebasedStartCommit: string;
  readonly exactTip: boolean;
}): DispatchJSONValue {
  return {
    guardedRebase: bridge.guardedRebase,
    oldResultCommit: bridge.oldResultCommit,
    ontoCommit: bridge.ontoCommit,
    rebasedStartCommit: bridge.rebasedStartCommit,
    exactTip: bridge.exactTip,
  } as unknown as DispatchJSONValue;
}

function conflictResultEvidence(output: DispatchJSONValue): GitConflictContinuationResultEvidence {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("broker-capable resolver result must carry conflict receipt evidence");
  }
  const result = output as Record<string, DispatchJSONValue>;
  const status = result["status"];
  if (
    (status !== "pass" && status !== "fail") ||
    typeof result["taskId"] !== "string" ||
    (status === "pass"
      ? typeof result["resultCommit"] !== "string"
      : result["resultCommit"] !== null) ||
    typeof result["branch"] !== "string" ||
    typeof result["actualWorktreePath"] !== "string" ||
    !Array.isArray(result["filesResolved"]) ||
    !result["filesResolved"].every((entry) => typeof entry === "string") ||
    !Array.isArray(result["conflictReceipts"])
  ) {
    throw new Error("broker-capable resolver result lacks complete continuation receipt evidence");
  }
  return {
    taskId: result["taskId"],
    resultCommit: result["resultCommit"] as string | null,
    branch: result["branch"],
    actualWorktreePath: result["actualWorktreePath"],
    filesResolved: result["filesResolved"] as string[],
    conflictReceipts: result[
      "conflictReceipts"
    ] as unknown as GitConflictContinuationResultEvidence["conflictReceipts"],
  };
}

/**
 * Every contract-level T976/T978 runtime handoff, mapped to the T977 path that
 * discharges it. Tests require exact key coverage so a handoff cannot disappear
 * merely because its source constant retains the historical name `DEFERRED`.
 */
export const DISPATCH_RUNTIME_DEFERRAL_DISCHARGE: ReadonlyMap<string, string> = new Map([
  [
    "live-prepare-dispatch-enforcement-path",
    "createDispatchCapability.prepare validates inline input or assembles refs before prepareDispatchOn",
  ],
  [
    "no-attestation-allocated-on-rejection-against-a-real-store",
    "typed prepare rejection returns before prepareDispatchOn; runtime and construction tests assert zero mutation",
  ],
  [
    "per-surface-claude-codex-pi-conformance",
    "dispatchCapability.test exercises the same prepare/fetch contract on claude, codex and pi",
  ],
  [
    "one-shot-child-retrieval-of-the-assembled-input-by-handle",
    "fetch_dispatch_input routes handle plus distinct input capability to fetchDispatchInputOn",
  ],
  [
    "stolen-or-foreign-capability-rejection",
    "fetchDispatchInput matches the handle-bound input-capability hash inside the namespace transaction",
  ],
  [
    "second-retrieval-failure",
    "inputMaterializedAt is compare-and-set durably and a repeated fetch throws DispatchStateConflictError",
  ],
  [
    "recorded-end-to-end-dispatch-showing-narrative-absent-from-parent-context",
    "dispatchCapability.test seeds a real ledger sentinel, passes refs only, and observes narrative only in child fetch",
  ],
]);

const DISPATCH_RUNTIME_HANDOFFS = [
  ...DISPATCH_INPUT_VALIDATION_DEFERRED,
  ...DISPATCH_REF_ASSEMBLY_DEFERRED,
].sort();
if (
  [...DISPATCH_RUNTIME_DEFERRAL_DISCHARGE.keys()].sort().join(",") !==
  DISPATCH_RUNTIME_HANDOFFS.join(",")
) {
  throw new Error("dispatch runtime deferral discharge does not cover the T976/T978 handoffs");
}

export function createDispatchCapability(options: DispatchCapabilityOptions): DispatchCapability {
  const now = options.now ?? (() => new Date().toISOString());
  const randomBytes = options.randomBytes ?? defaultDispatchRandomBytes;
  const materializeGuardedRebase =
    options.materializeGuardedRebaseBridge ?? materializeGuardedRebaseBridge;
  const namespace = options.backend.namespace;
  const implementationExecutorMode =
    options.implementationExecutorMode ??
    (namespace.backend === "postgres" ? "metadata-only" : "local-xdg");
  const localImplementationExecutorAvailable =
    implementationExecutorMode === "local-xdg" && options.repositoryRoot !== undefined;
  const implementationEvidenceAuthorityAvailable =
    options.ledgerStore !== undefined && options.implementationEvidenceStore !== undefined;

  function assertImplementationExecutor(operation: ImplementationExecutorOperation): void {
    if (
      !localImplementationExecutorAvailable ||
      ((operation === "qualify" || operation === "acquire") &&
        !implementationEvidenceAuthorityAvailable)
    ) {
      throw new ImplementationExecutorUnavailableError(operation);
    }
  }
  interface CachedPrepare {
    readonly callerFingerprint: string | undefined;
    readonly fingerprint: string;
    readonly request: PrepareDispatchRequest;
    readonly promise: Promise<DispatchPrepareAccepted>;
    reuseAfterMs?: number;
  }
  const prepares = new Map<string, CachedPrepare>();
  const preparesByHandle = new Map<string, CachedPrepare>();
  const recoveryJournal =
    options.recoveryJournal ??
    (options.repositoryRoot === undefined
      ? undefined
      : new FsCurrentRecoverySealJournalStore(
          currentRecoveryJournalRoot(options.repositoryRoot, options.worktreeStateDir),
        ));

  class JournalRecoveryRequiredError extends Error {
    constructor(readonly refusal: ReturnType<typeof journalRecoveryRequiredForFence>) {
      super("journal recovery is required for this dispatch lineage");
      this.name = "JournalRecoveryRequiredError";
    }
  }

  async function matchingFence(
    taskId: string,
    managedFingerprint: string,
  ): Promise<DispatchLineageCutoverFence | null> {
    if (recoveryJournal === undefined) return null;
    const fence = dispatchLineageFenceFromRecoveryJournal(await recoveryJournal.read(taskId));
    return fence !== null &&
      dispatchLineageFenceMatches(fence, { namespace, taskId, managedFingerprint })
      ? fence
      : null;
  }

  async function resolveDurableGuardedRebasePrior(
    binding: ManagedWorktreeDispatchBinding,
    input: Parameters<DispatchCapability["prepare"]>[0],
  ) {
    if (
      input.guardedRebase === undefined ||
      input.input === null ||
      typeof input.input !== "object" ||
      Array.isArray(input.input)
    ) {
      return null;
    }
    const record = input.input as Readonly<Record<string, DispatchJSONValue>>;
    const baseCommit = record["baseCommit"];
    const startingCommit = record["startingCommit"];
    if (typeof baseCommit !== "string" || typeof startingCommit !== "string") return null;

    const sources = await options.backend.transact({ kind: "namespace" }, (store) =>
      store.rows().flatMap((row) => {
        const priorBinding = isAttestationTombstone(row)
          ? row.terminalKind === "aborted"
            ? row.dispatchRecoveryBinding?.gitEffectBinding
            : row.terminalKind === "consumed"
              ? row.dispatchContinuationBinding?.gitEffectBinding
              : undefined
          : (row.state === "aborted" || row.state === "consumed") &&
              row.promptProvenance.roleId === "implement-worker"
            ? row.gitEffectBinding
            : undefined;
        if (
          priorBinding === undefined ||
          ![
            "taskId",
            "handleToken",
            "handleFingerprint",
            "repositoryRoot",
            "repositoryId",
            "commonDir",
            "worktreePath",
            "branch",
            "ref",
            "baseCommit",
          ].every(
            (field) =>
              priorBinding[field as keyof typeof priorBinding] ===
              binding[field as keyof ManagedWorktreeDispatchBinding],
          )
        ) {
          return [];
        }
        return [
          {
            handle: { attestationId: row.attestationId, generation: row.generation },
            priorBinding,
          },
        ];
      }),
    );
    const outcomes: (
      | {
          readonly kind: "materialized";
          readonly source: (typeof sources)[number];
          readonly bridge: Awaited<ReturnType<typeof materializeGuardedRebaseBridge>>;
        }
      | {
          readonly kind: "typed-rejection";
          readonly source: (typeof sources)[number];
          readonly rejection: GuardedRebaseRejection;
        }
      | { readonly kind: "untyped-failure"; readonly source: (typeof sources)[number] }
    )[] = [];
    for (const { handle, priorBinding } of sources) {
      try {
        const bridge = await materializeGuardedRebase({
          reference: input.guardedRebase,
          prior: { ...priorBinding, ...handle },
          current: binding,
          baseCommitInput: baseCommit,
          startingCommitInput: startingCommit,
          priorResultCommitInput:
            (record["priorResultCommit"] as string | null | undefined) ?? null,
          ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
        });
        outcomes.push({ kind: "materialized", source: { handle, priorBinding }, bridge });
      } catch (error) {
        outcomes.push(
          error instanceof GuardedRebaseRejection
            ? { kind: "typed-rejection", source: { handle, priorBinding }, rejection: error }
            : { kind: "untyped-failure", source: { handle, priorBinding } },
        );
      }
    }
    const candidates = outcomes.filter(
      (outcome): outcome is Extract<(typeof outcomes)[number], { readonly kind: "materialized" }> =>
        outcome.kind === "materialized",
    );
    if (candidates.length > 0) {
      if (candidates.length !== outcomes.length) return null;
      const sourceAttestationIds = new Set(
        candidates.map((candidate) => candidate.source.handle.attestationId),
      );
      if (sourceAttestationIds.size !== 1) return null;
      const newest = candidates.reduce((latest, candidate) =>
        candidate.source.handle.generation > latest.source.handle.generation ? candidate : latest,
      );
      return { ...newest.source, bridge: newest.bridge };
    }
    if (outcomes.length !== 1 || outcomes[0]?.kind !== "typed-rejection") {
      return null;
    }
    throw outcomes[0].rejection;
  }

  async function continuationExitsRecoveryFence(
    fence: DispatchLineageCutoverFence,
    binding: ManagedWorktreeDispatchBinding,
    continuationReference: string | undefined,
  ): Promise<boolean> {
    if (continuationReference === undefined) return false;
    try {
      const liveTip = await observeManagedWorktreeLiveTip(
        binding,
        options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
      );
      const continuation = await resolveDispatchContinuationOn(
        options.backend,
        {
          namespace,
          actor: "trusted-parent",
          continuationReference,
          gitEffectBinding: binding,
          liveTip,
        },
        { now },
      );
      return (
        continuation.reprepareOf.attestationId === fence.sourceAttestationId &&
        continuation.reprepareOf.generation === fence.lineageMaximumGeneration + 1
      );
    } catch {
      return false;
    }
  }

  async function recoveryFenceAuthorizesPrepare(
    fence: DispatchLineageCutoverFence,
    binding: ManagedWorktreeDispatchBinding,
    input: Parameters<DispatchCapability["prepare"]>[0],
  ): Promise<boolean | GuardedRebaseRejection> {
    if (dispatchLineageFenceAuthorizes(fence, input.recoveryPreparation)) return true;
    if (await continuationExitsRecoveryFence(fence, binding, input.continuation)) return true;
    return await guardedRebaseExitsRecoveryFence(fence, binding, input);
  }

  async function guardedRebaseExitsRecoveryFence(
    fence: DispatchLineageCutoverFence,
    binding: ManagedWorktreeDispatchBinding,
    input: Parameters<DispatchCapability["prepare"]>[0],
  ): Promise<boolean | GuardedRebaseRejection> {
    if (
      input.roleId !== "implement-worker" ||
      input.guardedRebase === undefined ||
      input.continuation !== undefined ||
      input.recovery !== undefined ||
      input.recoveryPreparation !== undefined ||
      input.implementationEvidenceBootstrap !== undefined ||
      input.input === null ||
      typeof input.input !== "object" ||
      Array.isArray(input.input)
    ) {
      return false;
    }
    const record = input.input as Readonly<Record<string, DispatchJSONValue>>;
    const baseCommit = record["baseCommit"];
    const startingCommit = record["startingCommit"];
    if (typeof baseCommit !== "string" || typeof startingCommit !== "string") return false;
    let resolved;
    try {
      resolved =
        input.reprepareOf === undefined
          ? await resolveDurableGuardedRebasePrior(binding, input)
          : null;
    } catch (error) {
      return error instanceof GuardedRebaseRejection ? error : false;
    }
    const reprepareOf = input.reprepareOf ?? resolved?.handle;
    const prior =
      resolved?.priorBinding ??
      (reprepareOf === undefined
        ? undefined
        : await resolveDispatchGitEffectBindingForHandleOn(options.backend, reprepareOf));
    if (
      prior === undefined ||
      reprepareOf === undefined ||
      reprepareOf.attestationId !== fence.sourceAttestationId ||
      reprepareOf.generation < fence.lineageMaximumGeneration
    )
      return false;
    try {
      await materializeGuardedRebase({
        reference: input.guardedRebase,
        prior: {
          ...prior,
          attestationId: reprepareOf.attestationId,
          generation: reprepareOf.generation,
        },
        current: binding,
        baseCommitInput: baseCommit,
        startingCommitInput: startingCommit,
        priorResultCommitInput: (record["priorResultCommit"] as string | null | undefined) ?? null,
        ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
      });
      return true;
    } catch {
      return false;
    }
  }

  function hasExclusiveLineageAuthority(
    input: Parameters<DispatchCapability["prepare"]>[0],
  ): boolean {
    const noOtherAuthority =
      input.recovery === undefined &&
      input.recoveryPreparation === undefined &&
      input.implementationEvidenceBootstrap === undefined;
    const continuation =
      noOtherAuthority &&
      input.continuation !== undefined &&
      input.reprepareOf === undefined &&
      input.guardedRebase === undefined &&
      input.recovery === undefined;
    const guardedRebase =
      noOtherAuthority && input.continuation === undefined && input.guardedRebase !== undefined;
    return continuation || guardedRebase;
  }

  function callerPrepareFingerprint(
    input: Parameters<DispatchCapability["prepare"]>[0],
  ): string | undefined {
    try {
      return dispatchPayloadDigest(input as unknown as DispatchJSONValue);
    } catch {
      return undefined;
    }
  }

  function managedPrepareCoordinates(input: Parameters<DispatchCapability["prepare"]>[0]):
    | {
        readonly repositoryRoot: string;
        readonly taskId: string;
        readonly worktreePath: string;
        readonly branch: string;
      }
    | undefined {
    if (options.repositoryRoot === undefined) return undefined;
    const request = input as unknown as Readonly<Record<string, unknown>>;
    const refs = request["refs"];
    if (refs !== null && typeof refs === "object" && !Array.isArray(refs)) {
      const record = refs as Readonly<Record<string, unknown>>;
      if (record["roleId"] !== "implement-worker") return undefined;
      const coordinates = record["coordinates"];
      if (
        typeof record["taskId"] === "string" &&
        coordinates !== null &&
        typeof coordinates === "object" &&
        !Array.isArray(coordinates)
      ) {
        const values = coordinates as Readonly<Record<string, unknown>>;
        if (typeof values["worktreePath"] === "string" && typeof values["branch"] === "string") {
          return {
            repositoryRoot: options.repositoryRoot,
            taskId: record["taskId"],
            worktreePath: values["worktreePath"],
            branch: values["branch"],
          };
        }
      }
      return undefined;
    }
    if (request["roleId"] !== "implement-worker") return undefined;
    const dispatchInput = request["input"];
    if (
      dispatchInput === null ||
      typeof dispatchInput !== "object" ||
      Array.isArray(dispatchInput)
    ) {
      return undefined;
    }
    const record = dispatchInput as Readonly<Record<string, unknown>>;
    if (
      typeof record["taskId"] !== "string" ||
      typeof record["worktreePath"] !== "string" ||
      typeof record["branch"] !== "string"
    ) {
      return undefined;
    }
    return {
      repositoryRoot: options.repositoryRoot,
      taskId: record["taskId"],
      worktreePath: record["worktreePath"],
      branch: record["branch"],
    };
  }

  async function revalidateManagedPrepareBinding(
    binding: ManagedWorktreeDispatchBinding,
    allowDetachedRebase: boolean,
  ): Promise<ManagedWorktreeDispatchBinding | null> {
    const revalidated = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: binding.repositoryRoot,
        taskId: binding.taskId,
        worktreePath: binding.worktreePath,
        branch: binding.branch,
        ...(allowDetachedRebase ? { allowDetachedRebase: true } : {}),
      },
      options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
    );
    return revalidated !== null &&
      revalidated.handleToken === binding.handleToken &&
      revalidated.handleFingerprint === binding.handleFingerprint
      ? revalidated
      : null;
  }

  async function durableCachedWorkerBinding(
    idempotencyKey: string,
  ): Promise<ManagedWorktreeDispatchBinding | undefined> {
    const cached = prepares.get(idempotencyKey);
    if (cached === undefined) return undefined;
    const accepted = await cached.promise;
    const binding = await resolveDispatchGitEffectBindingForHandleOn(
      options.backend,
      accepted.handle,
    );
    return binding?.conflictStateDigest === undefined ? binding : undefined;
  }

  function cacheHandleKey(handle: {
    readonly attestationId: string;
    readonly generation: number;
  }): string {
    return `${handle.attestationId}#${handle.generation}`;
  }

  function rememberTerminal(
    handle: { readonly attestationId: string; readonly generation: number },
    terminalAt: string,
  ): void {
    const cached = preparesByHandle.get(cacheHandleKey(handle));
    if (cached !== undefined) {
      cached.reuseAfterMs = attestationInstantMs(terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS;
    }
  }

  async function cachedPrepareRemainsHeld(
    idempotencyKey: string,
    accepted: DispatchPrepareAccepted,
    cached: CachedPrepare,
  ): Promise<boolean> {
    const readAtMs = () => attestationInstantMs(now(), "now");
    return await options.backend.transact({ kind: "handle", handle: accepted.handle }, (store) => {
      const row = store.read(accepted.handle);
      if (row === undefined) {
        if (cached.reuseAfterMs !== undefined && readAtMs() >= cached.reuseAfterMs) {
          return false;
        }
        throw new DispatchStateConflictError(
          "prepare_dispatch",
          "prepared",
          `cached prepare replay for "${idempotencyKey}" lost its durable row before its reuse horizon`,
        );
      }
      if (isAttestationTombstone(row)) {
        const reuseAfterMs = attestationInstantMs(row.reuseAfter, "reuseAfter");
        cached.reuseAfterMs = reuseAfterMs;
        if (readAtMs() >= reuseAfterMs) {
          return false;
        }
        throw new DispatchStateConflictError(
          "prepare_dispatch",
          "terminal-envelope-expired",
          `cached prepare replay for "${idempotencyKey}" no longer matches its durable row`,
        );
      }
      if (row.terminalAt !== undefined) {
        const reuseAfterMs =
          attestationInstantMs(row.terminalAt, "terminalAt") + IDEMPOTENCY_HORIZON_MS;
        cached.reuseAfterMs = reuseAfterMs;
        if (readAtMs() >= reuseAfterMs) {
          return false;
        }
      }
      if (
        row.idempotencyKey !== idempotencyKey ||
        row.promptProvenance.inputDigest !== accepted.prepared.promptProvenance.inputDigest ||
        row.prepareRequestDigest !==
          prepareDispatchRequestDigest({ ...cached.request, input: row.input })
      ) {
        throw new DispatchStateConflictError(
          "prepare_dispatch",
          row.state,
          `cached prepare replay for "${idempotencyKey}" no longer matches its durable row`,
        );
      }
      return true;
    });
  }

  async function replayCachedPrepare(
    idempotencyKey: string,
    fingerprint: string,
    fingerprintKind: "caller" | "resolved",
  ): Promise<DispatchPrepareAccepted | undefined> {
    while (true) {
      const existing = prepares.get(idempotencyKey);
      if (existing === undefined) return undefined;
      const accepted = await existing.promise;
      if (await cachedPrepareRemainsHeld(idempotencyKey, accepted, existing)) {
        const existingFingerprint =
          fingerprintKind === "caller" ? existing.callerFingerprint : existing.fingerprint;
        if (existingFingerprint !== fingerprint) {
          throw new AttestationKeyReuseError(idempotencyKey, accepted.handle);
        }
        return accepted;
      }
      if (prepares.get(idempotencyKey) === existing) {
        prepares.delete(idempotencyKey);
        preparesByHandle.delete(cacheHandleKey(accepted.handle));
      }
    }
  }

  function rejectLaunch(path: string, detail: string): DispatchPreLaunchRejection {
    return dispatchPreLaunchRejection("invalid-launch-envelope", path, detail);
  }

  async function abortWithRecovery(
    input: {
      readonly attestationId: string;
      readonly generation: number;
      readonly reason: Parameters<typeof abortDispatchOn>[1]["reason"];
      readonly details?: DispatchJSONValue;
    },
    binding: Awaited<ReturnType<typeof resolveDispatchGitEffectBindingForHandleOn>>,
    lockHeld = false,
  ) {
    const abort = async () => {
      let recoveryContext;
      if (
        input.reason === "parent-lost" &&
        binding !== undefined &&
        binding.conflictStateDigest === undefined
      ) {
        const liveTip = await observeManagedWorktreeLiveTip(
          binding,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        const gitReceipts = await resolveInheritedGitChangeReceipts(
          {
            ...binding,
            attestationId: input.attestationId,
            generation: input.generation,
          },
          liveTip,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        recoveryContext = { liveTip, gitReceipts };
      }
      return await abortDispatchOn(
        options.backend,
        {
          namespace,
          actor: "trusted-parent",
          ...input,
          ...(recoveryContext === undefined ? {} : { recoveryContext }),
        },
        { now },
      );
    };
    if (binding === undefined || lockHeld) return await abort();
    return await withManagedWorktreeEffectLock(
      binding,
      options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
      abort,
    );
  }

  async function parentGateCancellationForEpoch(
    handle: { readonly attestationId: string; readonly generation: number },
    gateEpoch: number,
  ): Promise<NonNullable<AttestationEnvelope["parentGateCancellationRequest"]> | undefined> {
    return await options.backend.transact({ kind: "handle", handle }, (store) => {
      const row = store.read(handle);
      if (row === undefined || isAttestationTombstone(row)) return undefined;
      const cancellation = row.parentGateCancellationRequest;
      return cancellation?.gateEpoch === gateEpoch ? cancellation : undefined;
    });
  }

  async function superviseClaimedParentGate(
    handle: { readonly attestationId: string; readonly generation: number },
    binding: ManagedWorktreeDispatchBinding,
    claimed: {
      readonly gateEpoch: number;
      readonly output: DispatchJSONValue;
      readonly context: Parameters<typeof superviseImplementWorkerGate>[0]["context"];
    },
    complete: (
      output: DispatchJSONValue,
    ) => Promise<Awaited<ReturnType<typeof completeParentGateOn>>>,
  ) {
    const cancellation = new AbortController();
    let stopCancellationObserver = false;
    let cancellationObserverError: unknown;
    const cancellationObserver = (async () => {
      while (!stopCancellationObserver) {
        try {
          if ((await parentGateCancellationForEpoch(handle, claimed.gateEpoch)) !== undefined) {
            cancellation.abort();
            return;
          }
        } catch (error) {
          cancellationObserverError = error;
          cancellation.abort();
          return;
        }
        await Bun.sleep(PARENT_GATE_CANCELLATION_POLL_MS);
      }
    })();
    let output: DispatchJSONValue | undefined;
    let gateError: unknown;
    try {
      output = await superviseImplementWorkerGate(
        { context: claimed.context, output: claimed.output },
        {
          ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
          ...(options.supervisedWorkerGateRunner === undefined
            ? {}
            : { runner: options.supervisedWorkerGateRunner }),
          cancellationSignal: cancellation.signal,
        },
      );
    } catch (error) {
      gateError = error;
    } finally {
      stopCancellationObserver = true;
      await cancellationObserver;
    }

    const requestedCancellation = await parentGateCancellationForEpoch(handle, claimed.gateEpoch);
    if (requestedCancellation !== undefined) {
      const result = await abortWithRecovery(
        {
          ...handle,
          reason: requestedCancellation.reason,
          ...(requestedCancellation.details === undefined
            ? {}
            : { details: requestedCancellation.details }),
        },
        binding,
        true,
      );
      return Object.freeze({ state: "aborted" as const, result });
    }
    if (cancellationObserverError !== undefined) throw cancellationObserverError;
    if (gateError !== undefined) {
      if (gateError instanceof SupervisedWorkerGateRejectedError) {
        let details = gateError.details;
        const diagnostic = gateError.durableDiagnostic();
        if (diagnostic !== undefined) {
          const putLog = ledgerLogWriter(options.ledgerStore);
          if (putLog === undefined) {
            throw new Error(
              "supervised worker gate rejection requires durable ledger log storage",
              { cause: gateError },
            );
          }
          await putLog(diagnostic.storagePath, diagnostic.content);
          details = diagnostic.details;
        }
        const rejected = await abortWithRecovery(
          {
            ...handle,
            reason: "gate-rejected",
            details: details as unknown as DispatchJSONValue,
          },
          binding,
          true,
        );
        return Object.freeze({ state: "aborted" as const, result: rejected });
      }
      const message = gateError instanceof Error ? gateError.message : String(gateError);
      try {
        await abortWithRecovery(
          {
            ...handle,
            reason: "parent-lost",
            details: { phase: "supervised-gate", message: durableParentGateDiagnostic(gateError) },
          },
          binding,
          true,
        );
      } catch (abortError) {
        const abortMessage = abortError instanceof Error ? abortError.message : String(abortError);
        throw new Error(`${message}; parent-lost terminalization failed: ${abortMessage}`, {
          cause: abortError,
        });
      }
      throw gateError;
    }
    if (output === undefined) {
      throw new Error("supervised parent gate produced no output and no failure");
    }
    try {
      const result = await complete(output);
      return Object.freeze({ state: "result-stored" as const, result });
    } catch (error) {
      const racedCancellation = await parentGateCancellationForEpoch(handle, claimed.gateEpoch);
      if (racedCancellation === undefined) throw error;
      const result = await abortWithRecovery(
        {
          ...handle,
          reason: racedCancellation.reason,
          ...(racedCancellation.details === undefined
            ? {}
            : { details: racedCancellation.details }),
        },
        binding,
        true,
      );
      return Object.freeze({ state: "aborted" as const, result });
    }
  }

  const implementationCandidateQueue = new ImplementationCandidateQueueAdapter({
    backend: options.backend,
    actor: "trusted-extension",
    now,
  });

  async function isQualifiedImplementationFrontSettled(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
  }): Promise<boolean> {
    return await options.backend.transact(
      { kind: "handle", handle: input.lease },
      (store): boolean => {
        const row = store.read(input.lease);
        if (row === undefined || isAttestationTombstone(row)) {
          throw new Error("qualified implementation front disappeared before settlement replay");
        }
        if (row.state !== "consumed") return false;
        const control = row.implementationQueue;
        const output = dispatchObject(row.output) ? row.output : undefined;
        const gate = output === undefined ? undefined : output["supervisedGateEvidence"];
        const validationIntent = dispatchObject(row.input)
          ? row.input["validationIntent"]
          : undefined;
        const focusedChecks = Array.isArray(output?.["focusedChecks"])
          ? output["focusedChecks"]
          : undefined;
        const focusedSettled =
          validationIntent === "focused-only" &&
          gate === undefined &&
          focusedChecks !== undefined &&
          focusedChecks.length > 0;
        if (
          control === undefined ||
          control.state !== "leased" ||
          control.qualification === undefined ||
          control.lease === undefined ||
          row.stagedCompletionQualification?.qualificationDigest !==
            control.qualification.qualificationDigest ||
          input.lease.partitionKey !== control.partition.partitionKey ||
          input.lease.enrollmentId !== control.enrollment.enrollmentId ||
          input.lease.attemptId !== control.attempt.attemptId ||
          input.lease.holderId !== control.lease.holderId ||
          input.lease.leaseGeneration !== control.lease.generation ||
          output?.["status"] !== "pass" ||
          output["taskId"] !== control.attempt.taskId ||
          output["resultCommit"] !== control.attempt.resultCommit ||
          (!focusedSettled &&
            (!dispatchObject(gate) ||
              !validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, gate).ok ||
              gate["taskId"] !== control.attempt.taskId ||
              gate["resultCommit"] !== control.attempt.resultCommit ||
              gate["worktreePath"] !== control.attempt.worktreePath ||
              gate["command"] !== control.attempt.gateCommand))
        ) {
          throw new Error("consumed implementation front lost its exact gate and lease authority");
        }
        return true;
      },
    );
  }

  async function finalizeQualifiedImplementationFront(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
  }): Promise<void> {
    const binding = await resolveDispatchGitEffectBindingForHandleOn(options.backend, input.lease);
    if (binding === undefined) {
      throw new Error("qualified implementation front requires a managed worktree binding");
    }
    await withManagedWorktreeEffectLock(
      binding,
      {
        ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
        effectLockTimeoutMs: CODEX_STAGED_TIMING_BASIS.parentEffectLockAcquisitionMs,
      },
      async () => {
        const claimed = await claimQualifiedParentGateOn(
          options.backend,
          { ...input.lease, queueLease: input.lease },
          { now },
        );
        if (claimed.state === "result-stored") return;
        if (claimed.state === "aborted") {
          throw new Error(`qualified implementation front gate is ${claimed.result.reason}`);
        }
        await superviseClaimedParentGate(
          input.lease,
          binding,
          claimed,
          async (output) =>
            await completeQualifiedParentGateOn(
              options.backend,
              {
                ...input.lease,
                queueLease: input.lease,
                gateEpoch: claimed.gateEpoch,
                output,
              },
              { now },
            ),
        );
      },
    );
  }

  async function confirmQualifiedImplementationFront(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly nativeCompletion: Parameters<
      DispatchCapability["confirmCompletion"]
    >[0]["nativeCompletion"];
  }): Promise<void> {
    if (input.control.qualification === undefined) {
      throw new Error("qualified implementation front lost its completion qualification");
    }
    const binding = await resolveDispatchGitEffectBindingForHandleOn(options.backend, input.lease);
    const confirm = async () => {
      let continuationContext;
      if (binding !== undefined && binding.conflictStateDigest === undefined) {
        const liveTip = await observeManagedWorktreeLiveTip(
          binding,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        const gitReceipts = await resolveInheritedGitChangeReceipts(
          { ...binding, ...input.lease },
          liveTip,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        continuationContext = { liveTip, gitReceipts };
      }
      return await confirmDispatchCompletionOn(
        options.backend,
        {
          namespace,
          attestationId: input.lease.attestationId,
          generation: input.lease.generation,
          nativeCompletion: input.nativeCompletion,
          expectedProvenance: input.control.qualification!.expectedProvenance,
          ...(continuationContext === undefined ? {} : { continuationContext }),
        },
        { now },
      );
    };
    const confirmation =
      binding === undefined
        ? await confirm()
        : await withManagedWorktreeEffectLock(
            binding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
            confirm,
          );
    if (confirmation.state !== "consumed") {
      throw new Error(`qualified implementation front confirmed as ${confirmation.state}`);
    }
    rememberTerminal(confirmation.result, confirmation.result.consumedAt);
  }

  async function retireAndRebaseStaleImplementationFront(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly ontoCommit: string;
  }): Promise<{ readonly sourceReference: string; readonly conflictPending?: true }> {
    if (options.repositoryRoot === undefined || options.ledgerStore === undefined) {
      throw new Error(
        "stale implementation candidate coordination requires a local repository and task ledger",
      );
    }
    const sourceRow = await options.backend.transact(
      { kind: "handle", handle: input.lease },
      (store): AttestationEnvelope => {
        const row = store.read(input.lease);
        if (row === undefined || isAttestationTombstone(row)) {
          throw new Error("stale implementation candidate source disappeared");
        }
        return row;
      },
    );
    const dispatchBinding = sourceRow.gitEffectBinding;
    if (dispatchBinding === undefined) {
      throw new Error("stale implementation candidate has no managed worktree binding");
    }
    const managed = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: dispatchBinding.repositoryRoot,
        taskId: dispatchBinding.taskId,
        worktreePath: dispatchBinding.worktreePath,
        branch: dispatchBinding.branch,
        allowDetachedRebase: true,
      },
      options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
    );
    if (
      managed === null ||
      managed.handleToken !== dispatchBinding.handleToken ||
      managed.handleFingerprint !== dispatchBinding.handleFingerprint
    ) {
      throw new Error("stale implementation candidate managed worktree authority changed");
    }
    const liveTip = await readOnlyGit(dispatchBinding.worktreePath, ["rev-parse", "HEAD"]);
    const clean =
      (await readOnlyGitAllowEmpty(dispatchBinding.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])) === "";
    if (!clean || liveTip !== input.control.attempt.resultCommit) {
      throw new Error("stale implementation candidate is no longer the clean staged result");
    }
    const operationId = `implementation-rebase-${dispatchPayloadDigest({
      enrollmentId: input.control.enrollment.enrollmentId,
      attemptId: input.control.attempt.attemptId,
    }).slice(0, 32)}`;
    const expected = Object.freeze({
      kind: "rebase" as const,
      targetRef: `tasks:${dispatchBinding.taskId}`,
      repositoryRoot: dispatchBinding.repositoryRoot,
      worktreePath: dispatchBinding.worktreePath,
      ontoCommit: input.ontoCommit,
    });
    const resolveExpected = async () => {
      await assertManagedWorktreeDispatchBindingLive(
        managed,
        options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
      );
      if (
        (await readProtectedIntegrationHead(
          dispatchBinding.repositoryRoot,
          input.control.partition.integrationRef,
        )) !== input.ontoCommit
      ) {
        throw new Error("stale implementation candidate protected head moved before rebase");
      }
      return expected;
    };
    let source:
      | Awaited<ReturnType<ImplementationCandidateQueueAdapter["retireStagedRebaseSource"]>>
      | undefined;
    const rebase = await runGuardedRebase({
      binding: managed,
      operationId,
      ontoCommit: input.ontoCommit,
      ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
      onIntent: async ({ reference, requestDigest }) => {
        source = await implementationCandidateQueue.retireStagedRebaseSource({
          ...input.lease,
          expectedPartitionRevision: input.control.partitionRevision,
          stagedOutputDigest: input.control.qualification!.outputDigest,
          effectLock: {
            kind: "managed-worktree-effect-lock",
            bindingDigest: input.control.attempt.managedWorktreeBindingDigest,
          },
          live: {
            clean,
            liveTip,
            resultCommit: input.control.attempt.resultCommit,
            resultTree: input.control.attempt.resultTree,
            repositoryId: input.control.attempt.repositoryId,
            worktreePath: input.control.attempt.worktreePath,
            gitReceipts: input.control.attempt.gitReceipts,
          },
          ontoCommit: input.ontoCommit,
          guardedRebase: reference,
          guardedRebaseJournalDigest: requestDigest,
        });
      },
      runEffect: async () =>
        await runLedgerWorksetGitEffect({
          store: options.ledgerStore!,
          expected,
          resolve: resolveExpected,
        }),
    });
    if (source === undefined) {
      throw new Error("stale implementation candidate rebase did not retire its source");
    }
    return Object.freeze({
      sourceReference: source.sourceReference,
      ...(rebase.kind === "conflict-pending" ? { conflictPending: true as const } : {}),
    });
  }

  interface RetiredStagedRebaseContext {
    readonly source: PendingStagedRebaseCheckpoint["source"];
    readonly control: PendingStagedRebaseCheckpoint["control"];
    readonly sourceRow: AttestationEnvelope;
    readonly managed: ManagedWorktreeDispatchBinding;
  }

  async function loadRetiredStagedRebaseContext(
    sourceReference: string,
  ): Promise<RetiredStagedRebaseContext> {
    const checkpoint = await options.backend.transact(
      { kind: "namespace" },
      (store): Omit<RetiredStagedRebaseContext, "managed"> => {
        const matches = store
          .rows()
          .filter((row): row is AttestationEnvelope => !isAttestationTombstone(row))
          .flatMap((row) => {
            const control = row.implementationQueue;
            const source = row.stagedRebaseSourceBinding ?? control?.stagedRebaseSource;
            return control?.state === "staged-rebase-retired" &&
              source?.sourceReference === sourceReference
              ? [{ source, control, sourceRow: row }]
              : [];
          });
        if (matches.length !== 1) {
          throw new Error("staged-rebase source does not resolve to one durable checkpoint");
        }
        return matches[0]!;
      },
    );
    const binding = checkpoint.sourceRow.gitEffectBinding;
    if (binding === undefined) {
      throw new Error("retired staged-rebase source lost its managed worktree binding");
    }
    const managed = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: binding.repositoryRoot,
        taskId: binding.taskId,
        worktreePath: binding.worktreePath,
        branch: binding.branch,
        allowDetachedRebase: true,
      },
      options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
    );
    if (
      managed === null ||
      managed.handleToken !== binding.handleToken ||
      managed.handleFingerprint !== binding.handleFingerprint
    ) {
      throw new Error("retired staged-rebase managed worktree authority changed");
    }
    return Object.freeze({ ...checkpoint, managed });
  }

  async function reconcileRetiredStagedRebase(context: RetiredStagedRebaseContext) {
    if (options.ledgerStore === undefined) {
      throw new Error("staged-rebase recovery requires the task ledger");
    }
    const operationId = `implementation-rebase-${dispatchPayloadDigest({
      enrollmentId: context.control.enrollment.enrollmentId,
      attemptId: context.control.attempt.attemptId,
    }).slice(0, 32)}`;
    const expected = Object.freeze({
      kind: "rebase" as const,
      targetRef: `tasks:${context.managed.taskId}`,
      repositoryRoot: context.managed.repositoryRoot,
      worktreePath: context.managed.worktreePath,
      ontoCommit: context.source.ontoCommit,
    });
    return await runGuardedRebase({
      binding: context.managed,
      operationId,
      ontoCommit: context.source.ontoCommit,
      ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
      runEffect: async () =>
        await runLedgerWorksetGitEffect({
          store: options.ledgerStore!,
          expected,
          resolve: async () => {
            await assertManagedWorktreeDispatchBindingLive(
              context.managed,
              options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
            );
            if (
              (await readProtectedIntegrationHead(
                context.managed.repositoryRoot,
                context.control.partition.integrationRef,
              )) !== context.source.ontoCommit
            ) {
              throw new Error("stale implementation candidate protected head moved before rebase");
            }
            return expected;
          },
        }),
    });
  }

  async function rebaseRetiredImplementationFront(input: {
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly retirement: { readonly sourceReference: string };
    readonly ontoCommit: string;
  }): Promise<{ readonly guardedRebase: string }> {
    const context = await loadRetiredStagedRebaseContext(input.retirement.sourceReference);
    if (
      context.control.attempt.attemptId !== input.control.attempt.attemptId ||
      context.source.ontoCommit !== input.ontoCommit
    ) {
      throw new Error("stale implementation candidate rebase checkpoint changed");
    }
    const rebase = await reconcileRetiredStagedRebase(context);
    if (rebase.kind !== "finalized") {
      throw new Error("stale implementation candidate rebase remains conflict-pending");
    }
    return Object.freeze({ guardedRebase: rebase.reference });
  }

  async function prepareRetiredStagedRebaseSuccessor(
    context: RetiredStagedRebaseContext,
    guardedRebase: string,
    rebasedStartCommit: string,
  ): Promise<{ readonly attestationId: string; readonly generation: number }> {
    if (
      context.sourceRow.input === null ||
      typeof context.sourceRow.input !== "object" ||
      Array.isArray(context.sourceRow.input)
    ) {
      throw new Error("stale implementation candidate source input is malformed");
    }
    const sourceInput = context.sourceRow.input as Readonly<Record<string, DispatchJSONValue>>;
    const round = sourceInput["round"];
    if (!Number.isSafeInteger(round) || (round as number) < 0) {
      throw new Error("stale implementation candidate source round is malformed");
    }
    const { guardedRebaseLineage: _guardedRebaseLineage, ...retainedInput } = sourceInput;
    const timeoutMs =
      attestationInstantMs(context.sourceRow.deadlines.childCancelAt, "deadlines.childCancelAt") -
      attestationInstantMs(context.sourceRow.createdAt, "createdAt");
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        ...retainedInput,
        baseCommit: context.source.ontoCommit,
        startingCommit: rebasedStartCommit,
        priorResultCommit: context.control.attempt.resultCommit,
        round: (round as number) + 1,
      },
      idempotencyKey: `implementation-successor-${dispatchPayloadDigest({
        sourceReference: context.source.sourceReference,
        guardedRebase,
      })}`,
      timeoutMs,
      expectedChild: context.sourceRow.expectedChild,
      reprepareOf: context.source.source,
      guardedRebase,
    });
    if (!prepared.accepted) {
      throw new Error(`stale implementation candidate successor was refused: ${prepared.detail}`);
    }
    if (options.implementationSuccessorLauncher !== undefined) {
      await options.implementationSuccessorLauncher({
        prepared: prepared.prepared,
        managed: context.managed,
        expectedChild: context.sourceRow.expectedChild,
        timeoutMs,
      });
    }
    return Object.freeze({ ...prepared.handle });
  }

  async function prepareStaleImplementationSuccessor(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly retirement: { readonly sourceReference: string };
    readonly rebase: { readonly guardedRebase: string };
    readonly ontoCommit: string;
  }): Promise<{ readonly attestationId: string; readonly generation: number }> {
    const context = await loadRetiredStagedRebaseContext(input.retirement.sourceReference);
    if (
      context.control.attempt.attemptId !== input.control.attempt.attemptId ||
      context.source.guardedRebase !== input.rebase.guardedRebase ||
      context.source.ontoCommit !== input.ontoCommit
    ) {
      throw new Error("stale implementation candidate successor checkpoint changed");
    }
    const rebase = await reconcileRetiredStagedRebase(context);
    if (rebase.kind !== "finalized" || rebase.reference !== input.rebase.guardedRebase) {
      throw new Error("stale implementation candidate successor rebase is not finalized");
    }
    return await prepareRetiredStagedRebaseSuccessor(
      context,
      rebase.reference,
      rebase.bridge.rebasedStartCommit,
    );
  }

  async function reconcileRetiredImplementationSource(
    input: PendingStagedRebaseCheckpoint,
  ): Promise<
    | { readonly state: "conflict-pending" }
    | {
        readonly state: "successor-queued";
        readonly successor: { readonly attestationId: string; readonly generation: number };
      }
  > {
    const context = await loadRetiredStagedRebaseContext(input.source.sourceReference);
    if (context.source.successor !== undefined) {
      return Object.freeze({
        state: "successor-queued" as const,
        successor: Object.freeze({ ...context.source.successor }),
      });
    }
    const rebase = await reconcileRetiredStagedRebase(context);
    if (rebase.kind !== "finalized") {
      return Object.freeze({ state: "conflict-pending" as const });
    }
    const successor = await prepareRetiredStagedRebaseSuccessor(
      context,
      rebase.reference,
      rebase.bridge.rebasedStartCommit,
    );
    return Object.freeze({ state: "successor-queued" as const, successor });
  }

  const implementationCandidateCoordinatorOperations: ImplementationCandidateCoordinatorOperations =
    {
      isQualifiedFrontSettled: isQualifiedImplementationFrontSettled,
      reconcileRetiredSource: reconcileRetiredImplementationSource,
      observeProtectedHead: async (control) => {
        if (options.repositoryRoot === undefined) {
          throw new Error("implementation candidate coordinator requires a local repository root");
        }
        return await readProtectedIntegrationHead(
          options.repositoryRoot,
          control.partition.integrationRef,
        );
      },
      finalizeQualifiedFront: finalizeQualifiedImplementationFront,
      confirmQualifiedFront: confirmQualifiedImplementationFront,
      retireStaleSource: retireAndRebaseStaleImplementationFront,
      rebaseRetiredSource: rebaseRetiredImplementationFront,
      prepareSuccessor: prepareStaleImplementationSuccessor,
    };
  const implementationCandidateCoordinator = new ImplementationCandidateCoordinator(
    implementationCandidateQueue,
    implementationCandidateCoordinatorOperations,
  );

  async function resolveImplementationCandidateAuthority(input: {
    readonly workerDispatch: { readonly attestationId: string; readonly generation: number };
    readonly taskRef: string;
    readonly resultCommit: string;
  }): Promise<ImplementationCandidateAuthorityReceipt> {
    if (options.repositoryRoot === undefined || options.ledgerStore === undefined) {
      throw new Error("implementation candidate authority requires a repository and task ledger");
    }
    const taskId = input.taskRef.startsWith("tasks:") ? input.taskRef.slice("tasks:".length) : "";
    if (!/^T[0-9]+$/u.test(taskId) || !FULL_GIT_SHA.test(input.resultCommit)) {
      throw new Error("implementation candidate authority target is malformed");
    }
    const resolved = await options.backend.transact({ kind: "namespace" }, (store) => {
      const row = store.read(input.workerDispatch);
      if (row === undefined || isAttestationTombstone(row)) {
        throw new Error("implementation candidate authority requires a live durable dispatch");
      }
      const control = row.implementationQueue;
      const output = row.output;
      const gate = dispatchObject(output) ? output["supervisedGateEvidence"] : undefined;
      if (
        row.state !== "consumed" ||
        control === undefined ||
        control.state !== "leased" ||
        control.qualification === undefined ||
        control.lease === undefined ||
        !dispatchObject(output) ||
        output["status"] !== "pass" ||
        output["taskId"] !== taskId ||
        output["resultCommit"] !== input.resultCommit ||
        !dispatchObject(gate) ||
        !validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, gate).ok ||
        gate["taskId"] !== taskId ||
        gate["resultCommit"] !== input.resultCommit ||
        gate["worktreePath"] !== control.attempt.worktreePath ||
        gate["command"] !== control.attempt.gateCommand ||
        control.attempt.resultCommit !== input.resultCommit ||
        control.attempt.taskId !== taskId ||
        control.enrollment.taskId !== taskId
      ) {
        throw new Error("implementation candidate lacks an exact consumed green-gate identity");
      }
      const activeEnrollmentRows = store.rows().filter((candidate) => {
        if (isAttestationTombstone(candidate)) return false;
        const queue = candidate.implementationQueue;
        return (
          queue !== undefined &&
          queue.enrollment.enrollmentId === control.enrollment.enrollmentId &&
          !["released", "terminal", "staged-rebase-retired"].includes(queue.state)
        );
      });
      const liveLeaseRows = store.rows().filter((candidate) => {
        if (isAttestationTombstone(candidate)) return false;
        const queue = candidate.implementationQueue;
        return (
          queue?.partition.partitionKey === control.partition.partitionKey &&
          queue.state === "leased"
        );
      });
      if (
        activeEnrollmentRows.length !== 1 ||
        activeEnrollmentRows[0]?.attestationId !== row.attestationId ||
        activeEnrollmentRows[0]?.generation !== row.generation ||
        liveLeaseRows.length !== 1 ||
        liveLeaseRows[0]?.attestationId !== row.attestationId ||
        liveLeaseRows[0]?.generation !== row.generation
      ) {
        throw new Error("implementation candidate is not the unique active leased successor");
      }
      if (row.gitEffectBinding === undefined) {
        throw new Error("implementation candidate lost its managed worktree binding");
      }
      return {
        row,
        control,
        gate: gate as DispatchJSONValue,
        binding: row.gitEffectBinding,
      };
    });
    const taskEvidence = currentRecoveryTaskEvidence(options.ledgerStore, taskId);
    if (
      currentRecoveryTaskSpecificationDigest(resolved.row.input) !==
        taskEvidence.taskSpecificationDigest ||
      resolved.control.enrollment.goalRef !== exactGoalRef(options.ledgerStore, taskId) ||
      resolved.control.enrollment.finalizedManifestDigest !== taskEvidence.finalizedManifestDigest
    ) {
      throw new Error("implementation candidate task, goal, or finalized manifest changed");
    }
    await assertManagedWorktreeDispatchBindingLive(
      resolved.binding,
      options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
    );
    if (
      dispatchPayloadDigest(resolved.binding as unknown as DispatchJSONValue) !==
        resolved.control.attempt.managedWorktreeBindingDigest ||
      resolved.binding.taskId !== taskId ||
      resolved.binding.repositoryId !== resolved.control.attempt.repositoryId ||
      resolved.binding.worktreePath !== resolved.control.attempt.worktreePath
    ) {
      throw new Error("implementation candidate managed worktree authority changed");
    }
    const [liveTip, worktreeStatus, protectedHead] = await Promise.all([
      readOnlyGit(resolved.binding.worktreePath, ["rev-parse", "HEAD"]),
      readOnlyGitAllowEmpty(resolved.binding.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]),
      readProtectedIntegrationHead(
        resolved.binding.repositoryRoot,
        resolved.control.partition.integrationRef,
      ),
    ]);
    if (
      liveTip !== input.resultCommit ||
      worktreeStatus !== "" ||
      protectedHead !== resolved.control.attempt.observedBaseCommit
    ) {
      throw new Error("implementation candidate code, tree, or integration base changed");
    }
    return Object.freeze({
      kind: "cq-implementation-candidate-authority" as const,
      version: 1 as const,
      workerDispatch: Object.freeze({ ...input.workerDispatch }),
      partitionKey: resolved.control.partition.partitionKey,
      enrollmentId: resolved.control.enrollment.enrollmentId,
      attemptId: resolved.control.attempt.attemptId,
      leaseHolderId: resolved.control.lease!.holderId,
      leaseGeneration: resolved.control.lease!.generation,
      qualificationDigest: resolved.control.qualification!.qualificationDigest,
      taskRef: input.taskRef,
      taskDigest: taskEvidence.taskDigest,
      goalRef: resolved.control.enrollment.goalRef,
      finalizedManifestDigest: taskEvidence.finalizedManifestDigest,
      integrationRef: resolved.control.partition.integrationRef,
      repositoryId: resolved.control.attempt.repositoryId,
      worktreePath: resolved.control.attempt.worktreePath,
      resultCommit: resolved.control.attempt.resultCommit,
      resultTree: resolved.control.attempt.resultTree,
      gateCommand: resolved.control.attempt.gateCommand,
      packagedEnvironmentDigest: resolved.control.attempt.packagedEnvironmentDigest,
      managedWorktreeBindingDigest: resolved.control.attempt.managedWorktreeBindingDigest,
      gitReceiptLineageDigest: resolved.control.attempt.gitReceiptLineageDigest,
      gateEvidenceDigest: dispatchPayloadDigest(resolved.gate),
    });
  }

  async function reserveImplementationCandidateAuthority(
    receipt: ImplementationCandidateAuthorityReceipt,
    binding: ImplementationCandidateCompletionReservationBinding,
  ): Promise<void> {
    const current = await resolveImplementationCandidateAuthority({
      workerDispatch: receipt.workerDispatch,
      taskRef: receipt.taskRef,
      resultCommit: receipt.resultCommit,
    });
    if (
      dispatchPayloadDigest(current as unknown as DispatchJSONValue) !==
      dispatchPayloadDigest(receipt as unknown as DispatchJSONValue)
    ) {
      throw new Error("implementation candidate authority changed before completion reservation");
    }
    await options.backend.transact({ kind: "namespace" }, (store) => {
      const row = store.read(receipt.workerDispatch);
      if (
        row === undefined ||
        isAttestationTombstone(row) ||
        row.implementationQueue === undefined
      ) {
        throw new Error("implementation candidate completion reservation row is not live");
      }
      reserveImplementationCompletionLease(
        {
          namespace,
          actor: "trusted-parent",
          attestationId: receipt.workerDispatch.attestationId,
          generation: receipt.workerDispatch.generation,
          partitionKey: receipt.partitionKey,
          enrollmentId: receipt.enrollmentId,
          attemptId: receipt.attemptId,
          holderId: receipt.leaseHolderId,
          leaseGeneration: receipt.leaseGeneration,
          expectedPartitionRevision: row.implementationQueue.partitionRevision,
          qualificationDigest: receipt.qualificationDigest,
          ...binding,
          detail: { operation: "protected-implementation-completion-reservation" },
        },
        { store, now },
      );
    });
  }

  async function releaseImplementationCandidateAuthority(
    receipt: ImplementationCandidateAuthorityReceipt,
    binding: ImplementationCandidateCompletionReservationBinding,
  ): Promise<void> {
    await options.backend.transact({ kind: "namespace" }, (store) => {
      const row = store.read(receipt.workerDispatch);
      if (row === undefined) throw new Error("implementation candidate release row is missing");
      if (row.implementationQueue === undefined) {
        throw new Error("implementation candidate release row has no queue authority");
      }
      if (isAttestationTombstone(row)) {
        const control = row.implementationQueue;
        if (
          control.state === "released" &&
          control.partitionKey === receipt.partitionKey &&
          control.enrollmentId === receipt.enrollmentId &&
          control.attemptId === receipt.attemptId &&
          control.leaseGeneration === receipt.leaseGeneration &&
          control.terminal?.detailsDigest ===
            dispatchPayloadDigest({
              operation: "protected-implementation-completion",
              ...binding,
            })
        )
          return;
        throw new Error("implementation candidate release tombstone does not match the receipt");
      }
      const control = row.implementationQueue;
      if (
        control.partition.partitionKey !== receipt.partitionKey ||
        control.enrollment.enrollmentId !== receipt.enrollmentId ||
        control.attempt.attemptId !== receipt.attemptId ||
        control.leaseGeneration !== receipt.leaseGeneration
      ) {
        throw new Error("implementation candidate release coordinates changed");
      }
      const detail = {
        operation: "protected-implementation-completion",
        ...binding,
      } as const;
      if (
        control.state === "released" &&
        control.terminal?.detailsDigest === dispatchPayloadDigest(detail)
      ) {
        return;
      }
      if (
        control.state !== "leased" ||
        control.lease?.holderId !== receipt.leaseHolderId ||
        control.lease.generation !== receipt.leaseGeneration
      ) {
        throw new Error("implementation candidate release requires the exact live lease");
      }
      releaseImplementationCompletionLease(
        {
          namespace,
          actor: "trusted-parent",
          attestationId: row.attestationId,
          generation: row.generation,
          partitionKey: receipt.partitionKey,
          enrollmentId: receipt.enrollmentId,
          attemptId: receipt.attemptId,
          holderId: receipt.leaseHolderId,
          leaseGeneration: receipt.leaseGeneration,
          expectedPartitionRevision: control.partitionRevision,
          ...binding,
          detail,
        },
        { store, now },
      );
    });
  }

  const capability: DispatchCapability = {
    prepare: async (input) => {
      const callerFingerprint = callerPrepareFingerprint(input);
      const earlyCoordinates = managedPrepareCoordinates(input);
      if (earlyCoordinates !== undefined) {
        const lineageBinding = await resolveManagedWorktreeLineageBinding(
          earlyCoordinates,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        if (lineageBinding !== null) {
          const refusal = await withManagedWorktreeEffectLock(
            lineageBinding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
            async () => {
              const fence = await matchingFence(
                lineageBinding.taskId,
                lineageBinding.handleFingerprint,
              );
              return fence !== null &&
                !dispatchLineageFenceAuthorizes(fence, input.recoveryPreparation) &&
                !hasExclusiveLineageAuthority(input)
                ? journalRecoveryRequiredForFence(fence)
                : undefined;
            },
          );
          if (refusal !== undefined) return refusal;
        }
      }
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.trim() === "" ||
        input.idempotencyKey.length > 256
      ) {
        return rejectLaunch(
          "idempotencyKey",
          "expected a non-empty idempotency key of at most 256 characters",
        );
      }
      if (
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < DISPATCH_TIMEOUT_MIN_MS ||
        input.timeoutMs > DISPATCH_TIMEOUT_MAX_MS
      ) {
        return rejectLaunch(
          "timeoutMs",
          `expected an integer timeout within [${DISPATCH_TIMEOUT_MIN_MS}, ${DISPATCH_TIMEOUT_MAX_MS}] ms`,
        );
      }
      if (
        input.recovery !== undefined &&
        (input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.continuation !== undefined)
      ) {
        return rejectLaunch(
          "recovery",
          "a terminal recovery reference requires an implement-worker on a local repository and must replace, not accompany, reprepareOf or guardedRebase",
        );
      }
      if (
        input.continuation !== undefined &&
        (input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.recovery !== undefined)
      ) {
        return rejectLaunch(
          "continuation",
          "a consumed continuation requires an implement-worker on a local repository and must replace, not accompany, reprepareOf, guardedRebase, or recovery",
        );
      }
      if (
        input.recoveryPreparation !== undefined &&
        (input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.recovery !== undefined ||
          input.continuation !== undefined)
      ) {
        return rejectLaunch(
          "recoveryPreparation",
          "journal recovery preparation requires an implement-worker on a local repository and must replace every legacy continuation path",
        );
      }
      if (
        input.implementationEvidenceBootstrap !== undefined &&
        (input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.recovery !== undefined ||
          input.continuation !== undefined ||
          input.recoveryPreparation !== undefined)
      ) {
        return rejectLaunch(
          "implementationEvidenceBootstrap",
          "implementation evidence bootstrap admission is a fresh implement-worker dispatch and cannot accompany continuation authority",
        );
      }
      if (earlyCoordinates !== undefined) {
        const candidate = await resolveManagedWorktreeDispatchBinding(
          earlyCoordinates,
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        const cachedBinding = await durableCachedWorkerBinding(input.idempotencyKey);
        const lockBinding = candidate ?? cachedBinding;
        if (lockBinding !== undefined) {
          const preflight = await withManagedWorktreeEffectLock(
            lockBinding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
            async () => {
              const liveBinding =
                candidate === null ? null : await revalidateManagedPrepareBinding(candidate, false);
              const binding = liveBinding ?? cachedBinding;
              if (binding === undefined) {
                return rejectLaunch(
                  "input.worktreePath",
                  "prepare worktree coordinates lost their authoritative manager binding",
                );
              }
              const fence = await matchingFence(binding.taskId, binding.handleFingerprint);
              if (fence !== null) {
                const authorization = await recoveryFenceAuthorizesPrepare(fence, binding, input);
                if (authorization instanceof GuardedRebaseRejection) {
                  return rejectLaunch(authorization.path, authorization.message);
                }
                if (!authorization) return journalRecoveryRequiredForFence(fence);
              }
              if (callerFingerprint === undefined) return undefined;
              const replay = await replayCachedPrepare(
                input.idempotencyKey,
                callerFingerprint,
                "caller",
              );
              if (replay !== undefined) return replay;
              return liveBinding === null
                ? rejectLaunch(
                    "input.worktreePath",
                    "prepare worktree coordinates lost their authoritative manager binding",
                  )
                : undefined;
            },
          );
          if (preflight !== undefined) return preflight;
        }
      } else if (callerFingerprint !== undefined) {
        const replay = await replayCachedPrepare(input.idempotencyKey, callerFingerprint, "caller");
        if (replay !== undefined) return replay;
      }
      let roleId: string;
      let dispatchInput: Parameters<typeof dispatchPayloadDigest>[0];
      let requestedSurface: string | undefined;
      if (input.refs !== undefined) {
        if (input.roleId !== undefined || input.input !== undefined) {
          return rejectLaunch(
            "refs",
            "refs-only prepare must not also carry roleId or inline input",
          );
        }
        if (options.narrativeSource === undefined) {
          return dispatchPreLaunchRejection(
            "unresolvable-ref",
            "refs",
            "this dispatch runtime has no project-bound narrative source",
          );
        }
        const assembly = assembleDispatchInput(input.refs, {
          source: options.narrativeSource,
          registry: DISPATCH_OVERLAY_REGISTRY,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
        });
        if (!assembly.accepted) {
          return assembly;
        }
        roleId = assembly.roleId;
        dispatchInput = assembly.input;
        requestedSurface = assembly.surface;
      } else {
        if (input.roleId === undefined || input.input === undefined) {
          return rejectLaunch(
            input.roleId === undefined ? "roleId" : "input",
            "prepare requires either refs or both roleId and structured input",
          );
        }
        roleId = input.roleId;
        dispatchInput = input.input;
      }

      if (
        implementationExecutorMode === "metadata-only" &&
        (roleId === "implement-worker" ||
          roleId === "implement-conflict-resolver" ||
          roleId === "implement-reviewer")
      ) {
        return dispatchPreLaunchRejection(
          "executor-unavailable",
          "roleId",
          "implementation execution requires a local XDG runtime with repository and evidence authority",
        );
      }

      if (
        roleId === "implement-worker" &&
        typeof dispatchInput === "object" &&
        dispatchInput !== null &&
        !Array.isArray(dispatchInput) &&
        Object.hasOwn(dispatchInput, "inheritedGitReceipts")
      ) {
        return rejectLaunch(
          "input.inheritedGitReceipts",
          "caller must omit server-bound inherited Git receipts",
        );
      }

      if (
        roleId === "implement-worker" &&
        typeof dispatchInput === "object" &&
        dispatchInput !== null &&
        !Array.isArray(dispatchInput) &&
        Object.hasOwn(dispatchInput, "guardedRebaseLineage")
      ) {
        return rejectLaunch(
          "input.guardedRebaseLineage",
          "caller must omit the server-injected guarded-rebase lineage",
        );
      }

      if (
        input.guardedRebase !== undefined &&
        (roleId !== "implement-worker" || options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "guardedRebase",
          "a guarded-rebase reference requires an implement-worker on a local repository",
        );
      }

      if (
        input.recovery !== undefined &&
        (roleId !== "implement-worker" || options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "recovery",
          "a terminal recovery reference requires an implement-worker on a local repository and must replace, not accompany, reprepareOf or guardedRebase",
        );
      }

      if (
        input.continuation !== undefined &&
        (roleId !== "implement-worker" || options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "continuation",
          "a consumed continuation requires an implement-worker on a local repository and must replace, not accompany, reprepareOf, guardedRebase, or recovery",
        );
      }

      if (
        input.recoveryPreparation !== undefined &&
        (roleId !== "implement-worker" || options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "recoveryPreparation",
          "journal recovery preparation requires an implement-worker on a local repository and must replace every legacy continuation path",
        );
      }

      if (
        input.implementationEvidenceBootstrap !== undefined &&
        (roleId !== "implement-worker" ||
          options.repositoryRoot === undefined ||
          options.implementationEvidenceStore === undefined)
      ) {
        return rejectLaunch(
          "implementationEvidenceBootstrap",
          "implementation evidence bootstrap admission requires a protected local implement-worker runtime",
        );
      }

      if (roleId === "implement-reviewer") {
        if (input.timeoutMs < IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS) {
          return rejectLaunch(
            "timeoutMs",
            `expected an integer timeout within [${IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS}, ${DISPATCH_TIMEOUT_MAX_MS}] ms`,
          );
        }
        if (
          typeof dispatchInput !== "object" ||
          dispatchInput === null ||
          Array.isArray(dispatchInput)
        ) {
          return dispatchPreLaunchRejection(
            "invalid-role-input",
            "input",
            "implement-reviewer input must be an object",
          );
        }
        for (const field of IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS) {
          if (Object.hasOwn(dispatchInput, field)) {
            return dispatchPreLaunchRejection(
              "invalid-role-input",
              `input.${field}`,
              `caller must omit server-bound implement-reviewer timing field "${field}"`,
            );
          }
        }
      }

      const manifest = options.promptArtifactStore.readManifest();
      const manifestSurface = manifest.promptSurface;
      if (manifestSurface === undefined) {
        throw new Error("prepare_dispatch requires an attested prompt surface");
      }
      if (requestedSurface !== undefined && requestedSurface !== manifestSurface) {
        return rejectLaunch(
          "refs.surface",
          `requested prompt surface "${requestedSurface}" does not match attested manifest surface "${manifestSurface}"`,
        );
      }
      if (input.refs === undefined) {
        const validation = validateDispatchInput({
          roleId,
          input:
            roleId === "implement-reviewer"
              ? {
                  ...(dispatchInput as object),
                  responseStoreNow: "1970-01-01T00:02:00.000Z",
                  gateCompleteBy: "1970-01-01T00:01:00.000Z",
                  synthesisStoreReserveMs: IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS,
                }
              : dispatchInput,
          surface: manifestSurface,
          ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
          registry: DISPATCH_OVERLAY_REGISTRY,
        });
        if (!validation.accepted) {
          return validation;
        }
      }

      // Resolve the catalog artifact only after the role/input/overlay boundary
      // has produced a typed acceptance. Unknown roles therefore never escape
      // as artifact lookup errors.
      const artifact = options.promptArtifactStore.readRole(roleId);
      const promptDigest = artifact.metadata.promptDigest;
      const catalogHash = manifest.catalogHash;
      const artifactSurface = artifact.metadata.promptSurface;
      if (
        artifact.metadata.roleKind !== "dispatched-subagent" ||
        promptDigest === undefined ||
        catalogHash === undefined ||
        artifactSurface === undefined
      ) {
        throw new Error(
          `prepare_dispatch requires an attested dispatched-role artifact for "${roleId}"`,
        );
      }
      if (artifactSurface !== manifestSurface) {
        return rejectLaunch(
          `roles.${roleId}.promptSurface`,
          `role-artifact surface "${artifactSurface}" does not match attested manifest surface "${manifestSurface}"`,
        );
      }
      let gitEffectBinding;
      let resolvedReprepareOf = input.reprepareOf;
      let resolvedImplementationEvidenceBootstrapRef = input.implementationEvidenceBootstrap;
      let continuationClaim;
      let journalRecoveryReservation;
      let prepareLockBinding: ManagedWorktreeDispatchBinding | undefined;
      if (
        (roleId === "implement-worker" || roleId === "implement-conflict-resolver") &&
        options.repositoryRoot !== undefined
      ) {
        if (
          typeof dispatchInput !== "object" ||
          dispatchInput === null ||
          Array.isArray(dispatchInput)
        ) {
          return rejectLaunch("input", `${roleId} Git binding requires object input`);
        }
        const dispatchRecord = dispatchInput as { readonly [key: string]: DispatchJSONValue };
        const taskId = dispatchRecord["taskId"];
        const worktreePath = dispatchRecord["worktreePath"];
        const branch = dispatchRecord["branch"];
        const conflictState = dispatchRecord["conflictState"];
        if (
          typeof taskId !== "string" ||
          typeof worktreePath !== "string" ||
          typeof branch !== "string"
        ) {
          return rejectLaunch(
            "input.worktreePath",
            `${roleId} requires taskId, worktreePath, and branch from worktree_manage`,
          );
        }
        if (
          roleId === "implement-conflict-resolver" &&
          (conflictState === null ||
            typeof conflictState !== "object" ||
            Array.isArray(conflictState))
        ) {
          return rejectLaunch(
            "input.conflictState",
            "implement-conflict-resolver requires the parent-observed conflict state",
          );
        }
        const resolvedGitEffectBinding = await resolveManagedWorktreeDispatchBinding(
          {
            repositoryRoot: options.repositoryRoot,
            taskId,
            worktreePath,
            branch,
            ...(roleId === "implement-conflict-resolver" ? { allowDetachedRebase: true } : {}),
          },
          options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        );
        if (resolvedGitEffectBinding === null) {
          return rejectLaunch(
            "input.worktreePath",
            `${roleId} worktree coordinates do not resolve to one live manager handle`,
          );
        }
        prepareLockBinding = resolvedGitEffectBinding;
        const fence = await matchingFence(taskId, resolvedGitEffectBinding.handleFingerprint);
        if (fence !== null) {
          const authorization = await recoveryFenceAuthorizesPrepare(
            fence,
            resolvedGitEffectBinding,
            input,
          );
          if (authorization instanceof GuardedRebaseRejection) {
            return rejectLaunch(authorization.path, authorization.message);
          }
          if (!authorization) return journalRecoveryRequiredForFence(fence);
        }
        let inferredGuardedRebasePrior;
        if (
          roleId === "implement-worker" &&
          input.guardedRebase !== undefined &&
          input.reprepareOf === undefined
        ) {
          try {
            inferredGuardedRebasePrior = await resolveDurableGuardedRebasePrior(
              resolvedGitEffectBinding,
              input,
            );
          } catch (error) {
            return rejectLaunch(
              error instanceof GuardedRebaseRejection ? error.path : "guardedRebase",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (inferredGuardedRebasePrior === null) {
            return rejectLaunch(
              "guardedRebase",
              "guarded-rebase reference does not resolve to one terminal prior worker generation",
            );
          }
          resolvedReprepareOf = inferredGuardedRebasePrior.handle;
        }
        if (roleId === "implement-conflict-resolver") {
          const resolverState = conflictState as unknown as GitRebaseConflictState;
          const conflictingFiles = dispatchRecord["conflictingFiles"];
          const observedPaths = [
            ...new Set(resolverState.conflicts.map((stage) => stage.path)),
          ].sort();
          if (
            dispatchRecord["baseCommit"] !== resolvedGitEffectBinding.baseCommit ||
            resolverState.baseCommit !== resolvedGitEffectBinding.baseCommit
          ) {
            return rejectLaunch(
              "input.baseCommit",
              "resolver baseCommit and conflictState must match the managed handle binding",
            );
          }
          if (resolverState.sequencer.headName !== resolvedGitEffectBinding.ref) {
            return rejectLaunch(
              "input.conflictState.sequencer.headName",
              "resolver conflictState must name the managed task ref",
            );
          }
          if (
            !Array.isArray(conflictingFiles) ||
            !conflictingFiles.every((entry) => typeof entry === "string") ||
            JSON.stringify([...new Set(conflictingFiles)].sort()) !== JSON.stringify(observedPaths)
          ) {
            return rejectLaunch(
              "input.conflictingFiles",
              "resolver conflictingFiles must equal the conflictState path set",
            );
          }
        }
        if (roleId === "implement-conflict-resolver") {
          gitEffectBinding = {
            ...resolvedGitEffectBinding,
            conflictStateDigest: gitRebaseConflictStateDigest(
              conflictState as unknown as GitRebaseConflictState,
            ),
          };
        } else if (input.recoveryPreparation !== undefined) {
          if (fence === null || recoveryJournal === undefined) {
            return rejectLaunch(
              "recoveryPreparation",
              "journal recovery preparation requires one committed lineage fence",
            );
          }
          const journal = await recoveryJournal.read(taskId);
          if (
            journal?.state !== "committed" ||
            journal.fence === undefined ||
            journal.fence.fenceRef !== fence.fenceRef
          ) {
            return journalRecoveryRequiredForFence(fence);
          }
          const startingCommit = dispatchRecord["startingCommit"];
          const baseCommitInput = dispatchRecord["baseCommit"];
          const liveTip = await observeManagedWorktreeLiveTip(
            resolvedGitEffectBinding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
          );
          if (typeof startingCommit !== "string" || startingCommit !== liveTip) {
            return rejectLaunch(
              "input.startingCommit",
              "journal recovery startingCommit must equal the live managed-worktree tip",
            );
          }
          if (baseCommitInput !== resolvedGitEffectBinding.baseCommit) {
            return rejectLaunch(
              "input.baseCommit",
              "journal recovery baseCommit differs from the managed binding",
            );
          }
          if (journal.seal.seed.gitReceipts.at(-1)?.newHead !== startingCommit) {
            return rejectLaunch(
              "input.startingCommit",
              "journal recovery seed receipt closure does not end at the live tip",
            );
          }
          resolvedReprepareOf = {
            attestationId: fence.sourceAttestationId,
            generation: fence.selectedSourceGeneration,
          };
          journalRecoveryReservation = {
            fenceRef: fence.fenceRef,
            sourceAttestationId: fence.sourceAttestationId,
            selectedSourceGeneration: fence.selectedSourceGeneration,
            lineageMaximumGeneration: fence.lineageMaximumGeneration,
          };
          gitEffectBinding = {
            ...resolvedGitEffectBinding,
            inheritedGitReceipts: journal.seal.seed.gitReceipts,
          };
        } else if (input.continuation !== undefined) {
          const startingCommit = dispatchRecord["startingCommit"];
          const baseCommitInput = dispatchRecord["baseCommit"];
          if (typeof startingCommit !== "string") {
            return rejectLaunch(
              "input.startingCommit",
              "worker continuation requires startingCommit",
            );
          }
          if (typeof baseCommitInput !== "string") {
            return rejectLaunch("input.baseCommit", "worker continuation requires baseCommit");
          }
          const liveTip = await observeManagedWorktreeLiveTip(
            resolvedGitEffectBinding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
          );
          if (liveTip !== startingCommit) {
            return rejectLaunch(
              "input.startingCommit",
              "worker continuation startingCommit differs from the live managed-worktree tip",
            );
          }
          let continuation;
          try {
            continuation = await resolveDispatchContinuationOn(
              options.backend,
              {
                namespace,
                actor: "trusted-parent",
                continuationReference: input.continuation,
                gitEffectBinding: resolvedGitEffectBinding,
                liveTip,
              },
              { now },
            );
          } catch (error) {
            return rejectLaunch(
              "continuation",
              error instanceof Error ? error.message : String(error),
            );
          }
          const guardedRebaseBridge = continuation.gitEffectBinding.guardedRebaseBridge;
          const logicalBaseCommit =
            guardedRebaseBridge?.ontoCommit ?? continuation.gitEffectBinding.baseCommit;
          if (baseCommitInput !== logicalBaseCommit) {
            return rejectLaunch(
              "input.baseCommit",
              "worker continuation baseCommit differs from the consumed logical binding",
            );
          }
          resolvedReprepareOf = continuation.reprepareOf;
          resolvedImplementationEvidenceBootstrapRef =
            continuation.implementationEvidenceBootstrapRef;
          continuationClaim = {
            continuationReference: continuation.continuationReference,
            actor: "trusted-parent" as const,
            liveTip,
          };
          if (guardedRebaseBridge === undefined) {
            gitEffectBinding =
              continuation.gitReceipts.length === 0
                ? resolvedGitEffectBinding
                : {
                    ...resolvedGitEffectBinding,
                    inheritedGitReceipts: continuation.gitReceipts,
                  };
          } else {
            let bridge;
            try {
              bridge = await reverifyGuardedRebaseBridge({
                bridge: guardedRebaseBridge,
                current: resolvedGitEffectBinding,
                baseCommitInput,
                startingCommitInput: startingCommit,
                firstInheritedOldHead: continuation.gitReceipts[0]?.oldHead ?? null,
                ...(options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir }),
              });
            } catch (error) {
              return rejectLaunch(
                error instanceof GuardedRebaseRejection ? error.path : "guardedRebase",
                error instanceof Error ? error.message : String(error),
              );
            }
            gitEffectBinding = {
              ...resolvedGitEffectBinding,
              ...(continuation.gitReceipts.length === 0
                ? {}
                : { inheritedGitReceipts: continuation.gitReceipts }),
              guardedRebaseBridge: bridge,
            };
            dispatchInput = {
              ...dispatchRecord,
              guardedRebaseLineage: guardedRebaseLineageOf(bridge),
            };
          }
        } else if (input.recovery !== undefined) {
          if (manifestSurface !== "codex") {
            return rejectLaunch(
              "recovery",
              "a terminal recovery reference requires the brokered codex surface",
            );
          }
          const startingCommit = dispatchRecord["startingCommit"];
          const baseCommitInput = dispatchRecord["baseCommit"];
          if (typeof startingCommit !== "string") {
            return rejectLaunch("input.startingCommit", "worker recovery requires startingCommit");
          }
          if (typeof baseCommitInput !== "string") {
            return rejectLaunch("input.baseCommit", "worker recovery requires baseCommit");
          }
          let recovery;
          try {
            recovery = await resolveDispatchRecoveryOn(
              options.backend,
              {
                namespace,
                actor: "trusted-parent",
                recoveryReference: input.recovery,
                gitEffectBinding: resolvedGitEffectBinding,
                liveTip: startingCommit,
              },
              { now },
            );
          } catch (error) {
            return rejectLaunch("recovery", error instanceof Error ? error.message : String(error));
          }
          const guardedRebaseBridge = recovery.gitEffectBinding.guardedRebaseBridge;
          const logicalBaseCommit =
            guardedRebaseBridge?.ontoCommit ?? recovery.gitEffectBinding.baseCommit;
          if (baseCommitInput !== logicalBaseCommit) {
            return rejectLaunch(
              "input.baseCommit",
              "worker recovery baseCommit differs from the terminal logical binding",
            );
          }
          resolvedReprepareOf = recovery.reprepareOf;
          resolvedImplementationEvidenceBootstrapRef = recovery.implementationEvidenceBootstrapRef;
          if (guardedRebaseBridge === undefined) {
            gitEffectBinding =
              recovery.gitReceipts.length === 0
                ? resolvedGitEffectBinding
                : { ...resolvedGitEffectBinding, inheritedGitReceipts: recovery.gitReceipts };
          } else {
            let bridge;
            try {
              bridge = await reverifyGuardedRebaseBridge({
                bridge: guardedRebaseBridge,
                current: resolvedGitEffectBinding,
                baseCommitInput,
                startingCommitInput: startingCommit,
                firstInheritedOldHead: recovery.gitReceipts[0]?.oldHead ?? null,
                ...(options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir }),
              });
            } catch (error) {
              return rejectLaunch(
                error instanceof GuardedRebaseRejection ? error.path : "guardedRebase",
                error instanceof Error ? error.message : String(error),
              );
            }
            gitEffectBinding = {
              ...resolvedGitEffectBinding,
              ...(recovery.gitReceipts.length === 0
                ? {}
                : { inheritedGitReceipts: recovery.gitReceipts }),
              guardedRebaseBridge: bridge,
            };
            dispatchInput = {
              ...dispatchRecord,
              guardedRebaseLineage: guardedRebaseLineageOf(bridge),
            };
          }
        } else if (resolvedReprepareOf === undefined) {
          // D332: a lineage-free prepare may only build on the tip it declares as
          // its diff base. When startingCommit has advanced past baseCommit, the
          // base-to-result diff spans commits no receipt of this generation could
          // cover, so allocation must wait for the exact reprepareOf lineage.
          const startingCommit = dispatchRecord["startingCommit"];
          if (
            typeof startingCommit !== "string" ||
            startingCommit !== dispatchRecord["baseCommit"]
          ) {
            return rejectLaunch(
              "reprepareOf",
              "a lineage-free implement-worker prepare requires startingCommit to equal baseCommit; " +
                "an advanced managed-worktree tip must name the exact terminal prior worker generation",
            );
          }
          gitEffectBinding = resolvedGitEffectBinding;
        } else if (manifestSurface !== "codex") {
          if (input.guardedRebase !== undefined) {
            return rejectLaunch(
              "guardedRebase",
              "a guarded-rebase reference requires the brokered codex surface",
            );
          }
          gitEffectBinding = resolvedGitEffectBinding;
        } else {
          const priorBinding =
            inferredGuardedRebasePrior?.priorBinding ??
            (await resolveDispatchGitEffectBindingForHandleOn(
              options.backend,
              resolvedReprepareOf,
            ));
          if (priorBinding === undefined) {
            return rejectLaunch(
              "reprepareOf",
              "brokered worker reprepare requires a prior Git effect binding",
            );
          }
          for (const field of [
            "taskId",
            "handleToken",
            "handleFingerprint",
            "repositoryRoot",
            "repositoryId",
            "commonDir",
            "worktreePath",
            "branch",
            "ref",
            "baseCommit",
          ] as const) {
            if (priorBinding[field] !== resolvedGitEffectBinding[field]) {
              return rejectLaunch(
                "reprepareOf",
                `prior-generation Git binding changed at ${field}`,
              );
            }
          }
          const startingCommit = dispatchRecord["startingCommit"];
          if (typeof startingCommit !== "string") {
            return rejectLaunch("input.startingCommit", "worker reprepare requires startingCommit");
          }
          const baseCommitInput = dispatchRecord["baseCommit"];
          if (typeof baseCommitInput !== "string") {
            return rejectLaunch("input.baseCommit", "worker reprepare requires baseCommit");
          }
          if (input.guardedRebase !== undefined) {
            // D334 initial bridge round: the opaque reference is resolved
            // against the terminal durable journal; the caller can never mint
            // the materialized lineage.
            let bridge;
            try {
              bridge = await materializeGuardedRebase({
                reference: input.guardedRebase,
                prior: {
                  ...priorBinding,
                  attestationId: resolvedReprepareOf.attestationId,
                  generation: resolvedReprepareOf.generation,
                },
                current: resolvedGitEffectBinding,
                baseCommitInput,
                startingCommitInput: startingCommit,
                priorResultCommitInput:
                  (dispatchRecord["priorResultCommit"] as string | null | undefined) ?? null,
                ...(options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir }),
              });
            } catch (error) {
              return rejectLaunch(
                error instanceof GuardedRebaseRejection ? error.path : "guardedRebase",
                error instanceof Error ? error.message : String(error),
              );
            }
            gitEffectBinding = {
              ...resolvedGitEffectBinding,
              guardedRebaseBridge: bridge,
            };
            dispatchInput = {
              ...dispatchRecord,
              guardedRebaseLineage: guardedRebaseLineageOf(bridge),
            };
          } else {
            let inheritedGitReceipts;
            try {
              inheritedGitReceipts = await resolveInheritedGitChangeReceipts(
                {
                  ...priorBinding,
                  attestationId: resolvedReprepareOf.attestationId,
                  generation: resolvedReprepareOf.generation,
                },
                startingCommit,
                options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir },
              );
            } catch (error) {
              return rejectLaunch(
                "input.startingCommit",
                `prior-generation receipt inheritance failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (priorBinding.guardedRebaseBridge === undefined) {
              gitEffectBinding =
                inheritedGitReceipts.length === 0
                  ? resolvedGitEffectBinding
                  : { ...resolvedGitEffectBinding, inheritedGitReceipts };
            } else {
              // Later correction on a guarded lineage: the verified bridge is
              // carried from the prior generation's persisted binding and
              // re-verified against the terminal journal and live binding.
              let bridge;
              try {
                bridge = await reverifyGuardedRebaseBridge({
                  bridge: priorBinding.guardedRebaseBridge,
                  current: resolvedGitEffectBinding,
                  baseCommitInput,
                  startingCommitInput: startingCommit,
                  firstInheritedOldHead: inheritedGitReceipts[0]?.oldHead ?? null,
                  ...(options.worktreeStateDir === undefined
                    ? {}
                    : { stateDir: options.worktreeStateDir }),
                });
              } catch (error) {
                return rejectLaunch(
                  error instanceof GuardedRebaseRejection ? error.path : "guardedRebase",
                  error instanceof Error ? error.message : String(error),
                );
              }
              gitEffectBinding = {
                ...resolvedGitEffectBinding,
                ...(inheritedGitReceipts.length === 0 ? {} : { inheritedGitReceipts }),
                guardedRebaseBridge: bridge,
              };
              dispatchInput = {
                ...dispatchRecord,
                guardedRebaseLineage: guardedRebaseLineageOf(bridge),
              };
            }
          }
        }
        if (roleId === "implement-worker" && options.implementationEvidenceStore !== undefined) {
          let requiredBootstrap;
          try {
            requiredBootstrap = await implementationEvidenceBootstrapAdmissionForTask(
              options.implementationEvidenceStore,
              `${TASKS_LEDGER}:${taskId}`,
            );
          } catch (error) {
            return rejectLaunch(
              "implementationEvidenceBootstrap",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (
            requiredBootstrap !== null &&
            resolvedImplementationEvidenceBootstrapRef !== requiredBootstrap.bootstrapRef
          )
            return rejectLaunch(
              "implementationEvidenceBootstrap",
              "fresh historical evidence dispatch must consume its exact bootstrap ref",
            );
          if (resolvedImplementationEvidenceBootstrapRef !== undefined) {
            if (
              input.recovery === undefined &&
              input.continuation === undefined &&
              (dispatchRecord["round"] !== 0 ||
                Object.hasOwn(dispatchRecord, "priorResultCommit") ||
                dispatchRecord["baseCommit"] !== resolvedGitEffectBinding.baseCommit ||
                dispatchRecord["startingCommit"] !== resolvedGitEffectBinding.baseCommit)
            )
              return rejectLaunch(
                "implementationEvidenceBootstrap",
                "historical bootstrap admission requires the fresh round-zero managed base",
              );
            try {
              const admission = await assertImplementationEvidenceBootstrapDispatchAdmission(
                options.implementationEvidenceStore,
                resolvedImplementationEvidenceBootstrapRef,
                `${TASKS_LEDGER}:${taskId}`,
              );
              if (admission.repositoryHead !== resolvedGitEffectBinding.baseCommit)
                return rejectLaunch(
                  "implementationEvidenceBootstrap",
                  "historical bootstrap admission repository head differs from the managed base",
                );
            } catch (error) {
              return rejectLaunch(
                "implementationEvidenceBootstrap",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      }
      const request = {
        namespace,
        roleId,
        surface: manifestSurface,
        input: dispatchInput,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
        ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest,
        catalogHash,
        expectedChild: input.expectedChild,
        ...(resolvedReprepareOf === undefined ? {} : { reprepareOf: resolvedReprepareOf }),
        ...(gitEffectBinding === undefined ? {} : { gitEffectBinding }),
        ...(continuationClaim === undefined ? {} : { continuationClaim }),
        ...(journalRecoveryReservation === undefined ? {} : { journalRecoveryReservation }),
        ...(resolvedImplementationEvidenceBootstrapRef === undefined
          ? {}
          : {
              implementationEvidenceBootstrapRef: resolvedImplementationEvidenceBootstrapRef,
            }),
      } as const;
      const fingerprint = prepareDispatchRequestDigest(request);
      const allocateOrReplay = async (): Promise<PrepareDispatchOutcome> => {
        if (prepareLockBinding !== undefined) {
          const binding = await revalidateManagedPrepareBinding(
            prepareLockBinding,
            roleId === "implement-conflict-resolver",
          );
          if (binding === null) {
            return rejectLaunch(
              "input.worktreePath",
              "prepare worktree coordinates lost their authoritative manager binding",
            );
          }
          const fence = await matchingFence(binding.taskId, binding.handleFingerprint);
          if (fence !== null) {
            const authorization = await recoveryFenceAuthorizesPrepare(fence, binding, input);
            if (authorization instanceof GuardedRebaseRejection) {
              return rejectLaunch(authorization.path, authorization.message);
            }
            if (!authorization) return journalRecoveryRequiredForFence(fence);
          }
        }
        while (true) {
          const existing = prepares.get(input.idempotencyKey);
          if (existing !== undefined) {
            const accepted = await existing.promise;
            if (await cachedPrepareRemainsHeld(input.idempotencyKey, accepted, existing)) {
              if (existing.fingerprint !== fingerprint) {
                throw new AttestationKeyReuseError(input.idempotencyKey, accepted.handle);
              }
              return accepted;
            }
            if (prepares.get(input.idempotencyKey) === existing) {
              prepares.delete(input.idempotencyKey);
              preparesByHandle.delete(cacheHandleKey(accepted.handle));
            }
            continue;
          }
          const pending = prepareDispatchOn(
            options.backend,
            request,
            prepareLockBinding === undefined
              ? { mode: "backend", now, randomBytes }
              : {
                  mode: "manager-bound",
                  now,
                  randomBytes,
                  lineageFenceGuard: async () => {
                    const fence = await matchingFence(
                      prepareLockBinding.taskId,
                      prepareLockBinding.handleFingerprint,
                    );
                    if (fence === null) return null;
                    const authorization = await recoveryFenceAuthorizesPrepare(
                      fence,
                      prepareLockBinding,
                      input,
                    );
                    return authorization === true ? null : journalRecoveryRequiredForFence(fence);
                  },
                  // allocateOrReplay is inside this binding's effect lock below.
                  withLineageLock: async (operation) => await operation(),
                },
          ).then((outcome: PrepareDispatchOutcome) => {
            if (!outcome.accepted) {
              if (
                outcome.reason === "journal-recovery-required" &&
                "fenceRef" in outcome &&
                "taskRef" in outcome
              ) {
                throw new JournalRecoveryRequiredError(
                  outcome as ReturnType<typeof journalRecoveryRequiredForFence>,
                );
              }
              throw new Error("validated prepare unexpectedly returned a pre-launch rejection");
            }
            return outcome;
          });
          const entry: CachedPrepare = {
            callerFingerprint,
            fingerprint,
            request,
            promise: pending,
          };
          prepares.set(input.idempotencyKey, entry);
          try {
            const accepted = await pending;
            preparesByHandle.set(cacheHandleKey(accepted.handle), entry);
            return accepted;
          } catch (error) {
            if (prepares.get(input.idempotencyKey) === entry) {
              prepares.delete(input.idempotencyKey);
            }
            if (error instanceof JournalRecoveryRequiredError) return error.refusal;
            throw error;
          }
        }
      };
      if (prepareLockBinding === undefined) return await allocateOrReplay();
      return await withManagedWorktreeEffectLock(
        prepareLockBinding,
        options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
        allocateOrReplay,
      );
    },
    fetchInput: (input) => fetchDispatchInputOn(options.backend, { namespace, ...input }, { now }),
    storeResult: async (input) => {
      const synchronousStartedAt = Date.now();
      const initialSynchronousDeadlineMs = stagingDeadlineAfter(
        CODEX_STAGED_TIMING_BASIS.storeResultSynchronousPhaseMs,
        "synchronous phase",
      );
      const gateContext = await withinStagingDeadline(
        async () => await resolveSupervisedWorkerGateContextOn(options.backend, input),
        initialSynchronousDeadlineMs,
        "synchronous phase",
      );
      const binding =
        gateContext ??
        (await withinStagingDeadline(
          async () => await resolveDispatchGitEffectBindingOn(options.backend, input),
          initialSynchronousDeadlineMs,
          "synchronous phase",
        ));
      const preLockSynchronousElapsedMs = Date.now() - synchronousStartedAt;
      const remainingSynchronousMs =
        CODEX_STAGED_TIMING_BASIS.storeResultSynchronousPhaseMs - preLockSynchronousElapsedMs;
      if (remainingSynchronousMs <= 0) {
        throw new Error("Codex store_result exceeded its synchronous phase deadline");
      }
      const store = async (synchronousDeadlineMs: number) => {
        let output = input.output;
        // An unbound dispatch has no trusted parent that could have minted this evidence.
        if (
          output !== null &&
          typeof output === "object" &&
          !Array.isArray(output) &&
          Object.hasOwn(output, "supervisedGateEvidence")
        ) {
          throw new Error(
            "caller-minted supervised gate evidence requires a runner-owned Git/gate binding",
          );
        }
        if (binding?.roleId === "implement-worker") {
          const evidence = brokerResultEvidence(output);
          if (evidence !== undefined) {
            const normalized = await withinStagingDeadline(
              async () =>
                await validateGitChangeBrokerResultEvidence(binding, evidence, {
                  ...(options.worktreeStateDir === undefined
                    ? {}
                    : { stateDir: options.worktreeStateDir }),
                  ...(gateContext === undefined
                    ? {}
                    : { diffBaseCommit: gateContext.dispatchBaseCommit }),
                  deadlineMs: synchronousDeadlineMs,
                }),
              synchronousDeadlineMs,
              "synchronous phase",
            );
            output = {
              ...(output as Readonly<Record<string, DispatchJSONValue>>),
              filesTouched: normalized.filesTouched as unknown as DispatchJSONValue,
              gitReceipts: normalized.gitReceipts as unknown as DispatchJSONValue,
            };
          }
        } else if (binding?.roleId === "implement-conflict-resolver") {
          await withinStagingDeadline(
            async () =>
              await validateGitConflictContinuationResultEvidence(
                binding,
                conflictResultEvidence(output),
                options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir },
              ),
            synchronousDeadlineMs,
            "synchronous phase",
          );
        }
        const acknowledgementDeadlineMs = stagingDeadlineAfter(
          CODEX_STAGED_TIMING_BASIS.storeResultDurableAcknowledgementMs,
          "durable acknowledgement",
        );
        return await withinStagingDeadline(
          async () => await storeDispatchResultOn(options.backend, { ...input, output }, { now }),
          acknowledgementDeadlineMs,
          "durable acknowledgement",
        );
      };
      const outcome =
        binding === undefined
          ? await store(initialSynchronousDeadlineMs)
          : await withManagedWorktreeEffectLock(
              binding,
              {
                ...(options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir }),
                effectLockTimeoutMs: CODEX_STAGED_TIMING_BASIS.storeResultEffectLockAcquisitionMs,
              },
              async () =>
                await store(stagingDeadlineAfter(remainingSynchronousMs, "synchronous phase")),
            );
      if (outcome.state === "aborted") {
        rememberTerminal(outcome.result, outcome.result.abortedAt);
      }
      return outcome;
    },
    qualifyImplementationCandidate: async (input) => {
      assertImplementationExecutor("qualify");
      assertProcessQualificationObservation(input);
      if (options.ledgerStore === undefined) {
        throw new Error("implementation candidate qualification requires the task ledger");
      }
      const row = await options.backend.transact(
        { kind: "handle", handle: input },
        (store): AttestationEnvelope => {
          const persisted = store.read(input);
          if (persisted === undefined || isAttestationTombstone(persisted)) {
            throw new Error("implementation candidate qualification requires a live dispatch");
          }
          if (
            persisted.state !== "gate-pending" ||
            persisted.gateSubmittedOutputDigest === undefined ||
            persisted.gitEffectBinding === undefined ||
            persisted.output === undefined
          ) {
            throw new DispatchStateConflictError(
              "confirm_dispatch_completion",
              persisted.state,
              "implementation candidate qualification requires one staged managed result",
            );
          }
          return persisted;
        },
      );
      const binding = row.gitEffectBinding!;
      const expectedChildId = `${input.roleId}${CODEX_CORRELATION_SEPARATOR}${input.correlationId}`;
      if (
        row.promptProvenance.roleId !== input.roleId ||
        row.promptProvenance.promptDigest !== input.promptDigest ||
        row.expectedChild.childId !== expectedChildId ||
        row.expectedChild.runId !== input.expectedRunId
      ) {
        const aborted = await abortDispatchOn(
          options.backend,
          {
            namespace,
            actor: "trusted-extension",
            attestationId: input.attestationId,
            generation: input.generation,
            reason: "protocol-violation",
            details: {
              violation: "foreign-process-completion",
              observationDigest: dispatchPayloadDigest(input as unknown as DispatchJSONValue),
            },
          },
          { now },
        );
        rememberTerminal(aborted, aborted.abortedAt);
        return Object.freeze({ state: "aborted" as const, result: aborted });
      }
      if (input.outcome !== "completed" || input.exitStatus !== 0) {
        const aborted = await abortDispatchOn(
          options.backend,
          {
            namespace,
            actor: "trusted-extension",
            attestationId: input.attestationId,
            generation: input.generation,
            reason: "native-failure",
            details: {
              violation: "unsuccessful-process-completion",
              outcome: input.outcome,
              exitStatus: input.exitStatus,
              observationDigest: dispatchPayloadDigest(input as unknown as DispatchJSONValue),
            },
          },
          { now },
        );
        rememberTerminal(aborted, aborted.abortedAt);
        return Object.freeze({ state: "aborted" as const, result: aborted });
      }
      if (row.output === null || typeof row.output !== "object" || Array.isArray(row.output)) {
        throw new Error("staged implementation candidate output must be an object");
      }
      const output = row.output as Readonly<Record<string, DispatchJSONValue>>;
      const resultCommit = output["resultCommit"];
      const gitReceipts = output["gitReceipts"];
      if (
        output["status"] !== "pass" ||
        typeof resultCommit !== "string" ||
        !FULL_GIT_SHA.test(resultCommit) ||
        !Array.isArray(gitReceipts)
      ) {
        throw new Error(
          "only a passing broker-verified worker result can enter the runnable queue",
        );
      }
      const [resultTree, integrationRef] = await Promise.all([
        readOnlyGit(binding.repositoryRoot, ["rev-parse", "--verify", `${resultCommit}^{tree}`]),
        readOnlyGit(binding.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
      ]);
      if (!FULL_GIT_SHA.test(resultTree) || !/^refs\/heads\//u.test(integrationRef)) {
        throw new Error("implementation candidate Git identity is malformed");
      }
      const taskEvidence = currentRecoveryTaskEvidence(options.ledgerStore, binding.taskId);
      const goalRef = exactGoalRef(options.ledgerStore, binding.taskId);
      const stagedRebaseSource = await options.backend.transact({ kind: "namespace" }, (store) => {
        const matches = store
          .rows()
          .map((candidate) => candidate.stagedRebaseSourceBinding)
          .filter(
            (source) =>
              source?.successor?.attestationId === input.attestationId &&
              source.successor.generation === input.generation,
          );
        if (matches.length > 1) {
          throw new Error("implementation successor is claimed by multiple retired sources");
        }
        const source = matches[0];
        return source === undefined
          ? undefined
          : Object.freeze({
              sourceReference: source.sourceReference,
              source: Object.freeze({ ...source.source }),
              leaseGeneration: source.leaseGeneration,
              guardedRebase: source.guardedRebase,
              ontoCommit: source.ontoCommit,
              guardedRebaseJournalDigest: source.guardedRebaseJournalDigest,
            });
      });
      const queue = await enqueueImplementationCandidateOn(
        options.backend,
        {
          namespace,
          actor: "trusted-extension",
          attestationId: input.attestationId,
          generation: input.generation,
          repositoryId: binding.repositoryId,
          integrationRef,
          authority: {
            taskId: binding.taskId,
            goalRef,
            finalizedManifestDigest: taskEvidence.finalizedManifestDigest,
          },
          observedBaseCommit: binding.guardedRebaseBridge?.ontoCommit ?? binding.baseCommit,
          resultCommit,
          resultTree,
          gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          packagedEnvironmentDigest: row.promptProvenance.catalogHash,
          gitReceipts: gitReceipts as unknown as readonly GitChangeBrokerReceipt[],
          gitEffectBinding: binding,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
          ...(stagedRebaseSource === undefined ? {} : { stagedRebaseSource }),
        },
        { now },
      );
      const nativeCompletion = Object.freeze({
        kind: "native-completion" as const,
        actor: "trusted-extension" as const,
        childId: row.expectedChild.childId,
        runId: row.expectedChild.runId,
        completedAt: input.observedAt,
      });
      const qualification = await qualifyDispatchStagedCompletionOn(
        options.backend,
        {
          namespace,
          actor: "trusted-extension",
          attestationId: input.attestationId,
          generation: input.generation,
          partitionKey: queue.partition.partitionKey,
          enrollmentId: queue.enrollment.enrollmentId,
          attemptId: queue.attempt.attemptId,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
          expectedChild: row.expectedChild,
          expectedProvenance: {
            roleId: row.promptProvenance.roleId,
            version: row.promptProvenance.version,
            promptDigest: row.promptProvenance.promptDigest,
            inputDigest: row.promptProvenance.inputDigest,
          },
          nativeCompletion,
          completionObservationDigest: dispatchPayloadDigest(input as unknown as DispatchJSONValue),
        },
        { now },
      );
      if (qualification.state === "aborted") {
        rememberTerminal(qualification.result, qualification.result.abortedAt);
        return Object.freeze({ state: "aborted" as const, result: qualification.result });
      }
      return Object.freeze({
        state: "queued" as const,
        attestationId: input.attestationId,
        generation: input.generation,
        partitionKey: queue.partition.partitionKey,
        outputDigest: row.gateSubmittedOutputDigest!,
        qualificationDigest: qualification.qualification.qualificationDigest,
      });
    },
    coordinateImplementationCandidate: async (
      input,
    ): Promise<CoordinateImplementationCandidateOutcome> => {
      assertImplementationExecutor("acquire");
      if ("partitionKey" in input) {
        return await implementationCandidateCoordinator.run(input);
      }
      const partitionKey = await options.backend.transact(
        { kind: "handle", handle: input },
        (store): string => {
          const persisted = store.read(input);
          if (persisted === undefined || isAttestationTombstone(persisted)) {
            throw new Error("implementation candidate coordination requires a live dispatch");
          }
          if (
            persisted.parentGateCapabilityHash === undefined ||
            !parentGateCapabilityMatches(
              input.parentGateCapability.token,
              persisted.parentGateCapabilityHash,
            )
          ) {
            throw new Error("implementation candidate coordination parent authority is invalid");
          }
          if (persisted.implementationQueue === undefined) {
            throw new Error("implementation candidate coordination requires a queued dispatch");
          }
          return persisted.implementationQueue.partition.partitionKey;
        },
      );
      return await implementationCandidateCoordinator.run({
        partitionKey,
        holderId: input.holderId,
        expectedCandidate: {
          attestationId: input.attestationId,
          generation: input.generation,
        },
      });
    },
    finalizeParentGate: async (input) => {
      assertImplementationExecutor("gate");
      const binding = await resolveDispatchGitEffectBindingForHandleOn(options.backend, input);
      if (binding === undefined) {
        throw new Error("parent gate finalization requires a managed worktree binding");
      }
      return await withManagedWorktreeEffectLock(
        binding,
        {
          ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
          effectLockTimeoutMs: CODEX_STAGED_TIMING_BASIS.parentEffectLockAcquisitionMs,
        },
        async () => {
          const claimed = await claimParentGateOn(options.backend, input, { now });
          if (claimed.state === "result-stored") {
            return Object.freeze({ state: "result-stored" as const, result: claimed.result });
          }
          if (claimed.state === "aborted") {
            return Object.freeze({ state: "aborted" as const, result: claimed.result });
          }
          return await superviseClaimedParentGate(
            input,
            binding,
            claimed,
            async (output) =>
              await completeParentGateOn(
                options.backend,
                { ...input, gateEpoch: claimed.gateEpoch, output },
                { now },
              ),
          );
        },
      );
    },
    confirmCompletion: async (input) => {
      const replay = await replayConfirmedDispatchCompletionOn(
        options.backend,
        { namespace, ...input },
        { now },
      );
      if (replay !== undefined) {
        rememberTerminal(replay.result, replay.result.consumedAt);
        return replay;
      }
      const binding = await resolveDispatchGitEffectBindingForHandleOn(options.backend, input);
      const confirm = async () => {
        let continuationContext;
        if (binding !== undefined && binding.conflictStateDigest === undefined) {
          const liveTip = await observeManagedWorktreeLiveTip(
            binding,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
          );
          const gitReceipts = await resolveInheritedGitChangeReceipts(
            {
              ...binding,
              attestationId: input.attestationId,
              generation: input.generation,
            },
            liveTip,
            options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
          );
          continuationContext = { liveTip, gitReceipts };
        }
        return await confirmDispatchCompletionOn(
          options.backend,
          {
            namespace,
            ...input,
            ...(continuationContext === undefined ? {} : { continuationContext }),
          },
          { now },
        );
      };
      const outcome =
        binding === undefined
          ? await confirm()
          : await withManagedWorktreeEffectLock(
              binding,
              options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir },
              confirm,
            );
      rememberTerminal(
        outcome.result,
        outcome.state === "consumed" ? outcome.result.consumedAt : outcome.result.abortedAt,
      );
      return outcome;
    },
    abort: async (input) => {
      const binding = await resolveDispatchGitEffectBindingForHandleOn(options.backend, input);
      if (binding !== undefined) {
        const cancellation = await requestParentGateCancellationOn(
          options.backend,
          { namespace, actor: "trusted-parent", ...input },
          { now },
        );
        if (cancellation.state === "aborted") {
          rememberTerminal(cancellation.result, cancellation.result.abortedAt);
          return cancellation.result;
        }
        if (cancellation.state === "cancellation-requested") {
          await settleWorktreeGateCommands({
            worktree: binding.worktreePath,
          });
        }
      }
      const result = await abortWithRecovery(input, binding);
      rememberTerminal(result, result.abortedAt);
      return result;
    },
    fetch: (input) =>
      fetchDispatchResultOn(
        options.backend,
        { namespace, actor: "trusted-parent", ...input },
        { now },
      ),
    observeEvidence: async (input) =>
      await options.backend.transact({ kind: "handle", handle: input }, (store) => {
        const row = store.read(input);
        if (row === undefined || isAttestationTombstone(row)) return { state: "missing" as const };
        const base = {
          roleId: row.promptProvenance.roleId,
          input: structuredClone(row.input),
          retainedAttestation: row.attestationId,
        };
        if (row.state === "consumed") {
          if (row.output === undefined) {
            throw new Error("consumed dispatch evidence has no stored output");
          }
          return {
            state: "consumed" as const,
            ...base,
            output: structuredClone(row.output),
          };
        }
        if (row.state === "aborted") return { state: "aborted" as const, ...base };
        return { state: "nonterminal" as const, ...base };
      }),
    ...(options.repositoryRoot === undefined ||
    options.ledgerStore === undefined ||
    options.implementationEvidenceStore === undefined
      ? {}
      : {
          resolveImplementationCandidateAuthority,
          reserveImplementationCandidateAuthority,
          releaseImplementationCandidateAuthority,
        }),
    gitCommit: async (input) => {
      assertImplementationExecutor("git");
      if (options.repositoryRoot === undefined) {
        throw new Error("git_commit is unavailable without a local repository root");
      }
      const authorize = async () =>
        await authorizeDispatchGitEffectOn(
          options.backend,
          {
            namespace,
            attestationId: input.attestationId,
            generation: input.generation,
            gitChangeCapability: input.gitChangeCapability,
          },
          { now },
        );
      const authorization = await authorize();
      return await commitManagedWorktreeChanges(
        {
          authorization,
          operationId: input.operationId,
          expectedHead: input.expectedHead,
          message: input.message,
          changes: input.changes,
        },
        {
          ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
          now: () => new Date(now()),
          authorize: async (expected) => {
            const observed = await authorize();
            if (
              observed.attestationId !== expected.attestationId ||
              observed.generation !== expected.generation ||
              observed.taskId !== expected.taskId ||
              observed.handleToken !== expected.handleToken ||
              observed.handleFingerprint !== expected.handleFingerprint ||
              observed.repositoryRoot !== expected.repositoryRoot ||
              observed.repositoryId !== expected.repositoryId ||
              observed.commonDir !== expected.commonDir ||
              observed.worktreePath !== expected.worktreePath ||
              observed.branch !== expected.branch ||
              observed.ref !== expected.ref ||
              observed.baseCommit !== expected.baseCommit ||
              observed.roleId !== expected.roleId ||
              observed.surface !== expected.surface ||
              observed.childCancelAt !== expected.childCancelAt
            ) {
              throw new Error("dispatch Git authorization changed during broker operation");
            }
          },
        },
      );
    },
    gitResolveContinue: async (input) => {
      assertImplementationExecutor("git");
      if (options.repositoryRoot === undefined) {
        throw new Error("git_resolve_continue is unavailable without a local repository root");
      }
      const authorize = async () =>
        await authorizeDispatchGitConflictOn(
          options.backend,
          {
            namespace,
            attestationId: input.attestationId,
            generation: input.generation,
            gitConflictCapability: input.gitConflictCapability,
          },
          { now },
        );
      const authorization = await authorize();
      const ledgerStore = options.ledgerStore;
      return await continueManagedWorktreeRebase(
        {
          authorization,
          operationId: input.operationId,
          expectedState: input.expectedState,
          resolutions: input.resolutions,
        },
        {
          ...(options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir }),
          now: () => new Date(now()),
          ...(ledgerStore === undefined
            ? {}
            : {
                runRebaseContinue: async (expected, resolveBinding, environment) =>
                  await runLedgerWorksetGitEffect({
                    store: ledgerStore,
                    expected,
                    resolve: resolveBinding,
                    environment,
                  }),
              }),
          authorize: async (expected) => {
            const observed = await authorize();
            for (const field of [
              "attestationId",
              "generation",
              "taskId",
              "handleToken",
              "handleFingerprint",
              "repositoryRoot",
              "repositoryId",
              "commonDir",
              "worktreePath",
              "branch",
              "ref",
              "baseCommit",
              "conflictStateDigest",
              "roleId",
              "surface",
              "childCancelAt",
            ] as const) {
              if (observed[field] !== expected[field]) {
                throw new Error(`dispatch Git conflict authorization changed at ${field}`);
              }
            }
          },
        },
      );
    },
    observeWorktreeActivity: async (worktreePath) =>
      await options.backend.transact({ kind: "namespace" }, (store) => {
        const liveDispatches: string[] = [];
        const liveLeases: string[] = [];
        for (const row of store.rows()) {
          if (
            isAttestationTombstone(row) ||
            row.gitEffectBinding === undefined ||
            resolve(row.gitEffectBinding.worktreePath) !== resolve(worktreePath)
          ) {
            continue;
          }
          const owner = `${row.attestationId}#${row.generation}`;
          if (row.state === "prepared") liveDispatches.push(owner);
          if (
            row.state === "gate-pending" ||
            row.state === "gate-running" ||
            row.state === "result-stored"
          ) {
            liveLeases.push(owner);
          }
        }
        return { liveDispatches, liveLeases };
      }),
    resolveRecovery: async (gitEffectBinding, liveTip) => {
      const deps =
        options.worktreeStateDir === undefined ? {} : { stateDir: options.worktreeStateDir };
      return await withManagedWorktreeEffectLock(gitEffectBinding, deps, async () => {
        await assertManagedWorktreeDispatchBindingLive(gitEffectBinding, deps);
        if ((await observeManagedWorktreeLiveTip(gitEffectBinding, deps)) !== liveTip) {
          throw new Error("managed recovery tip changed before the effect lock was acquired");
        }
        const existingJournal =
          recoveryJournal === undefined
            ? null
            : await recoveryJournal.read(gitEffectBinding.taskId);
        const task =
          options.ledgerStore === undefined
            ? undefined
            : options.ledgerStore.fetchItem(TASKS_LEDGER, gitEffectBinding.taskId);
        const goalRefs = task === undefined ? [] : task.fields["ledgerRefs"];
        const hasGoal =
          Array.isArray(goalRefs) &&
          goalRefs.some((ref) => typeof ref === "string" && ref.startsWith("goals:"));
        if (existingJournal !== null || hasGoal) {
          if (
            options.ledgerStore === undefined ||
            recoveryJournal === undefined ||
            options.repositoryRoot === undefined
          ) {
            throw new Error("current managed recovery requires the finalized task and its journal");
          }
          const seal = await captureCurrentDispatchRecoverySealUnderLock(
            {
              backend: options.backend,
              ledgerStore: options.ledgerStore,
              repositoryRoot: options.repositoryRoot,
              taskId: gitEffectBinding.taskId,
              ...deps,
              now,
            },
            gitEffectBinding,
            liveTip,
            recoveryJournal,
          );
          return Object.freeze({
            status: "dispatch-recovery-resolved" as const,
            taskId: gitEffectBinding.taskId,
            liveTip,
            preparation: {
              kind: "current" as const,
              recoveryPreparation: {
                recoverySeedRef: seal.sealReference,
                fenceCapability: {
                  scope: "dispatch-lineage-fence" as const,
                  token: gitEffectBinding.handleToken,
                },
              },
            },
          });
        }
        const recovery = await options.backend.transact({ kind: "namespace" }, (store) => {
          assertManagedRecoveryTipEligible(store.rows(), gitEffectBinding, liveTip);
          return discoverDispatchRecovery(
            { namespace, actor: "trusted-parent", gitEffectBinding, liveTip },
            { store, now },
          );
        });
        return Object.freeze({
          status: "dispatch-recovery-resolved" as const,
          taskId: recovery.gitEffectBinding.taskId,
          liveTip: recovery.liveTip,
          terminalAt: recovery.terminalAt,
          preparation: { kind: "legacy" as const, recovery: recovery.recoveryReference },
        });
      });
    },
    resolveContinuation: async (gitEffectBinding, liveTip) => {
      const continuation = await discoverDispatchContinuationOn(
        options.backend,
        {
          namespace,
          actor: "trusted-parent",
          gitEffectBinding,
          liveTip,
        },
        { now },
      );
      return Object.freeze({
        status: "dispatch-continuation-resolved" as const,
        continuationReference: continuation.continuationReference,
        taskId: continuation.gitEffectBinding.taskId,
        liveTip: continuation.liveTip,
        terminalAt: continuation.terminalAt,
      });
    },
  };
  return capability;
}

export type DispatchRuntime =
  | {
      readonly kind: "available";
      readonly capability: DispatchCapability;
      readonly implementationQueueRollout: UpgradeLiveImplementationQueueSummary | null;
      close(): Promise<void>;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      close(): Promise<void>;
    };

function unavailable(reason: string): DispatchRuntime {
  return Object.freeze({
    kind: "unavailable" as const,
    reason,
    close: async (): Promise<void> => {},
  });
}

function available(
  backend: AttestationBackend,
  promptArtifactStore: PromptArtifactStore,
  implementationExecutorMode: "local-xdg" | "metadata-only",
  implementationQueueRollout: UpgradeLiveImplementationQueueSummary | null,
  narrativeSource?: DispatchNarrativeSource,
  repositoryRoot?: string,
  ledgerStore?: LedgerStore,
  implementationEvidenceStore?: ImplementationEvidenceStore,
  implementationSuccessorLauncher?: DispatchCapabilityOptions["implementationSuccessorLauncher"],
  supervisedWorkerGateRunner?: SupervisedWorkerGateRunner,
): DispatchRuntime {
  return Object.freeze({
    kind: "available" as const,
    implementationQueueRollout,
    capability: createDispatchCapability({
      backend,
      promptArtifactStore,
      implementationExecutorMode,
      ...(narrativeSource === undefined ? {} : { narrativeSource }),
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      ...(ledgerStore === undefined ? {} : { ledgerStore }),
      ...(implementationEvidenceStore === undefined ? {} : { implementationEvidenceStore }),
      ...(implementationSuccessorLauncher === undefined ? {} : { implementationSuccessorLauncher }),
      ...(supervisedWorkerGateRunner === undefined ? {} : { supervisedWorkerGateRunner }),
    }),
    close: async (): Promise<void> => backend.close(),
  });
}

async function resolveLegacyImplementationQueueRow(
  row: AttestationEnvelope,
  ledgerStore: LedgerStore,
): Promise<LegacyImplementationResolution> {
  const incompatible = (reason: string, detail?: string): LegacyImplementationResolution => ({
    state: "incompatible",
    detail: {
      reason,
      ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
    },
  });
  const binding = row.gitEffectBinding;
  if (binding === undefined || row.promptProvenance.roleId !== "implement-worker") {
    return incompatible("managed-worktree-binding-unavailable");
  }
  let evidence: GitChangeBrokerResultEvidence | undefined;
  try {
    evidence = brokerResultEvidence(row.output ?? null);
  } catch (error) {
    return incompatible(
      "worker-result-evidence-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (evidence === undefined) return incompatible("passing-worker-result-unavailable");
  let normalized: GitChangeBrokerResultEvidence;
  try {
    normalized = await validateGitChangeBrokerResultEvidence(
      {
        ...binding,
        attestationId: row.attestationId,
        generation: row.generation,
        roleId: "implement-worker",
        surface: row.promptProvenance.surface,
        childCancelAt: row.deadlines.childCancelAt,
      },
      evidence,
    );
  } catch (error) {
    return incompatible(
      "worker-result-evidence-rejected",
      error instanceof Error ? error.message : String(error),
    );
  }
  const resultCommit = normalized.resultCommit;
  if (resultCommit === null) return incompatible("worker-result-commit-unavailable");
  if (row.gateSubmittedOutputDigest === undefined) {
    return incompatible("staged-output-digest-unavailable");
  }

  if (row.state === "result-stored") {
    const output = row.output;
    if (!dispatchObject(output) || row.outputDigest !== dispatchPayloadDigest(output)) {
      return incompatible("completed-output-binding-mismatch");
    }
    const gate = output["supervisedGateEvidence"];
    if (
      !dispatchObject(gate) ||
      !validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, gate).ok ||
      gate["attestationId"] !== row.attestationId ||
      gate["generation"] !== row.generation ||
      gate["taskId"] !== binding.taskId ||
      gate["worktreePath"] !== binding.worktreePath ||
      gate["branch"] !== binding.branch ||
      gate["resultCommit"] !== resultCommit ||
      gate["promptDigest"] !== row.promptProvenance.promptDigest ||
      gate["catalogHash"] !== row.promptProvenance.catalogHash ||
      gate["inputDigest"] !== row.promptProvenance.inputDigest
    ) {
      return incompatible("completed-green-evidence-rejected");
    }
    try {
      await assertManagedWorktreeWipClosure(binding, resultCommit);
    } catch (error) {
      return incompatible(
        "completed-green-worktree-projection-rejected",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      state: "completed-green",
      evidence: {
        outputDigest: row.outputDigest,
        resultCommit,
        managedWorktreeBindingDigest: dispatchPayloadDigest(
          binding as unknown as DispatchJSONValue,
        ),
        supervisedGateEvidenceDigest: dispatchPayloadDigest(gate),
      },
    };
  }
  if (row.state !== "gate-pending") {
    return incompatible(`unsupported-legacy-state-${row.state}`);
  }

  try {
    const taskEvidence = currentRecoveryTaskEvidence(ledgerStore, binding.taskId);
    const integrationRef = await readOnlyGit(binding.repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    const resultTree = await readOnlyGit(binding.worktreePath, [
      "rev-parse",
      "--verify",
      `${resultCommit}^{tree}`,
    ]);
    return {
      state: "compatible",
      candidate: {
        repositoryId: binding.repositoryId,
        integrationRef,
        authority: {
          taskId: binding.taskId,
          goalRef: exactGoalRef(ledgerStore, binding.taskId),
          finalizedManifestDigest: taskEvidence.finalizedManifestDigest,
        },
        observedBaseCommit: binding.guardedRebaseBridge?.ontoCommit ?? binding.baseCommit,
        resultCommit,
        resultTree,
        gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
        packagedEnvironmentDigest: row.promptProvenance.catalogHash,
        gitReceipts: normalized.gitReceipts,
        gitEffectBinding: binding,
        stagedOutputDigest: row.gateSubmittedOutputDigest,
      },
    };
  } catch (error) {
    return incompatible(
      "queue-candidate-binding-rejected",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface SingleProjectDispatchRuntimeOptions {
  readonly construction: SingleProjectConstruction;
  readonly resolved: ResolvedLedgerStore;
  readonly promptArtifactStore?: PromptArtifactStore;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly implementationSuccessorLauncher?: DispatchCapabilityOptions["implementationSuccessorLauncher"];
  readonly supervisedWorkerGateRunner?: SupervisedWorkerGateRunner;
}

export interface SingleProjectImplementationCandidateAuthority {
  resolve(input: {
    readonly workerDispatch: { readonly attestationId: string; readonly generation: number };
    readonly taskRef: string;
    readonly resultCommit: string;
  }): Promise<ImplementationCandidateAuthorityReceipt>;
  reserve(
    receipt: ImplementationCandidateAuthorityReceipt,
    binding: ImplementationCandidateCompletionReservationBinding,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Open only the durable candidate/lease authority needed by the direct merge gate. */
export async function createSingleProjectImplementationCandidateAuthority(input: {
  readonly resolved: ResolvedLedgerStore;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<SingleProjectImplementationCandidateAuthority> {
  const backend = assertAttestationConstructionSupported("direct", input.resolved.backend);
  if (backend !== "xdg") {
    throw new Error(`unsupported direct candidate authority backend: ${backend}`);
  }
  const projectId = loadConfig(input.resolved.configRoot)?.ledger?.projectId ?? null;
  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: "direct",
    backend,
    repoRoot: input.resolved.configRoot,
    projectId,
  });
  const attestationBackend = await createAttestationStoreForConstruction({
    backend: "xdg",
    namespace,
    ...(input.environment === undefined ? {} : { env: input.environment }),
  });
  const promptArtifactStore: PromptArtifactStore = {
    readManifest: () => {
      throw new Error("candidate authority cannot read prompt artifacts");
    },
    readRole: () => {
      throw new Error("candidate authority cannot read prompt artifacts");
    },
  };
  const capability = createDispatchCapability({
    backend: attestationBackend,
    promptArtifactStore,
    repositoryRoot: input.resolved.configRoot,
    ledgerStore: input.resolved.store,
    ...(input.resolved.implementationEvidenceStore === undefined
      ? { implementationExecutorMode: "metadata-only" as const }
      : { implementationEvidenceStore: input.resolved.implementationEvidenceStore }),
  });
  if (capability.resolveImplementationCandidateAuthority === undefined) {
    await attestationBackend.close();
    throw new Error("direct implementation candidate authority is unavailable");
  }
  if (capability.reserveImplementationCandidateAuthority === undefined) {
    await attestationBackend.close();
    throw new Error("direct implementation candidate reservation is unavailable");
  }
  return Object.freeze({
    resolve: async (request: {
      readonly workerDispatch: { readonly attestationId: string; readonly generation: number };
      readonly taskRef: string;
      readonly resultCommit: string;
    }) => await capability.resolveImplementationCandidateAuthority!(request),
    reserve: async (
      receipt: ImplementationCandidateAuthorityReceipt,
      binding: ImplementationCandidateCompletionReservationBinding,
    ) => await capability.reserveImplementationCandidateAuthority!(receipt, binding),
    close: async () => await attestationBackend.close(),
  });
}

/**
 * Bind one production single-project server to the matching durable
 * attestation backend. Unsupported construction/backend cells and launches
 * without an attested prompt surface return an unavailable registration
 * verdict; callers must omit the five lifecycle tools in that case.
 */
export async function createSingleProjectDispatchRuntime(
  options: SingleProjectDispatchRuntimeOptions,
): Promise<DispatchRuntime> {
  let backend: ReturnType<typeof assertAttestationConstructionSupported>;
  try {
    backend = assertAttestationConstructionSupported(
      options.construction,
      options.resolved.backend,
    );
  } catch (error) {
    if (error instanceof AttestationBackendUnsupportedError) {
      return unavailable(error.message);
    }
    throw error;
  }
  if (backend !== "xdg") {
    return unavailable(`unsupported single-project attestation backend: ${backend}`);
  }
  if (options.promptArtifactStore === undefined) {
    return unavailable("no attested prompt artifact surface is configured");
  }

  const projectId = loadConfig(options.resolved.configRoot)?.ledger?.projectId ?? null;
  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: options.construction,
    backend,
    repoRoot: options.resolved.configRoot,
    projectId,
  });
  const attestationBackend = await createAttestationStoreForConstruction({
    backend: "xdg",
    namespace,
    ...(options.environment === undefined ? {} : { env: options.environment }),
  });

  let implementationQueueRollout: UpgradeLiveImplementationQueueSummary | null = null;
  if (options.resolved.implementationEvidenceStore !== undefined) {
    try {
      implementationQueueRollout = await upgradeLiveImplementationQueueRows({
        backend: attestationBackend,
        now: () => new Date().toISOString(),
        resolve: async (row) =>
          await resolveLegacyImplementationQueueRow(row, options.resolved.store),
        withProtectedManagedWorktree: async (binding, operation) =>
          await withManagedWorktreeEffectLock(binding, {}, async () => {
            const liveBinding = await resolveManagedWorktreeDispatchBinding({
              repositoryRoot: binding.repositoryRoot,
              taskId: binding.taskId,
              worktreePath: binding.worktreePath,
              branch: binding.branch,
            });
            if (liveBinding === null) {
              return {
                state: "incompatible" as const,
                detail: { reason: "managed-worktree-binding-no-longer-live" },
              };
            }
            await assertManagedWorktreeDispatchBindingLive(binding);
            return { state: "protected" as const, value: await operation() };
          }),
      });
    } catch (error) {
      await attestationBackend.close();
      throw error;
    }
  }

  return available(
    attestationBackend,
    options.promptArtifactStore,
    options.resolved.implementationEvidenceStore === undefined ? "metadata-only" : "local-xdg",
    implementationQueueRollout,
    createDispatchNarrativeSource(options.resolved.store, namespace.projectKey),
    options.resolved.configRoot,
    options.resolved.store,
    options.resolved.implementationEvidenceStore,
    options.implementationSuccessorLauncher,
    options.supervisedWorkerGateRunner,
  );
}

export interface PostgresHubDispatchRuntimeOptions {
  readonly pool: SQL;
  readonly trustedProjectKey: string;
  readonly store?: LedgerStore;
  readonly promptArtifactStore?: PromptArtifactStore;
}

/** Bind one trusted PostgreSQL hub tenant to its namespaced attestation store. */
export async function createPostgresHubDispatchRuntime(
  options: PostgresHubDispatchRuntimeOptions,
): Promise<DispatchRuntime> {
  assertAttestationConstructionSupported("postgres-hub", "postgres");
  if (options.promptArtifactStore === undefined) {
    return unavailable("no attested prompt artifact surface is configured");
  }
  const namespace = attestationNamespaceForTrustedHubProject(options.trustedProjectKey);
  const backend = await createAttestationStoreForConstruction({
    backend: "postgres",
    namespace,
    pool: options.pool,
  });
  return available(
    backend,
    options.promptArtifactStore,
    "metadata-only",
    null,
    options.store === undefined
      ? undefined
      : createDispatchNarrativeSource(options.store, namespace.projectKey),
  );
}

/**
 * Assert a named construction/backend pair cannot expose dispatch tools and
 * turn that refusal into the registration verdict used by unsupported hosts.
 */
export function refuseDispatchRuntime(
  construction: LedgerServerConstruction,
  backend: string,
): DispatchRuntime {
  try {
    assertAttestationConstructionSupported(construction, backend);
  } catch (error) {
    if (error instanceof AttestationBackendUnsupportedError) {
      return unavailable(error.message);
    }
    throw error;
  }
  throw new Error(`dispatch construction ${construction}:${backend} is supported`);
}
