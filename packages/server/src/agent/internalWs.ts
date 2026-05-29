/**
 * Internal WebSocket service — cq-server side of the cq-server ↔
 * cq-mcp coherence channel (D-COHERENCE).
 *
 * Topology. The same `Bun.serve` that handles browser `/ws` traffic
 * also accepts `/__internal/cq-mcp` upgrades from spawned cq-mcp
 * subprocesses. The internal path is NOT subject to the same-origin
 * check (Node/Bun WS clients send no Origin header); authentication
 * uses a per-process random token sent as the `Sec-WebSocket-Protocol`
 * suffix.
 *
 * Token. Generated once at server startup
 * (`crypto.randomBytes(16).toString("hex")`), passed to spawned
 * cq-mcp via `CQ_INTERNAL_WS_URL` + `CQ_INTERNAL_WS_TOKEN` env vars.
 * The client sends `Sec-WebSocket-Protocol: cq-internal.<token>`;
 * the server validates the suffix via `crypto.timingSafeEqual` and
 * echoes the same subprotocol on accept.
 *
 * Routing. Inbound messages are Zod-validated against
 * `InternalWsMessage` (from `@cq/shared`); a handler map keyed by
 * `type` dispatches them. Unknown types are dropped with a warning
 * (forward-compatibility). Messages whose `sourcePid === process.pid`
 * are dropped to defend against loops in any future multi-process
 * topology.
 */

import * as crypto from "node:crypto";
import {
  INTERNAL_WS_PATH,
  INTERNAL_WS_SUBPROTOCOL_PREFIX,
  InternalWsMessage,
  type InternalWsMessageType,
} from "@cq/shared";
import type { Logger } from "../log/logger";

/**
 * Data we stash on an internal WebSocket connection at upgrade time.
 * Discriminated by `kind` against the browser-facing `WsSessionData`
 * so the outer `websocket:` block in `Bun.serve` can branch cleanly.
 */
export type InternalWsConnData = {
  kind: "internal";
  /** Per-connection id assigned at accept time (for logging only). */
  clientId: string;
};

/** Minimal handle the service uses to send + close per-socket. */
export interface InternalWsSocket {
  data: InternalWsConnData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

/** Handler signature for an inbound message of a given type. */
export type InternalWsHandler<T extends InternalWsMessageType> = (
  msg: Extract<InternalWsMessage, { type: T }>,
) => void | Promise<void>;

export interface InternalWsServiceOpts {
  logger: Logger;
  /**
   * Override `process.pid`; tests inject a stable value so loop-
   * detection assertions don't depend on the runner pid.
   */
  pid?: number;
  /**
   * Override the token; tests inject a deterministic value so
   * Sec-WebSocket-Protocol assertions are stable. Production code
   * never sets this — let the constructor generate one.
   */
  token?: string;
}

export class InternalWsService {
  private readonly logger: Logger;
  private readonly token: string;
  private readonly tokenBuffer: Buffer;
  private readonly pid: number;
  private readonly handlers = new Map<
    InternalWsMessageType,
    (msg: InternalWsMessage) => void | Promise<void>
  >();
  private readonly sockets = new Set<InternalWsSocket>();

  constructor(opts: InternalWsServiceOpts) {
    this.logger = opts.logger;
    this.token = opts.token ?? crypto.randomBytes(16).toString("hex");
    this.tokenBuffer = Buffer.from(this.token, "utf8");
    this.pid = opts.pid ?? process.pid;
  }

  /** The token value to pass to spawned cq-mcp via `CQ_INTERNAL_WS_TOKEN`. */
  tokenForChild(): string {
    return this.token;
  }

  /** This process's pid (used by callers when constructing broadcast envelopes). */
  selfPid(): number {
    return this.pid;
  }

  /**
   * Register an inbound handler for a given message type. Registering
   * a second handler for the same type replaces the first (the brief's
   * one-handler-per-type design).
   */
  registerHandler<T extends InternalWsMessageType>(
    type: T,
    fn: InternalWsHandler<T>,
  ): void {
    this.handlers.set(type, fn as (msg: InternalWsMessage) => void | Promise<void>);
  }

  /**
   * Broadcast a message to every connected internal client. The caller
   * sets `sourcePid` so the loop-detection assertion on the receiver
   * is symmetric.
   */
  broadcast(msg: InternalWsMessage): void {
    const parsed = InternalWsMessage.safeParse(msg);
    if (!parsed.success) {
      this.logger.warn("internalWs.broadcast_invalid", {
        error: parsed.error.message,
      });
      return;
    }
    const wire = JSON.stringify(parsed.data);
    for (const ws of this.sockets) {
      try {
        ws.send(wire);
      } catch (err: unknown) {
        this.logger.warn("internalWs.broadcast_send_failed", {
          clientId: ws.data.clientId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Pre-upgrade handler. Returns a `Response` (401) on auth failure;
   * returns `undefined` after a successful `srv.upgrade(...)`, mirroring
   * the convention in `server.ts`'s fetch handler so the outer router
   * just `return`s our result.
   *
   * `srv.upgrade<T>` is the Bun.serve upgrade hook; we pass the
   * `InternalWsConnData` shape via the `data` option and echo the
   * accepted subprotocol via `headers`.
   */
  handleUpgrade(
    req: Request,
    srv: {
      upgrade(
        req: Request,
        opts: { data: InternalWsConnData; headers?: HeadersInit },
      ): boolean;
    },
  ): Response | undefined {
    const token = this.extractTokenFromSubprotocol(req);
    if (token === null) {
      this.logger.info("internalWs.auth_rejected", { reason: "no-subprotocol" });
      return new Response("Unauthorized", { status: 401 });
    }
    const tokenBuf = Buffer.from(token, "utf8");
    if (tokenBuf.length !== this.tokenBuffer.length) {
      this.logger.info("internalWs.auth_rejected", { reason: "wrong-length" });
      return new Response("Unauthorized", { status: 401 });
    }
    if (!crypto.timingSafeEqual(tokenBuf, this.tokenBuffer)) {
      this.logger.info("internalWs.auth_rejected", { reason: "wrong-token" });
      return new Response("Unauthorized", { status: 401 });
    }

    const clientId = crypto.randomUUID();
    const upgraded = srv.upgrade(req, {
      data: { kind: "internal", clientId },
      headers: {
        "Sec-WebSocket-Protocol": `${INTERNAL_WS_SUBPROTOCOL_PREFIX}.${this.token}`,
      },
    });
    if (!upgraded) {
      this.logger.warn("internalWs.upgrade_failed", { clientId });
      return new Response("Upgrade required", { status: 426 });
    }
    return undefined;
  }

  /** Bun WS `open` callback — register the socket. */
  open(ws: InternalWsSocket): void {
    this.sockets.add(ws);
    this.logger.info("internalWs.connected", { clientId: ws.data.clientId });
  }

  /** Bun WS `close` callback. */
  close(ws: InternalWsSocket): void {
    this.sockets.delete(ws);
    this.logger.info("internalWs.disconnected", { clientId: ws.data.clientId });
  }

  /**
   * Bun WS `message` callback. Parse + dispatch. All failures are
   * logged + dropped; the channel is not torn down because one
   * malformed frame shouldn't kill the cache-coherence stream.
   */
  message(ws: InternalWsSocket, raw: string | Buffer): void {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.logger.warn("internalWs.bad_json", {
        clientId: ws.data.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const result = InternalWsMessage.safeParse(parsed);
    if (!result.success) {
      // Reach for the candidate `type` so logs say "unknown type X" vs
      // generic shape errors.
      const incomingType =
        typeof parsed === "object" && parsed !== null && "type" in parsed
          ? String((parsed as { type: unknown }).type)
          : "(missing)";
      this.logger.warn("internalWs.invalid_envelope", {
        clientId: ws.data.clientId,
        incomingType,
        error: result.error.message,
      });
      return;
    }
    const msg = result.data;
    if (msg.sourcePid === this.pid) {
      // Loop guard: never act on a message we (could have) emitted.
      return;
    }
    const handler = this.handlers.get(msg.type);
    if (handler === undefined) {
      this.logger.warn("internalWs.no_handler", {
        clientId: ws.data.clientId,
        type: msg.type,
      });
      return;
    }
    try {
      const ret = handler(msg);
      if (ret !== undefined && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch((err: unknown) => {
          this.logger.warn("internalWs.handler_rejected", {
            type: msg.type,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err: unknown) {
      this.logger.warn("internalWs.handler_threw", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Extract the token suffix from `Sec-WebSocket-Protocol`. RFC 6455
   * allows a comma-separated list. We accept any entry whose
   * dot-separated head matches the prefix; the tail is the candidate
   * token. Returns null if none match the prefix.
   */
  private extractTokenFromSubprotocol(req: Request): string | null {
    const header = req.headers.get("Sec-WebSocket-Protocol");
    if (header === null || header === "") return null;
    for (const raw of header.split(",")) {
      const proto = raw.trim();
      if (proto === "") continue;
      const dotIdx = proto.indexOf(".");
      if (dotIdx <= 0) continue;
      const head = proto.slice(0, dotIdx);
      const tail = proto.slice(dotIdx + 1);
      if (head !== INTERNAL_WS_SUBPROTOCOL_PREFIX) continue;
      if (tail === "") continue;
      return tail;
    }
    return null;
  }
}

/** Re-export the path constant for caller convenience. */
export { INTERNAL_WS_PATH };
