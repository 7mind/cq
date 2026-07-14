#!/usr/bin/env -S bun run
/**
 * ledger-mcp — standalone MCP server exposing the 26 ledger tools.
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
 *   ledger-mcp                                      # stdio; ledger root = $LEDGER_ROOT or CWD
 *   ledger-mcp --cwd <path>                         # stdio; explicit root (rel→resolved vs CWD)
 *   ledger-mcp --cwd <path> --http 7777             # HTTP on 127.0.0.1:7777
 *   ledger-mcp --http 0.0.0.0:7777                  # HTTP, root = CWD
 *   ledger-mcp --tool-prefix myproj                 # prefix all tool names with "myproj_"
 *   ledger-mcp --tool-prefix myproj --http 7777     # prefix + HTTP
 *   ledger-mcp restore --from-cache [--cwd <path>]  # restore .cq/ from the cache mirror
 *
 * Subcommands: the DEFAULT (no positional subcommand) launches the server as
 * above. The single recognised subcommand is `restore --from-cache`, which
 * copies the per-root `~/.cache` mirror (maintained by the store on every
 * mutation) back into `<root>/.cq/` — the one ledger lifecycle op hosted by
 * ledger-mcp (Q169). The OTHER lifecycle ops (backup+reinit, erase) remain in
 * the `cq` CLI — run `cq reset` / `cq erase`.
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
  type LedgerStore,
  type ReadLogCapability,
  type ConfigCapability,
  type PromptCatalogCapability,
  type ResolvedLedgerStore,
  type XdgCoherenceWatcher,
  createLedgerStore,
  startXdgCoherenceWatcher,
  nodeGitRunner,
  registerLedgerStdioTools,
  LEDGER_TOOL_NAMES,
  assertToolPrefix,
  prefixToolName,
} from "@cq/ledger";
import { createConfigCapability } from "./configCapability.js";
import { createPromptCatalogCapability } from "./promptCatalogCapability.js";
import { startLedgerWatcher, type LedgerWatcher } from "./watcher.js";
import { startLedgerRefWatcher } from "./refWatcher.js";
import { restoreFromCache } from "./restore.js";

export { restoreFromCache, CacheMirrorMissingError } from "./restore.js";
export type { RestoreSummary } from "./restore.js";

// Re-export so in-process hosts (ledger-tui embedded, ledger-web embedded) can
// wire live refresh against the same watcher the standalone binary uses.
export { startLedgerWatcher, type LedgerWatcher } from "./watcher.js";
export { startLedgerRefWatcher, type LedgerRefWatcher, REF_POLL_MS } from "./refWatcher.js";

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
  /** Optional ledger-tool name prefix (default `''` = unprefixed). */
  toolPrefix: string;
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

/**
 * Resolve the ledger root with the suite-wide precedence: `--cwd > $LEDGER_ROOT
 * > process CWD`. A non-empty relative value resolves against the CWD. Shared
 * by the server-launch path (parseArgs) and the `restore` subcommand
 * (parseRestoreArgs) so root resolution stays identical.
 */
function resolveRoot(cwdArg: string | undefined): string {
  const fromArg = cwdArg !== undefined && cwdArg !== "" ? cwdArg : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  return chosen !== undefined ? path.resolve(chosen) : process.cwd();
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  let http: HttpOpts | null = null;
  let toolPrefix = "";
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
    } else if (a === "--tool-prefix") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --tool-prefix requires a value");
      }
      toolPrefix = v;
    } else if (a !== undefined && a.startsWith("--tool-prefix=")) {
      toolPrefix = a.slice("--tool-prefix=".length);
    }
  }
  // Validate the prefix at parse time so a malformed value fails before the
  // server starts (fast-fail, per T379).
  assertToolPrefix(toolPrefix);
  // Ledger root precedence: --cwd > $LEDGER_ROOT > process CWD; a relative
  // value resolves against the CWD. (See file header for the rationale.)
  return { cwd: resolveRoot(cwd), http, toolPrefix };
}

/** Top-level CLI usage text (mirrors the file-header JSDoc; printed by --help/-h). */
export const TOP_LEVEL_USAGE = [
  "usage: ledger-mcp [options]                            # stdio MCP server",
  "       ledger-mcp restore --from-cache [--cwd <path>] # restore .cq/ from cache",
  "",
  "options:",
  "  --cwd <path>          Ledger root (default: $LEDGER_ROOT or current working directory)",
  "  --http [host:]port    Serve Streamable HTTP instead of stdio (default host: 127.0.0.1)",
  "  --tool-prefix <p>     Prefix all tool names with \"<p>_\"",
  "  -h, --help            Print this usage and exit",
  "",
  "subcommands:",
  "  restore --from-cache  Restore <root>/.cq/ from the per-root XDG cache mirror",
].join("\n");

/** The single recognised positional subcommand. */
export const RESTORE_SUBCOMMAND = "restore";

/** Parsed `restore --from-cache [--cwd <path>]` invocation. */
export interface RestoreArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  cwd: string;
}

/** Usage text for the `restore` subcommand (printed on a malformed invocation). */
export const RESTORE_USAGE = [
  "usage: ledger-mcp restore --from-cache [--cwd <path>]",
  "",
  "  Restore <root>/.cq/ from the per-root cache mirror under the XDG cache base.",
  "  ledger root: --cwd > $LEDGER_ROOT > current working directory",
].join("\n");

/**
 * Parse the args AFTER the `restore` subcommand token. Requires the
 * `--from-cache` flag (the only restore mode) and recognises `--cwd <path>` /
 * `--cwd=<path>`. Throws on a missing `--from-cache` or a `--cwd` without a
 * value.
 */
export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  let cwd: string | undefined;
  let fromCache = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-cache") {
      fromCache = true;
    } else if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp restore: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else {
      throw new Error(`ledger-mcp restore: unknown argument: ${String(a)}\n${RESTORE_USAGE}`);
    }
  }
  if (!fromCache) {
    throw new Error(`ledger-mcp restore: --from-cache is required\n${RESTORE_USAGE}`);
  }
  return { cwd: resolveRoot(cwd) };
}

/**
 * Server-level usage guidance, surfaced to the client on `initialize` (the MCP
 * `instructions` field) so the model gets "when/how to use this server" without
 * per-project setup. Keep it short; per-repo policy belongs in the project's own
 * instructions (e.g. CLAUDE.md).
 */
const SERVER_INSTRUCTIONS_TEMPLATE = [
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
  "- derive_predicates() — the /cq:advance flow-detection predicates",
  "  { pInvestigate, pPlan, pImplement, openQuestionGate } in one call; read",
  "  these instead of hand-deriving actionability from snapshot.",
  "- fetch_ledger with compact:true — strips long narrative fields to avoid",
  "  token-overflow on large ledgers. Combine with offset/limit for pagination.",
].join("\n");

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the server-level usage guidance, optionally renaming each referenced
 * ledger tool to its prefixed form (T377 / G45).
 *
 * `buildServerInstructions('')` returns {@link SERVER_INSTRUCTIONS_TEMPLATE}
 * BYTE-IDENTICALLY (prefixToolName('', name) === name, so every substitution is
 * a no-op). For a non-empty prefix, every WHOLE-WORD occurrence of a registered
 * tool name is rewritten to `prefixToolName(prefix, name)`.
 *
 * Drift-free by construction: the set of names rewritten is the live
 * {@link LEDGER_TOOL_NAMES}, and the prefixed form is derived via the shared
 * {@link prefixToolName} helper (Q208 — derive once + reuse), never a separate
 * hardcoded list. Names are replaced longest-first so a name that is a prefix
 * of another (e.g. `fetch_ledger` vs `fetch_ledger_archive`) cannot be
 * partially rewritten; `\b` boundaries (underscore is a word char) keep each
 * substitution to a whole token.
 */
export function buildServerInstructions(toolPrefix: string): string {
  assertToolPrefix(toolPrefix);
  if (toolPrefix === "") return SERVER_INSTRUCTIONS_TEMPLATE;
  // Longest names first so a shorter name that is a leading substring of a
  // longer one does not consume the longer name's token.
  const names = [...LEDGER_TOOL_NAMES].sort((a, b) => b.length - a.length);
  let text = SERVER_INSTRUCTIONS_TEMPLATE;
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    text = text.replace(pattern, prefixToolName(toolPrefix, name));
  }
  return text;
}

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
 * Build a fresh McpServer with the 26 ledger tools (LEDGER_TOOL_NAMES) bound to
 * `store`. read_log is wired only when `store` is filesystem-backed.
 *
 * `displayName` is the basename of the resolved `--cwd` (the project directory
 * name). Frontends are pure MCP clients and never read cwd, so the server
 * conveys it on `serverInfo.title` — a per-instance Implementation `title`,
 * with `name`/`version` held stable — which the client reads via
 * `getServerVersion()`. It is also pinned as the leading `instructions` line as
 * a fallback for SDK runtimes that omit `title`. Stable across reconnects.
 */
/**
 * Duck-typed root-dir capability check (T357). Both FsLedgerStore and the
 * git-object backend expose a `rootDir` accessor (the resolved ledger root the
 * root-bound config / prompt-catalog capabilities attach to); the in-memory test
 * store does not. Returns the root string when the store advertises one, else
 * `undefined`. Backend-independent on purpose — config/promptCatalog are not
 * FS-specific, so they must NOT be gated on `instanceof FsLedgerStore`.
 */
export function rootDirOf(store: LedgerStore): string | undefined {
  const candidate = (store as { rootDir?: unknown }).rootDir;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Duck-typed read-log capability check (T408). Both FsLedgerStore (tails the
 * on-disk `<root>/.cq/logs`) and GitObjectLedgerBackend (resolves `logs/<rel>`
 * from the orphan ref tip) expose a bounded, root-confined `readLog(relPath)`
 * returning a `ReadLogResult`; the in-memory test store does not. Returns the
 * bound capability when the store advertises one, else `undefined` — so
 * read_log is wired for BOTH file-backed AND git-object backends but throws the
 * documented not-implemented error over an in-memory store. Backend-aware on
 * purpose, replacing the former `instanceof FsLedgerStore` gate (which excluded
 * the git-object backend even though it can serve read_log from the ref tree).
 */
export function readLogOf(store: LedgerStore): ReadLogCapability | undefined {
  const candidate = (store as { readLog?: unknown }).readLog;
  if (typeof candidate !== "function") return undefined;
  const fn = candidate as ReadLogCapability;
  return (relPath) => fn.call(store, relPath);
}

/**
 * Start the per-backend coherence watcher for a resolved store (T357 item 5;
 * xdg case wired in T500): file-watch ({@link startLedgerWatcher}) for the fs
 * backend, ref-sha-watch ({@link startLedgerRefWatcher}, T353) for git-object,
 * data_version-poll ({@link startXdgCoherenceWatcher}, T530) for xdg. All three
 * return a handle with `.close()`, so the host wires shutdown identically
 * regardless of backend. The git-object path binds a {@link nodeGitRunner} at
 * the repo root so the watcher polls `refs/heads/<branch>` for ledger advances
 * by another process.
 *
 * The xdg watcher has no `onChange` parameter of its own (T530 bulk-invalidates
 * every known ledger off a single `data_version` bump with no per-ledger
 * granularity to report) — `onChange` is accepted here for signature parity
 * with the other two backends but is not invoked for xdg. WS "changed" pushes
 * for the xdg backend are therefore not yet wired; the STORE-level coherence
 * (invalidate → fresh reads) IS in effect regardless, which is what the
 * acceptance criterion for T500 requires.
 */
export function startLedgerCoherenceWatcher(
  resolved: ResolvedLedgerStore,
  root: string,
  onChange?: (ledgerId: string | null) => void,
): LedgerWatcher | XdgCoherenceWatcher {
  if (resolved.backend === "git-object") {
    return startLedgerRefWatcher(resolved.store, resolved.branch, nodeGitRunner(root), onChange);
  }
  if (resolved.backend === "xdg") {
    if (resolved.dbPath === undefined) {
      throw new Error(
        "startLedgerCoherenceWatcher: backend 'xdg' resolved without a dbPath — " +
          "createLedgerStore must always set dbPath for the xdg backend.",
      );
    }
    return startXdgCoherenceWatcher(resolved.store, resolved.dbPath);
  }
  return startLedgerWatcher(resolved.store, root, onChange);
}

/**
 * Options for {@link createLedgerMcpServer}, the public builder for an
 * `McpServer` bound to one `store` (G45 / Q209).
 *
 * `toolPrefix` is OPTIONAL and defaults to `''` (the unprefixed 26-tool
 * surface). A non-empty prefix renames every registered tool to its
 * `prefixToolName(prefix, name)` form and rewrites the matching tool names in
 * the server-level `instructions`. The prefix is validated by
 * {@link assertToolPrefix} (via `buildServerInstructions` + the threaded
 * `registerLedgerStdioTools` argument).
 */
export interface CreateLedgerMcpServerOptions {
  /** The ledger store the tools are bound to. */
  store: LedgerStore;
  /** Project display name carried on `serverInfo.title` + the instructions line. */
  displayName: string;
  /** Optional ledger-tool name prefix (default `''` = unprefixed). */
  toolPrefix?: string;
}

/**
 * Public builder: construct an `McpServer` exposing the ledger tool surface for
 * `store`, optionally renamed under `toolPrefix` (G45 / Q209). This is the
 * single factory both the standalone stdio host and `attachMcpHttp` route
 * through; {@link buildServer} is a thin unprefixed wrapper over it.
 *
 * With `toolPrefix` omitted or `''` the behaviour is BYTE-IDENTICAL to the
 * historical `buildServer` (serverInfo, instructions, capability gating, and the
 * registered 26-tool names are all unchanged). A non-empty prefix renames the
 * tools and the instruction references via the shared
 * {@link buildServerInstructions} / {@link registerLedgerStdioTools} prefix path.
 */
export function createLedgerMcpServer(opts: CreateLedgerMcpServerOptions): McpServer {
  const { store, displayName } = opts;
  const toolPrefix = opts.toolPrefix ?? "";
  assertToolPrefix(toolPrefix);
  const serverInfo = { ...SERVER_INFO, title: displayName };
  const instructions = `${projectInstructionLine(displayName)}\n\n${buildServerInstructions(toolPrefix)}`;
  const server = new McpServer(serverInfo, {
    capabilities: { tools: {} },
    instructions,
  });
  // read_log (Q87 / R137 #6 / T408) is BACKEND-AWARE: the FS store tails the
  // on-disk per-ledger log under <root>/.cq/logs, and the git-object backend
  // resolves the SAME `logs/<rel>` from the orphan ref tip (same confinement +
  // 4 MiB cap). So gate it on the duck-typed `readLog` capability (T357
  // precedent, mirroring `rootDirOf`) rather than `instanceof FsLedgerStore` —
  // read_log is wired for BOTH backends. An in-memory store (tests) exposes no
  // `readLog` and supplies none; read_log then throws the documented
  // not-implemented error.
  const readLog: ReadLogCapability | undefined = readLogOf(store);
  // cq.toml config + prompt-catalog capabilities (R193 / G18 / T2 / T343) are
  // ROOT-BOUND and BACKEND-INDEPENDENT: they read cq.toml / the role asset
  // markdown under the store's resolved root, which both FsLedgerStore and the
  // git-object backend expose via `rootDir`. So gate them on a duck-typed
  // root-dir capability (T357) rather than `instanceof FsLedgerStore`, making
  // config/promptCatalog available for BOTH backends. An in-memory store (tests)
  // exposes no `rootDir` and supplies neither; get_config / fetch_prompt then
  // throw the documented not-implemented error.
  const rootDir = rootDirOf(store);
  const configCapability: ConfigCapability | undefined =
    rootDir !== undefined ? createConfigCapability(rootDir) : undefined;
  const promptCatalog: PromptCatalogCapability | undefined =
    rootDir !== undefined ? createPromptCatalogCapability(rootDir) : undefined;
  registerLedgerStdioTools(server, store, readLog, configCapability, promptCatalog, toolPrefix);
  return server;
}

/**
 * Thin unprefixed wrapper over {@link createLedgerMcpServer} (G45 / Q209). Kept
 * BYTE-IDENTICAL in behaviour to its historical form for both call sites — the
 * stdio `main()` path and `attachMcpHttp` — so cq frontends/commands that rely
 * on the unprefixed 26-tool surface are unaffected.
 */
export function buildServer(store: LedgerStore, displayName: string): McpServer {
  return createLedgerMcpServer({ store, displayName });
}

/**
 * Construct and initialise the embedded store rooted at `cwd`, selecting the
 * backend from cq.toml's `[ledger]` table via {@link createLedgerStore} (T357).
 * The single place that builds the embedded store, shared by the standalone
 * binary and the in-process UIs (ledger-tui in-memory transport, ledger-web
 * co-hosted HTTP) so backend selection + init stay identical everywhere.
 *
 * Returns the full {@link ResolvedLedgerStore} (store + backend + branch) so the
 * host can select the matching coherence watcher via
 * {@link startLedgerCoherenceWatcher}. For `backend = 'fs'` (the default, and the
 * no-cq.toml case) the returned store is an `FsLedgerStore`, byte-identical to
 * the historical behaviour.
 */
export async function createEmbeddedStore(cwd: string): Promise<ResolvedLedgerStore> {
  return createLedgerStore(cwd);
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

export function attachMcpHttp(
  store: LedgerStore,
  displayName: string,
  toolPrefix = "",
): McpHttpHandlers {
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
    const server = createLedgerMcpServer({ store, displayName, toolPrefix });
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
  toolPrefix = "",
): ReturnType<typeof Bun.serve> {
  const { handle, onWsOpen, onWsMessage } = attachMcpHttp(store, displayName, toolPrefix);

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
 * `ledger-mcp restore --from-cache [--cwd <path>]` handler: restore
 * `<root>/.cq/` from the cache mirror via {@link restoreFromCache}, print a
 * per-ledger restored-file-count summary (ResetSummary style) to stdout, and
 * return an exit code. An absent/empty cache mirror throws
 * `CacheMirrorMissingError`, surfaced as a non-zero exit by the caller.
 */
export async function runRestore(args: RestoreArgs): Promise<void> {
  const summary = await restoreFromCache(args.cwd);
  process.stdout.write(`ledger-mcp restore: restored ledgers at ${summary.root}\n`);
  process.stdout.write(`  from cache: ${summary.cacheDir}\n`);
  for (const { name, fileCount } of summary.ledgers) {
    process.stdout.write(`  ${name}: ${fileCount} file(s) restored\n`);
  }
  process.stdout.write(`  total: ${summary.totalFiles} file(s) restored\n`);
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(TOP_LEVEL_USAGE + "\n");
    return;
  }

  // Positional-subcommand dispatch: the DEFAULT (no subcommand) launches the
  // server unchanged; the only recognised subcommand is `restore`.
  if (argv[0] === RESTORE_SUBCOMMAND) {
    await runRestore(parseRestoreArgs(argv.slice(1)));
    return;
  }

  const { cwd, http, toolPrefix } = parseArgs(argv);
  const displayName = path.basename(cwd);

  // Construct the store via the backend-selecting factory (T357), init it, then
  // register tools. The factory honours cq.toml's `[ledger]` backend: fs (the
  // default / no-cq.toml case) or git-object (after git-env fail-fast). If
  // construction/init fails we surface the error to stderr and exit non-zero —
  // the parent MCP client sees the channel close and treats the server as
  // unhealthy.
  const resolved = await createLedgerStore(cwd);
  const store = resolved.store;

  if (http !== null) {
    const server = serveHttp(store, http, displayName, toolPrefix);
    // Watch the ledger for out-of-process advances; push a `changed` frame to
    // subscribed UIs on any change. The watcher is selected by backend (file
    // watch for fs, orphan-ref-sha poll for git-object).
    const watcher = startLedgerCoherenceWatcher(resolved, cwd, (ledger) => {
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

  const server = createLedgerMcpServer({ store, displayName, toolPrefix });
  // Even on stdio, watch the ledger so this server's cache stays fresh when
  // another process writes the same ledgers (file watch for fs, ref-sha poll
  // for git-object).
  const watcher = startLedgerCoherenceWatcher(resolved, cwd);

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
