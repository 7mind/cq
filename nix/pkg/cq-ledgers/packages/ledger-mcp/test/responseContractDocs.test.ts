import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPACT_ITEM_FIELD_NAMES,
  createManagementLedgerMcpTools,
  createTrustedWorksetManagementAuthority,
  InMemoryLedgerStore,
  ITEM_PROJECTION_DESCRIPTION,
  LEDGER_RESPONSE_CONTRACTS,
  MANAGEMENT_LEDGER_TOOL_NAMES,
  type DispatchCapability,
} from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const packageReadmePath = path.resolve(import.meta.dir, "../README.md");
const unavailable = async (): Promise<never> => {
  throw new Error("documentation test does not invoke dispatch tools");
};
const dispatchCapability: DispatchCapability = {
  prepare: unavailable,
  fetchInput: unavailable,
  storeResult: unavailable,
  confirmCompletion: unavailable,
  abort: unavailable,
  fetch: unavailable,
};

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

interface ResponseMatrixRow {
  readonly tool: string;
  readonly kind: string;
  readonly response: string;
}

function responseMatrixRows(markdown: string): ResponseMatrixRow[] {
  const matrix = section(markdown, "ledger-response-contract");
  return [...matrix.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gm)].map(
    ([, tool, kind, response]) => ({
      tool: tool!,
      kind: kind!,
      response: response!.replaceAll("\\|", "|"),
    }),
  );
}

function assertCanonicalResponseMatrix(markdown: string): void {
  expect(responseMatrixRows(markdown)).toEqual(
    MANAGEMENT_LEDGER_TOOL_NAMES.map((tool) => ({
      tool,
      kind: LEDGER_RESPONSE_CONTRACTS[tool].kind,
      response: LEDGER_RESPONSE_CONTRACTS[tool].responseCell,
    })),
  );
}

function mutateResponseCell(
  markdown: string,
  tool: keyof typeof LEDGER_RESPONSE_CONTRACTS,
  remove: string,
): string {
  const contract = LEDGER_RESPONSE_CONTRACTS[tool];
  const mutatedResponse = contract.responseCell.replace(remove, "");
  if (mutatedResponse === contract.responseCell) {
    throw new Error(`response mutation token is absent for ${tool}: ${remove}`);
  }
  return markdown.replace(contract.responseCell, mutatedResponse);
}

const RESPONSE_DESCRIPTION_MARKER = "\n\nAuthoritative response: ";

function authoritativeResponseDescription(description: string): string {
  const markerIndex = description.lastIndexOf(RESPONSE_DESCRIPTION_MARKER);
  if (markerIndex === -1) {
    throw new Error("tool description lacks its authoritative response description");
  }
  return description.slice(markerIndex + RESPONSE_DESCRIPTION_MARKER.length);
}

function assertAuthoritativeResponseDescription(description: string, expected: string): void {
  expect(authoritativeResponseDescription(description)).toBe(expected);
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
    assertCanonicalResponseMatrix(readme);

    const compactFields = [...section(readme, "compact-item-fields").matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(compactFields).toEqual([...COMPACT_ITEM_FIELD_NAMES]);
    expect(readme).toContain('projection: "complement"');
    expect(readme).toContain("fields(full) = fields(compact) ∪ fields(complement)");
    expect(readme).toContain("After a `compact` read");
    expect(readme).toContain("closed 59-tool matrix");
  });

  // Regression: T678 review round 2 — field-level documentation drift must fail.
  it("rejects retained-field mutations in matrix cells and live descriptions", async () => {
    const readme = await packageReadme();
    const matrixMutation = mutateResponseCell(readme, "enumerate_ledgers", ", progressTotal");
    expect(matrixMutation).not.toBe(readme);
    expect(() => assertCanonicalResponseMatrix(matrixMutation)).toThrow();

    const acknowledgement = LEDGER_RESPONSE_CONTRACTS.update_item;
    const liveDescription = `${RESPONSE_DESCRIPTION_MARKER}${acknowledgement.responseDescription}`;
    const descriptionMutation = liveDescription.replace(", updatedAt", "");
    expect(descriptionMutation).not.toBe(liveDescription);
    expect(() =>
      assertAuthoritativeResponseDescription(
        descriptionMutation,
        acknowledgement.responseDescription,
      ),
    ).toThrow();
  });

  it("states the breaking cutover, selection, pagination, acknowledgement, and rejected alternatives", async () => {
    const [readme, rootReadme, projectGuidance] = await Promise.all([
      packageReadme(),
      readFile(path.join(repoRoot, "README.md"), "utf8"),
      readFile(path.join(repoRoot, "CLAUDE.md"), "utf8"),
    ]);

    expect(rootReadme).toContain("59-tool ledger surface");
    expect(rootReadme).toContain("compact/complement/full projection");
    expect(readme).toContain("single breaking cutover");
    expect(readme).toContain("No legacy peer is supported");
    expect(readme).toContain("There is no compatibility flag");
    expect(readme).toContain("There is no default projection");
    expect(readme).toContain("nextOffset");
    expect(readme).toContain("Markdown responses were rejected");
    expect(readme).toContain("The general `fetch_items` alternative was rejected");
    expect(readme).not.toContain("Milestone acknowledgement");
    expect(projectGuidance).toContain('projection: "compact"');
    expect(projectGuidance).toContain('projection: "full"');
    expect(projectGuidance).toContain('projection: "complement"');
    expect(projectGuidance).toContain("fields(full) = fields(compact) ∪ fields(complement)");
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

    const server = createLedgerMcpServer({
      store,
      displayName: "docs-test",
      dispatchCapability,
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });
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
      const directToolByName = new Map(
        createManagementLedgerMcpTools(
          store,
          undefined,
          undefined,
          undefined,
          "",
          undefined,
          dispatchCapability,
        ).map((tool) => [tool.name, tool]),
      );
      for (const toolName of MANAGEMENT_LEDGER_TOOL_NAMES) {
        const tool = toolByName.get(toolName);
        const directTool = directToolByName.get(toolName);
        expect(tool).toBeDefined();
        expect(directTool).toBeDefined();
        const contract = LEDGER_RESPONSE_CONTRACTS[toolName];
        expect(tool?.description).toBe(directTool?.description);
        if ((tool?.description ?? "").includes(RESPONSE_DESCRIPTION_MARKER)) {
          assertAuthoritativeResponseDescription(
            tool?.description ?? "",
            contract.responseDescription,
          );
        }
        if (contract.kind === "mandatory-item-projection") {
          expect(tool?.inputSchema.required).toContain("projection");
          expect(tool?.description).toContain(ITEM_PROJECTION_DESCRIPTION);
          expect(tool?.description).not.toContain(
            "projection is required: compact returns identity, status, timestamps, provenance, summary fields, and references; full returns every item field",
          );
        }
      }

      const examples = documentedExamples(await packageReadme());
      expect(examples.map((example) => example.arguments["projection"])).toContain("complement");
      for (const example of examples) {
        if (!Object.hasOwn(LEDGER_RESPONSE_CONTRACTS, example.tool)) {
          throw new Error(`unknown documented tool ${example.tool}`);
        }
        const toolName = example.tool as keyof typeof LEDGER_RESPONSE_CONTRACTS;
        const contract = LEDGER_RESPONSE_CONTRACTS[toolName];
        if (contract.kind === "mandatory-item-projection") {
          expect(example.arguments["projection"]).toMatch(/^(compact|full|complement)$/);
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
