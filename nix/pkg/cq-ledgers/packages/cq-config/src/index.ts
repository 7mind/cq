/**
 * @cq/config — cq.toml data model + parser/resolver (T170).
 *
 * Pure, typed module: parse a cq.toml document into a CqConfig, resolve its
 * `reviewers` aliases into ReviewerToken[], and load it from a repo root.
 * No MCP/transport concerns (that lands in T171).
 */

export type { Harness, ReviewerToken, CqConfig } from "./types.js";
export { HARNESSES, isHarness } from "./types.js";
export {
  CQ_CONFIG_FILENAME,
  CqConfigError,
  parseReviewerToken,
  parseConfig,
  resolveReviewers,
  loadConfig,
} from "./config.js";
export type { RawToml } from "./toml.js";
export { parseToml } from "./toml.js";
