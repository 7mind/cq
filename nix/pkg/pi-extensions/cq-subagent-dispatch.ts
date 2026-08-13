import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  launchPiChild,
  type LaunchedPiChild,
} from "./cq-subagent-process-lifecycle.ts";
import {
  PI_NATIVE_SESSION_SEAM,
  PI_PROCESS_SESSION_SEAM,
  createProductionPiNativeSessionDependencies,
  runPiNativeSession,
  type PiNativeSessionDependencies,
  type PiNativeSessionResult,
} from "./cq-subagent-native-session.ts";

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
// The cq.toml read strategy is PINNED in decisions:K46: $CQ_CONFIG (default
// $CQ_PROJECT_ROOT/cq.toml, fallback <cwd>/cq.toml), parsed with an INLINED
// flat-table TOML reader + INLINED resolver that MIRRORS @cq/config's
// resolveAgentTier/resolveTierToken/resolveAgentModel (T223,
// packages/cq-config/src/{config,toml}.ts). It is COPIED, not imported: this is
// a standalone store-path extension OUTSIDE the cq-ledgers bun workspace and
// cannot import @cq/config.

const DISPATCH_TOOL_NAME = "dispatch_agent";

/**
 * Test seam: when set, the native session path uses this dependency bundle
 * instead of the production createAgentSession wiring.
 */
let piNativeSessionDependenciesOverride: PiNativeSessionDependencies | null = null;

/** Test-only: inject createAgentSession dependencies for the native path. */
export function setPiNativeSessionDependenciesForTests(
  dependencies: PiNativeSessionDependencies | null,
): void {
  piNativeSessionDependenciesOverride = dependencies;
}

/** Production launchPiChild; tests may override to spy / refuse. */
type LaunchPiChildFn = (
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
) => Promise<LaunchedPiChild>;

let launchPiChildOverride: LaunchPiChildFn | null = null;

/** Test-only: spy or stub the process-seam launcher. */
export function setLaunchPiChildForTests(fn: LaunchPiChildFn | null): void {
  launchPiChildOverride = fn;
}

function launchPiChildSeam(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<LaunchedPiChild> {
  const impl = launchPiChildOverride ?? launchPiChild;
  return impl(argv, cwd, env, signal);
}

/**
 * T1699: forceShellout from CQ_DISPATCH_FORCE_SHELLOUT env ("true"/"1"),
 * default false — mirrors @cq/config [dispatch].forceShellout.
 */
export function resolveForceShellout(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.CQ_DISPATCH_FORCE_SHELLOUT;
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** T1699 delivery matrix (pure). */
export function selectPiChildDeliverySeam(input: {
  readonly activeHarness: string;
  readonly forceShellout: boolean;
}): typeof PI_NATIVE_SESSION_SEAM | typeof PI_PROCESS_SESSION_SEAM {
  if (input.activeHarness === "pi" && input.forceShellout === false) {
    return PI_NATIVE_SESSION_SEAM;
  }
  return PI_PROCESS_SESSION_SEAM;
}

/**
 * Runtime delivery branch used by dispatch_agent execute. Extracted so tests
 * can drive the REAL branch (not only pure select) and spy launchPiChild.
 */
export async function executePiChildDeliveryBranch<TNative, TProcess>(input: {
  readonly activeHarness: string;
  readonly forceShellout: boolean;
  readonly native: () => Promise<TNative>;
  readonly process: () => Promise<TProcess>;
}): Promise<
  | { readonly seam: typeof PI_NATIVE_SESSION_SEAM; readonly result: TNative }
  | { readonly seam: typeof PI_PROCESS_SESSION_SEAM; readonly result: TProcess }
> {
  const seam = selectPiChildDeliverySeam({
    activeHarness: input.activeHarness,
    forceShellout: input.forceShellout,
  });
  if (seam === PI_NATIVE_SESSION_SEAM) {
    return { seam, result: await input.native() };
  }
  return { seam, result: await input.process() };
}

export interface PiNativeDeliveryRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly effort?: string | null;
  readonly excludeTools?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * Same-harness native delivery body (createAgentSession path). Shared by
 * dispatch execute and topology-spy tests so the spy covers the real branch.
 */
export async function runPiNativeDelivery(
  request: PiNativeDeliveryRequest,
): Promise<PiNativeSessionResult> {
  const nativeDeps =
    piNativeSessionDependenciesOverride ??
    (await createProductionPiNativeSessionDependencies());
  const nativeResult = await runPiNativeSession(
    {
      cwd: request.cwd,
      prompt: request.prompt,
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      ...(request.model === undefined || request.model === null ? {} : { model: request.model }),
      ...(request.provider === undefined || request.provider === null
        ? {}
        : { provider: request.provider }),
      ...(request.effort === undefined || request.effort === null ? {} : { effort: request.effort }),
      ...(request.excludeTools === undefined ? {} : { excludeTools: request.excludeTools }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
    nativeDeps,
  );
  if (nativeResult.usedLaunchPiChild !== false) {
    throw new Error("Pi native session path must not call launchPiChild");
  }
  return nativeResult;
}
const LEDGER_DIRECT_TOOL_PREFIX = "ledger_";

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
  /** Role-specific ledger tools that remain visible to the child. */
  roleTools: string[];
  /** Dispatch input/result tools kept separate from role domain access. */
  transportTools: string[];
  /** Ledger tool complement removed before child prompt construction. */
  excludedLedgerTools: string[];
  /** The markdown body, injected as the child's appended system prompt. */
  systemPrompt: string;
  filePath: string;
}

interface RoleToolProfileManifest {
  readonly schemaVersion: 1;
  readonly ledgerToolNames: readonly string[];
  readonly roles: Readonly<
    Record<
      string,
      {
        readonly roleTools: readonly string[];
        readonly transportTools: readonly string[];
        readonly excludedTools: readonly string[];
      }
    >
  >;
}

interface DispatchDetails {
  agent: string;
  agentFile: string | null;
  /**
   * Echoes the requested isolation mode. Under G121/G163, confinement is
   * orchestrator-owned via worktree_manage + parent cwd (not a Q128-allocated
   * tree inside this tool). When `worktree` is requested, `isolationNote`
   * records that disclosure so callers cannot mistake the flag for allocation.
   */
  isolation: "worktree" | null;
  /** Present when isolation was requested; documents the real confinement owner. */
  isolationNote: string | null;
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
  roleTools: string[];
  transportTools: string[];
  cqConfigPath: string;
  stderr: string;
  /** T1699: which child-delivery seam was used. */
  deliverySeam: typeof PI_NATIVE_SESSION_SEAM | typeof PI_PROCESS_SESSION_SEAM | null;
  /** T1699: manager-bound cwd for native session (null on process seam). */
  nativeSessionCwd: string | null;
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
      description:
        'Optional isolation mode. Only "worktree" is recognized. It does NOT allocate a worktree inside this tool (G121/G163): the orchestrator must prepare via worktree_manage and dispatch with cwd already bound to the manager-returned path. The flag is recorded for observability and matched against parent-cwd confinement.',
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
// cq-ledgers workspace. The only cq.toml tables this needs are the four FLAT
// `key = "value"` tables `[aliases]`, `[tiers]`, `[agent_tiers]`, and
// `[agent_efforts]`; we do not need a full TOML 1.0 parser (the smol-toml dep
// @cq/config uses), only a flat-table reader. Anything outside these four
// tables is ignored.

// ── Effort vocabulary — mirror of @cq/config (T284/T286) ─────────────────────
//
// MIRROR of @cq/config (packages/cq-config/src/types.ts PI_EFFORTS /
// CLAUDE_EFFORTS) — keep in sync. Copied, NOT imported (standalone store-path
// extension outside the cq-ledgers workspace). These are the closed
// per-harness vocabularies of the trailing `:<effort>` suffix, spanning the
// union of what pi's providers accept: off/minimal remain for providers using
// those spellings, and none/max cover the GPT-5.6 reasoning-effort range
// (none/low/medium/high/xhigh/max) — all accepted by the
// `--model provider/model:<effort>` shorthand.
const PI_EFFORTS = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
 *
 * Exported (with CqConfigSubset, parseFlatToml, and resolveAgentToken) for the
 * [agent_efforts] equivalence test in cq-subagent-dispatch.test.ts.
 */
export interface CqToken {
  harness: string;
  model: string;
  effort: string | null;
}

/** The subset of cq.toml this extension reads. */
export interface CqConfigSubset {
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
  /**
   * The `[agent_efforts]` per-agent effort override (Q254): agent name ->
   * effort name; `{}` when absent (mirrors @cq/config). ORTHOGONAL to
   * `[agent_tiers]`: the tier axis picks the MODEL; this axis overrides the
   * resolved token's EFFORT (applyAgentEffort below).
   */
  agentEfforts: Record<string, string>;
}

const VALID_TIERS = new Set(["fast", "standard", "frontier"]);
// MIRRORS @cq/config DEFAULT_TIER: an agent with no [agent_tiers] entry is
// "standard".
const DEFAULT_TIER = "standard";
// The four flat tables this reader understands; any other `[section]` header
// switches the reader into an ignored section.
const FLAT_TABLES = new Set(["aliases", "tiers", "agent_tiers", "agent_efforts"]);

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
 * INLINED flat-table TOML reader. Parses ONLY `[aliases]`, `[tiers]`,
 * `[agent_tiers]`, and `[agent_efforts]` as flat `key = "value"` string tables;
 * every other section (e.g. `[webui]`, top-level `reviewers = [...]` arrays) is
 * ignored. Returns `null` for a table that never appeared, `{}` for a table
 * that appeared empty (mirroring @cq/config's "absent => null" distinction for
 * [tiers]/[agent_tiers] and its "absent => {}" default for [agent_efforts]).
 */
export function parseFlatToml(source: string): CqConfigSubset {
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
    agentEfforts: tables.agent_efforts ?? {},
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
 * Apply the `[agent_efforts]` per-agent effort override to a resolved token
 * (Q254). MIRRORS @cq/config applyAgentEffort
 * (packages/cq-config/src/config.ts), with the SAME semantics:
 *  - `[agent_efforts]` has an entry for `agentName` -> the returned token's
 *    `effort` IS that override (override wins over the tier token's
 *    `:<effort>` suffix, including when the suffix is absent);
 *  - no entry -> `token` is returned unchanged (tier token effort applies).
 *
 * The override is validated against the RESOLVED token's harness via isEffort,
 * exactly like the canonical. The only divergence is the FAILURE MODE, per this
 * file's pinned lenient policy (see parseCqToken): @cq/config FAILS FAST
 * (throws CqConfigError) on an effort invalid for the resolved harness; this
 * lenient mirror returns `null` instead, so the caller degrades to the parent
 * session's model rather than dispatching a contaminated token.
 */
function applyAgentEffort(config: CqConfigSubset, agentName: string, token: CqToken): CqToken | null {
  const override = config.agentEfforts[agentName];
  if (override === undefined) {
    return token;
  }
  if (!isEffort(token.harness, override)) {
    return null; // lenient mirror of @cq/config's fail-fast throw
  }
  return { ...token, effort: override };
}

/**
 * Resolve an agent end-to-end: agent name -> tier -> token (for the active
 * harness's tier map), then the `[agent_efforts]` per-agent effort override
 * (Q254) — MIRRORS @cq/config resolveAgentModel's pipeline
 * (resolveAgentTier -> tierModel -> applyAgentEffort). Returns null when no
 * tiered model applies, or when the agent's effort override is invalid for the
 * resolved harness (lenient mirror of the canonical throw) — the caller then
 * falls back to the parent session's active model.
 */
export function resolveAgentToken(config: CqConfigSubset, agentName: string, activeHarness: string): CqToken | null {
  const token = resolveTierToken(config, resolveAgentTier(config, agentName), activeHarness);
  if (token === null) return null;
  return applyAgentEffort(config, agentName, token);
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

function stringArray(value: unknown, pathLabel: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${pathLabel}: expected an array of non-empty tool names`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${pathLabel}: duplicate tool decision`);
  }
  return value as readonly string[];
}

function loadRoleToolDecision(
  agentsDir: string,
  roleId: string,
): {
  readonly roleTools: string[];
  readonly transportTools: string[];
  readonly excludedTools: string[];
} {
  const manifestPath = path.join(
    path.dirname(path.resolve(agentsDir)),
    "role-tool-profiles.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error(
      `role tool profile manifest is unavailable or invalid: ${manifestPath}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${manifestPath}: expected a role tool profile object`);
  }
  const manifest = parsed as Partial<RoleToolProfileManifest>;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${manifestPath}: unsupported role tool profile schema`);
  }
  const inventory = stringArray(
    manifest.ledgerToolNames,
    `${manifestPath}.ledgerToolNames`,
  );
  if (
    typeof manifest.roles !== "object" ||
    manifest.roles === null ||
    Array.isArray(manifest.roles)
  ) {
    throw new Error(`${manifestPath}.roles: expected a role decision map`);
  }
  const decision = manifest.roles[roleId];
  if (decision === undefined) {
    throw new Error(
      `${manifestPath}: no tool profile decision for role "${roleId}"`,
    );
  }
  const roleTools = stringArray(
    decision.roleTools,
    `${manifestPath}.roles.${roleId}.roleTools`,
  );
  const transportTools = stringArray(
    decision.transportTools,
    `${manifestPath}.roles.${roleId}.transportTools`,
  );
  const excludedTools = stringArray(
    decision.excludedTools,
    `${manifestPath}.roles.${roleId}.excludedTools`,
  );
  const decisions = [...roleTools, ...transportTools, ...excludedTools];
  const decisionSet = new Set(decisions);
  const inventorySet = new Set(inventory);
  const unknownTool = decisions.find((tool) => !inventorySet.has(tool));
  const undecidedTool = inventory.find((tool) => !decisionSet.has(tool));
  if (
    unknownTool !== undefined ||
    undecidedTool !== undefined ||
    decisionSet.size !== decisions.length ||
    decisionSet.size !== inventorySet.size
  ) {
    const detail =
      unknownTool !== undefined
        ? `unknown tool "${unknownTool}"`
        : undecidedTool !== undefined
          ? `tool "${undecidedTool}" lacks a profile decision`
          : "one tool has multiple profile decisions";
    throw new Error(`${manifestPath}.roles.${roleId}: ${detail}`);
  }
  return {
    roleTools: [...roleTools],
    transportTools: [...transportTools],
    excludedTools: [...excludedTools],
  };
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
  const roleId = frontmatter.name ?? agentName;
  if (roleId !== agentName) {
    throw new Error(
      `agent frontmatter name "${roleId}" does not match assigned role "${agentName}"`,
    );
  }
  const toolDecision = loadRoleToolDecision(agentsDir, roleId);
  return {
    name: roleId,
    description: frontmatter.description ?? "",
    disallowedTools,
    roleTools: toolDecision.roleTools,
    transportTools: toolDecision.transportTools,
    excludedLedgerTools: toolDecision.excludedTools,
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
function buildExcludeTools(disallowedTools: string[], excludedLedgerTools: string[]): string[] {
  const excluded = new Set<string>([DISPATCH_TOOL_NAME]);
  for (const cqName of disallowedTools) {
    excluded.add(CQ_TO_PI_TOOL[cqName] ?? cqName);
  }
  for (const ledgerTool of excludedLedgerTools) {
    excluded.add(`${LEDGER_DIRECT_TOOL_PREFIX}${ledgerTool}`);
  }
  return [...excluded];
}

function assertActiveLedgerToolDecisions(
  activeToolNames: readonly string[],
  roleTools: readonly string[],
  transportTools: readonly string[],
  excludedLedgerTools: readonly string[],
): void {
  const decidedTools = new Set([...roleTools, ...transportTools, ...excludedLedgerTools]);
  const undecidedTool = activeToolNames.find(
    (toolName) =>
      toolName.startsWith(LEDGER_DIRECT_TOOL_PREFIX) &&
      !decidedTools.has(toolName.slice(LEDGER_DIRECT_TOOL_PREFIX.length)),
  );
  if (undecidedTool !== undefined) {
    throw new Error(`active registered ledger tool "${undecidedTool}" lacks a profile decision`);
  }
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
export interface ChildMessage {
  role?: string;
  content?: AssistantPart[];
  /** Pi tags each assistant message with the provider/model it ran against. */
  provider?: string;
  model?: string;
}

export function parseChildJsonEvent(line: string): ChildMessage | null {
  if (!line.trim()) return null;
  let event: { type?: string; message?: ChildMessage };
  try {
    event = JSON.parse(line) as { type?: string; message?: ChildMessage };
  } catch {
    return null;
  }
  if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
    return event.message;
  }
  return null;
}

/** Walk back to the last assistant message and join ALL its text parts. */
export function getFinalOutput(messages: ChildMessage[]): string {
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
        // Isolation is advisory under G121/G163: confinement is parent-cwd +
        // worktree_manage, not allocated here. Always disclose when requested
        // so the flag cannot be mistaken for Q128-style throwaway allocation.
        isolation: args.isolation ?? null,
        isolationNote:
          args.isolation === "worktree"
            ? "isolation:worktree does not allocate a tree; confinement is orchestrator worktree_manage + parent cwd (G121/G163). Child runs at ctx.cwd."
            : null,
        model: null,
        provider: null,
        modelSource: "parent",
        childEffort: null,
        resolvedTier: null,
        childProvider: null,
        childModel: null,
        exitCode: 0,
        excludedTools: [],
        roleTools: [],
        transportTools: [],
        cqConfigPath,
        stderr: "",
        deliverySeam: null,
        nativeSessionCwd: null,
      };

      const agent = loadAgent(agentsDir, args.agent);
      if (!agent) {
        return textResult(
          `Unknown cq agent: "${args.agent}". Looked in ${agentsDir} (set ${AGENTS_DIR_ENV} to override).`,
          { ...baseDetails, exitCode: 1 },
        );
      }

      assertActiveLedgerToolDecisions(
        pi.getActiveTools(),
        agent.roleTools,
        agent.transportTools,
        agent.excludedLedgerTools,
      );
      const excludeTools = buildExcludeTools(agent.disallowedTools, agent.excludedLedgerTools);

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
        roleTools: agent.roleTools,
        transportTools: agent.transportTools,
      };

      const messages: ChildMessage[] = [];
      let stderr = "";

      try {
        // T1699 / D160: same-harness forceShellout=false uses createAgentSession
        // ({cwd, model, thinkingLevel}) with the manager-returned path (ctx.cwd).
        // Forced shellout and cross-harness remain on the registered process seam
        // (launchPiChild). Delivery goes through executePiChildDeliveryBranch so
        // topology spies cover the real branch.
        const forceShellout = resolveForceShellout();
        const activeHarness = resolveActiveHarness();

        const delivery = await executePiChildDeliveryBranch({
          activeHarness,
          forceShellout,
          native: async () => {
            details.deliverySeam = PI_NATIVE_SESSION_SEAM;
            details.nativeSessionCwd = ctx.cwd;
            return runPiNativeDelivery({
              cwd: ctx.cwd,
              prompt: args.task,
              systemPrompt: agent.systemPrompt,
              model,
              provider,
              effort: emittedEffort,
              excludeTools,
              ...(signal === undefined ? {} : { signal }),
            });
          },
          process: async () => {
            details.deliverySeam = PI_PROCESS_SESSION_SEAM;
            details.nativeSessionCwd = null;
            const invocation = getPiInvocation(childArgs);
            // Strip the codex-inline companion env before spawning the child pi.
            // When this extension runs under a codex orchestrator (openai-codex
            // provider), the process carries CODEX_COMPANION_SESSION_ID /
            // CLAUDE_PLUGIN_DATA; a child pi that inherits them BLOCKS INDEFINITELY
            // on the companion handshake whenever the companion is down or busy —
            // an output-less hang that makes the auto-driver's waitForIdle stall
            // for the whole dispatch. This is the SAME hazard the pi:* shellout
            // mitigates with `env -u … pi -p … </dev/null`; detaching stdin
            // (stdio[0]="ignore", below) is the other half of that mitigation.
            const childEnv = { ...process.env };
            delete childEnv.CODEX_COMPANION_SESSION_ID;
            delete childEnv.CLAUDE_PLUGIN_DATA;
            return launchPiChildSeam(
              [invocation.command, ...invocation.args],
              ctx.cwd,
              childEnv,
              signal,
            );
          },
        });

        if (delivery.seam === PI_NATIVE_SESSION_SEAM) {
          const nativeResult = delivery.result;
          details.exitCode = 0;
          details.stderr = "";
          return textResult(capOutput(nativeResult.finalText || "(no output)"), details);
        }

        const launched = delivery.result;
        const proc = launched.process;
        if (proc.stdout === null || proc.stderr === null) {
          throw new Error("registered Pi child launch returned no output pipes");
        }
        let buffer = "";

        const processLine = (line: string): void => {
          const message = parseChildJsonEvent(line);
          if (message !== null) messages.push(message);
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

        const exitCode = await launched.exited;
        if (buffer.trim()) processLine(buffer);

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

// ─────────────────────────────────────────────────────────────────────────────
// D190 / T1266 — attested role-contract validation on the packaged Pi surface.
//
// MEASUREMENT (T1266 acceptance §1): the packaged pi-extension runtime cannot
// resolve Ajv (or any other full JSON-Schema implementation). Verified by:
//   cd nix/pkg/pi-extensions && bun -e "try{console.log(import.meta.resolve('ajv'))}catch(e){console.log(String(e))}"
// which reports "Cannot find package 'ajv'". The extension is packaged outside
// the cq-ledgers workspace and cannot import `@cq/config` either (K46
// copy-not-import). typebox is present transitively via pi-coding-agent, but it
// validates typebox schemas — not the draft-2020-12 sidecar documents.
//
// PATH TAKEN: a recursive checker over the ATTESTED schema bytes that enforces
// the structural baseline (type / properties / required / additionalProperties /
// items / oneOf) PLUS exactly the seven keywords D190 named as previously
// unenforceable: enum, pattern, minLength, minItems, allOf, if, not. `const`,
// `then`, and `else` are evaluated only as support for `if` (without them `if`
// is inert).
//
// DISCLOSED RESIDUAL (keywords present in shipped sidecars but NOT enforced
// here — D160 class, not a silent gap): anyOf, minimum. `contains` is enforced
// because the implement-worker `if`/`then` mutationTable rule is gated on it;
// leaving it inert would false-match empty filesTouched and reject valid
// results. Full draft 2020-12 fidelity remains a packaging-of-Ajv (or
// equivalent) follow-up; this module does NOT silently fall back to the
// structural projection when the attested artifact is present.
//
// FALLBACK: when the attested schema artifact is ABSENT the structural
// projection is used, and the fallback is LOUD (returns `warning` + emits via
// the injected `warn` callback). A silent fallback would recreate D190 (K166).
// The prior fidelity-precondition marker is retired: the precondition it named
// is the attested artifact path above.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the packaged prompt surface root is pinned (nix/hm/pi.nix piWrapped). */
export const PROMPT_ROOT_ENV = "CQ_PROMPT_ROOT";

/** The seven D190 keywords this checker adds on top of the structural baseline. */
export const D190_ENFORCED_KEYWORDS = [
  "enum",
  "pattern",
  "minLength",
  "minItems",
  "allOf",
  "if",
  "not",
] as const;

/**
 * Keywords that appear in the shipped sidecars and are intentionally NOT
 * enforced by {@link validateAgainstAttestedSchema}. Named so the gap is a
 * disclosed residual (D160), never an inventory silence (K166).
 */
export const D190_DISCLOSED_RESIDUAL_KEYWORDS = ["anyOf", "minimum"] as const;

/** Capability measurement recorded for T1266 acceptance §1. */
export const PI_EXTENSION_JSON_SCHEMA_CAPABILITY = {
  fullValidatorAvailable: false,
  pathTaken: "seven-keyword-checker" as const,
  enforcedKeywords: D190_ENFORCED_KEYWORDS,
  disclosedResidualKeywords: D190_DISCLOSED_RESIDUAL_KEYWORDS,
  measurement:
    "bun -e resolve('ajv') inside nix/pkg/pi-extensions → Cannot find package 'ajv'; no other draft-2020-12 engine is a runtime dependency",
} as const;

/** Sorted JSON type names a projected property may declare. */
export const CONTRACT_KINDS = [
  "null",
  "boolean",
  "integer",
  "number",
  "string",
  "array",
  "object",
] as const;

export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** One projected schema branch (a `oneOf` member, or the whole schema). */
export interface ContractBranch {
  readonly required: readonly string[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly closed: boolean;
}

/** The projection of one dispatched role's two contracts. */
export interface RoleContractProjection {
  readonly version: number;
  readonly input: readonly ContractBranch[];
  readonly output: readonly ContractBranch[];
}

/** One structured contract violation. */
export interface ContractViolation {
  readonly path: string;
  readonly message: string;
  /** JSON-Schema keyword that failed, when known. */
  readonly keyword?: string;
}

export type RoleContractSide = "input" | "output";

/**
 * Mirrored structural projections, keyed by role id. Re-derived from
 * `DISPATCHED_ROLE_SIDECARS` by the gate test in
 * `packages/cq-config/test/piRefFirstDispatch.test.ts` so a sidecar gaining a
 * role, required key, property, type, or version fails there rather than
 * silently diverging here. Used ONLY as the LOUD absent-artifact fallback.
 */
export const DISPATCHED_ROLE_CONTRACTS: Readonly<Record<string, RoleContractProjection>> = {
  "plan-advance": {
    version: 2,
    input: [
      {
        required: ["goalId"],
        kinds: { candidateMode: ["boolean"], goalId: ["string"] },
        closed: true,
      },
    ],
    output: [
      {
        required: ["action", "mode"],
        kinds: {
          action: ["string"],
          defectsToFile: ["object"],
          finalize: ["object"],
          grounding: ["string"],
          manifest: ["object"],
          mode: ["string"],
          questions: ["array"],
          researches: ["array"],
        },
        closed: true,
      },
      {
        required: ["milestones", "mode", "rationale", "tasks"],
        kinds: {
          milestones: ["array"],
          mode: ["string"],
          rationale: ["string"],
          tasks: ["array"],
        },
        closed: true,
      },
    ],
  },
  "plan-reviewer": {
    version: 1,
    input: [
      {
        required: ["goalId"],
        kinds: { goalId: ["string"] },
        closed: true,
      },
    ],
    output: [
      {
        required: ["criticism", "defects", "new_questions", "summary", "verdict"],
        kinds: {
          criticism: ["array"],
          defects: ["array"],
          new_questions: ["array"],
          summary: ["string"],
          verdict: ["string"],
        },
        closed: true,
      },
    ],
  },
  "implement-worker": {
    version: 8,
    input: [
      {
        required: [
          "acceptance",
          "baseCommit",
          "branch",
          "round",
          "startingCommit",
          "taskId",
        ],
        kinds: {
          acceptance: ["string"],
          baseCommit: ["string"],
          branch: ["string"],
          description: ["string"],
          headline: ["string"],
          inheritedGitReceipts: ["array"],
          priorCriticism: ["array"],
          priorResultCommit: ["null", "string"],
          resolvedModel: ["string"],
          round: ["integer"],
          startingCommit: ["string"],
          taskId: ["string"],
          worktreePath: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: [
          "actualWorktreePath",
          "baseVerification",
          "branch",
          "checkSummary",
          "filesTouched",
          "resultCommit",
          "status",
          "summary",
          "taskId",
        ],
        kinds: {
          actualWorktreePath: ["string"],
          baseVerification: [],
          blockedReason: ["string"],
          branch: ["string"],
          checkSummary: ["string"],
          filesTouched: ["array"],
          gateDurationMs: ["integer"],
          gitReceipts: ["array"],
          mutationTable: ["array"],
          resultCommit: ["null", "string"],
          status: ["string"],
          summary: ["string"],
          supervisedGateEvidence: ["object"],
          taskId: ["string"],
        },
        closed: true,
      },
    ],
  },
  "implement-reviewer": {
    version: 7,
    input: [
      {
        required: [
          "acceptance",
          "baseCommit",
          "branch",
          "gateCompleteBy",
          "responseStoreNow",
          "round",
          "synthesisStoreReserveMs",
          "taskId",
          "workerResult",
        ],
        kinds: {
          acceptance: ["string"],
          baseCommit: ["string"],
          branch: ["string"],
          description: ["string"],
          gateCompleteBy: ["string"],
          headline: ["string"],
          parentGateAttestation: ["object"],
          priorCriticism: ["array"],
          responseStoreNow: ["string"],
          round: ["integer"],
          supervisedGateEvidence: ["object"],
          synthesisStoreReserveMs: [],
          taskId: ["string"],
          workerResult: ["object"],
          worktreePath: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: [
          "baseAncestry",
          "criticism",
          "defects",
          "gateReRan",
          "questions",
          "rationale",
          "resultCommitEvidence",
          "resultCommitVerified",
          "taskId",
          "verdict",
        ],
        kinds: {
          actualWorktreePath: ["string"],
          baseAncestry: [],
          criticism: ["array"],
          defects: ["array"],
          gateDurationMs: ["integer"],
          gateReRan: ["boolean"],
          gateReRanReason: ["string"],
          questions: ["array"],
          rationale: ["string"],
          resultCommitEvidence: [],
          resultCommitVerified: ["boolean"],
          summary: ["string"],
          taskId: ["string"],
          verdict: ["string"],
        },
        closed: true,
      },
    ],
  },
  "implement-conflict-resolver": {
    version: 4,
    input: [
      {
        required: ["baseCommit", "branch", "conflictState", "conflictingFiles", "taskId"],
        kinds: {
          baseCommit: ["string"],
          baseSideNote: ["string"],
          branch: ["string"],
          conflictState: ["object"],
          conflictingFiles: ["array"],
          description: ["string"],
          headline: ["string"],
          taskId: ["string"],
          worktreePath: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: [
          "actualWorktreePath",
          "branch",
          "checkSummary",
          "conflictReceipts",
          "filesResolved",
          "resultCommit",
          "status",
          "summary",
          "taskId",
        ],
        kinds: {
          actualWorktreePath: ["string"],
          blockedReason: ["string"],
          branch: ["string"],
          checkSummary: ["string"],
          conflictReceipts: ["array"],
          filesResolved: ["array"],
          resultCommit: ["null", "string"],
          status: ["string"],
          summary: ["string"],
          taskId: ["string"],
        },
        closed: true,
      },
    ],
  },
  "investigate-explorer": {
    version: 1,
    input: [
      {
        required: ["branchContext", "hypothesisId", "statement"],
        kinds: {
          branchContext: ["string"],
          hypothesisId: ["string"],
          leads: ["array"],
          statement: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: ["evidence", "hypothesisId", "lean"],
        kinds: {
          evidence: ["array"],
          hypothesisId: ["string"],
          lean: ["string"],
          notes: ["string"],
          probeRequest: ["object"],
        },
        closed: true,
      },
    ],
  },
  "investigate-prober": {
    version: 1,
    input: [
      {
        required: ["branchContext", "hypothesisId", "probeRequest", "statement"],
        kinds: {
          branchContext: ["string"],
          hypothesisId: ["string"],
          leads: ["array"],
          probeRequest: ["object"],
          statement: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: ["evidence", "hypothesisId", "lean"],
        kinds: {
          evidence: ["array"],
          hypothesisId: ["string"],
          lean: ["string"],
          notes: ["string"],
        },
        closed: true,
      },
    ],
  },
  "research-explorer": {
    version: 1,
    input: [
      {
        required: ["branchContext", "hypothesisId", "statement"],
        kinds: {
          branchContext: ["string"],
          hypothesisId: ["string"],
          leads: ["array"],
          statement: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: ["evidence", "hypothesisId", "lean"],
        kinds: {
          evidence: ["array"],
          hypothesisId: ["string"],
          lean: ["string"],
          notes: ["string"],
          probeRequest: ["object"],
        },
        closed: true,
      },
    ],
  },
  "research-experimenter": {
    version: 1,
    input: [
      {
        required: ["branchContext", "hypothesisId", "probeRequest", "statement"],
        kinds: {
          branchContext: ["string"],
          hypothesisId: ["string"],
          leads: ["array"],
          probeRequest: ["object"],
          statement: ["string"],
        },
        closed: true,
      },
    ],
    output: [
      {
        required: ["evidence", "hypothesisId", "lean"],
        kinds: {
          evidence: ["array"],
          hypothesisId: ["string"],
          lean: ["string"],
          notes: ["string"],
        },
        closed: true,
      },
    ],
  },
};

export const DISPATCHED_ROLE_IDS: readonly string[] = Object.freeze(
  Object.keys(DISPATCHED_ROLE_CONTRACTS),
);

const ROLE_ID_SET: ReadonlySet<string> = new Set(DISPATCHED_ROLE_IDS);

export function isDispatchedRoleId(roleId: unknown): roleId is string {
  return typeof roleId === "string" && ROLE_ID_SET.has(roleId);
}

export function roleContractFor(roleId: unknown): RoleContractProjection | undefined {
  return isDispatchedRoleId(roleId) ? DISPATCHED_ROLE_CONTRACTS[roleId] : undefined;
}

export function contractKindOf(value: unknown): ContractKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return "object";
  }
}

function kindMatches(declared: readonly string[], value: unknown): boolean {
  if (declared.length === 0) return true;
  const kind = contractKindOf(value);
  if (declared.includes(kind)) return true;
  return kind === "integer" && declared.includes("number");
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBranch(
  branch: ContractBranch,
  value: Readonly<Record<string, unknown>>,
  path: string,
): readonly ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const key of branch.required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      violations.push({
        path: `${path}/${key}`,
        message: "required property is missing",
        keyword: "required",
      });
    }
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    if (!Object.hasOwn(branch.kinds, key)) {
      if (branch.closed) {
        violations.push({
          path: `${path}/${key}`,
          message: "undeclared property",
          keyword: "additionalProperties",
        });
      }
      continue;
    }
    const declared = branch.kinds[key] ?? [];
    if (!kindMatches(declared, value[key])) {
      violations.push({
        path: `${path}/${key}`,
        message: `expected ${declared.join(" | ")}, got ${contractKindOf(value[key])}`,
        keyword: "type",
      });
    }
  }
  return violations;
}

/**
 * Structural-projection validator (T693/T694 mirror). Accepts when AT LEAST ONE
 * branch matches. Used only as the LOUD absent-artifact fallback.
 */
export function validateAgainstContract(
  branches: readonly ContractBranch[],
  value: unknown,
  path = "",
): readonly ContractViolation[] {
  if (!isPlainObject(value)) {
    return [
      {
        path: path === "" ? "/" : path,
        message: `expected object, got ${contractKindOf(value)}`,
        keyword: "type",
      },
    ];
  }
  let closest: readonly ContractViolation[] | undefined;
  for (const branch of branches) {
    const violations = validateBranch(branch, value, path);
    if (violations.length === 0) return [];
    if (closest === undefined || violations.length < closest.length) closest = violations;
  }
  return closest ?? [];
}

export function describeViolations(violations: readonly ContractViolation[]): string {
  return violations
    .map((violation) => `${violation.path === "" ? "/" : violation.path} ${violation.message}`)
    .join("; ");
}

/** Canonical shipped schema-sidecar artifact shape (D190 / serializeRoleSchemaArtifact). */
export interface RoleSchemaArtifact {
  readonly id: string;
  readonly version: number;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export type AttestedSchemaLoadResult =
  | {
      readonly status: "loaded";
      readonly artifact: RoleSchemaArtifact;
      readonly schemaPath: string;
      readonly schemaSha256: string;
    }
  | {
      readonly status: "absent";
      readonly warning: string;
      readonly schemaPath: string;
    }
  | {
      readonly status: "error";
      readonly detail: string;
      readonly schemaPath: string;
    };

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Utf8(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    const bRecord = b as Record<string, unknown>;
    return aKeys.every(
      (key) => Object.hasOwn(bRecord, key) && deepEqual((a as Record<string, unknown>)[key], bRecord[key]),
    );
  }
  return false;
}

function instancePath(path: string): string {
  return path === "" ? "/" : path;
}

/**
 * Recursive draft-2020-12 subset checker: structural baseline + D190's seven
 * keywords (+ const/then/else solely as `if` support). See file-header residual.
 */
export function validateAgainstAttestedSchema(
  schema: unknown,
  value: unknown,
  path = "",
): readonly ContractViolation[] {
  if (typeof schema === "boolean") {
    return schema
      ? []
      : [{ path: instancePath(path), message: "schema is false", keyword: "false" }];
  }
  if (!isPlainObject(schema)) {
    return [
      {
        path: instancePath(path),
        message: "schema is not an object",
        keyword: "schema",
      },
    ];
  }

  const violations: ContractViolation[] = [];
  const push = (keyword: string, message: string, at: string = path): void => {
    violations.push({ path: instancePath(at), message, keyword });
  };

  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    push("const", "must be equal to constant");
  }

  if (Object.hasOwn(schema, "enum")) {
    const options = schema.enum;
    if (!Array.isArray(options) || !options.some((option) => deepEqual(option, value))) {
      push("enum", "must be equal to one of the allowed values");
    }
  }

  if (Object.hasOwn(schema, "type")) {
    const declared = schema.type;
    const types = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
    if (types.length > 0 && !kindMatches(types as string[], value)) {
      push("type", `expected ${(types as string[]).join(" | ")}, got ${contractKindOf(value)}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.pattern === "string") {
      let matched = false;
      try {
        matched = new RegExp(schema.pattern, "u").test(value);
      } catch {
        matched = false;
      }
      if (!matched) push("pattern", `must match pattern "${schema.pattern}"`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      push("minLength", `must NOT have fewer than ${schema.minLength} characters`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      push("minItems", `must NOT have fewer than ${schema.minItems} items`);
    }
    if (Object.hasOwn(schema, "items") && isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        violations.push(
          ...validateAgainstAttestedSchema(schema.items, value[index], `${path}/${index}`),
        );
      }
    }
    // `contains` is required for correct evaluation of implement-worker's
    // if/then mutationTable gate (empty arrays must NOT match).
    if (Object.hasOwn(schema, "contains")) {
      const matched = value.some(
        (entry) => validateAgainstAttestedSchema(schema.contains, entry, path).length === 0,
      );
      if (!matched) {
        push("contains", "must contain at least one item matching the schema");
      }
    }
  }

  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== "string") continue;
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          push("required", `must have required property '${key}'`, `${path}/${key}`);
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : null;
    if (properties) {
      for (const [key, subschema] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
        violations.push(...validateAgainstAttestedSchema(subschema, value[key], `${path}/${key}`));
      }
    }
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (!Object.hasOwn(properties, key)) {
          push("additionalProperties", "must NOT have additional properties", `${path}/${key}`);
        }
      }
    } else if (isPlainObject(schema.additionalProperties) && properties) {
      for (const key of Object.keys(value)) {
        if (value[key] === undefined || Object.hasOwn(properties, key)) continue;
        violations.push(
          ...validateAgainstAttestedSchema(
            schema.additionalProperties,
            value[key],
            `${path}/${key}`,
          ),
        );
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      violations.push(...validateAgainstAttestedSchema(sub, value, path));
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstAttestedSchema(sub, value, path).length === 0,
    );
    if (matched.length !== 1) {
      push(
        "oneOf",
        matched.length === 0
          ? "must match exactly one schema in oneOf (matched 0)"
          : `must match exactly one schema in oneOf (matched ${matched.length})`,
      );
    }
  }

  if (Object.hasOwn(schema, "not")) {
    if (validateAgainstAttestedSchema(schema.not, value, path).length === 0) {
      push("not", "must NOT be valid against the given schema");
    }
  }

  if (Object.hasOwn(schema, "if")) {
    const ifOk = validateAgainstAttestedSchema(schema.if, value, path).length === 0;
    if (ifOk && Object.hasOwn(schema, "then")) {
      violations.push(...validateAgainstAttestedSchema(schema.then, value, path));
    } else if (!ifOk && Object.hasOwn(schema, "else")) {
      violations.push(...validateAgainstAttestedSchema(schema.else, value, path));
    }
  }

  return violations;
}

/**
 * Load `schemas/<roleId>.json` from a packaged surface root and bind it to the
 * `schemaSha256` recorded in `surface.json`. Absence is a soft signal (fallback);
 * a digest mismatch or malformed artifact is a hard error (no silent degrade).
 */
export function loadAttestedRoleSchema(
  promptRoot: string,
  roleId: string,
): AttestedSchemaLoadResult {
  const schemaPath = path.join(promptRoot, "schemas", `${roleId}.json`);
  const manifestPath = path.join(promptRoot, "surface.json");

  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return {
      status: "absent",
      schemaPath,
      warning:
        `attested schema artifact missing for role "${roleId}" at ${schemaPath}: ` +
        `surface manifest unreadable (${manifestPath}); falling back to structural projection ` +
        `(degraded guarantee: ${D190_ENFORCED_KEYWORDS.join("/")} unenforced)`,
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return {
      status: "error",
      schemaPath,
      detail: `${manifestPath}: surface manifest is not JSON`,
    };
  }
  if (!isPlainObject(manifest) || !Array.isArray(manifest.roles)) {
    return {
      status: "error",
      schemaPath,
      detail: `${manifestPath}: surface manifest lacks a roles list`,
    };
  }

  const roleEntry = (manifest.roles as unknown[]).find(
    (entry) => isPlainObject(entry) && entry.roleId === roleId,
  );
  if (!isPlainObject(roleEntry)) {
    return {
      status: "absent",
      schemaPath,
      warning:
        `attested schema artifact missing for role "${roleId}" at ${schemaPath}: ` +
        `role is not listed in ${manifestPath}; falling back to structural projection ` +
        `(degraded guarantee: ${D190_ENFORCED_KEYWORDS.join("/")} unenforced)`,
    };
  }

  const attestedDigest = roleEntry.schemaSha256;
  if (attestedDigest === null || attestedDigest === undefined) {
    return {
      status: "absent",
      schemaPath,
      warning:
        `attested schema artifact missing for role "${roleId}" at ${schemaPath}: ` +
        `surface.json records schemaSha256=null; falling back to structural projection ` +
        `(degraded guarantee: ${D190_ENFORCED_KEYWORDS.join("/")} unenforced)`,
    };
  }
  if (typeof attestedDigest !== "string" || !SHA256_HEX.test(attestedDigest)) {
    return {
      status: "error",
      schemaPath,
      detail: `${manifestPath}: role "${roleId}" schemaSha256 is not a lowercase hex SHA-256 digest`,
    };
  }

  let schemaRaw: string;
  try {
    schemaRaw = fs.readFileSync(schemaPath, "utf8");
  } catch {
    return {
      status: "absent",
      schemaPath,
      warning:
        `attested schema artifact missing for role "${roleId}" at ${schemaPath}: ` +
        `file not found while surface.json attests schemaSha256=${attestedDigest}; ` +
        `falling back to structural projection ` +
        `(degraded guarantee: ${D190_ENFORCED_KEYWORDS.join("/")} unenforced)`,
    };
  }

  const actualDigest = sha256Utf8(schemaRaw);
  if (actualDigest !== attestedDigest) {
    return {
      status: "error",
      schemaPath,
      detail:
        `${schemaPath}: schema digest mismatch (surface.json schemaSha256=${attestedDigest}, ` +
        `actual=${actualDigest})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaRaw);
  } catch {
    return {
      status: "error",
      schemaPath,
      detail: `${schemaPath}: schema artifact is not JSON`,
    };
  }
  if (
    !isPlainObject(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.version !== "number" ||
    !Object.hasOwn(parsed, "inputSchema") ||
    !Object.hasOwn(parsed, "outputSchema")
  ) {
    return {
      status: "error",
      schemaPath,
      detail: `${schemaPath}: expected {id, version, inputSchema, outputSchema}`,
    };
  }

  return {
    status: "loaded",
    schemaPath,
    schemaSha256: actualDigest,
    artifact: {
      id: parsed.id,
      version: parsed.version,
      inputSchema: parsed.inputSchema,
      outputSchema: parsed.outputSchema,
    },
  };
}

export interface ValidateRoleValueResult {
  readonly ok: boolean;
  readonly errors: readonly ContractViolation[];
  readonly mode: "attested-schema" | "structural-projection-fallback";
  /** Present iff the LOUD absent-artifact fallback fired. */
  readonly warning?: string;
  readonly schemaPath?: string;
}

export interface ValidateRoleValueOptions {
  readonly roleId: string;
  readonly side: RoleContractSide;
  readonly value: unknown;
  /** Packaged surface root; defaults to `$CQ_PROMPT_ROOT`. */
  readonly promptRoot?: string;
  /** Warning sink for the LOUD fallback (defaults to `console.warn`). */
  readonly warn?: (message: string) => void;
}

/**
 * Validate a role input/output value. Prefers the attested schema artifact;
 * falls back LOUDLY to the structural projection when the artifact is absent.
 */
export function validateRoleValue(options: ValidateRoleValueOptions): ValidateRoleValueResult {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const contract = roleContractFor(options.roleId);
  if (contract === undefined) {
    return {
      ok: false,
      mode: "attested-schema",
      errors: [
        {
          path: "/",
          message: `unknown dispatched role "${options.roleId}"`,
          keyword: "role",
        },
      ],
    };
  }

  const promptRoot =
    options.promptRoot ??
    (typeof process.env[PROMPT_ROOT_ENV] === "string" ? process.env[PROMPT_ROOT_ENV] : "");
  if (promptRoot.trim() === "") {
    const warning =
      `attested schema artifact missing for role "${options.roleId}" at schemas/${options.roleId}.json: ` +
      `${PROMPT_ROOT_ENV} is unset; falling back to structural projection ` +
      `(degraded guarantee: ${D190_ENFORCED_KEYWORDS.join("/")} unenforced)`;
    warn(warning);
    const errors = validateAgainstContract(contract[options.side], options.value);
    return {
      ok: errors.length === 0,
      errors,
      mode: "structural-projection-fallback",
      warning,
      schemaPath: `schemas/${options.roleId}.json`,
    };
  }

  const loaded = loadAttestedRoleSchema(promptRoot, options.roleId);
  if (loaded.status === "error") {
    return {
      ok: false,
      mode: "attested-schema",
      schemaPath: loaded.schemaPath,
      errors: [{ path: "/", message: loaded.detail, keyword: "schema" }],
    };
  }
  if (loaded.status === "absent") {
    warn(loaded.warning);
    const errors = validateAgainstContract(contract[options.side], options.value);
    return {
      ok: errors.length === 0,
      errors,
      mode: "structural-projection-fallback",
      warning: loaded.warning,
      schemaPath: loaded.schemaPath,
    };
  }

  const schema =
    options.side === "input" ? loaded.artifact.inputSchema : loaded.artifact.outputSchema;
  const errors = validateAgainstAttestedSchema(schema, options.value);
  return {
    ok: errors.length === 0,
    errors,
    mode: "attested-schema",
    schemaPath: loaded.schemaPath,
  };
}

/**
 * The T694 residual-gap exhibit: every projected required key at a declared
 * type, closed object — and yet `taskId` violates `pattern`, `status` violates
 * `enum`, and `branch` violates `pattern`. Structural projection ACCEPTS this;
 * the attested-schema path MUST reject it (T1266 / D190).
 */
export const T694_ENUM_PATTERN_EXHIBIT: Readonly<Record<string, unknown>> = {
  taskId: "not-a-task-id",
  status: "probably",
  resultCommit: null,
  branch: "some-random-branch",
  actualWorktreePath: "/tmp/wt-exhibit",
  filesTouched: [],
  checkSummary: "",
  summary: "",
  baseVerification: {
    status: "unresolvable",
    reason: "base-missing",
    baseCommit: null,
    headCommit: null,
  },
};
