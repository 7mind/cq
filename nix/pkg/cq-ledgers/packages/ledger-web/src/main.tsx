/**
 * Browser entry point for ledger-web.
 *
 * By default the app talks to the SAME-ORIGIN `/mcp` endpoint, which this
 * page's own server reverse-proxies to the upstream MCP server. So the browser
 * never contacts the MCP server directly — it works from any host that can
 * reach this page, with no CORS. `?url=` overrides for direct/advanced use.
 *
 * `?project=<key>` (T837): on a multi-project XDG/hub host, a deep link with a
 * SAFE (see {@link isSafeProjectKeySegment}) `?project=<key>` resolves the
 * initial `/mcp` + `/ws` endpoints to that project's own `/p/<key>/{mcp,ws}`
 * routes BEFORE any connection is attempted — the browser never opens a
 * socket or sends a request to the wrong (alias) project first. An absent or
 * unsafe key falls back to the deterministic alias routes (`/mcp`, `/ws`),
 * exactly as with no `?project=` at all. `?url=` keeps full precedence over
 * `?project=` (unaffected — advanced/direct use). This is the SAME shared
 * seam App.tsx's `switchProject` (T589) reconnects through post-boot, and
 * that future T733 (remote-client bootstrap) must extend rather than
 * duplicate.
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
import { App, appendWsToken, deriveProjectMcpUrl, PROJECT_QUERY_KEY } from "./App.js";
import { McpLedgerClient } from "./mcpClient.js";
import { isSafeProjectKeySegment } from "./projectRoutes.js";
import "./styles.css";

declare global {
  interface Window {
    __LEDGER_MCP_URL__?: string;
  }
}

/**
 * Resolve the `?project=<key>` deep-link param (T837) into a project key
 * that is safe to route into `/p/<key>/{mcp,ws}` BEFORE any connection —
 * `null` when the param is absent or fails {@link isSafeProjectKeySegment},
 * in which case the caller falls back to the deterministic alias route.
 * `loc` is injectable for tests; the real call sites read `window.location`.
 */
export function resolveDeepLinkedProjectKey(loc?: Pick<Location, "search">): string | null {
  const l = loc ?? window.location;
  const raw = new URLSearchParams(l.search).get(PROJECT_QUERY_KEY);
  if (raw === null) return null;
  return isSafeProjectKeySegment(raw) ? raw : null;
}

/**
 * Resolve the initial `/mcp` URL to connect to, in precedence order:
 * `?url=` override (unchanged, T837-preserved) > a valid `?project=<key>`
 * deep link, routed to `/p/<key>/mcp` > the injected/default same-origin
 * `/mcp` alias. `loc` is injectable for tests; the real call site reads
 * `window.location`.
 */
export function resolveInitialUrl(loc?: Pick<Location, "search" | "origin">): string {
  const l = loc ?? window.location;
  const fromQuery = new URLSearchParams(l.search).get("url");
  if (fromQuery !== null && fromQuery.length > 0) {
    return new URL(fromQuery, l.origin).toString();
  }
  const projectKey = resolveDeepLinkedProjectKey(l);
  if (projectKey !== null) {
    return deriveProjectMcpUrl(l.origin, projectKey);
  }
  const injected =
    typeof window.__LEDGER_MCP_URL__ === "string" && window.__LEDGER_MCP_URL__.length > 0
      ? window.__LEDGER_MCP_URL__
      : "/mcp";
  // Resolve relative ("/mcp") against this page's origin → absolute URL.
  return new URL(injected, l.origin).toString();
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
 * Same-origin /ws for live updates, proxied to the upstream by this server —
 * or, on a valid `?project=<key>` deep link (T837), that project's own
 * `/p/<key>/ws` (paired with {@link resolveInitialUrl}'s `/p/<key>/mcp`, so
 * the socket never opens against the wrong project either). Scheme follows
 * the page: `ws://` on a plain-http page, `wss://` on https — a secure page
 * may not open an insecure socket (mixed content), and a plain-http page must
 * not attempt wss. Appends `?token=` (T588 / Q273) when one was resolved from
 * the page URL — via the SHARED {@link appendWsToken} helper, so the
 * project-switch path (App.tsx, T589-r2) uses the identical encoding. `loc`
 * is injectable for tests; `search` is optional there (defaults to `""`, i.e.
 * no deep-linked project) so pre-T837 call sites keep compiling unchanged.
 */
export function liveWsUrl(
  token: string | null,
  loc?: Pick<Location, "protocol" | "host"> & Partial<Pick<Location, "search">>,
): string {
  const l = loc ?? window.location;
  const proto = l.protocol === "https:" ? "wss:" : "ws:";
  const projectKey = resolveDeepLinkedProjectKey({ search: l.search ?? "" });
  const path = projectKey !== null ? `/p/${encodeURIComponent(projectKey)}/ws` : "/ws";
  return appendWsToken(`${proto}//${l.host}${path}`, token);
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
