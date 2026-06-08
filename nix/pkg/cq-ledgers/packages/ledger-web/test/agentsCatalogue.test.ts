/**
 * Unit tests for the Agents-tab data model + parser (T275, goal G34).
 *
 * Exercises the pure {@link parseAgentMarkdown} on BOTH asset kinds:
 *   - an AGENT fixture (deny-list frontmatter: name/description/disallowedTools/
 *     isolation), asserting deny-list privilege derivation (Q151);
 *   - a COMMAND fixture (allow-list frontmatter: description/argument-hint/
 *     allowed-tools), asserting allow-list privilege derivation (Q151–Q152);
 * plus the `## Catalogue` fenced-yaml block extraction (and graceful degradation
 * when the block is absent), and the AGENT_ROLES placeholder re-export (T276
 * overwrites the gen file).
 *
 * Fixtures mirror the real asset frontmatter shapes (an implement-worker-like
 * deny-list with `isolation: worktree`, a plan-reviewer-like deny-list, a
 * plan/advance-like allow-list with a Write/Bash-bearing tool list).
 */

import { describe, it, expect } from "bun:test";
import {
  AGENT_ROLES,
  parseAgentMarkdown,
  deriveSubagentPrivilege,
  deriveCommandPrivilege,
  formatExposedTools,
  type AgentRole,
} from "../src/agentsCatalogue";

// An implement-worker-like agent: deny-list lacks all mutating tools ⇒ RW; has
// `isolation: worktree`; carries a `## Catalogue` block.
const AGENT_RW_FIXTURE = `---
name: implement-worker
description: Implement-flow worker. Implements EXACTLY ONE task end-to-end.
isolation: worktree
disallowedTools: Agent
---

## Catalogue
\`\`\`yaml
inputs:
  - task id + headline/description/acceptance
  - worktree path / branch
outputs:
  - structured pass/fail JSON
  - one commit on the task branch
ioSchema:
  - "result: { taskId, status, resultCommit, branch, filesTouched }"
\`\`\`

You are the **implement-flow worker**. You implement EXACTLY ONE task.
`;

// A plan-reviewer-like agent: deny-list CONTAINS Write/Edit/Bash ⇒ RO. No
// `## Catalogue` block (graceful degradation).
const AGENT_RO_FIXTURE = `---
name: plan-reviewer
description: Plan-flow adversarial reviewer. Read-only on the repo.
disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Bash
---

You are the **plan-flow adversarial reviewer**. You make NO repo edits.
`;

// A plan/advance-like command: allow-list lists Write/Bash ⇒ RW; carries an
// inline-comment-bearing argument-hint and a glob tool.
const COMMAND_RW_FIXTURE = `---
description: Advance plan-flow goals one full round.
argument-hint: [goalId]   # optional goal id
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

You are the **thin orchestrator** for the plan-flow advance loop.
`;

// A read-only command (plan-review-like): allow-list has NO mutating tool ⇒ RO.
const COMMAND_RO_FIXTURE = `---
description: Shared adversarial plan-review rubric.
argument-hint: <goalId> + the plan context
allowed-tools: Read, Grep, Glob, WebSearch, WebFetch
---

You judge the emitted plan by the canonical rubric.
`;

describe("parseAgentMarkdown — agent fixture (deny-list)", () => {
  const parsed = parseAgentMarkdown(AGENT_RW_FIXTURE);

  it("extracts the real agent frontmatter keys", () => {
    expect(parsed.frontmatter.name).toBe("implement-worker");
    expect(parsed.frontmatter.description).toBe(
      "Implement-flow worker. Implements EXACTLY ONE task end-to-end.",
    );
    expect(parsed.frontmatter.isolation).toBe("worktree");
    expect(parsed.frontmatter.disallowedTools).toEqual(["Agent"]);
  });

  it("extracts the structured `## Catalogue` block", () => {
    expect(parsed.catalogue.inputs).toEqual([
      "task id + headline/description/acceptance",
      "worktree path / branch",
    ]);
    expect(parsed.catalogue.outputs).toEqual([
      "structured pass/fail JSON",
      "one commit on the task branch",
    ]);
    // The fixture quotes this value; the parser strips the surrounding quotes
    // (T281 quoting convention) so the stored value is unquoted.
    expect(parsed.catalogue.ioSchema).toEqual([
      "result: { taskId, status, resultCommit, branch, filesTouched }",
    ]);
  });

  it("keeps the prompt-template body", () => {
    expect(parsed.body).toContain("You are the **implement-flow worker**.");
    // The body retains the `## Catalogue` block (the UI folds it).
    expect(parsed.body).toContain("## Catalogue");
  });

  it("derives RW for a deny-list lacking every mutating tool", () => {
    expect(deriveSubagentPrivilege(parsed.frontmatter.disallowedTools)).toBe("RW");
  });
});

describe("parseAgentMarkdown — agent fixture (RO deny-list, no Catalogue)", () => {
  const parsed = parseAgentMarkdown(AGENT_RO_FIXTURE);

  it("extracts the deny-list and derives RO", () => {
    expect(parsed.frontmatter.disallowedTools).toEqual([
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ]);
    expect(deriveSubagentPrivilege(parsed.frontmatter.disallowedTools)).toBe("RO");
  });

  it("degrades gracefully to an empty Catalogue when the block is absent", () => {
    expect(parsed.catalogue).toEqual({});
    expect(parsed.catalogue.inputs).toBeUndefined();
  });

  it("does not pick up command-only keys", () => {
    expect(parsed.frontmatter.allowedTools).toBeUndefined();
    expect(parsed.frontmatter.argumentHint).toBeUndefined();
  });
});

describe("parseAgentMarkdown — command fixture (allow-list)", () => {
  const parsed = parseAgentMarkdown(COMMAND_RW_FIXTURE);

  it("extracts the real command frontmatter keys (incl. allowed-tools per Q152)", () => {
    expect(parsed.frontmatter.description).toBe("Advance plan-flow goals one full round.");
    expect(parsed.frontmatter.argumentHint).toBe("[goalId]");
    expect(parsed.frontmatter.allowedTools).toEqual([
      "mcp__ledger__*",
      "Agent",
      "Write",
      "Bash",
      "Read",
      "Grep",
      "Glob",
    ]);
  });

  it("strips the inline comment from argument-hint", () => {
    expect(parsed.frontmatter.argumentHint).not.toContain("#");
    expect(parsed.frontmatter.argumentHint).not.toContain("optional");
  });

  it("derives RW for an allow-list listing Write/Bash", () => {
    expect(deriveCommandPrivilege(parsed.frontmatter.allowedTools)).toBe("RW");
  });

  it("does not pick up agent-only keys", () => {
    expect(parsed.frontmatter.disallowedTools).toBeUndefined();
    expect(parsed.frontmatter.isolation).toBeUndefined();
    expect(parsed.frontmatter.name).toBeUndefined();
  });
});

describe("deriveCommandPrivilege — read-only allow-list", () => {
  it("derives RO for an allow-list with no mutating tool", () => {
    const parsed = parseAgentMarkdown(COMMAND_RO_FIXTURE);
    expect(parsed.frontmatter.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
    ]);
    expect(deriveCommandPrivilege(parsed.frontmatter.allowedTools)).toBe("RO");
  });
});

describe("privilege derivation edge cases", () => {
  it("treats an absent deny-list as RW (subagent)", () => {
    expect(deriveSubagentPrivilege(undefined)).toBe("RW");
    expect(deriveSubagentPrivilege([])).toBe("RW");
  });

  it("treats an absent allow-list as RO (command)", () => {
    expect(deriveCommandPrivilege(undefined)).toBe("RO");
    expect(deriveCommandPrivilege([])).toBe("RO");
  });
});

// A Catalogue block exercising the quoting convention: double-quoted,
// single-quoted, and bare values across scalar + dash-item forms.
const CATALOGUE_QUOTING_FIXTURE = `---
name: quoting-probe
---

## Catalogue
\`\`\`yaml
inputs:
  - "double-quoted input"
  - 'single-quoted input'
  - bare input
outputs: "scalar quoted output"
ioSchema:
  - 'isn''t fully unwrapped'
\`\`\`
`;

describe("parseCatalogueBlock — quote stripping (T281 convention)", () => {
  const parsed = parseAgentMarkdown(CATALOGUE_QUOTING_FIXTURE);

  it("strips one matching pair of surrounding quotes from dash-items", () => {
    expect(parsed.catalogue.inputs).toEqual([
      "double-quoted input",
      "single-quoted input",
      "bare input",
    ]);
  });

  it("strips surrounding quotes from an inline scalar value", () => {
    expect(parsed.catalogue.outputs).toEqual(["scalar quoted output"]);
  });

  it("removes only the outer matching pair (inner quotes preserved)", () => {
    // `'isn''t fully unwrapped'` → outer single pair removed, leaving the inner
    // doubled quote untouched (the parser strips ONE matching outer pair only).
    expect(parsed.catalogue.ioSchema).toEqual(["isn''t fully unwrapped"]);
  });
});

describe("formatExposedTools — canonical display string (Q152–Q153)", () => {
  it("agent-subagent: lists disallowed tools + isolation suffix", () => {
    const parsed = parseAgentMarkdown(AGENT_RW_FIXTURE);
    expect(formatExposedTools(parsed.frontmatter, "agent-subagent")).toBe(
      "Disallowed: Agent; isolation: worktree",
    );
  });

  it("agent-subagent: lists a multi-tool deny-list (no isolation)", () => {
    const parsed = parseAgentMarkdown(AGENT_RO_FIXTURE);
    expect(formatExposedTools(parsed.frontmatter, "agent-subagent")).toBe(
      "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash",
    );
  });

  it("agent-subagent: 'Disallowed: none' when the deny-list is absent", () => {
    expect(formatExposedTools({}, "agent-subagent")).toBe("Disallowed: none");
    expect(formatExposedTools({ isolation: "worktree" }, "agent-subagent")).toBe(
      "Disallowed: none; isolation: worktree",
    );
  });

  it("orchestrator: lists allowed tools", () => {
    const parsed = parseAgentMarkdown(COMMAND_RW_FIXTURE);
    expect(formatExposedTools(parsed.frontmatter, "orchestrator")).toBe(
      "Allowed: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob",
    );
  });

  it("orchestrator: 'none declared' when the allow-list is absent", () => {
    expect(formatExposedTools({}, "orchestrator")).toBe("none declared");
    expect(formatExposedTools({ allowedTools: [] }, "orchestrator")).toBe("none declared");
  });
});

describe("AGENT_ROLES placeholder re-export", () => {
  it("re-exports the generated AGENT_ROLES (populated by T276 codegen)", () => {
    expect(Array.isArray(AGENT_ROLES)).toBe(true);
    expect(AGENT_ROLES.length).toBeGreaterThan(0);
  });

  it("the AgentRole type carries privilege + exposedTools (compile-time)", () => {
    // A literal that must satisfy AgentRole — fails typecheck if either the
    // privilege ('RO'|'RW') or exposedTools field is missing/renamed.
    const role: AgentRole = {
      id: "implement-worker",
      name: "implement-worker",
      kind: "agent-subagent",
      source: "agents/implement-worker.md",
      description: "Implement-flow worker.",
      inputs: [],
      outputs: [],
      ioSchema: [],
      promptTemplate: "body",
      model: "default",
      modelMappings: { claude: ["opus-4.8"] },
      privilege: "RW",
      exposedTools: "disallowedTools: Agent; isolation: worktree",
    };
    expect(role.privilege).toBe("RW");
    expect(role.exposedTools).toContain("disallowedTools");
  });
});
