import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "@cq/ledger";
import { createImplementationEvidenceFixture } from "../../ledger/test/implementationEvidenceTestSupport.js";
import { attachMcpHttp } from "../src/main.js";

async function rpc(
  handlers: ReturnType<typeof attachMcpHttp>,
  body: Record<string, unknown>,
  token: string,
  sessionId?: string,
): Promise<{ response: Response; message: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  const response = await handlers.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return { response, message: JSON.parse(data ?? text) as Record<string, unknown> };
}

function toolNames(message: Record<string, unknown>): readonly string[] {
  return (
    message["result"] as { readonly tools: readonly { readonly name: string }[] }
  ).tools.map(({ name }) => name);
}

function textPayload(message: Record<string, unknown>): Record<string, unknown> {
  const content = (message["result"] as { content: Array<{ type: string; text?: string }> })
    .content[0];
  if (content?.type !== "text" || content.text === undefined)
    throw new Error("status HTTP call returned no text payload");
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe("implementation evidence service status HTTP [Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("requires an authenticated management session", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const handlers = attachMcpHttp(
      ledger,
      "service-status-http",
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "full",
      undefined,
      { ordinaryToken: "ordinary", managementToken: "management" },
      "observe",
      false,
      fixture.service,
    );
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "service-status-http", version: "0.0.1" },
      },
    };
    const ordinary = await rpc(handlers, initialize, "ordinary");
    const ordinarySession = ordinary.response.headers.get("mcp-session-id");
    if (ordinarySession === null) throw new Error("ordinary session is missing");
    const ordinaryTools = await rpc(
      handlers,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      "ordinary",
      ordinarySession,
    );
    expect(toolNames(ordinaryTools.message)).not.toContain(
      "get_implementation_evidence_service_status",
    );

    const management = await rpc(handlers, initialize, "management");
    const managementSession = management.response.headers.get("mcp-session-id");
    if (managementSession === null) throw new Error("management session is missing");
    const called = await rpc(
      handlers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_implementation_evidence_service_status", arguments: {} },
      },
      "management",
      managementSession,
    );
    expect(called.response.status).toBe(200);
    expect(textPayload(called.message)).toMatchObject({
      protocolVersion: 2,
      bootstrapPhase: "historical-dispatch",
      startupBuildCommit: "a".repeat(40),
      repositoryHead: "a".repeat(40),
    });
  });
});
