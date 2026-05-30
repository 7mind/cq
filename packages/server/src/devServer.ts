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
import { initLedgerStoreOrExit } from "./ledgerInit";
import { INTERNAL_WS_PATH, InternalWsService, type InternalWsConnData } from "./agent/internalWs";

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
  /** URL the spawned cq-mcp uses to dial the internal channel (D-COHERENCE). */
  readonly internalWsUrl: string;
  /** Token to pass to spawned cq-mcp via env (D-COHERENCE). */
  readonly internalWsToken: string;
};

type DevWsData = WsSessionData | InternalWsConnData;

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
  const internalWs = new InternalWsService({ logger });
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
  // Humane startup (see server.ts): BootstrapViolationError → actionable
  // `cq reset` guidance, not a raw stack trace.
  await initLedgerStoreOrExit(ledgerStore);
  internalWs.registerHandler("ledger.changed", async (msg) => {
    try {
      await ledgerStore.invalidate(msg.ledgerId);
    } catch (err: unknown) {
      logger.warn("ledger.invalidate_failed", {
        ledgerId: msg.ledgerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const bridge = new Bridge({
    logger,
    registry,
    cwd,
    persistence,
    ledgerStore,
    internalWsToken: internalWs.tokenForChild(),
    // askproxy / outer-14: ask.reply travels upstream via broadcast.
    sendAskReply: (msg) => internalWs.broadcast(msg),
  });
  // askproxy / outer-14: inbound ask.request → drive browser ask UI + proxy.
  internalWs.registerHandler("ask.request", async (msg) => {
    bridge.handleAskRequest({
      askId: msg.askId,
      toolUseId: msg.toolUseId,
      sessionId: msg.sessionId,
      questions: msg.questions,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (serve as (opts: any) => ReturnType<typeof Bun.serve>)({
    hostname: host,
    port,
    development: { hmr: true, console: true },
    routes: {
      "/": indexHtml,
    },
    fetch(
      req: Request,
      srv: {
        upgrade(
          req: Request,
          opts: { data: DevWsData; headers?: HeadersInit },
        ): boolean;
      },
    ) {
      const url = new URL(req.url);
      if (url.pathname === INTERNAL_WS_PATH) {
        return internalWs.handleUpgrade(req, srv) ?? new Response("Upgrade required", { status: 426 });
      }
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
      open(ws: { data: DevWsData; send(d: string): void; close(c?: number, r?: string): void }) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.open(ws as never);
          return;
        }
        (ws.data as WsSessionData).session.open(ws as never);
      },
      message(ws: { data: DevWsData; send(d: string): void; close(c?: number, r?: string): void }, raw: string | Buffer) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.message(ws as never, raw);
          return;
        }
        (ws.data as WsSessionData).session.message(ws as never, raw);
      },
      close(ws: { data: DevWsData; send(d: string): void; close(c?: number, r?: string): void }, code: number, reason: string) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.close(ws as never);
          return;
        }
        (ws.data as WsSessionData).session.close(ws as never, code, reason);
      },
    },
  });

  const boundPort = server.port;
  const internalWsUrl = `ws://127.0.0.1:${boundPort}${INTERNAL_WS_PATH}`;
  bridge.setInternalWsUrl(internalWsUrl);
  logger.info("cq dev listening", { host, port: boundPort, cwd, dbPath, hmr: true, internalWsUrl });

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
    internalWsUrl,
    internalWsToken: internalWs.tokenForChild(),
  };
}
