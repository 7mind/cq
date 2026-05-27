import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "./log/logger";
import indexHtml from "../../web/index.html" with { type: "html" };
import { WsSession, type WsSessionData } from "./ws/session";
import { isOriginAllowed } from "./ws/origin";
import { Bridge } from "./agent/bridge";
import { SessionRegistry } from "./seq/sessionRegistry";
import { SqlitePersistence } from "./persist/SqlitePersistence.js";
import { FsLedgerStore } from "@cq/ledger";

export type DevServerConfig = Readonly<{
  host: string;
  port: number;
  cwd: string;
  dbPath: string;
  logger: Logger;
}>;

export type RunningDevServer = {
  stop(): void | Promise<void>;
  readonly url: URL;
  readonly development: boolean;
};

/**
 * Injectable serve function type — matches the Bun.serve signature for our use.
 * The default is Bun.serve. Tests may inject a stub to capture options.
 */
export type ServeFunction = typeof Bun.serve;

export async function startDevServer(
  config: DevServerConfig,
  serve: ServeFunction = Bun.serve,
): Promise<RunningDevServer> {
  const { host, port, cwd, dbPath, logger } = config;

  // Shared registry and bridge (pool=1 across all connections).
  const registry = new SessionRegistry();
  // Ensure the parent directory exists for file-backed databases.
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const persistence = new SqlitePersistence(dbPath);
  const ledgerStore = new FsLedgerStore({ root: cwd });
  await ledgerStore.init();
  const bridge = new Bridge({ logger, registry, cwd, persistence, ledgerStore });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (serve as (opts: any) => ReturnType<typeof Bun.serve>)({
    hostname: host,
    port,
    development: { hmr: true, console: true },
    routes: {
      "/": indexHtml,
    },
    fetch(req: Request, srv: { upgrade(req: Request, opts: { data: WsSessionData }): boolean }) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!isOriginAllowed(req)) {
          logger.info("ws.origin_rejected", {
            origin: req.headers.get("Origin") ?? "(none)",
            host,
            port,
          });
          return new Response(null, { status: 403 });
        }

        const sessionId = crypto.randomUUID();
        const session = new WsSession(sessionId, logger, registry, bridge);
        const upgraded = srv.upgrade(req, { data: { sessionId, session } });
        if (!upgraded) {
          return new Response("Upgrade required", { status: 426 });
        }
        return undefined;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws: { data: WsSessionData; send(d: string): void; close(c?: number, r?: string): void }) {
        ws.data.session.open(ws);
      },
      message(ws: { data: WsSessionData; send(d: string): void; close(c?: number, r?: string): void }, raw: string | Buffer) {
        ws.data.session.message(ws, raw);
      },
      close(ws: { data: WsSessionData; send(d: string): void; close(c?: number, r?: string): void }, code: number, reason: string) {
        ws.data.session.close(ws, code, reason);
      },
    },
  });

  logger.info("cq dev listening", { host, port, cwd, dbPath, hmr: true });

  return {
    stop() {
      const result = server.stop();
      persistence.close();
      return result;
    },
    get url() {
      return server.url;
    },
    get development() {
      return server.development;
    },
  };
}
