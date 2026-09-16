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
  prepareDispatchOn,
  prepareDispatchRequestDigest,
  qualifyDispatchStagedCompletionOn,
  resolveDispatchGitEffectBindingOn,
  resolveSupervisedWorkerGateContextOn,
  resolveDispatchGitEffectBindingForHandleOn,
  resolveDispatchRecoveryOn,
  resolveDispatchContinuationOn,
  storeDispatchResultOn,
  validateDispatchInput,
  type AttestationBackend,
  type AttestationEnvelope,
  type DispatchNarrativeSource,
  type DispatchJSONValue,
  type DispatchPrepareAccepted,
  type DispatchPreLaunchRejection,
  type PrepareDispatchOutcome,
  type PrepareDispatchRequest,
} from "@cq/config";
import type { SQL } from "bun";
import { resolve } from "node:path";
import {
  assertAttestationConstructionSupported,
  assertManagedWorktreeDispatchBindingLive,
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
} from "./dispatchRecoverySeal.js";
import {
  ImplementationCandidateCoordinator,
  ImplementationCandidateQueueAdapter,
  type ImplementationCandidateCoordinatorOperations,
} from "./implementationCandidateQueue.js";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

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

function exactGoalRef(store: LedgerStore, taskId: string): string {
  const task = store.fetchItem(TASKS_LEDGER, taskId);
  const goalRefs = (Array.isArray(task.fields["ledgerRefs"])
    ? task.fields["ledgerRefs"]
    : []
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
    ["promptDigest", input.promptDigest],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`implementation candidate ${field} must be non-empty`);
    }
  }
  if (input.outcome !== "completed") {
    throw new Error("only a completed Codex process observation can qualify a candidate");
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
          ...(options.worktreeStateDir === undefined
            ? {}
            : { stateDir: options.worktreeStateDir }),
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
      await materializeGuardedRebaseBridge({
        reference: input.guardedRebase,
        prior: {
          ...prior,
          attestationId: reprepareOf.attestationId,
          generation: reprepareOf.generation,
        },
        current: binding,
        baseCommitInput: baseCommit,
        startingCommitInput: startingCommit,
        priorResultCommitInput:
          (record["priorResultCommit"] as string | null | undefined) ?? null,
        ...(options.worktreeStateDir === undefined
          ? {}
          : { stateDir: options.worktreeStateDir }),
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
      noOtherAuthority &&
      input.continuation === undefined &&
      input.guardedRebase !== undefined;
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

  const implementationCandidateQueue = new ImplementationCandidateQueueAdapter({
    backend: options.backend,
    actor: "trusted-extension",
    now,
  });

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
        let output: DispatchJSONValue;
        try {
          output = await superviseImplementWorkerGate(
            { context: claimed.context, output: claimed.output },
            {
              ...(options.worktreeStateDir === undefined
                ? {}
                : { stateDir: options.worktreeStateDir }),
              ...(options.supervisedWorkerGateRunner === undefined
                ? {}
                : { runner: options.supervisedWorkerGateRunner }),
            },
          );
        } catch (error) {
          if (error instanceof SupervisedWorkerGateRejectedError) {
            await abortWithRecovery(
              {
                attestationId: input.lease.attestationId,
                generation: input.lease.generation,
                reason: "gate-rejected",
                details: error.details as unknown as DispatchJSONValue,
              },
              binding,
              true,
            );
          }
          throw error;
        }
        await completeQualifiedParentGateOn(
          options.backend,
          {
            ...input.lease,
            queueLease: input.lease,
            gateEpoch: claimed.gateEpoch,
            output,
          },
          { now },
        );
      },
    );
  }

  async function confirmAndFetchQualifiedImplementationFront(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly nativeCompletion: Parameters<DispatchCapability["confirmCompletion"]>[0]["nativeCompletion"];
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
    const fetched = await fetchDispatchResultOn(
      options.backend,
      {
        namespace,
        actor: "trusted-parent",
        attestationId: input.lease.attestationId,
        generation: input.lease.generation,
      },
      { now },
    );
    if (fetched.state !== "consumed") {
      throw new Error(`qualified implementation front fetched as ${fetched.state}`);
    }
  }

  interface StaleImplementationCandidateRun {
    readonly source: Awaited<ReturnType<ImplementationCandidateQueueAdapter["retireStagedRebaseSource"]>>;
    readonly guardedRebase: string;
    readonly guardedRebaseJournalDigest: string;
    readonly rebasedStartCommit: string;
    readonly sourceRow: AttestationEnvelope;
  }
  const staleImplementationCandidateRuns = new Map<string, StaleImplementationCandidateRun>();

  async function retireAndRebaseStaleImplementationFront(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly ontoCommit: string;
  }): Promise<{ readonly sourceReference: string }> {
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
        (await readOnlyGit(dispatchBinding.repositoryRoot, ["rev-parse", "HEAD"])) !==
        input.ontoCommit
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
    if (rebase.kind !== "finalized") {
      throw new Error("stale implementation candidate rebase stopped on a conflict");
    }
    if (source === undefined) {
      throw new Error("stale implementation candidate rebase did not retire its source");
    }
    const run: StaleImplementationCandidateRun = Object.freeze({
      source,
      guardedRebase: rebase.reference,
      guardedRebaseJournalDigest: rebase.bridge.requestDigest,
      rebasedStartCommit: rebase.bridge.rebasedStartCommit,
      sourceRow,
    });
    staleImplementationCandidateRuns.set(input.control.attempt.attemptId, run);
    return Object.freeze({ sourceReference: source.sourceReference });
  }

  async function rebaseRetiredImplementationFront(input: {
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly retirement: { readonly sourceReference: string };
    readonly ontoCommit: string;
  }): Promise<{ readonly guardedRebase: string }> {
    const run = staleImplementationCandidateRuns.get(input.control.attempt.attemptId);
    if (
      run === undefined ||
      run.source.sourceReference !== input.retirement.sourceReference ||
      run.source.ontoCommit !== input.ontoCommit
    ) {
      throw new Error("stale implementation candidate rebase checkpoint is unavailable");
    }
    return Object.freeze({ guardedRebase: run.guardedRebase });
  }

  async function prepareStaleImplementationSuccessor(input: {
    readonly lease: Parameters<ImplementationCandidateQueueAdapter["inspectLease"]>[0];
    readonly control: Awaited<ReturnType<ImplementationCandidateQueueAdapter["inspectLease"]>>;
    readonly retirement: { readonly sourceReference: string };
    readonly rebase: { readonly guardedRebase: string };
    readonly ontoCommit: string;
  }): Promise<{ readonly attestationId: string; readonly generation: number }> {
    const run = staleImplementationCandidateRuns.get(input.control.attempt.attemptId);
    if (
      run === undefined ||
      run.source.sourceReference !== input.retirement.sourceReference ||
      run.guardedRebase !== input.rebase.guardedRebase ||
      run.source.ontoCommit !== input.ontoCommit
    ) {
      throw new Error("stale implementation candidate successor checkpoint is unavailable");
    }
    if (
      run.sourceRow.input === null ||
      typeof run.sourceRow.input !== "object" ||
      Array.isArray(run.sourceRow.input)
    ) {
      throw new Error("stale implementation candidate source input is malformed");
    }
    const sourceInput = run.sourceRow.input as Readonly<Record<string, DispatchJSONValue>>;
    const round = sourceInput["round"];
    if (!Number.isSafeInteger(round) || (round as number) < 0) {
      throw new Error("stale implementation candidate source round is malformed");
    }
    const { guardedRebaseLineage: _guardedRebaseLineage, ...retainedInput } = sourceInput;
    const timeoutMs =
      attestationInstantMs(run.sourceRow.deadlines.childCancelAt, "deadlines.childCancelAt") -
      attestationInstantMs(run.sourceRow.createdAt, "createdAt");
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        ...retainedInput,
        baseCommit: input.ontoCommit,
        startingCommit: run.rebasedStartCommit,
        priorResultCommit: input.control.attempt.resultCommit,
        round: (round as number) + 1,
      },
      idempotencyKey: `implementation-successor-${dispatchPayloadDigest({
        sourceReference: run.source.sourceReference,
        guardedRebase: run.guardedRebase,
      })}`,
      timeoutMs,
      expectedChild: run.sourceRow.expectedChild,
      reprepareOf: {
        attestationId: input.lease.attestationId,
        generation: input.lease.generation,
      },
      guardedRebase: run.guardedRebase,
    });
    if (!prepared.accepted) {
      throw new Error(`stale implementation candidate successor was refused: ${prepared.detail}`);
    }
    return Object.freeze({ ...prepared.handle });
  }

  const implementationCandidateCoordinatorOperations: ImplementationCandidateCoordinatorOperations = {
    observeProtectedHead: async () => {
      if (options.repositoryRoot === undefined) {
        throw new Error("implementation candidate coordinator requires a local repository root");
      }
      return await readOnlyGit(options.repositoryRoot, ["rev-parse", "HEAD"]);
    },
    finalizeQualifiedFront: finalizeQualifiedImplementationFront,
    confirmAndFetchQualifiedFront: confirmAndFetchQualifiedImplementationFront,
    retireStaleSource: retireAndRebaseStaleImplementationFront,
    rebaseRetiredSource: rebaseRetiredImplementationFront,
    prepareSuccessor: prepareStaleImplementationSuccessor,
  };
  const implementationCandidateCoordinator = new ImplementationCandidateCoordinator(
    implementationCandidateQueue,
    implementationCandidateCoordinatorOperations,
  );

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
              bridge = await materializeGuardedRebaseBridge({
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
              baseCommit: bridge.ontoCommit,
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
        row.expectedChild.childId !== expectedChildId
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
        throw new Error("only a passing broker-verified worker result can enter the runnable queue");
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
          observedBaseCommit: binding.baseCommit,
          resultCommit,
          resultTree,
          gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
          packagedEnvironmentDigest: row.promptProvenance.catalogHash,
          gitReceipts: gitReceipts as unknown as readonly GitChangeBrokerReceipt[],
          gitEffectBinding: binding,
          stagedOutputDigest: row.gateSubmittedOutputDigest!,
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
    ): Promise<CoordinateImplementationCandidateOutcome> =>
      await implementationCandidateCoordinator.run(input),
    finalizeParentGate: async (input) => {
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
          let output: DispatchJSONValue;
          try {
            output = await superviseImplementWorkerGate(
              { context: claimed.context, output: claimed.output },
              {
                ...(options.worktreeStateDir === undefined
                  ? {}
                  : { stateDir: options.worktreeStateDir }),
                ...(options.supervisedWorkerGateRunner === undefined
                  ? {}
                  : { runner: options.supervisedWorkerGateRunner }),
              },
            );
          } catch (error) {
            if (error instanceof SupervisedWorkerGateRejectedError) {
              const rejected = await abortWithRecovery(
                {
                  attestationId: input.attestationId,
                  generation: input.generation,
                  reason: "gate-rejected",
                  details: error.details as unknown as DispatchJSONValue,
                },
                binding,
                true,
              );
              return Object.freeze({ state: "aborted" as const, result: rejected });
            }
            const message = error instanceof Error ? error.message : String(error);
            try {
              await abortWithRecovery(
                {
                  attestationId: input.attestationId,
                  generation: input.generation,
                  reason: "parent-lost",
                  details: { phase: "supervised-gate", message: message.slice(0, 1024) },
                },
                binding,
                true,
              );
            } catch (abortError) {
              const abortMessage =
                abortError instanceof Error ? abortError.message : String(abortError);
              throw new Error(`${message}; parent-lost terminalization failed: ${abortMessage}`, {
                cause: abortError,
              });
            }
            throw error;
          }
          const result = await completeParentGateOn(
            options.backend,
            { ...input, gateEpoch: claimed.gateEpoch, output },
            { now },
          );
          return Object.freeze({ state: "result-stored" as const, result });
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
    gitCommit: async (input) => {
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
            { namespace, actor: "trusted-parent", gitEffectBinding, liveTip }, { store, now },
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
  narrativeSource?: DispatchNarrativeSource,
  repositoryRoot?: string,
  ledgerStore?: LedgerStore,
  implementationEvidenceStore?: ImplementationEvidenceStore,
): DispatchRuntime {
  return Object.freeze({
    kind: "available" as const,
    capability: createDispatchCapability({
      backend,
      promptArtifactStore,
      ...(narrativeSource === undefined ? {} : { narrativeSource }),
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      ...(ledgerStore === undefined ? {} : { ledgerStore }),
      ...(implementationEvidenceStore === undefined ? {} : { implementationEvidenceStore }),
    }),
    close: async (): Promise<void> => backend.close(),
  });
}

export interface SingleProjectDispatchRuntimeOptions {
  readonly construction: SingleProjectConstruction;
  readonly resolved: ResolvedLedgerStore;
  readonly promptArtifactStore?: PromptArtifactStore;
  readonly environment?: Readonly<Record<string, string | undefined>>;
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

  return available(
    attestationBackend,
    options.promptArtifactStore,
    createDispatchNarrativeSource(options.resolved.store, namespace.projectKey),
    options.resolved.configRoot,
    options.resolved.store,
    options.resolved.implementationEvidenceStore,
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
