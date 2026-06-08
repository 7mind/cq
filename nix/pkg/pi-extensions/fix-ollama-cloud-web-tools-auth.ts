import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { AuthStorage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// pi-ollama-cloud (npm, 0.6.0) registers `ollama_web_search` / `ollama_web_fetch`
// whose key resolution is broken (web-tools.ts):
//
//   async function getCloudApiKey() {
//     return authStorage.getApiKey("ollama-cloud") ?? process.env.OLLAMA_API_KEY;
//   }
//
// `getApiKey` is async, so it returns a (always-truthy) Promise — the `??`
// short-circuits and the `process.env.OLLAMA_API_KEY` fallback is DEAD CODE
// (verified: `(Promise ?? x)` resolves to the Promise's value, never `x`).
// Worse, it resolves against a FRESH `AuthStorage.create()` instance that shares
// nothing with pi's live auth: empty runtimeOverrides (so an interactive
// credential is invisible), `ollama-cloud` is absent from pi-ai's built-in env
// map, and there is no fallbackResolver. Net effect: the tool only works when
// auth.json carries an `ollama-cloud` api_key entry, and silently ignores
// `OLLAMA_API_KEY` — even though that env var is exactly how piWrapped injects
// the agenix secret (and how the `ollama-cloud` PROVIDER authenticates, via
// `apiKey: "$OLLAMA_API_KEY"`). So chat works while web search reports
// "No Ollama Cloud API key configured."
//
// Fix here rather than vendor the package (same approach as
// patch-grok-build-context-window.ts): re-register both tools with corrected key
// resolution that `await`s the lookup and then falls back to the env var.
//
// Ordering: every extension default export runs at LOAD; pi-ollama-cloud@0.6.0
// registers its web tools only in its `session_start` handler, guarded by
// `ensureWebToolsRegistered()` which SKIPS any tool already present by name.
// Registering ours at load (below) therefore pre-empts the buggy versions
// regardless of relative load order. The package's `setWebToolsActive(true)`
// (also session_start) still activates them by name, so we don't manage active
// state. If a newer pi-ollama-cloud moves registration to load time and wins the
// race, remove this extension and rely on the upstream fix instead.

const OLLAMA_BASE = "https://ollama.com";
const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;

// Fresh instance is fine: the corrected resolution treats auth.json as the
// optional path and process.env.OLLAMA_API_KEY as the reliable one (piWrapped
// exports it from /run/agenix/ollama).
const authStorage = AuthStorage.create();

async function getCloudApiKey(): Promise<string | undefined> {
  return (await authStorage.getApiKey("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}

function textResult(text: string, isError = false): AgentToolResult<unknown> {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function noApiKeyError(): AgentToolResult<unknown> {
  return textResult(
    "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add an " +
      '`ollama-cloud` api_key entry to auth.json.',
    true,
  );
}

function authError(kind: "search" | "fetch"): AgentToolResult<unknown> {
  return textResult(
    `Ollama Cloud ${kind} failed: authentication error. ` +
      "Check OLLAMA_API_KEY or the ollama-cloud auth.json entry.",
    true,
  );
}

interface SearchResponse {
  results: Array<{ title: string; url: string; content: string }>;
}

interface FetchResponse {
  title: string;
  content: string;
  links: string[];
}

const SearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute" }),
  max_results: Type.Optional(
    Type.Integer({
      description: `Maximum number of search results to return (default: ${DEFAULT_MAX_RESULTS}, max: ${MAX_MAX_RESULTS})`,
      default: DEFAULT_MAX_RESULTS,
      minimum: 1,
      maximum: MAX_MAX_RESULTS,
    }),
  ),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
});

function registerWebSearchTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof SearchParams, unknown>({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      "Returns relevant results with titles, URLs, and content snippets.",
    parameters: SearchParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();
      const args = params as { query: string; max_results?: number };
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_search`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: args.query, max_results: args.max_results ?? DEFAULT_MAX_RESULTS }),
          signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) return authError("search");
          if (res.status === 429) return textResult("Ollama Cloud search failed: rate limited. Try again shortly.", true);
          const errorText = await res.text().catch(() => "");
          return textResult(`Search API error (status ${res.status}): ${errorText || res.statusText}`, true);
        }
        const data = (await res.json()) as SearchResponse;
        const formatted = data.results
          .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
          .join("\n\n");
        return { content: [{ type: "text" as const, text: formatted || "No results found." }], details: { results: data.results } };
      } catch (err) {
        return textResult(`Web search failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  });
}

function registerWebFetchTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof FetchParams, unknown>({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      "Returns the page title, main content, and links found on the page.",
    parameters: FetchParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const apiKey = await getCloudApiKey();
      if (!apiKey) return noApiKeyError();
      const args = params as { url: string };
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_fetch`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: args.url }),
          signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) return authError("fetch");
          if (res.status === 429) return textResult("Ollama Cloud fetch failed: rate limited. Try again shortly.", true);
          const errorText = await res.text().catch(() => "");
          return textResult(`Fetch API error (status ${res.status}): ${errorText || res.statusText}`, true);
        }
        const data = (await res.json()) as FetchResponse;
        const formatted = [
          `Title: ${data.title}`,
          "",
          "Content:",
          data.content,
          "",
          `Links found: ${data.links?.length ?? 0}`,
          ...(data.links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
        ].join("\n");
        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { title: data.title, content: data.content, links: data.links },
        };
      } catch (err) {
        return textResult(`Web fetch failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  });
}

export default function fixOllamaCloudWebToolsAuth(pi: ExtensionAPI): void {
  registerWebSearchTool(pi);
  registerWebFetchTool(pi);
}
