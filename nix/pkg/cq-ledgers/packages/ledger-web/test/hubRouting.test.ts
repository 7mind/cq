/**
 * `cq serve` per-project routing (T587) — the live acceptance check.
 *
 * Pure-unit coverage of the routing helpers (no Postgres, always run):
 *   - matchProjectRoute: /p/<key>/{mcp,ws} parsing, decode, non-match cases.
 *   - hubTopic: per-tenant pub/sub topic naming.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-backend
 * suite): spawns the real `hubServe.ts` binary with `--port 0` over TWO
 * registered tenants and asserts these acceptance scenarios:
 *   1. MCP: create_item on /p/A/mcp is visible via fetch_item on a SECOND
 *      /p/A/mcp session, and NOT via /p/B/mcp (tenant isolation).
 *   2. WS: a committed ordinary mutation publishes exactly one ledger-scoped
 *      changedFrame to /p/A/ws, none to /p/B/ws, and a rejected transaction
 *      publishes nothing.
 *
 * A second live-Postgres describe block below (T588 / Q273) spins up its OWN
 * `--token`-armed hub and asserts the bearer-auth gate: unauthenticated /mcp
 * POSTs and /ws upgrades get 401 (no token echoed back), authenticated ones
 * succeed, and the static bundle + `/` stay open regardless of --token.
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
import {
  matchProjectRoute,
  hubTopic,
  PROJECT_DISPLAY_NAME_HEADER,
} from "../src/hubServe.js";

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
async function openWs(
  base: string,
  key: string,
): Promise<{ frames: string[]; send: (frame: string) => void; close: () => void }> {
  const wsUrl = `${base.replace(/^http/, "ws")}/p/${encodeURIComponent(key)}/ws`;
  const ws = new WebSocket(wsUrl);
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`ws failed to open: ${wsUrl}`)));
  });
  ws.addEventListener("message", (ev) => frames.push(String(ev.data)));
  return { frames, send: (frame) => ws.send(frame), close: () => ws.close() };
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
      decode<{ item: { id: string } }>(
        await s1.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "milestones",
            id: msId,
            status: "open",
            fields: { title: "T587 isolation" },
          },
        }),
      );
      const created = decode<{
        item: { id: string; fields: Record<string, never> };
      }>(
        await s1.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "tasks",
            milestone_id: msId,
            status: "planned",
            fields: {
              headline: "A only",
              description: "hub full-only narrative",
            },
          },
        }),
      );
      itemId = created.item.id;
      expect(itemId).toMatch(/^T\d+$/);
      expect(created.item.fields).toEqual({});
    } finally {
      await s1.close();
    }

    // Second session on the SAME tenant sees the write (shared per-project store).
    const s2 = await connectMcp(base, keyA, "t587-a2");
    try {
      const compact = decode<{
        item: { id: string; fields: Record<string, unknown> };
      }>(
        await s2.callTool({
          name: "fetch_item",
          arguments: {
            ledger_id: "tasks",
            item_id: itemId,
            projection: "compact",
          },
        }),
      );
      expect(compact.item.id).toBe(itemId);
      expect(compact.item.fields["headline"]).toBe("A only");
      expect(compact.item.fields["description"]).toBeUndefined();

      const got = decode<{
        item: { id: string; fields: Record<string, unknown> };
      }>(
        await s2.callTool({
          name: "fetch_item",
          arguments: {
            ledger_id: "tasks",
            item_id: itemId,
            projection: "full",
          },
        }),
      );
      expect(got.item.id).toBe(itemId);
      expect(got.item.fields["headline"]).toBe("A only");
      expect(got.item.fields["description"]).toBe("hub full-only narrative");
    } finally {
      await s2.close();
    }

    // Tenant B must NOT see A's item.
    const sb = await connectMcp(base, keyB, "t587-b1");
    try {
      const res = await sb.callTool({
        name: "fetch_item",
        arguments: {
          ledger_id: "tasks",
          item_id: itemId,
          projection: "full",
        },
      });
      expect(isError(res)).toBe(true);
    } finally {
      await sb.close();
    }
  }, 30_000);

  it("T726 Good-Communication: committed mutations publish once; rejected transactions publish nothing", async () => {
    const s1 = await connectMcp(base, keyA, "t726-a1");
    const s2 = await connectMcp(base, keyA, "t726-a2");
    const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
    decode<{ item: { id: string } }>(
      await s1.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "milestones",
          id: msId,
          status: "open",
          fields: { title: "T726 publish" },
        },
      }),
    );
    const created = decode<{ item: { id: string } }>(
      await s1.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "tasks",
          milestone_id: msId,
          status: "planned",
          fields: { headline: "before commit" },
        },
      }),
    );
    const wsA = await openWs(base, keyA);
    const wsB = await openWs(base, keyB);
    try {
      decode<{ item: { id: string } }>(
        await s1.callTool({
          name: "update_item",
          arguments: {
            ledger_id: "tasks",
            item_id: created.item.id,
            status: "wip",
            fields: { headline: "committed value" },
          },
        }),
      );

      await waitFor(() => wsA.frames.length > 0, 5_000);
      const observed = decode<{
        item: { id: string; status: string; fields: Record<string, unknown> };
      }>(
        await s2.callTool({
          name: "fetch_item",
          arguments: {
            ledger_id: "tasks",
            item_id: created.item.id,
            projection: "full",
          },
        }),
      );
      expect(observed.item.status).toBe("wip");
      expect(observed.item.fields["headline"]).toBe("committed value");
      expect(wsA.frames).toHaveLength(1);
      expect(JSON.parse(wsA.frames[0]!)).toEqual({ type: "changed", ledger: "tasks" });
      expect(wsB.frames.length).toBe(0);

      const rejected = await s1.callTool({
        name: "update_item",
        arguments: {
          ledger_id: "tasks",
          item_id: created.item.id,
          fields: { dependsOn: ["tasks:T999999999"] },
        },
      });
      expect(isError(rejected)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(wsA.frames).toHaveLength(1);
      expect(wsB.frames).toHaveLength(0);

      wsA.send(JSON.stringify({ type: "ping", nonce: "t726-heartbeat", ts: 42 }));
      await waitFor(
        () =>
          wsA.frames.some((frame) => {
            const parsed = JSON.parse(frame) as { type?: string; nonce?: string };
            return parsed.type === "pong" && parsed.nonce === "t726-heartbeat";
          }),
        5_000,
      );
      expect(
        wsA.frames.filter((frame) => (JSON.parse(frame) as { type?: string }).type === "changed"),
      ).toHaveLength(1);
    } finally {
      await s1.close();
      await s2.close();
      wsA.close();
      wsB.close();
    }
  }, 30_000);
});

describe.skipIf(!PG_URL)("cq serve — bearer-token auth over live Postgres (T588, Q273)", () => {
  let outdir: string;
  let base: string;
  let key: string;
  let proc: ReturnType<typeof bunSpawn>;
  const TOKEN = "t588-secret-token";

  beforeAll(async () => {
    outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-t588-"));
    const tag = `t588-${randomUUID().slice(0, 8)}`;
    key = `${tag}-a`;
    await registerTenant(key, `T588 Tenant ${tag}`);

    const p = bunSpawn({
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
      ],
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

  it("GET / (static bundle) stays open with no Authorization header", async () => {
    const resp = await fetch(`${base}/`);
    expect(resp.status).toBe(200);
  });

  it("GET /api/projects: 401 with no/wrong bearer, 200 with the right one — never echoes the token", async () => {
    const noAuth = await fetch(`${base}/api/projects`);
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).not.toContain(TOKEN);

    const wrongAuth = await fetch(`${base}/api/projects`, { headers: { authorization: "Bearer wrong-token" } });
    expect(wrongAuth.status).toBe(401);

    const rightAuth = await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(rightAuth.status).toBe(200);
  });

  it("POST /p/<key>/mcp: 401 with no/wrong bearer (no token echo), 200/session on the right one", async () => {
    const noAuth = await fetch(`${base}/p/${encodeURIComponent(key)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).not.toContain(TOKEN);

    const wrongAuth = await fetch(`${base}/p/${encodeURIComponent(key)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: "{}",
    });
    expect(wrongAuth.status).toBe(401);

    // Authenticated: a full MCP session over the SDK client, carrying the
    // bearer header via requestInit — proves the auth gate lets a real session
    // through, not merely that SOME 200 is returned.
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/p/${encodeURIComponent(key)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "t588-auth", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport as unknown as Transport);
    try {
      const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
      const created = decode<{ item: { id: string } }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "milestones",
            id: msId,
            status: "open",
            fields: { title: "T588 auth" },
          },
        }),
      );
      expect(created.item.id).toBe(msId);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("GET /p/<key>/ws (upgrade attempt): 401 with no/wrong ?token=, opens with the right one", async () => {
    const noToken = await fetch(`${base}/p/${encodeURIComponent(key)}/ws`);
    expect(noToken.status).toBe(401);
    expect(await noToken.text()).not.toContain(TOKEN);

    const wrongToken = await fetch(`${base}/p/${encodeURIComponent(key)}/ws?token=wrong-token`);
    expect(wrongToken.status).toBe(401);

    const wsUrl = `${base.replace(/^http/, "ws")}/p/${encodeURIComponent(key)}/ws?token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`ws failed to open: ${wsUrl}`)));
      });
    } finally {
      ws.close();
    }
  }, 30_000);
});

describe.skipIf(!PG_URL)(
  "cq serve — request-bound project registration (T725, Behavioral-Active Group)",
  () => {
    let outdir: string;
    let base: string;
    let proc: ReturnType<typeof bunSpawn>;
    let control: ReturnType<typeof openPgPool>;
    const TOKEN = "t725-registration-token";

    beforeAll(async () => {
      outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-t725-"));
      control = openPgPool(PG_URL!);
      await ensureSchema(control);

      const p = bunSpawn({
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
        ],
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
      await control.close();
      await fs.rm(outdir, { recursive: true, force: true });
    });

    async function connectClient(
      projectKey: string,
      clientName: string,
      displayName?: string,
    ): Promise<Client> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${TOKEN}`,
      };
      if (displayName !== undefined) headers[PROJECT_DISPLAY_NAME_HEADER] = displayName;
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/p/${encodeURIComponent(projectKey)}/mcp`),
        { requestInit: { headers } },
      );
      const client = new Client({ name: clientName, version: "0.0.1" }, { capabilities: {} });
      await client.connect(transport as unknown as Transport);
      return client;
    }

    it("registers once under concurrent initialize, refreshes later session metadata without replacing the runtime, and falls back to projectKey", async () => {
      const tag = `t725-${randomUUID().slice(0, 8)}`;
      const projectKey = `${tag}-named`;
      const fallbackKey = `${tag}-fallback`;
      const unauthenticatedKey = `${tag}-unauthenticated`;
      const initialName = `Initial ${tag}`;
      const changedName = `Changed ${tag}`;

      const unauthenticated = await fetch(
        `${base}/p/${encodeURIComponent(unauthenticatedKey)}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [PROJECT_DISPLAY_NAME_HEADER]: "must-not-register",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "unauthenticated", version: "0.0.1" },
            },
          }),
        },
      );
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.text()).toBe("unauthorized");
      const unauthenticatedRows = await control<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM projects
        WHERE project_key = ${unauthenticatedKey}
      `;
      expect(unauthenticatedRows[0]!.count).toBe("0");

      const [first, second] = await Promise.all([
        connectClient(projectKey, "t725-first", initialName),
        connectClient(projectKey, "t725-second", initialName),
      ]);
      try {
        const registeredRows = await control<
          Array<{ count: string; display_name: string }>
        >`
          SELECT count(*)::text AS count, min(display_name) AS display_name
          FROM projects
          WHERE project_key = ${projectKey}
        `;
        expect(registeredRows[0]).toEqual({ count: "1", display_name: initialName });
        expect(first.getServerVersion()?.title).toBe(initialName);
        expect(second.getServerVersion()?.title).toBe(initialName);

        const renamed = await connectClient(projectKey, "t725-renamed", changedName);
        try {
          expect(renamed.getServerVersion()?.title).toBe(changedName);
          expect(renamed.getInstructions()).toStartWith(`Project: ${changedName}`);

          const refreshedRows = await control<Array<{ display_name: string }>>`
            SELECT display_name FROM projects WHERE project_key = ${projectKey}
          `;
          expect(refreshedRows).toEqual([{ display_name: changedName }]);

          // The pre-rename session remains valid and observes the refreshed
          // registry through the same cached runtime/handler session map.
          const projects = decode<{
            projects: Array<{ key: string; displayName: string }>;
          }>(await first.callTool({ name: "list_projects", arguments: {} }));
          expect(projects.projects.find((project) => project.key === projectKey)?.displayName).toBe(
            changedName,
          );

          const rejectedRename = await fetch(
            `${base}/p/${encodeURIComponent(projectKey)}/mcp`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [PROJECT_DISPLAY_NAME_HEADER]: "unauthenticated rename",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "unauthenticated", version: "0.0.1" },
                },
              }),
            },
          );
          expect(rejectedRename.status).toBe(401);
          expect(await rejectedRename.text()).toBe("unauthorized");
          const unchangedRows = await control<Array<{ display_name: string }>>`
            SELECT display_name FROM projects WHERE project_key = ${projectKey}
          `;
          expect(unchangedRows).toEqual([{ display_name: changedName }]);
        } finally {
          await renamed.close();
        }

        const fallback = await connectClient(fallbackKey, "t725-fallback");
        try {
          expect(fallback.getServerVersion()?.title).toBe(fallbackKey);
          expect(fallback.getInstructions()).toStartWith(`Project: ${fallbackKey}`);
          const fallbackRows = await control<Array<{ display_name: string }>>`
            SELECT display_name FROM projects WHERE project_key = ${fallbackKey}
          `;
          expect(fallbackRows).toEqual([{ display_name: fallbackKey }]);
        } finally {
          await fallback.close();
        }
      } finally {
        await first.close();
        await second.close();
      }
    }, 30_000);
  },
);
