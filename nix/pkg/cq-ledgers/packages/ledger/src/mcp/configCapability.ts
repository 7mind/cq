/**
 * config capability (T1 / T13 / R193 / G18).
 *
 * The `get_reviewers` / `get_planners` / `get_config` MCP tools surface a repo's
 * resolved cq.toml reviewer/planner config. Like `read_log` (./readLog.ts), the
 * config parsing is a capability the OUTER package supplies: `@cq/ledger` core
 * stays config-agnostic and must NOT import `@cq/config` — the loadConfig /
 * resolveReviewers / resolvePlanners calls live only in the `@cq/ledger-mcp`
 * implementation, constructed there (T2) and injected here.
 *
 * The result types below are STRUCTURAL (e.g. `harness: string`) so core need
 * not know `@cq/config`'s `Harness` union.
 */

/**
 * A single resolved reviewer, as returned by `get_reviewers`: the parsed
 * harness + model PLUS the `alias` name it was declared under in `cq.toml`
 * (so the orchestrators can echo a human-meaningful label).
 */
export interface ResolvedReviewer {
  readonly harness: string;
  readonly model: string;
  readonly alias: string;
}

/**
 * The `get_reviewers` payload. `configured` is true only when a `cq.toml`
 * exists AND declares a non-empty `reviewers` list; otherwise the caller falls
 * back to a single native Claude reviewer.
 */
export interface GetReviewersResult {
  readonly configured: boolean;
  readonly reviewers: readonly ResolvedReviewer[];
}

/**
 * A single resolved planner, as returned by `get_planners`: the parsed
 * harness + model PLUS the `alias` name it was declared under in `cq.toml`
 * (so the orchestrators can echo a human-meaningful label). Mirrors
 * {@link ResolvedReviewer}.
 */
export interface ResolvedPlanner {
  readonly harness: string;
  readonly model: string;
  readonly alias: string;
}

/**
 * The `get_planners` payload. `configured` is true only when a `cq.toml`
 * exists AND declares a non-empty `planners` list; otherwise the caller falls
 * back to a single native Claude planner. Mirrors {@link GetReviewersResult}.
 */
export interface GetPlannersResult {
  readonly configured: boolean;
  readonly planners: readonly ResolvedPlanner[];
}

/** The `get_config` payload: the full parsed config (or `configured:false`). */
export interface GetConfigResult {
  readonly configured: boolean;
  readonly aliases: Record<string, { harness: string; model: string }>;
  readonly reviewers: readonly string[];
  readonly planners: readonly string[];
}

/**
 * The injected config capability: computes the `get_reviewers` / `get_config`
 * payloads against a config root the OUTER package bound it to. Supplied by the
 * ledger-mcp layer (over `@cq/config`); absent for config-agnostic factories
 * (e.g. an in-memory store with no cq.toml-capable root).
 */
export interface ConfigCapability {
  computeReviewers(): GetReviewersResult;
  computePlanners(): GetPlannersResult;
  computeConfig(): GetConfigResult;
}

/**
 * Thrown when `get_reviewers` / `get_planners` / `get_config` is invoked on a
 * factory wired WITHOUT a config capability (no cq.toml-capable root). Mirrors
 * `ReadLogNotImplementedError`: the OTHER tools remain unaffected.
 */
export class ConfigNotImplementedError extends Error {
  constructor() {
    super(
      "get_reviewers/get_planners/get_config is not implemented for this " +
        "store: no cq.toml-capable config root is available (config " +
        "capability absent)",
    );
    this.name = "ConfigNotImplementedError";
  }
}
