import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
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
} from "./ledgerTools.js";
import type { ListProjectsCapability } from "./listProjects.js";
import type { PromptCatalogCapability } from "./promptCatalogCapability.js";
import type { ReadLogCapability } from "./readLog.js";
import type { WorktreeManageCapability } from "./worktreeManageTools.js";

export interface CreateLedgerSdkMcpServerOptions {
  readonly name: string;
  readonly version?: string;
  readonly instructions?: string;
  readonly alwaysLoad?: boolean;
  readonly store: LedgerStore;
  readonly readLog?: ReadLogCapability;
  readonly configCapability?: ConfigCapability;
  readonly promptCatalog?: PromptCatalogCapability;
  readonly toolPrefix?: string;
  readonly listProjects?: ListProjectsCapability;
  readonly dispatchCapability?: DispatchCapability;
  readonly profileName?: LedgerToolProfileName;
  readonly worktreeManage?: WorktreeManageCapability;
}

/**
 * Construct an Anthropic in-process MCP server with compact public schemas.
 * Zod shapes remain installed on handlers; only tools/list serialization is
 * replaced with the same definitions used by the stdio transport.
 */
export function createLedgerSdkMcpServer(
  options: CreateLedgerSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const toolPrefix = options.toolPrefix ?? "";
  const profileName = options.profileName ?? FULL_LEDGER_TOOL_PROFILE;
  assertToolPrefix(toolPrefix);
  const specifications = selectLedgerMcpToolSpecifications(
    createLedgerMcpToolSpecifications(
      options.store,
      options.readLog,
      options.configCapability,
      options.promptCatalog,
      options.listProjects,
      options.dispatchCapability,
      options.worktreeManage,
    ),
    profileName,
  );
  const tools = specifications.map((specification) => ({
    ...specification,
    name: prefixToolName(toolPrefix, specification.name),
  })) as SdkMcpToolDefinition[];
  const server = createSdkMcpServer({
    name: options.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.alwaysLoad === undefined ? {} : { alwaysLoad: options.alwaysLoad }),
    tools,
  });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ledgerToolListDefinitions(specifications, toolPrefix, options.alwaysLoad),
  }));
  return server;
}
