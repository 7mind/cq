/**
 * Browser entry point for ledger-web.
 *
 * By default the app talks to the SAME-ORIGIN `/mcp` endpoint, which this
 * page's own server reverse-proxies to the upstream MCP server. So the browser
 * never contacts the MCP server directly — it works from any host that can
 * reach this page, with no CORS. `?url=` overrides for direct/advanced use.
 *
 * `?token=` (T588 / Q273): this SAME bundle is also served by the `cq serve`
 * hub, which — when bound with `--token` — requires that bearer secret on
 * every data route. There is no login screen (Q273 lock: minimal surface): the
 * token rides as a `?token=` query param on the PAGE's own URL, which this
 * entry point forwards as the `Authorization: Bearer <token>` header on every
 * `/mcp` request ({@link McpLedgerClient.connect}) and as a `?token=` query
 * param on the `/ws` upgrade ({@link liveWsUrl}) — browsers cannot set custom
 * headers on a WebSocket handshake, so the query param is the one mechanism
 * `/p/<key>/ws` accepts (see hubServe.ts's module doc).
 */

import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./App.js";
import { McpLedgerClient } from "./mcpClient.js";
import "./styles.css";

declare global {
  interface Window {
    __LEDGER_MCP_URL__?: string;
  }
}

function resolveInitialUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("url");
  if (fromQuery !== null && fromQuery.length > 0) {
    return new URL(fromQuery, window.location.origin).toString();
  }
  const injected =
    typeof window.__LEDGER_MCP_URL__ === "string" && window.__LEDGER_MCP_URL__.length > 0
      ? window.__LEDGER_MCP_URL__
      : "/mcp";
  // Resolve relative ("/mcp") against this page's origin → absolute URL.
  return new URL(injected, window.location.origin).toString();
}

/**
 * Read the `?token=` page-URL param (T588 / Q273), or `null` when absent —
 * `loc` is injectable for tests; the real call site reads `window.location`.
 */
export function resolveToken(loc?: Pick<Location, "search">): string | null {
  const l = loc ?? window.location;
  const t = new URLSearchParams(l.search).get("token");
  return t !== null && t.length > 0 ? t : null;
}

/**
 * Same-origin /ws for live updates, proxied to the upstream by this server.
 * Scheme follows the page: `ws://` on a plain-http page, `wss://` on https —
 * a secure page may not open an insecure socket (mixed content), and a
 * plain-http page must not attempt wss. Appends `?token=` (T588 / Q273) when
 * one was resolved from the page URL — `loc` is injectable for tests.
 */
export function liveWsUrl(token: string | null, loc?: Pick<Location, "protocol" | "host">): string {
  const l = loc ?? window.location;
  const proto = l.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${l.host}/ws`;
  return token !== null ? `${base}?token=${encodeURIComponent(token)}` : base;
}

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  const token = resolveToken();
  createRoot(rootEl).render(
    createElement(App, {
      connect: (url: string) => McpLedgerClient.connect(url, token ?? undefined),
      initialUrl: resolveInitialUrl(),
      liveUrl: liveWsUrl(token),
    }),
  );
}
