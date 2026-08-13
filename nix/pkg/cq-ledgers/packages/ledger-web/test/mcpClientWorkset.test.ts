import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { WorksetResult, WorksetResultFor } from "@cq/ledger";
import { LedgerToolError, McpLedgerClient } from "../src/mcpClient.js";
import type { WorksetCapableLedgerClient } from "../src/types.js";

interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function stubClient(
  responses: readonly WorksetResult[],
): { readonly client: McpLedgerClient; readonly calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let responseIndex = 0;
  const sdk = {
    callTool: async (request: ToolCall) => {
      calls.push(request);
      const response = responses[responseIndex];
      responseIndex += 1;
      if (response === undefined) throw new Error("unexpected workset call");
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  };
  return {
    client: new McpLedgerClient(sdk as unknown as Client),
    calls,
  };
}

describe("McpLedgerClient.workset", () => {
  it("forwards get, fetch, set, and empty clear as exactly one workset call each", async () => {
    const emptyGraph = {
      roots: [],
      inactiveRoots: [],
      nodes: [],
      edges: [],
      restrictive: false,
      projection: "id" as const,
    };
    const { client, calls } = stubClient([
      { op: "get", graph: emptyGraph },
      { op: "fetch", graph: emptyGraph },
      { op: "set", acknowledgement: { roots: ["tasks:T1"], epoch: 1 } },
      { op: "set", acknowledgement: { roots: [], epoch: 2 } },
    ]);

    expect(await client.workset({ op: "get", projection: "id" })).toEqual({
      op: "get",
      graph: emptyGraph,
    });
    expect(
      await client.workset({ op: "fetch", roots: ["T1"], projection: "compact" }),
    ).toEqual({ op: "fetch", graph: emptyGraph });
    expect(await client.workset({ op: "set", roots: ["T1"] })).toEqual({
      op: "set",
      acknowledgement: { roots: ["tasks:T1"], epoch: 1 },
    });
    expect(await client.workset({ op: "set", roots: [] })).toEqual({
      op: "set",
      acknowledgement: { roots: [], epoch: 2 },
    });

    expect(calls).toEqual([
      { name: "workset", arguments: { op: "get", projection: "id" } },
      {
        name: "workset",
        arguments: { op: "fetch", roots: ["T1"], projection: "compact" },
      },
      { name: "workset", arguments: { op: "set", roots: ["T1"] } },
      { name: "workset", arguments: { op: "set", roots: [] } },
    ]);
  });

  it("preserves a workset tool rejection as LedgerToolError", async () => {
    const sdk = {
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "workset root is inactive" }],
      }),
    };
    const client = new McpLedgerClient(sdk as unknown as Client);

    const rejection = client.workset({ op: "set", roots: ["tasks:T-missing"] });
    await expect(rejection).rejects.toBeInstanceOf(LedgerToolError);
    await expect(rejection).rejects.toMatchObject({
      tool: "workset",
      message: "workset root is inactive",
    });
  });

  it("correlates the result with the request operation at the call site", async () => {
    const { client } = stubClient([
      {
        op: "get",
        graph: {
          roots: [],
          inactiveRoots: [],
          nodes: [],
          edges: [],
          restrictive: false,
          projection: "id",
        },
      },
    ]);
    const capable: WorksetCapableLedgerClient = client;
    const result = await capable.workset({ op: "get", projection: "id" });
    const correlated: WorksetResultFor<{ readonly op: "get"; readonly projection: "id" }> =
      result;

    expect(correlated.op).toBe("get");
  });
});
