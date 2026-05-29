/**
 * Internal WebSocket client — cq-mcp side of the cq-server ↔ cq-mcp
 * coherence channel (D-COHERENCE).
 *
 * Symmetric to `packages/server/src/agent/internalWs.ts`. The client
 * dials the server with `Sec-WebSocket-Protocol: cq-internal.<token>`
 * provided via env vars from the spawning cq-server. On open, it
 * registers `ledger.changed` handlers to invalidate the local
 * `FsLedgerStore` cache; on every successful local mutation it sends
 * a `ledger.changed` envelope upstream so the server reciprocally
 * invalidates.
 *
 * Lifecycle. `connect({url, token})` returns a `Channel` after the
 * upgrade completes (within 5 s) or rejects with a descriptive error
 * the caller turns into a fatal stderr line + exit(2). NO reconnection
 * logic — cq-mcp is short-lived per Codex session; on disconnect we
 * log and continue serving stdio MCP (cache invalidation is then
 * silently disabled).
 */

import {
  INTERNAL_WS_SUBPROTOCOL_PREFIX,
  InternalWsMessage,
  type InternalWsMessageType,
} from "@cq/shared";

export type InternalWsHandler<T extends InternalWsMessageType> = (
  msg: Extract<InternalWsMessage, { type: T }>,
) => Promise<void>;

/**
 * Logger interface — kept minimal so the binary doesn't pull in the
 * server's logger module. We write straight to stderr.
 */
export interface ChannelLogger {
  warn(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export interface ConnectOpts {
  url: string;
  token: string;
  logger?: ChannelLogger;
  timeoutMs?: number;
  /**
   * Test-only: override the global WebSocket constructor so tests can
   * inject a stub without relying on Bun.WebSocket process behaviour.
   * Defaults to `globalThis.WebSocket`.
   */
  WebSocketCtor?: typeof WebSocket;
}

export class InternalWsChannel {
  private readonly ws: WebSocket;
  private readonly logger: ChannelLogger;
  private readonly handlers = new Map<
    InternalWsMessageType,
    (msg: InternalWsMessage) => Promise<void>
  >();
  /** Callbacks fired exactly once when the channel transitions to closed. */
  private readonly closeCallbacks: Array<() => void> = [];
  private closed = false;
  private closeFanoutDone = false;

  private constructor(ws: WebSocket, logger: ChannelLogger) {
    this.ws = ws;
    this.logger = logger;
    this.ws.addEventListener("message", (ev) => this.handleMessage(ev));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      this.logger.info("internalWs.client_closed", {});
      this.fireCloseCallbacks();
    });
    this.ws.addEventListener("error", (ev) => {
      // After open the WebSocket spec emits 'error' on transport
      // problems; we log + leave the channel closed.
      const msg =
        ev instanceof ErrorEvent
          ? ev.message
          : (ev as { message?: string }).message ?? "unknown error";
      this.logger.warn("internalWs.client_error", { error: msg });
    });
  }

  static async connect(opts: ConnectOpts): Promise<InternalWsChannel> {
    const logger = opts.logger ?? defaultLogger();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
    if (Ctor === undefined) {
      throw new Error("internalWs: globalThis.WebSocket is not available");
    }
    const protocol = `${INTERNAL_WS_SUBPROTOCOL_PREFIX}.${opts.token}`;
    const ws = new Ctor(opts.url, [protocol]);
    return await new Promise<InternalWsChannel>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Echo check: the server SHOULD select the subprotocol we
        // offered. If it didn't, the handshake completed but the
        // server isn't the one we expected. Treat as an auth failure.
        const accepted = (ws as { protocol?: string }).protocol;
        if (typeof accepted === "string" && accepted !== "" && accepted !== protocol) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`subprotocol mismatch: server selected "${accepted}"`));
          return;
        }
        resolve(new InternalWsChannel(ws, logger));
      });
      ws.addEventListener("close", (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const reason =
          (ev as { reason?: string }).reason ??
          `closed before open (code=${(ev as { code?: number }).code ?? 0})`;
        reject(new Error(reason));
      });
      ws.addEventListener("error", (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message =
          ev instanceof ErrorEvent
            ? ev.message
            : (ev as { message?: string }).message ?? "connect error";
        reject(new Error(message));
      });
    });
  }

  /** Validate + send a message. Drops invalid payloads with a warning. */
  send(msg: InternalWsMessage): void {
    if (this.closed) return;
    const parsed = InternalWsMessage.safeParse(msg);
    if (!parsed.success) {
      this.logger.warn("internalWs.client_send_invalid", {
        error: parsed.error.message,
      });
      return;
    }
    try {
      this.ws.send(JSON.stringify(parsed.data));
    } catch (err: unknown) {
      this.logger.warn("internalWs.client_send_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  registerHandler<T extends InternalWsMessageType>(
    type: T,
    fn: InternalWsHandler<T>,
  ): void {
    this.handlers.set(type, fn as (msg: InternalWsMessage) => Promise<void>);
  }

  /**
   * Register a callback fired exactly once when the channel closes — for
   * either reason (server-initiated `close` event OR a local `close()`
   * call). Used by the ask-proxy to reject any pending asks so the
   * `ask_user_question` tool handler returns an error result instead of
   * hanging forever after the channel drops. If the channel is already
   * closed, the callback fires synchronously.
   */
  registerOnClose(cb: () => void): void {
    if (this.closeFanoutDone) {
      cb();
      return;
    }
    this.closeCallbacks.push(cb);
  }

  private fireCloseCallbacks(): void {
    if (this.closeFanoutDone) return;
    this.closeFanoutDone = true;
    for (const cb of this.closeCallbacks) {
      try {
        cb();
      } catch (err: unknown) {
        this.logger.warn("internalWs.close_callback_threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  close(code = 1000, reason = "normal"): void {
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
    // The 'close' event may not fire for an already-closed/again-closed
    // socket; fan out here too so rejectAll-on-disconnect is guaranteed.
    this.fireCloseCallbacks();
  }

  /** True after `close()` or after the server closed the channel. */
  isClosed(): boolean {
    return this.closed;
  }

  private handleMessage(ev: MessageEvent): void {
    const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn("internalWs.client_bad_json", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const result = InternalWsMessage.safeParse(parsed);
    if (!result.success) {
      this.logger.warn("internalWs.client_invalid_envelope", {
        error: result.error.message,
      });
      return;
    }
    const msg = result.data;
    if (msg.sourcePid === process.pid) return; // self-loop guard
    const handler = this.handlers.get(msg.type);
    if (handler === undefined) {
      this.logger.warn("internalWs.client_no_handler", { type: msg.type });
      return;
    }
    handler(msg).catch((err: unknown) => {
      this.logger.warn("internalWs.client_handler_rejected", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

function defaultLogger(): ChannelLogger {
  return {
    warn(msg, extra) {
      const payload = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
      process.stderr.write(`cq-mcp: ${payload}\n`);
    },
    info(msg, extra) {
      const payload = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
      process.stderr.write(`cq-mcp: ${payload}\n`);
    },
  };
}
