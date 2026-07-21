/**
 * `cq serve` per-project routing (T587) — the live acceptance check.
 *
 * Pure-unit coverage of the routing helpers (no Postgres, always run):
 *   - matchProjectRoute: /p/<key>/{mcp,ws} parsing, decode, non-match cases.
 *   - hubTopic: per-tenant pub/sub topic naming.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-backend
 * suite): spawns the real `hubServe.ts` binary with `--port 0` over TWO
 * registered tenants and asserts the four acceptance properties:
 *   1. MCP: create_item on /p/A/mcp is visible via fetch_item on a SECOND
 *      /p/A/mcp session, and NOT via /p/B/mcp (tenant isolation).
 *   2. WS: a /p/A/ws client receives a changedFrame for A's write while a
 *      /p/B/ws client stays silent (per-project topic isolation).
 *   3. LISTEN: a write from an EXTERNAL store process (its OWN pool / DSN
 *      connection) to A also reaches the /p/A/ws client (the one hub-level
 *      LISTEN connection dispatching by payload project_key).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn as bunSpawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openPgPool, ensureSchema, PostgresLedgerStore } from "@cq/ledger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { matchProjectRoute, hubTopic } from "../src/hubServe.js";

describe("matchProjectRoute", () => {
  it("parses /p/<key>/mcp and /p/<key>/ws", () => {
    expect(matchProjectRoute("/p/abc/mcp")).toEqual({ projectKey: "abc", leaf: "mcp" });
    expect(matchProjectRoute("/p/abc/ws")).toEqual({ projectKey: "abc", leaf: "ws" });
  });

  it("URL-decodes the project key segment", () => {
    expect(matchProjectRoute("/p/a%2Fb/mcp")).toEqual({ projectKey: "a/b", leaf: "mcp" });
  });

  it("returns null for non-per-project paths", () => {
    for (const p of ["/", "/api/projects", "/p/abc", "/p/abc/", "/p//mcp", "/p/abc/other", "/p/abc/mcp/x"]) {
      expect(matchProjectRoute(p)).toBeNull();
    }
  });
});

describe("hubTopic", () => {
  it("namespaces the pub/sub topic per tenant", () => {
    expect(hubTopic("proj-a")).toBe("ledger:proj-a");
    expect(hubTopic("proj-b")).toBe("ledger:proj-b");
  });
});

const PG_URL = process.env["CQ_TEST_PG_URL"];
const here = new URL(".", import.meta.url).pathname;
const hubMain = path.resolve(here, "..", "src", "hubServe.ts");

/** Unwrap a single-text-block MCP tool result to its parsed JSON payload. */
function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected single text content block");
  return JSON.parse(first.text) as T;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** Register a tenant with its OWN pool (each store's dispose() closes its pool). */
async function registerTenant(key: string, displayName: string): Promise<void> {
  const pool = openPgPool(PG_URL!);
  await ensureSchema(pool);
  const store = new PostgresLedgerStore({ pool, projectKey: key, displayName });
  await store.init();
  await store.dispose();
}

/** Connect an MCP client to a per-project endpoint `http://host:port/p/<key>/mcp`. */
async function connectMcp(base: string, key: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/p/${encodeURIComponent(key)}/mcp`));
  const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  return client;
}

/** Open a WS to `http://host:port/p/<key>/ws`, collecting every frame received. */
async function openWs(base: string, key: string): Promise<{ frames: string[]; close: () => void }> {
  const wsUrl = `${base.replace(/^http/, "ws")}/p/${encodeURIComponent(key)}/ws`;
  const ws = new WebSocket(wsUrl);
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`ws failed to open: ${wsUrl}`)));
  });
  ws.addEventListener("message", (ev) => frames.push(String(ev.data)));
  return { frames, close: () => ws.close() };
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!PG_URL)("cq serve — per-project routing over live Postgres (T587)", () => {
  let outdir: string;
  let base: string;
  let keyA: string;
  let keyB: string;
  let proc: ReturnType<typeof bunSpawn>;

  beforeAll(async () => {
    outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-t587-"));
    const tag = `t587-${randomUUID().slice(0, 8)}`;
    keyA = `${tag}-a`;
    keyB = `${tag}-b`;
    await registerTenant(keyA, `Tenant A ${tag}`);
    await registerTenant(keyB, `Tenant B ${tag}`);

    const p = bunSpawn({
      cmd: [process.execPath, "run", hubMain, "--pg-url", PG_URL!, "--host", "127.0.0.1", "--port", "0"],
      cwd: os.tmpdir(),
      env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = p;
    const reader = p.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 20_000;
    while (!buf.includes("\n")) {
      if (Date.now() > deadline) throw new Error("hubServe did not emit a URL within 20s");
      const { done, value } = await reader.read();
      if (done) throw new Error("stdout closed without a URL line");
      buf += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    const urlLine = buf.slice(0, buf.indexOf("\n")).trim();
    const match = urlLine.match(/^(http:\/\/127\.0\.0\.1:\d+)\/$/);
    if (match === null) throw new Error(`unexpected URL line: ${urlLine}`);
    base = match[1]!;
  }, 30_000);

  afterAll(async () => {
    proc.kill();
    await proc.exited;
    await fs.rm(outdir, { recursive: true, force: true });
  });

  it("unknown projectKey -> 404 on both /mcp and /ws", async () => {
    const mcp = await fetch(`${base}/p/no-such-tenant/mcp`, { method: "POST" });
    expect(mcp.status).toBe(404);
    const ws = await fetch(`${base}/p/no-such-tenant/ws`);
    expect(ws.status).toBe(404);
  });

  it("MCP: a create_item on /p/A/mcp is visible on a 2nd /p/A session, NOT via /p/B", async () => {
    const s1 = await connectMcp(base, keyA, "t587-a1");
    let itemId: string;
    try {
      const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
      decode<{ milestone: { id: string } }>(
        await s1.callTool({ name: "create_milestone", arguments: { id: msId, title: "T587 isolation" } }),
      );
      const created = decode<{ item: { id: string } }>(
        await s1.callTool({
          name: "create_item",
          arguments: { ledger_id: "tasks", milestone_id: msId, status: "planned", fields: { headline: "A only" } },
        }),
      );
      itemId = created.item.id;
      expect(itemId).toMatch(/^T\d+$/);
    } finally {
      await s1.close();
    }

    // Second session on the SAME tenant sees the write (shared per-project store).
    const s2 = await connectMcp(base, keyA, "t587-a2");
    try {
      const got = decode<{ item: { id: string; fields: { headline: string } } }>(
        await s2.callTool({ name: "fetch_item", arguments: { ledger_id: "tasks", item_id: itemId } }),
      );
      expect(got.item.id).toBe(itemId);
      expect(got.item.fields.headline).toBe("A only");
    } finally {
      await s2.close();
    }

    // Tenant B must NOT see A's item.
    const sb = await connectMcp(base, keyB, "t587-b1");
    try {
      const res = await sb.callTool({ name: "fetch_item", arguments: { ledger_id: "tasks", item_id: itemId } });
      expect(isError(res)).toBe(true);
    } finally {
      await sb.close();
    }
  }, 30_000);

  it("WS: A's write reaches /p/A/ws while /p/B/ws stays silent", async () => {
    const wsA = await openWs(base, keyA);
    const wsB = await openWs(base, keyB);
    const s = await connectMcp(base, keyA, "t587-a-ws");
    try {
      const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
      decode<{ milestone: { id: string } }>(
        await s.callTool({ name: "create_milestone", arguments: { id: msId, title: "T587 ws" } }),
      );
      await s.callTool({
        name: "create_item",
        arguments: { ledger_id: "tasks", milestone_id: msId, status: "planned", fields: { headline: "ws A" } },
      });

      await waitFor(() => wsA.frames.length > 0, 5_000);
      expect(wsA.frames.length).toBeGreaterThan(0);
      expect(JSON.parse(wsA.frames[0]!)).toEqual({ type: "changed" });
      expect(wsB.frames.length).toBe(0);
    } finally {
      await s.close();
      wsA.close();
      wsB.close();
    }
  }, 30_000);

  it("LISTEN: an EXTERNAL store process's write to A reaches /p/A/ws", async () => {
    // Ensure A's hub-side store is constructed (so onProjectChange invalidates it)
    // and a socket is subscribed to A's topic.
    const warm = await connectMcp(base, keyA, "t587-a-warm");
    await warm.close();
    const wsA = await openWs(base, keyA);

    // A SEPARATE store process: its own pool / DSN connection, same tenant A.
    const extPool = openPgPool(PG_URL!);
    const extStore = new PostgresLedgerStore({ pool: extPool, projectKey: keyA, displayName: `Tenant A ext` });
    await extStore.init();
    try {
      const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
      await extStore.createMilestone({ id: msId, title: "T587 external" });
      await extStore.createItem("tasks", msId, { status: "planned", fields: { headline: "external write" } });

      await waitFor(() => wsA.frames.length > 0, 5_000);
      expect(wsA.frames.length).toBeGreaterThan(0);
      expect(JSON.parse(wsA.frames[0]!)).toEqual({ type: "changed" });
    } finally {
      await extStore.dispose();
      wsA.close();
    }
  }, 30_000);
});
