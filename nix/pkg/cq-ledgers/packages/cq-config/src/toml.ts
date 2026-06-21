/**
 * cq.toml parsing scoped to the cq.toml schema (T170, T185, T223, T237).
 *
 * Parsing is delegated to the maintained `smol-toml` library (pure TS, TOML
 * 1.0, zero native deps, Bun-compatible). smol-toml accepts *any* valid TOML,
 * so this module layers the cq.toml schema on top of it as a post-parse
 * validation pass (fail fast at the boundary):
 *  - only `[aliases]`, `reviewers`, `planners`, `[webui]`, `[tiers]`, and
 *    `[agent_tiers]` are allowed; any other top-level key/table throws;
 *  - `aliases` is a table of `name = "value"` string assignments (token values);
 *  - `reviewers` / `planners` are arrays of strings;
 *  - `webui` is a table with an optional string `host` and an optional
 *    integer `port` in 1..65535;
 *  - `tiers` is an inverted CLASSIFIER table: each KEY is a reviewer token
 *    (`"<harness>:<model>"`) or an `[aliases]` name, and each VALUE is the tier
 *    CLASS it is assigned to (`fast`/`standard`/`frontier`);
 *  - `agent_tiers` is a table of `agent-name = "<tier>"` strings.
 *
 * Token grammar (BREAKING in T237):
 *  - pi tokens MUST be `pi:<provider>/<model>` where provider is the pi
 *    `--provider` and model is the pi `--model`. Bare pi tokens (e.g.
 *    `pi:minimax` without a provider qualifier) are a CONFIG ERROR.
 *  - claude tokens MUST be `claude:<model>`. Provider qualifiers (/) are
 *    NOT permitted on claude tokens and are a CONFIG ERROR.
 *
 * A malformed document (smol-toml's `TomlError`) is re-wrapped into the
 * existing `TomlSyntaxError` style so the public surface is unchanged.
 */

import { parse as parseSmolToml, TomlError } from "smol-toml";
import { isHarness } from "./types.js";

/**
 * The raw `[webui]` table as produced by the parser: the `host` / `port`
 * cells are left as smol-toml emitted them (unknown JS values) for the
 * config layer to type-check and range-check at the boundary
 * (`parseConfig` -> `CqConfigError`). Absent cells are `undefined`.
 */
export interface RawWebui {
  readonly host: unknown;
  readonly port: unknown;
}

/**
 * The raw `[ledger]` table as produced by the parser: all cells are left as
 * smol-toml emitted them (unknown JS values) for the config layer to
 * type-check at the boundary (`parseConfig` -> `CqConfigError`).
 * Absent cells are `undefined`.
 */
export interface RawLedger {
  readonly backend: unknown;
  readonly branch: unknown;
  readonly remote: unknown;
}

/**
 * A single `[harness.<name>]` override block (Q240): the raw per-harness
 * subset of the SHARED config that may be overridden for one harness. Each
 * cell is left as the parser produced it (validated structurally here, but
 * the merge into `CqConfig` is a downstream task T477):
 *  - `reviewers` / `planners`: the per-harness reviewer/planner arrays, or
 *    null if that sub-key is absent;
 *  - `tiers`: the per-harness `[harness.<name>.tiers]` CLASSIFIER table
 *    (raw token-or-alias KEY -> tier-class VALUE), or null if absent.
 * `[harness.<name>]` may carry ONLY these three keys; `aliases`, `webui`,
 * `ledger`, and `agent_tiers` are SHARED-only and rejected here.
 */
export interface RawHarnessOverride {
  /** The per-harness `reviewers` array of strings, or null if absent. */
  readonly reviewers: readonly string[] | null;
  /** The per-harness `planners` array of strings, or null if absent. */
  readonly planners: readonly string[] | null;
  /** The per-harness `[tiers]` CLASSIFIER table, or null if absent. */
  readonly tiers: Record<string, string> | null;
}

/** The shape a cq.toml document parses into before schema validation. */
export interface RawToml {
  /** The `[aliases]` table: alias name -> raw token string. */
  readonly aliases: Record<string, string>;
  /** The top-level `reviewers` array of strings, or null if absent. */
  readonly reviewers: readonly string[] | null;
  /** The top-level `planners` array of strings, or null if absent. */
  readonly planners: readonly string[] | null;
  /** The `[webui]` table, or null if absent. */
  readonly webui: RawWebui | null;
  /**
   * The `[tiers]` CLASSIFIER table: raw token-or-alias KEY -> tier-class VALUE
   * (both raw strings; the config layer resolves the key and validates the
   * class). Null if absent.
   */
  readonly tiers: Record<string, string> | null;
  /** The `[agent_tiers]` table: agent name -> tier name, or null if absent. */
  readonly agentTiers: Record<string, string> | null;
  /** The `[ledger]` table, or null if absent. */
  readonly ledger: RawLedger | null;
  /**
   * The `[harness.<name>]` per-harness override tables (Q240): harness name
   * (`claude`/`pi`) -> its raw overridable subset. Null if the document
   * carries no `[harness.*]` table at all.
   */
  readonly harnessOverrides: Record<string, RawHarnessOverride> | null;
}

/** Thrown when cq.toml is not valid TOML, or violates the cq.toml schema. */
class TomlSyntaxError extends Error {
  constructor(message: string) {
    super(`cq.toml: ${message}`);
    this.name = "TomlSyntaxError";
  }
}

/** The exact set of top-level keys/tables cq.toml permits. */
const ALLOWED_TOP_LEVEL = new Set([
  "aliases",
  "reviewers",
  "planners",
  "webui",
  "tiers",
  "agent_tiers",
  "ledger",
  "harness",
]);

/** The per-harness keys an `[harness.<name>]` block may override (Q240). */
const ALLOWED_HARNESS_OVERRIDE_KEYS = new Set(["reviewers", "planners", "tiers"]);

/** Narrow an unknown value to a record (TOML table). */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate + coerce the `[aliases]` table into `name -> string`. */
function parseAliases(value: unknown): Record<string, string> {
  if (!isTable(value)) {
    throw new TomlSyntaxError("[aliases] must be a table");
  }
  const aliases: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new TomlSyntaxError(`alias "${name}" must be a string`);
    }
    aliases[name] = raw;
  }
  return aliases;
}

/** Validate that `value` is an array of strings (for reviewers / planners). */
function parseStringArray(key: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TomlSyntaxError(`${key} must be an array of strings`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new TomlSyntaxError(`${key}[${i}] must be a string`);
    }
    return entry;
  });
}

/**
 * Validate + coerce a string-to-string table (used for `[tiers]` and
 * `[agent_tiers]`): every value must be a string.
 */
function parseStringTable(key: string, value: unknown): Record<string, string> {
  if (!isTable(value)) {
    throw new TomlSyntaxError(`[${key}] must be a table`);
  }
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new TomlSyntaxError(`${key}.${name} must be a string`);
    }
    result[name] = raw;
  }
  return result;
}

/**
 * Structurally validate the `[webui]` table: it must be a table whose only
 * keys are `host` / `port`. The host/port *values* are passed through
 * untouched — `parseConfig` type-checks and range-checks them and raises a
 * `CqConfigError` at the boundary.
 */
function parseWebui(value: unknown): RawWebui {
  if (!isTable(value)) {
    throw new TomlSyntaxError("[webui] must be a table");
  }
  for (const key of Object.keys(value)) {
    if (key !== "host" && key !== "port") {
      throw new TomlSyntaxError(`unexpected key "${key}" in [webui]`);
    }
  }
  return { host: value.host, port: value.port };
}

/**
 * Structurally validate the `[ledger]` table: it must be a table whose only
 * keys are `backend`, `branch`, and `remote`. The values are passed through
 * untouched — `parseConfig` type-checks and validates them and raises a
 * `CqConfigError` at the boundary.
 */
function parseLedgerRaw(value: unknown): RawLedger {
  if (!isTable(value)) {
    throw new TomlSyntaxError("[ledger] must be a table");
  }
  for (const key of Object.keys(value)) {
    if (key !== "backend" && key !== "branch" && key !== "remote") {
      throw new TomlSyntaxError(`unexpected key "${key}" in [ledger]`);
    }
  }
  return { backend: value.backend, branch: value.branch, remote: value.remote };
}

/**
 * Structurally validate the `[harness]` table of per-harness override blocks
 * (Q240): each sub-table key must be a known harness name (`claude`/`pi` via
 * `isHarness`), and within each block only `reviewers` / `planners` / `tiers`
 * are permitted (the per-harness-overridable subset). `aliases`, `webui`,
 * `ledger`, and `agent_tiers` are SHARED-only and rejected with a precise
 * error naming the offending key. The reviewers/planners arrays and tiers
 * table are validated with the same helpers as their top-level counterparts;
 * the merge into `CqConfig` is deferred to T477.
 */
function parseHarnessOverrides(
  value: unknown,
): Record<string, RawHarnessOverride> {
  if (!isTable(value)) {
    throw new TomlSyntaxError("[harness] must be a table");
  }
  const overrides: Record<string, RawHarnessOverride> = {};
  for (const [name, block] of Object.entries(value)) {
    if (!isHarness(name)) {
      throw new TomlSyntaxError(
        `unknown harness "${name}" in [harness.${name}] (expected "claude" or "pi")`,
      );
    }
    if (!isTable(block)) {
      throw new TomlSyntaxError(`[harness.${name}] must be a table`);
    }
    for (const key of Object.keys(block)) {
      if (!ALLOWED_HARNESS_OVERRIDE_KEYS.has(key)) {
        throw new TomlSyntaxError(
          `unexpected key "${key}" in [harness.${name}] (only reviewers, planners, tiers may be overridden per-harness)`,
        );
      }
    }
    const reviewers =
      "reviewers" in block
        ? parseStringArray(`harness.${name}.reviewers`, block.reviewers)
        : null;
    const planners =
      "planners" in block
        ? parseStringArray(`harness.${name}.planners`, block.planners)
        : null;
    const tiers =
      "tiers" in block
        ? parseStringTable(`harness.${name}.tiers`, block.tiers)
        : null;
    overrides[name] = { reviewers, planners, tiers };
  }
  return overrides;
}

/**
 * Parse a cq.toml document into its raw shape, or throw a precise
 * `TomlSyntaxError` on malformed input or a schema violation.
 */
export function parseToml(source: string): RawToml {
  let doc: Record<string, unknown>;
  try {
    doc = parseSmolToml(source) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TomlError) {
      throw new TomlSyntaxError(err.message);
    }
    throw err;
  }

  // Whitelist: only the known top-level keys/tables are permitted.
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw new TomlSyntaxError(`unexpected top-level key ${key}`);
    }
  }

  const aliases = "aliases" in doc ? parseAliases(doc.aliases) : {};
  const reviewers =
    "reviewers" in doc ? parseStringArray("reviewers", doc.reviewers) : null;
  const planners =
    "planners" in doc ? parseStringArray("planners", doc.planners) : null;
  const webui = "webui" in doc ? parseWebui(doc.webui) : null;
  const tiers = "tiers" in doc ? parseStringTable("tiers", doc.tiers) : null;
  const agentTiers =
    "agent_tiers" in doc
      ? parseStringTable("agent_tiers", doc.agent_tiers)
      : null;
  const ledger = "ledger" in doc ? parseLedgerRaw(doc.ledger) : null;
  const harnessOverrides =
    "harness" in doc ? parseHarnessOverrides(doc.harness) : null;

  return {
    aliases,
    reviewers,
    planners,
    webui,
    tiers,
    agentTiers,
    ledger,
    harnessOverrides,
  };
}
