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

const DEFAULT_PORT = 5180;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MCP_URL = "http://127.0.0.1:7777/mcp";

const WEB_SRC = path.resolve(import.meta.dir, "main.tsx");
const DEFAULT_OUTDIR = path.resolve(import.meta.dir, "..", "dist");

export interface ServeOpts {
  host: string;
  port: number;
  mcpUrl: string;
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

export async function serve(opts: ServeOpts): Promise<ReturnType<typeof Bun.serve>> {
  await prepare(opts.outdir);
  const indexPath = path.join(opts.outdir, "index.html");

  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0, // long-lived SSE proxy streams must not time out
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === MCP_PROXY_PATH) {
        return proxyToMcp(req, opts.mcpUrl);
      }
      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      // Resolve within outdir; reject path traversal.
      const resolved = path.resolve(opts.outdir, `.${reqPath}`);
      if (resolved === opts.outdir || resolved.startsWith(opts.outdir + path.sep)) {
        const file = Bun.file(resolved);
        if (await file.exists()) return new Response(file);
      }
      // SPA fallback.
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
}

interface ParsedArgs {
  host: string;
  port: number;
  mcpUrl: string;
  outdir: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let mcpUrl = DEFAULT_MCP_URL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a?.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--host") host = argv[++i] ?? host;
    else if (a?.startsWith("--host=")) host = a.slice("--host=".length);
    else if (a === "--mcp-url") mcpUrl = argv[++i] ?? mcpUrl;
    else if (a?.startsWith("--mcp-url=")) mcpUrl = a.slice("--mcp-url=".length);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ledger-web: --port must be 1..65535; got: ${port}`);
  }
  const outdir = process.env["LEDGER_WEB_OUTDIR"] ?? DEFAULT_OUTDIR;
  return { host, port, mcpUrl, outdir };
}

export async function main(argv: readonly string[]): Promise<void> {
  const opts = parseArgs(argv);
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
  process.stderr.write(
    `ledger-web: serving http://${opts.host}:${server.port}/ → MCP upstream ${opts.mcpUrl}\n`,
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
