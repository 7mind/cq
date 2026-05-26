import { ClientFrame, type ServerHbPong } from "@cq/shared";
import { FRAME_VALIDATION_FAILED } from "@cq/shared";
import type { Logger } from "../log/logger";
import { createHeartbeat, type HeartbeatHandle } from "./heartbeat";

// ---------------------------------------------------------------------------
// Data attached to each WebSocket connection via ws.data
// ---------------------------------------------------------------------------

export type WsSessionData = {
  sessionId: string;
  session: WsSession;
};

// ---------------------------------------------------------------------------
// Outbound frame helper type — server-to-client frames without seq/ts (injected)
// ---------------------------------------------------------------------------

type PongPayload = Omit<ServerHbPong, "seq" | "ts">;

// ---------------------------------------------------------------------------
// WsSession — per-connection state and message dispatch
// ---------------------------------------------------------------------------

export class WsSession {
  private outboundSeq = 0;
  readonly sessionId: string;
  private readonly logger: Logger;
  private readonly heartbeat: HeartbeatHandle;

  constructor(sessionId: string, logger: Logger) {
    this.sessionId = sessionId;
    this.logger = logger;
    this.heartbeat = createHeartbeat({
      buildFrame: (payload) => {
        const seq = this.outboundSeq++;
        const ts = Date.now();
        return JSON.stringify({ ...payload, seq, ts });
      },
    });
  }

  /** Called by the Bun WS `open` handler. */
  open(ws: WsSocket): void {
    this.logger.info("ws.open", { sessionId: this.sessionId });
    this.heartbeat.start(ws);
  }

  /** Called by the Bun WS `message` handler. */
  message(ws: WsSocket, raw: string | Buffer): void {
    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this.logger.info("ws.validation_failed", {
        sessionId: this.sessionId,
        reason: "invalid JSON",
      });
      ws.close(FRAME_VALIDATION_FAILED, "invalid frame");
      return;
    }

    // Zod-validate against ClientFrame discriminated union
    const result = ClientFrame.safeParse(parsed);
    if (!result.success) {
      this.logger.info("ws.validation_failed", {
        sessionId: this.sessionId,
        reason: result.error.message,
      });
      ws.close(FRAME_VALIDATION_FAILED, "invalid frame");
      return;
    }

    const frame = result.data;

    switch (frame.type) {
      case "hb.ping": {
        const pong: PongPayload = {
          type: "hb.pong",
          echoNonce: frame.nonce,
          clientTs: frame.ts,
          serverTs: Date.now(),
        };
        this.sendFrame(ws, pong);
        break;
      }
      case "hb.spong": {
        this.heartbeat.onPong(ws, frame);
        break;
      }
      // All other client frames are accepted but not yet dispatched (PR-07+)
      default:
        // Accepted; no-op until later PRs wire the handlers.
        break;
    }
  }

  /** Called by the Bun WS `close` handler. */
  close(ws: WsSocket, code: number, reason: string): void {
    this.logger.info("ws.close", { sessionId: this.sessionId, code, reason });
    this.heartbeat.stop(ws);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Sends a frame to the client, injecting `seq` and `ts` automatically.
   * `payload` must contain all fields except `seq` and `ts`.
   */
  private sendFrame(ws: WsSocket, payload: PongPayload): void {
    const seq = this.outboundSeq++;
    const ts = Date.now();
    ws.send(JSON.stringify({ ...payload, seq, ts }));
  }
}

// ---------------------------------------------------------------------------
// Minimal ServerWebSocket shape Bun exposes — typed locally to avoid coupling
// to Bun global types that may not be in scope everywhere.
// ---------------------------------------------------------------------------

type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  data: WsSessionData;
};
