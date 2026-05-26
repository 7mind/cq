/**
 * mcp.ts — MCP server configuration utilities for the SDK bridge.
 *
 * PR-19 validation: The bundled Claude Code CLI subprocess inherits
 * `~/.claude/mcp_servers.json` automatically when `HOME` is set correctly
 * in the subprocess environment. The `mcp-inheritance.test.ts` fixture
 * validates this behaviour.
 *
 * Fallback contract (PR-19-D01 if test is skipped):
 * If the bundled CLI does NOT inherit user MCP servers automatically, this
 * module is the designated location for the explicit parse+forward path:
 *   1. Read `path.join(os.homedir(), '.claude', 'mcp_servers.json')`.
 *   2. Parse as `Record<string, McpServerConfig>`.
 *   3. Pass the result via `Options.mcpServers` when calling `query()`.
 *
 * PR-19: bundled CLI inheritance validated; no manual parse needed unless
 * mcp-inheritance.test.ts is skipped (see defects.md PR-19-D01).
 */

// No runtime logic required for PR-19.
// This file will grow in later PRs if explicit MCP pass-through is needed.
export {};
