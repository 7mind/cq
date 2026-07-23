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
  resolveAgentTier,
  tierModel,
  applyAgentEffort,
  HARNESSES,
  AGENT_ROLE_TIERS,
  type CqConfig,
  type Harness,
  type ReviewerToken,
} from "@cq/config";
import type {
  ConfigCapability,
  GetReviewersResult,
  GetPlannersResult,
  GetConfigResult,
  ResolvedReviewer,
  ResolvedPlanner,
  AgentModelsResult,
  AgentModelEntry,
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
    effort: token.effort ?? null,
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
    effort: token.effort ?? null,
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
      agentEfforts: {},
    };
  }
  return projectConfig(config);
}

function projectConfig(config: CqConfig): GetConfigResult {
  const aliases: GetConfigResult["aliases"] = {};
  for (const [name, token] of Object.entries(config.aliases)) {
    aliases[name] = {
      harness: token.harness,
      model: token.model,
      provider: token.provider,
      effort: token.effort ?? null,
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
              effort: entry.token.effort ?? null,
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
    // D81: `configured` means 'a parseable cq.toml is present', independent
    // of whether reviewers/planners/tiers are populated. `projectConfig` is
    // only ever called from the `config !== null` branch of `computeConfig`,
    // so it is unconditionally true here.
    configured: true,
    aliases,
    reviewers: config.reviewers,
    planners: config.planners,
    tiers,
    agentTiers: config.agentTiers,
    agentEfforts: config.agentEfforts,
  };
}

/**
 * Group `tokens` by harness into the per-harness `modelMappings` shape: each
 * concrete model id is de-duplicated per harness (by its provider-qualified
 * rendering) and sorted for deterministic output. A pi token is rendered
 * `<provider>/<model>`; a claude token (provider null) is rendered bare. When
 * `token.effort` is present (non-null), a `:<effort>` suffix is appended so
 * `get_agent_models` can show which effort a mapping runs at (D79); an
 * effortless token renders unchanged, with no trailing colon.
 *
 * Returns `{}` when no token maps to any harness (the `no-live-token` case).
 */
function groupByHarness(
  tokens: readonly ReviewerToken[],
): AgentModelEntry["modelMappings"] {
  const byHarness: Record<Harness, Set<string>> = {
    claude: new Set(),
    pi: new Set(),
  };
  for (const t of tokens) {
    const base = t.provider === null ? t.model : `${t.provider}/${t.model}`;
    byHarness[t.harness].add(
      t.effort === null || t.effort === undefined
        ? base
        : `${base}:${t.effort}`,
    );
  }
  const mappings: { claude?: readonly string[]; pi?: readonly string[] } = {};
  for (const harness of HARNESSES) {
    const models = [...byHarness[harness]].sort();
    if (models.length > 0) {
      mappings[harness] = models;
    }
  }
  return mappings;
}

/**
 * Compute the `get_agent_models` payload for `repoRoot` (Q156–Q158).
 *
 * Re-reads `cq.toml` per call (no caching), like the other compute* methods.
 * Walks the fixed {@link AGENT_ROLE_TIERS} 24-role roster (the SHARED anti-drift
 * roster the codegen also consumes) and, per role:
 *
 *  - `agentTierKey === null` (orchestrator commands) -> status
 *    `not-model-configurable`, `modelClass` null, empty mappings.
 *  - otherwise, when no `cq.toml` is present (`config === null`) -> status
 *    `not-configured` for every model-configurable role.
 *  - otherwise resolve the role's tier via {@link resolveAgentTier}, look up the
 *    one model the `[tiers]` map assigns to that tier via {@link tierModel},
 *    apply the `[agent_efforts]` per-agent effort override via
 *    {@link applyAgentEffort} (Q254), and group it by harness. No model for the
 *    tier -> status `no-live-token` with `modelClass = tier`; a model -> status
 *    `resolved` with `modelClass = tier` and per-harness mappings (Q157).
 *
 * `configured` is `config !== null`.
 */
export function computeAgentModels(repoRoot: string): AgentModelsResult {
  const config = loadConfig(repoRoot);

  const agents: AgentModelEntry[] = AGENT_ROLE_TIERS.map((role) => {
    if (role.agentTierKey === null) {
      return {
        id: role.id,
        status: "not-model-configurable",
        modelClass: null,
        modelMappings: {},
      };
    }
    if (config === null) {
      return {
        id: role.id,
        status: "not-configured",
        modelClass: null,
        modelMappings: {},
      };
    }
    const tier = resolveAgentTier(config, role.agentTierKey);
    const token = tierModel(config, tier);
    // Q254: apply the [agent_efforts] per-agent effort override on top of the
    // tier token, so the effort-aware modelMappings (D79) reflect it.
    const effective =
      token === undefined
        ? undefined
        : applyAgentEffort(config, role.agentTierKey, token);
    const modelMappings = groupByHarness(
      effective === undefined ? [] : [effective],
    );
    const hasLiveToken =
      modelMappings.claude !== undefined || modelMappings.pi !== undefined;
    return {
      id: role.id,
      status: hasLiveToken ? "resolved" : "no-live-token",
      modelClass: tier,
      modelMappings,
    };
  });

  return { configured: config !== null, agents };
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
    computeAgentModels: () => computeAgentModels(repoRoot),
  };
}
