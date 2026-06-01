/**
 * Browser entry point for ledger-web.
 *
 * By default the app talks to the SAME-ORIGIN `/mcp` endpoint, which this
 * page's own server reverse-proxies to the upstream MCP server. So the browser
 * never contacts the MCP server directly — it works from any host that can
 * reach this page, with no CORS. `?url=` overrides for direct/advanced use.
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
 * Same-origin /ws for live updates, proxied to the upstream by this server.
 * Scheme follows the page: `ws://` on a plain-http page, `wss://` on https —
 * a secure page may not open an insecure socket (mixed content), and a
 * plain-http page must not attempt wss.
 */
function liveWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  createRoot(rootEl).render(
    createElement(App, {
      connect: (url: string) => McpLedgerClient.connect(url),
      initialUrl: resolveInitialUrl(),
      liveUrl: liveWsUrl(),
    }),
  );
}
