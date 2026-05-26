/**
 * mcp-inheritance.test.ts — G2c F-14: MCP server inheritance from ~/.claude/mcp_servers.json.
 *
 * This test validates that when HOME is set to a temporary directory containing
 * .claude/mcp_servers.json, the SDK's bundled CLI subprocess reads that file
 * and surfaces the MCP servers in the init message's mcp_servers list.
 *
 * SKIPPED (PR-19-D01): Running the test against the real bundled CLI requires a
 * valid Anthropic API key and network access, which are not available in the test
 * environment. The Anthropic HTTP layer cannot be stubbed at the transport level
 * without either:
 *  (a) A PR-20-style MockAnthropicHTTP server — which is the deliverable of PR-20,
 *      or
 *  (b) The SDK exposing a `ANTHROPIC_BASE_URL` override that the subprocess honours
 *      for its initialization handshake (to be confirmed in PR-20 spike).
 *
 * When PR-20 ships MockAnthropicHTTP, this test should be un-skipped and wired to:
 *  1. Set HOME=tmpdir containing .claude/mcp_servers.json.
 *  2. Set ANTHROPIC_BASE_URL to MockAnthropicHTTP's base URL.
 *  3. Boot Bridge with real queryFactory (no MockQuery).
 *  4. Send chat.start; await chat.started.
 *  5. Assert chat.started.initInfo.mcp_servers includes the stub server.
 *
 * Fallback (if the real bundled CLI does not honour HOME for mcp_servers.json):
 *  Implement explicit MCP parse in packages/server/src/agent/mcp.ts and pass
 *  the parsed config via Options.mcpServers. See defects.md PR-19-D01.
 */

import { describe, it } from "bun:test";

describe("MCP inheritance (G2c F-14)", () => {
  // PR-19-D01: Skipped — requires MockAnthropicHTTP (PR-20) or real API key.
  // See the module docstring above for the full test plan and fallback.
  it.skip(
    "MCP servers from ~/.claude/ are forwarded in initInfo (requires PR-20 MockAnthropicHTTP)",
    async () => {
      // Full implementation deferred to PR-20. Outline:
      //
      //   const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cq-mcp-test-"));
      //   await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
      //   await fs.writeFile(
      //     path.join(tmpHome, ".claude", "mcp_servers.json"),
      //     JSON.stringify({
      //       "stub-server": { command: "echo", args: ["stub"] },
      //     }),
      //   );
      //
      //   // Start MockAnthropicHTTP (from PR-20 helpers).
      //   const stub = await startMockAnthropicHTTP();
      //   process.env.ANTHROPIC_BASE_URL = stub.baseUrl;
      //   process.env.HOME = tmpHome;
      //
      //   const registry = new SessionRegistry();
      //   const bridge = new Bridge({
      //     logger: noopLogger,
      //     registry,
      //     cwd: tmpHome,
      //     // Use real queryFactory — no MockQuery injection.
      //   });
      //
      //   const ws = new MockWsSocket();
      //   await bridge.handleChatStart(ws, { type: "chat.start", seq: 0, ts: Date.now() });
      //   const [startedFrame] = await ws.waitForFrames("chat.started");
      //   const initInfo = startedFrame.initInfo as { mcp_servers?: Array<{ name: string }> };
      //   const names = (initInfo.mcp_servers ?? []).map((s) => s.name);
      //   expect(names).toContain("stub-server");
      //
      //   await bridge.shutdown();
      //   await stub.stop();
      //   await fs.rm(tmpHome, { recursive: true, force: true });
    },
  );
});
