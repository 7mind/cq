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
};

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { host, port, webOutdir, cwd, dbPath, logger } = config;

  // Shared registry and bridge (pool=1 across all connections).
  const registry = new SessionRegistry();
  // Ensure the parent directory exists for file-backed databases.
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const persistence = new SqlitePersistence(dbPath, undefined, logger);
  // Ledger store rooted at the same cwd so docs/<ledger>.md sit next to
  // the agent's working tree. init() loads docs/ledgers.yaml and every
  // registered ledger; missing files are created with empty content.
  const ledgerStore = new FsLedgerStore({ root: cwd });
  await ledgerStore.init();
  const bridge = new Bridge({ logger, registry, cwd, persistence, ledgerStore });

  // Track all open WS sockets for graceful close-with-code.
  type WsHandle = { close(code?: number, reason?: string): void };
  const openSockets = new Set<WsHandle>();
  let draining = false;

  const server = Bun.serve<WsSessionData>({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

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
        openSockets.add(ws);
        ws.data.session.open(ws);
      },
      message(ws, raw) {
        ws.data.session.message(ws, raw);
      },
      close(ws, code, reason) {
        openSockets.delete(ws);
        ws.data.session.close(ws, code, reason);
      },
    },
  });

  logger.info("cq listening", { host, port, cwd, dbPath });

  return {
    bridge,
    persistence,

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
