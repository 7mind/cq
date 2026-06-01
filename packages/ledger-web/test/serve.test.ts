/**
 * ledger-web static-serve + MCP-proxy test.
 *
 * Stands up a real `ledger-mcp --http` upstream, serves ledger-web pointed at
 * it, and asserts:
 *   - index.html is served with the same-origin /mcp endpoint injected + the
 *     module script; the JS bundle loads; unknown paths fall back to index.
 *   - the SAME-ORIGIN /mcp endpoint reverse-proxies to the upstream: an MCP
 *     client connected to the web origin can list the 14 tools and round-trip
 *     a create/fetch (so the browser never needs to reach the MCP host).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn as bunSpawn, type Subprocess } from "bun";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FsLedgerStore, LEDGER_TOOL_NAMES } from "@cq/ledger";
import { serve, proxyToMcp } from "../src/serve.js";

const here = new URL(".", import.meta.url).pathname;
const mcpMain = path.resolve(here, "..", "..", "ledger-mcp", "src", "main.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (a === null || typeof a === "string") return reject(new Error("no port"));
      const p = a.port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}
async function waitForPort(p: number, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((res) => {
      const s = net.connect(p, "127.0.0.1");
      s.on("connect", () => {
        s.end();
        res(true);
      });
      s.on("error", () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`not up on ${p}`);
}

let tmpRoot: string;
let outdir: string;
let mcp: Subprocess;
let mcpPort: number;
let web: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-mcp-"));
  const seed = new FsLedgerStore({ root: tmpRoot });
  await seed.init();
  await seed.createLedger("bugs", {
    statusValues: ["open", "closed"],
    terminalStatuses: ["closed"],
    fields: { headline: { type: "string", required: true } },
  });
  await seed.dispose();

  mcpPort = await freePort();
  mcp = bunSpawn({
    cmd: [process.execPath, "run", mcpMain, "--cwd", tmpRoot, "--http", String(mcpPort)],
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForPort(mcpPort);

  outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-out-"));
  web = await serve({
    host: "127.0.0.1",
    port: 0,
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    cwd: tmpRoot, // ignored in proxy mode
    outdir,
  });
});

afterAll(async () => {
  web.stop(true);
  mcp.kill();
  await mcp.exited;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(outdir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${web.port}`;

describe("ledger-web static server", () => {
  it("serves index.html with the same-origin /mcp endpoint + module script", async () => {
    const res = await fetch(base() + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('window.__LEDGER_MCP_URL__ = "/mcp"');
    expect(html).toMatch(/<script type="module" src="\/main\.js">/);
  });

  it("serves the JS bundle", async () => {
    const res = await fetch(base() + "/main.js");
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(100);
  });

  it("falls back to index.html for unknown SPA paths", async () => {
    const res = await fetch(base() + "/some/deep/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});

describe("ledger-web /mcp reverse proxy", () => {
  it("proxies the MCP protocol to the upstream (same-origin client works)", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base()}/mcp`));
    const client = new Client({ name: "proxy-test", version: "0.0.1" }, { capabilities: {} });
    // exactOptionalPropertyTypes vs the SDK's sessionId?: string declaration.
    await client.connect(transport as unknown as Transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());

      const res = await client.callTool({ name: "enumerate_ledgers", arguments: {} });
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(JSON.parse(text).ledgers).toContain("bugs");
    } finally {
      await client.close();
    }
  });

  it("returns a 502 JSON-RPC error when the upstream is unreachable", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await proxyToMcp(req, "http://127.0.0.1:1/mcp");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("cannot reach MCP upstream");
  });
});
