import path from "node:path";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Logger } from "./log/logger";
import { WsSession, type WsSessionData } from "./ws/session";
import { isOriginAllowed } from "./ws/origin";
import { Bridge } from "./agent/bridge";
import { SessionRegistry } from "./seq/sessionRegistry";
import { SqlitePersistence } from "./persist/SqlitePersistence.js";
import { FsLedgerStore } from "@cq/ledger";
import { INTERNAL_WS_PATH, InternalWsService, type InternalWsConnData } from "./agent/internalWs";

export type ServerConfig = Readonly<{
  host: string;
  port: number;
  webOutdir: string;
  cwd: string;
  dbPath: string;
  logger: Logger;
}>;

export type RunningServer = {
  stop(): void | Promise<void>;
  /** Prevent new WebSocket upgrades (called at start of graceful shutdown). */
  markDraining(): void;
  /** Close all tracked WebSocket connections with code 1012 (service restart). */
  closeAllSockets(code: number, reason: string): void;
  /** The Bridge instance managing the active SDK query. */
  readonly bridge: Bridge;
  /** The Persistence adapter (needed for close() in shutdown). */
  readonly persistence: SqlitePersistence;
  /**
   * URL the spawned cq-mcp uses to dial the internal channel. Built
   * from the bound port (NOT the requested port — Bun's `port: 0`
   * picks an ephemeral one).
   */
  readonly internalWsUrl: string;
  /** Token to pass to spawned cq-mcp via env. */
  readonly internalWsToken: string;
};

type WsData = WsSessionData | InternalWsConnData;

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { host, port, webOutdir, cwd, dbPath, logger } = config;

  // Shared registry and bridge (pool=1 across all connections).
  const registry = new SessionRegistry();
  // Ensure the parent directory exists for file-backed databases.
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const persistence = new SqlitePersistence(dbPath, undefined, logger);
  // Internal WS service runs alongside the browser WS handler; it
  // owns a per-process token used to authenticate spawned cq-mcp
  // subprocesses. Constructed before the ledger store so we can wire
  // its broadcast into `onMutation`.
  const internalWs = new InternalWsService({ logger });
  // Ledger store rooted at the same cwd so docs/<ledger>.md sit next to
  // the agent's working tree. init() loads docs/ledgers.yaml and every
  // registered ledger; missing files are created with empty content.
  // onMutation broadcasts every successful write to all connected
  // cq-mcp clients so they invalidate their caches (D-COHERENCE).
  const ledgerStore = new FsLedgerStore({
    root: cwd,
    onMutation: (ledgerId, op) => {
      internalWs.broadcast({
        type: "ledger.changed",
        ledgerId,
        op,
        sourcePid: internalWs.selfPid(),
      });
    },
  });
  await ledgerStore.init();
  // Inbound `ledger.changed` from any cq-mcp triggers a local
  // invalidate. Loop-detection (sourcePid === our pid) is enforced
  // inside the service before the handler runs.
  internalWs.registerHandler("ledger.changed", (msg) => {
    void ledgerStore.invalidate(msg.ledgerId).catch((err: unknown) => {
      logger.warn("ledger.invalidate_failed", {
        ledgerId: msg.ledgerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  const bridge = new Bridge({ logger, registry, cwd, persistence, ledgerStore });

  // Track all open WS sockets for graceful close-with-code.
  type WsHandle = { close(code?: number, reason?: string): void };
  const openSockets = new Set<WsHandle>();
  let draining = false;

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // ── Internal WS upgrade ───────────────────────────────────────── //
      // The cq-mcp subprocess dials `/__internal/cq-mcp` with a token
      // in `Sec-WebSocket-Protocol`. NOT subject to the same-origin
      // check (Node/Bun WS clients send no Origin header). Token check
      // is constant-time. Refuses 503 while draining like /ws.
      if (pathname === INTERNAL_WS_PATH) {
        if (draining) return new Response("Service Unavailable", { status: 503 });
        return internalWs.handleUpgrade(req, srv) ?? new Response("Upgrade required", { status: 426 });
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/interrupt: force-clears bridge.active so the next test
      // starts with a clean slate. Only enabled when CQ_E2E_HOOKS=1 (set by
      // the Playwright globalSetup), refusing the route in production. This
      // is the minimum surface Playwright needs for reliable test teardown
      // when the SDK subprocess takes long to drain.
      if (pathname === "/__e2e/interrupt" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          bridge.interruptActive();
          await bridge.shutdown();
          return new Response("ok", { status: 200 });
        } catch (err) {
          logger.warn("e2e.interrupt_failed", { err: String(err) });
          return new Response("interrupt failed", { status: 500 });
        }
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/settings: synchronously sets ui_settings.{model,
      // permissionMode, hideSdkEvents}. Mirrors the `settings.set` WS frame
      // but lets test setup pre-stage server-side defaults BEFORE opening
      // the cq page, so the very first auto-start chat.start carries the
      // intended routing (e.g. Codex specs that need model=gpt-5.5 server-
      // side so the auto-start picks it up via settings.get_result before
      // the deferred chat.start fires). Body shape:
      //   { model?: string|null, permissionMode?: string|null,
      //     hideSdkEvents?: boolean }
      if (pathname === "/__e2e/settings" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          const body = (await req.json()) as {
            model?: string | null;
            permissionMode?: string | null;
            hideSdkEvents?: boolean;
          };
          const patch: Partial<{ model: string | null; permissionMode: string | null; hideSdkEvents: boolean }> = {};
          if (body.model !== undefined) patch.model = body.model;
          if (body.permissionMode !== undefined) patch.permissionMode = body.permissionMode;
          if (body.hideSdkEvents !== undefined) patch.hideSdkEvents = body.hideSdkEvents;
          persistence.settings.set(patch);
          return new Response("ok", { status: 200 });
        } catch (err) {
          logger.warn("e2e.settings_failed", { err: String(err) });
          return new Response("settings failed", { status: 500 });
        }
      }

      // WebSocket upgrade — only on /ws
      if (pathname === "/ws") {
        // Refuse new upgrades when draining.
        if (draining) {
          return new Response("Service Unavailable", { status: 503 });
        }

        if (!isOriginAllowed(req)) {
          logger.info("ws.origin_rejected", {
            origin: req.headers.get("Origin") ?? "(none)",
            host,
            port,
          });
          return new Response(null, { status: 403 });
        }

        const sessionId = crypto.randomUUID();
        const session = new WsSession(sessionId, logger, registry, bridge, persistence);
        const upgraded = srv.upgrade(req, { data: { sessionId, session } });
        if (!upgraded) {
          // Bun returns false when the upgrade fails for non-WS requests
          return new Response("Upgrade required", { status: 426 });
        }
        // upgrade() succeeded — must return undefined so Bun takes over.
        return undefined;
      }

      // Static asset cache policy: cq rebuilds the web bundle on every
      // server start (buildWeb → fixed filename main.js / main.css), but
      // without Cache-Control browsers happily serve the old bundle from
      // memory/disk cache and the user never sees fresh UI code. For a
      // local dev tool the safe default is no-store on every static asset.
      const noStore = { "Cache-Control": "no-store, no-cache, must-revalidate" };

      // Serve index.html for root or unknown paths
      if (pathname === "/" || pathname === "") {
        const indexPath = path.join(webOutdir, "index.html");
        try {
          const content = await fs.readFile(indexPath, "utf8");
          return new Response(content, {
            headers: { "Content-Type": "text/html; charset=utf-8", ...noStore },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // Serve static files from webOutdir
      const filePath = path.join(webOutdir, pathname.replace(/^\//, ""));
      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(file, { headers: noStore });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },

    websocket: {
      open(ws) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.open(ws as never);
          return;
        }
        openSockets.add(ws);
        (ws.data as WsSessionData).session.open(ws as never);
      },
      message(ws, raw) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.message(ws as never, raw);
          return;
        }
        (ws.data as WsSessionData).session.message(ws as never, raw);
      },
      close(ws, code, reason) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.close(ws as never);
          return;
        }
        openSockets.delete(ws);
        (ws.data as WsSessionData).session.close(ws as never, code, reason);
      },
    },
  });

  // Bind URL reflects the bound port; `Bun.serve` may pick an
  // ephemeral one when port=0.
  const boundPort = server.port;
  const internalWsUrl = `ws://127.0.0.1:${boundPort}${INTERNAL_WS_PATH}`;
  logger.info("cq listening", { host, port: boundPort, cwd, dbPath, internalWsUrl });

  return {
    bridge,
    persistence,
    internalWsUrl,
    internalWsToken: internalWs.tokenForChild(),

    markDraining() {
      draining = true;
    },

    closeAllSockets(code: number, reason: string) {
      for (const ws of openSockets) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closed — ignore.
        }
      }
      openSockets.clear();
    },

    stop() {
      server.stop();
      persistence.close();
    },
  };
}
