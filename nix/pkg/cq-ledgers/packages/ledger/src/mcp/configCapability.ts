/**
 * config capability (T1 / T13 / R193 / G18).
 *
 * The sectioned `get_config` MCP tool surfaces a repo's resolved cq.toml
 * configuration. Like `read_log` (./readLog.ts), the
 * config parsing is a capability the OUTER package supplies: `@cq/ledger` core
 * stays config-agnostic and must NOT import `@cq/config` — the loadConfig /
 * resolveReviewers / resolvePlanners calls live only in the `@cq/ledger-mcp`
 * implementation, constructed there (T2) and injected here.
 *
 * The result types below are STRUCTURAL (e.g. `harness: string`) so core need
 * not know `@cq/config`'s `Harness` union.
 */

/**
 * A single resolved reviewer, as returned by the `reviewers` section: the parsed
 * harness + model PLUS the `alias` name it was declared under in `cq.toml`
 * (so the orchestrators can echo a human-meaningful label).
 */
export interface ResolvedReviewer {
  readonly harness: string;
  readonly model: string;
  /** The pi `--provider` qualifier; null for claude. */
  readonly provider: string | null;
  readonly alias: string;
  /**
   * The optional effort level from the token's trailing `:<effort>` suffix
   * (T284/T286). `null` means absent — the provider/model default applies.
   */
  readonly effort?: string | null;
}

/**
 * The `reviewers` section payload. LIST-KEYED (D144/D153): `configured` is true
 * only when a `cq.toml` exists AND declares a non-empty `reviewers` list.
 * When unconfigured the payload still carries the built-in DEFAULT_REVIEWERS
 * fallback tokens with `configured: false` — orchestrators must not invent a
 * model, and must not treat this flag as get_config's presence-only D81 sense.
 */
export interface GetReviewersResult {
  readonly configured: boolean;
  readonly reviewers: readonly ResolvedReviewer[];
}

/**
 * A single resolved planner, as returned by the `planners` section: the parsed
 * harness + model PLUS the `alias` name it was declared under in `cq.toml`
 * (so the orchestrators can echo a human-meaningful label). Mirrors
 * {@link ResolvedReviewer}.
 */
export interface ResolvedPlanner {
  readonly harness: string;
  readonly model: string;
  /** The pi `--provider` qualifier; null for claude. */
  readonly provider: string | null;
  readonly alias: string;
  /**
   * The optional effort level from the token's trailing `:<effort>` suffix
   * (T284/T286). `null` means absent — the provider/model default applies.
   */
  readonly effort?: string | null;
}

/**
 * The `planners` section payload. LIST-KEYED (D144/D153): `configured` is true
 * only when a `cq.toml` exists AND declares a non-empty `planners` list. When
 * unconfigured the payload still carries DEFAULT_PLANNERS with
 * `configured: false`. Mirrors {@link GetReviewersResult}.
 */
export interface GetPlannersResult {
  readonly configured: boolean;
  readonly planners: readonly ResolvedPlanner[];
}

/**
 * The `all` section payload: the full parsed config (or `configured:false`).
 *
 * `configured` means 'a parseable cq.toml is present' (`config !== null`) —
 * D81. It is INDEPENDENT of whether `reviewers`/`planners`/`tiers` are
 * populated: a cq.toml with a valid `[tiers]`/`[aliases]` table but an empty
 * `reviewers`/`planners` list still yields `configured: true`. This differs
 * from {@link GetReviewersResult.configured} / {@link GetPlannersResult.configured},
 * which stay list-keyed (true only when their own resolved list is non-empty).
 */
export interface GetConfigResult {
  readonly configured: boolean;
  readonly aliases: Record<
    string,
    {
      harness: string;
      model: string;
      provider: string | null;
      /** Optional effort level; null/absent means no override. */
      effort?: string | null;
    }
  >;
  readonly reviewers: readonly string[];
  readonly planners: readonly string[];
  /**
   * The `[tiers]` table: maps fast/standard/frontier to a resolved
   * provider+model, or null if `[tiers]` is absent from cq.toml.
   */
  readonly tiers: {
    readonly fast?: {
      readonly harness: string;
      readonly model: string;
      readonly provider: string | null;
      /** Optional effort level; null/absent means no override. */
      readonly effort?: string | null;
    };
    readonly standard?: {
      readonly harness: string;
      readonly model: string;
      readonly provider: string | null;
      /** Optional effort level; null/absent means no override. */
      readonly effort?: string | null;
    };
    readonly frontier?: {
      readonly harness: string;
      readonly model: string;
      readonly provider: string | null;
      /** Optional effort level; null/absent means no override. */
      readonly effort?: string | null;
    };
  } | null;
  /**
   * The `[agent_tiers]` table: maps agent-name -> tier name, or null if
   * `[agent_tiers]` is absent from cq.toml.
   */
  readonly agentTiers: Record<string, string> | null;
  /**
   * The `[agent_efforts]` table (Q254): maps agent-name -> per-agent
   * reasoning-effort override. ORTHOGONAL to `agentTiers` (the tier picks the
   * model; this overrides the resolved token's effort — override wins over
   * the tier token's `:<effort>` suffix). `{}` when `[agent_efforts]` is
   * absent from cq.toml (or no cq.toml exists).
   */
  readonly agentEfforts: Record<string, string>;
  /** Global dispatch policy, independent of the active harness. */
  readonly dispatch: { readonly forceShellout: boolean };
}

/**
 * The per-role model-resolution status, as returned by the `agent_models` section
 * (Q157+Q158). Exactly four variants:
 *
 * - `'resolved'`            — a live token (or tokens) was found for the role's
 *                             tier class in the candidate union.
 * - `'not-configured'`      — no `cq.toml` is present at all.
 * - `'no-live-token'`       — `cq.toml` is present, but the role's
 *                             `[agent_tiers]` tier has no live token of that
 *                             class in the candidate union.
 * - `'not-model-configurable'` — the role has no `agentTierKey` (orchestrator
 *                             commands), so model selection is N/A.
 *
 * This is a SERVER-SIDE status enum. It is NOT byte-identical to the web
 * client's `ModelClass`: the web's `'N/A'` / `'default'` render-labels do not
 * exist here — the server reports `status` + a nullable `modelClass`. The web
 * client owns a single `status` -> render-label mapping; that mapping, not any
 * type identity, is the source of truth for what the user sees.
 */
export type AgentModelStatus =
  "resolved" | "not-configured" | "no-live-token" | "not-model-configurable";

/**
 * One agent role's resolved model overlay, as returned by the `agent_models` section.
 * `id` is the `AgentRole.id` / `[agent_tiers]` key — the Q158 join key the web
 * client overlays onto its agent catalogue with no remapping. `modelClass` is
 * the resolved tier class, or null when no class applies (e.g.
 * `not-model-configurable` / `no-live-token`). `modelMappings` carries the
 * per-harness concrete model ids that back the resolved class.
 */
export interface AgentModelEntry {
  readonly id: string;
  readonly status: AgentModelStatus;
  readonly modelClass: "frontier" | "standard" | "fast" | null;
  readonly modelMappings: {
    readonly claude?: readonly string[];
    readonly codex?: readonly string[];
    readonly pi?: readonly string[];
  };
}

/**
 * The `agent_models` section payload: `configured` is true only when a `cq.toml`
 * is present, and `agents` is the per-role overlay keyed by `AgentRole.id`.
 */
export interface AgentModelsResult {
  readonly configured: boolean;
  readonly agents: readonly AgentModelEntry[];
}

export const CONFIG_SECTIONS = [
  "all",
  "reviewers",
  "planners",
  "agent_models",
  "aliases",
  "tiers",
  "agent_tiers",
  "agent_efforts",
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export type ConfigSectionResult =
  | GetConfigResult
  | GetReviewersResult
  | GetPlannersResult
  | AgentModelsResult
  | { readonly configured: boolean; readonly aliases: GetConfigResult["aliases"] }
  | { readonly configured: boolean; readonly tiers: GetConfigResult["tiers"] }
  | { readonly configured: boolean; readonly agentTiers: GetConfigResult["agentTiers"] }
  | { readonly configured: boolean; readonly agentEfforts: GetConfigResult["agentEfforts"] };

/**
 * The injected config capability computes section payloads against a config
 * root the OUTER package bound it
 * to. Supplied by the ledger-mcp layer (over `@cq/config`); absent for
 * config-agnostic factories (e.g. an in-memory store with no cq.toml-capable
 * root).
 */
export interface ConfigCapability {
  computeReviewers(): GetReviewersResult;
  computePlanners(): GetPlannersResult;
  computeConfig(): GetConfigResult;
  computeAgentModels(): AgentModelsResult;
  computeSection?(section: ConfigSection): ConfigSectionResult;
}

export function computeConfigSection(
  capability: ConfigCapability,
  section: ConfigSection,
): ConfigSectionResult {
  if (capability.computeSection !== undefined) {
    return capability.computeSection(section);
  }
  switch (section) {
    case "reviewers":
      return capability.computeReviewers();
    case "planners":
      return capability.computePlanners();
    case "agent_models":
      return capability.computeAgentModels();
    case "all":
      return capability.computeConfig();
    case "aliases": {
      const config = capability.computeConfig();
      return { configured: Object.keys(config.aliases).length > 0, aliases: config.aliases };
    }
    case "tiers": {
      const config = capability.computeConfig();
      return {
        configured: config.tiers !== null && Object.keys(config.tiers).length > 0,
        tiers: config.tiers,
      };
    }
    case "agent_tiers": {
      const config = capability.computeConfig();
      return {
        configured: config.agentTiers !== null && Object.keys(config.agentTiers).length > 0,
        agentTiers: config.agentTiers,
      };
    }
    case "agent_efforts": {
      const config = capability.computeConfig();
      return {
        configured: Object.keys(config.agentEfforts).length > 0,
        agentEfforts: config.agentEfforts,
      };
    }
  }
}

/**
 * Thrown when `get_config` is invoked on a
 * factory wired WITHOUT a config capability (no cq.toml-capable root). Mirrors
 * `ReadLogNotImplementedError`: the OTHER tools remain unaffected.
 */
export class ConfigNotImplementedError extends Error {
  constructor() {
    super(
      "get_config is not implemented for this " +
        "store: no cq.toml-capable config root is available (config " +
        "capability absent)",
    );
    this.name = "ConfigNotImplementedError";
  }
}
