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
  await writeFile(indexPath, '<!doctype html><div id="root"></div>\n', "utf8");
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

/**
 * Every module specifier `xdgCatalogServe.ts` is allowed to pull in. An
 * allowlist catches ANY cq-serve/PostgreSQL coupling that arrives through an
 * import, whatever it is named, because importing an unlisted module at all
 * fails the guard.
 */
const allowedCatalogImports = new Set([
  "bun",
  "@cq/ledger",
  "@cq/ledger-mcp",
  "./projectRoutes.js",
  "./serve.js",
]);

/**
 * Coupling that needs no import and so slips past the allowlist: an inline
 * bearer-auth header read, an inline project-registration route, or a direct
 * PostgreSQL/hub-ownership call. Matched case-insensitively so that
 * `authorization`/`Authorization` and `Postgres`/`postgres` are both caught.
 */
const forbiddenCatalogTokens = [
  "authorization",
  "Bearer",
  "/api/projects",
  "registerProject",
  "Postgres",
  "openPgPool",
  "checkBearerAuth",
  "bootHub",
  "fetchRegisteredProjects",
];

interface CouplingViolation {
  readonly kind: "import" | "token";
  readonly value: string;
}

/**
 * Collect every module specifier, across all four import forms. A `from`-only
 * regex structurally cannot see bare side-effect imports, dynamic imports, or
 * `require`, so an unlisted module could be pulled in unobserved.
 */
function importSpecifiersOf(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!),
  );
}

function couplingViolationsOf(source: string): CouplingViolation[] {
  const violations: CouplingViolation[] = [];
  for (const specifier of importSpecifiersOf(source)) {
    if (!allowedCatalogImports.has(specifier)) {
      violations.push({ kind: "import", value: specifier });
    }
  }
  const haystack = source.toLowerCase();
  for (const token of forbiddenCatalogTokens) {
    if (haystack.includes(token.toLowerCase())) {
      violations.push({ kind: "token", value: token });
    }
  }
  return violations;
}

describe("architecture guard self-check", () => {
  test("rejects import-free coupling that carries no module specifier", () => {
    const bearerCheck = `
      const token = req.headers.get("authorization");
      if (token !== \`Bearer \${expected}\`) return new Response(null, { status: 401 });
    `;
    expect(couplingViolationsOf(bearerCheck)).toEqual([
      { kind: "token", value: "authorization" },
      { kind: "token", value: "Bearer" },
    ]);

    const registrationRoute = `
      if (url.pathname === "/api/projects") return registerProject(req);
    `;
    expect(couplingViolationsOf(registrationRoute)).toEqual([
      { kind: "token", value: "/api/projects" },
      { kind: "token", value: "registerProject" },
    ]);

    for (const token of forbiddenCatalogTokens) {
      expect(couplingViolationsOf(`const x = ${token};`), token).toContainEqual({
        kind: "token",
        value: token,
      });
    }
  });

  test("rejects a forbidden module under every import form", () => {
    const forms = [
      'import { bootHub } from "@cq/cq-serve";',
      'import type { HubOptions } from "@cq/cq-serve";',
      'import * as serve from "@cq/cq-serve";',
      'export { bootHub } from "@cq/cq-serve";',
      'import "@cq/cq-serve";',
      'const m = await import("@cq/cq-serve");',
      'const m = require("@cq/cq-serve");',
    ];
    for (const form of forms) {
      expect(couplingViolationsOf(form), form).toContainEqual({
        kind: "import",
        value: "@cq/cq-serve",
      });
    }
  });

  test("accepts the allowed import forms with no forbidden token", () => {
    expect(couplingViolationsOf('import { hubTopic } from "./projectRoutes.js";'))
      .toEqual([]);
  });
});

describe("explicit XDG catalog HTTP/WS host", () => {
  test("boots trusted XDG management on a non-loopback host", async () => {
    const fixture = await makeHostFixture();
    await seedProject(fixture.projectsRoot, "alpha");
    const catalog = createStaticXdgHostCatalog([
      { key: "alpha", displayName: "Alpha" },
    ]);
    const server = serveXdgCatalog(
      {
        host: "0.0.0.0",
        port: 0,
        projectsRoot: fixture.projectsRoot,
        outdir: fixture.outdir,
        aliasProjectKey: "alpha",
        catalog,
        runtimeOpener: observeRuntimes().opener,
      },
      fixture.indexPath,
    );
    servers.push(server);
    const client = await connectMcp(
      `http://127.0.0.1:${String(server.port)}`,
      "/p/alpha/mcp",
      "xdg-non-loopback-management",
    );
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "workset",
      );
      expect(
        (definition?.inputSchema.properties?.["op"] as { enum?: string[] } | undefined)?.enum,
      ).toEqual(["get", "fetch", "set"]);
      expect(textOf(await client.callTool({
        name: "workset",
        arguments: { op: "set", roots: [] },
      }))).toBe('{"op":"set","acknowledgement":{"roots":[],"epoch":1}}');
    } finally {
      await client.close();
    }
  });

  test("binds loopback XDG MCP sessions to trusted workset management", async () => {
    const fixture = await makeHostFixture();
    await seedProject(fixture.projectsRoot, "alpha");
    const catalog = createStaticXdgHostCatalog([
      { key: "alpha", displayName: "Alpha" },
    ]);
    const { base } = startHost(fixture, catalog, observeRuntimes().opener);
    const client = await connectMcp(base, "/p/alpha/mcp", "xdg-workset-management");
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "workset",
      );
      expect(
        (definition?.inputSchema.properties?.["op"] as { enum?: string[] } | undefined)?.enum,
      ).toEqual(["get", "fetch", "set"]);
      expect(textOf(await client.callTool({
        name: "workset",
        arguments: { op: "set", roots: [] },
      }))).toBe('{"op":"set","acknowledgement":{"roots":[],"epoch":1}}');
    } finally {
      await client.close();
    }
  });

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
    const names = (await alphaOne.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("prepare_dispatch");
    expect(names).not.toContain("fetch_dispatch_result");

    const expectedListing = JSON.stringify({ projects });
    const listingOne = textOf(
      await alphaOne.callTool({ name: "list_projects", arguments: {} }),
    );
    const listingTwo = textOf(
      await alphaTwo.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(listingOne).toBe(expectedListing);
    expect(listingTwo).toBe(listingOne);
    // Discovery (list_projects) must not eagerly construct dormant runtimes —
    // the real catalog key is "beta team", not "beta"; assert on the real key
    // right after listing so an eager-construction regression here fails.
    expect(observed.opens.has("beta team")).toBe(false);

    const alias = await connectMcp(base, "/mcp", "alias");
    expect(textOf(await alias.callTool({ name: "list_projects", arguments: {} })))
      .toBe(expectedListing);
    expect(observed.opens.get("alpha")).toBe(1);
    expect(observed.opens.has("beta team")).toBe(false);

    decode(
      await alphaOne.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "milestones",
          id: "M900",
          status: "open",
          fields: { title: "Alpha only" },
        },
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
        (await beta.callTool({
          name: "fetch_item",
          arguments: {
            ledger_id: "tasks",
            item_id: created.item.id,
            projection: "full",
          },
        })) as ToolResult
      ).isError,
    ).toBe(true);
    expect(textOf(await beta.callTool({ name: "list_projects", arguments: {} })))
      .toBe(expectedListing);

    const alphaWs = await openWs(base, "/p/alpha/ws");
    const betaWs = await openWs(base, "/p/beta%20team/ws");
    const aliasWs = await openWs(base, "/ws");
    betaWs.socket.send(JSON.stringify({ type: "ping", nonce: "beta", ts: 1 }));
    await waitFor(
      () => betaWs.frames.some((frame) => frame.includes('"pong"')),
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

  test("a lingering stop() does not block a later stop(true) from disposing every runtime", async () => {
    const fixture = await makeHostFixture();
    await seedProject(fixture.projectsRoot, "alpha");
    const catalog = createStaticXdgHostCatalog([
      { key: "alpha", displayName: "Alpha" },
    ]);
    const observed = observeRuntimes();
    const { server, base } = startHost(fixture, catalog, observed.opener);

    const alpha = await connectMcp(base, "/p/alpha/mcp", "alpha");
    expect(observed.opens.get("alpha")).toBe(1);
    await alpha.close();
    await openWs(base, "/p/alpha/ws");

    // A graceful stop() with an open WebSocket stays pending on native Bun
    // indefinitely (confirmed against native Bun.serve directly, independent
    // of this wrapper) — it never resolves on its own here. The regression
    // this guards is the wrapper swallowing `closeActiveConnections` for
    // EVERY later call once the first is in flight, which left `stop(true)`
    // returning that same never-resolving promise and never reaching
    // `originalStop(true)` or runtime disposal. `stop(true)` must still
    // resolve and dispose on its own, independently of the lingering call.
    let firstStopSettled = false;
    void server.stop().then(() => {
      firstStopSettled = true;
    });
    await Bun.sleep(20);
    expect(firstStopSettled).toBe(false);

    await server.stop(true);
    expect(observed.disposals.get("alpha")).toBe(1);
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

    // Two complementary mechanisms, neither sufficient alone. The import
    // allowlist catches coupling that arrives through ANY module specifier,
    // whatever it is named; the forbidden-token scan catches coupling that
    // needs no import at all (an inline bearer-auth header read, an inline
    // registration route). Both failure paths are exercised by the
    // "architecture guard self-check" suite above.
    expect(importSpecifiersOf(source).length).toBeGreaterThan(0);
    expect(couplingViolationsOf(source)).toEqual([]);
  });
});
