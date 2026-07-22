/**
 * McpLedgerClient.connect(url, token) header passthrough (T588 / Q273).
 *
 * A `cq serve --token` hub requires `Authorization: Bearer <token>` on every
 * `/mcp` request (hubRouting.test.ts asserts the SERVER side of the gate over
 * live Postgres). This is the CLIENT side, hermetic: a real `attachMcpHttp`
 * server over an in-memory store, wrapped so the test can observe the
 * incoming Authorization header on the very first request the SDK transport
 * issues (its `initialize` POST) — proving `connect(url, token)` actually
 * attaches the header, and `connect(url)` (no token) sends none.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { InMemoryLedgerStore } from "@cq/ledger";
import { attachMcpHttp } from "@cq/ledger-mcp";
import { McpLedgerClient } from "../src/mcpClient.js";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Boots a real MCP-over-HTTP server, capturing the first request's Authorization header into `captured`. */
function startCapturingServer(captured: { header: string | null }): string {
  const store = new InMemoryLedgerStore();
  const { handle } = attachMcpHttp(store, "auth-token-test");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Promise<Response> {
      if (captured.header === null) captured.header = req.headers.get("authorization");
      return handle(req);
    },
  });
  return `http://127.0.0.1:${server.port}/mcp`;
}

describe("McpLedgerClient.connect token passthrough (T588)", () => {
  it("sends Authorization: Bearer <token> when a token is given", async () => {
    const captured: { header: string | null } = { header: null };
    const url = startCapturingServer(captured);
    const client = await McpLedgerClient.connect(url, "my-secret-token");
    expect(captured.header).toBe("Bearer my-secret-token");
    expect(client.displayName()).toBe("auth-token-test");
  });

  it("sends no Authorization header when no token is given", async () => {
    const captured: { header: string | null } = { header: null };
    const url = startCapturingServer(captured);
    await McpLedgerClient.connect(url);
    expect(captured.header).toBeNull();
  });
});
