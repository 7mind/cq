/**
 * T735/T738 — two-client / two-project capstone through the sole owner.
 *
 * Offline: skipIf(!CQ_TEST_PG_URL). Live: spawn cq serve, create through
 * direct HTTP MCP, read through the stdio remote proxy, isolate tenant B,
 * restart the hub, and prove the row survived. Clients never open PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn as bunSpawn } from "bun";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ensureSchema, openPgPool, PostgresLedgerStore } from "@cq/ledger";
import { connectRemoteMcpProxy } from "../../ledger-mcp/src/stdioRemoteProxy.js";

const PG_URL = process.env["CQ_TEST_PG_URL"];
const hubMain = path.resolve(import.meta.dir, "../src/hubServe.ts");
const TOKEN = "t735-ordinary";

function hubSpawnEnv(outdir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LEDGER_WEB_OUTDIR: outdir,
  };
  delete env["CQ_PROMPT_ROOT"];
  delete env["CQ_PROMPT_SURFACE"];
  delete env["CQ_PROMPT_SURFACES_ROOT"];
  return env;
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

async function registerTenant(key: string, displayName: string): Promise<void> {
  const pool = openPgPool(PG_URL!);
  await ensureSchema(pool);
  const store = new PostgresLedgerStore({ pool, projectKey: key, displayName });
  await store.init();
  await store.dispose();
}

async function connectHttp(base: string, key: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/p/${encodeURIComponent(key)}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
  );
  const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  return client;
}

async function connectProxy(
  base: string,
  key: string,
): Promise<{ client: Client; close(): Promise<void> }> {
  const proxy = await connectRemoteMcpProxy(base, key, TOKEN);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  const client = new Client({ name: "t735-proxy", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await proxy.close();
    },
  };
}

async function spawnHub(outdir: string): Promise<{
  proc: ReturnType<typeof bunSpawn>;
  base: string;
}> {
  const proc = bunSpawn({
    cmd: [
      process.execPath,
      "run",
      hubMain,
      "--pg-url",
      PG_URL!,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--token",
      TOKEN,
      "--admin-token",
      "t735-admin-different",
    ],
    cwd: os.tmpdir(),
    env: hubSpawnEnv(outdir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;
  while (!buf.includes("\n")) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error("hubServe did not emit a URL within 20s");
    }
    const { done, value } = await reader.read();
    if (done) {
      proc.kill();
      throw new Error("stdout closed without a URL line");
    }
    buf += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  const urlLine = buf.slice(0, buf.indexOf("\n")).trim();
  const match = urlLine.match(/^(http:\/\/127\.0\.0\.1:\d+)\/$/);
  if (match === null) {
    proc.kill();
    throw new Error(`unexpected URL line: ${urlLine}`);
  }
  return { proc, base: match[1]! };
}

describe.skipIf(PG_URL === undefined || PG_URL.trim() === "")(
  "T735 cross-client parity through cq serve [GC]",
  () => {
    let outdir: string;
    let base: string;
    let keyA: string;
    let keyB: string;
    let proc: ReturnType<typeof bunSpawn>;
    let itemId: string;
    let milestoneId: string;

    beforeAll(async () => {
      outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-t735-"));
      const tag = `t735-${randomUUID().slice(0, 8)}`;
      keyA = `${tag}-a`;
      keyB = `${tag}-b`;
      await registerTenant(keyA, `Tenant A ${tag}`);
      await registerTenant(keyB, `Tenant B ${tag}`);
      const first = await spawnHub(outdir);
      proc = first.proc;
      base = first.base;
    }, 30_000);

    afterAll(async () => {
      proc.kill();
      await proc.exited;
      await fs.rm(outdir, { recursive: true, force: true });
    });

    it("creates on HTTP A, reads through the stdio proxy, isolates B, survives restart", async () => {
      const httpA = await connectHttp(base, keyA, "t735-http-a");
      try {
        milestoneId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
        decode<{ item: { id: string } }>(
          await httpA.callTool({
            name: "create_item",
            arguments: {
              ledger_id: "milestones",
              id: milestoneId,
              status: "open",
              fields: { title: "T735 capstone" },
            },
          }),
        );
        const created = decode<{ item: { id: string } }>(
          await httpA.callTool({
            name: "create_item",
            arguments: {
              ledger_id: "tasks",
              milestone_id: milestoneId,
              status: "planned",
              fields: { headline: "visible on A only" },
            },
          }),
        );
        itemId = created.item.id;
        expect(itemId).toMatch(/^T\d+$/);
      } finally {
        await httpA.close();
      }

      const proxied = await connectProxy(base, keyA);
      try {
        const fetched = decode<{ item: { id: string; fields: { headline?: string } } }>(
          await proxied.client.callTool({
            name: "fetch_item",
            arguments: { ledger_id: "tasks", item_id: itemId, projection: "compact" },
          }),
        );
        expect(fetched.item.id).toBe(itemId);
        expect(fetched.item.fields.headline).toBe("visible on A only");
      } finally {
        await proxied.close();
      }

      const httpB = await connectHttp(base, keyB, "t735-http-b");
      try {
        const missing = await httpB.callTool({
          name: "fetch_item",
          arguments: { ledger_id: "tasks", item_id: itemId, projection: "compact" },
        });
        expect((missing as { isError?: boolean }).isError).toBe(true);
      } finally {
        await httpB.close();
      }

      proc.kill();
      await proc.exited;
      const second = await spawnHub(outdir);
      proc = second.proc;
      base = second.base;

      const restarted = await connectHttp(base, keyA, "t735-http-restart");
      try {
        const fetched = decode<{ item: { id: string } }>(
          await restarted.callTool({
            name: "fetch_item",
            arguments: { ledger_id: "tasks", item_id: itemId, projection: "compact" },
          }),
        );
        expect(fetched.item.id).toBe(itemId);
      } finally {
        await restarted.close();
      }
    }, 60_000);
  },
);
