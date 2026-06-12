#!/usr/bin/env -S bun run
/**
 * ledger-web — static server for the browser ledger explorer/editor.
 *
 * This server serves ONLY the built React bundle. The browser app is a pure
 * MCP client: it connects (cross-origin) to a separately-running
 * `ledger-mcp --http <port> ` over the Streamable HTTP transport. The default
 * MCP URL is injected into index.html as `window.__LEDGER_MCP_URL__`; the user
 * can override it in the UI (or via a `?url=` query param).
 *
 * CLI:
 *   ledger-web --port 5180 --mcp-url http://127.0.0.1:7777/mcp
 *
 * The bundle is built at startup with Bun.build (TypeScript/JSX transpiled on
 * the fly). LEDGER_WEB_OUTDIR redirects the bundler output to a writable path
 * for read-only (e.g. Nix store) deployments.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  attachMcpHttp,
  changedFrame,
  createEmbeddedStore,
  LEDGER_TOPIC,
  startLedgerCoherenceWatcher,
} from "@cq/ledger-mcp";
import type { WebuiConfig } from "@cq/config";
import { loadConfig } from "@cq/config";

const DEFAULT_PORT = 5180;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Maximum number of consecutive ports the bind scan will try (Q107). Starting
 * at the resolved port P, the scan probes P, P+1, …, P+MAX_PORT_SCAN-1 and
 * throws if every one is occupied.
 */
const MAX_PORT_SCAN = 64;

const WEB_SRC = path.resolve(import.meta.dir, "main.tsx");
const DEFAULT_OUTDIR = path.resolve(import.meta.dir, "..", "dist");

export interface ServeOpts {
  host: string;
  port: number;
  /**
   * True when `--host` was passed EXPLICITLY on the command line (vs falling
   * through to DEFAULT_HOST). Lets `resolveWebOpts` distinguish "user set it"
   * from "default" so cq.toml [webui] can fill the gap (Q106).
   */
  hostExplicit: boolean;
  /** True when `--port` was passed EXPLICITLY (vs DEFAULT_PORT). See above. */
  portExplicit: boolean;
  /**
   * Upstream MCP URL to reverse-proxy to, or `null` to run the MCP server
   * EMBEDDED in this process (rooted at `cwd`) and host `/mcp` + `/ws` directly.
   */
  mcpUrl: string | null;
  /** Ledger root for embedded mode (--cwd > $LEDGER_ROOT > CWD). */
  cwd: string;
  outdir: string;
}

export interface BundleBuild {
  outdir: string;
  scriptPath: string;
  cssLink: string;
}

/** Bundle the browser entry with Bun.build; returns the emitted asset paths. */
export async function buildBundle(outdir: string): Promise<BundleBuild> {
  const result = await Bun.build({
    entrypoints: [WEB_SRC],
    outdir,
    target: "browser",
    minify: false,
    sourcemap: "linked",
    naming: "[name].[ext]",
  });
  if (!result.success) {
    const msgs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`ledger-web: Bun.build failed:\n${msgs}`);
  }
  const js = result.outputs.find((o) => o.kind === "entry-point");
  if (js === undefined) throw new Error("ledger-web: Bun.build produced no entry point");
  const scriptPath = `/${path.basename(js.path)}`;
  const css = result.outputs.find((o) => o.kind === "asset" && o.path.endsWith(".css"));
  const cssLink =
    css !== undefined ? `<link rel="stylesheet" href="/${path.basename(css.path)}">` : "";
  return { outdir, scriptPath, cssLink };
}

/** Path the browser app talks to (same origin); proxied to the upstream MCP. */
export const MCP_PROXY_PATH = "/mcp";

/**
 * index.html. The browser app connects to the SAME-ORIGIN `/mcp` endpoint
 * (this server proxies it to the upstream MCP server); it never contacts the
 * MCP server directly, so the page works from any host that can reach this
 * server, with no CORS. `?url=` can still override for direct/advanced use.
 */
export function renderIndexHtml(b: BundleBuild): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ledger-web</title>
${b.cssLink}
<script>window.__LEDGER_MCP_URL__ = ${JSON.stringify(MCP_PROXY_PATH)};</script>
</head>
<body><div id="root"></div><script type="module" src="${b.scriptPath}"></script></body>
</html>
`;
}

/** Build the bundle + write index.html. Returns the build for serving. */
export async function prepare(outdir: string): Promise<BundleBuild> {
  const build = await buildBundle(outdir);
  await fs.writeFile(path.join(outdir, "index.html"), renderIndexHtml(build), "utf8");
  return build;
}

/**
 * Reverse-proxy one request to the upstream MCP server (server→server, so no
 * CORS and the MCP host need not be reachable from the browser). The request
 * body is small JSON; the RESPONSE is streamed back verbatim so the Streamable
 * HTTP transport's SSE channel works through the proxy. The `mcp-session-id`
 * response header is preserved (it rides in the forwarded headers).
 */
export async function proxyToMcp(req: Request, upstream: string): Promise<Response> {
  const headers = new Headers(req.headers);
  // Hop-by-hop / host headers must not be forwarded; fetch recomputes them.
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  let resp: Response;
  try {
    resp = await fetch(upstream, init);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: `ledger-web: cannot reach MCP upstream ${upstream}: ${msg}` },
        id: null,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  // Stream the upstream response (status + headers + body) back unchanged.
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: new Headers(resp.headers),
  });
}

/** Path the browser connects to for live-change notifications (proxied). */
export const WS_PROXY_PATH = "/ws";

/** Derive the upstream WS URL (.../ws) from the upstream MCP URL (.../mcp). */
export function mcpUrlToWs(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}${WS_PROXY_PATH}`;
}

interface WsData {
  up: WebSocket | null;
  buf: string[];
}

/**
 * Serve a static asset from `outdir` for `url`, with SPA fallback to
 * index.html. Shared by both the proxy and embedded servers.
 */
async function serveStatic(url: URL, outdir: string, indexPath: string): Promise<Response> {
  const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
  // Resolve within outdir; reject path traversal.
  const resolved = path.resolve(outdir, `.${reqPath}`);
  if (resolved === outdir || resolved.startsWith(outdir + path.sep)) {
    const file = Bun.file(resolved);
    if (await file.exists()) return new Response(file);
  }
  // SPA fallback.
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Dispatcher: embedded MCP when `mcpUrl` is null, else reverse-proxy. */
export async function serve(opts: ServeOpts): Promise<ReturnType<typeof Bun.serve>> {
  await prepare(opts.outdir);
  const indexPath = path.join(opts.outdir, "index.html");
  if (opts.mcpUrl !== null) {
    return scanForPort(opts.port, (p) => serveProxy({ ...opts, port: p }, opts.mcpUrl!, indexPath));
  }
  // Embedded: async setup first, then synchronous bind scan.
  return serveEmbedded(opts, indexPath);
}

/** Reverse-proxy `/mcp` + `/ws` to a separate `ledger-mcp --http` server. */
function serveProxy(
  opts: ServeOpts,
  mcpUrl: string,
  indexPath: string,
): ReturnType<typeof Bun.serve> {
  const wsUpstream = mcpUrlToWs(mcpUrl);

  return Bun.serve<WsData>({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0, // long-lived SSE / WS proxy streams must not time out
    async fetch(req, server): Promise<Response | undefined> {
      const url = new URL(req.url);
      // Live-change WebSocket: upgrade the browser socket; the upstream socket
      // is opened per-connection in the `open` handler below.
      if (url.pathname === WS_PROXY_PATH) {
        if (server.upgrade(req, { data: { up: null, buf: [] } })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      if (url.pathname === MCP_PROXY_PATH) {
        return proxyToMcp(req, mcpUrl);
      }
      return serveStatic(url, opts.outdir, indexPath);
    },
    // Reverse-proxy the WS to the upstream ledger-mcp /ws, piping both ways, so
    // the browser only ever talks to this origin (same as the /mcp proxy).
    websocket: {
      open(ws): void {
        const up = new WebSocket(wsUpstream);
        ws.data.up = up;
        up.onopen = (): void => {
          for (const m of ws.data.buf) up.send(m);
          ws.data.buf = [];
        };
        up.onmessage = (ev: MessageEvent): void => {
          try {
            ws.send(typeof ev.data === "string" ? ev.data : String(ev.data));
          } catch {
            /* client gone */
          }
        };
        up.onclose = (): void => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        };
        up.onerror = (): void => {
          /* close follows */
        };
      },
      message(ws, raw): void {
        const s = typeof raw === "string" ? raw : raw.toString();
        const up = ws.data.up;
        if (up !== null && up.readyState === 1) up.send(s);
        else ws.data.buf.push(s); // queue until upstream opens
      },
      close(ws): void {
        try {
          ws.data.up?.close();
        } catch {
          /* ignore */
        }
      },
    },
  });
}

/**
 * Host the MCP server IN-PROCESS: an embedded file-store rooted at `opts.cwd`,
 * the shared `attachMcpHttp` handlers mounted on `/mcp` + `/ws`, and the file
 * watcher publishing `changed` frames to subscribed browser sockets. The
 * browser is unchanged — it still talks to the same-origin `/mcp` and `/ws`.
 * The returned server's `stop()` is wrapped to also close the watcher and
 * dispose the store.
 */
async function serveEmbedded(
  opts: ServeOpts,
  indexPath: string,
): Promise<ReturnType<typeof Bun.serve>> {
  const resolved = await createEmbeddedStore(opts.cwd);
  const store = resolved.store;
  const { handle, onWsOpen, onWsMessage } = attachMcpHttp(store, path.basename(opts.cwd));

  const server = scanForPort(opts.port, (p) =>
    Bun.serve({
      hostname: opts.host,
      port: p,
      idleTimeout: 0, // long-lived SSE / WS streams must not time out
      async fetch(req, srv): Promise<Response | undefined> {
        const url = new URL(req.url);
        if (url.pathname === WS_PROXY_PATH) {
          if (srv.upgrade(req, { data: undefined })) return undefined;
          return new Response("expected a websocket upgrade", { status: 426 });
        }
        if (url.pathname === MCP_PROXY_PATH) {
          return handle(req);
        }
        return serveStatic(url, opts.outdir, indexPath);
      },
      websocket: {
        open: onWsOpen,
        message: onWsMessage,
      },
    }),
  );

  // Publish a `changed` frame to subscribed browser sockets on any change
  // (this server's own writes, the agent's stdio server, git, a hand-edit).
  // Watcher is selected by backend (file watch for fs, orphan-ref-sha poll for
  // git-object).
  const watcher = startLedgerCoherenceWatcher(resolved, opts.cwd, (ledger) => {
    server.publish(LEDGER_TOPIC, changedFrame(ledger));
  });

  // Tear down the embedded resources when the server stops (main()/tests call
  // server.stop(true)); the return type stays the Bun server.
  const origStop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean): Promise<void> => {
    watcher.close();
    void store.dispose();
    return origStop(closeActiveConnections);
  };

  return server;
}

export function parseArgs(argv: readonly string[]): ServeOpts {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let hostExplicit = false;
  let portExplicit = false;
  let mcpUrl: string | null = null; // omitted ⇒ embedded
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      port = Number(argv[++i]);
      portExplicit = true;
    } else if (a?.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
      portExplicit = true;
    } else if (a === "--host") {
      host = argv[++i] ?? host;
      hostExplicit = true;
    } else if (a?.startsWith("--host=")) {
      host = a.slice("--host=".length);
      hostExplicit = true;
    } else if (a === "--mcp-url") mcpUrl = argv[++i] ?? mcpUrl;
    else if (a?.startsWith("--mcp-url=")) mcpUrl = a.slice("--mcp-url=".length);
    else if (a === "--cwd") cwd = argv[++i];
    else if (a?.startsWith("--cwd=")) cwd = a.slice("--cwd=".length);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ledger-web: --port must be 1..65535; got: ${port}`);
  }
  // Embedded ledger root: --cwd > $LEDGER_ROOT > process CWD (mirrors ledger-mcp).
  const fromArg = cwd !== undefined && cwd !== "" ? cwd : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const resolvedCwd = chosen !== undefined ? path.resolve(chosen) : process.cwd();
  const outdir = process.env["LEDGER_WEB_OUTDIR"] ?? DEFAULT_OUTDIR;
  return { host, port, hostExplicit, portExplicit, mcpUrl, cwd: resolvedCwd, outdir };
}

/**
 * Per-field host/port resolution (Q106). Resolves `host` and `port`
 * INDEPENDENTLY with precedence:
 *
 *   explicit CLI flag  >  cq.toml [webui] value  >  built-in default.
 *
 * `args` carries the parsed CLI values plus `hostExplicit`/`portExplicit`
 * flags that tell an explicitly-passed flag from one that fell through to
 * DEFAULT_HOST/DEFAULT_PORT. `config` is the loaded `[webui]` table, or null
 * when there is no cq.toml / no `[webui]` table. A null field WITHIN a present
 * `[webui]` table is also treated as unset (the default fills it).
 *
 * Pure: no I/O, no socket binding — directly unit-testable.
 */
export function resolveWebOpts(
  args: Pick<ServeOpts, "host" | "port" | "hostExplicit" | "portExplicit">,
  config: WebuiConfig | null,
): { host: string; port: number } {
  const host = args.hostExplicit
    ? args.host
    : (config?.host ?? DEFAULT_HOST);
  const port = args.portExplicit
    ? args.port
    : (config?.port ?? DEFAULT_PORT);
  return { host, port };
}

/** Node's EADDRINUSE error shape (Bun.serve rethrows it synchronously). */
function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

/**
 * Bounded port auto-increment scan (Q107). Calls `bind(port)` starting at
 * `startPort` and, on an address-in-use failure, retries `port + 1`, up to
 * `MAX_PORT_SCAN` attempts total. Returns whatever `bind` returns for the
 * first port that binds successfully.
 *
 * The host is NEVER part of the scan — it is `bind`'s concern and is taken
 * as-is. Only EADDRINUSE is caught; any other error (e.g. EACCES, an invalid
 * port) propagates immediately. When all `MAX_PORT_SCAN` consecutive ports are
 * occupied, throws a precise cap error naming the exhausted range.
 *
 * `bind` is injected so this loop is testable without owning the Bun.serve
 * call: callers pass a closure that runs `Bun.serve({ port, … })` and returns
 * the server (or its bound port).
 */
export function scanForPort<T>(startPort: number, bind: (port: number) => T): T {
  let lastErr: unknown;
  for (let i = 0; i < MAX_PORT_SCAN; i++) {
    const port = startPort + i;
    try {
      return bind(port);
    } catch (err: unknown) {
      if (!isAddrInUse(err)) throw err;
      lastErr = err;
    }
  }
  const lastPort = startPort + MAX_PORT_SCAN - 1;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `ledger-web: no free port in ${startPort}..${lastPort} ` +
      `(${MAX_PORT_SCAN} attempts, last error: ${msg})`,
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  // Load cq.toml from the ledger root (null when absent — feature off).
  // A dangling reviewers/planners alias in cq.toml throws CqConfigError, which
  // we treat as a fatal startup error (consistent with the catch below).
  const config = loadConfig(parsed.cwd);
  // Resolve effective host/port: explicit CLI flag > cq.toml [webui] > default.
  const { host, port } = resolveWebOpts(parsed, config?.webui ?? null);
  const opts: ServeOpts = { ...parsed, host, port };
  await fs.mkdir(opts.outdir, { recursive: true });
  const server = await serve(opts);
  // Stop the server and exit on Ctrl+C / SIGTERM so the port is released and
  // the process does not linger (Bun keeps the process alive for the server).
  const shutdown = (): void => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const actualPort = server.port;
  const backend = opts.mcpUrl === null ? `embedded MCP (cwd=${opts.cwd})` : `MCP upstream ${opts.mcpUrl}`;
  // Machine-readable URL on stdout (for scripts/orchestrators).
  process.stdout.write(`http://${opts.host}:${actualPort}/\n`);
  // Human-readable line on stderr.
  process.stderr.write(
    `ledger-web: serving http://${opts.host}:${actualPort}/ → ${backend}\n`,
  );
}

const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ledger-web: fatal: ${msg}\n`);
    process.exit(1);
  });
}
