/**
 * Typed render-model for the Agents tab (T275, goal G34; Q148 + Q151–Q153).
 *
 * Mirrors {@link ./flowData.ts} — the hand-authored / generated typed-catalogue
 * precedent — in structure and export style: a typed model plus a single
 * exported array the UI tab (T278) consumes. Where `flowData` is hand-authored,
 * `AGENT_ROLES` is GENERATED: a codegen script (T276) walks the `cq-assets`
 * agent/command markdown, runs {@link parseAgentMarkdown} over each asset, and
 * emits `agentsCatalogue.gen.ts`. This module re-exports that generated array so
 * the UI imports a single stable name regardless of how it was produced.
 *
 * This module is **node-free / browser-bundleable**: it imports no `node:*`
 * builtins. All file reading (globbing the asset tree, `readFileSync`) lives in
 * the T276 codegen SCRIPT, which calls the pure {@link parseAgentMarkdown} below
 * and serializes the result. The parser itself takes a raw string and returns a
 * plain object — no I/O — so it bundles for the browser and unit-tests trivially.
 *
 * ## AGENT_ROLES placeholder (approach (a))
 * `agentsCatalogue.gen.ts` is committed as a PLACEHOLDER exporting an empty
 * `AGENT_ROLES: AgentRole[] = []`. T276 overwrites that file with the real
 * generated array. Re-exporting from a committed placeholder (rather than a
 * yet-to-exist module) keeps `bun run check` GREEN now and gives T276 a concrete
 * file to regenerate in place. Consumers import {@link AGENT_ROLES} from THIS
 * module, never from the `.gen` file directly.
 */

import type { JSONSchema } from "@cq/config";

/** Which side of the implement/plan/investigate flows a role plays. */
export type AgentKind = "orchestrator" | "agent-subagent";

/**
 * Repo-mutation privilege, DERIVED MECHANICALLY from frontmatter (Q151–Q153) —
 * NOT authored in the `## Catalogue` block:
 * - a SUBAGENT (`agents/*.md`) is `RW` iff NONE of
 *   {Write, Edit, MultiEdit, NotebookEdit, Bash} appears in its
 *   `disallowedTools`, else `RO`;
 * - a COMMAND (`commands/cq/*.md`) is `RW` iff its `allowed-tools` lists a
 *   mutating tool (Write | Edit | Bash), else `RO`.
 */
export type Privilege = "RO" | "RW";

/**
 * The structured `## Catalogue` block authored per asset (T281): the SOURCE OF
 * TRUTH for a role's INPUTS / OUTPUTS / IO-SCHEMA notes. Distinct from the
 * MECHANICALLY-DERIVED privilege/exposedTools (which come from frontmatter, not
 * this block). Every field is optional so the parser degrades gracefully when an
 * asset has no `## Catalogue` block yet (the common case until T281 authors them).
 */
export interface CatalogueBlock {
  /** Expected inputs the role consumes (from the dispatch prompt / ledger). */
  inputs?: string[];
  /** Outputs the role produces (structured result, ledger writes, files). */
  outputs?: string[];
  /** Free-form notes on the input/output schema / contract shape. */
  ioSchema?: string[];
}

/**
 * The typed render model for ONE role in the Agents tab. Widens the
 * `## Catalogue`-authored IO model (inputs/outputs/ioSchema) with the identity,
 * provenance, prompt body, model configuration, and the MECHANICALLY-DERIVED
 * privilege/exposedTools.
 */
export interface AgentRole {
  /** Stable id (the asset basename, e.g. `implement-worker`, `plan/advance`). */
  id: string;
  /** Human display name (frontmatter `name` for agents; derived for commands). */
  name: string;
  /** Which side of the flow the role plays. */
  kind: AgentKind;
  /** Source path of the asset, relative to `cq-assets` (e.g. `agents/x.md`). */
  source: string;
  /** Frontmatter `description`. */
  description: string;
  /** Expected inputs (from the `## Catalogue` block). */
  inputs: string[];
  /** Outputs produced (from the `## Catalogue` block). */
  outputs: string[];
  /** Input/output schema notes (from the `## Catalogue` block). */
  ioSchema: string[];
  /** Full prompt-template body (markdown after the frontmatter; folded in UI). */
  promptTemplate: string;
  /** Repo-mutation privilege, DERIVED from frontmatter (Q151). */
  privilege: Privilege;
  /**
   * RAW per-kind tool descriptor (Q152–Q153), as authored in frontmatter —
   * subagents show `disallowedTools` (+ `isolation` when present), commands show
   * `allowed-tools`; `"none declared"` when the frontmatter key is absent.
   */
  exposedTools: string;
  /**
   * The parent-supplied INPUT contract as JSON Schema (T341, role-scope decision
   * 1) — present IFF this role is a DISPATCHED-SUBAGENT (non-null `agentTierKey`
   * in `AGENT_ROLE_TIERS`), sourced from the `@cq/config` typed catalog
   * (`DISPATCHED_ROLE_SIDECARS`). Absent (`undefined`) for orchestrator-commands.
   */
  inputSchema?: JSONSchema;
  /**
   * The validated OUTPUT contract as JSON Schema (T341) — present IFF this role
   * is a dispatched-subagent, sourced from the same `@cq/config` typed catalog.
   * Absent for orchestrator-commands.
   */
  outputSchema?: JSONSchema;
}

/**
 * Re-export of the GENERATED catalogue (see module doc — approach (a)). T276
 * overwrites `agentsCatalogue.gen.ts`; consumers import this name, never the
 * `.gen` module directly.
 */
export { AGENT_ROLES } from "./agentsCatalogue.gen.js";

// ---------------------------------------------------------------------------
// Pure parser — used by the T276 codegen script; no node:* / no I/O.
// ---------------------------------------------------------------------------

/** Frontmatter keys the parser recognises across BOTH asset kinds. */
export interface ParsedFrontmatter {
  /** Agent identity (agents only). */
  name?: string;
  /** Description (both kinds). */
  description?: string;
  /** Agent deny-list (subagents only), split on commas, trimmed. */
  disallowedTools?: string[];
  /** Agent isolation mode (subagents only), e.g. `worktree`. */
  isolation?: string;
  /** Command argument hint (commands only). */
  argumentHint?: string;
  /** Command allow-list (commands only), split on commas, trimmed (Q152). */
  allowedTools?: string[];
}

/** The structured result of {@link parseAgentMarkdown}. */
export interface ParsedAgentMarkdown {
  frontmatter: ParsedFrontmatter;
  /** The parsed `## Catalogue` fenced-yaml block, or an empty object if absent. */
  catalogue: CatalogueBlock;
  /** The prompt-template body — the markdown after the frontmatter. */
  body: string;
}

/** Mutating tools that gate a SUBAGENT's deny-list privilege (Q151). */
const SUBAGENT_MUTATING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] as const;
/** Mutating tools that gate a COMMAND's allow-list privilege (Q151). */
const COMMAND_MUTATING_TOOLS = ["Write", "Edit", "Bash"] as const;

/**
 * Strip a trailing `# comment` from a frontmatter scalar value. Asset frontmatter
 * carries inline comments on some keys (e.g. `argument-hint: <x>  # e.g. …`);
 * they are not part of the value. A `#` only starts a comment when preceded by
 * whitespace (or at line start) so a `#` inside a token is preserved.
 */
function stripInlineComment(value: string): string {
  const m = value.match(/(^|\s)#/);
  if (m && m.index !== undefined) {
    const cut = m[1] === "" ? m.index : m.index + 1;
    return value.slice(0, cut).trim();
  }
  return value.trim();
}

/**
 * Strip a single matching pair of surrounding single or double quotes from a
 * value. `## Catalogue` authoring convention (T281): an author MAY quote a
 * scalar/list value (e.g. to protect a leading `{` or a colon under a strict
 * YAML reader) or leave it bare — the parser yields the UNQUOTED string either
 * way, so the UI never renders literal quote characters. Only a *matching*
 * outer pair is removed; mismatched or single dangling quotes are preserved.
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Split a comma-separated tool list into trimmed, non-empty tokens. */
function splitToolList(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse the leading `---`-fenced frontmatter into a {@link ParsedFrontmatter}.
 * The asset frontmatter is a flat `key: value` block (NOT nested YAML): tool
 * lists are inline comma-separated, scalars may carry trailing `# comments`.
 * Returns `{ fm, rest }` where `rest` is everything after the closing fence
 * (the body, including any `## Catalogue` block).
 */
function parseFrontmatterBlock(raw: string): { fm: ParsedFrontmatter; rest: string } {
  const fm: ParsedFrontmatter = {};
  // Frontmatter must open with `---` on the first line.
  const fenceMatch = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!fenceMatch) {
    return { fm, rest: raw };
  }
  const block = fenceMatch[1] ?? "";
  const rest = raw.slice(fenceMatch[0].length);
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    switch (key) {
      case "name":
        fm.name = stripInlineComment(rawValue);
        break;
      case "description":
        // Descriptions may legitimately contain `#`; preserve their prose content.
        fm.description = stripQuotes(rawValue);
        break;
      case "disallowedTools":
        fm.disallowedTools = splitToolList(stripInlineComment(rawValue));
        break;
      case "isolation":
        fm.isolation = stripInlineComment(rawValue);
        break;
      case "argument-hint":
        fm.argumentHint = stripQuotes(stripInlineComment(rawValue));
        break;
      case "allowed-tools":
        fm.allowedTools = splitToolList(stripInlineComment(rawValue));
        break;
      default:
        break;
    }
  }
  return { fm, rest };
}

/**
 * Extract and parse the `## Catalogue` fenced-yaml block from the body, if
 * present. The convention (T275; T281 authors the blocks):
 *
 * ```
 * ## Catalogue
 * ` ` `yaml
 * inputs:
 *   - <expected input>
 * outputs:
 *   - <produced output>
 * ioSchema:
 *   - <schema note>
 * ` ` `
 * ```
 *
 * Each recognised key maps to a list of dash-items (or a single scalar, which is
 * normalised to a one-element list). Degrades gracefully: an absent block, an
 * absent fence, or absent keys yield an empty {@link CatalogueBlock}. The parser
 * is intentionally small (flat keys → string lists) so the module stays
 * dependency-free and browser-bundleable rather than pulling in a YAML library.
 *
 * Quoting convention (T281 authors): each scalar/list value MAY be wrapped in a
 * single matching pair of single or double quotes — useful to protect a value
 * whose first character (`{`, `[`, `&`, …) or embedded `:` would confuse a
 * strict YAML reader — or left bare. The parser strips one matching outer pair
 * via {@link stripQuotes}, so the stored value is always UNQUOTED and the UI
 * never renders literal quote characters.
 */
function parseCatalogueBlock(body: string): CatalogueBlock {
  const out: CatalogueBlock = {};
  // Locate `## Catalogue` heading, then the first fenced code block under it.
  const heading = body.match(/^##[ \t]+Catalogue[ \t]*$/m);
  if (!heading || heading.index === undefined) return out;
  const after = body.slice(heading.index + heading[0].length);
  const fence = after.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n```/);
  if (!fence) return out;
  const yaml = fence[1] ?? "";

  let current: keyof CatalogueBlock | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    // A `- item` line appends to the currently-open key.
    const item = line.match(/^[ \t]*-[ \t]+(.*\S)[ \t]*$/);
    if (item && current) {
      (out[current] ??= []).push(stripQuotes((item[1] ?? "").trim()));
      continue;
    }
    // A `key:` line (optionally with an inline scalar value) opens a key.
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*)[ \t]*:[ \t]*(.*)$/);
    if (kv) {
      const key = kv[1];
      if (key === "inputs" || key === "outputs" || key === "ioSchema") {
        current = key;
        const scalar = (kv[2] ?? "").trim();
        if (scalar.length > 0) {
          (out[current] ??= []).push(stripQuotes(scalar));
        }
      } else {
        // Unknown key: stop appending dash-items to a prior key.
        current = null;
      }
    }
  }
  return out;
}

/**
 * Pure parser over ONE asset's raw markdown (Q148 + Q152). Extracts:
 * - the real frontmatter keys for BOTH kinds — agents'
 *   `name`/`description`/`disallowedTools`/`isolation` AND commands'
 *   `description`/`argument-hint`/`allowed-tools`;
 * - the `## Catalogue` fenced-yaml block (empty when absent);
 * - the prompt-template body (everything after the frontmatter).
 *
 * No I/O: takes the raw string, returns a plain object. The T276 codegen script
 * reads the files and derives {@link AgentRole} (incl. privilege + exposedTools)
 * from this result.
 */
export function parseAgentMarkdown(raw: string): ParsedAgentMarkdown {
  const { fm, rest } = parseFrontmatterBlock(raw);
  const catalogue = parseCatalogueBlock(rest);
  return { frontmatter: fm, catalogue, body: rest };
}

/**
 * Derive a SUBAGENT's privilege from its `disallowedTools` deny-list (Q151): a
 * subagent is `RW` iff NONE of {Write, Edit, MultiEdit, NotebookEdit, Bash}
 * appears in the deny-list, else `RO`. An absent/empty deny-list ⇒ `RW`.
 */
export function deriveSubagentPrivilege(disallowedTools: string[] | undefined): Privilege {
  const denied = new Set(disallowedTools ?? []);
  const blocksMutation = SUBAGENT_MUTATING_TOOLS.some((t) => denied.has(t));
  return blocksMutation ? "RO" : "RW";
}

/**
 * Derive a COMMAND's privilege from its `allowed-tools` allow-list (Q151): a
 * command is `RW` iff its allow-list lists a mutating tool (Write | Edit | Bash),
 * else `RO`. An absent/empty allow-list ⇒ `RO`.
 */
export function deriveCommandPrivilege(allowedTools: string[] | undefined): Privilege {
  const allowed = new Set(allowedTools ?? []);
  const grantsMutation = COMMAND_MUTATING_TOOLS.some((t) => allowed.has(t));
  return grantsMutation ? "RW" : "RO";
}

/**
 * Build the canonical display string for {@link AgentRole.exposedTools} from the
 * PARSED frontmatter (Q152–Q153, raw per-kind semantics). Centralising the
 * format here is the contract for downstream tasks: T276 (codegen) populates
 * `exposedTools` by calling THIS helper, and T278 (UI) renders the result
 * verbatim — neither invents its own string.
 *
 * Tool-list parsing assumption (for T281 authors): the underlying frontmatter
 * `disallowedTools` / `allowed-tools` values are COMMA-SEPARATED lists of EXACT
 * tool tokens (e.g. `Write`, `Edit`, `Bash`, `mcp__ledger__*`, `Agent`), already
 * split + trimmed into {@link ParsedFrontmatter}. This helper joins them back
 * with `", "`; it does not normalise or validate token spelling, so privilege
 * derivation and display both rely on the authored tokens matching exactly.
 *
 * Exact output format:
 * - `agent-subagent` → `"Disallowed: <comma-list>"`, with `"; isolation: <value>"`
 *   appended when `isolation` is present; `"Disallowed: none"` when
 *   `disallowedTools` is absent or empty (the `isolation` suffix is still
 *   appended when present, e.g. `"Disallowed: none; isolation: worktree"`).
 * - `orchestrator` (command) → `"Allowed: <comma-list>"`, or `"none declared"`
 *   when `allowed-tools` is absent or empty.
 */
export function formatExposedTools(frontmatter: ParsedFrontmatter, kind: AgentKind): string {
  if (kind === "agent-subagent") {
    const denied = frontmatter.disallowedTools ?? [];
    const base = denied.length > 0 ? `Disallowed: ${denied.join(", ")}` : "Disallowed: none";
    return frontmatter.isolation ? `${base}; isolation: ${frontmatter.isolation}` : base;
  }
  const allowed = frontmatter.allowedTools ?? [];
  return allowed.length > 0 ? `Allowed: ${allowed.join(", ")}` : "none declared";
}
