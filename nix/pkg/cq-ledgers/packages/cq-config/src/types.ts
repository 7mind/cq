/**
 * cq.toml data model (T170, T223, T237, T284).
 *
 * Pure, typed domain types — no transport/MCP concerns. A `ReviewerToken`
 * names a reviewer harness + model; a `CqConfig` is the fully-parsed (but
 * not yet alias-resolved) configuration: the `[aliases]` table plus the
 * top-level `reviewers` list of alias names.
 *
 * Token grammar (BREAKING in T237):
 *  - pi tokens: `pi:<provider>/<model>` (e.g. pi:ollama-cloud/minimax-m3)
 *  - claude tokens: `claude:<model>` (e.g. claude:opus-4.8[1m])
 * Bare pi tokens (no provider) and provider qualifiers on claude tokens
 * are CONFIG ERRORs.
 *
 * Token grammar with effort (T284):
 *  - Trailing `:<effort>` suffix, e.g. `claude:opus-4.8[1m]:high`
 *  - pi efforts: off | none | minimal | low | medium | high | xhigh | max
 *  - claude efforts: low | medium | high | xhigh | max
 *  Parsing of the effort suffix is deferred to T286.
 */

/** The two reviewer harnesses cq knows how to drive. */
export const HARNESSES = ["claude", "pi"] as const;

/** A reviewer harness identifier (the part before the `:` in a token). */
export type Harness = (typeof HARNESSES)[number];

/**
 * Effort levels for the `pi` harness (thinking budget).
 * These are the closed vocabulary of pi effort strings (T284), spanning the
 * union of what pi's providers accept. `none` and `max` cover the GPT-5.6
 * reasoning-effort range (`none | low | medium | high | xhigh | max`); `off`
 * and `minimal` remain for providers that use those spellings. Ordered by
 * increasing thinking budget.
 */
export const PI_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** A pi effort level (the trailing `:<effort>` suffix for pi tokens). */
export type PiEffort = (typeof PI_EFFORTS)[number];

/**
 * Effort levels for the `claude` harness.
 * `ultracode` is a session-only Claude Code setting, not an effort level —
 * excluded from this vocabulary (T284).
 */
export const CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** A Claude effort level (the trailing `:<effort>` suffix for claude tokens). */
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** The union of all recognised effort strings across harnesses. */
export type Effort = PiEffort | ClaudeEffort;

/**
 * Type guard: is `value` a valid effort string for the given `harness`?
 *
 * - pi accepts: off | none | minimal | low | medium | high | xhigh | max
 * - claude accepts: low | medium | high | xhigh | max
 */
export function isEffort(harness: Harness, value: string): value is Effort {
  if (harness === "pi") {
    return (PI_EFFORTS as readonly string[]).includes(value);
  }
  return (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

/**
 * A reviewer token parsed from a `"<harness>:<model>[:<effort>]"` string.
 *
 * Token grammar (T237 BREAKING change):
 *  - pi tokens MUST be `pi:<provider>/<model>` where the provider is
 *    separated from model by the FIRST `/`. E.g. `"pi:ollama-cloud/minimax-m3"`
 *    parses to `{ harness: "pi", model: "minimax-m3", provider: "ollama-cloud" }`.
 *    A bare pi token (e.g. `pi:minimax`) missing the provider qualifier is a
 *    CONFIG ERROR (BREAKING).
 *  - claude tokens MUST be `claude:<model>` and never carry a provider.
 *    `provider` is always null for claude tokens, and a `/` in the model
 *    segment is a CONFIG ERROR.
 *
 * Optional trailing effort suffix (T284):
 *  - Append `:<effort>` after the full token to override the provider/model
 *    default, e.g. `claude:opus-4.8[1m]:high` or
 *    `pi:ollama-cloud/minimax-m3:xhigh`.
 *  - `null` means absent (omitted) — the harness/model default applies.
 *  - pi efforts: off | none | minimal | low | medium | high | xhigh | max
 *  - claude efforts: low | medium | high | xhigh | max
 *  Parsing of the effort suffix is deferred to T286; this field is populated
 *  as `null` at existing construction sites until T286 is implemented.
 *
 * Reference: D36 (pi provider routing).
 */
export interface ReviewerToken {
  readonly harness: Harness;
  readonly model: string;
  /** The pi `--provider` (before the first `/`); null for claude. */
  readonly provider: string | null;
  /**
   * The optional effort level for this token (the trailing `:<effort>` suffix).
   * `null` (or absent) means no override — the provider/model default applies
   * (current behaviour unchanged). Populated by T286; always `null` until then.
   */
  readonly effort?: Effort | null;
}

/**
 * The `[webui]` table: optional bind host + port for the web UI.
 *
 * - `host`: the bind address string, or null if unset (caller picks a default).
 * - `port`: the TCP port integer (1..65535), or null if unset.
 */
export interface WebuiConfig {
  readonly host: string | null;
  readonly port: number | null;
}

/** Type guard: is `value` a known harness? */
export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

/** The three suggestedModel tiers cq dispatches at. */
export const TIERS = ["fast", "standard", "frontier"] as const;

/** A tier name (the part before `->` in an agent_tiers mapping). */
export type Tier = (typeof TIERS)[number];

/** Type guard: is `value` a known tier? */
export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * The default tier for agents that have no entry in `[agent_tiers]`.
 * Documented here so callers can reproduce the same fallback.
 */
export const DEFAULT_TIER: Tier = "standard";

/**
 * One entry of the `[tiers]` map: a {@link Tier} class and the ONE model it
 * dispatches, as both the parsed token and the raw grammar string it came from.
 */
export interface TierEntry {
  /** The parsed model token (harness + model + provider). */
  readonly token: ReviewerToken;
  /**
   * The raw VALUE string this tier was assigned — an alias name or a
   * `parseReviewerToken` grammar string, e.g. `"opus"` or `"claude:opus-4.8[1m]"`.
   */
  readonly raw: string;
  /** The tier class this entry configures. */
  readonly class: Tier;
}

/**
 * The `[tiers]` table: a `tier -> one model` DISPATCH MAP.
 *
 * Each `[tiers]` entry keys a {@link Tier} class (`fast` | `standard` |
 * `frontier`) to a model, given as an alias name or a `parseReviewerToken`
 * grammar string. TOML keys are unique, so a tier names exactly ONE model; a
 * single model MAY serve several tiers (e.g. `frontier` and `standard` both
 * `"opus"`).
 *
 * `entries` holds one {@link TierEntry} per configured tier — the parsed model
 * {@link ReviewerToken}, the raw VALUE string, and the tier class — so an
 * agent's tier resolves directly to its model (tier -> model).
 */
export interface TiersConfig {
  readonly entries: ReadonlyArray<TierEntry>;
}

/**
 * The supported ledger storage backends (T349, T494, T570).
 *
 * - `fs` / `git-object`: the LEGACY in-tree backends. They remain PARSEABLE
 *   (never removed from this union) so `cq migrate` can read a `cq.toml`
 *   that still names one to locate the source data — but after the T505
 *   cutover neither selects a runtime primary store.
 * - `xdg`: the out-of-tree bun:sqlite primary at the XDG location (K102) —
 *   the DEFAULT runtime primary.
 * - `postgres`: an OPT-IN external Postgres primary (G81). Config-surface
 *   only here — see `url` below; the store-side wiring lands in T577.
 */
export const LEDGER_BACKENDS = ["fs", "git-object", "xdg", "postgres"] as const;

/** A ledger backend identifier. */
export type LedgerBackend = (typeof LEDGER_BACKENDS)[number];

/** Type guard: is `value` a known ledger backend? */
export function isLedgerBackend(value: string): value is LedgerBackend {
  return (LEDGER_BACKENDS as readonly string[]).includes(value);
}

/** The supported ledger backup modes (Q244, T494). */
export const LEDGER_BACKUP_MODES = ["none", "in-tree", "orphan-branch"] as const;

/** A ledger backup mode identifier. */
export type LedgerBackupMode = (typeof LEDGER_BACKUP_MODES)[number];

/** Type guard: is `value` a known ledger backup mode? */
export function isLedgerBackupMode(value: string): value is LedgerBackupMode {
  return (LEDGER_BACKUP_MODES as readonly string[]).includes(value);
}

/**
 * The `[ledger]` table: storage backend configuration (T349, T494).
 *
 * - `backend`: the storage backend to use; 'xdg' — the out-of-tree bun:sqlite
 *   primary (K102) — is the default (K117). 'fs' and 'git-object' are the
 *   LEGACY in-repo backends: still selectable explicitly, but construction
 *   emits a deprecation warning pointing at `cq migrate`. 'postgres' is the
 *   opt-in multi-tenant backend (G81).
 * - `backendExplicit`: whether cq.toml carried an explicit `backend` key
 *   (K117) — lets callers distinguish a deliberate backend choice from the
 *   'xdg' default (the legacy-shadow warning and `cq migrate`'s source
 *   detection key off this).
 * - `branch`: the git branch for the git-object backend (default 'cq-ledger').
 * - `remote`: the git remote for the git-object backend (default 'origin').
 * - `backup`: the mandatory human-readable markdown export/backup mode;
 *   defaults to 'none' (OFF by default, Q244).
 * - `projectId`: an optional committed project-identity string, used for
 *   repo-identity keying (Q246) — e.g. to locate the right out-of-tree store
 *   when the repo is cloned to multiple paths. `null` when absent.
 * - `url`: an optional committed connection string for the `postgres` backend
 *   (G81, Q272/Q278 hybrid). MUST be credential-less (no embedded password) —
 *   `null` when absent. A `CQ_LEDGER_PG_URL` / `DATABASE_URL` environment
 *   variable takes precedence over this value at resolution time (the
 *   resolver itself is T571, not this config layer). `null` when absent.
 *
 * `branch` and `remote` are consumed by the git-object backend (W5/T355);
 * they are parsed and stored for any backend, but only meaningful for
 * 'git-object'. `url` is only meaningful for 'postgres'.
 */
export interface LedgerConfig {
  readonly backend: LedgerBackend;
  readonly backendExplicit: boolean;
  readonly branch: string;
  readonly remote: string;
  readonly backup: LedgerBackupMode;
  readonly projectId: string | null;
  readonly url: string | null;
}

/**
 * The `[project]` table: project-level metadata (Q270, T570).
 *
 * - `name`: an optional display name for the project, `null` when absent.
 */
export interface ProjectConfig {
  readonly name: string | null;
}

/**
 * The parsed cq.toml configuration (T170, T223, T349).
 *
 * - `aliases`: the `[aliases]` table, each value parsed into a ReviewerToken.
 * - `reviewers`: the top-level `reviewers = [...]` list of ALIAS names
 *   (not yet resolved — see `resolveReviewers`).
 * - `planners`: the top-level `planners = [...]` list of ALIAS names
 *   (not yet resolved — see `resolvePlanners`).
 * - `webui`: the `[webui]` table (host + port), or null if absent.
 * - `tiers`: the `[tiers]` DISPATCH MAP — each tier (fast/standard/frontier) ->
 *   the one model it runs (an alias name or token); or null if `[tiers]` is
 *   absent. See {@link TiersConfig}.
 * - `agentTiers`: the `[agent_tiers]` table mapping agent-name -> tier name,
 *   or null if `[agent_tiers]` is absent. An unlisted agent falls back to
 *   `DEFAULT_TIER`.
 * - `agentEfforts`: the `[agent_efforts]` table mapping agent-name -> effort
 *   override (Q254); `{}` when `[agent_efforts]` is absent. ORTHOGONAL to
 *   `agentTiers`: the tier picks the MODEL, this overrides the resolved
 *   token's EFFORT (override wins; an unlisted agent keeps the tier token's
 *   effort). Values are validated at parse time against the union of all
 *   harness effort vocabularies; harness-specific validity (`isEffort`) is
 *   checked at resolution time, once the agent's harness is known.
 * - `ledger`: the `[ledger]` table (backend + branch + remote + backup +
 *   projectId + url), or null if absent. When null, `backend` defaults to
 *   'xdg' (K117) and `backup` defaults to 'none'.
 * - `project`: the `[project]` table (name), or null if absent (T570).
 */
export interface CqConfig {
  readonly aliases: Record<string, ReviewerToken>;
  readonly reviewers: readonly string[];
  readonly planners: readonly string[];
  readonly webui: WebuiConfig | null;
  /** The `[tiers]` table, or null if absent. */
  readonly tiers: TiersConfig | null;
  /** The `[agent_tiers]` table (agent-name -> tier name), or null if absent. */
  readonly agentTiers: Record<string, Tier> | null;
  /** The `[agent_efforts]` table (agent-name -> effort override); `{}` when absent. */
  readonly agentEfforts: Record<string, Effort>;
  /** The `[ledger]` table (backend + branch + remote), or null if absent. */
  readonly ledger: LedgerConfig | null;
  /** The `[project]` table (name), or null if absent. */
  readonly project: ProjectConfig | null;
}
