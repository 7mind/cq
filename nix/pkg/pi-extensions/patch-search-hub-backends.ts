import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// patch-search-hub-backends.ts
//
// Defect (pi-search-hub): the `web_search` tool advertises a STATIC list of
// all backends (19 as of v2.8.0) in both its `description` and its `backend`
// parameter enum (search-hub.ts registers them hardcoded), regardless of which
// backends are actually enabled in search.json. So the model believes it may request, e.g.,
// `backend: "tavily"` when tavily is unconfigured — those calls then fail, and
// it cannot tell the configured set from the tool definition alone. Bug report:
// docs/drafts/20260608-1016-pi-search-hub-static-backend-list-bug-report.md.
//
// This patch rewrites the `web_search` tool definition in each outgoing
// provider request (before_provider_request — the same hook the grok
// drop-client-web-search patch uses) so the `description` and the `backend`
// enum list ONLY the backends that are actually active per the live config.
//
// The active set is resolved at RUNTIME, not baked at build time (repo decision
// K46: standalone store-path extensions read their config at runtime so edits
// take effect without a rebuild). Resolution mirrors pi-search-hub's own
// loadConfig/refreshConfig (config.ts): global
// ~/.pi/agent/extensions/search.json + project <cwd>/.pi/search.json (deep
// per-backend merge), plus the SEARCH_*_API_KEY env-fallback auto-enable; empty
// => ["duckduckgo"]. Re-read at most every CONFIG_TTL_MS (pi-search-hub uses 10s).
//
// NOT touched: promptSnippet/promptGuidelines (injected into the system prompt
// at registration, absent from the provider payload). The `backend` enum is the
// authoritative value set the model selects from, so trimming it is the fix.

const WEB_SEARCH_TOOL_NAME = "web_search";
const AUTO_BACKEND = "auto";
const CONFIG_TTL_MS = 10_000;
const DEFAULT_BACKEND = "duckduckgo";

// Mirror of pi-search-hub credentials.ts FALLBACK_ENV_MAP (backend -> env var
// whose presence auto-enables that backend). Keep in lockstep with upstream —
// the npm: package in nix/hm/pi.nix is pinned to the mirrored version (2.8.0);
// bump both together.
const FALLBACK_ENV_MAP: Record<string, string> = {
  jina: "SEARCH_JINA_API_KEY",
  serper: "SEARCH_SERPER_API_KEY",
  tavily: "SEARCH_TAVILY_API_KEY",
  exa: "SEARCH_EXA_API_KEY",
  brave: "SEARCH_BRAVE_API_KEY",
  "brave-llm": "SEARCH_BRAVE_API_KEY",
  langsearch: "SEARCH_LANGSEARCH_API_KEY",
  firecrawl: "SEARCH_FIRECRAWL_API_KEY",
  websearchapi: "SEARCH_WEBSEARCHAPI_API_KEY",
  perplexity: "SEARCH_PERPLEXITY_API_KEY",
  sofya: "SEARCH_SOFYA_API_KEY",
  youcom: "SEARCH_YOUCOM_API_KEY",
  linkup: "SEARCH_LINKUP_API_KEY",
  fastcrw: "SEARCH_FASTCRW_API_KEY",
};

interface BackendCfg {
  enabled?: boolean;
  [k: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBackends(path: string): Record<string, BackendCfg> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (isRecord(parsed) && isRecord(parsed.backends)) {
      return parsed.backends as Record<string, BackendCfg>;
    }
  } catch {
    // malformed config — ignore, same as pi-search-hub's loadConfig
  }
  return undefined;
}

function computeActiveBackends(cwd: string): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const backends: Record<string, BackendCfg> = {
    ...readBackends(join(home, ".pi", "agent", "extensions", "search.json")),
  };

  // Project config wins via per-backend deep merge.
  const projectBackends = readBackends(join(cwd, ".pi", "search.json"));
  if (projectBackends) {
    for (const [name, cfg] of Object.entries(projectBackends)) {
      backends[name] = backends[name] ? { ...backends[name], ...cfg } : cfg;
    }
  }

  // Env-fallback auto-enable: only when the backend is not explicitly configured.
  for (const [backend, envVar] of Object.entries(FALLBACK_ENV_MAP)) {
    const value = process.env[envVar];
    if (value && value.trim().length > 0) {
      const existing = backends[backend];
      if (!existing || existing.enabled === undefined) {
        backends[backend] = { ...existing, enabled: true };
      }
    }
  }

  const active = Object.entries(backends)
    .filter(([, cfg]) => cfg?.enabled)
    .map(([name]) => name);
  return active.length > 0 ? active : [DEFAULT_BACKEND];
}

let cachedActive: string[] = [];
let cachedAt = 0;
let cachedCwd = "";

function activeBackends(cwd: string): string[] {
  const now = Date.now();
  if (cwd === cachedCwd && cachedActive.length > 0 && now - cachedAt < CONFIG_TTL_MS) {
    return cachedActive;
  }
  cachedActive = computeActiveBackends(cwd);
  cachedAt = now;
  cachedCwd = cwd;
  return cachedActive;
}

function buildDescription(active: string[]): string {
  return (
    `Search the web. Backends configured in this harness: ${active.join(", ")}. ` +
    "backend='auto' (default) uses the best configured backend with fallback. " +
    "Use combine=true to query all configured backends in parallel and merge results. " +
    "Use for fact-finding, research, documentation lookups, and current events."
  );
}

// Tool objects in the provider payload come in three shapes depending on the
// provider: { name, description, input_schema } (Anthropic),
// { type:"function", name, description, parameters } (OpenAI Responses), and
// { type:"function", function:{ name, description, parameters } } (OpenAI Chat).
// holderOf returns whichever object carries name/description/schema.
function holderOf(tool: Record<string, unknown>): Record<string, unknown> {
  return isRecord(tool.function) ? tool.function : tool;
}

function schemaOf(holder: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(holder.input_schema)) return holder.input_schema;
  if (isRecord(holder.parameters)) return holder.parameters;
  return undefined;
}

function rewriteWebSearch(tool: Record<string, unknown>, active: string[]): void {
  const holder = holderOf(tool);
  if (holder.name !== WEB_SEARCH_TOOL_NAME) return;

  holder.description = buildDescription(active);

  const schema = schemaOf(holder);
  if (!schema || !isRecord(schema.properties)) return;
  const backend = (schema.properties as Record<string, unknown>).backend;
  if (!isRecord(backend)) return;

  if (Array.isArray(backend.enum)) {
    backend.enum = [...active, AUTO_BACKEND];
  }
  if (typeof backend.description === "string") {
    backend.description =
      "Backend to use; only configured backends are available. " +
      "'auto' (default) picks the best configured backend.";
  }
}

export default function patchSearchHubBackends(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => {
    const payload = (event as { payload?: unknown }).payload;
    if (!isRecord(payload)) return;

    const tools = payload.tools;
    if (!Array.isArray(tools)) return;

    const active = activeBackends(process.cwd());
    for (const tool of tools) {
      if (isRecord(tool)) rewriteWebSearch(tool, active);
    }
  });
}
