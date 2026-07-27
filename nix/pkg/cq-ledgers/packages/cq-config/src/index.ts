/**
 * @cq/config — cq.toml data model + parser/resolver (T170).
 *
 * Pure, typed module: parse a cq.toml document into a CqConfig, resolve its
 * `reviewers` aliases into ReviewerToken[], and load it from a repo root.
 * No MCP/transport concerns (that lands in T171).
 */

export type {
  Harness,
  ActiveHarness,
  ReviewerToken,
  CqConfig,
  WebuiConfig,
  Tier,
  TierEntry,
  TiersConfig,
  PiEffort,
  ClaudeEffort,
  Effort,
  LedgerBackend,
  LedgerBackupMode,
  LedgerConfig,
  RemoteLedgerConfig,
  NonRemoteLedgerConfig,
  RemoteServerUrl,
  RemoteLedgerToken,
  ProjectConfig,
} from "./types.js";
export {
  HARNESSES,
  isHarness,
  ACTIVE_HARNESSES,
  isActiveHarness,
  TIERS,
  isTier,
  DEFAULT_TIER,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
  isEffort,
  LEDGER_BACKENDS,
  isLedgerBackend,
  LEDGER_BACKUP_MODES,
  isLedgerBackupMode,
} from "./types.js";
export {
  CQ_CONFIG_FILENAME,
  CqConfigError,
  parseReviewerToken,
  formatReviewerToken,
  reviewerTokensEqual,
  parseConfig,
  assertDispatchable,
  resolveReviewers,
  resolvePlanners,
  resolveAgentTier,
  tierModel,
  applyAgentEffort,
  resolveAgentModel,
  loadConfig,
} from "./config.js";
export {
  resolveActiveHarness,
  resolveActiveHarnessFromProcess,
  DEFAULT_HARNESS,
  CQ_HARNESS_ENV,
  CLAUDE_CODE_SESSION_ID_ENV,
} from "./activeHarness.js";
export type {
  RawToml,
  RawWebui,
  RawLedger,
  RawProject,
  RawHarnessOverride,
} from "./toml.js";
export { parseToml } from "./toml.js";
export {
  CQ_LEDGER_REMOTE_TOKEN_ENV,
  RemoteLedgerTokenError,
  resolveRemoteLedgerToken,
  resolveRemoteLedgerTokenFromProcess,
} from "./remoteToken.js";
export type { AgentRoleTier } from "./agentRoster.js";
export { AGENT_ROLE_TIERS } from "./agentRoster.js";
export type {
  RoleKind,
  ModelTier,
  PromptSurface,
  IntentionalDifferenceKind,
  IntentionalDifferenceDeclaration,
  JSONSchema,
  JSONSchemaType,
  PromptCatalogEntry,
  RoleSchemaSidecar,
} from "./promptCatalog.js";
export {
  PROMPT_SURFACES,
  isPromptSurface,
  INTENTIONAL_DIFFERENCE_KINDS,
  isIntentionalDifferenceKind,
  INTENTIONAL_DIFFERENCE_DECLARATION_SCHEMA,
  PromptCatalogSchemaError,
  parseIntentionalDifferenceDeclaration,
  parseIntentionalDifferenceDeclarationJSON,
  serializeIntentionalDifferenceDeclaration,
} from "./promptCatalog.js";
export type {
  PromptFragmentSlot,
  PromptBlockClassification,
  PromptDispatchEdgeKind,
  PromptDispatchEdge,
  SharedPromptSourceBlock,
  FragmentPromptSourceBlock,
  PromptSourceBlock,
  PromptRoleSourceInventoryEntry,
  PromptFragmentSlotContract,
  ResolvedPromptFragmentInventoryEntry,
} from "./promptFragmentInventory.js";
export {
  PROMPT_FRAGMENT_SLOTS,
  PROMPT_BLOCK_CLASSIFICATIONS,
  PROMPT_DISPATCH_EDGE_KINDS,
  PROMPT_FRAGMENT_SLOT_CONTRACTS,
  PROMPT_ROLE_SOURCE_INVENTORY,
  PROMPT_FRAGMENT_INVENTORY,
  validatePromptFragmentInventory,
} from "./promptFragmentInventory.js";
export type {
  PromptCatalogFileInput,
  PromptFragmentFileInput,
  RenderPromptSurfaceTreeInput,
  RenderedPromptArtifact,
  RenderedPromptSurfaceTree,
} from "./promptRenderer.js";
export { PromptRendererError, renderPromptSurfaceTree } from "./promptRenderer.js";
export type {
  PromptVerificationRoot,
  PromptFragmentObservation,
  PromptCatalogVerificationInput,
} from "./promptCatalogVerification.js";
export {
  PromptCatalogVerificationError,
  verifyPromptCatalog,
} from "./promptCatalogVerification.js";
export { planAdvanceSidecar, PLAN_STEP_ACTIONS } from "./schemas/plan-advance.js";
export { planReviewerSidecar, PLAN_REVIEW_VERDICTS } from "./schemas/plan-reviewer.js";
export { implementWorkerSidecar, IMPLEMENT_WORKER_STATUSES } from "./schemas/implement-worker.js";
export {
  implementReviewerSidecar,
  IMPLEMENT_REVIEW_VERDICTS,
} from "./schemas/implement-reviewer.js";
export {
  implementConflictResolverSidecar,
  CONFLICT_RESOLVER_STATUSES,
} from "./schemas/implement-conflict-resolver.js";
export { investigateExplorerSidecar } from "./schemas/investigate-explorer.js";
export { investigateProberSidecar } from "./schemas/investigate-prober.js";
export { EVIDENCE_LEANS } from "./schemas/investigate-evidence.js";
export {
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_IDS,
  getRoleSidecar,
} from "./promptCatalogStore.js";
export type { ValidationError, ValidationResult } from "./validation.js";
export { validateAgainstSchema } from "./validation.js";
export type {
  DispatchedRoleId,
  DispatchJSONValue,
  DispatchOverlayApplication,
  CompactDispatchLaunch,
  DispatchHandle,
  ResultCapability,
  DispatchPromptProvenance,
  DispatchDeadlines,
  DispatchPrepared,
  StoreDispatchResult,
  NativeCompletionProof,
  ConfirmDispatchCompletion,
  DispatchAbortReason,
  AbortDispatch,
  DispatchLifecycleState,
  PreparedDispatchResult,
  ResultStoredDispatchResult,
  ConsumedDispatchResult,
  AbortedDispatchResult,
  TerminalEnvelopeExpiredDispatchResult,
  AttestationNotFoundDispatchResult,
  FetchDispatchResult,
  DispatchProtocolOperation,
} from "./compactDispatchProtocol.js";
export {
  DISPATCH_ABORT_REASONS,
  DISPATCH_LIFECYCLE_STATES,
  DISPATCH_PROTOCOL_OPERATIONS,
  COMPACT_DISPATCH_LAUNCH_SCHEMA,
  DISPATCH_HANDLE_SCHEMA,
  DISPATCH_PREPARED_SCHEMA,
  STORE_DISPATCH_RESULT_SCHEMA,
  CONFIRM_DISPATCH_COMPLETION_SCHEMA,
  ABORT_DISPATCH_SCHEMA,
  FETCH_DISPATCH_RESULT_SCHEMA,
} from "./compactDispatchProtocol.js";
