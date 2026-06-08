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
} from "./types.js";
export { HARNESSES, isHarness, TIERS, isTier, DEFAULT_TIER } from "./types.js";
export {
  CQ_CONFIG_FILENAME,
  CqConfigError,
  parseReviewerToken,
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
