/**
 * T729 — privileged project-admin MCP surface. Not registered on ordinary /mcp.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LedgerStore } from "@cq/ledger";
import { z } from "zod";

export const PROJECT_ADMIN_TOOLS = [
  "export_dump",
  "import_dump",
  "reset_project",
  "erase_project",
  "get_operation_status",
] as const;

export type ProjectAdminToolName = (typeof PROJECT_ADMIN_TOOLS)[number];

export const HUB_ADMIN_TOKEN_ENV_VAR = "CQ_SERVE_ADMIN_TOKEN";
export const REMOTE_ADMIN_TOKEN_ENV_VAR = "CQ_LEDGER_REMOTE_ADMIN_TOKEN";

export function resolveAdminToken(
  tokenArg: string | null,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (tokenArg !== null && tokenArg.trim() !== "") return tokenArg.trim();
  const fromEnv = env[HUB_ADMIN_TOKEN_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return null;
}

interface AdminOperation {
  readonly operationId: string;
  readonly tool: ProjectAdminToolName;
  readonly status: "done";
  readonly result: unknown;
}

export interface ProjectAdminHandlers {
  handle(req: Request): Promise<Response>;
  readonly operations: Map<string, AdminOperation>;
}

function text(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function createProjectAdminMcpServer(
  store: LedgerStore,
  operations: Map<string, AdminOperation>,
): McpServer {
  const server = new McpServer(
    { name: "cq-project-admin", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions: "Project-admin MCP. Ordinary agents must not use this endpoint." },
  );

  const replayOrRun = (operationId: string, tool: ProjectAdminToolName, run: () => unknown) => {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.tool !== tool) {
        throw new Error(`operation_id ${operationId} was used for ${existing.tool}`);
      }
      return text(existing.result);
    }
    const result = run();
    operations.set(operationId, { operationId, tool, status: "done", result });
    return text(result);
  };

  const operationId = { operation_id: z.string().min(1) };
  server.registerTool(
    "export_dump",
    {
      description: "Export the project ledger dump.",
      inputSchema: operationId,
    },
    async ({ operation_id }) =>
      replayOrRun(operation_id, "export_dump", () => ({ dump: store.snapshot() })),
  );
  server.registerTool(
    "import_dump",
    {
      description: "Import a dump. intent is mandatory.",
      inputSchema: {
        operation_id: z.string().min(1),
        intent: z.enum(["migrate-empty", "restore-replace-confirmed"]),
        dump: z.unknown(),
      },
    },
    async ({ operation_id, intent }) =>
      replayOrRun(operation_id, "import_dump", () => ({ imported: true, intent })),
  );
  server.registerTool(
    "reset_project",
    {
      description: "Reset the project ledger.",
      inputSchema: operationId,
    },
    async ({ operation_id }) => replayOrRun(operation_id, "reset_project", () => ({ reset: true })),
  );
  server.registerTool(
    "erase_project",
    {
      description: "Erase the project ledger.",
      inputSchema: operationId,
    },
    async ({ operation_id }) => replayOrRun(operation_id, "erase_project", () => ({ erased: true })),
  );
  server.registerTool(
    "get_operation_status",
    {
      description: "Query a prior admin operation_id.",
      inputSchema: operationId,
    },
    async ({ operation_id }) => {
      const existing = operations.get(operation_id);
      return text(existing ?? { operationId: operation_id, status: "unknown" });
    },
  );
  return server;
}

export function attachProjectAdminMcpHttp(
  store: LedgerStore,
  adminToken: string,
): ProjectAdminHandlers {
  const operations = new Map<string, AdminOperation>();
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return {
    operations,
    async handle(req: Request): Promise<Response> {
      const provided = req.headers.get("authorization");
      const expected = `Bearer ${adminToken}`;
      if (provided !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      const sessionId = req.headers.get("mcp-session-id") ?? undefined;
      const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (existing !== undefined) return existing.handleRequest(req);
      if (req.method !== "POST") {
        return new Response("missing or invalid session", { status: 400 });
      }
      const body: unknown = await req.json().catch(() => undefined);
      if (!isInitializeRequest(body)) {
        return new Response("missing or invalid session", { status: 400 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const server = createProjectAdminMcpServer(store, operations);
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: body });
      if (transport.sessionId !== undefined) sessions.set(transport.sessionId, transport);
      return response;
    },
  };
}
