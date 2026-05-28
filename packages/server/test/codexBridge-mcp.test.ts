/**
 * codexBridge-mcp.test.ts — gc1-1 wiring test.
 *
 * Asserts that the CodexBridge passes the per-session
 * `CodexOptions.config.mcp_servers.cq = { command, args: [..., "--cwd", <cwd>] }`
 * shape into its codexFactory so the Codex CLI spawns the cq-mcp stdio
 * binary and routes mcp__cq__* tool calls to it.
 *
 * This is a behaviour-on-the-boundary test (per the dual-tests skill):
 * the factory is the injection seam, so capturing what reaches it is
 * the closest the unit suite can get to verifying the Codex SDK
 * surfaces our config to the CLI. The standalone-binary path itself
 * is exercised end-to-end in packages/cq-mcp/test/main.test.ts.
 */

import { describe, it, expect } from "bun:test";
import { CodexBridge } from "../src/agent/codexBridge";
import type { CodexFactory, CqMcpBin } from "../src/agent/codexBridge";
import type { Codex, CodexOptions, Thread, ThreadOptions } from "@openai/codex-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence";
import { noopLogger, MockWsSocket } from "./helpers/mockBridge";

/**
 * Inert dummy — just enough to keep the bridge happy past chat.start.
 * We're only inspecting what the factory received.
 */
class InertThread {
  readonly threadOptions: ThreadOptions;
  constructor(opts: ThreadOptions) { this.threadOptions = opts; }
  get id(): string | null { return null; }
  // Required by Thread shape but never invoked in this test.
  async runStreamed(): Promise<never> { throw new Error("not exercised"); }
  async run(): Promise<never> { throw new Error("not exercised"); }
}

class InertCodex {
  startThread(opts?: ThreadOptions): Thread {
    return new InertThread(opts ?? {}) as unknown as Thread;
  }
  resumeThread(_id: string, opts?: ThreadOptions): Thread {
    return new InertThread(opts ?? {}) as unknown as Thread;
  }
}

describe("CodexBridge MCP wiring (gc1-1)", () => {
  it("passes config.mcp_servers.cq.{command, args=[--cwd <cwd>]} to the codex factory", async () => {
    const captured: { options: CodexOptions | undefined } = { options: undefined };
    const factory: CodexFactory = async (options?: CodexOptions): Promise<Codex> => {
      captured.options = options;
      return new InertCodex() as unknown as Codex;
    };
    const cqMcpBin: CqMcpBin = {
      command: "/tmp/fake-bin/cq-mcp",
      args: ["--banner", "yes"],
    };
    const bridge = new CodexBridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      cwd: "/tmp/codex-mcp-test",
      persistence: new InMemoryPersistence(),
      codexFactory: factory,
      detectAuth: () => true,
      cqMcpBin,
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      platform: "codex",
      model: "gpt-5.1",
    });
    expect(captured.options).toBeDefined();
    const cfg = captured.options!.config as
      | undefined
      | { mcp_servers?: { cq?: { command: unknown; args: unknown } } };
    expect(cfg).toBeDefined();
    expect(cfg!.mcp_servers).toBeDefined();
    expect(cfg!.mcp_servers!.cq).toBeDefined();
    expect(cfg!.mcp_servers!.cq!.command).toBe("/tmp/fake-bin/cq-mcp");
    // Pre-supplied args are preserved and the --cwd <abs> pair is appended.
    expect(cfg!.mcp_servers!.cq!.args).toEqual([
      "--banner",
      "yes",
      "--cwd",
      "/tmp/codex-mcp-test",
    ]);
    await bridge.shutdown();
  });

  it("falls back to the default resolver when cqMcpBin is omitted", async () => {
    // Smoke-test the default resolver in-process: it should produce
    // *some* CqMcpBin without throwing, and the resulting Codex options
    // carry it through. This guards against a default-path regression
    // in defaultResolveCqMcpBin (file-walking + bin-link lookup).
    const captured: { options: CodexOptions | undefined } = { options: undefined };
    const factory: CodexFactory = async (options?: CodexOptions): Promise<Codex> => {
      captured.options = options;
      return new InertCodex() as unknown as Codex;
    };
    const bridge = new CodexBridge({
      logger: noopLogger,
      registry: new SessionRegistry(),
      cwd: "/tmp/codex-mcp-test-default",
      persistence: new InMemoryPersistence(),
      codexFactory: factory,
      detectAuth: () => true,
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      platform: "codex",
      model: "gpt-5.1",
    });
    const cfg = captured.options?.config as
      | undefined
      | { mcp_servers?: { cq?: { command: unknown; args: unknown } } };
    expect(cfg?.mcp_servers?.cq?.command).toBeDefined();
    // args MUST end with --cwd <abs>; the prefix (the bin's own args)
    // may be empty for the linked symlink path or ["run", "<main.ts>"]
    // for the bun-fallback path.
    const args = cfg!.mcp_servers!.cq!.args as unknown as string[];
    expect(args.length).toBeGreaterThanOrEqual(2);
    expect(args[args.length - 2]).toBe("--cwd");
    expect(args[args.length - 1]).toBe("/tmp/codex-mcp-test-default");
    await bridge.shutdown();
  });
});
