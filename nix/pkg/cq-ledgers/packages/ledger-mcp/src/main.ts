#!/usr/bin/env -S bun run
/**
 * ledger-mcp — standalone MCP server exposing the 29 ledger tools.
 *
 * This is the cq-free ledger MCP server: it serves the tool surface backed
 * by the store `createLedgerStore` resolves for the supplied `--cwd` directory
 * (the out-of-tree xdg `SqliteLedgerStore`, T530/T505), with NO dependency on
 * the cq server. It speaks two transports:
 *
 *   - stdio (default): JSON-RPC frames over stdin/stdout, for clients that
 *     spawn the server as a child process (Claude Code, Codex, etc.).
 *   - Streamable HTTP (`--http [host:]port`): the MCP Streamable HTTP
 *     transport over `Bun.serve`, for clients that connect to an
 *     already-running server (e.g. ledger-tui). Session-managed: each
 *     client initialize allocates a session bound to its own `McpServer`,
 *     all sharing the one store.
 *
 * CLI:
 *   ledger-mcp                                      # stdio; ledger root = $LEDGER_ROOT or CWD
 *   ledger-mcp --cwd <path>                         # stdio; explicit root (rel→resolved vs CWD)
 *   ledger-mcp --cwd <path> --http 7777             # HTTP on 127.0.0.1:7777
 *   ledger-mcp --http 0.0.0.0:7777                  # HTTP, root = CWD
 *   ledger-mcp --tool-prefix myproj                 # prefix all tool names with "myproj_"
 *   ledger-mcp --tool-prefix myproj --http 7777     # prefix + HTTP
 *   ledger-mcp --tool-profile implement-worker      # fail-closed role tool surface
 *
 * The ledger lifecycle ops (init, backup+reinit, erase, backup/restore,
 * migrate) live in the `cq` CLI.
 *
 * Ledger root precedence: --cwd > $LEDGER_ROOT > process CWD. Defaulting to the
 * CWD lets a single global install serve per-repo ledgers (the MCP client
 * spawns this server with the repo as its working directory).
 *
 * Output discipline (stdio mode). Stdout is reserved for MCP protocol
 * traffic only; all logs go to stderr.
 */

import * as path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startParentDeathWatcher, startStdinEndWatcher } from "./stdioProcessGuards.js";
import {
  type LedgerStore,
  type ReadLogCapability,
  type ConfigCapability,
  type DispatchCapability,
  type PromptCatalogCapability,
  type ListProjectsCapability,
  type ResolvedLedgerStore,
  type XdgCoherenceWatcher,
  createLedgerStore,
  resolveLedgerBackend,
  resolveProjectKey,
  RemoteLedgerClientNotWiredError,
  startXdgCoherenceWatcher,
  nodeGitRunner,
  createLedgerMcpToolSpecifications,
  FULL_LEDGER_TOOL_PROFILE,
  LEDGER_TOOL_NAMES,
  MANAGEMENT_LEDGER_TOOL_NAMES,
  ledgerToolNamesForProfile,
  registerLedgerStdioToolSpecifications,
  selectLedgerMcpToolSpecifications,
  ledgerToolListDefinitions,
  assertToolPrefix,
  prefixToolName,
  type LedgerToolName,
  type LedgerToolProfileName,
  type WorktreeManageCapability,
  createGitLegacyWorktreeActivityFence,
  createWorktreeManageCapability,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  isTrustedWorksetManagementAuthority,
  validateJsonl,
  bindWorksetInvocationAuthority,
  type WorksetInvocationAuthority,
  type ImplementationEvidenceService,
} from "@cq/ledger";
import { loadConfig, resolveRemoteLedgerTokenFromProcess } from "@cq/config";
import { z } from "zod";
import { createConfigCapability } from "./configCapability.js";
import { createProductionImplementationEvidenceService } from "./implementationEvidenceRuntime.js";

export { createProductionImplementationEvidenceService } from "./implementationEvidenceRuntime.js";
import { serveRemoteStdioProxy } from "./stdioRemoteProxy.js";
export { connectRemoteMcpProxy, serveRemoteStdioProxy } from "./stdioRemoteProxy.js";
export { computeConfig } from "./configCapability.js";
export {
  attachProjectAdminMcpHttp,
  createProjectAdminMcpServer,
  resolveAdminToken,
  PROJECT_ADMIN_TOOLS,
  HUB_ADMIN_TOKEN_ENV_VAR,
  REMOTE_ADMIN_TOKEN_ENV_VAR,
  MAX_ADMIN_DUMP_BYTES,
} from "./projectAdminMcp.js";
export type {
  ProjectAdminHandlers,
  ProjectAdminToolName,
  AttachProjectAdminMcpHttpOptions,
  ProjectAdminReconcileKind,
} from "./projectAdminMcp.js";
import { createSingleProjectDispatchRuntime, type DispatchRuntime } from "./dispatchCapability.js";
export {
  DISPATCH_RUNTIME_DEFERRAL_DISCHARGE,
  createDispatchCapability,
  createPostgresHubDispatchRuntime,
  createSingleProjectDispatchRuntime,
  refuseDispatchRuntime,
} from "./dispatchCapability.js";
export type {
  DispatchRuntime,
  PostgresHubDispatchRuntimeOptions,
  SingleProjectDispatchRuntimeOptions,
} from "./dispatchCapability.js";
export {
  captureCurrentDispatchRecoveryForProject,
  captureCurrentDispatchRecoverySeal,
  captureCurrentRecoverySeal,
  currentRecoveryTaskEvidence,
  readCurrentDispatchRecoveryStatus,
  readCurrentDispatchRecoveryStatusForProject,
} from "./dispatchRecoverySeal.js";
export type {
  CaptureCurrentDispatchRecoveryOptions,
  CurrentRecoveryCaptureCoordinates,
  CurrentRecoveryCaptureDeps,
  SingleProjectRecoverySealOptions,
} from "./dispatchRecoverySeal.js";
import {
  createLegacySourcePromptCatalogCapability,
  createPromptCatalogCapability,
} from "./promptCatalogCapability.js";
import type { PromptArtifactStore } from "./promptArtifactStore.js";
import {
  parsePromptSurface,
  resolvePromptSurface,
  type PromptSurface,
} from "./promptSurfaceSelection.js";
import { startLedgerWatcher, type LedgerWatcher } from "./watcher.js";
import { startLedgerRefWatcher } from "./refWatcher.js";

// Re-export so in-process hosts (ledger-tui embedded, ledger-web embedded) can
// wire live refresh against the same watcher the standalone binary uses.
export { startLedgerWatcher, type LedgerWatcher } from "./watcher.js";
export { startLedgerRefWatcher, type LedgerRefWatcher, REF_POLL_MS } from "./refWatcher.js";
export {
  FileSystemPromptArtifactStore,
  InMemoryPromptArtifactStore,
  PromptArtifactNotFoundError,
  PromptArtifactStoreError,
} from "./promptArtifactStore.js";
export {
  CQ_PROMPT_ROOT_ENV,
  CQ_PROMPT_SURFACE_ENV,
  CQ_PROMPT_SURFACES_ROOT_ENV,
  DEFAULT_PROMPT_SURFACE,
  parsePromptSurface,
  PROMPT_SURFACES,
  PromptSurfaceSelectionError,
  resolvePromptSurface,
} from "./promptSurfaceSelection.js";
export type {
  InMemoryPromptRoleArtifact,
  PromptArtifactManifest,
  PromptArtifactRoleKind,
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
  PromptRoleArtifact,
} from "./promptArtifactStore.js";
export type {
  PromptSurface,
  PromptSurfaceSelectionInput,
  ResolvedPromptSurface,
} from "./promptSurfaceSelection.js";

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
  /** Full compatibility surface or one fail-closed prompt-catalog role profile. */
  toolProfile: LedgerToolProfileName;
  promptSurface: PromptSurface | undefined;
  promptRoot: string | undefined;
  parentGateFinalize: boolean;
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
 * > process CWD`. A non-empty relative value resolves against the CWD.
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
  let toolProfile: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE;
  let promptSurface: PromptSurface | undefined;
  let promptRoot: string | undefined;
  let parentGateFinalize = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--parent-gate-finalize") {
      parentGateFinalize = true;
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
    } else if (a === "--tool-prefix") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --tool-prefix requires a value");
      }
      toolPrefix = v;
    } else if (a !== undefined && a.startsWith("--tool-prefix=")) {
      toolPrefix = a.slice("--tool-prefix=".length);
    } else if (a === "--tool-profile") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --tool-profile requires a value");
      }
      toolProfile = v;
    } else if (a !== undefined && a.startsWith("--tool-profile=")) {
      toolProfile = a.slice("--tool-profile=".length);
    } else if (a === "--prompt-surface") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --prompt-surface requires a value");
      }
      promptSurface = parsePromptSurface(v);
    } else if (a !== undefined && a.startsWith("--prompt-surface=")) {
      promptSurface = parsePromptSurface(a.slice("--prompt-surface=".length));
    } else if (a === "--prompt-root") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("ledger-mcp: --prompt-root requires a value");
      }
      promptRoot = path.resolve(v);
    } else if (a !== undefined && a.startsWith("--prompt-root=")) {
      promptRoot = path.resolve(a.slice("--prompt-root=".length));
    }
  }
  // Validate the prefix at parse time so a malformed value fails before the
  // server starts (fast-fail, per T379).
  assertToolPrefix(toolPrefix);
  // Resolve before constructing the store or transport. Unknown role names
  // cannot fall through to the compatibility surface.
  ledgerToolNamesForProfile(toolProfile);
  // Ledger root precedence: --cwd > $LEDGER_ROOT > process CWD; a relative
  // value resolves against the CWD. (See file header for the rationale.)
  return {
    cwd: resolveRoot(cwd),
    http,
    toolPrefix,
    toolProfile,
    promptSurface,
    promptRoot,
    parentGateFinalize,
  };
}

interface ParentGateFinalizeStdinRequest {
  readonly attestationId: string;
  readonly generation: number;
  readonly parentGateCapability: { readonly scope: "parent-gate"; readonly token: string };
}

const PARENT_GATE_REQUEST_MAX_BYTES = 16_384;

export async function readParentGateFinalizeRequest(
  input: NodeJS.ReadableStream,
): Promise<ParentGateFinalizeStdinRequest> {
  const text = await new Promise<string>((resolveInput, rejectInput) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffered.length + bytes.length > PARENT_GATE_REQUEST_MAX_BYTES) {
        cleanup();
        rejectInput(
          new Error(
            `ledger-mcp: parent gate request exceeds ${String(PARENT_GATE_REQUEST_MAX_BYTES)} bytes before completion`,
          ),
        );
        return;
      }
      buffered = Buffer.concat([buffered, bytes]);
    };
    const onEnd = (): void => {
      cleanup();
      resolveInput(buffered.toString("utf8"));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectInput(error);
    };
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
  if (
    Buffer.byteLength(text, "utf8") > PARENT_GATE_REQUEST_MAX_BYTES ||
    !text.endsWith("\n") ||
    text.indexOf("\n") !== text.length - 1
  ) {
    throw new Error(
      "ledger-mcp: parent gate request must be one bounded newline-terminated JSON value",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ledger-mcp: parent gate request must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ledger-mcp: parent gate request must be an object");
  }
  const request = parsed as Record<string, unknown>;
  const capability = request["parentGateCapability"] as Record<string, unknown> | undefined;
  if (
    Object.keys(request).sort().join(",") !== "attestationId,generation,parentGateCapability" ||
    typeof request["attestationId"] !== "string" ||
    !Number.isInteger(request["generation"]) ||
    capability === undefined ||
    Object.keys(capability).sort().join(",") !== "scope,token" ||
    capability["scope"] !== "parent-gate" ||
    typeof capability["token"] !== "string"
  ) {
    throw new Error("ledger-mcp: malformed parent gate request");
  }
  return request as unknown as ParentGateFinalizeStdinRequest;
}

/** Top-level CLI usage text (mirrors the file-header JSDoc; printed by --help/-h). */
export const TOP_LEVEL_USAGE = [
  "usage: ledger-mcp [options]                            # stdio MCP server",
  "",
  "options:",
  "  --cwd <path>          Ledger root (default: $LEDGER_ROOT or current working directory)",
  "  --http [host:]port    Serve Streamable HTTP instead of stdio (default host: 127.0.0.1)",
  '  --tool-prefix <p>     Prefix all tool names with "<p>_"',
  "  --tool-profile <role> Expose only the named role's ledger capability profile",
  "  --prompt-surface <s>  Select claude, codex, or pi (default: $CQ_PROMPT_SURFACE or claude)",
  "  --prompt-root <path>  Use an explicit built prompt-artifact root",
  "  -h, --help            Print this usage and exit",
].join("\n");

/**
 * Server-level usage guidance, surfaced to the client on `initialize` (the MCP
 * `instructions` field) so the model gets "when/how to use this server" without
 * per-project setup. Keep it short; per-repo policy belongs in the project's own
 * instructions (e.g. CLAUDE.md).
 */
const SERVER_INSTRUCTIONS_TEMPLATE = [
  "Typed milestone/item DAG. enumerate_ledgers schemas. Writes valid fields+author/session+canonical refs.",
  "Reads compact|complement|full; compact.fields ⊎ complement.fields = full.fields. fetch_ledger: paginate until nextOffset=null. fts_search defaults active+filters; terminal stays active until archive_terminal_items or archive_milestone.",
  "Plan/build: fts_search relevant active memories by ledger/status; fetch_item full matches. create_item only confirmed durable project facts in memories/M-AMBIENT with useful sourceRefs; exclude transient reasoning/session notes/unconfirmed preferences.",
  "Ideas omit milestone_id→M-AMBIENT; no work milestone/archive; ledgerRefs independent.",
  "CQ snapshot/derive_predicates; preserve IDs and dispatch/plan capability/generation/fence/recovery/idempotency.",
].join(" ");

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the server-level usage guidance, optionally renaming each referenced
 * ledger tool to its prefixed form (T377 / G45).
 *
 * `buildServerInstructions('')` for the full compatibility profile returns
 * {@link SERVER_INSTRUCTIONS_TEMPLATE} BYTE-IDENTICALLY. For a non-empty
 * prefix, every WHOLE-WORD occurrence of a registered full-profile tool name
 * is rewritten to `prefixToolName(prefix, name)`. Narrow role profiles receive
 * a generated inventory containing only their already-filtered tools.
 *
 * Drift-free by construction: the set of names rewritten is the live
 * {@link LEDGER_TOOL_NAMES}, and the prefixed form is derived via the shared
 * {@link prefixToolName} helper (Q208 — derive once + reuse), never a separate
 * hardcoded list. Names are replaced longest-first so a name that is a prefix
 * of another (e.g. `fetch_ledger` vs `fetch_ledger_archive`) cannot be
 * partially rewritten; `\b` boundaries (underscore is a word char) keep each
 * substitution to a whole token.
 */
export function buildServerInstructions(
  toolPrefix: string,
  profileName: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
  availableToolNames: readonly LedgerToolName[] = ledgerToolNamesForProfile(profileName),
): string {
  assertToolPrefix(toolPrefix);
  if (
    profileName === FULL_LEDGER_TOOL_PROFILE ||
    (availableToolNames.length === LEDGER_TOOL_NAMES.length &&
      LEDGER_TOOL_NAMES.every((name) => availableToolNames.includes(name))) ||
    (availableToolNames.length === MANAGEMENT_LEDGER_TOOL_NAMES.length &&
      MANAGEMENT_LEDGER_TOOL_NAMES.every((name) => availableToolNames.includes(name)))
  ) {
    if (toolPrefix === "") return SERVER_INSTRUCTIONS_TEMPLATE;
    const names = [...LEDGER_TOOL_NAMES].sort((a, b) => b.length - a.length);
    let text = SERVER_INSTRUCTIONS_TEMPLATE;
    for (const name of names) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
      text = text.replace(pattern, prefixToolName(toolPrefix, name));
    }
    return text;
  }

  const profileTools = availableToolNames.map((name) => prefixToolName(toolPrefix, name));
  if (profileTools.length === 0) {
    return `Ledger tool profile ${JSON.stringify(profileName)} exposes no tools.`;
  }
  return [
    `Ledger tool profile ${JSON.stringify(profileName)} exposes only:`,
    ...profileTools.map((name) => `- ${name}`),
  ].join("\n");
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
 * Build a fresh McpServer with the 29 ledger tools bound to
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
 *
 * D93: the xdg `SqliteLedgerStore` exposes NO `rootDir` — its data lives
 * out-of-tree, entirely independent of the cq.toml config root — so this
 * duck-type alone under-detects the capability for xdg. Callers that hold the
 * {@link ResolvedLedgerStore} from `createLedgerStore` should prefer its
 * `configRoot` (the actual cq.toml root) over this function; `rootDirOf`
 * remains the fallback for call sites (tests, mainly) that construct a store
 * directly and have no `ResolvedLedgerStore` to hand.
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
const MAX_PUT_LOG_BYTES = 4 * 1024 * 1024;

function putLogOf(
  store: LedgerStore,
): ((relPath: string, content: string) => Promise<void>) | undefined {
  const candidate = (store as { putLog?: unknown }).putLog;
  if (typeof candidate !== "function") return undefined;
  const fn = candidate as (relPath: string, content: string) => Promise<void>;
  return (relPath, content) => fn.call(store, relPath, content);
}

function registerOrdinaryPutLog(server: McpServer, store: LedgerStore, toolPrefix: string): void {
  const putLog = putLogOf(store);
  if (putLog === undefined) {
    throw new Error("enableLogWrite requires a store that implements putLog");
  }
  const name = prefixToolName(toolPrefix, "put_log");
  server.registerTool(
    name,
    {
      description:
        "Upload one log artifact. Ordinary bearer only. Path must stay under logs/; JSONL is re-validated.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
      },
    },
    async ({ path: relPath, content }) => {
      if (Buffer.byteLength(content, "utf8") > MAX_PUT_LOG_BYTES) {
        throw new Error(`put_log: content exceeds ${String(MAX_PUT_LOG_BYTES)} bytes`);
      }
      const normalized = relPath.replace(/^logs\//, "");
      if (
        normalized.trim() === "" ||
        normalized.startsWith("/") ||
        normalized.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new Error(`put_log: path escapes logs root: ${relPath}`);
      }
      if (normalized.endsWith(".jsonl")) {
        const validation = validateJsonl(content);
        if (!validation.ok) {
          throw new Error(
            `put_log: malformed JSONL at line ${String(validation.line)}: ${validation.reason}`,
          );
        }
      }
      await putLog(normalized, content);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ path: normalized, stored: true }) },
        ],
      };
    },
  );
}

export function readLogOf(store: LedgerStore): ReadLogCapability | undefined {
  const candidate = (store as { readLog?: unknown }).readLog;
  if (typeof candidate !== "function") return undefined;
  const fn = candidate as ReadLogCapability;
  return (relPath) => fn.call(store, relPath);
}

/**
 * Build the ALWAYS-DEFINED `list_projects` capability (T585 / Q284): the
 * store's own genuine multi-tenant `listProjects()` when it advertises one
 * (duck-typed exactly like {@link readLogOf} — PostgresLedgerStore is the
 * only implementor today), else a closure synthesizing the single-project
 * fallback entry from `fallback` (this server's own resolved projectKey +
 * display name). Unlike `readLogOf`, this NEVER returns `undefined` — every
 * server built through {@link createLedgerMcpServer} answers `list_projects`,
 * so frontends never need to sniff the backend (Q284).
 */
export function listProjectsOf(
  store: LedgerStore,
  fallback: { key: string; displayName: string },
): ListProjectsCapability {
  const candidate = (store as { listProjects?: unknown }).listProjects;
  if (typeof candidate === "function") {
    const fn = candidate as ListProjectsCapability;
    return () => fn.call(store);
  }
  return () => ({ projects: [fallback] });
}

/**
 * Start the per-backend coherence watcher for a resolved store (T357 item 5;
 * xdg case wired in T500): file-watch ({@link startLedgerWatcher}) for the fs
 * backend, ref-sha-watch ({@link startLedgerRefWatcher}, T353) for git-object,
 * domain-state-version poll ({@link startXdgCoherenceWatcher}) for xdg.
 * Public postgres is retired (T736). Remote launches do not watch a local store.
 * Local watchers return a handle with `.close()`, so the host wires shutdown
 * identically regardless of backend.
 * The git-object path binds a {@link nodeGitRunner} at the repo root so the
 * watcher polls `refs/heads/<branch>` for ledger advances by another process.
 *
 * The xdg watcher bulk-invalidates every known ledger off a content-version
 * bump, so its `onChange` (D89) fires once per invalidate pass with `null`
 * rather than once per ledger id — `onChange` is forwarded here exactly as
 * for the other backends, driving the same WS "changed" push for a peer
 * process's write. Public postgres is retired; hub live frames come from
 * in-process `onMutation` (T726/T736).
 */
export function startLedgerCoherenceWatcher(
  resolved: ResolvedLedgerStore,
  root: string,
  onChange?: (ledgerId: string | null) => void,
): LedgerWatcher | XdgCoherenceWatcher {
  if (resolved.backend === "remote") {
    throw new RemoteLedgerClientNotWiredError("startLedgerCoherenceWatcher", root);
  }
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
    return startXdgCoherenceWatcher(resolved.store, resolved.dbPath, undefined, onChange);
  }
  return startLedgerWatcher(resolved.store, root, onChange);
}

/**
 * Options for {@link createLedgerMcpServer}, the public builder for an
 * `McpServer` bound to one `store` (G45 / Q209).
 *
 * `toolPrefix` is OPTIONAL and defaults to `''`. `toolProfile` defaults to the
 * full compatibility surface; a role id selects its T1325 capability subset.
 * Durable dispatch availability is intersected before that profile. A
 * non-empty prefix renames every registered tool to its
 * `prefixToolName(prefix, name)` form and rewrites the matching tool names in
 * the server-level `instructions`.
 */
export interface CreateLedgerMcpServerOptions {
  /** The ledger store the tools are bound to. */
  store: LedgerStore;
  /** Project display name carried on `serverInfo.title` + the instructions line. */
  displayName: string;
  /** Optional ledger-tool name prefix (default `''` = unprefixed). */
  toolPrefix?: string;
  /** `full` compatibility surface or a fail-closed T1325 prompt-catalog role id. */
  toolProfile?: LedgerToolProfileName;
  /**
   * The cq.toml CONFIG ROOT (D93) — `ResolvedLedgerStore.configRoot` from
   * `createLedgerStore`. Takes precedence over the duck-typed `rootDirOf(store)`
   * so config/prompt-catalog capability is wired for the xdg backend too, whose
   * store carries no `rootDir` of its own. Omit only when no
   * `ResolvedLedgerStore` is available (falls back to `rootDirOf(store)`).
   */
  configRoot?: string;
  /**
   * An already-built prompt surface. When supplied, prompt-catalog tools read
   * this store directly and do not discover source assets beneath configRoot.
   */
  promptArtifactStore?: PromptArtifactStore;
  /**
   * This server's resolved `projectKey` (T585 / Q284) — `ResolvedLedgerStore.
   * projectKey` from `createLedgerStore`. Feeds the single-project
   * `list_projects` fallback (`listProjectsOf`) when `store` is not itself
   * multi-tenant. Omitted, the fallback keys off `displayName` instead (the
   * honest minimal for a caller with no `ResolvedLedgerStore` at hand, e.g. a
   * test constructing a server directly over an in-memory store).
   */
  projectKey?: string;
  /**
   * Optional shared project-registry capability. Multi-project hosts inject
   * this so every project-bound session sees the same whole-host registry.
   * Omitted, {@link listProjectsOf} preserves the store-native or synthesized
   * single-project fallback.
   */
  listProjects?: ListProjectsCapability;
  /** Durable, server-scoped dispatch lifecycle capability. */
  dispatchCapability?: DispatchCapability;
  /**
   * Managed-worktree lifecycle capability (T1306). When omitted, the server
   * synthesises one from `repositoryRoot` when that is set; otherwise
   * `worktree_manage` throws WorktreeManageNotImplementedError on invoke.
   */
  worktreeManage?: WorktreeManageCapability;
  /**
   * Git repository root used to wire the default `worktree_manage` capability
   * when `worktreeManage` is omitted. Production hosts pass the same cwd used
   * to open the ledger store.
   */
  repositoryRoot?: string;
  /** Runtime-only workset authority; never serialized into tool schemas. */
  worksetAuthority?: WorksetInvocationAuthority;
  /**
   * T741 — register ordinary `put_log` when the store can persist artifacts.
   * Off by default so the T1326 tools/list inventory does not grow.
   */
  enableLogWrite?: boolean;
  /** Protected implementation review/completion evidence service. */
  implementationEvidence?: ImplementationEvidenceService;
}

/**
 * Public builder: construct an `McpServer` exposing the ledger tool surface for
 * `store`, optionally renamed under `toolPrefix` (G45 / Q209). This is the
 * single factory both the standalone stdio host and `attachMcpHttp` route
 * through; {@link buildServer} is a thin unprefixed wrapper over it.
 *
 * With `toolProfile` omitted and `toolPrefix` omitted or `''`, behaviour is
 * BYTE-IDENTICAL to the historical `buildServer` (serverInfo, instructions,
 * definitions, handlers, and capability gating). Named profiles filter the
 * canonical specifications before registration and instruction generation.
 */
export function createLedgerMcpServer(opts: CreateLedgerMcpServerOptions): McpServer {
  const { store, displayName } = opts;
  const configRoot = opts.configRoot;
  const toolPrefix = opts.toolPrefix ?? "";
  const toolProfile = opts.toolProfile ?? FULL_LEDGER_TOOL_PROFILE;
  assertToolPrefix(toolPrefix);
  // Resolve before constructing the server so unknown profiles fail before any
  // `tools/list` serializer or transport can observe a partial surface.
  ledgerToolNamesForProfile(toolProfile);
  // read_log (Q87 / R137 #6 / T408) is BACKEND-AWARE: the FS store tails the
  // on-disk per-ledger log under <root>/.cq/logs, and the git-object backend
  // resolves the SAME `logs/<rel>` from the orphan ref tip (same confinement +
  // 4 MiB cap). So gate it on the duck-typed `readLog` capability (T357
  // precedent, mirroring `rootDirOf`) rather than `instanceof FsLedgerStore` —
  // read_log is wired for BOTH backends. An in-memory store (tests) exposes no
  // `readLog` and supplies none; read_log then throws the documented
  // not-implemented error.
  const readLog: ReadLogCapability | undefined = readLogOf(store);
  // cq.toml config remains root-bound and backend-independent. Prompt-catalog
  // tools prefer an injected, already-built artifact store; the source-backed
  // root path remains the compatibility fallback until all launchers inject a
  // packaged surface. An in-memory ledger store with neither dependency leaves
  // those capabilities unwired and produces the documented not-implemented
  // errors.
  const rootDir = configRoot ?? rootDirOf(store);
  const configCapability: ConfigCapability | undefined =
    rootDir !== undefined ? createConfigCapability(rootDir) : undefined;
  const promptCatalog: PromptCatalogCapability | undefined =
    opts.promptArtifactStore !== undefined
      ? createPromptCatalogCapability(opts.promptArtifactStore)
      : rootDir !== undefined
        ? createLegacySourcePromptCatalogCapability(rootDir)
        : undefined;
  // list_projects (T585 / Q284): ALWAYS wired, never left undefined — see
  // listProjectsOf's doc. The single-project fallback key defaults to
  // `displayName` when the caller has no resolved `projectKey` at hand.
  const listProjects: ListProjectsCapability =
    opts.listProjects ??
    listProjectsOf(store, {
      key: opts.projectKey ?? displayName,
      displayName,
    });
  const worktreeManage: WorktreeManageCapability | undefined =
    opts.worktreeManage ??
    (opts.repositoryRoot !== undefined
      ? createWorktreeManageCapability(opts.repositoryRoot, {
          ...(opts.dispatchCapability?.resolveRecovery === undefined
            ? {}
            : { resolveDispatchRecovery: opts.dispatchCapability.resolveRecovery }),
          ...(opts.dispatchCapability?.resolveContinuation === undefined
            ? {}
            : { resolveDispatchContinuation: opts.dispatchCapability.resolveContinuation }),
          deps: {
            adoptionActivityFence: createGitLegacyWorktreeActivityFence(
              opts.dispatchCapability?.observeWorktreeActivity,
            ),
          },
        })
      : undefined);
  const specifications = selectLedgerMcpToolSpecifications(
    createLedgerMcpToolSpecifications(
      store,
      readLog,
      configCapability,
      promptCatalog,
      listProjects,
      opts.dispatchCapability,
      worktreeManage,
      opts.worksetAuthority ?? createObserveOnlyWorksetInvocationAuthority(),
      opts.implementationEvidence,
      isTrustedWorksetManagementAuthority(opts.worksetAuthority),
    ),
    toolProfile,
  );
  const serverInfo = { ...SERVER_INFO, title: displayName };
  const instructions = `${projectInstructionLine(displayName)}\n\n${buildServerInstructions(
    toolPrefix,
    toolProfile,
    specifications.map((specification) => specification.name),
  )}`;
  const server = new McpServer(serverInfo, {
    capabilities: { tools: {} },
    instructions,
  });
  registerLedgerStdioToolSpecifications(server, specifications, toolPrefix);
  if (opts.enableLogWrite === true) {
    registerOrdinaryPutLog(server, store, toolPrefix);
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...ledgerToolListDefinitions(specifications, toolPrefix),
        {
          name: prefixToolName(toolPrefix, "put_log"),
          description:
            "Upload one log artifact. Ordinary bearer only. Path must stay under logs/; JSONL is re-validated.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ],
    }));
  }
  return bindWorksetInvocationAuthority(
    server,
    opts.worksetAuthority ?? createObserveOnlyWorksetInvocationAuthority(),
  );
}

/** Dedicated trusted-host constructor for direct or stdio management surfaces. */
export function createManagementLedgerMcpServer(
  opts: Omit<CreateLedgerMcpServerOptions, "worksetAuthority">,
): McpServer {
  return createLedgerMcpServer({
    ...opts,
    worksetAuthority: createTrustedWorksetManagementAuthority(),
  });
}

/**
 * Thin unprefixed wrapper over {@link createLedgerMcpServer} (G45 / Q209). Kept
 * BYTE-IDENTICAL in behaviour to its historical form for both call sites — the
 * stdio `main()` path and `attachMcpHttp`.
 */
export function buildServer(
  store: LedgerStore,
  displayName: string,
  configRoot?: string,
  projectKey?: string,
  promptArtifactStore?: PromptArtifactStore,
  dispatchCapability?: DispatchCapability,
  repositoryRoot?: string,
  implementationEvidence?: ImplementationEvidenceService,
): McpServer {
  return createLedgerMcpServer({
    store,
    displayName,
    ...(configRoot !== undefined ? { configRoot } : {}),
    ...(projectKey !== undefined ? { projectKey } : {}),
    ...(promptArtifactStore !== undefined ? { promptArtifactStore } : {}),
    ...(dispatchCapability !== undefined ? { dispatchCapability } : {}),
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    ...(implementationEvidence !== undefined ? { implementationEvidence } : {}),
  });
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
 * {@link startLedgerCoherenceWatcher}.
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

export interface McpHttpCredentialConfig {
  /** Ordinary credential, or null for backward-compatible open loopback. */
  readonly ordinaryToken: string | null;
  /** Distinct management credential; null disables HTTP management. */
  readonly managementToken: string | null;
}

export class McpHttpCredentialSeparationError extends Error {
  constructor() {
    super("MCP management credential must differ from the ordinary credential");
    this.name = "McpHttpCredentialSeparationError";
  }
}

function assertMcpHttpCredentialSeparation(credentials: McpHttpCredentialConfig | undefined): void {
  if (
    credentials?.ordinaryToken !== null &&
    credentials?.ordinaryToken !== undefined &&
    credentials.managementToken !== null &&
    worksetCredentialsMatch(credentials.ordinaryToken, credentials.managementToken)
  ) {
    throw new McpHttpCredentialSeparationError();
  }
}

export type McpSessionScope = "observe" | "management";

interface McpSessionBinding {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly scope: McpSessionScope;
}

function extractBearerCredential(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1] ?? null;
}

/** Constant-time credential comparison over fixed-size SHA-256 digests. */
export function worksetCredentialsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function resolveInitialSessionScope(
  req: Request,
  credentials: McpHttpCredentialConfig | undefined,
  defaultScope: McpSessionScope,
): McpSessionScope | null {
  if (credentials === undefined) return defaultScope;
  const provided = extractBearerCredential(req);
  if (
    provided !== null &&
    credentials.managementToken !== null &&
    worksetCredentialsMatch(provided, credentials.managementToken)
  ) {
    return "management";
  }
  if (credentials.ordinaryToken === null) {
    return provided === null ? "observe" : null;
  }
  return provided !== null && worksetCredentialsMatch(provided, credentials.ordinaryToken)
    ? "observe"
    : null;
}

function sessionCredentialMatches(
  req: Request,
  binding: McpSessionBinding,
  credentials: McpHttpCredentialConfig | undefined,
): boolean {
  if (credentials === undefined) return true;
  const expected =
    binding.scope === "management" ? credentials.managementToken : credentials.ordinaryToken;
  const provided = extractBearerCredential(req);
  if (expected === null) return provided === null;
  return provided !== null && worksetCredentialsMatch(provided, expected);
}

function sessionUnauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

export type McpSessionDisplayName = string | ((req: Request) => Promise<string> | string);

export function attachMcpHttp(
  store: LedgerStore,
  displayName: McpSessionDisplayName,
  toolPrefix = "",
  configRoot?: string,
  projectKey?: string,
  promptArtifactStore?: PromptArtifactStore,
  listProjects?: ListProjectsCapability,
  dispatchCapability?: DispatchCapability,
  toolProfile: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
  repositoryRoot?: string,
  credentials?: McpHttpCredentialConfig,
  trustedDefaultScope: McpSessionScope = "observe",
  enableLogWrite = false,
  implementationEvidence?: ImplementationEvidenceService,
): McpHttpHandlers {
  assertMcpHttpCredentialSeparation(credentials);
  const sessions = new Map<string, McpSessionBinding>();

  async function handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined;
    const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      if (!sessionCredentialMatches(req, existing, credentials)) {
        return sessionUnauthorized();
      }
      return existing.transport.handleRequest(req);
    }
    if (sessionId !== undefined) {
      return new Response("invalid or expired MCP session", { status: 400 });
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

    const scope = resolveInitialSessionScope(req, credentials, trustedDefaultScope);
    if (scope === null) return sessionUnauthorized();

    const sessionDisplayName =
      typeof displayName === "string" ? displayName : await displayName(req);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, scope });
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });
    const server = createLedgerMcpServer({
      store,
      displayName: sessionDisplayName,
      toolPrefix,
      ...(configRoot !== undefined ? { configRoot } : {}),
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(promptArtifactStore !== undefined ? { promptArtifactStore } : {}),
      ...(listProjects !== undefined ? { listProjects } : {}),
      ...(dispatchCapability !== undefined ? { dispatchCapability } : {}),
      ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
      worksetAuthority:
        scope === "management"
          ? createTrustedWorksetManagementAuthority()
          : createObserveOnlyWorksetInvocationAuthority(),
      toolProfile,
      ...(enableLogWrite ? { enableLogWrite: true } : {}),
      ...(implementationEvidence !== undefined ? { implementationEvidence } : {}),
    });
    await server.connect(transport);
    // Body already consumed above; hand it back so the transport doesn't
    // re-read the (now-empty) request stream.
    return transport.handleRequest(req, { parsedBody: body });
  }

  function onWsOpen(ws: ServerWebSocket<undefined>): void {
    ws.subscribe(LEDGER_TOPIC); // receives every published `changed` event
  }

  function onWsMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer): void {
    wsHeartbeat((s) => ws.send(s), raw);
  }

  return { handle, onWsOpen, onWsMessage };
}

/**
 * App-level WebSocket heartbeat (resilient-ws-ui R3): on a `{type:"ping"}`
 * frame, echo a `{type:"pong"}` carrying the client's `nonce`/`ts` plus a
 * `serverTs`, so the client can measure RTT and detect a dead connection. A
 * non-JSON or non-ping frame is ignored. `send` is injected (rather than a
 * concrete `ServerWebSocket`) so both `attachMcpHttp`'s single-project socket
 * and the `cq serve` hub's per-project socket (whose Bun.serve `data` type
 * differs — it carries the projectKey) share ONE protocol implementation with
 * no drift.
 */
export function wsHeartbeat(send: (frame: string) => void, raw: string | Buffer): void {
  let msg: { type?: string; nonce?: string; ts?: number } | undefined;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
  } catch {
    return;
  }
  if (msg?.type === "ping") {
    send(JSON.stringify({ type: "pong", nonce: msg.nonce, ts: msg.ts, serverTs: Date.now() }));
  }
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
  configRoot?: string,
  projectKey?: string,
  promptArtifactStore?: PromptArtifactStore,
  dispatchCapability?: DispatchCapability,
  toolProfile: LedgerToolProfileName = FULL_LEDGER_TOOL_PROFILE,
  repositoryRoot?: string,
  implementationEvidence?: ImplementationEvidenceService,
): ReturnType<typeof Bun.serve> {
  const { handle, onWsOpen, onWsMessage } = attachMcpHttp(
    store,
    displayName,
    toolPrefix,
    configRoot,
    projectKey,
    promptArtifactStore,
    undefined,
    dispatchCapability,
    toolProfile,
    repositoryRoot,
    undefined,
    "observe",
    false,
    implementationEvidence,
  );

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
  return JSON.stringify(
    ledgerId !== null ? { type: "changed", ledger: ledgerId } : { type: "changed" },
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(TOP_LEVEL_USAGE + "\n");
    return;
  }

  const { cwd, http, toolPrefix, toolProfile, promptSurface, promptRoot, parentGateFinalize } =
    parseArgs(argv);
  const displayName = path.basename(cwd);
  const resolvedPromptSurface = resolvePromptSurface({
    promptSurface,
    promptRoot,
    environment: process.env,
  });

  if (resolveLedgerBackend(cwd).backend === "remote") {
    if (http !== null) {
      throw new Error(
        "ledger-mcp: backend=remote does not serve local HTTP; connect clients to cq serve",
      );
    }
    const config = loadConfig(cwd);
    if (config?.ledger?.backend !== "remote" || config.ledger.serverUrl === null) {
      throw new Error("ledger-mcp: backend=remote requires [ledger].serverUrl");
    }
    const projectKey = await resolveProjectKey({
      repoRoot: cwd,
      projectId: config.ledger.projectId,
    });
    await serveRemoteStdioProxy({
      serverUrl: config.ledger.serverUrl,
      projectKey,
      token: resolveRemoteLedgerTokenFromProcess(),
      displayName,
    });
    return;
  }

  // Construct the store via the backend-selecting factory (T357), init it, then
  // register tools. The factory honours cq.toml's `[ledger]` backend ('xdg'
  // is the K117 default; an explicit legacy fs/git-object opens with a
  // deprecation warning naming `cq migrate`). If construction/init fails we
  // surface the error to stderr and exit non-zero — the parent MCP client
  // sees the channel close and treats the server as unhealthy.
  const resolved = await createLedgerStore(cwd);
  const store = resolved.store;
  const dispatchRuntime: DispatchRuntime = await createSingleProjectDispatchRuntime({
    construction: http === null ? "stdio" : "http-single-project",
    resolved,
    ...(resolvedPromptSurface === undefined
      ? {}
      : { promptArtifactStore: resolvedPromptSurface.store }),
    environment: process.env,
  });
  const dispatchCapability =
    dispatchRuntime.kind === "available" ? dispatchRuntime.capability : undefined;
  const implementationEvidence =
    dispatchCapability !== undefined && resolved.implementationEvidenceStore !== undefined
      ? createProductionImplementationEvidenceService({
          resolved,
          dispatchCapability,
          repositoryRoot: cwd,
        })
      : undefined;

  if (parentGateFinalize) {
    try {
      if (http !== null || dispatchCapability?.finalizeParentGate === undefined) {
        throw new Error(
          "ledger-mcp: parent gate finalization requires a local durable dispatch runtime",
        );
      }
      const outcome = await dispatchCapability.finalizeParentGate(
        await readParentGateFinalizeRequest(process.stdin),
      );
      if (outcome.state !== "result-stored") {
        throw new Error(`ledger-mcp: parent gate finalized as ${outcome.state}`);
      }
      process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    } finally {
      resolved.backup?.close();
      await dispatchRuntime.close();
      await store.dispose();
    }
    return;
  }

  if (http !== null) {
    const server = serveHttp(
      store,
      http,
      displayName,
      toolPrefix,
      resolved.configRoot,
      resolved.projectKey,
      resolvedPromptSurface?.store,
      dispatchCapability,
      toolProfile,
      cwd,
      implementationEvidence,
    );
    // Watch the ledger for out-of-process advances; push a `changed` frame to
    // subscribed UIs on any change. The watcher is selected by backend (file
    // watch for fs, orphan-ref-sha poll for git-object).
    const watcher = startLedgerCoherenceWatcher(resolved, cwd, (ledger) => {
      server.publish(LEDGER_TOPIC, changedFrame(ledger));
    });
    const shutdown = (): void => {
      watcher.close();
      void (async () => {
        await server.stop(true);
        await dispatchRuntime.close();
        process.exit(0);
      })();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.stderr.write(
      `ledger-mcp: serving Streamable HTTP on http://${http.host}:${http.port}${MCP_HTTP_PATH} (cwd=${cwd})\n`,
    );
    return;
  }

  const server = createLedgerMcpServer({
    store,
    displayName,
    toolPrefix,
    configRoot: resolved.configRoot,
    ...(resolved.projectKey !== undefined ? { projectKey: resolved.projectKey } : {}),
    ...(resolvedPromptSurface !== undefined
      ? { promptArtifactStore: resolvedPromptSurface.store }
      : {}),
    ...(dispatchCapability === undefined ? {} : { dispatchCapability }),
    repositoryRoot: cwd,
    toolProfile,
    ...(implementationEvidence === undefined ? {} : { implementationEvidence }),
  });
  // Even on stdio, watch the ledger so this server's cache stays fresh when
  // another process writes the same ledgers (file watch for fs, ref-sha poll
  // for git-object).
  const watcher = startLedgerCoherenceWatcher(resolved, cwd);

  // Graceful shutdown on SIGTERM / SIGINT / parent death / stdin end (T2019).
  let stopParentWatch: () => void = () => {};
  let stopStdinWatch: () => void = () => {};
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentWatch();
    stopStdinWatch();
    watcher.close();
    void dispatchRuntime.close().finally(() => process.exit(0));
  };
  stopParentWatch = startParentDeathWatcher(() => {
    process.stderr.write("ledger-mcp: parent process gone — exiting (D293/T2019 orphan reaper)\n");
    shutdown();
  });
  stopStdinWatch = startStdinEndWatcher(() => {
    process.stderr.write("ledger-mcp: stdin closed — exiting\n");
    shutdown();
  });
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
