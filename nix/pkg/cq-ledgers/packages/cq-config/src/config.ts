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
import { parseToml, type RawWebui } from "./toml.js";
import {
  DEFAULT_HARNESS,
  resolveActiveHarnessFromProcess,
} from "./activeHarness.js";
import {
  isHarness,
  isEffort,
  isTier,
  isLedgerBackend,
  DEFAULT_TIER,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
  type CqConfig,
  type Effort,
  type Harness,
  type LedgerConfig,
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

/**
 * Type-check the raw `[ledger]` table at the boundary.
 *
 * `backend` (if present) must be a string equal to 'fs' or 'git-object';
 * any other value is rejected as a `CqConfigError`. `branch` and `remote`
 * (if present) must be non-empty strings. Absent `backend` defaults to 'fs';
 * absent `branch` defaults to 'cq-ledger'; absent `remote` defaults to 'origin'.
 */
function parseLedger(raw: import("./toml.js").RawLedger): LedgerConfig {
  let backend: LedgerConfig["backend"] = "fs";
  if (raw.backend !== undefined) {
    if (typeof raw.backend !== "string") {
      throw new CqConfigError("[ledger] backend must be a string");
    }
    if (!isLedgerBackend(raw.backend)) {
      throw new CqConfigError(
        `[ledger] backend "${raw.backend}" is not a valid backend (expected fs or git-object)`,
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

  return { backend, branch, remote };
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
 * `[webui]`, `[ledger]`, and `[agent_tiers]` are SHARED-only and NEVER
 * overridden. `[harness.<name>.tiers]` is parsed into the same `TiersConfig`
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
  const ledger = raw.ledger === null ? null : parseLedger(raw.ledger);
  return { aliases, reviewers, planners, webui, tiers, agentTiers, ledger };
}

/**
 * Parse the inverted, token-keyed `[tiers]` CLASSIFIER table into a
 * `TiersConfig` (Q149/Q150; rewritten in T270).
 *
 * Each `[tiers]` entry is `KEY = VALUE` where:
 *  - the KEY is a reviewer token, resolved EXACTLY as a `reviewers`/`planners`
 *    or old per-slot tier value was: if the KEY names an entry in `[aliases]`,
 *    use that alias's token; otherwise parse the KEY directly with
 *    `parseReviewerToken` (the G29 grammar: `claude:<model>` |
 *    `pi:<provider>/<model>`). An alias miss that is also a malformed token
 *    throws a precise `CqConfigError` from `parseReviewerToken`.
 *  - the VALUE is a tier CLASS name, validated by `isTier`. A value that is
 *    not `fast`/`standard`/`frontier` throws a `CqConfigError`.
 *
 * The resulting `entries` array records, per configured token, the parsed
 * {@link ReviewerToken}, the raw KEY string it was keyed by, and the assigned
 * class — so a token can be classified (token -> class) and the tokens of a
 * class can be enumerated (class -> tokens).
 */
function parseTiers(
  raw: Record<string, string>,
  aliases: Record<string, ReviewerToken>,
): TiersConfig {
  const entries: TierEntry[] = [];

  for (const [key, value] of Object.entries(raw)) {
    // Resolve the KEY to a token: if the KEY names a known alias, use it;
    // otherwise parse the KEY directly as a "<harness>:<model>" token. A
    // malformed/unknown token key surfaces parseReviewerToken's precise error.
    const token =
      aliases[key] !== undefined ? aliases[key]! : parseReviewerToken(key);
    // Validate the VALUE as a tier class name.
    if (!isTier(value)) {
      throw new CqConfigError(
        `tiers["${key}"] = "${value}" is not a valid tier class (expected fast, standard, or frontier)`,
      );
    }
    // Fail-loud on a DUPLICATE token classification (class-agnostic): a token
    // must be classified at most once. If this KEY resolves to a token
    // structurally equal to an already-recorded entry's token, the config
    // contradicts itself (e.g. a direct token key + an alias key resolving to
    // it, or two direct keys for the same token) — throw naming BOTH keys and
    // their classes rather than letting classifyToken silently first-match.
    const duplicate = entries.find((e) => reviewerTokensEqual(e.token, token));
    if (duplicate !== undefined) {
      throw new CqConfigError(
        `tiers["${key}"] = "${value}" and tiers["${duplicate.raw}"] = "${duplicate.class}" both classify the same token — a token must be classified at most once`,
      );
    }
    entries.push({ token, raw: key, class: value });
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
 * This is the comparison `classifyToken` uses to look a candidate token up in
 * the inverted `[tiers]` classifier, and the comparison `parseTiers` uses for
 * its class-agnostic duplicate-token guard (D42).
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
 * Classify a `ReviewerToken` against the inverted `[tiers]` classifier.
 *
 * Looks `token` up among `config.tiers.entries` by STRUCTURAL token equality
 * (harness + model + provider; see {@link reviewerTokensEqual}) and returns
 * the {@link Tier} class it was assigned. Returns `undefined` when `[tiers]`
 * is absent or no configured entry matches the token (i.e. the token is
 * unclassified).
 *
 * `parseTiers` rejects a config in which two `[tiers]` entries resolve to the
 * same token (class-agnostic dedup, fail-loud), so a classified token can
 * match at most one entry here — first-match is therefore unambiguous.
 */
export function classifyToken(
  config: CqConfig,
  token: ReviewerToken,
): Tier | undefined {
  if (config.tiers === null) {
    return undefined;
  }
  const entry = config.tiers.entries.find((e) =>
    reviewerTokensEqual(e.token, token),
  );
  return entry === undefined ? undefined : entry.class;
}

/**
 * Select, from a set of candidate tokens, those classified to `tier`.
 *
 * `candidates` is the active token set the caller cares about (typically the
 * resolved `planners` or `reviewers` list — see `resolvePlanners` /
 * `resolveReviewers`). Each candidate is classified via {@link classifyToken}
 * and kept iff its class equals `tier`.
 *
 * This is a PURE FILTER: the result PRESERVES the order of `candidates`. No
 * sorting, de-duplication, or reordering is applied; a candidate that appears
 * twice is returned twice. Candidates that do not classify (unclassified, or
 * classified to a different tier) are dropped. Callers that want a single token
 * (e.g. `resolveAgentModel`) do NOT rely on this order — they re-order the
 * survivors by `[tiers]` declaration position (see `firstByTierOrder`), so
 * `[aliases]`/candidate order never decides which model a tier resolves to.
 */
export function selectTokensForTier(
  config: CqConfig,
  tier: Tier,
  candidates: readonly ReviewerToken[],
): ReviewerToken[] {
  return candidates.filter((token) => classifyToken(config, token) === tier);
}

/**
 * From a tier-filtered token set, return the one declared FIRST in `[tiers]`.
 *
 * Walks `config.tiers.entries` in declaration order and returns the first entry
 * whose token appears in `selected` — making the caller's tie-break depend on
 * `[tiers]` order alone, independent of how `selected` (and hence `[aliases]`)
 * was ordered. Returns `undefined` iff `selected` is empty. When `[tiers]` is
 * null nothing can classify, so `selected` is empty and the guard returns
 * `undefined` regardless.
 */
function firstByTierOrder(
  config: CqConfig,
  selected: readonly ReviewerToken[],
): ReviewerToken | undefined {
  if (selected.length === 0 || config.tiers === null) {
    return selected[0];
  }
  for (const e of config.tiers.entries) {
    // Return the caller's OWN candidate object (not e.token), preserving its
    // exact shape — the candidate is what the caller passed in.
    const hit = selected.find((t) => reviewerTokensEqual(t, e.token));
    if (hit !== undefined) {
      return hit;
    }
  }
  // Unreachable: every classified token has a matching [tiers] entry.
  return selected[0];
}

/**
 * Resolve a named agent end-to-end to the token it should run at.
 *
 * Pipeline (Q149 classifier model): agent-name -> {@link resolveAgentTier}
 * (via `[agent_tiers]`, falling back to `DEFAULT_TIER`) ->
 * {@link selectTokensForTier} over `candidates` (the relevant ACTIVE set —
 * the resolved planners/reviewers the caller is dispatching from) -> when more
 * than one candidate classifies to that tier, the one declared FIRST in
 * `[tiers]` wins.
 *
 * TIE-BREAK — `[tiers]` DECLARATION ORDER, never `[aliases]`/candidate order.
 * `[aliases]` is an unordered name->token MAP; its ordering must not influence
 * which model a tier resolves to (R###). `[tiers]` is the classifier the user
 * writes, so its declaration order is the single authoritative tie-break. Every
 * classified candidate has exactly one `[tiers]` entry (`parseTiers` rejects two
 * entries resolving to the same token), so the ordering is unambiguous.
 *
 * `[tiers]` is a CLASSIFIER, not a tier->single-model lookup: it does NOT pick
 * a model on its own. The caller supplies which active tokens are eligible;
 * `resolveAgentModel` only filters them by the agent's tier (and orders the
 * survivors by `[tiers]` position).
 *
 * Throws a precise `CqConfigError` when NO candidate classifies to the agent's
 * tier (including the case where `[tiers]` is absent so nothing classifies).
 */
export function resolveAgentModel(
  config: CqConfig,
  agentName: string,
  candidates: readonly ReviewerToken[],
): ReviewerToken {
  const tier = resolveAgentTier(config, agentName);
  const selected = selectTokensForTier(config, tier, candidates);
  const first = firstByTierOrder(config, selected);
  if (first === undefined) {
    throw new CqConfigError(
      `cannot resolve a model for agent "${agentName}": no active token classifies as tier "${tier}" in [tiers] (candidates: ${
        candidates.length === 0
          ? "<none>"
          : candidates.map((t) => formatReviewerToken(t)).join(", ")
      })`,
    );
  }
  return first;
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
