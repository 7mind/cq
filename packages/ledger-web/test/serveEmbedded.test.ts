/**
 * ledger-web EMBEDDED mode (no --mcp-url): the serve process hosts the MCP
 * server in-process and exposes it on the same-origin /mcp + /ws. Asserts:
 *   - a real MCP client connected to the web origin lists the tools and
 *     round-trips a create/fetch (no separate ledger-mcp process);
 *   - the /ws socket receives a `changed` frame after an out-of-band write to
 *     the ledger files under docs/.
 *
 * The web server is run as a SUBPROCESS (the real `ledger-web` binary) so its
 * one-time Bun.build runs in its own process — running a second in-process
 * Bun.build alongside serve.test.ts trips a Bun bundler limitation.
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

const here = new URL(".", import.meta.url).pathname;
const webMain = path.resolve(here, "..", "src", "serve.ts");

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
async function waitForPort(p: number, attempts = 200): Promise<void> {
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
  throw new Error(`web server not up on ${p}`);
}

let tmpRoot: string;
let outdir: string;
let web: Subprocess;
let webPort: number;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-embedded-"));
  const seed = new FsLedgerStore({ root: tmpRoot });
  await seed.init();
  await seed.createLedger("bugs", {
    statusValues: ["open", "closed"],
    terminalStatuses: ["closed"],
    fields: { headline: { type: "string", required: true } },
  });
  await seed.dispose();

  outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-embedded-out-"));
  webPort = await freePort();
  // No --mcp-url ⇒ embedded MCP rooted at --cwd.
  web = bunSpawn({
    cmd: [process.execPath, "run", webMain, "--cwd", tmpRoot, "--port", String(webPort)],
    env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForPort(webPort);
});

afterAll(async () => {
  web.kill();
  await web.exited;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(outdir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${webPort}`;

describe("ledger-web embedded MCP (same-origin /mcp, no upstream process)", () => {
  it("serves index.html pointing the browser at the same-origin /mcp", async () => {
    const html = await (await fetch(base() + "/")).text();
    expect(html).toContain('window.__LEDGER_MCP_URL__ = "/mcp"');
  });

  it("hosts the MCP protocol in-process: a same-origin client round-trips", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base()}/mcp`));
    const client = new Client({ name: "embedded-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport as unknown as Transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());

      await client.callTool({ name: "create_milestone", arguments: { id: "M40", title: "embedded web" } });
      const res = await client.callTool({
        name: "create_item",
        arguments: { ledger_id: "bugs", milestone_id: "M40", status: "open", fields: { headline: "flux desync" } },
      });
      const created = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).item as { id: string };
      const fetched = await client.callTool({
        name: "fetch_item",
        arguments: { ledger_id: "bugs", item_id: created.id },
      });
      const item = JSON.parse((fetched.content as Array<{ text: string }>)[0]!.text).item as {
        fields: Record<string, unknown>;
      };
      expect(item.fields["headline"]).toBe("flux desync");
    } finally {
      await client.close();
    }
  });

  it("pushes a `changed` frame over /ws after an out-of-band file write", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`);
    const changed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no changed frame within 4s")), 4000);
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data);
        if (data.includes('"changed"')) {
          clearTimeout(timer);
          resolve(data);
        }
      });
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error("ws open failed")));
    });

    // Out-of-band write by a SEPARATE store (mimics the agent / git / a 2nd UI).
    const other = new FsLedgerStore({ root: tmpRoot });
    await other.init();
    await other.createMilestone({ title: "out-of-band" });
    await other.dispose();

    const frame = await changed;
    expect(JSON.parse(frame).type).toBe("changed");
    ws.close();
  });
});
