import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// cq subagent-dispatch extension (T224).
//
// Registers ONE tool, `dispatch_agent`, that the cq shared prompts already
// speak to: "dispatch/launch the named subagent <agent> with <task>". The tool
// reads the named agent's markdown from the projected cq-agents directory
// (T222: $CQ_AGENTS_DIR, default $HOME/.pi/agent/cq-agents), parses its
// frontmatter, and runs the agent as an ISOLATED child pi turn whose toolset is
// filtered to the agent's allowed set — and which can NOT itself re-dispatch.
//
// Mechanism (Route A, per the T221 go/no-go spike
// docs/drafts/20260607-2022-T221-pi-childsession-spike.md): spawn a fresh
//   pi -p --mode json --no-session [--provider P --model M]
//      --exclude-tools <denylist incl. DISPATCH_TOOL_NAME>
//      --append-system-prompt <agent body file> "<task>"
// subprocess and parse its stdout `message_end` JSON stream; the final
// assistant text part is returned to the caller (the `getFinalOutput` pattern
// from the upstream subagent example).
//
// Subagents-cannot-spawn-subagents is guarded by the `--exclude-tools` denylist
// below, which ALWAYS contains DISPATCH_TOOL_NAME: the child is a plain
// `pi -p` process that is NOT launched with `--extension
// cq-subagent-dispatch.ts`, and even if the dispatch extension is discovered
// via settings, its tool is filtered out of the child by the denylist — so the
// child can never re-dispatch. (We do NOT pass `--no-extensions`, because the
// provider-registering package extensions — e.g. pi-xai's grok-build — must
// still load for the child's model to resolve.)
//
// CHILD MODEL (T225): the child's provider+model is resolved from the
// DISPATCHED AGENT'S NAME via cq.toml's `[agent_tiers]` + tier maps.
// Resolution precedence (highest first):
//   1. an explicit `model` arg the caller passes at dispatch (a
//      "<harness>:<model>" token, or a bare pi model pattern) — wins outright;
//   2. the agent's tier: agent name -> `[agent_tiers]` -> tier (default
//      "standard") -> the tier map -> token (resolved via `[aliases]` first,
//      else a direct "<harness>:<model>" token). The tier map is the ACTIVE
//      harness's `[harness.<CQ_HARNESS>.tiers]` when present, else the shared
//      top-level `[tiers]` — mirroring @cq/config's per-harness layering, and
//      matching the `tier = "model"` keying cq init now writes;
//   3. fallback: the PARENT session's currently-active model (ctx.model) — used
//      when cq.toml is absent, has no applicable tier map / `[agent_tiers]`, the
//      agent's tier slot is unconfigured, or the token resolves to a `claude:`
//      harness (a Claude provider cannot be driven by a child `pi -p` process).
//
// The cq.toml read strategy is PINNED in K46
// (docs/drafts/20260607-2049-pi-runtime-config-access.md): $CQ_CONFIG (default
// $CQ_PROJECT_ROOT/cq.toml, fallback <cwd>/cq.toml), parsed with an INLINED
// flat-table TOML reader + INLINED resolver that MIRRORS @cq/config's
// resolveAgentTier/resolveTierToken/resolveAgentModel (T223,
// packages/cq-config/src/{config,toml}.ts). It is COPIED, not imported: this is
// a standalone store-path extension OUTSIDE the cq-ledgers bun workspace and
// cannot import @cq/config.

const DISPATCH_TOOL_NAME = "dispatch_agent";

// T222: the directory the cq agent markdowns are projected to. Pinned on
// piWrapped in nix/hm/dev-llm.nix; default mirrors that wiring.
const AGENTS_DIR_ENV = "CQ_AGENTS_DIR";
const DEFAULT_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "cq-agents");

// K46: where cq.toml lives. T224 only computes this path (a seam for T225's
// tier resolution); it does NOT read or parse the file here.
const CQ_CONFIG_ENV = "CQ_CONFIG";
const CQ_PROJECT_ROOT_ENV = "CQ_PROJECT_ROOT";
const CQ_CONFIG_FILENAME = "cq.toml";

// Cap on the child's returned text, mirroring the upstream subagent example's
// per-task output discipline.
const OUTPUT_CAP_BYTES = 64 * 1024;

interface AgentDefinition {
  name: string;
  description: string;
  /** pi tool names the child is NOT allowed to use (denylist for --exclude-tools). */
  disallowedTools: string[];
  /** The markdown body, injected as the child's appended system prompt. */
  systemPrompt: string;
  filePath: string;
}

interface DispatchDetails {
  agent: string;
  agentFile: string | null;
  /** Echoes the requested isolation mode (stubbed seam, deferred per Q128). */
  isolation: "worktree" | null;
  model: string | null;
  provider: string | null;
  /**
   * How `model`/`provider` were chosen (T225): "explicit" (caller passed a
   * model arg), "tier" (agent name -> [agent_tiers] -> [tiers]), or "parent"
   * (fallback to the parent session's active model).
   */
  modelSource: "explicit" | "tier" | "parent";
  /**
   * The resolved effort level (R342). For a pi child this is APPENDED to the
   * `--model` arg as the `<provider>/<model>:<effort>` thinking-level shorthand.
   * For a claude token (parent fallback) it is recorded INERTLY here — observable
   * but NOT passed to the child. null when the resolved token carried no effort.
   */
  childEffort: string | null;
  /** The tier the agent NAME mapped to via [agent_tiers] (null when not tiered). */
  resolvedTier: string | null;
  /** provider/model the child actually opened against, read from its JSON stream. */
  childProvider: string | null;
  childModel: string | null;
  exitCode: number;
  excludedTools: string[];
  cqConfigPath: string;
  stderr: string;
}

const DispatchParams = Type.Object({
  agent: Type.String({ description: "Name of the cq agent to dispatch (matches the agent markdown filename / frontmatter name)." }),
  task: Type.String({ description: "The task to delegate to the agent — becomes the child turn's prompt." }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional explicit model OVERRIDE. Wins over the agent\'s tier. A "<harness>:<model>" token: a pi token MUST be qualified ("pi:<provider>/<model>", e.g. "pi:ollama-cloud/minimax-m3") — a BARE pi token ("pi:<model>", no provider) is REFUSED and falls back to the parent model (mirrors @cq/config). A "claude:" token cannot run under a child pi process and also falls back to the parent model.',
    }),
  ),
  isolation: Type.Optional(
    Type.Literal("worktree", {
      description: 'Optional isolation mode. Only "worktree" is recognized; it is a stubbed seam (deferred per Q128) and does not yet change behavior.',
    }),
  ),
});

type DispatchArgs = {
  agent: string;
  task: string;
  model?: string;
  isolation?: "worktree";
};

/** Resolve the cq-agents directory (T222 wiring). */
function resolveAgentsDir(): string {
  const fromEnv = process.env[AGENTS_DIR_ENV];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_AGENTS_DIR;
}

/**
 * Resolve the cq.toml path per K46: $CQ_CONFIG, else $CQ_PROJECT_ROOT/cq.toml,
 * else <cwd>/cq.toml. The seam T224 left for T225 — now actually READ + resolved
 * by loadCqConfig / resolveAgentToken below.
 */
function resolveCqConfigPath(cwd: string): string {
  const explicit = process.env[CQ_CONFIG_ENV];
  if (explicit && explicit.length > 0) return explicit;
  const projectRoot = process.env[CQ_PROJECT_ROOT_ENV];
  if (projectRoot && projectRoot.length > 0) return path.join(projectRoot, CQ_CONFIG_FILENAME);
  return path.join(cwd, CQ_CONFIG_FILENAME);
}

// ── Inlined cq.toml tier resolution (K46) ───────────────────────────────────
//
// MIRRORS @cq/config (T223, packages/cq-config/src/{config,toml}.ts). Copied,
// NOT imported — this extension is a standalone store-path file outside the
// cq-ledgers workspace. The only cq.toml tables this needs are the three FLAT
// `key = "value"` tables `[aliases]`, `[tiers]`, `[agent_tiers]`; we do not need
// a full TOML 1.0 parser (the smol-toml dep @cq/config uses), only a flat-table
// reader. Anything outside these three tables is ignored.

// ── Effort vocabulary — mirror of @cq/config (T284/T286) ─────────────────────
//
// MIRROR of @cq/config (packages/cq-config/src/types.ts PI_EFFORTS /
// CLAUDE_EFFORTS) — keep in sync. Copied, NOT imported (standalone store-path
// extension outside the cq-ledgers workspace). These are the closed
// per-harness vocabularies of the trailing `:<effort>` suffix; pi's set
// matches the pi CLI's `--thinking` levels (off/minimal/low/medium/high/xhigh),
// which is the same vocabulary the `--model provider/model:<effort>` shorthand
// accepts.
const PI_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Type guard mirroring @cq/config isEffort: is `value` a valid effort string
 * for `harness`? pi: off/minimal/low/medium/high/xhigh; claude:
 * low/medium/high/xhigh/max.
 */
function isEffort(harness: string, value: string): boolean {
  return (harness === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS).has(value);
}

/** The legal effort set for a harness, rendered for error messages. */
function legalEfforts(harness: string): string {
  return [...(harness === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)].join(" | ");
}

/**
 * A `<harness>:<model>[:<effort>]` token: harness is "claude" or "pi", with an
 * OPTIONAL trailing effort suffix (mirror of @cq/config ReviewerToken — T284/
 * T286). `effort` is null when no valid suffix was present.
 */
interface CqToken {
  harness: string;
  model: string;
  effort: string | null;
}

/** The subset of cq.toml this extension reads. */
interface CqConfigSubset {
  aliases: Record<string, string>;
  /**
   * The SHARED top-level `[tiers]` (tier name -> raw token/alias), or null if
   * absent. Used as the fallback when the active harness has no
   * `[harness.<name>.tiers]` override.
   */
  tiers: Record<string, string> | null;
  /**
   * Per-harness `[harness.<name>.tiers]` overrides: harness name -> (tier name
   * -> raw token/alias). The active harness's block WHOLLY REPLACES the shared
   * `[tiers]` (mirrors @cq/config's per-harness layering).
   */
  harnessTiers: Record<string, Record<string, string>>;
  /** agent name -> tier name. */
  agentTiers: Record<string, string> | null;
}

const VALID_TIERS = new Set(["fast", "standard", "frontier"]);
// MIRRORS @cq/config DEFAULT_TIER: an agent with no [agent_tiers] entry is
// "standard".
const DEFAULT_TIER = "standard";
// The three flat tables this reader understands; any other `[section]` header
// switches the reader into an ignored section.
const FLAT_TABLES = new Set(["aliases", "tiers", "agent_tiers"]);

/**
 * Strip a TOML inline `#` comment and surrounding whitespace from a line.
 * `#` inside a quoted string is preserved (the cq.toml flat tables never embed
 * `#` in a value, but we stay robust).
 */
function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Unquote a TOML basic/literal string value, or return it verbatim. */
function unquoteTomlValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * INLINED flat-table TOML reader. Parses ONLY `[aliases]`, `[tiers]`, and
 * `[agent_tiers]` as flat `key = "value"` string tables; every other section
 * (e.g. `[webui]`, top-level `reviewers = [...]` arrays) is ignored. Returns
 * `null` for a table that never appeared, `{}` for a table that appeared empty
 * (mirroring @cq/config's "absent => null" distinction for [tiers]/[agent_tiers]).
 */
function parseFlatToml(source: string): CqConfigSubset {
  const tables: Record<string, Record<string, string>> = {};
  const harnessTiers: Record<string, Record<string, string>> = {};
  // The table body lines are written into, or null inside an ignored section.
  let target: Record<string, string> | null = null;
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1]!.trim();
      if (FLAT_TABLES.has(name)) {
        target = tables[name] ??= {};
      } else {
        // Per-harness tier override: `[harness.<name>.tiers]`. Any other
        // nested/unknown section (e.g. `[harness.pi]`, `[webui]`) is ignored.
        const hm = name.match(/^harness\.([^.]+)\.tiers$/);
        target = hm ? (harnessTiers[hm[1]!] ??= {}) : null;
      }
      continue;
    }
    if (target === null) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    target[key] = unquoteTomlValue(line.slice(eq + 1));
  }
  return {
    aliases: tables.aliases ?? {},
    tiers: tables.tiers ?? null,
    harnessTiers,
    agentTiers: tables.agent_tiers ?? null,
  };
}

/**
 * Parse a `"<harness>:<model>[:<effort>]"` token. The FIRST `:` splits harness
 * from the remainder; an OPTIONAL trailing effort suffix is split off the LAST
 * `:` of that remainder and validated against the per-harness effort set
 * (PI_EFFORTS / CLAUDE_EFFORTS); after stripping a valid effort, `:` is
 * RESERVED inside the residual model on BOTH the claude model and the pi model
 * half (mirroring @cq/config parseReviewerToken — T286/R342: a stray `:` in the
 * model would collide with the `--model provider/model:<effort>` shorthand the
 * extension emits).
 *
 * UNSPECIFIED-EFFORT POLICY (PINNED — Q163): @cq/config FAILS FAST (throws) on
 * an invalid effort suffix or a reserved `:` in the model, because it sits at
 * the config-load boundary. This inlined mirror instead keeps THIS FILE'S
 * EXISTING LENIENT policy — a malformed token returns `null`, and the caller
 * falls back to the PARENT session's active model rather than dispatching an
 * unusable model token. Rationale: the only consumer here is a best-effort
 * child-model override; a bad token must never abort a dispatch, it must
 * degrade to the parent fallback (the same policy already applied to bare/
 * empty/unknown-harness tokens above). An invalid effort suffix, or a reserved
 * `:` left in the residual model, therefore yields `null` (not a throw).
 *
 * Returns null on a malformed/empty/invalid token.
 */
function parseCqToken(token: string): CqToken | null {
  const sep = token.indexOf(":");
  if (sep < 0) return null;
  const harness = token.slice(0, sep);
  const remainder = token.slice(sep + 1);
  if (harness === "" || remainder === "") return null;
  if (harness !== "claude" && harness !== "pi") return null;

  // Split a candidate effort suffix off the LAST `:` of the remainder.
  // Recognised as effort ONLY when isEffort(harness, suffix); a present-but-
  // invalid suffix is NOT silently absorbed — it leaves a reserved `:` in the
  // residual model, which is rejected below (→ null, parent fallback).
  let model = remainder;
  let effort: string | null = null;
  const lastColon = remainder.lastIndexOf(":");
  if (lastColon >= 0) {
    const candidate = remainder.slice(lastColon + 1);
    if (isEffort(harness, candidate)) {
      effort = candidate;
      model = remainder.slice(0, lastColon);
    }
    // else: invalid effort — fall through; the residual `:` is caught below.
  }
  if (model === "") return null;
  // R342: after stripping a valid effort, `:` is reserved in the residual
  // model (both harnesses) — it would collide with the pi `--model
  // provider/model:<effort>` shorthand. A leftover `:` means the token is
  // malformed -> null (parent fallback), the lenient mirror of @cq/config's
  // fail-fast throw.
  if (model.includes(":")) return null;
  return { harness, model, effort };
}

/** Load + parse cq.toml from `configPath`; null if absent or unreadable. */
function loadCqConfig(configPath: string): CqConfigSubset | null {
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  return parseFlatToml(source);
}

/**
 * Resolve an agent name to its tier. MIRRORS @cq/config resolveAgentTier:
 * `[agent_tiers]`[name] if present + valid, else DEFAULT_TIER ("standard").
 */
function resolveAgentTier(config: CqConfigSubset, agentName: string): string {
  if (config.agentTiers !== null) {
    const tier = config.agentTiers[agentName];
    if (tier !== undefined && VALID_TIERS.has(tier)) return tier;
  }
  return DEFAULT_TIER;
}

/**
 * The active cq harness for THIS process. MIRRORS @cq/config
 * resolveActiveHarnessFromProcess: `CQ_HARNESS` wins when it names a known
 * harness, else default "claude". In a pi process (this extension's only host)
 * nix/hm/pi.nix sets `CQ_HARNESS=pi`, so per-harness tiers resolve against
 * `[harness.pi.tiers]`.
 */
function resolveActiveHarness(): string {
  const env = process.env.CQ_HARNESS;
  return env === "pi" || env === "claude" ? env : "claude";
}

/**
 * Resolve a tier name to a `<harness>:<model>` token via the `[tiers]` map for
 * `activeHarness`: the active harness's `[harness.<harness>.tiers]` override if
 * present, else the shared top-level `[tiers]` (mirrors @cq/config's per-harness
 * layering). A tier VALUE is either an `[aliases]` NAME (checked first) or a
 * direct token. Returns null if no tiers map applies, the slot is unconfigured,
 * or the value is unparseable (lenient: null, not throw).
 */
function resolveTierToken(config: CqConfigSubset, tier: string, activeHarness: string): CqToken | null {
  const tiers = config.harnessTiers[activeHarness] ?? config.tiers;
  if (!tiers) return null;
  const value = tiers[tier];
  if (value === undefined) return null;
  const aliased = config.aliases[value];
  return parseCqToken(aliased !== undefined ? aliased : value);
}

/**
 * Resolve an agent end-to-end: agent name -> tier -> token (for the active
 * harness's tier map). MIRRORS @cq/config resolveAgentModel. Returns null when
 * no tiered model applies (caller then falls back to the parent session's
 * active model).
 */
function resolveAgentToken(config: CqConfigSubset, agentName: string, activeHarness: string): CqToken | null {
  return resolveTierToken(config, resolveAgentTier(config, agentName), activeHarness);
}

/**
 * Map a resolved `<harness>:<model>` token to the child `pi -p` process's
 * provider/model selection.
 *
 * - `pi:<provider>/<model>`: the pi model segment MUST carry an explicit
 *   `provider/model` qualifier; the provider half is emitted as `--provider`
 *   and the model half as `--model`, BOTH non-empty. A BARE pi segment (NO
 *   `/`) is REFUSED → null; an empty half (`p/` or `/m`) is also REFUSED →
 *   null. This MIRRORS @cq/config's parseReviewerToken (T231,
 *   packages/cq-config/src/config.ts), which THROWS on a bare/empty-half pi
 *   token: both REFUSE bare (parseReviewerToken throws; this lenient mirror
 *   returns null, so the caller falls back to the parent model rather than
 *   dispatching provider-less — exactly D36). A bare `pi:<model>` MUST NOT be
 *   dispatched with a null provider.
 * - `claude:<model>`: a Claude provider CANNOT be driven by a child `pi -p`
 *   process, so this yields null — the caller falls back to the parent's model.
 *   (A `/` qualifier is pi-only; claude carries no provider here either way.)
 *   The token's `effort` is recorded INERTLY on the dispatch details by the
 *   caller (so it is observable) but is NEVER passed to the child.
 *
 * EFFORT (R342): for a pi token, the resolved `effort` is carried through so
 * the caller can append it to the child `--model` as the
 * `<provider>/<model>:<effort>` thinking-level SHORTHAND — pi has NO separate
 * `--thinking`-style flag in the child token; the level rides on `--model`.
 *
 * Returns {provider, model, effort} to pass to the child, or null to fall back.
 */
function tokenToChildModel(token: CqToken): { provider: string | null; model: string; effort: string | null } | null {
  if (token.harness !== "pi") return null;
  const slash = token.model.indexOf("/");
  if (slash < 0) return null; // bare pi token — REFUSED (mirror @cq/config THROW)
  const provider = token.model.slice(0, slash);
  const model = token.model.slice(slash + 1);
  if (provider === "" || model === "") return null; // empty half — REFUSED
  return { provider, model, effort: token.effort };
}

/** Read + parse the named agent markdown from the cq-agents directory. */
// Lenient line-based frontmatter parser for the cq agent markdowns.
//
// We deliberately do NOT use pi's exported `parseFrontmatter` (a strict YAML
// `parse`): the cq agent frontmatter carries long, unquoted `description:`
// values that contain colons, which strict YAML rejects with
// "Nested mappings are not allowed in compact mappings". The cq frontmatter is
// a flat set of single-line `key: value` scalars (name/description/
// disallowedTools/isolation), so splitting each line on its FIRST colon parses
// every cq agent robustly without quoting the source (cq-assets is read-only).
function parseFlatFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Tolerate trailing whitespace on the `---` delimiter lines (and a missing
  // trailing newline after the closing delimiter) so a slightly off-spec
  // markdown variant doesn't silently yield an empty frontmatter (which would
  // drop the agent's disallowedTools and weaken the child's tool filtering).
  const open = normalized.match(/^---[ \t]*\n/);
  if (!open) return { frontmatter: {}, body: normalized.trim() };
  const rest = normalized.slice(open[0].length);
  const close = rest.match(/\n[ \t]*---[ \t]*(?:\n|$)/);
  if (!close || close.index === undefined) return { frontmatter: {}, body: normalized.trim() };
  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).trim();
  const frontmatter: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    frontmatter[key] = line.slice(colon + 1).trim();
  }
  return { frontmatter, body };
}

function loadAgent(agentsDir: string, agentName: string): AgentDefinition | null {
  // Path-traversal guard: `agentName` is caller-controlled (an LLM tool arg), so
  // it must be a bare filename — no path separators, no "..", no leading dot —
  // before it is joined into a filesystem path. Otherwise a name like
  // "../../secret" would let readFileSync escape agentsDir and surface arbitrary
  // *.md content as the child's system prompt.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentName) || agentName.includes("..")) {
    return null;
  }
  const filePath = path.join(agentsDir, `${agentName}.md`);
  // Defense in depth: the resolved file must live directly inside agentsDir.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(agentsDir)) {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFlatFrontmatter(content);
  const disallowedTools = (frontmatter.disallowedTools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: frontmatter.name ?? agentName,
    description: frontmatter.description ?? "",
    disallowedTools,
    systemPrompt: body,
    filePath,
  };
}

// The cq/Claude tool names that appear in agent frontmatter `disallowedTools`
// do not all map 1:1 to pi's built-in tool names. Map the ones that do; pi
// silently ignores unknown names in an --exclude-tools denylist, so passing the
// originals through is harmless, but mapping the common ones keeps the denylist
// meaningful. `Agent` (Claude's dispatch tool) maps to this extension's
// dispatch tool name so the child can never re-dispatch.
const CQ_TO_PI_TOOL: Record<string, string> = {
  Agent: DISPATCH_TOOL_NAME,
  Bash: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Read: "read",
  Grep: "grep",
  Glob: "find",
  NotebookEdit: "edit",
};

/**
 * Build the child's --exclude-tools denylist from the agent's disallowedTools,
 * always including DISPATCH_TOOL_NAME so the child cannot re-dispatch.
 */
function buildExcludeTools(disallowedTools: string[]): string[] {
  const excluded = new Set<string>([DISPATCH_TOOL_NAME]);
  for (const cqName of disallowedTools) {
    excluded.add(CQ_TO_PI_TOOL[cqName] ?? cqName);
  }
  return [...excluded];
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-dispatch-"));
  // If the write fails after the dir was created, clean it up here — otherwise
  // the caller's try/finally (which it enters only AFTER this returns) never
  // runs and the temp dir leaks.
  try {
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(dir, `system-${safeName}.md`);
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir, filePath };
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

// Resolve how to re-invoke pi for the child process. Mirrors the upstream
// subagent example: prefer the current script under the real runtime, else fall
// back to the `pi` binary on PATH.
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

interface AssistantPart {
  type: string;
  text?: string;
}
interface ChildMessage {
  role?: string;
  content?: AssistantPart[];
  /** Pi tags each assistant message with the provider/model it ran against. */
  provider?: string;
  model?: string;
}

/** Walk back to the last assistant message and join ALL its text parts. */
function getFinalOutput(messages: ChildMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((part): part is AssistantPart & { text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
}

function capOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= OUTPUT_CAP_BYTES) return output;
  let truncated = output.slice(0, OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP_BYTES) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated to ${OUTPUT_CAP_BYTES} bytes.]`;
}

// Build a text tool-result. Errors are surfaced in the text content and in
// `details.exitCode` (the AgentToolResult type carries no `isError` field).
function textResult(text: string, details: DispatchDetails): AgentToolResult<DispatchDetails> {
  return { content: [{ type: "text", text }], details };
}

export default function cqSubagentDispatch(pi: ExtensionAPI): void {
  pi.registerTool<typeof DispatchParams, DispatchDetails>({
    name: DISPATCH_TOOL_NAME,
    label: "Dispatch cq agent",
    description: [
      "Dispatch a named cq subagent with a task, running it as an isolated child pi turn",
      "with a filtered toolset. The child cannot itself re-dispatch. Returns the child's",
      "final output as text. Args: { agent, task, isolation? }.",
    ].join(" "),
    parameters: DispatchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<DispatchDetails>> {
      const args = params as DispatchArgs;
      const agentsDir = resolveAgentsDir();
      const cqConfigPath = resolveCqConfigPath(ctx.cwd);

      const baseDetails: DispatchDetails = {
        agent: args.agent,
        agentFile: null,
        // Echo the requested isolation mode. Worktree isolation is a deferred
        // seam (Q128 — explorer/reviewer dispatches need no worktree); recording
        // it keeps the {agent,task,isolation?} convention shape observable for
        // the follow-up that implements it, rather than silently ignoring it.
        isolation: args.isolation ?? null,
        model: null,
        provider: null,
        modelSource: "parent",
        childEffort: null,
        resolvedTier: null,
        childProvider: null,
        childModel: null,
        exitCode: 0,
        excludedTools: [],
        cqConfigPath,
        stderr: "",
      };

      const agent = loadAgent(agentsDir, args.agent);
      if (!agent) {
        return textResult(
          `Unknown cq agent: "${args.agent}". Looked in ${agentsDir} (set ${AGENTS_DIR_ENV} to override).`,
          { ...baseDetails, exitCode: 1 },
        );
      }

      const excludeTools = buildExcludeTools(agent.disallowedTools);

      // ── Resolve the child model (T225) ──────────────────────────────────
      // Precedence: explicit `model` arg > agent tier ([agent_tiers]->[tiers])
      // > parent session's active model. The agent's tier SOURCE is the cq.toml
      // `[agent_tiers]` table keyed by agent NAME — NOT the agent markdown
      // frontmatter (which stays byte-identical per Q126/K44).
      const parentModel = ctx.model?.id ?? null;
      const parentProvider = ctx.model?.provider ?? null;

      let model: string | null = parentModel;
      let provider: string | null = parentProvider;
      let modelSource: "explicit" | "tier" | "parent" = "parent";
      let resolvedTier: string | null = null;
      // R342: the resolved effort recorded on the details (observable). For a
      // pi child it ALSO rides on --model as the `<provider>/<model>:<effort>`
      // shorthand; for a claude token (parent fallback) it is recorded here
      // inertly and NOT passed to the child.
      let childEffort: string | null = null;
      // The effort to actually APPEND to the child --model. Distinct from the
      // inert `childEffort`: it is set ONLY on the pi path (a real child model
      // resolved from a pi token), never on the claude parent-fallback path.
      let emittedEffort: string | null = null;

      const explicit = args.model && args.model.trim().length > 0 ? args.model.trim() : null;
      if (explicit !== null) {
        // An explicit override may be a "<harness>:<model>[:<effort>]" token or
        // a bare pi --model pattern (a non-token string with no ':').
        // tokenToChildModel REFUSES (→null) a claude: token (can't drive a child
        // pi process) AND a bare/empty-half pi: token (must be
        // "pi:<provider>/<model>", mirror of @cq/config); a null child keeps the
        // parent-model fallback. A claude token's effort is still recorded
        // inertly below.
        const token = parseCqToken(explicit);
        const child = token ? tokenToChildModel(token) : { provider: null, model: explicit, effort: null };
        if (child !== null) {
          model = child.model;
          provider = child.provider;
          childEffort = child.effort;
          emittedEffort = child.effort;
          modelSource = "explicit";
        } else if (token !== null) {
          // claude: override -> keep the parent-model fallback, but record the
          // requested effort INERTLY (observable, never passed to the child).
          childEffort = token.effort;
        }
      } else {
        // Tier resolution from the agent NAME via cq.toml, using the active
        // harness's [harness.<harness>.tiers] map (else the shared [tiers]).
        const config = loadCqConfig(cqConfigPath);
        if (config !== null) {
          const activeHarness = resolveActiveHarness();
          resolvedTier = resolveAgentTier(config, agent.name);
          const token = resolveAgentToken(config, agent.name, activeHarness);
          const child = token ? tokenToChildModel(token) : null;
          if (child !== null) {
            model = child.model;
            provider = child.provider;
            childEffort = child.effort;
            emittedEffort = child.effort;
            modelSource = "tier";
          } else if (token !== null) {
            // claude: tier -> parent-model fallback; record effort inertly.
            childEffort = token.effort;
          }
          // else: no [tiers]/slot -> parent-model fallback.
        }
      }

      // The child is a plain `pi -p` process launched WITHOUT
      // `--extension cq-subagent-dispatch.ts`. We do NOT pass `--no-extensions`
      // because the provider-registering package extensions (e.g. pi-xai's
      // grok-build) must still load for the child's model to resolve. The
      // re-dispatch guard is the `--exclude-tools` denylist below, which always
      // contains DISPATCH_TOOL_NAME — so even if the dispatch extension is
      // discovered via settings, its tool is filtered out of the child.
      const childArgs: string[] = ["--mode", "json", "-p", "--no-session"];
      if (provider) childArgs.push("--provider", provider);
      if (model) {
        // R342: pi's reasoning-effort mechanism is the thinking-level SHORTHAND
        // appended to the --model token (`<provider>/<model>:<effort>`), NOT a
        // separate --thinking flag. Append `emittedEffort` — set ONLY on the pi
        // path (a real child model resolved from a pi token); it is NEVER set on
        // the claude parent-fallback path, so the parent model is never
        // contaminated with a claude effort. The pi CLI documents `--model
        // <pattern>` as supporting an optional `:<thinking>` suffix
        // (off/minimal/low/medium/high/xhigh).
        childArgs.push("--model", emittedEffort ? `${model}:${emittedEffort}` : model);
      }
      if (excludeTools.length > 0) childArgs.push("--exclude-tools", excludeTools.join(","));

      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
      childArgs.push("--append-system-prompt", tmp.filePath);
      childArgs.push(args.task);

      const details: DispatchDetails = {
        ...baseDetails,
        agentFile: agent.filePath,
        model,
        provider,
        modelSource,
        childEffort,
        resolvedTier,
        excludedTools: excludeTools,
      };

      const messages: ChildMessage[] = [];
      let stderr = "";

      try {
        const exitCode = await new Promise<number>((resolve) => {
          const invocation = getPiInvocation(childArgs);
          const proc = spawn(invocation.command, invocation.args, {
            cwd: ctx.cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let buffer = "";

          const processLine = (line: string): void => {
            if (!line.trim()) return;
            let event: { type?: string; message?: ChildMessage };
            try {
              event = JSON.parse(line) as { type?: string; message?: ChildMessage };
            } catch {
              return;
            }
            if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
              messages.push(event.message);
            }
          };

          proc.stdout.on("data", (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
          });
          proc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          proc.on("close", (code) => {
            if (buffer.trim()) processLine(buffer);
            resolve(code ?? 0);
          });
          proc.on("error", () => resolve(1));

          if (signal) {
            const killProc = (): void => {
              proc.kill("SIGTERM");
              setTimeout(() => {
                if (!proc.killed) proc.kill("SIGKILL");
              }, 5000);
            };
            if (signal.aborted) killProc();
            else signal.addEventListener("abort", killProc, { once: true });
          }
        });

        details.exitCode = exitCode;
        details.stderr = stderr;

        // Capture the provider/model the child actually opened against — Pi
        // tags each assistant message with them. This is the observable T225
        // evidence: it confirms the child ran under the tier-resolved model.
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.role === "assistant" && (m.provider || m.model)) {
            details.childProvider = m.provider ?? null;
            details.childModel = m.model ?? null;
            break;
          }
        }

        const finalText = getFinalOutput(messages);
        if (exitCode !== 0 && !finalText) {
          return textResult(
            `Agent "${agent.name}" exited with code ${exitCode}.\n${stderr || "(no output)"}`,
            details,
          );
        }
        return textResult(capOutput(finalText || "(no output)"), details);
      } finally {
        try {
          fs.rmSync(tmp.dir, { recursive: true, force: true });
        } catch {
          /* ignore cleanup failure */
        }
      }
    },
  });
}
