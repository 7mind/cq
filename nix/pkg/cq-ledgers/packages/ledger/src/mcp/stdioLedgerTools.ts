/**
 * Raw MCP SDK registration derived from the canonical ledger tool
 * specifications in `ledgerTools.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LedgerStore } from "../store/LedgerStore.js";
import type { ConfigCapability } from "./configCapability.js";
import type { DispatchCapability } from "./dispatchCapability.js";
import {
  assertToolPrefix,
  createLedgerMcpToolSpecifications,
  FULL_LEDGER_TOOL_PROFILE,
  ledgerToolListDefinitions,
  prefixToolName,
  selectLedgerMcpToolSpecifications,
  type LedgerToolProfileName,
  type LedgerToolSpecification,
} from "./ledgerTools.js";
import type { ListProjectsCapability } from "./listProjects.js";
import type { PromptCatalogCapability } from "./promptCatalogCapability.js";
import type { ReadLogCapability } from "./readLog.js";

/**
 * Register an already-resolved specification set. Callers must profile and
 * capability-filter before reaching this boundary, so `tools/list` never sees
 * a specification outside the selected surface.
 */
export function registerLedgerStdioToolSpecifications(
  server: McpServer,
  specifications: readonly LedgerToolSpecification[],
  toolPrefix: string = "",
): void {
  assertToolPrefix(toolPrefix);
  if (specifications.length === 0) {
    const sentinel = server.registerTool(
      "__empty_ledger_profile__",
      { description: "Internal empty-profile sentinel.", inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );
    sentinel.remove();
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ledgerToolListDefinitions(specifications, toolPrefix),
    }));
    return;
  }
  for (const specification of specifications) {
    server.registerTool(
      prefixToolName(toolPrefix, specification.name),
      {
        description: specification.description,
        inputSchema: specification.inputSchema,
      },
      specification.handler,
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ledgerToolListDefinitions(specifications, toolPrefix),
  }));
}

/**
 * Build, capability-gate, profile-filter, and register the canonical ledger
 * tool specifications on a raw MCP SDK server.
 */
export function registerLedgerStdioTools(
  server: McpServer,
  store: LedgerStore,
  readLog?: ReadLogCapability,
  configCapability?: ConfigCapability,
  promptCatalog?: PromptCatalogCapability,
  toolPrefix: string = "",
  listProjects?: ListProjectsCapability,
  dispatchCapability?: DispatchCapability,
  profileName: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
): void {
  const specifications = selectLedgerMcpToolSpecifications(
    createLedgerMcpToolSpecifications(
      store,
      readLog,
      configCapability,
      promptCatalog,
      listProjects,
      dispatchCapability,
    ),
    profileName,
  );
  registerLedgerStdioToolSpecifications(server, specifications, toolPrefix);
}
