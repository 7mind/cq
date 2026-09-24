/**
 * G224 / K331 — built-in tool policy for a Claude child launched through the
 * print bridge. The policy is read from the role's attested frontmatter, the
 * same bytes whose digest the bridge verifies, so it cannot drift from the
 * role a native `Agent` launch would have used. Tools outside the baseline
 * (Agent, Workflow, Skill, scheduling, messaging) are never granted.
 */

import { AttestationContractError } from "./dispatchAttestation.js";

export const CLAUDE_DISPATCH_BUILTIN_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
] as const);

const FRONTMATTER_DELIMITER = "---";
const DISALLOWED_TOOLS_KEY = "disallowedTools:";
const NAME_KEY = "name:";

function frontmatterLines(rolePrompt: string): readonly string[] {
  const lines = rolePrompt.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new AttestationContractError(
      "launch.rolePrompt.frontmatter",
      "the attested role body has no frontmatter declaring its tool policy",
    );
  }
  const end = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (end < 0) {
    throw new AttestationContractError(
      "launch.rolePrompt.frontmatter",
      "the attested role body's frontmatter is not terminated",
    );
  }
  return lines.slice(1, end);
}

function frontmatterValue(lines: readonly string[], key: string, roleId: string): string {
  const matches = lines.filter((line) => line.startsWith(key));
  if (matches.length !== 1) {
    throw new AttestationContractError(
      "launch.rolePrompt.frontmatter",
      `the attested frontmatter for "${roleId}" must declare exactly one ${key.slice(0, -1)} line, found ${matches.length}`,
    );
  }
  return matches[0]!.slice(key.length).trim();
}

/**
 * The tools a role's attested frontmatter denies, in the surface's own tool
 * vocabulary. Shared by every process adapter that narrows a child's tools.
 */
export function attestedDisallowedTools(rolePrompt: string, roleId: string): ReadonlySet<string> {
  const lines = frontmatterLines(rolePrompt);
  const declaredRole = frontmatterValue(lines, NAME_KEY, roleId);
  if (declaredRole !== roleId) {
    throw new AttestationContractError(
      "launch.rolePrompt.frontmatter",
      `the attested frontmatter names role "${declaredRole}", not "${roleId}"`,
    );
  }
  return new Set(
    frontmatterValue(lines, DISALLOWED_TOOLS_KEY, roleId)
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool !== ""),
  );
}

/** Built-in tools the child may use: the baseline minus the role's declared denials. */
export function claudeDispatchBuiltinTools(rolePrompt: string, roleId: string): readonly string[] {
  const denied = attestedDisallowedTools(rolePrompt, roleId);
  return Object.freeze(CLAUDE_DISPATCH_BUILTIN_TOOLS.filter((tool) => !denied.has(tool)));
}
