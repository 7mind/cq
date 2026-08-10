/**
 * @cq/ledger — markdown-backed ledger library + in-process SDK-MCP tools.
 */

export * from "./types.js";
export * from "./usageStats.js";
export * from "./planLifecycle.js";
export * from "./operatorActions.js";
export type {
  TaskAdoptionEligibilityFence,
  TaskAdoptionEligibilityResult,
  TaskAdoptionIneligibility,
  TaskAdoptionPublicationResult,
} from "./taskAdoptionEligibility.js";
export {
  MILESTONES_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_SCHEMA,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  HYPOTHESIS_LEDGER,
  QUESTIONS_LEDGER,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  REVIEWS_LEDGER,
  PLAN_REVIEW_DRAFT_FIELD,
  HANDOFFS_LEDGER,
  OPERATOR_ACTIONS_LEDGER,
  IDEAS_LEDGER,
  RESEARCHES_LEDGER,
  UPSTREAM_LEDGER,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  REVIEWS_SCHEMA,
  HANDOFFS_SCHEMA,
  OPERATOR_ACTIONS_SCHEMA,
  IDEAS_SCHEMA,
  RESEARCHES_SCHEMA,
  UPSTREAM_SCHEMA,
  CANONICAL_LEDGERS,
  LEDGER_STORAGE_DIRNAME,
  LEDGER_LOGS_DIRNAME,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
  ISO_TIMESTAMP_RE,
  isIsoTimestamp,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNED_FIELD_NAMES,
  WORKSET_OWNERSHIP_SCHEMA_FIELDS,
} from "./constants.js";
export type { WorksetOwnedFieldName } from "./constants.js";
export * from "./worksetPlanLifecycle.js";
export {
  PLANNING_LIFECYCLE_CREATION_KINDS,
  IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
  WORKSET_OWNER_EDGE_KINDS,
  LIFECYCLE_CREATION_KIND_SET,
  OWNER_EDGE_EXCLUSIONS,
  ALLOWED_OWNER_EDGE_ROWS,
  DENIED_OWNER_EDGE_ROWS,
  resolveOwnerEdgePolicy,
  ownerEdgeCoverageCells,
  deriveCanonicalOwnership,
  ownershipFieldsFrom,
  readCanonicalOwnership,
  ownershipFromLedgerRefs,
  inferLegacyOwnership,
  isAmbiguousLegacyOwnership,
  assertWorksetOwnershipFieldsAbsent,
  WorksetOwnershipFieldError,
  fixturesForAllowedRow,
  fixtureIncludedInOwnerClosure,
  PREREQUISITE_EDGE,
} from "./worksetOwnerEdges.js";
export type {
  PlanningLifecycleCreationKind,
  ImplementationLifecycleCreationKind,
  LifecycleCreationKind,
  WorksetOwnerEdgeKind,
  OwnerEdgeExclusion,
  OwnerEdgeDirection,
  AllowedOwnerEdgeRow,
  DeniedOwnerEdgeRow,
  OwnerEdgePolicyRow,
  OwnerEdgeResolution,
  OwnerEdgeCoverageCell,
  CanonicalOwnership,
  OwnerEdgeRelation,
  OwnerEdgeFixture,
} from "./worksetOwnerEdges.js";
export {
  defaultWorksetPrefixRegistry,
  buildWorksetActiveState,
  canonicalizeWorksetRoots,
  parseGoalCurrentDraftManifest,
  parseGoalFinalizedManifest,
  closeWorkset,
  projectWorkset,
  isRestrictiveInactiveWorkset,
  WorksetRootError,
} from "./worksetGraph.js";
export type {
  WorksetProjection,
  WorksetEdgeKind,
  WorksetEdge,
  WorksetNode,
  WorksetGraph,
  WorksetActiveState,
  CloseWorksetOptions,
  WorksetProjectedNode,
  WorksetProjectedGraph,
} from "./worksetGraph.js";
export {
  WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
  WORKSET_LEDGER_WRITE_MUTATION_KINDS,
  WORKSET_LEDGER_MUTATION_KINDS,
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
  WORKSET_EFFECT_KINDS,
  WORKSET_ADMISSION_FORMS,
  WORKSET_FORBIDDEN_ADMISSION_PATTERNS,
  WORKSET_EFFECT_TERMINATION_REASONS,
  admissionFormForEffectKind,
  WorksetAdmissionError,
  canonicalizeWorksetRootReplacement,
  createInMemoryWorksetAdmissionCoordinator,
  isLiveWorksetAdmission,
  registerLiveWorksetAdmission,
  unregisterLiveWorksetAdmission,
  assertCallerCannotMintAdmission,
} from "./worksetEffectAdmission.js";
export type {
  WorksetPlanLifecycleMutationKind,
  WorksetLedgerWriteMutationKind,
  WorksetLedgerMutationKind,
  WorksetExternalEffectKind,
  WorksetAdministrativeEffectKind,
  WorksetEffectKind,
  WorksetAdmissionForm,
  WorksetForbiddenAdmissionPattern,
  WorksetEffectTerminationReason,
  WorksetAdmissionErrorCode,
  WorksetRootsEpoch,
  WorksetProcessGroupRegistration,
  WorksetLedgerMutationAdmission,
  WorksetExternalEffectAdmission,
  WorksetAdmissionCoordinatorHooks,
  CreateInMemoryWorksetAdmissionCoordinatorOptions,
  WorksetAdmissionCoordinator,
  WorksetPublishedAdmissionLease,
} from "./worksetEffectAdmission.js";
export {
  WorksetInvocationAuthorityError,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  isTrustedWorksetManagementAuthority,
  bindWorksetInvocationAuthority,
  invokeWorksetGet,
  invokeWorksetFetch,
  invokeWorksetSet,
} from "./worksetInvocationAuthority.js";
export type {
  WorksetInvocationAuthority,
  WorksetInvocationAuthorityErrorCode,
  WorksetManagementAuthority,
} from "./worksetInvocationAuthority.js";
export {
  createInMemoryWorksetStore,
  readWorksetRootsEpoch,
  worksetStoreFromCoordinator,
  worksetEffectAdmissionProviderFromStore,
} from "./worksetStore.js";
export type {
  WorksetStore,
  WorksetEffectAdmissionProvider,
  CreateInMemoryWorksetStoreOptions,
} from "./worksetStore.js";
export {
  createGitObjectWorksetStore,
  parseWorksetRootsDocument,
  serializeWorksetRootsDocument,
} from "./worksetStoreGit.js";
export type {
  CreateGitObjectWorksetStoreOptions,
  WorksetRootsDocument,
} from "./worksetStoreGit.js";
export {
  WORKSET_GENERIC_MUTATION_OPERATION_KINDS,
  WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES,
  WORKSET_GENERIC_MUTATION_FIELD_CLAUSES,
  WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS,
  WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS,
  clauseForGenericMutationOperation,
  clauseForGenericMutationField,
  WorksetGenericMutationError,
  assertNoPublicRawWriteEscape,
  buildActiveStateFromLedgerStore,
  worksetMemberRefSet,
  introducedClosureRefs,
  createWorksetGenericMutationGateway,
  createWorksetGuardedLedger,
  createWorksetManagementLedger,
  createInMemoryWorksetGuardedLedger,
  createInMemoryWorksetManagementLedger,
  createFsWorksetGuardedLedger,
  createGitObjectWorksetGuardedLedger,
  createSqliteWorksetGuardedLedger,
  assertGenericMutationAdmissionNotCallerMinted,
  inventoriedLedgerStoreMutationMethods,
  inventoriedSealedOwnershipFields,
  canonicalLedgerCount,
} from "./worksetGenericMutation.js";
export type {
  WorksetGenericMutationOperationKind,
  WorksetGenericMutationRestrictivePolicy,
  WorksetGenericMutationOperationClause,
  WorksetGenericMutationFieldKind,
  WorksetGenericMutationFieldRestrictivePolicy,
  WorksetGenericMutationFieldClause,
  WorksetGenericMutationErrorCode,
  WorksetLedgerReadSurface,
  WorksetGenericMutationGateway,
  WorksetGuardedLedger,
  WorksetGenericMutationGatewayHost,
  CreateInMemoryWorksetGuardedLedgerOptions,
  CreateFsWorksetGuardedLedgerOptions,
  CreateGitObjectWorksetGuardedLedgerOptions,
  CreateSqliteWorksetGuardedLedgerOptions,
} from "./worksetGenericMutation.js";
export {
  WorksetOwnedLifecycleError,
  createWorksetOwnedWriteGateway,
  createWorksetCoordinationBundleGateway,
  createWorksetOwnedGuardedLedger,
  createInMemoryWorksetOwnedGuardedLedger,
  assertOwnedWriteAdmissionNotCallerMinted,
  WORKSET_OWNED_WRITE_CREATION_KINDS,
  defaultChildLedgerForCreationKind,
} from "./worksetOwnedLifecycle.js";
export type {
  WorksetOwnedLifecycleErrorCode,
  OwnedOwnerRef,
  OwnedChildInit,
  OwnedCreateInput,
  OwnedCreateResult,
  OwnerlessCreateInput,
  IdeaToGoalBundleInput,
  IdeaToGoalBundleResult,
  DefectToFixGoalBundleInput,
  DefectToFixGoalBundleResult,
  OwnedDraftTaskInit,
  OwnedDraftBundleInput,
  OwnedDraftBundleResult,
  WorksetOwnedWriteGateway,
  WorksetCoordinationBundleGateway,
  WorksetOwnedGuardedLedger,
  WorksetOwnedWriteHost,
  WorksetOwnedWriteTx,
  CreateInMemoryWorksetOwnedGuardedLedgerOptions,
  WorksetOwnedWriteCreationKind,
} from "./worksetOwnedLifecycle.js";
export * from "./parser/parse.js";
export * from "./parser/serialize.js";
export { parseFrontmatter, serializeFrontmatter } from "./parser/frontmatter.js";
export type { ParsedFrontmatter } from "./parser/frontmatter.js";
export type {
  LedgerStore,
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./store/LedgerStore.js";
export type { LedgerPersistence } from "./store/LedgerPersistence.js";
export {
  AbstractLedgerStore,
  schemasEqual,
  schemaCompatible,
} from "./store/AbstractLedgerStore.js";
export { FsPersistence } from "./store/FsPersistence.js";
export type { FsPersistenceLayout } from "./store/FsPersistence.js";
export { FsLedgerStore } from "./store/FsLedgerStore.js";
export type { FsLedgerStoreOpts, ResetSummary } from "./store/FsLedgerStore.js";
export { createFsWorksetStore } from "./store/fsWorksetStore.js";
export type { CreateFsWorksetStoreOptions } from "./store/fsWorksetStore.js";
export {
  buildBackupDump,
  exportBackupInTree,
  exportBackupOrphanBranch,
  runBackupExport,
  BackupScheduler,
  DEFAULT_BACKUP_DEBOUNCE_MS,
} from "./store/backupExporter.js";
export type { BackupDumpFile, BackupExportOpts, BackupTarget } from "./store/backupExporter.js";
export {
  readDumpInTree,
  readDumpOrphanBranch,
  restoreDumpToXdg,
  RestoreTargetChangedError,
  isXdgPrimaryEmpty,
  parseBackupDump,
} from "./store/restoreImporter.js";
export type { RestoreSummary, ParsedDump } from "./store/restoreImporter.js";
export { atomicWrite } from "./store/fsAtomic.js";
export {
  GitPlumbing,
  StaleRefError,
  GitCommandError,
  nodeGitRunner,
} from "./store/git/GitPlumbing.js";
export type { TreeEntry, GitResult, GitRunOpts, GitRunner } from "./store/git/GitPlumbing.js";
export {
  DispatchBaseGitCommandError,
  nodeDispatchBaseGitRunner,
  observeDispatchBase,
  verifyDispatchBase,
} from "./dispatchBase.js";
export type {
  DispatchBaseAncestryObservation,
  DispatchBaseGitResult,
  DispatchBaseGitRunner,
  DispatchBaseObservations,
  DispatchBaseUnresolvableReason,
  DispatchBaseVerification,
  DispatchCommitObservation,
  ObserveDispatchBaseRequest,
  RebaseRequiredDispatchBase,
  UnresolvableDispatchBase,
  VerifiedDispatchBase,
} from "./dispatchBase.js";
export { decideWorktreeSweep, patchEquivalentFromGitCherry } from "./worktreeSweep.js";
export type {
  WorktreeAssociatedTaskStatus,
  WorktreeSweepDecision,
  WorktreeSweepFacts,
} from "./worktreeSweep.js";
export {
  resolveDependencyResultCommits,
  resolveDependencyResultCommitsForDispatch,
} from "./dependencyResultCommits.js";
export type {
  DependencyResultCommit,
  DependencyResultCommitResolution,
  DependencyTaskSnapshot,
  DependencyTaskSnapshotReader,
  ReadyDependencyResultCommits,
  ResolveDependencyResultCommitsForDispatchRequest,
  ResolveDependencyResultCommitsRequest,
  UnresolvableDependencyResultCommits,
} from "./dependencyResultCommits.js";
export {
  buildManagedWorktreeInstallPlan,
  discoverBunWorkspaceRoot,
  findOpenWipCheckpoints,
  generateUuidV7,
  isUuidV7,
  listManagedLiveWorktrees,
  managedWorktreeHandleSegment,
  nodeManagedWorktreeGitRunner,
  normalizeManagedPath,
  prepareManagedWorktree,
  rebaseBunWorkspaceIntoWorktree,
  releaseManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  resolveBunInstallCacheDir,
  resolveCqCacheRoot,
  resolveNodeGypBinDir,
  validateManagedWorktreeHandle,
  validateManagedWorktreeInstallPlan,
  assertManagedWorktreeDispatchBindingLive,
  assertManagedWorktreeConflictDispatchBindingLive,
  withManagedWorktreeEffectLock,
} from "./managedWorktree.js";
export type {
  ManagedWorktreeDispatchBinding,
  ManagedWorktreeDeps,
  ManagedWorktreeFaultBoundary,
  ManagedWorktreeFaultInjector,
  ManagedWorktreeGitResult,
  ManagedWorktreeGitRunner,
  ManagedWorktreeHandle,
  ManagedWorktreeIdFactory,
  ManagedWorktreeInstallPlan,
  ManagedWorktreeInstallPlanValidation,
  ManagedWorktreeInstallRunner,
  ManagedWorktreeTaskAdoptionAuthority,
  ManagedWorktreeTerminalDisposition,
  PrepareManagedWorktreeRefusalReason,
  PrepareManagedWorktreeRequest,
  PrepareManagedWorktreeResult,
  PreparedWorktreeEvidence,
  ReleaseManagedWorktreeRefusalReason,
  ReleaseManagedWorktreeRequest,
  ReleaseManagedWorktreeResult,
  ResolveManagedWorktreeDispatchBindingRequest,
  WipOpenCheckpointFinding,
} from "./managedWorktree.js";
export {
  commitManagedWorktreeChanges,
  resolveInheritedGitChangeReceipts,
  validateGitChangeBrokerResultEvidence,
} from "./gitChangeBroker.js";
export type { GitChangeReceiptLineageBinding } from "./gitChangeBroker.js";
export {
  SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  nodeSupervisedWorkerGateRunner,
  superviseImplementWorkerGate,
} from "./supervisedWorkerGate.js";
export type {
  SupervisedWorkerGateRunRequest,
  SupervisedWorkerGateRunResult,
  SupervisedWorkerGateRunner,
  SuperviseImplementWorkerGateRequest,
  SuperviseImplementWorkerGateDeps,
} from "./supervisedWorkerGate.js";
export type {
  DispatchBoundGitAuthorization,
  GitChangeBrokerDeps,
  GitChangeBrokerEvidenceDeps,
  GitChangeBrokerReceipt,
  GitChangeBrokerResultEvidence,
  GitChangeBrokerRequest,
  GitChangeManifestEntry,
  GitPathState,
  GitRegularMode,
} from "./gitChangeBroker.js";
export {
  assessLegacyReconciliationActivity,
  assessLegacyReconciliationHistory,
  beginLegacyWorktreeReconciliation,
  classifyLegacyHistory,
  createGitLegacyWorktreeActivityFence,
  createGitLegacyReconciliationObservationAdapter,
  nodeLegacyReconciliationGitRunner,
  recoverLegacyWorktreeReconciliation,
} from "./legacyWorktreeReconciliation.js";
export type {
  BeginLegacyWorktreeReconciliationRequest,
  BeginLegacyWorktreeReconciliationRefusalReason,
  BeginLegacyWorktreeReconciliationResult,
  LegacyOverlayJournalEntry,
  LegacyReconciliationActivityAssessment,
  LegacyReconciliationClassification,
  LegacyReconciliationFaultBoundary,
  LegacyReconciliationFaultInjector,
  LegacyReconciliationGitResult,
  LegacyReconciliationGitRunner,
  LegacyReconciliationHistoryAssessment,
  LegacyReconciliationHistoryObservation,
  LegacyReconciliationObservationAdapter,
  LegacyWorktreeActivityFence,
  LegacyWorktreeActivityObservation,
  LegacyWorktreeManagedOwnerObservation,
  LegacyWorktreeManagedOwnerObserver,
  LegacyWorktreeManagerLock,
  LegacyWorktreeReconciliationDeps,
  LegacyWorktreeReconciliationEvidence,
  LegacyWorktreeReconciliationTransaction,
  RecoverLegacyWorktreeReconciliationRequest,
  RecoverLegacyWorktreeReconciliationResult,
} from "./legacyWorktreeReconciliation.js";
export {
  continueManagedWorktreeRebase,
  gitRebaseConflictStateDigest,
  observeManagedRebaseConflict,
  observeManagedWorktreeConflictState,
  validateGitConflictContinuationResultEvidence,
} from "./gitConflictContinuation.js";
export type {
  GitConflictContinuationDeps,
  GitConflictContinuationEvidenceDeps,
  GitConflictContinuationOutcome,
  GitConflictContinuationReceipt,
  GitConflictContinuationRequest,
  GitConflictContinuationResultEvidence,
  GitConflictResolution,
  GitConflictStage,
  GitExpectedAncestry,
  GitRebaseConflictState,
  GitRebaseSequencerState,
} from "./gitConflictContinuation.js";
export { GitPersistence } from "./store/git/GitPersistence.js";
export { GitObjectLedgerBackend } from "./store/git/GitObjectLedgerBackend.js";
export type { GitObjectLedgerBackendOpts } from "./store/git/GitObjectLedgerBackend.js";
export { SqliteLedgerStore } from "./store/sqlite/SqliteLedgerStore.js";
export type { SqliteLedgerStoreOpts } from "./store/sqlite/SqliteLedgerStore.js";
export { createSqliteWorksetStore } from "./store/sqlite/sqliteWorksetStore.js";
export { openExistingLedgerDb } from "./store/sqlite/connection.js";
export type { CreateSqliteWorksetStoreOptions } from "./store/sqlite/sqliteWorksetStore.js";
export {
  openXdgProjectRuntime,
  isSafeProjectKey,
  XdgProjectRuntimeLocationError,
} from "./store/sqlite/xdgProjectRuntime.js";
export type {
  OpenXdgProjectRuntimeOptions,
  XdgProjectRuntime,
} from "./store/sqlite/xdgProjectRuntime.js";
export {
  PROJECT_DISPLAY_NAME_META_KEY,
  PROJECT_REPOSITORY_PATH_META_KEY,
  SqliteXdgProjectIdentityAccess,
  XdgProjectIdentityMetadataError,
} from "./store/sqlite/projectIdentity.js";
export type {
  XdgProjectIdentity,
  XdgProjectIdentityAccess,
} from "./store/sqlite/projectIdentity.js";
export {
  backfillXdgProjectIdentities,
  FilesystemXdgProjectIdentityBackfillAccess,
  XdgProjectIdentityBackfill,
  XdgProjectIdentityBackfillBoundaryError,
} from "./store/sqlite/xdgProjectIdentityBackfill.js";
export type {
  ResolvedXdgCheckout,
  XdgCheckoutResolution,
  XdgProjectIdentityBackfillAccess,
  XdgProjectIdentityBackfillAccessEvent,
  XdgProjectIdentityBackfillAccessObserver,
  XdgProjectIdentityBackfillDiagnostic,
  XdgProjectIdentityBackfillDiagnosticCode,
  XdgProjectIdentityBackfillProject,
  XdgProjectIdentityBackfillRequest,
  XdgProjectIdentityBackfillResult,
} from "./store/sqlite/xdgProjectIdentityBackfill.js";
export {
  FilesystemXdgProjectCatalogSource,
  ReadOnlyXdgProjectCatalog,
  XdgProjectCatalogRootError,
} from "./store/sqlite/xdgProjectCatalog.js";
export type {
  XdgProjectCatalog,
  XdgProjectCatalogCandidate,
  XdgProjectCatalogContent,
  XdgProjectCatalogDiagnostic,
  XdgProjectCatalogDiagnosticCode,
  XdgProjectCatalogEntry,
  XdgProjectCatalogResult,
  XdgProjectCatalogSource,
  XdgProjectStoreProbe,
  XdgProjectStoreSnapshot,
} from "./store/sqlite/xdgProjectCatalog.js";
// Postgres backend (G81): the barrel carries ONLY the surface external
// consumers (cq-cli's logPut postgres branch, the T577 factory, and cq serve's
// process-lifetime ownership lease) genuinely need — the rest of the
// connection/dsn/schema internals stay module-local (review R690 round 2: no
// over-export).
export { PostgresLedgerStore } from "./store/postgres/PostgresLedgerStore.js";
export type { PostgresLedgerStoreOpts } from "./store/postgres/PostgresLedgerStore.js";
export { openPgPool, tryAcquireDedicatedAdvisoryLock } from "./store/postgres/connection.js";
export type { PgAdvisoryLockLease } from "./store/postgres/connection.js";
export { ensureSchema } from "./store/postgres/schema.js";
export { createPostgresWorksetStore } from "./store/postgres/worksetStore.js";
export type {
  CreatePostgresWorksetStoreOptions,
  DurableWorksetAdmissionRow,
  PostgresWorksetStore,
} from "./store/postgres/worksetStore.js";
export { createPostgresWorksetGuardedLedger } from "./store/postgres/worksetGuardedLedger.js";
export type { CreatePostgresWorksetGuardedLedgerOptions } from "./store/postgres/worksetGuardedLedger.js";
export { resolvePostgresDsn, PostgresDsnResolutionError } from "./store/postgres/dsn.js";
export { resolveDisplayName } from "./store/postgres/displayName.js";
export type { DisplayNameCandidates } from "./store/postgres/displayName.js";
export { startPostgresCoherenceWatcher } from "./store/postgres/coherenceWatcher.js";
export type { PostgresCoherenceWatcher } from "./store/postgres/coherenceWatcher.js";
export { startPostgresHubCoherenceWatcher } from "./store/postgres/coherenceWatcher.js";
export type { PostgresHubWatcherCallbacks } from "./store/postgres/coherenceWatcher.js";
export { restoreDumpToPostgres, isPostgresTenantEmpty } from "./store/postgres/restoreImporter.js";
export {
  createLedgerStore,
  createManagementLedgerStore,
  openLegacyLedgerStore,
  resolveLedgerBackend,
  assertGitWorkTree,
  hasLegacyFsLedger,
  GitEnvironmentError,
  RemoteLedgerClientNotWiredError,
  PostgresBackupNotWiredError,
  startXdgCoherenceWatcher,
  XDG_DB_FILENAME,
} from "./store/createLedgerStore.js";
export type {
  ResolvedLedgerStore,
  ResolvedPostgresHandle,
  XdgCoherenceWatcher,
} from "./store/createLedgerStore.js";
export {
  LEDGER_SERVER_CONSTRUCTIONS,
  SINGLE_PROJECT_CONSTRUCTIONS,
  ATTESTATION_HUB_CONSTRUCTION,
  ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION,
  ATTESTATION_CONSTRUCTION_COVERAGE,
  ATTESTATION_STORE_BACKENDS,
  ATTESTATION_IN_MEMORY_BACKEND,
  AttestationConstructionUnsupportedError,
  isLedgerServerConstruction,
  isSingleProjectConstruction,
  assertAttestationConstructionSupported,
  buildAttestationConstructionCoverage,
  supportedConstructionCells,
  resolveSingleProjectAttestationNamespace,
  attestationNamespaceForTrustedHubProject,
  fsAttestationProductionRoot,
  createAttestationStoreForConstruction,
} from "./store/attestationConstruction.js";
export type {
  LedgerServerConstruction,
  SingleProjectConstruction,
  AttestationConstructionVerdict,
  SingleProjectNamespaceInput,
  XdgAttestationConstructionInput,
  FsAttestationConstructionInput,
  PostgresAttestationConstructionInput,
  AttestationConstructionStoreInput,
} from "./store/attestationConstruction.js";
export {
  PROJECT_DISPLAY_NAME_HEADER,
  PROJECT_DISPLAY_NAME_MAX_BYTES,
  RemoteLedgerClient,
  RemoteLedgerClientError,
  RemoteAuthError,
  RemoteUnavailableError,
  RemoteProtocolError,
  RemoteMalformedResponseError,
  RemoteToolError,
  RemoteDisplayNameError,
  RemoteLedgerClientConfigError,
  remoteMcpUrl,
} from "./store/remote/RemoteLedgerClient.js";
export type {
  RemoteLedgerClientOpts,
  RemoteLedgerManagementClientOpts,
  RemoteItemInit,
  RemoteItemPatch,
  RemoteMilestoneInit,
  RemoteMilestonePatch,
  RemoteFtsSearchOpts,
} from "./store/remote/RemoteLedgerClient.js";
export { InMemoryLedgerStore } from "./store/InMemoryLedgerStore.js";
export type { InMemoryLedgerStoreOpts } from "./store/InMemoryLedgerStore.js";
export { validateSchema } from "./store/core.js";
export { computeLedgerSummaries } from "./summaries.js";
export type { LedgerSummariesResult } from "./summaries.js";
export { derivePredicates } from "./store/predicates.js";
export type { DerivedPredicates, PredicateVerdict } from "./store/predicates.js";
export { AsyncMutex } from "./store/mutex.js";
export { Lockfile } from "./store/lockfile.js";
export type { LockfileOpts, LockHolder } from "./store/lockfile.js";
export { redactSecrets, REDACTION_KINDS } from "./store/logRedaction.js";
export type { RedactionKind } from "./store/logRedaction.js";
export { parseRegistry, serializeRegistry, parseSchema, EMPTY_REGISTRY } from "./registry.js";
export {
  enumerateLedgerArtifacts,
  ledgerTreePaths,
  removeLedgerArtifacts,
  LEDGER_REGISTRY_FILENAME,
  LEDGER_ARCHIVE_DIRNAME,
  LEDGER_RUNTIME_DIRNAMES,
  LEDGER_PORTABLE_RUNTIME_DIRNAMES,
  LEDGER_EPHEMERAL_RUNTIME_DIRNAMES,
  ARCHIVE_COMMIT_PENDING_FILENAME,
  WORKSET_ROOTS_FILENAME,
} from "./store/ledgerArtifacts.js";
export type { LedgerArtifacts, RemoveLedgerArtifactsResult } from "./store/ledgerArtifacts.js";
export {
  createLedgerMcpToolSpecifications,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  DISPATCH_LIFECYCLE_TOOL_NAMES,
  FULL_LEDGER_TOOL_PROFILE,
  LEDGER_TOOL_NAMES,
  ledgerToolInputJsonSchema,
  ledgerToolListDefinitions,
  ledgerToolNamesForProfile,
  NON_DISPATCH_LEDGER_TOOL_NAMES,
  selectLedgerMcpToolSpecifications,
  TOOL_PREFIX_RE,
  assertToolPrefix,
  prefixToolName,
  prefixedToolNames,
} from "./mcp/ledgerTools.js";
export type {
  LedgerToolListDefinition,
  LedgerToolName,
  LedgerToolProfileName,
  LedgerToolSpecification,
} from "./mcp/ledgerTools.js";
export {
  createLedgerSdkMcpServer,
  createManagementLedgerSdkMcpServer,
} from "./mcp/directLedgerTools.js";
export type { CreateLedgerSdkMcpServerOptions } from "./mcp/directLedgerTools.js";
export { createDispatchNarrativeSource } from "./mcp/dispatchNarrativeSource.js";
export {
  COMPACT_ITEM_FIELD_NAMES,
  GET_PLANNERS_SECTION_RESPONSE_DESCRIPTION,
  GET_REVIEWERS_SECTION_RESPONSE_DESCRIPTION,
  ITEM_PROJECTION_DESCRIPTION,
  LEDGER_RESPONSE_CONTRACTS,
  isProducedWireDto,
  produceWireDto,
  projectCompactItemDto,
  projectComplementItemDto,
  projectFullItemDto,
  projectItemDto,
  projectFetchedLedgerDto,
  projectPaginatedLedgerDto,
  projectFtsSearchResultsDto,
  projectFetchedMilestoneDto,
  projectMilestoneItemGroupsDto,
  projectItemMutationAckDto,
  projectLedgerMutationAckDto,
  projectMilestoneMutationAckDto,
  serializeWireDto,
} from "./mcp/wireResponseContract.js";
export type {
  ProducedWireDto,
  ItemProjection,
  CompactItemFieldName,
  CompactItemFieldsDto,
  CompactItemDto,
  ComplementItemDto,
  FullItemDto,
  ItemDto,
  FetchedLedgerDto,
  PaginatedLedgerDto,
  FtsSearchResultDto,
  FetchedMilestoneDto,
  MilestoneItemGroupsDto,
  ItemReferenceFieldsDto,
  MilestoneReferenceFieldsDto,
  ItemMutationAckDto,
  LedgerMutationAckDto,
  MilestoneMutationAckDto,
  MandatoryItemProjectionContract,
  FixedAcknowledgementContract,
  PurposeBuiltSmallContract,
  RequestedFullContentContract,
  LedgerResponseContract,
} from "./mcp/wireResponseContract.js";
export {
  registerLedgerStdioToolSpecifications,
  registerLedgerStdioTools,
  registerLedgerStdioManagementTools,
} from "./mcp/stdioLedgerTools.js";
export {
  PLAN_CLAIM_TOKEN_ECHO_PATH,
  PLAN_LIFECYCLE_TOOL_NAMES,
  PLAN_LIFECYCLE_TOOL_SPECS,
  PlanLifecycleNotImplementedError,
  assertPlanLifecycleTokenExposure,
  isPlanLifecycleStore,
} from "./mcp/planLifecycleTools.js";
export type { PlanLifecycleToolName, PlanLifecycleToolSpec } from "./mcp/planLifecycleTools.js";
export {
  WORKTREE_MANAGE_INPUT_SHAPE,
  WORKTREE_MANAGE_TOOL_NAME,
  WORKTREE_MANAGE_TOOL_SPEC,
  WorktreeManageNotImplementedError,
  createWorktreeManageCapability,
  dependencyTaskSnapshotReaderFromStore,
  parseWorktreeManageInput,
} from "./mcp/worktreeManageTools.js";
export type {
  WorktreeManageCapability,
  WorktreeManageFlatInput,
  WorktreeManageToolName,
  WorktreeManageToolSpec,
} from "./mcp/worktreeManageTools.js";
export { MAX_READ_LOG_BYTES, ReadLogNotImplementedError } from "./mcp/readLog.js";
export type { ReadLogCapability, ReadLogResult } from "./mcp/readLog.js";
export { DispatchNotImplementedError } from "./mcp/dispatchCapability.js";
export type {
  AbortDispatchToolInput,
  ConfirmDispatchCompletionToolInput,
  DispatchCapability,
  DispatchWorktreeActivityObservation,
  FetchDispatchInputToolInput,
  FetchDispatchResultToolInput,
  PrepareDispatchToolInput,
  StoreResultToolInput,
} from "./mcp/dispatchCapability.js";
export { ListProjectsNotImplementedError } from "./mcp/listProjects.js";
export type {
  ListProjectsCapability,
  ListProjectsResult,
  ProjectEntry,
} from "./mcp/listProjects.js";
export {
  CONFIG_SECTIONS,
  ConfigNotImplementedError,
  computeConfigSection,
} from "./mcp/configCapability.js";
export type {
  ConfigCapability,
  ConfigSection,
  ConfigSectionResult,
  ResolvedReviewer,
  GetReviewersResult,
  ResolvedPlanner,
  GetPlannersResult,
  GetConfigResult,
  AgentModelStatus,
  AgentModelEntry,
  AgentModelsResult,
} from "./mcp/configCapability.js";
export {
  UnknownRoleError,
  NoSchemaForRoleError,
  PromptCatalogNotImplementedError,
  FETCH_PROMPT_PROJECTIONS,
  projectFetchPromptResult,
} from "./mcp/promptCatalogCapability.js";
export type {
  PromptCatalogCapability,
  FetchPromptResult,
  FetchPromptProjection,
  FetchPromptSchemaResult,
  PromptValidationResult,
  PromptValidationError,
  PromptRoleKind,
  PromptSurface,
  PromptRendererCapability,
  PromptIntentionalDifferenceKind,
  PromptIntentionalDifference,
  PromptWorkflowDependency,
  PromptSharedSourceBlock,
  PromptFragmentBinding,
  PromptRendererMetadata,
  JSONSchemaDoc,
} from "./mcp/promptCatalogCapability.js";
export { LedgerSearchIndex } from "./search/LedgerSearchIndex.js";
export type { FtsSearchOpts, FtsSearchHit } from "./search/LedgerSearchIndex.js";
export {
  defectFixTaskIds,
  hypothesisRelationships,
  hypothesesLinkedToRef,
  hypothesisForest,
} from "./relationships.js";
export type { HypothesisRelationships, HypothesisForestNode } from "./relationships.js";
export {
  eligibleColumnFields,
  defaultColumns,
  LONG_FIELD_DENYLIST,
  ALWAYS_SHOWN_COLUMNS,
  SUMMARY_SOURCE_FIELDS,
} from "./columns.js";
export { paginate } from "./projection.js";
export type { PaginateResult } from "./projection.js";
export { summarize, fieldToString } from "./summarize.js";
export { buildSnapshot } from "./snapshot.js";
export type { LedgerSnapshot, SnapshotItemStub, SnapshotStatusBucket } from "./snapshot.js";
export { validateJsonl } from "./store/jsonlLog.js";
export type {
  JsonlValidationResult,
  JsonlValidationOk,
  JsonlValidationError,
} from "./store/jsonlLog.js";
export {
  resolveStateDirBase,
  resolveStateDir,
  resolveLogsDir,
  STORE_LAYOUT,
  ensureStateDir,
} from "./stateDir.js";
export { resolveProjectKey, ProjectKeyResolutionError } from "./projectKey.js";
export type { ResolveProjectKeyOpts } from "./projectKey.js";
export {
  parseRef,
  buildPrefixRegistry,
  canonicalizeRef,
  DEPENDENCY_REF_FIELDS,
  RefParseError,
} from "./refs.js";
export type { ParsedRef } from "./refs.js";
export { FINALIZE_PRESENTATION, describeFinalizeEmptyPlan } from "./finalizePresentation.js";
export type { FinalizePresentation, FinalizeScope } from "./finalizePresentation.js";
