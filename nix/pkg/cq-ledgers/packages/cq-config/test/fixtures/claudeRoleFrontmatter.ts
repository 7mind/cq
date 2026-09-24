/** G224 / K331: wrap a fixture role body in the frontmatter a packaged Claude role carries. */
export function withClaudeRoleFrontmatter(roleId: string, disallowedTools: string, body: string): string {
  return [
    "---",
    `name: ${roleId}`,
    "description: fixture role",
    `# Claude host capabilities for ${roleId}`,
    `disallowedTools: ${disallowedTools}`,
    "",
    "---",
    "",
    body,
    "",
  ].join("\n");
}
