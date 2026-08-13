import { afterEach, describe, expect, test } from "bun:test";
import { RemoteLedgerClient } from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installMcpFetchProbe(): string[] {
  const authorizations: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    if (request.method === "GET") return new Response("not offered", { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const body = (await request.json()) as {
      readonly id?: string | number | null;
      readonly method?: string;
      readonly params?: { readonly protocolVersion?: string };
    };
    if (body.method?.startsWith("notifications/") === true) {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "authority-probe", version: "0.0.1" },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "authority-probe-session",
        },
      },
    );
  }) as typeof fetch;
  return authorizations;
}

describe("RemoteLedgerClient workset management authority", () => {
  test("ordinary connect remains ordinary and connectManagement sends only its management credential", async () => {
    const authorizations = installMcpFetchProbe();
    const ordinary = await RemoteLedgerClient.connect({
      serverUrl: "http://ledger.invalid",
      projectKey: "ordinary",
      token: "ordinary-credential",
    });
    expect(ordinary.connectionScope()).toBe("ordinary");
    await ordinary.close();

    const management = await RemoteLedgerClient.connectManagement({
      serverUrl: "http://ledger.invalid",
      projectKey: "management",
      managementToken: "management-credential",
    });
    expect(management.connectionScope()).toBe("management");
    await management.close();

    expect(authorizations).toContain("Bearer ordinary-credential");
    expect(authorizations).toContain("Bearer management-credential");
  });
});
