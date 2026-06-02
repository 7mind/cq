/**
 * ledger-mcp Streamable HTTP transport test.
 *
 * Starts the server's `serveHttp` over Bun.serve on an ephemeral port,
 * connects a real `@modelcontextprotocol/sdk` Client through the
 * StreamableHTTPClientTransport, and asserts the 14-tool surface plus a
 * full create → update → fetch → search round-trip works over HTTP and
 * persists to disk.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FsLedgerStore, LEDGER_TOOL_NAMES } from "@cq/ledger";
import { serveHttp, MCP_HTTP_PATH } from "../src/main.js";

let tmpRoot: string;
let store: FsLedgerStore;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: URL;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-http-"));
  store = new FsLedgerStore({ root: tmpRoot });
  await store.init();
  await store.createLedger("xenos", {
    statusValues: ["open", "done"],
    terminalStatuses: ["done"],
    fields: { note: { type: "string", required: false } },
  });
  server = serveHttp(store, { host: "127.0.0.1", port: 0 }, "test-project");
  baseUrl = new URL(`http://127.0.0.1:${server.port}${MCP_HTTP_PATH}`);
});

afterAll(async () => {
  server.stop(true);
  await store.dispose();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StreamableHTTPClientTransport(baseUrl);
  const client = new Client({ name: "http-test", version: "0.0.1" }, { capabilities: {} });
  // exactOptionalPropertyTypes vs the SDK's sessionId?: string declaration.
  await client.connect(transport as unknown as Transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("ledger-mcp Streamable HTTP", () => {
  it("lists the 14 ledger tools over HTTP", async () => {
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
    });
  });

  it("advertises usage instructions on initialize", async () => {
    await withClient(async (client) => {
      const instr = client.getInstructions() ?? "";
      expect(instr).toContain("planning ledger");
      expect(instr).toContain("create_item");
    });
  });

  it("404s on a non-/mcp path", async () => {
    const res = await fetch(new URL(`http://127.0.0.1:${server.port}/nope`));
    expect(res.status).toBe(404);
    await res.text();
  });

  it("answers a CORS preflight and exposes mcp-session-id", async () => {
    const res = await fetch(new URL(`http://127.0.0.1:${server.port}${MCP_HTTP_PATH}`), {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, mcp-session-id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "mcp-session-id",
    );
    expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
      "mcp-session-id",
    );
    await res.text();
  });

  it("supports a full create → update → fetch → search round-trip over HTTP", async () => {
    let itemId = "";
    await withClient(async (client) => {
      const ms = decode<{ milestone: { id: string } }>(
        await client.callTool({
          name: "create_milestone",
          arguments: { id: "M11", title: "http round-trip" },
        }),
      );
      expect(ms.milestone.id).toBe("M11");

      const created = decode<{ item: { id: string; status: string } }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "xenos",
            milestone_id: "M11",
            status: "open",
            fields: { note: "tyranid sighting" },
          },
        }),
      );
      itemId = created.item.id;

      const updated = decode<{ item: { status: string } }>(
        await client.callTool({
          name: "update_item",
          arguments: { ledger_id: "xenos", item_id: itemId, status: "done" },
        }),
      );
      expect(updated.item.status).toBe("done");

      const hits = decode<{ results: Array<{ ledgerId: string }> }>(
        await client.callTool({ name: "fts_search", arguments: { query: "tyranid" } }),
      );
      expect(hits.results.some((h) => h.ledgerId === "xenos")).toBe(true);
    });

    // Fresh store confirms the writes hit disk.
    const verify = new FsLedgerStore({ root: tmpRoot });
    await verify.init();
    const item = verify.fetchItem("xenos", itemId);
    expect(item.status).toBe("done");
    await verify.dispose();
  });
});
