/**
 * T728 — stdio compatibility proxy for backend=remote.
 * Forwards MCP tools/list and tools/call to cq serve. No LedgerStore.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { remoteMcpUrl } from "@cq/ledger";

export interface RemoteStdioProxyOptions {
  readonly serverUrl: string;
  readonly projectKey: string;
  readonly token: string;
  readonly displayName?: string;
}

export interface RemoteMcpProxy {
  readonly server: McpServer;
  readonly upstream: Client;
  readonly endpoint: string;
  close(): Promise<void>;
}

export async function connectRemoteMcpProxy(
  serverUrl: string,
  projectKey: string,
  token: string,
): Promise<RemoteMcpProxy> {
  const endpoint = remoteMcpUrl(serverUrl, projectKey);
  const transport = new StreamableHTTPClientTransport(
    new URL(endpoint),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  const upstream = new Client(
    { name: "cq-mcp-remote-proxy", version: "0.0.1" },
    { capabilities: {} },
  );
  await upstream.connect(transport as unknown as Transport);

  const info = upstream.getServerVersion();
  const instructions = upstream.getInstructions();
  const server = new McpServer(
    {
      name: info?.name ?? "cq-mcp-remote-proxy",
      version: info?.version ?? "0.0.1",
      ...(info?.title !== undefined && info.title !== "" ? { title: info.title } : {}),
    },
    {
      capabilities: { tools: {} },
      ...(instructions !== undefined && instructions !== "" ? { instructions } : {}),
    },
  );

  const sentinel = server.registerTool(
    "__remote_proxy_sentinel__",
    { description: "Internal remote-proxy sentinel.", inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
  );
  sentinel.remove();

  server.server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    }),
  );

  return {
    server,
    upstream,
    endpoint,
    async close(): Promise<void> {
      await upstream.close();
    },
  };
}

export async function serveRemoteStdioProxy(options: RemoteStdioProxyOptions): Promise<void> {
  const proxy = await connectRemoteMcpProxy(
    options.serverUrl,
    options.projectKey,
    options.token,
  );
  const transport = new StdioServerTransport();
  await proxy.server.connect(transport);
  process.stderr.write(
    `ledger-mcp: proxying stdio to ${proxy.endpoint}` +
      (options.displayName !== undefined ? ` (${options.displayName})` : "") +
      "\n",
  );
}
