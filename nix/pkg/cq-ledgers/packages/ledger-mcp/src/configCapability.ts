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
  assertDispatchable,
  loadConfig,
  resolveReviewers,
  resolvePlanners,
  resolveAgentTier,
  tierModel,
  applyAgentEffort,
  defaultPanelFor,
  resolveActiveHarnessFromProcess,
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
  ConfigSection,
  ConfigSectionResult,
} from "@cq/ledger";

/**
 * Project a built-in default panel into the MCP wire shape. Alias is the
 * template alias name (opus/grok/codex), not the rendered token string.
 */
function resolveDefaultPanel(
  entries: readonly { readonly alias: string; readonly token: ReviewerToken }[],
): readonly ResolvedReviewer[] {
  return entries.map((entry) => ({
    harness: entry.token.harness,
    model: entry.token.model,
    provider: entry.token.provider,
    alias: entry.alias,
    effort: entry.token.effort ?? null,
  }));
}

/**
 * Compute the `reviewers` section payload for `repoRoot`.
 *
 * LIST-KEYED `configured` (D144/D153): true only when a cq.toml exists AND the
 * resolved reviewers list is non-empty. When unconfigured (absent cq.toml or
 * empty list), returns the ACTIVE harness default panel with `source:
 * "default"` and `configured: false`.
 */
export function computeReviewers(repoRoot: string): GetReviewersResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return {
      configured: false,
      source: "default",
      reviewers: resolveDefaultPanel(defaultPanelFor(resolveActiveHarnessFromProcess()).reviewers),
    };
  }
  const tokens = resolveReviewers(config);
  if (tokens.length === 0) {
    return {
      configured: false,
      source: "default",
      reviewers: resolveDefaultPanel(defaultPanelFor(resolveActiveHarnessFromProcess()).reviewers),
    };
  }
  const reviewers: ResolvedReviewer[] = tokens.map((token, i) => ({
    harness: token.harness,
    model: token.model,
    provider: token.provider,
    // resolveReviewers preserves order, so the alias is config.reviewers[i].
    alias: config.reviewers[i] as string,
    effort: token.effort ?? null,
  }));
  return { configured: true, source: "cq.toml", reviewers };
}

/**
 * Compute the `planners` section payload for `repoRoot`.
 *
 * LIST-KEYED `configured` (D144/D153): true only when a cq.toml exists AND the
 * resolved planners list is non-empty. When unconfigured, returns
 * `source: "default"` and `configured: false`. Mirrors {@link computeReviewers}.
 */
export function computePlanners(repoRoot: string): GetPlannersResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return {
      configured: false,
      source: "default",
      planners: resolveDefaultPanel(defaultPanelFor(resolveActiveHarnessFromProcess()).planners),
    };
  }
  const tokens = resolvePlanners(config);
  if (tokens.length === 0) {
    return {
      configured: false,
      source: "default",
      planners: resolveDefaultPanel(defaultPanelFor(resolveActiveHarnessFromProcess()).planners),
    };
  }
  const planners: ResolvedPlanner[] = tokens.map((token, i) => ({
    harness: token.harness,
    model: token.model,
    provider: token.provider,
    // resolvePlanners preserves order, so the alias is config.planners[i].
    alias: config.planners[i] as string,
    effort: token.effort ?? null,
  }));
  return { configured: true, source: "cq.toml", planners };
}

/**
 * Compute the `get_config` payload for `repoRoot`.
 *
 * Projects the DISPATCH PANELS (`reviewers` / `planners` / `[tiers]`), so it
 * fails closed on the active selector's recorded violation (T861) exactly like
 * the `reviewers` / `planners` / `agent_models` sections — a Codex host must
 * never be handed a Claude panel it cannot invoke.
 */
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
      dispatch: {
        forceShellout: false,
        unsafeDisableCodexReadOnlySandbox: false,
      },
    };
  }
  assertDispatchable(config);
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
    dispatch: config.dispatch,
  };
}

/**
 * Group `tokens` by harness into the per-harness `modelMappings` shape: each
 * concrete model id is de-duplicated per harness (by its provider-qualified
 * rendering) and sorted for deterministic output. A pi token is rendered
 * `<provider>/<model>`; a claude token (provider null) is rendered bare. When
 * `token.effort` is present (non-null), a `:<effort>` suffix is appended so
 * the `agent_models` section can show which effort a mapping runs at (D79); an
 * effortless token renders unchanged, with no trailing colon.
 *
 * Returns `{}` when no token maps to any harness (the `no-live-token` case).
 */
function groupByHarness(tokens: readonly ReviewerToken[]): AgentModelEntry["modelMappings"] {
  const byHarness: Record<Harness, Set<string>> = {
    claude: new Set(),
    codex: new Set(),
    pi: new Set(),
  };
  for (const t of tokens) {
    const base = t.provider === null ? t.model : `${t.provider}/${t.model}`;
    byHarness[t.harness].add(
      t.effort === null || t.effort === undefined ? base : `${base}:${t.effort}`,
    );
  }
  const mappings: { claude?: readonly string[]; codex?: readonly string[]; pi?: readonly string[] } = {};
  for (const harness of HARNESSES) {
    const models = [...byHarness[harness]].sort();
    if (models.length > 0) {
      mappings[harness] = models;
    }
  }
  return mappings;
}

/**
 * Compute the `agent_models` section payload for `repoRoot` (Q156–Q158).
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
      token === undefined ? undefined : applyAgentEffort(config, role.agentTierKey, token);
    const modelMappings = groupByHarness(effective === undefined ? [] : [effective]);
    const hasLiveToken = modelMappings.claude !== undefined || modelMappings.codex !== undefined || modelMappings.pi !== undefined;
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
    computeSection: (section) => computeSection(repoRoot, section),
  };
}

export function computeSection(repoRoot: string, section: ConfigSection): ConfigSectionResult {
  switch (section) {
    case "reviewers":
      return computeReviewers(repoRoot);
    case "planners":
      return computePlanners(repoRoot);
    case "agent_models":
      return computeAgentModels(repoRoot);
    case "all":
      return computeConfig(repoRoot);
  }
  const config = loadConfig(repoRoot);
  if (config === null) {
    switch (section) {
      case "aliases":
        return { configured: false, aliases: {} };
      case "tiers":
        return { configured: false, tiers: null };
      case "agent_tiers":
        return { configured: false, agentTiers: null };
      case "agent_efforts":
        return { configured: false, agentEfforts: {} };
    }
  }
  const projected = projectConfig(config);
  switch (section) {
    case "aliases":
      return {
        configured: Object.keys(projected.aliases).length > 0,
        aliases: projected.aliases,
      };
    case "tiers": {
      const populated = projected.tiers !== null && Object.keys(projected.tiers).length > 0;
      return { configured: populated, tiers: populated ? projected.tiers : null };
    }
    case "agent_tiers": {
      const populated =
        projected.agentTiers !== null && Object.keys(projected.agentTiers).length > 0;
      return {
        configured: populated,
        agentTiers: populated ? projected.agentTiers : null,
      };
    }
    case "agent_efforts":
      return {
        configured: Object.keys(projected.agentEfforts).length > 0,
        agentEfforts: projected.agentEfforts,
      };
  }
}
