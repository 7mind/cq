#!/usr/bin/env -S bun run
/**
 * ledger-mcp — standalone MCP server exposing the 21 ledger tools.
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
import type { ServerWebSocket } from "bun";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  FsLedgerStore,
  type LedgerStore,
  type ResetSummary,
  type ReadLogCapability,
  type ConfigCapability,
  registerLedgerStdioTools,
} from "@cq/ledger";
import { createConfigCapability } from "./configCapability.js";
import { startLedgerWatcher } from "./watcher.js";

// Re-export so in-process hosts (ledger-tui embedded, ledger-web embedded) can
// wire live refresh against the same watcher the standalone binary uses.
export { startLedgerWatcher, type LedgerWatcher } from "./watcher.js";

const SERVER_INFO = { name: "ledger-mcp", version: "0.0.1" } as const;
const DEFAULT_HTTP_HOST = "127.0.0.1";
/** Path the Streamable HTTP transport is served on. */
export const MCP_HTTP_PATH = "/mcp";
/** Path of the live-change WebSocket (push notifications to UIs). */
export const WS_PATH = "/ws";
/** Bun pub/sub topic that change notifications are published to. */
export const LEDGER_TOPIC = "ledger";

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
  /** `--reset`: wipe-and-reinit the ledgers at `cwd`, then exit without serving. */
  reset: boolean;
  /** `--yes`/`-y`: skip the interactive reset confirmation (unattended). */
  yes: boolean;
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
  let reset = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") {
      reset = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--cwd") {
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
  // Ledger root precedence: --cwd > $LEDGER_ROOT > process CWD; a relative
  // value resolves against the CWD. (See file header for the rationale.)
  const fromArg = cwd !== undefined && cwd !== "" ? cwd : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const resolved = chosen !== undefined ? path.resolve(chosen) : process.cwd();
  return { cwd: resolved, http, reset, yes };
}

/**
 * Server-level usage guidance, surfaced to the client on `initialize` (the MCP
 * `instructions` field) so the model gets "when/how to use this server" without
 * per-project setup. Keep it short; per-repo policy belongs in the project's own
 * instructions (e.g. CLAUDE.md).
 */
const SERVER_INSTRUCTIONS = [
  "This server is a markdown-backed planning ledger. Use it to track work as",
  "structured items instead of scratch notes or ad-hoc TODO files.",
  "",
  "Model: a `milestones` ledger holds milestones (which form a DAG via",
  "dependsOn/blockedBy); other ledgers (tasks, defects, hypothesis, questions,",
  "decisions, goals) hold typed items, each attached to a milestone.",
  "",
  "When to use it:",
  "- At the start of multi-step work: create a milestone, then create_item the",
  "  tasks/defects/etc. under it.",
  "- As work proceeds: update_item status (e.g. planned→wip→done) so the ledger",
  "  reflects reality; record findings as hypothesis/decision/question items.",
  "- Before acting: fts_search / fetch_ledger to see what already exists; do not",
  "  duplicate an existing item. fts_search accepts filters, e.g.",
  '  `status:wip ledger:tasks`, `(status:done OR status:wip)`, `author:user`.',
  "- On completion: mark items terminal and archive_milestone once all its items",
  "  are terminal.",
  "",
  "Conventions: keep one item per discrete unit of work; put detail in the",
  "item's fields (markdown is supported); use enumerate_ledgers to discover",
  "ledgers and their schemas before creating items.",
  "",
  "Provenance: on every create_item / update_item, set `author` to your model",
  'class (e.g. "opus-4.8[1m]") and `session` to your CLAUDE_CODE_SESSION_ID so',
  "the ledger records who wrote each item. Human edits via the TUI/web editor",
  'set author to "user". These are optional intrinsic fields — not schema',
  "fields — so they apply to every ledger and never need a schema change.",
  "",
  "fts_search query notes:",
  "- Two paths for status filtering: (a) dedicated `status` param — a single",
  "  exact value pre-filtered before ranking; (b) inline status: qualifier in",
  "  the query string. Combine freely: status='wip' + query='ledger:tasks auth'.",
  "- OR-of-qualifiers work: '(status:open OR status:wip)' uses the structured",
  "  evaluator (not the MiniSearch fast path) and returns all matching items.",
  "- Active vs archived: fts_search covers active items by default; pass",
  "  include_archived:true to also search milestone-group archives.",
  "- Terminal vs active: terminalStatuses (done/resolved/abandoned etc.) are",
  "  still active (searchable, editable) until archive_milestone is called.",
  "  Use -status:done to exclude terminal items from results.",
  "",
  "Quick overview tools:",
  "- snapshot() — compact {id,status,summary} cross-ledger state in one call.",
  "- fetch_ledger with compact:true — strips long narrative fields to avoid",
  "  token-overflow on large ledgers. Combine with offset/limit for pagination.",
].join("\n");

/**
 * Stable leading line carrying the project display name on `instructions`,
 * used as a fallback for SDK runtimes that drop `title` off the Implementation
 * carrier. The primary channel is `serverInfo.title` (read via the client's
 * `getServerVersion()`); this line lets a client recover the same value from
 * `getInstructions()` if title is absent.
 */
export function projectInstructionLine(displayName: string): string {
  return `Project: ${displayName}`;
}

/**
 * Build a fresh McpServer with the ledger tools (LEDGER_TOOL_NAMES) bound to
 * `store`. read_log is wired only when `store` is filesystem-backed.
 *
 * `displayName` is the basename of the resolved `--cwd` (the project directory
 * name). Frontends are pure MCP clients and never read cwd, so the server
 * conveys it on `serverInfo.title` — a per-instance Implementation `title`,
 * with `name`/`version` held stable — which the client reads via
 * `getServerVersion()`. It is also pinned as the leading `instructions` line as
 * a fallback for SDK runtimes that omit `title`. Stable across reconnects.
 */
export function buildServer(store: LedgerStore, displayName: string): McpServer {
  const serverInfo = { ...SERVER_INFO, title: displayName };
  const instructions = `${projectInstructionLine(displayName)}\n\n${SERVER_INSTRUCTIONS}`;
  const server = new McpServer(serverInfo, {
    capabilities: { tools: {} },
    instructions,
  });
  // read_log (Q87 / R137 #6) is bounded to the EXPLICIT FS-store root, not the
  // generic LedgerStore interface; thread the capability only when the store is
  // filesystem-backed. An in-memory store supplies no capability and read_log
  // then throws the documented not-implemented error.
  const readLog: ReadLogCapability | undefined =
    store instanceof FsLedgerStore ? (p) => store.readLog(p) : undefined;
  // cq.toml config capability (R193 / G18 / T2). The config root IS the ledger
  // root (Q99): bind it to the SAME resolved store root buildServer's callers
  // already resolved (--cwd > $LEDGER_ROOT > CWD), re-reading cq.toml on every
  // call (createConfigCapability closes over the root with no caching). Wired
  // here so it reaches the standalone stdio binary, the HTTP transport, AND the
  // embedded TUI/web hosts — all funnel through buildServer. An in-memory store
  // (tests) supplies no capability; get_reviewers/get_config then throw the
  // documented not-implemented error.
  const configCapability: ConfigCapability | undefined =
    store instanceof FsLedgerStore ? createConfigCapability(store.rootDir) : undefined;
  registerLedgerStdioTools(server, store, readLog, configCapability);
  return server;
}

/**
 * Construct and initialise a file-backed store rooted at `cwd`. The single
 * place that builds the embedded store, shared by the standalone binary and
 * the in-process UIs (ledger-tui in-memory transport, ledger-web co-hosted
 * HTTP) so root resolution + init stay identical everywhere.
 */
export async function createEmbeddedStore(cwd: string): Promise<FsLedgerStore> {
  const store = new FsLedgerStore({ root: cwd });
  await store.init();
  return store;
}

/**
 * Transport-agnostic MCP-over-HTTP handlers bound to one `store`, so any
 * `Bun.serve` host — the standalone `serveHttp` below OR ledger-web's `serve`
 * — mounts the SAME `/mcp` request logic and `/ws` live-change socket. The
 * caller owns the `Bun.serve` instance (and thus `server.publish` for change
 * frames); these handlers only implement the per-request / per-socket
 * behaviour. Returned `handle` produces the raw protocol Response WITHOUT CORS
 * — the caller applies CORS uniformly.
 */
export interface McpHttpHandlers {
  /** Handle one `/mcp` request (session routing + initialize). */
  handle(req: Request): Promise<Response>;
  /** `Bun.serve` `websocket.open` — subscribe the socket to change frames. */
  onWsOpen(ws: ServerWebSocket<undefined>): void;
  /** `Bun.serve` `websocket.message` — app-level ping/pong heartbeat. */
  onWsMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer): void;
}

export function attachMcpHttp(store: LedgerStore, displayName: string): McpHttpHandlers {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

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
    const server = buildServer(store, displayName);
    await server.connect(transport);
    // Body already consumed above; hand it back so the transport doesn't
    // re-read the (now-empty) request stream.
    return transport.handleRequest(req, { parsedBody: body });
  }

  function onWsOpen(ws: ServerWebSocket<undefined>): void {
    ws.subscribe(LEDGER_TOPIC); // receives every published `changed` event
  }

  function onWsMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer): void {
    // App-level heartbeat (resilient-ws-ui R3): echo ping nonce + ts so the
    // client can measure RTT and detect a dead connection.
    let msg: { type?: string; nonce?: string; ts?: number } | undefined;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", nonce: msg.nonce, ts: msg.ts, serverTs: Date.now() }));
    }
  }

  return { handle, onWsOpen, onWsMessage };
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
  displayName: string,
): ReturnType<typeof Bun.serve> {
  const { handle, onWsOpen, onWsMessage } = attachMcpHttp(store, displayName);

  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    async fetch(req, server): Promise<Response | undefined> {
      const url = new URL(req.url);
      // CORS preflight — answer before any session/path logic.
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      // Live-change WebSocket upgrade.
      if (url.pathname === WS_PATH) {
        if (server.upgrade(req, { data: undefined })) return undefined; // upgraded; Bun owns the socket
        return applyCors(new Response("expected a websocket upgrade", { status: 426 }));
      }
      if (url.pathname !== MCP_HTTP_PATH) {
        return applyCors(new Response("not found", { status: 404 }));
      }
      return applyCors(await handle(req));
    },
    websocket: {
      open: onWsOpen,
      message: onWsMessage,
    },
  });
}

/** Build a `changed` notification frame for the WS topic. */
export function changedFrame(ledgerId: string | null): string {
  return JSON.stringify(ledgerId !== null ? { type: "changed", ledger: ledgerId } : { type: "changed" });
}

/**
 * Injectable IO for the `--reset` path, so the operator-facing confirmation +
 * exit can be driven from a test without touching the real TTY / killing the
 * test process. Production wires these to `process.std*` and `readline`.
 */
export interface ResetIo {
  /** Whether stdin is an interactive terminal (gates the prompt). */
  isTty: boolean;
  /** Write an informational/summary line (stdout in production). */
  out(line: string): void;
  /** Write a warning/error line (stderr in production). */
  err(line: string): void;
  /**
   * Show `question`, read one line, resolve the trimmed answer. Only called on
   * a TTY without `--yes`. Production reads a single line via `readline`.
   */
  prompt(question: string): Promise<string>;
}

/** Outcome of {@link runReset}: the exit code main() should propagate. */
export interface ResetOutcome {
  exitCode: number;
  /** The reset summary when the wipe actually ran; null if refused/aborted. */
  summary: ResetSummary | null;
}

function defaultResetIo(): ResetIo {
  return {
    isTty: process.stdin.isTTY === true,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: async (question) => {
      const rl = (await import("node:readline")).createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await new Promise<string>((resolve) => rl.question(question, resolve));
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * The `--reset` short-circuit (Q64): confirm, then wipe-and-reinit the ledgers
 * at `cwd` via the public {@link FsLedgerStore.reset}, print the backup dir +
 * per-ledger summary, and return an exit code. NEVER starts a server.
 *
 * Confirmation policy:
 *   - `--yes`            → proceed unattended (no prompt).
 *   - TTY, no `--yes`    → prompt; proceed only on a `y`/`Y` answer.
 *   - non-TTY, no `--yes`→ REFUSE (exit 2) — never wipe a tree silently.
 *
 * Factored out of main() so a test can drive it with an injected ResetIo and
 * assert the filesystem effects without the process.exit that main() applies.
 */
export async function runReset(
  cwd: string,
  yes: boolean,
  io: ResetIo = defaultResetIo(),
): Promise<ResetOutcome> {
  if (!yes) {
    if (!io.isTty) {
      io.err(
        `ledger-mcp: refusing to reset ledgers at ${cwd} without confirmation; ` +
          `re-run with --yes to reset non-interactively.`,
      );
      return { exitCode: 2, summary: null };
    }
    const answer = await io.prompt(
      `Reset ledgers at ${cwd}? Backup will be written to docs/.backup/. [y/N] `,
    );
    if (answer.trim().toLowerCase() !== "y") {
      io.err("ledger-mcp: reset aborted.");
      return { exitCode: 1, summary: null };
    }
  }

  const store = new FsLedgerStore({ root: cwd });
  await store.init();
  let summary: ResetSummary;
  try {
    summary = await store.reset();
  } finally {
    await store.dispose();
  }

  io.out(`ledger-mcp: reset ledgers at ${cwd}`);
  io.out(`  backup: ${summary.backupDir}`);
  for (const { name, itemCount } of summary.ledgers) {
    io.out(`  ${name}: ${itemCount} item(s) backed up, reinitialised empty`);
  }
  return { exitCode: 0, summary };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { cwd, http, reset, yes } = parseArgs(argv);
  const displayName = path.basename(cwd);

  // --reset short-circuit: confirm, wipe-and-reinit, print summary, exit.
  // NEVER falls through to start a watcher/HTTP/stdio server.
  if (reset) {
    const { exitCode } = await runReset(cwd, yes);
    process.exit(exitCode);
  }

  // Construct the store, init it, then register tools. If init fails we
  // surface the error to stderr and exit non-zero — the parent MCP client
  // sees the channel close and treats the server as unhealthy.
  const store = new FsLedgerStore({ root: cwd });
  await store.init();

  if (http !== null) {
    const server = serveHttp(store, http, displayName);
    // Watch the files; push a `changed` frame to subscribed UIs on any change
    // (incl. writes by another process — the agent's own server, git, etc.).
    const watcher = startLedgerWatcher(store, cwd, (ledger) => {
      server.publish(LEDGER_TOPIC, changedFrame(ledger));
    });
    const shutdown = (): void => {
      watcher.close();
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

  const server = buildServer(store, displayName);
  // Even on stdio, watch the files so this server's cache stays fresh when
  // another process writes the same ledgers.
  const watcher = startLedgerWatcher(store, cwd);

  // Graceful shutdown on SIGTERM / SIGINT.
  const shutdown = (): void => {
    watcher.close();
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
