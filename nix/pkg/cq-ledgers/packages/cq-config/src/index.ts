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
  classifyToken,
  selectTokensForTier,
  resolveAgentModel,
  loadConfig,
} from "./config.js";
export type { RawToml, RawWebui } from "./toml.js";
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
