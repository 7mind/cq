import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  dispatchPayloadDigest,
  isAttestationTombstone,
  loadConfig,
  type AttestationBackend,
  type AttestationEnvelope,
  type AttestationRow,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
} from "@cq/config";
import {
  CurrentRecoverySealError,
  FsCurrentRecoverySealJournalStore,
  GOALS_LEDGER,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PlanPublishedManifestSchema,
  TASKS_LEDGER,
  assertAttestationConstructionSupported,
  assertManagedWorktreeDispatchBindingLive,
  createAttestationStoreForConstruction,
  createCurrentRecoverySeal,
  createCurrentRecoverySeed,
  createDispatchLineageCutoverFence,
  currentRecoveryJournalRoot,
  currentRecoveryReceiptClosureDigest,
  currentRecoveryStatusFromJournal,
  listManagedLiveWorktrees,
  nodeManagedWorktreeGitRunner,
  observeManagedWorktreeLiveTip,
  resolveInheritedGitChangeReceipts,
  resolveManagedWorktreeDispatchBinding,
  resolveSingleProjectAttestationNamespace,
  selectStrictMaximalRecoverySource,
  withManagedWorktreeEffectLock,
  type CurrentRecoverySeal,
  type CurrentRecoverySealJournalStore,
  type CurrentRecoverySourceAbortReason,
  type CurrentRecoverySourceCandidate,
  type CurrentRecoveryStatus,
  type GitChangeBrokerReceipt,
  type LedgerStore,
  type ManagedWorktreeDispatchBinding,
  type ResolvedLedgerStore,
  type SingleProjectConstruction,
} from "@cq/ledger";

const TASK_ID = /^T[0-9]+$/u;
const TERMINAL_STATES: ReadonlySet<string> = new Set(["consumed", "aborted"]);
const ELIGIBLE_ABORT_REASONS: ReadonlySet<string> = new Set([
  "invalid-output",
  "missing-result",
  "deadline-exceeded",
  "parent-lost",
]);
const SNAPSHOT_RETRY_LIMIT = 16;

interface RecoveryLineageSnapshot {
  readonly digest: string;
  readonly rows: readonly AttestationEnvelope[];
}

export interface CurrentRecoveryCaptureCoordinates {
  readonly taskId: string;
  readonly binding: ManagedWorktreeDispatchBinding;
  readonly liveTip: string;
  readonly taskDigest: string;
  readonly finalizedManifestDigest: string;
}

export interface CurrentRecoveryCaptureDeps {
  readonly journal: CurrentRecoverySealJournalStore;
  readonly snapshot: () => Promise<readonly AttestationRow[]>;
  readonly resolveReceipts: (
    row: AttestationEnvelope,
    liveTip: string,
  ) => Promise<readonly GitChangeBrokerReceipt[]>;
  readonly revalidateBinding: () => Promise<void>;
  readonly observeLiveTip: () => Promise<string>;
  readonly now: () => string;
  /** Deterministic race seam used after provisional durability and before the lineage reread. */
  readonly afterProvisional?: () => Promise<void>;
  /** Deterministic race seam used after reselection and before the final locked reread. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface CaptureCurrentDispatchRecoveryOptions {
  readonly backend: AttestationBackend;
  readonly ledgerStore: LedgerStore;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly stateDir?: string;
  readonly journal?: CurrentRecoverySealJournalStore;
  readonly now?: () => string;
  readonly afterProvisional?: () => Promise<void>;
  readonly beforeCommit?: () => Promise<void>;
}

function bindingMatches(
  candidate: DispatchGitEffectBinding | undefined,
  binding: ManagedWorktreeDispatchBinding,
): boolean {
  if (candidate === undefined || candidate.conflictStateDigest !== undefined) return false;
  return (
    candidate.taskId === binding.taskId &&
    candidate.handleToken === binding.handleToken &&
    candidate.handleFingerprint === binding.handleFingerprint &&
    resolve(candidate.repositoryRoot) === binding.repositoryRoot &&
    candidate.repositoryId === binding.repositoryId &&
    resolve(candidate.commonDir) === binding.commonDir &&
    resolve(candidate.worktreePath) === binding.worktreePath &&
    candidate.branch === binding.branch &&
    candidate.ref === binding.ref &&
    candidate.baseCommit === binding.baseCommit
  );
}

function lineageSnapshot(
  rows: readonly AttestationRow[],
  binding: ManagedWorktreeDispatchBinding,
): RecoveryLineageSnapshot {
  const envelopes = rows
    .filter((row): row is AttestationEnvelope => !isAttestationTombstone(row))
    .filter((row) => bindingMatches(row.gitEffectBinding, binding))
    .sort((left, right) => {
      const byId =
        left.attestationId < right.attestationId
          ? -1
          : left.attestationId > right.attestationId
            ? 1
            : 0;
      return byId || left.generation - right.generation;
    });
  return {
    rows: Object.freeze(envelopes.map((row) => structuredClone(row))),
    digest: dispatchPayloadDigest(envelopes as unknown as DispatchJSONValue),
  };
}

function assertNoActiveGeneration(snapshot: RecoveryLineageSnapshot): void {
  const active = snapshot.rows.find((row) => !TERMINAL_STATES.has(row.state));
  if (active !== undefined) {
    throw new CurrentRecoverySealError(
      "lineage-active",
      `dispatch lineage ${active.attestationId} generation ${String(active.generation)} is ${active.state}`,
    );
  }
}

function lineageMaximumGeneration(snapshot: RecoveryLineageSnapshot): number {
  return Math.max(...snapshot.rows.map((row) => row.generation));
}

async function sourceCandidates(
  snapshot: RecoveryLineageSnapshot,
  coordinates: CurrentRecoveryCaptureCoordinates,
  deps: CurrentRecoveryCaptureDeps,
): Promise<readonly CurrentRecoverySourceCandidate[]> {
  const candidates: CurrentRecoverySourceCandidate[] = [];
  for (const row of snapshot.rows) {
    if (
      row.state !== "aborted" ||
      row.promptProvenance.roleId !== "implement-worker" ||
      row.abortReason === undefined ||
      !ELIGIBLE_ABORT_REASONS.has(row.abortReason) ||
      row.terminalDigest === undefined
    ) {
      continue;
    }
    let gitReceipts: readonly GitChangeBrokerReceipt[];
    try {
      gitReceipts = await deps.resolveReceipts(row, coordinates.liveTip);
    } catch {
      continue;
    }
    if (gitReceipts.length === 0) continue;
    candidates.push({
      selectedSourceHandle: {
        attestationId: row.attestationId,
        generation: row.generation,
      },
      lineageMaximumGeneration: lineageMaximumGeneration(snapshot),
      sourceAbortReason: row.abortReason as CurrentRecoverySourceAbortReason,
      sourceTerminalDigest: row.terminalDigest,
      gitReceipts,
      gitReceiptsDigest: currentRecoveryReceiptClosureDigest(gitReceipts),
    });
  }
  return candidates;
}

function sourceRow(
  snapshot: RecoveryLineageSnapshot,
  source: CurrentRecoverySourceCandidate,
): AttestationEnvelope {
  const row = snapshot.rows.find(
    (candidate) =>
      candidate.attestationId === source.selectedSourceHandle.attestationId &&
      candidate.generation === source.selectedSourceHandle.generation,
  );
  if (row === undefined) {
    throw new CurrentRecoverySealError("source-not-found", "selected recovery source disappeared");
  }
  return row;
}

function sourcesEqual(
  left: CurrentRecoverySourceCandidate,
  right: CurrentRecoverySourceCandidate,
): boolean {
  return (
    left.selectedSourceHandle.attestationId === right.selectedSourceHandle.attestationId &&
    left.selectedSourceHandle.generation === right.selectedSourceHandle.generation &&
    left.lineageMaximumGeneration === right.lineageMaximumGeneration &&
    left.sourceAbortReason === right.sourceAbortReason &&
    left.sourceTerminalDigest === right.sourceTerminalDigest &&
    left.gitReceiptsDigest === right.gitReceiptsDigest
  );
}

function sealForSource(
  coordinates: CurrentRecoveryCaptureCoordinates,
  row: AttestationEnvelope,
  source: CurrentRecoverySourceCandidate,
  snapshotDigest: string,
  capturedAt: string,
): CurrentRecoverySeal {
  return createCurrentRecoverySeal(
    createCurrentRecoverySeed({
      selectedSourceHandle: source.selectedSourceHandle,
      lineageMaximumGeneration: source.lineageMaximumGeneration,
      snapshotDigest,
      sourceAbortReason: source.sourceAbortReason,
      sourceTerminalDigest: source.sourceTerminalDigest,
      namespace: row.namespace,
      promptProvenance: row.promptProvenance,
      prepareRequestDigest: row.prepareRequestDigest,
      taskId: coordinates.taskId,
      taskDigest: coordinates.taskDigest,
      finalizedManifestDigest: coordinates.finalizedManifestDigest,
      inputRecipe: row.input,
      overlays: row.overlays,
      gitBinding: coordinates.binding,
      gitReceipts: source.gitReceipts,
      liveTip: coordinates.liveTip,
      capturedAt,
    }),
  );
}

/**
 * Capture business logic. It deliberately knows only the journal and snapshot ports so the
 * retry/selection contract runs unchanged against the in-memory dummy and filesystem adapter.
 */
export async function captureCurrentRecoverySeal(
  coordinates: CurrentRecoveryCaptureCoordinates,
  deps: CurrentRecoveryCaptureDeps,
): Promise<CurrentRecoverySeal> {
  let provisionalHookRan = false;
  let beforeCommitHookRan = false;
  for (let attempt = 0; attempt < SNAPSHOT_RETRY_LIMIT; attempt += 1) {
    const snapshot = lineageSnapshot(await deps.snapshot(), coordinates.binding);
    assertNoActiveGeneration(snapshot);
    const source = selectStrictMaximalRecoverySource(
      coordinates.taskId,
      coordinates.liveTip,
      await sourceCandidates(snapshot, coordinates, deps),
    );
    const row = sourceRow(snapshot, source);
    const existing = await deps.journal.read(coordinates.taskId);
    if (
      existing?.state === "committed" &&
      existing.fence !== undefined &&
      existing.snapshotDigest === snapshot.digest
    ) {
      const replay = sealForSource(
        coordinates,
        row,
        source,
        snapshot.digest,
        existing.seal.seed.capturedAt,
      );
      if (replay.sealDigest === existing.seal.sealDigest) return existing.seal;
    }
    const capturedAt = deps.now();
    const seal = sealForSource(coordinates, row, source, snapshot.digest, capturedAt);
    const provisional = {
      kind: "cq-current-recovery-seal-journal" as const,
      version: 1 as const,
      state: "provisional" as const,
      taskId: coordinates.taskId,
      snapshotDigest: snapshot.digest,
      seal,
      writtenAt: capturedAt,
    };
    await deps.journal.put(provisional);
    if (!provisionalHookRan && deps.afterProvisional !== undefined) {
      provisionalHookRan = true;
      await deps.afterProvisional();
    }
    await deps.revalidateBinding();
    if ((await deps.observeLiveTip()) !== coordinates.liveTip) {
      throw new CurrentRecoverySealError(
        "snapshot-changed",
        "managed worktree tip changed during recovery capture",
      );
    }
    const reread = lineageSnapshot(await deps.snapshot(), coordinates.binding);
    if (reread.digest !== snapshot.digest) continue;
    assertNoActiveGeneration(reread);
    const selectedAgain = selectStrictMaximalRecoverySource(
      coordinates.taskId,
      coordinates.liveTip,
      await sourceCandidates(reread, coordinates, deps),
    );
    if (!sourcesEqual(selectedAgain, source)) continue;
    if (!beforeCommitHookRan && deps.beforeCommit !== undefined) {
      beforeCommitHookRan = true;
      await deps.beforeCommit();
    }
    await deps.revalidateBinding();
    if ((await deps.observeLiveTip()) !== coordinates.liveTip) {
      throw new CurrentRecoverySealError(
        "snapshot-changed",
        "managed worktree tip changed during recovery capture",
      );
    }
    const finalSnapshot = lineageSnapshot(await deps.snapshot(), coordinates.binding);
    if (finalSnapshot.digest !== snapshot.digest) continue;
    assertNoActiveGeneration(finalSnapshot);
    const selectedFinal = selectStrictMaximalRecoverySource(
      coordinates.taskId,
      coordinates.liveTip,
      await sourceCandidates(finalSnapshot, coordinates, deps),
    );
    if (!sourcesEqual(selectedFinal, source)) continue;
    const committedAt = deps.now();
    const fence = createDispatchLineageCutoverFence({
      namespace: row.namespace,
      taskId: coordinates.taskId,
      managedFingerprint: coordinates.binding.handleFingerprint,
      sourceAttestationId: source.selectedSourceHandle.attestationId,
      selectedSourceGeneration: source.selectedSourceHandle.generation,
      lineageMaximumGeneration: source.lineageMaximumGeneration,
      recoverySeedRef: seal.sealReference,
      fenceCapability: {
        scope: "dispatch-lineage-fence",
        token: coordinates.binding.handleToken,
      },
      installedAt: committedAt,
    });
    await deps.journal.put({
      ...provisional,
      state: "committed",
      committedAt,
      fence,
    });
    return seal;
  }
  throw new CurrentRecoverySealError(
    "snapshot-changed",
    "dispatch lineage did not stabilize during recovery capture",
  );
}

async function repositoryRoot(cwd: string): Promise<string> {
  const result = await nodeManagedWorktreeGitRunner(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0 || result.stdout.trim() === "") {
    throw new CurrentRecoverySealError("invalid", "recovery capture requires a Git repository");
  }
  return await realpath(resolve(result.stdout.trim()));
}

async function resolveManagedBinding(
  repository: string,
  taskId: string,
  stateDir?: string,
): Promise<ManagedWorktreeDispatchBinding> {
  const handles = await listManagedLiveWorktrees(repository, taskId, stateDir);
  if (handles.length !== 1) {
    throw new CurrentRecoverySealError(
      "invalid",
      `task ${taskId} must own exactly one live managed worktree`,
    );
  }
  const handle = handles[0]!;
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot: repository,
      taskId,
      worktreePath: handle.absolutePath,
      branch: handle.branch,
    },
    stateDir === undefined ? {} : { stateDir },
  );
  if (binding === null || binding.handleToken !== handle.token) {
    throw new CurrentRecoverySealError(
      "invalid",
      "managed worktree binding is no longer authoritative",
    );
  }
  return binding;
}

export function currentRecoveryTaskEvidence(
  store: LedgerStore,
  taskId: string,
): {
  readonly taskDigest: string;
  readonly finalizedManifestDigest: string;
} {
  const task = store.fetchItem(TASKS_LEDGER, taskId);
  const goalRefs = (
    Array.isArray(task.fields["ledgerRefs"]) ? task.fields["ledgerRefs"] : []
  ).filter(
    (entry): entry is string => typeof entry === "string" && entry.startsWith(`${GOALS_LEDGER}:`),
  );
  if (goalRefs.length !== 1) {
    throw new CurrentRecoverySealError(
      "invalid",
      `task ${taskId} must link exactly one finalized goal`,
    );
  }
  const goal = store.fetchItem(GOALS_LEDGER, goalRefs[0]!.slice(`${GOALS_LEDGER}:`.length));
  const manifest = goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
  if (typeof manifest !== "string") {
    throw new CurrentRecoverySealError("invalid", `task ${taskId} has no finalized manifest`);
  }
  let decodedManifest: ReturnType<typeof PlanPublishedManifestSchema.parse>;
  try {
    decodedManifest = PlanPublishedManifestSchema.parse(JSON.parse(manifest) as unknown);
  } catch {
    throw new CurrentRecoverySealError("invalid", `task ${taskId} finalized manifest is malformed`);
  }
  if (!decodedManifest.tasks.some(({ id }) => id === taskId)) {
    throw new CurrentRecoverySealError(
      "invalid",
      `task ${taskId} does not belong to the finalized manifest`,
    );
  }
  return {
    taskDigest: dispatchPayloadDigest(task as unknown as DispatchJSONValue),
    finalizedManifestDigest: dispatchPayloadDigest(decodedManifest),
  };
}

export async function captureCurrentDispatchRecoverySeal(
  options: CaptureCurrentDispatchRecoveryOptions,
): Promise<CurrentRecoverySeal> {
  if (!TASK_ID.test(options.taskId)) {
    throw new CurrentRecoverySealError("invalid", "taskId must be one canonical task id");
  }
  const repository = await repositoryRoot(options.repositoryRoot);
  const binding = await resolveManagedBinding(repository, options.taskId, options.stateDir);
  const journal =
    options.journal ??
    new FsCurrentRecoverySealJournalStore(currentRecoveryJournalRoot(repository, options.stateDir));
  return await withManagedWorktreeEffectLock(
    binding,
    options.stateDir === undefined ? {} : { stateDir: options.stateDir },
    async () => {
      await assertManagedWorktreeDispatchBindingLive(
        binding,
        options.stateDir === undefined ? {} : { stateDir: options.stateDir },
      );
      const liveTip = await observeManagedWorktreeLiveTip(
        binding,
        options.stateDir === undefined ? {} : { stateDir: options.stateDir },
      );
      const evidence = currentRecoveryTaskEvidence(options.ledgerStore, options.taskId);
      return await options.backend.transact(
        { kind: "namespace" },
        async (store) =>
          await captureCurrentRecoverySeal(
            { taskId: options.taskId, binding, liveTip, ...evidence },
            {
              journal,
              now: options.now ?? (() => new Date().toISOString()),
              snapshot: async () => store.rows().map((row) => structuredClone(row)),
              resolveReceipts: async (row, tip) =>
                await resolveInheritedGitChangeReceipts(
                  {
                    ...binding,
                    attestationId: row.attestationId,
                    generation: row.generation,
                    ...(row.gitEffectBinding?.inheritedGitReceipts === undefined
                      ? {}
                      : {
                          inheritedGitReceipts: row.gitEffectBinding
                            .inheritedGitReceipts as readonly GitChangeBrokerReceipt[],
                        }),
                  },
                  tip,
                  options.stateDir === undefined ? {} : { stateDir: options.stateDir },
                ),
              revalidateBinding: async () =>
                await assertManagedWorktreeDispatchBindingLive(
                  binding,
                  options.stateDir === undefined ? {} : { stateDir: options.stateDir },
                ),
              observeLiveTip: async () =>
                await observeManagedWorktreeLiveTip(
                  binding,
                  options.stateDir === undefined ? {} : { stateDir: options.stateDir },
                ),
              ...(options.afterProvisional === undefined
                ? {}
                : { afterProvisional: options.afterProvisional }),
              ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
            },
          ),
      );
    },
  );
}

export async function readCurrentDispatchRecoveryStatus(options: {
  readonly backend: AttestationBackend;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly stateDir?: string;
  readonly journal?: CurrentRecoverySealJournalStore;
}): Promise<CurrentRecoveryStatus> {
  const repository = await repositoryRoot(options.repositoryRoot);
  const binding = await resolveManagedBinding(repository, options.taskId, options.stateDir);
  const journal =
    options.journal ??
    new FsCurrentRecoverySealJournalStore(currentRecoveryJournalRoot(repository, options.stateDir));
  return await withManagedWorktreeEffectLock(
    binding,
    options.stateDir === undefined ? {} : { stateDir: options.stateDir },
    async () => {
      await assertManagedWorktreeDispatchBindingLive(
        binding,
        options.stateDir === undefined ? {} : { stateDir: options.stateDir },
      );
      const liveTip = await observeManagedWorktreeLiveTip(
        binding,
        options.stateDir === undefined ? {} : { stateDir: options.stateDir },
      );
      return await options.backend.transact(
        { kind: "namespace" },
        async (store) =>
          await readCurrentDispatchRecoveryStatusForLineage({
            journal,
            taskId: options.taskId,
            binding,
            liveTip,
            rows: store.rows(),
          }),
      );
    },
  );
}

export async function readCurrentDispatchRecoveryStatusForLineage(options: {
  readonly journal: CurrentRecoverySealJournalStore;
  readonly taskId: string;
  readonly binding: ManagedWorktreeDispatchBinding;
  readonly liveTip: string;
  readonly rows: readonly AttestationRow[];
}): Promise<CurrentRecoveryStatus> {
  const journal = await options.journal.read(options.taskId);
  if (journal?.state === "committed") {
    const seed = journal.seal.seed;
    const binding = options.binding;
    if (
      seed.taskId !== options.taskId ||
      seed.managedFingerprint !== binding.handleFingerprint ||
      seed.gitBinding.taskId !== binding.taskId ||
      resolve(seed.gitBinding.repositoryRoot) !== binding.repositoryRoot ||
      seed.gitBinding.repositoryId !== binding.repositoryId ||
      resolve(seed.gitBinding.commonDir) !== binding.commonDir ||
      resolve(seed.gitBinding.worktreePath) !== binding.worktreePath ||
      seed.gitBinding.branch !== binding.branch ||
      seed.gitBinding.ref !== binding.ref ||
      seed.gitBinding.baseCommit !== binding.baseCommit ||
      seed.liveTip !== options.liveTip
    ) {
      throw new CurrentRecoverySealError(
        "snapshot-changed",
        "committed recovery authority no longer matches the live managed binding",
      );
    }
    const snapshot = lineageSnapshot(options.rows, binding);
    assertNoActiveGeneration(snapshot);
    if (
      snapshot.digest !== journal.snapshotDigest ||
      seed.snapshotDigest !== journal.snapshotDigest
    ) {
      throw new CurrentRecoverySealError(
        "snapshot-changed",
        "committed recovery authority no longer matches the dispatch lineage",
      );
    }
  }
  return currentRecoveryStatusFromJournal(journal, options.taskId);
}

export interface SingleProjectRecoverySealOptions {
  readonly construction: SingleProjectConstruction;
  readonly resolved: ResolvedLedgerStore;
  readonly taskId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stateDir?: string;
}

/** Open the production attestation namespace only for the duration of one protected capture. */
export async function captureCurrentDispatchRecoveryForProject(
  options: SingleProjectRecoverySealOptions,
): Promise<CurrentRecoverySeal> {
  const backendKind = assertAttestationConstructionSupported(
    options.construction,
    options.resolved.backend,
  );
  const projectId = loadConfig(options.resolved.configRoot)?.ledger?.projectId ?? null;
  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: options.construction,
    backend: backendKind,
    repoRoot: options.resolved.configRoot,
    projectId,
  });
  const backend = await (async () => {
    switch (backendKind) {
      case "xdg":
        return await createAttestationStoreForConstruction({
          backend: backendKind,
          namespace,
          ...(options.environment === undefined ? {} : { env: options.environment }),
        });
      case "fs":
        return await createAttestationStoreForConstruction({
          backend: backendKind,
          namespace,
          ledgerRoot: options.resolved.configRoot,
        });
      default:
        throw new CurrentRecoverySealError(
          "invalid",
          `single-project recovery capture does not support ${String(backendKind)}`,
        );
    }
  })();
  try {
    return await captureCurrentDispatchRecoverySeal({
      backend,
      ledgerStore: options.resolved.store,
      repositoryRoot: options.resolved.configRoot,
      taskId: options.taskId,
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    });
  } finally {
    await backend.close();
  }
}

/** Open the production namespace and verify committed authority against its current lineage. */
export async function readCurrentDispatchRecoveryStatusForProject(
  options: SingleProjectRecoverySealOptions,
): Promise<CurrentRecoveryStatus> {
  const backendKind = assertAttestationConstructionSupported(
    options.construction,
    options.resolved.backend,
  );
  const projectId = loadConfig(options.resolved.configRoot)?.ledger?.projectId ?? null;
  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: options.construction,
    backend: backendKind,
    repoRoot: options.resolved.configRoot,
    projectId,
  });
  const backend = await (async () => {
    switch (backendKind) {
      case "xdg":
        return await createAttestationStoreForConstruction({
          backend: backendKind,
          namespace,
          ...(options.environment === undefined ? {} : { env: options.environment }),
        });
      case "fs":
        return await createAttestationStoreForConstruction({
          backend: backendKind,
          namespace,
          ledgerRoot: options.resolved.configRoot,
        });
      default:
        throw new CurrentRecoverySealError(
          "invalid",
          `single-project recovery status does not support ${String(backendKind)}`,
        );
    }
  })();
  try {
    return await readCurrentDispatchRecoveryStatus({
      backend,
      repositoryRoot: options.resolved.configRoot,
      taskId: options.taskId,
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    });
  } finally {
    await backend.close();
  }
}
