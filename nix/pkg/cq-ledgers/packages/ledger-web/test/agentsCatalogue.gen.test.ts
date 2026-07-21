/**
 * Freshness / drift guard for the generated agents catalogue (T277, goal G34).
 *
 * Part (a) — CONTENT: imports AGENT_ROLES and asserts the full Q148 role set is
 * present with the required structured fields populated.
 *
 * Part (b) — FRESHNESS: re-runs the codegen (`bun run gen-agents`) in a
 * subprocess, captures the output into a temp file, and asserts the committed
 * `src/agentsCatalogue.gen.ts` is byte-for-byte identical to the freshly
 * generated output. A stale committed file (e.g. a cq-assets asset or
 * cq.toml.example changed but not regenerated) causes this assertion to fail.
 *
 * The freshness check shells out to `bun run gen-agents` (the root workspace
 * script), lets the script write to its hardcoded OUT_FILE, then restores the
 * original content — so the assertion is side-effect-free regardless of outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ROLES } from "../src/agentsCatalogue";
import type { AgentRole } from "../src/agentsCatalogue";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * The workspace root (`nix/pkg/cq-ledgers/`) — where `bun run gen-agents` is
 * defined in the root package.json.
 */
const WORKSPACE_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
/** The committed generated module that this test protects. */
const GEN_FILE = path.resolve(TEST_DIR, "..", "src", "agentsCatalogue.gen.ts");

// ---------------------------------------------------------------------------
// Part (a) — CONTENT: role-set invariants
// ---------------------------------------------------------------------------

/**
 * The 23 Q148 role ids in the FIXED generation order (same as ROLES[] in the
 * gen script): 9 subagents first, then 14 orchestrator commands.
 */
const EXPECTED_ROLE_IDS: readonly string[] = [
  // subagents
  "plan-advance",
  "plan-reviewer",
  "implement-worker",
  "implement-reviewer",
  "implement-conflict-resolver",
  "investigate-explorer",
  "investigate-prober",
  "research-explorer",
  "research-experimenter",
  // orchestrator commands
  "advance",
  "plan",
  "plan/advance",
  "plan/follow-up",
  "investigate",
  "investigate/advance",
  "research",
  "research/advance",
  "implement/start",
  "implement/advance",
  "plan-review",
  "implement-review",
  "planners",
  "reviewers",
];

describe("AGENT_ROLES — Q148 role-set invariants (part a)", () => {
  it("exports exactly 23 roles in the fixed generation order", () => {
    expect(AGENT_ROLES.length).toBe(23);
    expect(AGENT_ROLES.map((r) => r.id)).toEqual([...EXPECTED_ROLE_IDS]);
  });

  it("every role has non-empty id / name / description / promptTemplate", () => {
    for (const role of AGENT_ROLES) {
      expect(role.id.length, `role ${role.id}: id empty`).toBeGreaterThan(0);
      expect(role.name.length, `role ${role.id}: name empty`).toBeGreaterThan(0);
      expect(role.description.length, `role ${role.id}: description empty`).toBeGreaterThan(0);
      expect(role.promptTemplate.length, `role ${role.id}: promptTemplate empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every role has non-empty inputs / outputs / ioSchema arrays", () => {
    for (const role of AGENT_ROLES) {
      expect(role.inputs.length, `role ${role.id}: inputs empty`).toBeGreaterThan(0);
      expect(role.outputs.length, `role ${role.id}: outputs empty`).toBeGreaterThan(0);
      expect(role.ioSchema.length, `role ${role.id}: ioSchema empty`).toBeGreaterThan(0);
    }
  });

  it("every role has a privilege in {RO, RW}", () => {
    for (const role of AGENT_ROLES) {
      expect(["RO", "RW"]).toContain(role.privilege);
    }
  });

  it("every role has an exposedTools string (non-empty)", () => {
    for (const role of AGENT_ROLES) {
      expect(
        typeof role.exposedTools === "string" && role.exposedTools.length > 0,
        `role ${role.id}: exposedTools empty`,
      ).toBe(true);
    }
  });

  it("plan-reviewer is present with privilege RO", () => {
    const role = AGENT_ROLES.find((r) => r.id === "plan-reviewer");
    expect(role).toBeDefined();
    expect(role!.privilege).toBe("RO");
    expect(role!.kind).toBe("agent-subagent");
  });

  it("implement-worker is present with privilege RW", () => {
    const role = AGENT_ROLES.find((r) => r.id === "implement-worker");
    expect(role).toBeDefined();
    expect(role!.privilege).toBe("RW");
    expect(role!.kind).toBe("agent-subagent");
    // implement-worker uses an isolated worktree — its exposedTools reflects that
    expect(role!.exposedTools).toContain("isolation: worktree");
  });

  it("all 9 subagents are agent-subagent kind", () => {
    const subagentIds = EXPECTED_ROLE_IDS.slice(0, 9);
    for (const id of subagentIds) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      expect(role.kind, `${id}: expected agent-subagent`).toBe("agent-subagent");
    }
  });

  it("all 14 orchestrator commands are orchestrator kind", () => {
    const cmdIds = EXPECTED_ROLE_IDS.slice(9);
    for (const id of cmdIds) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      expect(role.kind, `${id}: expected orchestrator`).toBe("orchestrator");
    }
  });

  it("every dispatched-subagent role carries typed input + output schemas (T341)", () => {
    // The 9 subagents are the dispatched-subagent roles (non-null agentTierKey);
    // each must carry the typed schemas sourced from the @cq/config sidecars.
    const subagentIds = EXPECTED_ROLE_IDS.slice(0, 9);
    for (const id of subagentIds) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      expect(role.inputSchema, `${id}: missing inputSchema`).toBeDefined();
      expect(role.outputSchema, `${id}: missing outputSchema`).toBeDefined();
      // Draft 2020-12, carried verbatim from the sidecar.
      expect(role.inputSchema!.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(role.outputSchema!.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("no orchestrator-command role carries a typed schema (T341)", () => {
    const cmdIds = EXPECTED_ROLE_IDS.slice(9);
    for (const id of cmdIds) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      expect(role.inputSchema, `${id}: unexpected inputSchema`).toBeUndefined();
      expect(role.outputSchema, `${id}: unexpected outputSchema`).toBeUndefined();
    }
  });

  it("the AgentRole type carries all required fields (compile-time + run-time)", () => {
    // A literal that must satisfy the full AgentRole shape — catches field
    // renames or type changes at compile time.
    const role: AgentRole = {
      id: "plan-reviewer",
      name: "plan-reviewer",
      kind: "agent-subagent",
      source: "agents/plan-reviewer.md",
      description: "Plan-flow adversarial reviewer.",
      inputs: ["goal id G"],
      outputs: ["go-ahead | revise verdict"],
      ioSchema: ["verdict json shape: {summary, verdict, ...}"],
      promptTemplate: "You are the plan-flow adversarial reviewer.",
      privilege: "RO",
      exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash",
    };
    expect(role.privilege).toBe("RO");
    expect(role.inputs.length).toBeGreaterThan(0);
    expect(role.ioSchema.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Part (b) — FRESHNESS: drift guard
// ---------------------------------------------------------------------------

/**
 * Snapshot of the committed gen.ts content before the subprocess runs — used
 * both for the diff assertion and to restore the file after the test.
 */
let committedContent: string;
/** The freshly generated content produced by running `bun run gen-agents`. */
let freshContent: string;

beforeAll(() => {
  // 1. Save the committed content.
  committedContent = readFileSync(GEN_FILE, "utf8");

  // 2. Run the gen script. It always writes to GEN_FILE (hardcoded in the
  //    script via import.meta.url — cannot be redirected externally without
  //    modifying the script). We let it overwrite, read the fresh output, then
  //    restore the original.
  const result = Bun.spawnSync(["bun", "run", "gen-agents"], {
    cwd: WORKSPACE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    throw new Error(`gen-agents failed (exit ${result.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  // 3. Capture the freshly generated output.
  freshContent = readFileSync(GEN_FILE, "utf8");
});

afterAll(() => {
  // Restore the committed content regardless of test outcome, so the source
  // tree is left unchanged after the test suite runs.
  if (committedContent !== undefined) {
    writeFileSync(GEN_FILE, committedContent, "utf8");
  }
});

describe("agentsCatalogue.gen.ts freshness guard (part b)", () => {
  it("committed gen.ts is byte-for-byte identical to a freshly generated output", () => {
    // When the committed file is fresh, committedContent === freshContent.
    // When an asset or cq.toml.example changed but gen-agents was not re-run,
    // the two strings differ and this test fails — the developer must run
    // `bun run gen-agents` and commit the updated file.
    expect(committedContent).toBe(freshContent);
  });
});
