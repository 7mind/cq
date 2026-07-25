/**
 * T679 — request-side (schema/input) overhead of the ledger MCP surface.
 *
 * Boots the REAL stdio ledger MCP server for a given workspace over an
 * in-memory transport, issues `tools/list`, and tokenizes the returned tool
 * definitions. Run it against this worktree and against the RS3-era tree
 * (`git archive 3fe3b8a7…`) to obtain a measured before/after of the cold
 * schema cost — the request-side counterpart to the response measurement.
 *
 * The metric is operational: UTF-8 bytes and `o200k_base` tokens of the
 * minified JSON of the `tools` array as `client.listTools()` returns it
 * (name + description + inputSchema). It is NOT a host-specific context
 * accounting: hosts may reformat, cache, or elide tool definitions.
 *
 * Usage:
 *   bun run schema-overhead.ts --workspace <abs path to nix/pkg/cq-ledgers> [--json <file>]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolSchemaMeasurement {
  name: string;
  bytes: number;
  tokens: number;
  hasProjectionParam: boolean;
}

export interface SchemaOverheadResult {
  workspace: string;
  toolCount: number;
  totalBytes: number;
  totalTokens: number;
  perTool: ToolSchemaMeasurement[];
  projectionParamTools: string[];
  /**
   * Counterfactual: the same schema with every `projection` input property
   * (and its `required` entry and its description sentence) mechanically
   * removed. Measures what the mandatory-projection contract costs on the
   * request side of THIS tree. It is a strip of the current schema, not the
   * historical schema of any commit.
   */
  counterfactualWithoutProjection: {
    totalBytes: number;
    totalTokens: number;
    tokensAttributableToProjection: number;
  };
  /**
   * Decomposition of the schema growth that the response-contract cutover is
   * responsible for, by mechanically removing each contract artefact from the
   * CURRENT schema:
   *  - projection: the `projection` input property + its description sentence
   *  - ackSentences: the fixed-acknowledgement sentences in tool descriptions
   *  - authoritativeResponse: the "Authoritative response: …" block T676 appends
   * Residual growth against an older tree is therefore NOT attributable to the
   * cutover.
   */
  contractAttributable: {
    projectionTokens: number;
    ackSentenceTokens: number;
    authoritativeResponseTokens: number;
    allTokens: number;
  };
}

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  const value = process.argv[idx + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

function sizeOf(value: unknown): { bytes: number; tokens: number } {
  const text = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: encode(text).length,
  };
}

function stripProjection(tool: ToolDefinition, sentence: string): ToolDefinition {
  const stripped = structuredClone(tool);
  const schema = stripped.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (schema.properties !== undefined) delete schema.properties["projection"];
  if (schema.required !== undefined) {
    schema.required = schema.required.filter((name) => name !== "projection");
    if (schema.required.length === 0) delete schema.required;
  }
  if (stripped.description !== undefined && sentence !== "") {
    stripped.description = stripped.description.split(sentence).join("");
  }
  return stripped;
}

export async function measureSchemaOverhead(
  workspaceInput: string,
): Promise<SchemaOverheadResult> {
  const workspace = resolve(workspaceInput);
  const { McpServer } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", `${workspace}/packages/ledger`)
  );
  const { Client } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", `${workspace}/packages/ledger`)
  );
  const { InMemoryTransport } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/inMemory.js", `${workspace}/packages/ledger`)
  );
  const { registerLedgerStdioTools } = await import(
    `${workspace}/packages/ledger/src/mcp/stdioLedgerTools.ts`
  );
  const { InMemoryLedgerStore } = await import(
    `${workspace}/packages/ledger/src/store/InMemoryLedgerStore.ts`
  );
  // Present in the cutover tree only; absent at the RS3-era commit.
  let projectionSentence = "";
  let ackSentences: string[] = [];
  try {
    const contract = await import(
      `${workspace}/packages/ledger/src/mcp/wireResponseContract.ts`
    );
    projectionSentence = contract.ITEM_PROJECTION_DESCRIPTION ?? "";
    ackSentences = [
      contract.ITEM_MUTATION_ACK_DESCRIPTION,
      contract.MILESTONE_MUTATION_ACK_DESCRIPTION,
      contract.LEDGER_MUTATION_ACK_DESCRIPTION,
    ].filter((s: unknown): s is string => typeof s === "string");
  } catch {
    projectionSentence = "";
  }

  const store = new InMemoryLedgerStore();
  await store.init();
  const server = new McpServer(
    { name: "t679-schema-probe", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(server, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "t679-schema-probe-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  const listed = (await client.listTools()) as { tools: ToolDefinition[] };
  const tools = [...listed.tools].sort((a, b) => a.name.localeCompare(b.name));

  const perTool = tools.map((tool) => {
    const { bytes, tokens } = sizeOf(tool);
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    return {
      name: tool.name,
      bytes,
      tokens,
      hasProjectionParam:
        properties !== undefined && properties["projection"] !== undefined,
    };
  });
  const whole = sizeOf(tools);
  const strippedTools = tools.map((tool) => stripProjection(tool, projectionSentence));
  const stripped = sizeOf(strippedTools);

  const stripSentences = (list: ToolDefinition[], sentences: string[]): ToolDefinition[] =>
    list.map((tool) => {
      const copy = structuredClone(tool);
      if (copy.description !== undefined) {
        for (const sentence of sentences) {
          if (sentence === "") continue;
          copy.description = copy.description.split(sentence).join("");
        }
      }
      return copy;
    });
  const stripAuthoritative = (list: ToolDefinition[]): ToolDefinition[] =>
    list.map((tool) => {
      const copy = structuredClone(tool);
      if (copy.description !== undefined) {
        const marker = "\n\nAuthoritative response:";
        const at = copy.description.indexOf(marker);
        if (at !== -1) copy.description = copy.description.slice(0, at);
      }
      return copy;
    });

  const withoutAck = sizeOf(stripSentences(tools, ackSentences));
  const withoutAuthoritative = sizeOf(stripAuthoritative(tools));
  const withoutAll = sizeOf(
    stripAuthoritative(stripSentences(strippedTools, ackSentences)),
  );

  await client.close();
  await server.close();

  return {
    workspace,
    toolCount: tools.length,
    totalBytes: whole.bytes,
    totalTokens: whole.tokens,
    perTool,
    projectionParamTools: perTool.filter((t) => t.hasProjectionParam).map((t) => t.name),
    counterfactualWithoutProjection: {
      totalBytes: stripped.bytes,
      totalTokens: stripped.tokens,
      tokensAttributableToProjection: whole.tokens - stripped.tokens,
    },
    contractAttributable: {
      projectionTokens: whole.tokens - stripped.tokens,
      ackSentenceTokens: whole.tokens - withoutAck.tokens,
      authoritativeResponseTokens: whole.tokens - withoutAuthoritative.tokens,
      allTokens: whole.tokens - withoutAll.tokens,
    },
  };
}

if (import.meta.main) {
  const result = await measureSchemaOverhead(arg("workspace"));
  const jsonOut = process.argv.includes("--json")
    ? resolve(arg("json"))
    : null;
  if (jsonOut !== null) {
    writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(
    JSON.stringify(
      {
        workspace: result.workspace,
        toolCount: result.toolCount,
        totalBytes: result.totalBytes,
        totalTokens: result.totalTokens,
        projectionParamTools: result.projectionParamTools,
        counterfactualWithoutProjection: result.counterfactualWithoutProjection,
        contractAttributable: result.contractAttributable,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
