/**
 * cq.toml config capability for the ledger MCP (T1 / T13 / R193 / G18).
 *
 * Provides computeReviewers/computePlanners/computeConfig as a small module
 * local to `@cq/ledger-mcp`. `@cq/ledger` core stays config-agnostic — the
 * `@cq/config` import + `loadConfig`/`resolveReviewers`/`resolvePlanners` calls
 * live ONLY here; the resulting `ConfigCapability` is INJECTED into
 * `registerLedgerStdioTools` / `createLedgerMcpTools` (the buildServer wiring
 * is T2).
 *
 * Each method re-reads `cq.toml` from disk on every call so the server
 * reflects edits without a restart.
 */

import {
  loadConfig,
  resolveReviewers,
  resolvePlanners,
  type CqConfig,
} from "@cq/config";
import type {
  ConfigCapability,
  GetReviewersResult,
  GetPlannersResult,
  GetConfigResult,
  ResolvedReviewer,
  ResolvedPlanner,
} from "@cq/ledger";

/**
 * Compute the `get_reviewers` payload for `repoRoot`.
 *
 * Loads `cq.toml` (null when absent → `configured:false`), then resolves each
 * `reviewers` alias through `[aliases]` into a `{ harness, model, alias }`.
 * An empty resolved set also yields `configured:false` — the orchestrators
 * then use the single native Claude reviewer.
 */
export function computeReviewers(repoRoot: string): GetReviewersResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return { configured: false, reviewers: [] };
  }
  const tokens = resolveReviewers(config);
  const reviewers: ResolvedReviewer[] = tokens.map((token, i) => ({
    harness: token.harness,
    model: token.model,
    provider: token.provider,
    // resolveReviewers preserves order, so the alias is config.reviewers[i].
    alias: config.reviewers[i] as string,
  }));
  return { configured: reviewers.length > 0, reviewers };
}

/**
 * Compute the `get_planners` payload for `repoRoot`.
 *
 * Loads `cq.toml` (null when absent → `configured:false`), then resolves each
 * `planners` alias through `[aliases]` into a `{ harness, model, alias }`.
 * An empty resolved set also yields `configured:false` — the orchestrators
 * then use the single native Claude planner. Mirrors {@link computeReviewers}.
 */
export function computePlanners(repoRoot: string): GetPlannersResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return { configured: false, planners: [] };
  }
  const tokens = resolvePlanners(config);
  const planners: ResolvedPlanner[] = tokens.map((token, i) => ({
    harness: token.harness,
    model: token.model,
    provider: token.provider,
    // resolvePlanners preserves order, so the alias is config.planners[i].
    alias: config.planners[i] as string,
  }));
  return { configured: planners.length > 0, planners };
}

/** Compute the `get_config` payload for `repoRoot`. */
export function computeConfig(repoRoot: string): GetConfigResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return {
      configured: false,
      aliases: {},
      reviewers: [],
      planners: [],
      tiers: null,
      agentTiers: null,
    };
  }
  return projectConfig(config);
}

function projectConfig(config: CqConfig): GetConfigResult {
  const aliases: Record<
    string,
    { harness: string; model: string; provider: string | null }
  > = {};
  for (const [name, token] of Object.entries(config.aliases)) {
    aliases[name] = {
      harness: token.harness,
      model: token.model,
      provider: token.provider,
    };
  }

  let tiers: GetConfigResult["tiers"] = null;
  if (config.tiers !== null) {
    // T268 minimal bridge: the GetConfig wire shape still exposes the
    // per-tier-slot view (fast/standard/frontier). Derive each slot from the
    // inverted classifier `entries` by picking the first token of that class.
    // The wire-shape rework (token-keyed classifier over MCP) is a downstream
    // task; here we keep the existing output contract intact.
    const slotFor = (cls: "fast" | "standard" | "frontier") => {
      const entry = config.tiers!.entries.find((e) => e.class === cls);
      return entry === undefined
        ? {}
        : {
            [cls]: {
              harness: entry.token.harness,
              model: entry.token.model,
              provider: entry.token.provider,
            },
          };
    };
    tiers = {
      ...slotFor("fast"),
      ...slotFor("standard"),
      ...slotFor("frontier"),
    };
  }

  return {
    configured: config.reviewers.length > 0,
    aliases,
    reviewers: config.reviewers,
    planners: config.planners,
    tiers,
    agentTiers: config.agentTiers,
  };
}

/**
 * Build a {@link ConfigCapability} bound to `repoRoot`, suitable for injection
 * into the ledger tool factories. Each method re-reads `cq.toml` on each call.
 */
export function createConfigCapability(repoRoot: string): ConfigCapability {
  return {
    computeReviewers: () => computeReviewers(repoRoot),
    computePlanners: () => computePlanners(repoRoot),
    computeConfig: () => computeConfig(repoRoot),
    // T283 added the interface method; the resolution logic is T285. Throwing
    // stub keeps typecheck green until T285 replaces it with a real impl.
    computeAgentModels: () => {
      throw new Error("computeAgentModels not implemented — T285");
    },
  };
}
