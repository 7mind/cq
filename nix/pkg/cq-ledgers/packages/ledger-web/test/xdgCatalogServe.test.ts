/**
 * T836 — explicit XDG catalog host.
 *
 * Behavioral-Active × Blackbox-Group for the public HTTP/MCP/WebSocket
 * boundary, with a small source-level architecture guard for forbidden
 * PostgreSQL/cq-serve coupling.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  SqliteLedgerStore,
  openXdgProjectRuntime,
  type OpenXdgProjectRuntimeOptions,
  type XdgProjectRuntime,
} from "@cq/ledger";
import {
  createStaticXdgHostCatalog,
  matchSafeXdgProjectRoute,
  serveXdgCatalog,
  type XdgHostCatalog,
  type XdgRuntimeOpener,
} from "../src/xdgCatalogServe.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const sockets: WebSocket[] = [];

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RuntimeObserver {
  readonly opens: Map<string, number>;
  readonly disposals: Map<string, number>;
  readonly opener: XdgRuntimeOpener;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeHostFixture(): Promise<{
  projectsRoot: string;
  outdir: string;
  indexPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-web-xdg-host-"));
  roots.push(root);
  const projectsRoot = path.join(root, "projects");
  const outdir = path.join(root, "web");
  await mkdir(projectsRoot);
  await mkdir(outdir);
  const indexPath = path.join(outdir, "index.html");
  await writeFile(indexPath, "<!doctype html><div id=\"root\"></div>\n", "utf8");
  return { projectsRoot, outdir, indexPath };
}

async function seedProject(projectsRoot: string, projectKey: string): Promise<void> {
  const stateDir = path.join(projectsRoot, projectKey, "state");
  await mkdir(stateDir, { recursive: true });
  const store = new SqliteLedgerStore({
    dbPath: path.join(stateDir, "ledger.db"),
    logsDir: path.join(projectsRoot, projectKey, "logs"),
  });
  await store.init();
  await store.dispose();
}

function observeRuntimes(
  delegate: XdgRuntimeOpener = openXdgProjectRuntime,
): RuntimeObserver {
  const opens = new Map<string, number>();
  const disposals = new Map<string, number>();
  const opener: XdgRuntimeOpener = async (
    options: OpenXdgProjectRuntimeOptions,
  ): Promise<XdgProjectRuntime> => {
    opens.set(options.projectKey, (opens.get(options.projectKey) ?? 0) + 1);
    const runtime = await delegate(options);
    let disposed = false;
    return {
      ...runtime,
      async dispose(): Promise<void> {
        if (!disposed) {
          disposed = true;
          disposals.set(
            options.projectKey,
            (disposals.get(options.projectKey) ?? 0) + 1,
          );
        }
        await runtime.dispose();
      },
    };
  };
  return { opens, disposals, opener };
}

function startHost(
  fixture: Awaited<ReturnType<typeof makeHostFixture>>,
  catalog: XdgHostCatalog,
  runtimeOpener: XdgRuntimeOpener,
  aliasProjectKey = "alpha",
): { server: ReturnType<typeof Bun.serve>; base: string } {
  const server = serveXdgCatalog(
    {
      host: "127.0.0.1",
      port: 0,
      projectsRoot: fixture.projectsRoot,
      outdir: fixture.outdir,
      aliasProjectKey,
      catalog,
      runtimeOpener,
    },
    fixture.indexPath,
  );
  servers.push(server);
  return { server, base: `http://127.0.0.1:${String(server.port)}` };
}

async function connectMcp(
  base: string,
  route: string,
  name: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${route}`));
  const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  return client;
}

function textOf(result: unknown): string {
  const first = (result as ToolResult).content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text result");
  }
  return first.text;
}

function decode<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

async function openWs(
  base: string,
  route: string,
): Promise<{ socket: WebSocket; frames: string[] }> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}${route}`);
  sockets.push(socket);
  const frames: string[] = [];
  socket.addEventListener("message", (event) => frames.push(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`WebSocket failed to open: ${route}`)),
      { once: true },
    );
  });
  return { socket, frames };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function changedFrames(frames: readonly string[]): string[] {
  return frames.filter((frame) => {
    try {
      return (JSON.parse(frame) as { type?: unknown }).type === "changed";
    } catch {
      return false;
    }
  });
}

describe("explicit XDG catalog HTTP/WS host", () => {
  test("lazily serves two isolated projects, one global listing, aliases, scoped WS, and disposal", async () => {
    const fixture = await makeHostFixture();
    await seedProject(fixture.projectsRoot, "alpha");
    await seedProject(fixture.projectsRoot, "beta team");
    const projects = [
      { key: "alpha", displayName: "Alpha" },
      { key: "beta team", displayName: "Beta" },
    ] as const;
    const catalog = createStaticXdgHostCatalog(projects);
    const observed = observeRuntimes();
    const { server, base } = startHost(fixture, catalog, observed.opener);

    expect(observed.opens.size).toBe(0);
    const [alphaOne, alphaTwo] = await Promise.all([
      connectMcp(base, "/p/alpha/mcp", "alpha-one"),
      connectMcp(base, "/p/alpha/mcp", "alpha-two"),
    ]);
    expect(observed.opens.get("alpha")).toBe(1);
    expect(observed.opens.has("beta")).toBe(false);

    const expectedListing = JSON.stringify({ projects });
    const listingOne = textOf(
      await alphaOne.callTool({ name: "list_projects", arguments: {} }),
    );
    const listingTwo = textOf(
      await alphaTwo.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(listingOne).toBe(expectedListing);
    expect(listingTwo).toBe(listingOne);

    decode(
      await alphaOne.callTool({
        name: "create_milestone",
        arguments: { id: "M900", title: "Alpha only" },
      }),
    );
    const created = decode<{ item: { id: string } }>(
      await alphaOne.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "tasks",
          milestone_id: "M900",
          status: "planned",
          fields: { headline: "Alpha task" },
        },
      }),
    );

    const beta = await connectMcp(base, "/p/beta%20team/mcp", "beta");
    expect(observed.opens.get("beta team")).toBe(1);
    expect(
      (
        await beta.callTool({
          name: "fetch_item",
          arguments: {
            ledger_id: "tasks",
            item_id: created.item.id,
            projection: "full",
          },
        }) as ToolResult
      ).isError,
    ).toBe(true);
    expect(textOf(await beta.callTool({ name: "list_projects", arguments: {} })))
      .toBe(expectedListing);

    const alias = await connectMcp(base, "/mcp", "alias");
    expect(textOf(await alias.callTool({ name: "list_projects", arguments: {} })))
      .toBe(expectedListing);
    expect(observed.opens.get("alpha")).toBe(1);

    const alphaWs = await openWs(base, "/p/alpha/ws");
    const betaWs = await openWs(base, "/p/beta%20team/ws");
    const aliasWs = await openWs(base, "/ws");
    betaWs.socket.send(JSON.stringify({ type: "ping", nonce: "beta", ts: 1 }));
    await waitFor(
      () => betaWs.frames.some((frame) => frame.includes("\"pong\"")),
      "beta heartbeat did not return a pong",
    );

    await alphaTwo.callTool({
      name: "update_item",
      arguments: {
        ledger_id: "tasks",
        item_id: created.item.id,
        fields: { headline: "Alpha task updated" },
      },
    });
    await waitFor(
      () =>
        changedFrames(alphaWs.frames).length > 0 &&
        changedFrames(aliasWs.frames).length > 0,
      "alpha-scoped sockets did not receive the committed change",
    );
    expect(changedFrames(betaWs.frames)).toEqual([]);

    await Promise.all([
      alphaOne.close(),
      alphaTwo.close(),
      beta.close(),
      alias.close(),
    ]);
    await server.stop(true);
    expect(observed.disposals).toEqual(new Map([
      ["alpha", 1],
      ["beta team", 1],
    ]));
  });

  test("rejects malformed and unsafe encoded keys before catalog lookup or runtime construction", async () => {
    const fixture = await makeHostFixture();
    const baseCatalog = createStaticXdgHostCatalog([
      { key: "alpha", displayName: "Alpha" },
    ]);
    let lookups = 0;
    const catalog: XdgHostCatalog = {
      projects: baseCatalog.projects,
      lookup(projectKey) {
        lookups += 1;
        return baseCatalog.lookup(projectKey);
      },
    };
    let opens = 0;
    const opener: XdgRuntimeOpener = async () => {
      opens += 1;
      throw new Error("unsafe route reached runtime construction");
    };
    const { base } = startHost(fixture, catalog, opener);

    for (const route of [
      "/p/%ZZ/mcp",
      "/p/%2Fetc/mcp",
      "/p/%5Cserver/mcp",
      "/p/..%2Fsecret/mcp",
      "/p/%00/mcp",
      "/p/%20%20/mcp",
    ]) {
      const response = await fetch(`${base}${route}`, { method: "POST" });
      expect(response.status, route).toBe(400);
      await response.text();
    }
    expect(matchSafeXdgProjectRoute("/p/%2e%2e/mcp")).toEqual({
      kind: "invalid",
    });
    expect(lookups).toBe(0);
    expect(opens).toBe(0);

    const unknown = await fetch(`${base}/p/unknown/mcp`, { method: "POST" });
    expect(unknown.status).toBe(404);
    await unknown.text();
    expect(lookups).toBe(1);
    expect(opens).toBe(0);
  });

  test("evicts a failed runtime construction so the next request retries", async () => {
    const fixture = await makeHostFixture();
    await seedProject(fixture.projectsRoot, "alpha");
    const catalog = createStaticXdgHostCatalog([
      { key: "alpha", displayName: "Alpha" },
    ]);
    let attempts = 0;
    const observed = observeRuntimes(async (options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient construction failure");
      return openXdgProjectRuntime(options);
    });
    const { base } = startHost(fixture, catalog, observed.opener);

    const failed = await fetch(`${base}/p/alpha/mcp`, { method: "POST" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("project runtime unavailable");

    const retried = await connectMcp(base, "/p/alpha/mcp", "retry");
    expect(textOf(await retried.callTool({ name: "list_projects", arguments: {} })))
      .toBe(JSON.stringify({
        projects: [{ key: "alpha", displayName: "Alpha" }],
      }));
    expect(attempts).toBe(2);
    await retried.close();
  });

  test("reuses neutral T587 routing/topics without cq-serve/PostgreSQL coupling", async () => {
    const source = await readFile(
      new URL("../src/xdgCatalogServe.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("matchProjectRoute");
    expect(source).toContain("hubTopic");
    expect(source).toContain("attachMcpHttp");
    expect(source).toContain("openXdgProjectRuntime");
    for (const forbidden of [
      "Postgres",
      "openPgPool",
      "registerProject",
      "/api/projects",
      "Authorization",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
