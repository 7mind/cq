import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPACT_ITEM_FIELD_NAMES,
  GET_PLANNERS_RESPONSE_DESCRIPTION,
  GET_REVIEWERS_RESPONSE_DESCRIPTION,
  InMemoryLedgerStore,
  LEDGER_RESPONSE_CONTRACTS,
  LEDGER_TOOL_NAMES,
} from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const packageReadmePath = path.resolve(import.meta.dir, "../README.md");

function section(markdown: string, name: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`missing documentation section ${name}`);
  }
  return markdown.slice(startIndex + start.length, endIndex);
}

async function packageReadme(): Promise<string> {
  return readFile(packageReadmePath, "utf8");
}

interface DocumentedExample {
  tool: string;
  arguments: Record<string, unknown>;
  consume?: string;
}

function documentedExamples(markdown: string): DocumentedExample[] {
  const examples = section(markdown, "ledger-response-examples");
  const json = examples.match(/```json\s+([\s\S]*?)```/)?.[1];
  if (json === undefined) throw new Error("ledger-response-examples lacks a JSON block");
  return JSON.parse(json) as DocumentedExample[];
}

function textJson(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
  return JSON.parse(text) as Record<string, unknown>;
}

function valueAtPath(value: Record<string, unknown>, dottedPath: string): unknown {
  let current: unknown = value;
  for (const segment of dottedPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

describe("public MCP response-contract documentation", () => {
  it("publishes the exhaustive live tool-category matrix and compact field allowlist", async () => {
    const readme = await packageReadme();
    const matrix = section(readme, "ledger-response-contract");
    const rows = [...matrix.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (.+) \|$/gm)].map(
      ([, tool, kind, response]) => ({ tool, kind, response }),
    );

    expect(rows.map(({ tool, kind }) => [tool, kind])).toEqual(
      LEDGER_TOOL_NAMES.map((tool) => [tool, LEDGER_RESPONSE_CONTRACTS[tool].kind]),
    );
    expect(rows.find((row) => row.tool === "get_reviewers")?.response).toBe(
      `\`${GET_REVIEWERS_RESPONSE_DESCRIPTION}\`.`,
    );
    expect(rows.find((row) => row.tool === "get_planners")?.response).toBe(
      `\`${GET_PLANNERS_RESPONSE_DESCRIPTION}\`.`,
    );

    const compactFields = [...section(readme, "compact-item-fields").matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]);
    expect(compactFields).toEqual([...COMPACT_ITEM_FIELD_NAMES]);
  });

  it("states the breaking cutover, selection, pagination, acknowledgement, and rejected alternatives", async () => {
    const [readme, rootReadme, projectGuidance] = await Promise.all([
      packageReadme(),
      readFile(path.join(repoRoot, "README.md"), "utf8"),
      readFile(path.join(repoRoot, "CLAUDE.md"), "utf8"),
    ]);

    expect(rootReadme).toContain("27-tool ledger surface");
    expect(readme).toContain("single breaking cutover");
    expect(readme).toContain("No legacy peer is supported");
    expect(readme).toContain("There is no compatibility flag");
    expect(readme).toContain("There is no default projection");
    expect(readme).toContain("nextOffset");
    expect(readme).toContain("Markdown responses were rejected");
    expect(readme).toContain("The general `fetch_items` alternative was rejected");
    expect(projectGuidance).toContain('projection: "compact"');
    expect(projectGuidance).toContain('projection: "full"');
    expect(projectGuidance).toContain("mutation acknowledgement");
  });

  it("keeps examples valid against live schemas and makes acknowledgement consumption explicit", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ title: "Documented contract" });
    const item = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "Documented task",
        description: "Narrative used by the full-projection example",
      },
    });
    expect(milestone.id).toBe("M1");
    expect(item.id).toBe("T1");

    const server = createLedgerMcpServer({ store, displayName: "docs-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "response-contract-docs", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      for (const toolName of LEDGER_TOOL_NAMES) {
        const tool = toolByName.get(toolName);
        expect(tool).toBeDefined();
        const contract = LEDGER_RESPONSE_CONTRACTS[toolName];
        if (contract.kind === "mandatory-item-projection") {
          expect(tool?.inputSchema.required).toContain("projection");
          expect(tool?.description).toContain("required");
          expect(tool?.description).toContain("compact");
          expect(tool?.description).toContain("full");
        }
        if (contract.kind === "fixed-acknowledgement") {
          expect(tool?.description).toContain("acknowledgement");
        }
      }
      expect(toolByName.get("get_reviewers")?.description).toContain(
        GET_REVIEWERS_RESPONSE_DESCRIPTION,
      );
      expect(toolByName.get("get_planners")?.description).toContain(
        GET_PLANNERS_RESPONSE_DESCRIPTION,
      );

      for (const example of documentedExamples(await packageReadme())) {
        if (!Object.hasOwn(LEDGER_RESPONSE_CONTRACTS, example.tool)) {
          throw new Error(`unknown documented tool ${example.tool}`);
        }
        const toolName = example.tool as keyof typeof LEDGER_RESPONSE_CONTRACTS;
        const contract = LEDGER_RESPONSE_CONTRACTS[toolName];
        if (contract.kind === "mandatory-item-projection") {
          expect(example.arguments["projection"]).toMatch(/^(compact|full)$/);
        }
        if (contract.kind === "fixed-acknowledgement") {
          expect(example.consume).toBeDefined();
        }

        const result = (await client.callTool({
          name: toolName,
          arguments: example.arguments,
        })) as {
          isError?: boolean;
          content: Array<{ type: string; text?: string }>;
        };
        expect(result.isError ?? false).toBe(false);
        if (example.consume !== undefined) {
          expect(valueAtPath(textJson(result), example.consume)).toBeDefined();
        }
      }
    } finally {
      await client.close();
      await store.dispose();
    }
  });
});
