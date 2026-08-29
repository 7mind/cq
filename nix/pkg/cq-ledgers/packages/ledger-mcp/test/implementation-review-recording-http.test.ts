import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "@cq/ledger";
import {
  IMPLEMENTATION_RESULT,
  IMPLEMENTATION_WORKER,
  createImplementationEvidenceFixture,
} from "../../ledger/test/implementationEvidenceTestSupport.js";
import { attachMcpHttp } from "../src/main.js";

function textPayload(result: unknown): unknown {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("implementation evidence HTTP response contained no text payload");
  }
  return JSON.parse(first.text);
}

async function rpc(
  handlers: ReturnType<typeof attachMcpHttp>,
  body: Record<string, unknown>,
  sessionId?: string,
  token?: string,
): Promise<{ response: Response; message: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
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

describe("implementation evidence HTTP transport [Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("exposes protected operations only to authenticated management HTTP", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const handlers = attachMcpHttp(
      ledger,
      "implementation-evidence-http",
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
        clientInfo: { name: "implementation-evidence-http", version: "0.0.1" },
      },
    };
    const ordinaryInitialized = await rpc(handlers, initialize, undefined, "ordinary");
    const ordinarySessionId = ordinaryInitialized.response.headers.get("mcp-session-id");
    if (ordinarySessionId === null) throw new Error("ordinary initialization returned no session id");
    const ordinaryTools = await rpc(
      handlers,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ordinarySessionId,
      "ordinary",
    );
    expect(
      (
        ordinaryTools.message["result"] as {
          tools: Array<{ name: string }>;
        }
      ).tools.some((tool) => tool.name === "prepare_implementation_review_panel"),
    ).toBe(false);

    const initialized = await rpc(handlers, initialize, undefined, "management");
    expect(initialized.response.status).toBe(200);
    const sessionId = initialized.response.headers.get("mcp-session-id");
    if (sessionId === null) throw new Error("HTTP initialization returned no session id");
    const called = await rpc(
      handlers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "prepare_implementation_review_panel",
          arguments: {
            task_ref: "tasks:T2345",
            result_commit: IMPLEMENTATION_RESULT,
            worker_dispatch: IMPLEMENTATION_WORKER,
            operation_id: "panel",
            author: "parent",
          },
        },
      },
      sessionId,
      "management",
    );
    expect(called.response.status).toBe(200);
    expect(textPayload(called.message["result"])).toMatchObject({
      status: "existing",
      panelRef: fixture.panel.panelRef,
    });
    const finalized = await rpc(
      handlers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "finalize_implementation_review_attempt",
          arguments: {
            attempt_ref: fixture.attemptRef,
            operation_id: "finalize",
            author: "parent",
          },
        },
      },
      sessionId,
      "management",
    );
    expect(finalized.response.status).toBe(200);
    expect(textPayload(finalized.message["result"])).toMatchObject({
      status: "existing",
      attemptRef: fixture.attemptRef,
      terminalState: "approved",
      outcome: { kind: "verdict", verdict: { verdict: "approve" } },
    });
  });
});
