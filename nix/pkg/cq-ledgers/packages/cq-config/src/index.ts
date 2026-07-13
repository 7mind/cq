/**
 * @cq/config — cq.toml data model + parser/resolver (T170).
 *
 * Pure, typed module: parse a cq.toml document into a CqConfig, resolve its
 * `reviewers` aliases into ReviewerToken[], and load it from a repo root.
 * No MCP/transport concerns (that lands in T171).
 */

export type {
  Harness,
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
  LedgerConfig,
} from "./types.js";
export {
  HARNESSES,
  isHarness,
  TIERS,
  isTier,
  DEFAULT_TIER,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
  isEffort,
  LEDGER_BACKENDS,
  isLedgerBackend,
} from "./types.js";
export {
  CQ_CONFIG_FILENAME,
  CqConfigError,
  parseReviewerToken,
  formatReviewerToken,
  reviewerTokensEqual,
  parseConfig,
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
  RawHarnessOverride,
} from "./toml.js";
export { parseToml } from "./toml.js";
export type { AgentRoleTier } from "./agentRoster.js";
export { AGENT_ROLE_TIERS } from "./agentRoster.js";
export type {
  RoleKind,
  ModelTier,
  JSONSchema,
  JSONSchemaType,
  PromptCatalogEntry,
  RoleSchemaSidecar,
} from "./promptCatalog.js";
export { planAdvanceSidecar, PLAN_ADVANCE_STATUS_TOKENS } from "./schemas/plan-advance.js";
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
