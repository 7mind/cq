import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

async function probeConnection(input: {
  readonly ordinaryToken: string | null;
  readonly managementToken: string | null;
  readonly presentedToken: string | null;
}): Promise<{ readonly status: number; readonly serialization: string }> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const handlers = attachMcpHttp(
    store,
    "authority-http-test",
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ordinaryToken: input.ordinaryToken,
      managementToken: input.managementToken,
    },
  );
  try {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (input.presentedToken !== null) {
      headers["authorization"] = `Bearer ${input.presentedToken}`;
    }
    const response = await handlers.handle(new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "authority-http-test", version: "0.0.1" },
        },
      }),
    }));
    return {
      status: response.status,
      serialization: await response.text(),
    };
  } finally {
    await store.dispose();
  }
}

describe("HTTP workset management authority", () => {
  test("keeps open loopback observe access and ordinary-token compatibility", async () => {
    const open = await probeConnection({
      ordinaryToken: null,
      managementToken: null,
      presentedToken: null,
    });
    const ordinary = await probeConnection({
      ordinaryToken: "ordinary-secret",
      managementToken: "management-secret",
      presentedToken: "ordinary-secret",
    });
    expect(open.status).toBe(200);
    expect(ordinary.status).toBe(200);
  });

  test("enables management only when the distinct credential is configured and redacts both secrets", async () => {
    const disabled = await probeConnection({
      ordinaryToken: "ordinary-secret",
      managementToken: null,
      presentedToken: "management-secret",
    });
    expect(disabled.status).toBe(401);

    const management = await probeConnection({
      ordinaryToken: "ordinary-secret",
      managementToken: "management-secret",
      presentedToken: "management-secret",
    });
    expect(management.status).toBe(200);
    expect(management.serialization).not.toContain("ordinary-secret");
    expect(management.serialization).not.toContain("management-secret");
  });
});
