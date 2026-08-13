import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp, type McpHttpHandlers } from "../src/main.js";

const ORDINARY_TOKEN = "ordinary-session-token";
const MANAGEMENT_TOKEN = "management-session-token";

async function startFixture(): Promise<{
  readonly handlers: McpHttpHandlers;
  readonly storeAccesses: () => number;
  readonly displayNameCalls: () => number;
  close(): Promise<void>;
}> {
  const store = new InMemoryLedgerStore();
  await store.init();
  let accesses = 0;
  let displayNameCalls = 0;
  const originalRecordUsage = store.recordMcpUsage.bind(store);
  store.recordMcpUsage = async (endpoint, bytesIn, bytesOut) => {
    accesses += 1;
    await originalRecordUsage(endpoint, bytesIn, bytesOut);
  };
  const handlers = attachMcpHttp(
    store,
    () => {
      displayNameCalls += 1;
      return "authority-session-test";
    },
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ordinaryToken: ORDINARY_TOKEN, managementToken: MANAGEMENT_TOKEN },
  );
  return {
    handlers,
    storeAccesses: () => accesses,
    displayNameCalls: () => displayNameCalls,
    close: async () => {
      await store.dispose();
    },
  };
}

async function initializeRequest(
  handlers: McpHttpHandlers,
  token: string,
  sessionId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  return await handlers.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "authority-session-test", version: "0.0.1" },
      },
    }),
  }));
}

async function initialize(handlers: McpHttpHandlers, token: string): Promise<string> {
  const response = await initializeRequest(handlers, token);
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("expected initialized MCP session id");
  await response.text();
  return sessionId;
}

async function closeSession(
  handlers: McpHttpHandlers,
  sessionId: string,
  token: string,
): Promise<Response> {
  return await handlers.handle(new Request("http://localhost/mcp", {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: `Bearer ${token}`,
    },
  }));
}

async function rawToolCall(
  handlers: McpHttpHandlers,
  sessionId: string,
  token: string,
): Promise<Response> {
  return await handlers.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "enumerate_ledgers", arguments: {} },
    }),
  }));
}

describe("HTTP workset authority session binding", () => {
  test("rejects credentials substituted across ordinary and management sessions before store access", async () => {
    const fixture = await startFixture();
    const ordinarySessionId = await initialize(fixture.handlers, ORDINARY_TOKEN);
    const managementSessionId = await initialize(fixture.handlers, MANAGEMENT_TOKEN);
    try {
      const before = fixture.storeAccesses();

      const managementOnOrdinary = await rawToolCall(
        fixture.handlers,
        ordinarySessionId,
        MANAGEMENT_TOKEN,
      );
      expect(managementOnOrdinary.status).toBe(401);
      const ordinaryOnManagement = await rawToolCall(
        fixture.handlers,
        managementSessionId,
        ORDINARY_TOKEN,
      );
      expect(ordinaryOnManagement.status).toBe(401);
      expect(fixture.storeAccesses()).toBe(before);

      const validManagement = await rawToolCall(
        fixture.handlers,
        managementSessionId,
        MANAGEMENT_TOKEN,
      );
      expect(validManagement.status).toBe(200);
      await validManagement.text();
      expect(fixture.storeAccesses()).toBe(before + 1);
    } finally {
      await closeSession(fixture.handlers, ordinarySessionId, ORDINARY_TOKEN);
      await closeSession(fixture.handlers, managementSessionId, MANAGEMENT_TOKEN);
      await fixture.close();
    }
  });

  test("DELETE destroys the binding so the former session id cannot be reused", async () => {
    const fixture = await startFixture();
    const sessionId = await initialize(fixture.handlers, MANAGEMENT_TOKEN);
    expect((await closeSession(fixture.handlers, sessionId, MANAGEMENT_TOKEN)).status).toBe(200);

    const reused = await rawToolCall(fixture.handlers, sessionId, MANAGEMENT_TOKEN);
    expect(reused.status).toBe(400);
    expect(fixture.storeAccesses()).toBe(0);
    await fixture.close();
  });

  test("a deleted session id cannot reopen through initialize or invoke display resolution", async () => {
    const fixture = await startFixture();
    const sessionId = await initialize(fixture.handlers, MANAGEMENT_TOKEN);
    expect(fixture.displayNameCalls()).toBe(1);
    expect((await closeSession(fixture.handlers, sessionId, MANAGEMENT_TOKEN)).status).toBe(200);

    const replay = await initializeRequest(
      fixture.handlers,
      MANAGEMENT_TOKEN,
      sessionId,
    );
    expect(replay.status).toBe(400);
    expect(fixture.displayNameCalls()).toBe(1);
    expect(fixture.storeAccesses()).toBe(0);
    await fixture.close();
  });
});
