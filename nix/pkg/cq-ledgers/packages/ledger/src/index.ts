/**
 * @cq/ledger — markdown-backed ledger library + in-process SDK-MCP tools.
 */

export * from "./types.js";
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
  HANDOFFS_LEDGER,
  IDEAS_LEDGER,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  REVIEWS_SCHEMA,
  HANDOFFS_SCHEMA,
  IDEAS_SCHEMA,
  CANONICAL_LEDGERS,
  LEDGER_STORAGE_DIRNAME,
  LEDGER_LOGS_DIRNAME,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
  ISO_TIMESTAMP_RE,
  isIsoTimestamp,
} from "./constants.js";
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
export { AbstractLedgerStore, schemasEqual, schemaCompatible } from "./store/AbstractLedgerStore.js";
export { FsPersistence } from "./store/FsPersistence.js";
export type { FsPersistenceLayout } from "./store/FsPersistence.js";
export { FsLedgerStore } from "./store/FsLedgerStore.js";
export type { FsLedgerStoreOpts, ResetSummary } from "./store/FsLedgerStore.js";
export { cacheMirrorDir, mirrorMutation } from "./store/cacheMirror.js";
export type { MirrorLayout } from "./store/cacheMirror.js";
export { atomicWrite } from "./store/fsAtomic.js";
export { GitPlumbing, StaleRefError, GitCommandError, nodeGitRunner } from "./store/git/GitPlumbing.js";
export type { TreeEntry, GitResult, GitRunOpts, GitRunner } from "./store/git/GitPlumbing.js";
export { GitPersistence } from "./store/git/GitPersistence.js";
export { GitObjectLedgerBackend } from "./store/git/GitObjectLedgerBackend.js";
export type { GitObjectLedgerBackendOpts } from "./store/git/GitObjectLedgerBackend.js";
export {
  createLedgerStore,
  resolveLedgerBackend,
  assertGitWorkTree,
  GitEnvironmentError,
  LedgerBackendNotImplementedError,
} from "./store/createLedgerStore.js";
export type { ResolvedLedgerStore } from "./store/createLedgerStore.js";
export {
  ensureGitBackendGitignore,
  removeGitBackendGitignore,
  GIT_BACKEND_GITIGNORE_MARKER,
  GIT_BACKEND_GITIGNORE_END_MARKER,
  GIT_BACKEND_GITIGNORE_BLOCK,
} from "./store/gitBackendGitignore.js";
export { InMemoryLedgerStore } from "./store/InMemoryLedgerStore.js";
export type { InMemoryLedgerStoreOpts } from "./store/InMemoryLedgerStore.js";
export { validateSchema } from "./store/core.js";
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
} from "./store/ledgerArtifacts.js";
export type { LedgerArtifacts, RemoveLedgerArtifactsResult } from "./store/ledgerArtifacts.js";
export {
  createLedgerMcpTools,
  LEDGER_TOOL_NAMES,
  TOOL_PREFIX_RE,
  assertToolPrefix,
  prefixToolName,
  prefixedToolNames,
} from "./mcp/ledgerTools.js";
export { registerLedgerStdioTools } from "./mcp/stdioLedgerTools.js";
export {
  MAX_READ_LOG_BYTES,
  ReadLogNotImplementedError,
} from "./mcp/readLog.js";
export type { ReadLogCapability, ReadLogResult } from "./mcp/readLog.js";
export { ConfigNotImplementedError } from "./mcp/configCapability.js";
export type {
  ConfigCapability,
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
} from "./mcp/promptCatalogCapability.js";
export type {
  PromptCatalogCapability,
  FetchPromptResult,
  PromptValidationResult,
  PromptValidationError,
  PromptRoleKind,
  JSONSchemaDoc,
} from "./mcp/promptCatalogCapability.js";
export { LedgerSearchIndex } from "./search/LedgerSearchIndex.js";
export type { FtsSearchOpts, FtsSearchHit } from "./search/LedgerSearchIndex.js";
export {
  defectFixTaskIds,
  hypothesisRelationships,
} from "./relationships.js";
export type { HypothesisRelationships } from "./relationships.js";
export {
  eligibleColumnFields,
  defaultColumns,
  LONG_FIELD_DENYLIST,
  ALWAYS_SHOWN_COLUMNS,
  SUMMARY_SOURCE_FIELDS,
} from "./columns.js";
export {
  projectCompact,
  paginate,
  COMPACT_PROJECTION_DENYLIST,
  PROJECTION_EXTRA_DENYLIST,
} from "./projection.js";
export type { PaginateResult } from "./projection.js";
export { summarize, fieldToString } from "./summarize.js";
export { buildSnapshot } from "./snapshot.js";
export type {
  LedgerSnapshot,
  SnapshotItemStub,
  SnapshotStatusBucket,
} from "./snapshot.js";
export { validateJsonl } from "./store/jsonlLog.js";
export type { JsonlValidationResult, JsonlValidationOk, JsonlValidationError } from "./store/jsonlLog.js";
export {
  resolveStateDirBase,
  resolveStateDir,
  resolveLogsDir,
  STORE_LAYOUT,
  ensureStateDir,
} from "./stateDir.js";
