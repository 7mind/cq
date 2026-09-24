/**
 * G224 / D544 — the Pi extension a CQ-launched, child-stored Pi child loads
 * (`pi -e`). Pi has no MCP client of its own, so this connects the child to
 * its own dispatch-scoped `cq mcp` and registers that server's role tools
 * under their bare names (`fetch_dispatch_input`, `store_result`, ...).
 *
 * The launcher hands the server's launch specification over in a private file
 * named by {@link PI_CHILD_LEDGER_CONFIG_ENV}. The file carries the dispatch's
 * environment-bound capabilities, so it is read and deleted, and the variable
 * removed, before the model runs: the capabilities then live only in the
 * spawned server's environment, never in a prompt, argv, or Pi's own env.
 *
 * Deliberately free of workspace imports: Pi loads this file in its own
 * runtime, resolving only the MCP SDK from this package's dependencies.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const PI_CHILD_LEDGER_CONFIG_ENV = "CQ_PI_CHILD_LEDGER_CONFIG";

export interface PiChildLedgerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Added to the child's inherited environment for the server only. */
  readonly env: Readonly<Record<string, string>>;
  /** The ledger tools to register; each must be offered by the server. */
  readonly tools: readonly string[];
}

interface PiToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly details: undefined;
}

/** The slice of Pi's `ExtensionAPI` this extension uses. */
interface PiExtensionApi {
  registerTool(tool: {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: unknown;
    execute(toolCallId: string, params: unknown): Promise<PiToolResult>;
  }): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
}

function takeConfig(): PiChildLedgerConfig {
  const configPath = process.env[PI_CHILD_LEDGER_CONFIG_ENV];
  if (configPath === undefined || configPath === "") {
    throw new Error(`the CQ Pi child extension requires ${PI_CHILD_LEDGER_CONFIG_ENV}`);
  }
  delete process.env[PI_CHILD_LEDGER_CONFIG_ENV];
  const config = JSON.parse(readFileSync(configPath, "utf8")) as PiChildLedgerConfig;
  unlinkSync(configPath);
  return config;
}

export default async function piChildLedgerExtension(pi: PiExtensionApi): Promise<void> {
  const config = takeConfig();
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  // Loaded only through an explicit `-e` on a dispatch launch, which always
  // starts a session; the connection opens here because the tool schemas come
  // from the server and Pi's `--tools` allowlist applies at startup.
  const client = new Client({ name: "cq-pi-dispatch-child", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      cwd: config.cwd,
      env: { ...inherited, ...config.env },
      stderr: "inherit",
    }),
  );
  const offered = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  for (const name of config.tools) {
    const tool = offered.get(name);
    if (tool === undefined) {
      await client.close();
      throw new Error(`the child ledger server does not offer ${name}`);
    }
    pi.registerTool({
      name,
      label: name,
      description: tool.description ?? name,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params) {
        const result = await client.callTool({ name, arguments: params as Record<string, unknown> });
        const text = (result.content as ReadonlyArray<{ readonly type: string; readonly text?: string }>)
          .filter((part) => part.type === "text" && part.text !== undefined)
          .map((part) => part.text!)
          .join("\n");
        if (result.isError === true) throw new Error(text);
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  }
  pi.on("session_shutdown", async () => {
    await client.close();
  });
}
