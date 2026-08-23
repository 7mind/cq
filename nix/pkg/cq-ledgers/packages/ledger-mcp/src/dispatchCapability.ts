import {
  CODEX_STAGED_TIMING_BASIS,
  DISPATCH_INPUT_VALIDATION_DEFERRED,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_REF_ASSEMBLY_DEFERRED,
  DISPATCH_TIMEOUT_MAX_MS,
  DISPATCH_TIMEOUT_MIN_MS,
  IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS,
  IMPLEMENT_REVIEWER_TIMEOUT_MIN_MS,
  IMPLEMENT_REVIEWER_TIMING_INPUT_FIELDS,
  IDEMPOTENCY_HORIZON_MS,
  AttestationKeyReuseError,
  AttestationBackendUnsupportedError,
  DispatchStateConflictError,
  abortDispatchOn,
  claimParentGateOn,
  completeParentGateOn,
  discoverDispatchContinuationOn,
  discoverDispatchRecoveryOn,
  authorizeDispatchGitConflictOn,
  authorizeDispatchGitEffectOn,
  assembleDispatchInput,
  attestationInstantMs,
  confirmDispatchCompletionOn,
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
  resolveDispatchGitEffectBindingOn,
  resolveSupervisedWorkerGateContextOn,
  resolveDispatchGitEffectBindingForHandleOn,
  resolveDispatchRecoveryOn,
  resolveDispatchContinuationOn,
  storeDispatchResultOn,
  validateDispatchInput,
  type AttestationBackend,
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
  attestationNamespaceForTrustedHubProject,
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
  observeManagedWorktreeLiveTip,
  resolveInheritedGitChangeReceipts,
  runLedgerWorksetGitEffect,
  withManagedWorktreeEffectLock,
  superviseImplementWorkerGate,
  resolveSingleProjectAttestationNamespace,
  type DispatchCapability,
  type GitChangeBrokerResultEvidence,
  type GitRebaseConflictState,
  type GitConflictContinuationResultEvidence,
  type LedgerStore,
  type LedgerServerConstruction,
  type ResolvedLedgerStore,
  type SupervisedWorkerGateRunner,
  type SingleProjectConstruction,
} from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

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

  function callerPrepareFingerprint(
    input: Parameters<DispatchCapability["prepare"]>[0],
  ): string | undefined {
    try {
      return dispatchPayloadDigest(input as unknown as DispatchJSONValue);
    } catch {
      return undefined;
    }
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

  return {
    prepare: async (input) => {
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
      const callerFingerprint = callerPrepareFingerprint(input);
      if (callerFingerprint !== undefined) {
        const replay = await replayCachedPrepare(
          input.idempotencyKey,
          callerFingerprint,
          "caller",
        );
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
        (roleId !== "implement-worker" ||
          input.reprepareOf === undefined ||
          options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "guardedRebase",
          "a guarded-rebase reference requires an implement-worker reprepareOf naming the exact terminal prior worker generation on a local repository",
        );
      }

      if (
        input.recovery !== undefined &&
        (roleId !== "implement-worker" ||
          input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.continuation !== undefined ||
          options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "recovery",
          "a terminal recovery reference requires an implement-worker on a local repository and must replace, not accompany, reprepareOf or guardedRebase",
        );
      }

      if (
        input.continuation !== undefined &&
        (roleId !== "implement-worker" ||
          input.reprepareOf !== undefined ||
          input.guardedRebase !== undefined ||
          input.recovery !== undefined ||
          options.repositoryRoot === undefined)
      ) {
        return rejectLaunch(
          "continuation",
          "a consumed continuation requires an implement-worker on a local repository and must replace, not accompany, reprepareOf, guardedRebase, or recovery",
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
      let continuationClaim;
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
          if (baseCommitInput !== continuation.gitEffectBinding.baseCommit) {
            return rejectLaunch(
              "input.baseCommit",
              "worker continuation baseCommit differs from the consumed managed binding",
            );
          }
          resolvedReprepareOf = continuation.reprepareOf;
          continuationClaim = {
            continuationReference: continuation.continuationReference,
            actor: "trusted-parent" as const,
            liveTip,
          };
          gitEffectBinding =
            continuation.gitReceipts.length === 0
              ? resolvedGitEffectBinding
              : {
                  ...resolvedGitEffectBinding,
                  inheritedGitReceipts: continuation.gitReceipts,
                };
          if (continuation.gitReceipts.length > 0) {
            dispatchInput = {
              ...dispatchRecord,
              inheritedGitReceipts: continuation.gitReceipts as unknown as DispatchJSONValue,
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
          if (baseCommitInput !== recovery.gitEffectBinding.baseCommit) {
            return rejectLaunch(
              "input.baseCommit",
              "worker recovery baseCommit differs from the terminal managed binding",
            );
          }
          resolvedReprepareOf = recovery.reprepareOf;
          gitEffectBinding =
            recovery.gitReceipts.length === 0
              ? resolvedGitEffectBinding
              : { ...resolvedGitEffectBinding, inheritedGitReceipts: recovery.gitReceipts };
          if (recovery.gitReceipts.length > 0) {
            dispatchInput = {
              ...dispatchRecord,
              inheritedGitReceipts: recovery.gitReceipts as unknown as DispatchJSONValue,
            };
          }
        } else if (input.reprepareOf === undefined) {
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
          const priorBinding = await resolveDispatchGitEffectBindingForHandleOn(
            options.backend,
            input.reprepareOf,
          );
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
          const guardedRebaseLineageOf = (bridge: {
            readonly guardedRebase: string;
            readonly oldResultCommit: string;
            readonly ontoCommit: string;
            readonly rebasedStartCommit: string;
            readonly exactTip: boolean;
          }): DispatchJSONValue =>
            ({
              guardedRebase: bridge.guardedRebase,
              oldResultCommit: bridge.oldResultCommit,
              ontoCommit: bridge.ontoCommit,
              rebasedStartCommit: bridge.rebasedStartCommit,
              exactTip: bridge.exactTip,
            }) as unknown as DispatchJSONValue;
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
                  attestationId: input.reprepareOf.attestationId,
                  generation: input.reprepareOf.generation,
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
            gitEffectBinding = { ...resolvedGitEffectBinding, guardedRebaseBridge: bridge };
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
                  attestationId: input.reprepareOf.attestationId,
                  generation: input.reprepareOf.generation,
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
              if (inheritedGitReceipts.length > 0) {
                dispatchInput = {
                  ...dispatchRecord,
                  inheritedGitReceipts: inheritedGitReceipts as unknown as DispatchJSONValue,
                };
              }
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
                ...(inheritedGitReceipts.length === 0
                  ? {}
                  : { inheritedGitReceipts: inheritedGitReceipts as unknown as DispatchJSONValue }),
                guardedRebaseLineage: guardedRebaseLineageOf(bridge),
              };
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
      } as const;
      const fingerprint = prepareDispatchRequestDigest(request);
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
        const pending = prepareDispatchOn(options.backend, request, {
          now,
          randomBytes,
        }).then((outcome: PrepareDispatchOutcome) => {
          if (!outcome.accepted) {
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
          throw error;
        }
      }
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
        const output = input.output;
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
            await withinStagingDeadline(
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
      const recovery = await discoverDispatchRecoveryOn(
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
        status: "dispatch-recovery-resolved" as const,
        recoveryReference: recovery.recoveryReference,
        taskId: recovery.gitEffectBinding.taskId,
        liveTip: recovery.liveTip,
        terminalAt: recovery.terminalAt,
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
): DispatchRuntime {
  return Object.freeze({
    kind: "available" as const,
    capability: createDispatchCapability({
      backend,
      promptArtifactStore,
      ...(narrativeSource === undefined ? {} : { narrativeSource }),
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      ...(ledgerStore === undefined ? {} : { ledgerStore }),
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
  let attestationBackend: AttestationBackend;
  switch (backend) {
    case "xdg":
      attestationBackend = await createAttestationStoreForConstruction({
        backend,
        namespace,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      });
      break;
    case "fs":
      attestationBackend = await createAttestationStoreForConstruction({
        backend,
        namespace,
        ledgerRoot: options.resolved.configRoot,
      });
      break;
    default:
      throw new Error(`unsupported single-project attestation backend: ${String(backend)}`);
  }
  return available(
    attestationBackend,
    options.promptArtifactStore,
    createDispatchNarrativeSource(options.resolved.store, namespace.projectKey),
    options.resolved.configRoot,
    options.resolved.store,
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
