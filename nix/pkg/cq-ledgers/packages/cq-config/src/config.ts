/**
 * cq.toml parse / resolve / load logic (T170, T237, T286).
 *
 * Pure module: validates at the boundary and fails fast with precise errors.
 * No transport/MCP concerns — that lands in the next task (T171).
 *
 * Token grammar (T237 BREAKING change + T286 effort suffix):
 *  - pi tokens MUST be `pi:<provider>/<model>[:<effort>]`
 *    E.g. `pi:ollama-cloud/minimax-m3`, `pi:grok-build/grok-build:xhigh`
 *    Legal pi efforts: off | minimal | low | medium | high | xhigh
 *    `:` is RESERVED in the model name (collides with the `--model` shorthand, R342).
 *  - claude tokens MUST be `claude:<model>[:<effort>]`
 *    E.g. `claude:opus-4.8[1m]`, `claude:opus-4.8[1m]:high`
 *    Legal claude efforts: low | medium | high | xhigh | max
 *    `:` is RESERVED in the model name (T286).
 * Bare pi tokens, provider qualifiers on claude tokens, and invalid effort
 * suffixes are rejected as CqConfigErrors. See parseReviewerToken for the full
 * grammar and fail-fast effort validation (T286).
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseToml, type RawWebui, type RawProject } from "./toml.js";
import {
  DEFAULT_HARNESS,
  resolveActiveHarnessFromProcess,
} from "./activeHarness.js";
import {
  isHarness,
  isEffort,
  isTier,
  isLedgerBackend,
  isLedgerBackupMode,
  DEFAULT_TIER,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
  type CqConfig,
  type Effort,
  type Harness,
  type LedgerConfig,
  type ProjectConfig,
  type ReviewerToken,
  type Tier,
  type TierEntry,
  type TiersConfig,
  type WebuiConfig,
} from "./types.js";

/** The cq.toml filename, resolved relative to a repo root. */
export const CQ_CONFIG_FILENAME = "cq.toml";

/** The lowest / highest valid TCP port number. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Thrown when cq.toml is structurally valid TOML but violates the schema. */
export class CqConfigError extends Error {
  constructor(message: string) {
    super(`cq.toml: ${message}`);
    this.name = "CqConfigError";
  }
}

/**
 * Parse a reviewer token string into a typed ReviewerToken.
 *
 * Token grammar (T237 BREAKING change + T286 effort suffix):
 *  - pi tokens MUST be `pi:<provider>/<model>` where:
 *    - The FIRST `:` separates the harness from the model segment.
 *    - The FIRST `/` in the residual model separates provider from model.
 *    - Both provider and model must be non-empty.
 *    - A bare pi token (missing `/`) is rejected as a CqConfigError (BREAKING).
 *  - claude tokens MUST be `claude:<model>` where:
 *    - The FIRST `:` separates the harness from the model.
 *    - No `/` is permitted in the model (provider qualifiers are pi-only).
 *    - A `/` in the model is rejected as a CqConfigError.
 *
 * EFFORT SUFFIX (T286, Q160): an OPTIONAL trailing `:<effort>` may follow the
 * full token. After the harness is split off the FIRST `:`, the LAST `:` in
 * the remainder delimits a candidate suffix; that suffix is treated as the
 * effort ONLY IF {@link isEffort}(harness, suffix) holds. Bracketed model
 * suffixes such as `[1m]` contain no `:`, so `claude:opus-4.8[1m]` parses with
 * `effort: null` and `claude:opus-4.8[1m]:high` parses with `effort: "high"`.
 * An omitted suffix yields `effort: null`.
 *
 * `:` is RESERVED inside a model name. After stripping a valid effort suffix,
 * a residual `:` in the model is a CqConfigError — on BOTH halves: the claude
 * model and the pi MODEL half (the part after `/`) — because a colon there
 * would collide with the `--model provider/model:effort` shorthand the pi
 * extension emits (review R342).
 *
 * FAIL FAST: a trailing-`:` suffix that is present but is NOT a valid effort
 * for this harness throws a precise CqConfigError naming the bad effort and the
 * harness's legal set (it is not silently folded back into the model).
 *
 * Throws a `CqConfigError` if the harness is unknown, the token format is
 * invalid, any required segment is empty, an effort suffix is invalid, or a
 * reserved `:` survives in the residual model.
 */
export function parseReviewerToken(token: string): ReviewerToken {
  const sep = token.indexOf(":");
  if (sep < 0) {
    throw new CqConfigError(
      `token "${token}" is not "<harness>:<model>" (missing ':')`,
    );
  }
  const harness = token.slice(0, sep);
  const remainder = token.slice(sep + 1);
  if (harness === "") {
    throw new CqConfigError(`token "${token}" has an empty harness`);
  }
  if (remainder === "") {
    throw new CqConfigError(`token "${token}" has an empty model`);
  }
  if (!isHarness(harness)) {
    throw new CqConfigError(
      `unknown harness "${harness}" in token "${token}" (expected "claude" or "pi")`,
    );
  }

  // Split a candidate effort suffix off the LAST `:` of the harness-stripped
  // remainder. Recognised as effort ONLY when isEffort(harness, suffix);
  // otherwise the `:` is treated as a reserved colon in the residual model
  // (rejected below) — never silently absorbed.
  let modelSegment = remainder;
  let effort: Effort | null = null;
  const lastColon = remainder.lastIndexOf(":");
  if (lastColon >= 0) {
    const candidate = remainder.slice(lastColon + 1);
    if (isEffort(harness, candidate)) {
      effort = candidate;
      modelSegment = remainder.slice(0, lastColon);
    } else {
      throw new CqConfigError(
        `token "${token}" has an invalid effort suffix "${candidate}" for harness "${harness}" (legal: ${legalEfforts(harness)})`,
      );
    }
  }

  const slash = modelSegment.indexOf("/");

  if (harness === "pi") {
    if (slash < 0) {
      throw new CqConfigError(
        `pi token "${token}" must be "pi:<provider>/<model>" (missing provider qualifier '/'; bare pi tokens are no longer accepted)`,
      );
    }
    const provider = modelSegment.slice(0, slash);
    const model = modelSegment.slice(slash + 1);
    if (provider === "") {
      throw new CqConfigError(
        `pi token "${token}" has an empty provider (before '/')`,
      );
    }
    if (model === "") {
      throw new CqConfigError(
        `pi token "${token}" has an empty model (after '/')`,
      );
    }
    // R342: `:` is reserved inside the pi model half (collides with the
    // `--model provider/model:effort` shorthand the extension emits).
    if (model.includes(":")) {
      throw new CqConfigError(
        `pi token "${token}" has a reserved ':' in its model "${model}" that is not a valid effort (legal effort: ${legalEfforts(harness)})`,
      );
    }
    return { harness, model, provider, effort };
  }

  // harness === "claude": provider qualifiers are pi-only.
  if (slash >= 0) {
    throw new CqConfigError(
      `claude token "${token}" must not contain a provider qualifier '/' (provider qualifiers are pi-only)`,
    );
  }
  // `:` is reserved inside the claude model after stripping a valid effort.
  if (modelSegment.includes(":")) {
    throw new CqConfigError(
      `claude token "${token}" has a reserved ':' in its model "${modelSegment}" that is not a valid effort (legal effort: ${legalEfforts(harness)})`,
    );
  }
  return { harness, model: modelSegment, provider: null, effort };
}

/** The legal effort set for a harness, rendered for error messages. */
function legalEfforts(harness: ReviewerToken["harness"]): string {
  return (harness === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS).join(" | ");
}

/** The default git branch for the git-object ledger backend. */
const DEFAULT_LEDGER_BRANCH = "cq-ledger";

/** The default git remote for the git-object ledger backend. */
const DEFAULT_LEDGER_REMOTE = "origin";

/** The default ledger backup mode (Q244 — OFF by default). */
const DEFAULT_LEDGER_BACKUP: LedgerConfig["backup"] = "none";

/**
 * Type-check the raw `[ledger]` table at the boundary.
 *
 * `backend` (if present) must be a string equal to a known {@link LedgerBackend}
 * ('fs', 'git-object', 'xdg', or 'postgres'); any other value is rejected as a
 * `CqConfigError`. `branch` and `remote` (if present) must be non-empty
 * strings. `backup` (if present) must be a known backup mode
 * ('none' | 'in-tree' | 'orphan-branch'); `projectId` (if present) must be a
 * string. `url` (if present) must be a string (G81, Q272/Q278 hybrid — a
 * committed credential-less DSN; the env-wins resolver is T571). Absent
 * `backend` defaults to 'xdg' (K117 — the out-of-tree runtime primary; the
 * old 'fs' default had not been a selectable primary since T505), with
 * `backendExplicit` recording whether the key was present so callers can
 * distinguish a deliberate choice from the default. Absent `branch` defaults
 * to 'cq-ledger'; absent `remote` defaults to 'origin'; absent `backup`
 * defaults to 'none' (Q244); absent `projectId` is `null`; absent `url` is
 * `null`.
 */
function parseLedger(raw: import("./toml.js").RawLedger): LedgerConfig {
  let backend: LedgerConfig["backend"] = "xdg";
  const backendExplicit = raw.backend !== undefined;
  if (raw.backend !== undefined) {
    if (typeof raw.backend !== "string") {
      throw new CqConfigError("[ledger] backend must be a string");
    }
    if (!isLedgerBackend(raw.backend)) {
      throw new CqConfigError(
        `[ledger] backend "${raw.backend}" is not a valid backend (expected fs, git-object, xdg, or postgres)`,
      );
    }
    backend = raw.backend;
  }

  let branch = DEFAULT_LEDGER_BRANCH;
  if (raw.branch !== undefined) {
    if (typeof raw.branch !== "string") {
      throw new CqConfigError("[ledger] branch must be a string");
    }
    branch = raw.branch;
  }

  let remote = DEFAULT_LEDGER_REMOTE;
  if (raw.remote !== undefined) {
    if (typeof raw.remote !== "string") {
      throw new CqConfigError("[ledger] remote must be a string");
    }
    remote = raw.remote;
  }

  let backup = DEFAULT_LEDGER_BACKUP;
  if (raw.backup !== undefined) {
    if (typeof raw.backup !== "string") {
      throw new CqConfigError("[ledger] backup must be a string");
    }
    if (!isLedgerBackupMode(raw.backup)) {
      throw new CqConfigError(
        `[ledger] backup "${raw.backup}" is not a valid backup mode (expected none, in-tree, or orphan-branch)`,
      );
    }
    backup = raw.backup;
  }

  let projectId: string | null = null;
  if (raw.projectId !== undefined) {
    if (typeof raw.projectId !== "string") {
      throw new CqConfigError("[ledger] projectId must be a string");
    }
    projectId = raw.projectId;
  }

  let url: string | null = null;
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string") {
      throw new CqConfigError("[ledger] url must be a string");
    }
    url = raw.url;
  }

  return { backend, backendExplicit, branch, remote, backup, projectId, url };
}

/**
 * Type-check the raw `[project]` table at the boundary (T570).
 *
 * `name` (if present) must be a string; absent `name` is `null`.
 */
function parseProject(raw: RawProject): ProjectConfig {
  let name: string | null = null;
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") {
      throw new CqConfigError("[project] name must be a string");
    }
    name = raw.name;
  }

  return { name };
}

/**
 * Parse a cq.toml document string into a typed CqConfig for one ACTIVE harness.
 *
 * LAYERED MERGE (Q239/Q240). The document has two layers:
 *  - SHARED DEFAULTS — the top-level keys (`reviewers`, `planners`, `[tiers]`,
 *    plus `[aliases]`/`[webui]`/`[ledger]`/`[agent_tiers]`).
 *  - PER-HARNESS OVERRIDES — each `[harness.<name>]` block (parsed into
 *    `RawToml.harnessOverrides`) may carry `reviewers` / `planners` /
 *    `[harness.<name>.tiers]` for ONE harness.
 *
 * PRECEDENCE (override-vs-shared): the SHARED top-level value is the default;
 * if the ACTIVE harness has an override block, its present sections REPLACE the
 * shared value wholesale (override semantics, NOT a deep append/merge): a
 * section PRESENT in the override (even an empty array/table) wins; a section
 * ABSENT from the override (`null`) falls through to the shared top-level value.
 * Only `reviewers` / `planners` / `tiers` are overridable; `[aliases]`,
 * `[webui]`, `[ledger]`, `[agent_tiers]`, and `[agent_efforts]` are
 * SHARED-only and NEVER overridden. `[harness.<name>.tiers]` is parsed into the same `TiersConfig`
 * shape as the shared `[tiers]` (via {@link parseTiers}, resolving keys through
 * the SHARED `[aliases]`).
 *
 * `activeHarness` defaults to {@link DEFAULT_HARNESS}, so an omitted argument
 * reproduces the pre-override behaviour exactly. A flat cq.toml with no
 * `[harness.*]` table parses identically under any harness.
 *
 * Throws on malformed TOML (via the parser), an unknown harness in an alias
 * token, or a non-array `reviewers`.
 */
export function parseConfig(
  source: string,
  activeHarness: Harness = DEFAULT_HARNESS,
): CqConfig {
  const raw = parseToml(source);

  const aliases: Record<string, ReviewerToken> = {};
  for (const [name, token] of Object.entries(raw.aliases)) {
    aliases[name] = parseReviewerToken(token);
  }

  // SHARED top-level defaults.
  let reviewers = raw.reviewers ?? [];
  let planners = raw.planners ?? [];
  let tiers = raw.tiers === null ? null : parseTiers(raw.tiers, aliases);

  // PER-HARNESS override layer (Q240): the active harness's block REPLACES the
  // shared reviewers/planners/tiers for any section it carries; an absent
  // section (null) falls through to the shared value above. `[aliases]` is
  // shared-only, so per-harness tiers still resolve keys via the shared aliases.
  const override = raw.harnessOverrides?.[activeHarness];
  if (override !== undefined) {
    if (override.reviewers !== null) {
      reviewers = override.reviewers;
    }
    if (override.planners !== null) {
      planners = override.planners;
    }
    if (override.tiers !== null) {
      tiers = parseTiers(override.tiers, aliases);
    }
  }

  const webui = raw.webui === null ? null : parseWebui(raw.webui);
  const agentTiers =
    raw.agentTiers === null ? null : parseAgentTiers(raw.agentTiers);
  const agentEfforts =
    raw.agentEfforts === null ? {} : parseAgentEfforts(raw.agentEfforts);
  const ledger = raw.ledger === null ? null : parseLedger(raw.ledger);
  const project = raw.project === null ? null : parseProject(raw.project);
  return {
    aliases,
    reviewers,
    planners,
    webui,
    tiers,
    agentTiers,
    agentEfforts,
    ledger,
    project,
  };
}

/**
 * Parse the `[tiers]` table — a per-harness `tier -> model` map (rewritten from
 * the old token-keyed classifier).
 *
 * Each `[tiers]` entry is `KEY = VALUE` where:
 *  - the KEY is a tier CLASS name (`fast` | `standard` | `frontier`), validated
 *    by `isTier`. TOML keys are unique, so a tier names AT MOST ONE model.
 *  - the VALUE is either an alias name from `[aliases]` (resolved to its token)
 *    or a bare `<harness>:<model>` token parsed via `parseReviewerToken`. A
 *    malformed value that is neither surfaces `parseReviewerToken`'s error.
 *
 * A single model MAY serve several tiers (e.g. `frontier = "opus"` AND
 * `standard = "opus"`): tiers map to models, not the reverse, so there is NO
 * uniqueness constraint on the VALUE. Duplicate tier KEYS are rejected upstream
 * by the TOML parser.
 *
 * The resulting `entries` array records, per tier, the parsed
 * {@link ReviewerToken}, the raw VALUE string, and the tier class — one entry
 * per configured tier.
 */
function parseTiers(
  raw: Record<string, string>,
  aliases: Record<string, ReviewerToken>,
): TiersConfig {
  const entries: TierEntry[] = [];

  for (const [key, value] of Object.entries(raw)) {
    // Validate the KEY as a tier class name.
    if (!isTier(key)) {
      throw new CqConfigError(
        `tiers key "${key}" is not a valid tier (expected fast, standard, or frontier)`,
      );
    }
    // Resolve the VALUE to a token: an alias name from [aliases], else a bare
    // "<harness>:<model>" token. A malformed/unknown value surfaces
    // parseReviewerToken's precise error.
    const token =
      aliases[value] !== undefined ? aliases[value]! : parseReviewerToken(value);
    entries.push({ token, raw: value, class: key });
  }

  return { entries };
}

/**
 * Parse the `[agent_tiers]` raw string table into a `Record<string, Tier>`.
 *
 * Every value must be a known tier name (fast/standard/frontier).
 */
function parseAgentTiers(raw: Record<string, string>): Record<string, Tier> {
  const result: Record<string, Tier> = {};
  for (const [agentName, tierName] of Object.entries(raw)) {
    if (!isTier(tierName)) {
      throw new CqConfigError(
        `agent_tiers["${agentName}"] = "${tierName}" is not a valid tier (expected fast, standard, or frontier)`,
      );
    }
    result[agentName] = tierName;
  }
  return result;
}

/**
 * Parse the `[agent_efforts]` raw string table into a `Record<string, Effort>`
 * (Q254).
 *
 * Every value must be a member of the OVERALL effort vocabulary (the union of
 * the pi and claude effort sets) — the agent's harness is unknown at parse
 * time, so harness-specific validity is deferred to resolution time
 * ({@link applyAgentEffort} via `isEffort`). A value outside the union fails
 * fast here with a precise CqConfigError.
 */
function parseAgentEfforts(raw: Record<string, string>): Record<string, Effort> {
  const result: Record<string, Effort> = {};
  for (const [agentName, effortName] of Object.entries(raw)) {
    // PI_EFFORTS is a superset of CLAUDE_EFFORTS, but check the union
    // explicitly so the vocabularies may diverge without silent breakage.
    if (!isEffort("pi", effortName) && !isEffort("claude", effortName)) {
      throw new CqConfigError(
        `agent_efforts["${agentName}"] = "${effortName}" is not a valid effort (expected ${PI_EFFORTS.join(" | ")})`,
      );
    }
    result[agentName] = effortName;
  }
  return result;
}

/**
 * Type-check + range-check the raw `[webui]` table at the boundary.
 *
 * `host` (if present) must be a string; `port` (if present) must be an
 * INTEGER in 1..65535. Throws a precise `CqConfigError` otherwise.
 */
function parseWebui(raw: RawWebui): WebuiConfig {
  let host: string | null = null;
  if (raw.host !== undefined) {
    if (typeof raw.host !== "string") {
      throw new CqConfigError("[webui] host must be a string");
    }
    host = raw.host;
  }

  let port: number | null = null;
  if (raw.port !== undefined) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port)) {
      throw new CqConfigError("[webui] port must be an integer");
    }
    if (raw.port < MIN_PORT || raw.port > MAX_PORT) {
      throw new CqConfigError(
        `[webui] port must be in ${MIN_PORT}..${MAX_PORT}, got ${raw.port}`,
      );
    }
    port = raw.port;
  }

  return { host, port };
}

/**
 * Resolve each `reviewers` alias name through `[aliases]` into a
 * ReviewerToken. Throws a precise `CqConfigError` on a dangling alias.
 */
export function resolveReviewers(config: CqConfig): ReviewerToken[] {
  return config.reviewers.map((alias) => {
    const token = config.aliases[alias];
    if (token === undefined) {
      throw new CqConfigError(
        `reviewers references undefined alias "${alias}" (not declared in [aliases])`,
      );
    }
    return token;
  });
}

/**
 * Resolve each `planners` alias name through `[aliases]` into a
 * ReviewerToken. Throws a precise `CqConfigError` on a dangling alias.
 */
export function resolvePlanners(config: CqConfig): ReviewerToken[] {
  return config.planners.map((alias) => {
    const token = config.aliases[alias];
    if (token === undefined) {
      throw new CqConfigError(
        `planners references undefined alias "${alias}" (not declared in [aliases])`,
      );
    }
    return token;
  });
}

/**
 * Resolve a named agent to its tier, using `[agent_tiers]` if present and
 * the agent is listed; falls back to `DEFAULT_TIER` otherwise.
 */
export function resolveAgentTier(config: CqConfig, agentName: string): Tier {
  if (config.agentTiers !== null) {
    const tier = config.agentTiers[agentName];
    if (tier !== undefined) {
      return tier;
    }
  }
  return DEFAULT_TIER;
}

/**
 * Structural equality for two {@link ReviewerToken}s.
 *
 * Two tokens are equal iff their `harness`, `model`, `provider`, AND `effort`
 * all match (no normalization beyond the parse already performed by
 * `parseReviewerToken` — the model string is compared verbatim, including any
 * bracketed suffix such as `[1m]`). `effort` PARTICIPATES in identity (Q162):
 * `claude:opus-4.8[1m]:high` and `claude:opus-4.8[1m]:low` are DISTINCT tokens.
 * An omitted suffix (`undefined`) and an explicit `null` are the SAME
 * equivalence class — a token parsed without a suffix carries `effort: null`,
 * and two such tokens compare equal regardless of which absent form they hold.
 *
 * Structural token equality (effort-suffix aware) — used to compare model
 * tokens regardless of which absent-effort form they carry.
 */
export function reviewerTokensEqual(
  a: ReviewerToken,
  b: ReviewerToken,
): boolean {
  return (
    a.harness === b.harness &&
    a.model === b.model &&
    a.provider === b.provider &&
    // Normalize the two "absent effort" forms (undefined vs null) to a single
    // equivalence class before comparing, so an omitted suffix never differs
    // from an explicit null.
    (a.effort ?? null) === (b.effort ?? null)
  );
}

/**
 * Look up the single model configured for `tier` in the `[tiers]` map.
 *
 * `[tiers]` maps each tier to at most one model, so this is a direct lookup:
 * the entry whose class equals `tier`, or `undefined` when `[tiers]` is absent
 * or does not name that tier. (A model may serve several tiers, but a tier
 * names one model — TOML key uniqueness guarantees it.)
 */
export function tierModel(
  config: CqConfig,
  tier: Tier,
): ReviewerToken | undefined {
  return config.tiers?.entries.find((e) => e.class === tier)?.token;
}

/**
 * Apply the `[agent_efforts]` per-agent effort override to a resolved token
 * (Q254).
 *
 * ORTHOGONAL to `[agent_tiers]`: the tier axis picks the MODEL; this axis
 * overrides the resolved token's EFFORT. Semantics:
 *  - `[agent_efforts]` has an entry for `agentName` -> the returned token's
 *    `effort` IS that override (override wins over the tier token's
 *    `:<effort>` suffix, including when the suffix is absent);
 *  - no entry -> `token` is returned unchanged (tier token effort applies).
 *
 * FAIL FAST: the override is validated against the RESOLVED token's harness
 * via {@link isEffort} — an effort outside that harness's vocabulary (e.g.
 * `"off"` for a claude-resolved agent) throws a precise CqConfigError naming
 * the agent, the bad effort, and the harness's legal set.
 */
export function applyAgentEffort(
  config: CqConfig,
  agentName: string,
  token: ReviewerToken,
): ReviewerToken {
  const override = config.agentEfforts[agentName];
  if (override === undefined) {
    return token;
  }
  if (!isEffort(token.harness, override)) {
    throw new CqConfigError(
      `agent_efforts["${agentName}"] = "${override}" is not a valid effort for harness "${token.harness}" (legal: ${legalEfforts(token.harness)})`,
    );
  }
  return { ...token, effort: override };
}

/**
 * Resolve a named agent end-to-end to the token it should run at.
 *
 * Pipeline: agent-name -> {@link resolveAgentTier} (via `[agent_tiers]`,
 * falling back to `DEFAULT_TIER`) -> {@link tierModel} (the one model the
 * `[tiers]` map assigns to that tier) -> {@link applyAgentEffort} (the
 * `[agent_efforts]` per-agent effort override, Q254). No candidate pool, no
 * tie-break — `[tiers]` names the model directly, so `[aliases]` order is
 * irrelevant.
 *
 * Throws a precise `CqConfigError` when `[tiers]` does not configure the
 * agent's tier (including the case where `[tiers]` is absent), or when the
 * agent's `[agent_efforts]` override is invalid for the resolved harness.
 */
export function resolveAgentModel(
  config: CqConfig,
  agentName: string,
): ReviewerToken {
  const tier = resolveAgentTier(config, agentName);
  const token = tierModel(config, tier);
  if (token === undefined) {
    throw new CqConfigError(
      `cannot resolve a model for agent "${agentName}": [tiers] configures no model for tier "${tier}"`,
    );
  }
  return applyAgentEffort(config, agentName, token);
}

/**
 * Render a {@link ReviewerToken} back to its canonical string grammar.
 *
 * Grammar: `<harness>:<model>[:<effort>]` for claude tokens and
 * `<harness>:<provider>/<model>[:<effort>]` for pi tokens.
 *
 * The effort suffix is appended ONLY when `token.effort` is a non-null,
 * non-undefined string, making `formatReviewerToken(parseReviewerToken(s)) === s`
 * hold for all valid token strings (Q160 round-trip safety).
 *
 * When `effort` is null or undefined, the output is byte-identical to the
 * pre-T288 format — no trailing `:<effort>` is emitted.
 */
export function formatReviewerToken(token: ReviewerToken): string {
  const base =
    token.provider == null
      ? `${token.harness}:${token.model}`
      : `${token.harness}:${token.provider}/${token.model}`;
  return token.effort != null ? `${base}:${token.effort}` : base;
}

/**
 * Load cq.toml from `repoRoot` for the ACTIVE harness.
 *
 * Returns `null` when no cq.toml exists (feature OFF => caller falls back to
 * a single native Claude reviewer). Otherwise parses with the active harness's
 * layered override (see {@link parseConfig}), validates, and eagerly resolves
 * the reviewers/planners lists — so a dangling alias in the ALREADY-MERGED
 * active-harness panels throws at load time, not later.
 *
 * `harness` defaults to {@link resolveActiveHarnessFromProcess}, so the active
 * harness is read from `process.env` (Q238) unless the caller injects one.
 */
export function loadConfig(
  repoRoot: string,
  harness: Harness = resolveActiveHarnessFromProcess(),
): CqConfig | null {
  const file = path.join(repoRoot, CQ_CONFIG_FILENAME);
  if (!existsSync(file)) {
    return null;
  }
  const source = readFileSync(file, "utf8");
  const config = parseConfig(source, harness);
  // Eagerly resolve so a dangling alias is reported at load time, not later.
  resolveReviewers(config);
  resolvePlanners(config);
  return config;
}
