/**
 * T729/T739 — privileged project-admin MCP surface. Not registered on ordinary /mcp.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  buildBackupDump,
  createTrustedWorksetManagementAuthority,
  InMemoryLedgerStore,
  isXdgPrimaryEmpty,
  parseBackupDump,
  PostgresLedgerStore,
  restoreDumpToPostgres,
  type BackupDumpFile,
  type LedgerStore,
} from "@cq/ledger";
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

export const MAX_ADMIN_DUMP_BYTES = 32 * 1024 * 1024;

export type AdminImportIntent = "migrate-empty" | "restore-replace-confirmed";

export function resolveAdminToken(
  tokenArg: string | null,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (tokenArg !== null && tokenArg.trim() !== "") return tokenArg.trim();
  const fromEnv = env[HUB_ADMIN_TOKEN_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return null;
}

export interface AdminOperation {
  readonly operationId: string;
  readonly tool: ProjectAdminToolName;
  readonly status: "done";
  readonly result: unknown;
}

export interface ProjectAdminHandlers {
  handle(req: Request): Promise<Response>;
  readonly operations: Map<string, AdminOperation>;
}

export type ProjectAdminReconcileKind = "import" | "reset" | "erase";

export interface AttachProjectAdminMcpHttpOptions {
  readonly store: LedgerStore;
  readonly adminToken: string;
  readonly onReconcile?: (kind: ProjectAdminReconcileKind) => Promise<void>;
}

function text(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function dumpByteLength(dump: readonly BackupDumpFile[]): number {
  let total = 0;
  for (const file of dump) {
    total += Buffer.byteLength(file.path, "utf8") + Buffer.byteLength(file.content, "utf8");
  }
  return total;
}

function parseDumpArgument(raw: unknown): BackupDumpFile[] {
  if (!Array.isArray(raw)) {
    throw new Error("import_dump: dump must be an array of {path, content}");
  }
  const dump: BackupDumpFile[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { content?: unknown }).content !== "string"
    ) {
      throw new Error("import_dump: each dump entry must be {path: string, content: string}");
    }
    dump.push({
      path: (entry as { path: string }).path,
      content: (entry as { content: string }).content,
    });
  }
  if (dumpByteLength(dump) > MAX_ADMIN_DUMP_BYTES) {
    throw new Error(`import_dump: dump exceeds ${String(MAX_ADMIN_DUMP_BYTES)} bytes`);
  }
  parseBackupDump(dump);
  return dump;
}

async function exportDump(store: LedgerStore): Promise<BackupDumpFile[]> {
  return await buildBackupDump(store, null);
}

async function importDump(
  store: LedgerStore,
  intent: AdminImportIntent,
  dump: BackupDumpFile[],
): Promise<{ imported: true; intent: AdminImportIntent }> {
  parseBackupDump(dump);
  if (intent === "migrate-empty" && !(await isXdgPrimaryEmpty(store))) {
    throw new Error("import_dump: migrate-empty refused because the tenant is not empty");
  }
  if (store instanceof PostgresLedgerStore) {
    await restoreDumpToPostgres({
      pool: store.sharedPool(),
      projectKey: store.tenantKey(),
      dump,
      overwriteAuthorized: intent === "restore-replace-confirmed",
      authority: createTrustedWorksetManagementAuthority(),
    });
    await store.reloadCommittedState();
    return { imported: true, intent };
  }
  if (store instanceof InMemoryLedgerStore) {
    await store.replaceFromParsedDump(parseBackupDump(dump));
    return { imported: true, intent };
  }
  throw new Error("import_dump: store does not support dump import");
}

async function resetProject(store: LedgerStore): Promise<{ reset: true }> {
  if (store instanceof PostgresLedgerStore) {
    await store.resetTenant({ authority: createTrustedWorksetManagementAuthority() });
    return { reset: true };
  }
  if (store instanceof InMemoryLedgerStore) {
    await store.resetToBootstrap();
    return { reset: true };
  }
  throw new Error("reset_project: store does not support reset");
}

async function eraseProject(store: LedgerStore): Promise<{ erased: true }> {
  if (store instanceof PostgresLedgerStore) {
    await store.eraseTenant({ authority: createTrustedWorksetManagementAuthority() });
    return { erased: true };
  }
  if (store instanceof InMemoryLedgerStore) {
    await store.resetToBootstrap();
    return { erased: true };
  }
  throw new Error("erase_project: store does not support erase");
}

export function createProjectAdminMcpServer(
  store: LedgerStore,
  operations: Map<string, AdminOperation>,
  onReconcile?: (kind: ProjectAdminReconcileKind) => Promise<void>,
): McpServer {
  const server = new McpServer(
    { name: "cq-project-admin", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      instructions: "Project-admin MCP. Ordinary agents must not use this endpoint.",
    },
  );

  const replayOrRun = async (
    operationId: string,
    tool: ProjectAdminToolName,
    run: () => Promise<unknown>,
  ) => {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.tool !== tool) {
        throw new Error(`operation_id ${operationId} was used for ${existing.tool}`);
      }
      return text(existing.result);
    }
    const result = await run();
    operations.set(operationId, { operationId, tool, status: "done", result });
    return text(result);
  };

  const operationId = { operation_id: z.string().min(1) };
  server.registerTool(
    "export_dump",
    {
      description: "Export the project ledger dump including logs.",
      inputSchema: operationId,
    },
    async ({ operation_id }) =>
      replayOrRun(operation_id, "export_dump", async () => ({ dump: await exportDump(store) })),
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
    async ({ operation_id, intent, dump }) =>
      replayOrRun(operation_id, "import_dump", async () => {
        const parsed = parseDumpArgument(dump);
        const result = await importDump(store, intent, parsed);
        await onReconcile?.("import");
        return result;
      }),
  );
  server.registerTool(
    "reset_project",
    {
      description: "Reset the project ledger.",
      inputSchema: operationId,
    },
    async ({ operation_id }) =>
      replayOrRun(operation_id, "reset_project", async () => {
        const result = await resetProject(store);
        await onReconcile?.("reset");
        return result;
      }),
  );
  server.registerTool(
    "erase_project",
    {
      description: "Erase the project ledger.",
      inputSchema: operationId,
    },
    async ({ operation_id }) =>
      replayOrRun(operation_id, "erase_project", async () => {
        const result = await eraseProject(store);
        await onReconcile?.("erase");
        return result;
      }),
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
  storeOrOpts: LedgerStore | AttachProjectAdminMcpHttpOptions,
  adminTokenArg?: string,
): ProjectAdminHandlers {
  const opts: AttachProjectAdminMcpHttpOptions =
    typeof adminTokenArg === "string"
      ? { store: storeOrOpts as LedgerStore, adminToken: adminTokenArg }
      : (storeOrOpts as AttachProjectAdminMcpHttpOptions);
  const operations = new Map<string, AdminOperation>();
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return {
    operations,
    async handle(req: Request): Promise<Response> {
      const provided = req.headers.get("authorization");
      const expected = `Bearer ${opts.adminToken}`;
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
      const server = createProjectAdminMcpServer(opts.store, operations, opts.onReconcile);
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: body });
      if (transport.sessionId !== undefined) sessions.set(transport.sessionId, transport);
      return response;
    },
  };
}
