#!/usr/bin/env bun
/**
 * Codegen for the Agents tab catalogue (T276, goal G34; Q148 + Q151–Q153).
 *
 * Walks the Q148 role assets under `cq-assets/` (9 `agents/*.md` subagents + 14
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
import { AGENT_ROLE_TIERS, getRoleSidecar, DISPATCHED_ROLE_IDS } from "@cq/config";
import {
  parseAgentMarkdown,
  deriveSubagentPrivilege,
  deriveCommandPrivilege,
  formatExposedTools,
  type AgentRole,
  type AgentKind,
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
 * The 23 Q148 roles, in a fixed order: the 9 subagents first (by the
 * link-prompts flow order), then the 14 orchestrator commands. Each subagent's
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
  { id: "research-explorer", name: "research-explorer", kind: "agent-subagent", source: "agents/research-explorer.md", agentTierKey: "research-explorer" },
  { id: "research-experimenter", name: "research-experimenter", kind: "agent-subagent", source: "agents/research-experimenter.md", agentTierKey: "research-experimenter" },
  // --- commands/cq/*.md (orchestrators) ---
  { id: "advance", name: "/cq:advance", kind: "orchestrator", source: "commands/cq/advance.md", agentTierKey: null },
  { id: "plan", name: "/cq:plan", kind: "orchestrator", source: "commands/cq/plan.md", agentTierKey: null },
  { id: "plan/advance", name: "/cq:plan:advance", kind: "orchestrator", source: "commands/cq/plan/advance.md", agentTierKey: null },
  { id: "plan/follow-up", name: "/cq:plan:follow-up", kind: "orchestrator", source: "commands/cq/plan/follow-up.md", agentTierKey: null },
  { id: "investigate", name: "/cq:investigate", kind: "orchestrator", source: "commands/cq/investigate.md", agentTierKey: null },
  { id: "investigate/advance", name: "/cq:investigate:advance", kind: "orchestrator", source: "commands/cq/investigate/advance.md", agentTierKey: null },
  { id: "research", name: "/cq:research", kind: "orchestrator", source: "commands/cq/research.md", agentTierKey: null },
  { id: "research/advance", name: "/cq:research:advance", kind: "orchestrator", source: "commands/cq/research/advance.md", agentTierKey: null },
  { id: "implement/start", name: "/cq:implement:start", kind: "orchestrator", source: "commands/cq/implement/start.md", agentTierKey: null },
  { id: "implement/advance", name: "/cq:implement:advance", kind: "orchestrator", source: "commands/cq/implement/advance.md", agentTierKey: null },
  { id: "plan-review", name: "/cq:plan-review", kind: "orchestrator", source: "commands/cq/plan-review.md", agentTierKey: null },
  { id: "implement-review", name: "/cq:implement-review", kind: "orchestrator", source: "commands/cq/implement-review.md", agentTierKey: null },
  { id: "planners", name: "/cq:planners", kind: "orchestrator", source: "commands/cq/planners.md", agentTierKey: null },
  { id: "reviewers", name: "/cq:reviewers", kind: "orchestrator", source: "commands/cq/reviewers.md", agentTierKey: null },
];

// --- Role assembly ---------------------------------------------------------

/** A precise, exit-worthy error for a role whose asset is missing/incomplete. */
class GenError extends Error {}

/**
 * Read + parse ONE role asset and assemble its {@link AgentRole}. Hard-fails
 * (throws {@link GenError}) when the file is unreadable, has no description, has
 * no `## Catalogue` block, or the Catalogue is missing inputs/outputs/ioSchema.
 */
function buildRole(spec: RoleSpec): AgentRole {
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

  // Typed I/O schemas (T341, role-scope decision 1): a DISPATCHED-SUBAGENT role
  // (non-null agentTierKey) MUST have a sidecar in the @cq/config typed catalog —
  // its parent-validated input/output contract is sourced from there, NOT from a
  // duplicate. An orchestrator-command role (agentTierKey null) carries NO such
  // contract; its schema fields stay undefined. Hard-fail (the complete-or-nothing
  // contract) if a dispatched role is missing its sidecar.
  const dispatched = spec.agentTierKey !== null;
  const sidecar = getRoleSidecar(spec.id);
  if (dispatched && sidecar === undefined) {
    throw new GenError(
      `role "${spec.id}": dispatched-subagent (non-null agentTierKey) has no schema sidecar in @cq/config typed catalog (DISPATCHED_ROLE_SIDECARS)`,
    );
  }
  if (!dispatched && sidecar !== undefined) {
    throw new GenError(
      `role "${spec.id}": orchestrator-command (null agentTierKey) must NOT carry a schema sidecar, but one is present in @cq/config`,
    );
  }

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
    privilege,
    exposedTools,
    ...(sidecar !== undefined
      ? { inputSchema: sidecar.inputSchema, outputSchema: sidecar.outputSchema }
      : {}),
  };
}

// --- Emit ------------------------------------------------------------------

/** Serialize a JS value with a stable 2-space indent (JSON is deterministic). */
function lit(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Serialize a (possibly nested) value with a stable 2-space indent, then shift
 * every line after the first right by `baseIndent` spaces so a multi-line schema
 * object nests cleanly under its `key:` column. Deterministic: relies only on
 * `JSON.stringify`'s stable key order (insertion order of the sidecar objects).
 */
function litIndented(value: unknown, baseIndent: number): string {
  const pad = " ".repeat(baseIndent);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n");
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
        `    privilege: ${lit(r.privilege)},`,
        `    exposedTools: ${lit(r.exposedTools)},`,
      ];
      // Typed I/O schemas are emitted ONLY for dispatched-subagent roles
      // (role-scope decision 1); orchestrator-commands omit the keys entirely so
      // the generated entry has no `inputSchema`/`outputSchema` at all.
      if (r.inputSchema !== undefined && r.outputSchema !== undefined) {
        fields.push(`    inputSchema: ${litIndented(r.inputSchema, 4)},`);
        fields.push(`    outputSchema: ${litIndented(r.outputSchema, 4)},`);
      }
      return `  {\n${fields.join("\n")}\n  },`;
    })
    .join("\n");

  return `/**
 * GENERATED catalogue — DO NOT EDIT BY HAND (T276, goal G34).
 *
 * Emitted by \`packages/ledger-web/scripts/gen-agents-catalogue.ts\` from the
 * \`cq-assets\` agent/command markdown. Regenerate with \`bun run gen-agents\`
 * (from \`nix/pkg/cq-ledgers/\`) whenever a role asset's frontmatter or
 * \`## Catalogue\` block changes.
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

/**
 * Fail the codegen if this script's {@link ROLES} table has drifted from the
 * SHARED {@link AGENT_ROLE_TIERS} roster (the same `(id, agentTierKey)` pairs
 * the ledger-mcp `computeAgentModels` capability resolves over). The shared
 * roster is the single source of truth for the join keys; this script owns only
 * the per-role display metadata (`name`/`kind`/`source`). They must agree on the
 * 23 ids, their order, and which carry an `[agent_tiers]` key.
 */
function assertRosterMatchesShared(): void {
  const local = ROLES.map((r) => `${r.id}=${r.agentTierKey ?? "null"}`);
  const shared = AGENT_ROLE_TIERS.map(
    (r) => `${r.id}=${r.agentTierKey ?? "null"}`,
  );
  if (local.length !== shared.length || local.some((v, i) => v !== shared[i])) {
    throw new Error(
      `gen-agents: ROLES table drifted from @cq/config AGENT_ROLE_TIERS — ` +
        `local=[${local.join(", ")}] shared=[${shared.join(", ")}]`,
    );
  }
}

/**
 * Fail the codegen if the `@cq/config` typed-catalog STORE
 * (`DISPATCHED_ROLE_SIDECARS`, surfaced as {@link DISPATCHED_ROLE_IDS}) has
 * drifted from the dispatched-subagent subset of the roster (the roles with a
 * non-null `agentTierKey`). The two MUST cover EXACTLY the same role ids in the
 * same order, so every dispatched role has a typed input/output contract and no
 * orchestrator-command does (role-scope decision 1).
 */
function assertSidecarsMatchDispatchedRoster(): void {
  const dispatchedRoster = ROLES.filter((r) => r.agentTierKey !== null).map((r) => r.id);
  const store = [...DISPATCHED_ROLE_IDS];
  if (
    dispatchedRoster.length !== store.length ||
    dispatchedRoster.some((id, i) => id !== store[i])
  ) {
    throw new Error(
      `gen-agents: dispatched-role roster drifted from @cq/config typed-catalog store — ` +
        `roster=[${dispatchedRoster.join(", ")}] store=[${store.join(", ")}]`,
    );
  }
}

function main(): void {
  assertRosterMatchesShared();
  assertSidecarsMatchDispatchedRoster();

  const roles: AgentRole[] = [];
  const errors: string[] = [];
  for (const spec of ROLES) {
    try {
      roles.push(buildRole(spec));
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
  console.log(
    `gen-agents: wrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${roles.length} roles`,
  );
}

main();
