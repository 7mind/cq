/**
 * G224: a stand-in for `claude -p` that behaves like a real print-mode child.
 * It records its argv, starts the ledger server from `--mcp-config` exactly as
 * declared (environment included), materializes its input and stores its
 * result over MCP, then prints a `claude -p --output-format json` terminal
 * result whose final message is the dispatch handle.
 */

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const capture = process.env["CQ_FAKE_CLAUDE_ARGV_CAPTURE"];
if (capture !== undefined) writeFileSync(capture, JSON.stringify(argv));

function flag(name: string): string {
  const index = argv.indexOf(name);
  const value = argv[index + 1];
  if (index < 0 || value === undefined) throw new Error(`fake claude: missing ${name}`);
  return value;
}

const reference = JSON.parse(flag("-p")) as {
  readonly attestationId: string;
  readonly generation: number;
  readonly inputCapability: unknown;
};
const sessionId = flag("--session-id");
const config = JSON.parse(flag("--mcp-config")) as {
  readonly mcpServers: Readonly<
    Record<
      string,
      {
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
      }
    >
  >;
};
const [serverName, server] = Object.entries(config.mcpServers)[0]!;
const inherited: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) inherited[key] = value;
}
const transport = new StdioClientTransport({
  command: server.command,
  args: [...server.args],
  cwd: server.cwd,
  env: { ...inherited, ...server.env },
  stderr: "inherit",
});
const client = new Client({ name: "fake-claude-child", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }>; isError?: boolean });
  if (content.isError === true) throw new Error(`fake claude: ${serverName} tool failed: ${content.content[0]?.text}`);
  return content.content[0]!.text;
}

text(
  await client.callTool({
    name: "fetch_dispatch_input",
    arguments: {
      attestationId: reference.attestationId,
      generation: reference.generation,
      inputCapability: reference.inputCapability,
    },
  }),
);
text(
  await client.callTool({
    name: "store_result",
    arguments: { output: JSON.parse(process.env["CQ_FAKE_CLAUDE_OUTPUT"] ?? "{}") as unknown },
  }),
);
await client.close();

process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    result: JSON.stringify({ attestationId: reference.attestationId, generation: reference.generation }),
    modelUsage: { [flag("--model")]: { canonicalModel: "claude-sonnet-fixture" } },
  }),
);
