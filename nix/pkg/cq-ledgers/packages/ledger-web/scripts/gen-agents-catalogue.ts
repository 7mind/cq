#!/usr/bin/env bun
/**
 * Codegen for the Agents tab catalogue (T276, goal G34; Q148 + Q151–Q153).
 *
 * Walks the Q148 role assets under `cq-assets/` (7 `agents/*.md` subagents + 12
 * `commands/cq/*.md` orchestrator commands), runs the pure
 * {@link parseAgentMarkdown} over each, and emits the COMMITTED generated module
 * `packages/ledger-web/src/agentsCatalogue.gen.ts`, overwriting the T275
 * placeholder with the real `AGENT_ROLES: AgentRole[]`.
 *
 * ## WHY the generated module is COMMITTED (not built in the sandbox)
 * `cq-assets` lives OUTSIDE the `ledger-web` Nix closure: ledger-web's Nix build
 * is a startup `Bun.build` over `src/` only, and the sandbox has no access to the
 * sibling `cq-assets` package or the repo-root `cq.toml.example`. So this codegen
 * runs at DEV time (a `bun run gen-agents` package script), reads the assets +
 * `cq.toml.example` from the working tree, and writes a plain TS module into
 * `src/` that the Nix build bundles like any hand-authored source. The script
 * itself may use `node:*` / Bun file I/O freely; only `agentsCatalogue.ts` (which
 * the browser bundles) must stay node-free — it does, this script imports its
 * PURE exports (`parseAgentMarkdown`, the privilege/exposedTools helpers, the
 * `AgentRole` type) and does all I/O here.
 *
 * ## Determinism
 * Re-running is byte-deterministic: the role list is a fixed, explicitly-ordered
 * table (not a directory glob whose order is FS-dependent), the model class is
 * read from the COMMITTED `cq.toml.example` (NOT the gitignored live `cq.toml`),
 * and the emitter serializes with a stable key order and 2-space indent.
 *
 * ## Hard-fail contract
 * Aborts (non-zero exit) on any role whose asset file is missing, is missing its
 * `## Catalogue` block, or whose Catalogue lacks inputs/outputs/ioSchema — the
 * generated catalogue must be complete or not emitted at all.
 *
 *   bun run gen-agents        # from nix/pkg/cq-ledgers/
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseConfig,
  classifyToken,
  resolveAgentTier,
  HARNESSES,
  type CqConfig,
  type Harness,
  type ReviewerToken,
} from "@cq/config";
import {
  parseAgentMarkdown,
  deriveSubagentPrivilege,
  deriveCommandPrivilege,
  formatExposedTools,
  type AgentRole,
  type AgentKind,
  type ModelClass,
  type HarnessModelMappings,
} from "../src/agentsCatalogue.js";

// --- Paths -----------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * Repo root, relative to this script
 * (`nix/pkg/cq-ledgers/packages/ledger-web/scripts/`): six levels up —
 * scripts -> ledger-web -> packages -> cq-ledgers -> pkg -> nix -> <root>.
 */
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..", "..", "..");
/** The cq-assets package root (sibling of cq-ledgers under nix/pkg/). */
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
/** The COMMITTED config example — NOT the gitignored live cq.toml. */
const CONFIG_EXAMPLE = path.join(REPO_ROOT, "cq.toml.example");
/** The generated module this script overwrites. */
const OUT_FILE = path.resolve(SCRIPT_DIR, "..", "src", "agentsCatalogue.gen.ts");

// --- Role table (Q148; explicit + ordered for determinism) -----------------

/** A role's static identity, before its asset is parsed. */
interface RoleSpec {
  /** Stable id (asset basename for agents; path under commands/cq for commands). */
  readonly id: string;
  /** Human display name. */
  readonly name: string;
  readonly kind: AgentKind;
  /** Source path relative to cq-assets (e.g. `agents/x.md`). */
  readonly source: string;
  /**
   * The `[agent_tiers]` key for a model-configurable subagent, or null for a
   * role that is not separately model-configurable (every orchestrator command,
   * which only chains subagents). null -> model class `default`/`N/A`.
   */
  readonly agentTierKey: string | null;
}

/**
 * The 19 Q148 roles, in a fixed order: the 7 subagents first (by the
 * link-prompts flow order), then the 12 orchestrator commands. Each subagent's
 * `agentTierKey` is its `[agent_tiers]` lookup key (its name); commands are not
 * model-configurable so their key is null.
 */
const ROLES: readonly RoleSpec[] = [
  // --- agents/*.md (subagents) ---
  { id: "plan-advance", name: "plan-advance", kind: "agent-subagent", source: "agents/plan-advance.md", agentTierKey: "plan-advance" },
  { id: "plan-reviewer", name: "plan-reviewer", kind: "agent-subagent", source: "agents/plan-reviewer.md", agentTierKey: "plan-reviewer" },
  { id: "implement-worker", name: "implement-worker", kind: "agent-subagent", source: "agents/implement-worker.md", agentTierKey: "implement-worker" },
  { id: "implement-reviewer", name: "implement-reviewer", kind: "agent-subagent", source: "agents/implement-reviewer.md", agentTierKey: "implement-reviewer" },
  { id: "implement-conflict-resolver", name: "implement-conflict-resolver", kind: "agent-subagent", source: "agents/implement-conflict-resolver.md", agentTierKey: "implement-conflict-resolver" },
  { id: "investigate-explorer", name: "investigate-explorer", kind: "agent-subagent", source: "agents/investigate-explorer.md", agentTierKey: "investigate-explorer" },
  { id: "investigate-prober", name: "investigate-prober", kind: "agent-subagent", source: "agents/investigate-prober.md", agentTierKey: "investigate-prober" },
  // --- commands/cq/*.md (orchestrators) ---
  { id: "advance", name: "/cq:advance", kind: "orchestrator", source: "commands/cq/advance.md", agentTierKey: null },
  { id: "plan", name: "/cq:plan", kind: "orchestrator", source: "commands/cq/plan.md", agentTierKey: null },
  { id: "plan/advance", name: "/cq:plan:advance", kind: "orchestrator", source: "commands/cq/plan/advance.md", agentTierKey: null },
  { id: "plan/follow-up", name: "/cq:plan:follow-up", kind: "orchestrator", source: "commands/cq/plan/follow-up.md", agentTierKey: null },
  { id: "investigate", name: "/cq:investigate", kind: "orchestrator", source: "commands/cq/investigate.md", agentTierKey: null },
  { id: "investigate/advance", name: "/cq:investigate:advance", kind: "orchestrator", source: "commands/cq/investigate/advance.md", agentTierKey: null },
  { id: "implement/start", name: "/cq:implement:start", kind: "orchestrator", source: "commands/cq/implement/start.md", agentTierKey: null },
  { id: "implement/advance", name: "/cq:implement:advance", kind: "orchestrator", source: "commands/cq/implement/advance.md", agentTierKey: null },
  { id: "plan-review", name: "/cq:plan-review", kind: "orchestrator", source: "commands/cq/plan-review.md", agentTierKey: null },
  { id: "implement-review", name: "/cq:implement-review", kind: "orchestrator", source: "commands/cq/implement-review.md", agentTierKey: null },
  { id: "planners", name: "/cq:planners", kind: "orchestrator", source: "commands/cq/planners.md", agentTierKey: null },
  { id: "reviewers", name: "/cq:reviewers", kind: "orchestrator", source: "commands/cq/reviewers.md", agentTierKey: null },
];

// --- Model-class + per-harness mapping derivation --------------------------

/**
 * Derive a subagent's MODEL CLASS from `cq.toml.example`: look its
 * `[agent_tiers]` key up via {@link resolveAgentTier} (falling back to the
 * `standard` default tier when unlisted, exactly as the orchestrator does). The
 * tier name (`fast`/`standard`/`frontier`) IS the model class. A role with no
 * tier key (every orchestrator command) is not model-configurable -> `N/A`.
 */
function deriveModelClass(config: CqConfig, spec: RoleSpec): ModelClass {
  if (spec.agentTierKey === null) {
    return "N/A";
  }
  return resolveAgentTier(config, spec.agentTierKey);
}

/**
 * Group the configured planner+reviewer tokens that CLASSIFY to a role's model
 * class, by harness — the concrete model tokens a given harness would resolve
 * the role to. For an `N/A` (non-model-configurable) role, returns `{}`.
 *
 * The candidate set is the union of the config's `planners` and `reviewers`
 * alias lists resolved through `[aliases]`; each candidate is classified via
 * {@link classifyToken} and kept iff its class equals the role's class. Tokens
 * are de-duplicated per harness (by `<harness>:<model>` rendering) and sorted
 * for deterministic output.
 */
function deriveModelMappings(config: CqConfig, modelClass: ModelClass): HarnessModelMappings {
  if (modelClass === "N/A" || modelClass === "default") {
    return {};
  }
  const aliasNames = [...new Set([...config.planners, ...config.reviewers])];
  const candidates: ReviewerToken[] = [];
  for (const name of aliasNames) {
    const token = config.aliases[name];
    if (token !== undefined) {
      candidates.push(token);
    }
  }
  const matched = candidates.filter((t) => classifyToken(config, t) === modelClass);

  const byHarness: Record<Harness, Set<string>> = { claude: new Set(), pi: new Set() };
  for (const t of matched) {
    byHarness[t.harness].add(t.provider === null ? t.model : `${t.provider}/${t.model}`);
  }
  const mappings: HarnessModelMappings = {};
  for (const harness of HARNESSES) {
    const models = [...byHarness[harness]].sort();
    if (models.length > 0) {
      mappings[harness] = models;
    }
  }
  return mappings;
}

// --- Role assembly ---------------------------------------------------------

/** A precise, exit-worthy error for a role whose asset is missing/incomplete. */
class GenError extends Error {}

/**
 * Read + parse ONE role asset and assemble its {@link AgentRole}. Hard-fails
 * (throws {@link GenError}) when the file is unreadable, has no description, has
 * no `## Catalogue` block, or the Catalogue is missing inputs/outputs/ioSchema.
 */
function buildRole(config: CqConfig, spec: RoleSpec): AgentRole {
  const absPath = path.join(ASSETS_ROOT, spec.source);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new GenError(`role "${spec.id}": cannot read ${spec.source}: ${(err as Error).message}`);
  }
  const { frontmatter, catalogue, body } = parseAgentMarkdown(raw);

  const description = (frontmatter.description ?? "").trim();
  if (description.length === 0) {
    throw new GenError(`role "${spec.id}": frontmatter has no description`);
  }
  if (catalogue.inputs === undefined || catalogue.outputs === undefined || catalogue.ioSchema === undefined) {
    throw new GenError(
      `role "${spec.id}": missing or incomplete ## Catalogue block (need inputs + outputs + ioSchema) in ${spec.source}`,
    );
  }
  const promptTemplate = body.trim();
  if (promptTemplate.length === 0) {
    throw new GenError(`role "${spec.id}": empty prompt-template body in ${spec.source}`);
  }

  const privilege =
    spec.kind === "agent-subagent"
      ? deriveSubagentPrivilege(frontmatter.disallowedTools)
      : deriveCommandPrivilege(frontmatter.allowedTools);
  const exposedTools = formatExposedTools(frontmatter, spec.kind);
  const model = deriveModelClass(config, spec);
  const modelMappings = deriveModelMappings(config, model);

  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    source: spec.source,
    description,
    inputs: catalogue.inputs,
    outputs: catalogue.outputs,
    ioSchema: catalogue.ioSchema,
    promptTemplate,
    model,
    modelMappings,
    privilege,
    exposedTools,
  };
}

// --- Emit ------------------------------------------------------------------

/** Serialize a JS value with a stable 2-space indent (JSON is deterministic). */
function lit(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Render the generated module source for the assembled roles. */
function emitModule(roles: readonly AgentRole[]): string {
  const entries = roles
    .map((r) => {
      const fields = [
        `    id: ${lit(r.id)},`,
        `    name: ${lit(r.name)},`,
        `    kind: ${lit(r.kind)},`,
        `    source: ${lit(r.source)},`,
        `    description: ${lit(r.description)},`,
        `    inputs: ${lit(r.inputs)},`,
        `    outputs: ${lit(r.outputs)},`,
        `    ioSchema: ${lit(r.ioSchema)},`,
        `    promptTemplate: ${lit(r.promptTemplate)},`,
        `    model: ${lit(r.model)},`,
        `    modelMappings: ${lit(r.modelMappings)},`,
        `    privilege: ${lit(r.privilege)},`,
        `    exposedTools: ${lit(r.exposedTools)},`,
      ].join("\n");
      return `  {\n${fields}\n  },`;
    })
    .join("\n");

  return `/**
 * GENERATED catalogue — DO NOT EDIT BY HAND (T276, goal G34).
 *
 * Emitted by \`packages/ledger-web/scripts/gen-agents-catalogue.ts\` from the
 * \`cq-assets\` agent/command markdown + the COMMITTED \`cq.toml.example\`. Regenerate
 * with \`bun run gen-agents\` (from \`nix/pkg/cq-ledgers/\`) whenever a role asset's
 * frontmatter / \`## Catalogue\` block, or \`cq.toml.example\` tier config, changes.
 *
 * ## WHY this module is COMMITTED rather than built in the sandbox
 * \`cq-assets\` is OUTSIDE the ledger-web Nix closure: ledger-web's Nix build is a
 * startup \`Bun.build\` over \`src/\` only, with no access to the sibling \`cq-assets\`
 * package or the repo-root \`cq.toml.example\`. The codegen runs at DEV time, never
 * in the sandbox, so its output is committed into \`src/\` and bundled like any
 * hand-authored source. Consumers import \`AGENT_ROLES\` from \`./agentsCatalogue.js\`
 * (the node-free re-export), never this \`.gen\` module directly.
 */

import type { AgentRole } from "./agentsCatalogue.js";

export const AGENT_ROLES: AgentRole[] = [
${entries}
];
`;
}

// --- Main ------------------------------------------------------------------

function main(): void {
  const config = parseConfig(readFileSync(CONFIG_EXAMPLE, "utf8"));

  const roles: AgentRole[] = [];
  const errors: string[] = [];
  for (const spec of ROLES) {
    try {
      roles.push(buildRole(config, spec));
    } catch (err) {
      if (err instanceof GenError) {
        errors.push(err.message);
      } else {
        throw err;
      }
    }
  }
  if (errors.length > 0) {
    console.error(`gen-agents: ${errors.length} role(s) failed:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  writeFileSync(OUT_FILE, emitModule(roles), "utf8");
  const real = roles.filter((r) => r.model !== "N/A" && r.model !== "default").length;
  console.log(
    `gen-agents: wrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${roles.length} roles ` +
      `(${real} with a configured model class, ${roles.length - real} default/N/A)`,
  );
}

main();
