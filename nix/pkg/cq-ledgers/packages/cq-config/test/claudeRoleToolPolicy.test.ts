/**
 * G224 / K331: the Claude print bridge derives a dispatched child's built-in
 * tools from the role's attested frontmatter instead of disabling them all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { AttestationContractError } from "../src/dispatchAttestation.js";
import {
  CLAUDE_DISPATCH_BUILTIN_TOOLS,
  claudeDispatchBuiltinTools,
} from "../src/claudeRoleToolPolicy.js";

function rolePrompt(roleId: string, disallowed: string): string {
  return [
    "---",
    `name: ${roleId}`,
    "description: fixture role",
    `# Claude host capabilities for ${roleId}`,
    `disallowedTools: ${disallowed}`,
    "",
    "---",
    "",
    "Role body.",
    "",
  ].join("\n");
}

const RENDERED_CLAUDE_ROLES = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "cq-assets",
  "fragments",
  "claude",
  "agents",
);

describe("claudeDispatchBuiltinTools", () => {
  test("a worker keeps every baseline tool except the ones its frontmatter denies", () => {
    expect(claudeDispatchBuiltinTools(rolePrompt("implement-worker", "Agent"), "implement-worker")).toEqual(
      [...CLAUDE_DISPATCH_BUILTIN_TOOLS],
    );
  });

  test("a reviewer loses the write tools but keeps read and shell tools", () => {
    expect(
      claudeDispatchBuiltinTools(
        rolePrompt("implement-reviewer", "Write, Edit, MultiEdit, NotebookEdit, Agent"),
        "implement-reviewer",
      ),
    ).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  test("an explorer that denies Bash is left with read-only search tools", () => {
    expect(
      claudeDispatchBuiltinTools(
        rolePrompt("investigate-explorer", "Write, Edit, MultiEdit, NotebookEdit, Bash, Agent"),
        "investigate-explorer",
      ),
    ).toEqual(["Read", "Glob", "Grep"]);
  });

  test("never grants a tool outside the baseline, whatever the frontmatter omits", () => {
    const tools = claudeDispatchBuiltinTools(rolePrompt("plan-advance", "Write"), "plan-advance");
    expect(tools).not.toContain("Agent");
    expect(tools.every((tool) => (CLAUDE_DISPATCH_BUILTIN_TOOLS as readonly string[]).includes(tool))).toBe(true);
  });

  test("refuses a role body without frontmatter", () => {
    expect(() => claudeDispatchBuiltinTools("Role body only.\n", "implement-worker")).toThrow(
      AttestationContractError,
    );
  });

  test("refuses frontmatter that declares no disallowedTools", () => {
    const body = "---\nname: implement-worker\ndescription: x\n---\n\nbody\n";
    expect(() => claudeDispatchBuiltinTools(body, "implement-worker")).toThrow(/disallowedTools/);
  });

  test("refuses frontmatter naming a different role", () => {
    expect(() =>
      claudeDispatchBuiltinTools(rolePrompt("implement-reviewer", "Agent"), "implement-worker"),
    ).toThrow(/implement-reviewer/);
  });

  test("every packaged dispatched role's declared policy parses", () => {
    for (const roleId of [
      "implement-worker",
      "implement-reviewer",
      "implement-conflict-resolver",
      "implementation-auditor",
      "investigate-explorer",
      "investigate-prober",
      "plan-advance",
      "plan-reviewer",
      "research-experimenter",
      "research-explorer",
    ]) {
      const declaration = readFileSync(
        path.join(RENDERED_CLAUDE_ROLES, roleId, "host-tool-vocabulary.md"),
        "utf8",
      )
        .split("\n")
        .find((line) => line.startsWith("disallowedTools:"));
      expect(declaration, roleId).toBeDefined();
      const tools = claudeDispatchBuiltinTools(
        rolePrompt(roleId, declaration!.slice("disallowedTools:".length).trim()),
        roleId,
      );
      expect(tools, roleId).toContain("Read");
    }
  });
});
