#!/usr/bin/env -S bun run
/**
 * ledger-mcp — standalone MCP server exposing the 14 ledger tools.
 *
 * This is the cq-free ledger MCP server: it serves the tool surface backed
 * by a file-backed `FsLedgerStore` rooted at the supplied `--cwd` directory,
 * with NO dependency on the cq server. It speaks two transports:
 *
 *   - stdio (default): JSON-RPC frames over stdin/stdout, for clients that
 *     spawn the server as a child process (Claude Code, Codex, etc.).
 *   - Streamable HTTP (`--http [host:]port`): the MCP Streamable HTTP
 *     transport over `Bun.serve`, for clients that connect to an
 *     already-running server (e.g. ledger-tui). Session-managed: each
 *     client initialize allocates a session bound to its own `McpServer`,
 *     all sharing the one `FsLedgerStore`.
 *
 * CLI:
 *   ledger-mcp                            # stdio; ledger root = $LEDGER_ROOT or CWD
 *   ledger-mcp --cwd <path>               # stdio; explicit root (rel→resolved vs CWD)
 *   ledger-mcp --cwd <path> --http 7777   # HTTP on 127.0.0.1:7777
 *   ledger-mcp --http 0.0.0.0:7777        # HTTP, root = CWD
 *
 * Ledger root precedence: --cwd > $LEDGER_ROOT > process CWD. Defaulting to the
 * CWD lets a single global install serve per-repo ledgers (the MCP client
 * spawns this server with the repo as its working directory).
 *
 * Output discipline (stdio mode). Stdout is reserved for MCP protocol
 * traffic only; all logs go to stderr.
 */

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  FsLedgerStore,
  type LedgerStore,
  registerLedgerStdioTools,
} from "@cq/ledger";

const SERVER_INFO = { name: "ledger-mcp", version: "0.0.1" } as const;
const DEFAULT_HTTP_HOST = "127.0.0.1";
/** Path the Streamable HTTP transport is served on. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * Permissive CORS for the HTTP transport so a browser MCP client (ledger-web)
 * can reach it cross-origin. The transport carries no cookies/credentials, so
 * `*` is safe; `mcp-session-id` MUST be exposed or the browser hides it from
 * JS and the client can never capture its session. The request-header allow
 * list covers everything the Streamable HTTP client sends.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, mcp-session-id, mcp-protocol-version, accept, last-event-id, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export interface HttpOpts {
  host: string;
  port: number;
}

export interface ParsedArgs {
  cwd: string;
  http: HttpOpts | null;
}

/**
 * Parse `--http [host:]port` into a structured {host, port}. A bare port
 * binds 127.0.0.1 (loopback) so the server is not exposed by default.
 */
function parseHttp(value: string): HttpOpts {
  const lastColon = value.lastIndexOf(":");
  let host = DEFAULT_HTTP_HOST;
  let portStr = value;
  if (lastColon !== -1) {
    host = value.slice(0, lastColon);
    portStr = value.slice(lastColon + 1);
    if (host === "") host = DEFAULT_HTTP_HOST;
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ledger-mcp: --http port must be 1..65535; got: ${portStr}`);
  }
  return { host, port };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  let http: HttpOpts | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else if (a === "--http") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --http requires a [host:]port value");
      }
      http = parseHttp(v);
    } else if (a !== undefined && a.startsWith("--http=")) {
      http = parseHttp(a.slice("--http=".length));
    }
  }
  // The ledger root, in priority order: --cwd, then $LEDGER_ROOT, else the
  // process working directory. A relative value resolves against the CWD.
  // Defaulting to the CWD is what lets one global install serve per-repo
  // ledgers — the MCP client spawns this server with the repo as its CWD.
  const fromArg = cwd !== undefined && cwd !== "" ? cwd : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const resolved = chosen !== undefined ? path.resolve(chosen) : process.cwd();
  return { cwd: resolved, http };
}

/** Build a fresh McpServer with the 14 ledger tools bound to `store`. */
function buildServer(store: LedgerStore): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  registerLedgerStdioTools(server, store);
  return server;
}

/**
 * Serve the MCP protocol over Streamable HTTP via Bun.serve.
 *
 * Session-managed (stateful): the first request from a client is an
 * `initialize` with no session id; we mint a transport + McpServer for it
 * and register the transport under the generated session id once the SDK
 * fires `onsessioninitialized`. Subsequent requests carry the
 * `mcp-session-id` header and route back to the same transport. All
 * sessions share the single `store` (FsLedgerStore is concurrency-safe via
 * its own mutex + lockfile).
 *
 * Returns the running Bun server so callers (tests) can `.stop()` it.
 */
export function serveHttp(
  store: LedgerStore,
  opts: HttpOpts,
): ReturnType<typeof Bun.serve> {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  // Inner handler returns the protocol Response; the outer fetch applies CORS
  // uniformly and answers preflight so every code path stays consistent.
  async function handle(req: Request): Promise<Response> {
      const sessionId = req.headers.get("mcp-session-id") ?? undefined;
      const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;
      if (existing !== undefined) {
        return existing.handleRequest(req);
      }

      // No existing session. Only a POST initialize may open one; anything
      // else without a valid session is a client error.
      if (req.method !== "POST") {
        return new Response("missing or invalid session", { status: 400 });
      }
      const body: unknown = await req.json().catch(() => undefined);
      if (!isInitializeRequest(body)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session id" },
            id: null,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
        onsessionclosed: (sid) => {
          transports.delete(sid);
        },
      });
      const server = buildServer(store);
      await server.connect(transport);
      // Body already consumed above; hand it back so the transport doesn't
      // re-read the (now-empty) request stream.
      return transport.handleRequest(req, { parsedBody: body });
  }

  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      // CORS preflight — answer before any session/path logic.
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (url.pathname !== MCP_HTTP_PATH) {
        return applyCors(new Response("not found", { status: 404 }));
      }
      return applyCors(await handle(req));
    },
  });
}

export async function main(argv: readonly string[]): Promise<void> {
  const { cwd, http } = parseArgs(argv);

  // Construct the store, init it, then register tools. If init fails we
  // surface the error to stderr and exit non-zero — the parent MCP client
  // sees the channel close and treats the server as unhealthy.
  const store = new FsLedgerStore({ root: cwd });
  await store.init();

  if (http !== null) {
    const server = serveHttp(store, http);
    const shutdown = (): void => {
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.stderr.write(
      `ledger-mcp: serving Streamable HTTP on http://${http.host}:${http.port}${MCP_HTTP_PATH} (cwd=${cwd})\n`,
    );
    return;
  }

  const server = buildServer(store);

  // Graceful shutdown on SIGTERM / SIGINT.
  const shutdown = (): void => {
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer holds the process open by virtue of the stdio listener;
  // exiting here would close stdin and tear the channel down immediately.
  process.stderr.write(`ledger-mcp: serving stdio MCP on cwd=${cwd}\n`);
}

// Only run main() when executed directly (not when imported by the test
// suite). `import.meta.main` is bun-specific but available in the bun
// runtime that hosts this binary.
const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ledger-mcp: fatal: ${msg}\n`);
    process.exit(1);
  });
}
