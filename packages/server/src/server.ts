import path from "node:path";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Logger } from "./log/logger";
import { WsSession, type WsSessionData } from "./ws/session";
import { isOriginAllowed } from "./ws/origin";
import { Bridge } from "./agent/bridge";
import { SessionRegistry } from "./seq/sessionRegistry";
import { SqlitePersistence } from "./persist/SqlitePersistence.js";

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
  const persistence = new SqlitePersistence(dbPath);
  const bridge = new Bridge({ logger, registry, cwd, persistence });

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

      // WebSocket upgrade — only on /ws
      if (pathname === "/ws") {
        // Refuse new upgrades when draining.
        if (draining) {
          return new Response("Service Unavailable", { status: 503 });
        }

        if (!isOriginAllowed(req, host, port)) {
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

      // Serve index.html for root or unknown paths
      if (pathname === "/" || pathname === "") {
        const indexPath = path.join(webOutdir, "index.html");
        try {
          const content = await fs.readFile(indexPath, "utf8");
          return new Response(content, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
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
        return new Response(file);
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
