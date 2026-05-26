import { ClientFrame, type ServerHbPong, type SessionState, type ChatError } from "@cq/shared";
import { FRAME_VALIDATION_FAILED } from "@cq/shared";
import type { Logger } from "../log/logger";
import { createHeartbeat, type HeartbeatHandle } from "./heartbeat";
import type { SessionRegistry } from "../seq/sessionRegistry";
import type { Bridge, WsSocket as BridgeWsSocket } from "../agent/bridge";

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
type SessionStatePayload = Omit<SessionState, "seq" | "ts">;

// ---------------------------------------------------------------------------
// WsSession — per-connection state and message dispatch
// ---------------------------------------------------------------------------

export class WsSession {
  private outboundSeq = 0;
  /** WS connection-level id (assigned at upgrade time). */
  readonly sessionId: string;
  /**
   * Chat session id — null until PR-19 sets it on `chat.start`.
   * The session.request_state handler returns sessionId:null when this is null.
   */
  chatSessionId: string | null = null;
  private readonly logger: Logger;
  private readonly heartbeat: HeartbeatHandle;
  private readonly registry: SessionRegistry | null;
  /**
   * Bridge instance — null in development/test mode where no SDK is wired.
   * When null, chat.start/input/interrupt return chat.error{code:BRIDGE_UNAVAILABLE}.
   */
  private readonly bridge: Bridge | null;

  constructor(sessionId: string, logger: Logger, registry?: SessionRegistry, bridge?: Bridge | null) {
    this.sessionId = sessionId;
    this.logger = logger;
    this.registry = registry ?? null;
    this.bridge = bridge ?? null;
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
      case "session.request_state": {
        this.handleRequestState(ws, frame.lastSeenServerSeq);
        break;
      }
      case "chat.start": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatStart(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "chat.input": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatInput(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "chat.interrupt": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatInterrupt(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
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
   * Handles `session.request_state` from the client (post-reconnect catchup).
   *
   * Decision tree per plan § 3.5:
   *  - No chat session (chatSessionId === null) → session.state{sessionId:null, gapDetected:false, serverSeq:0}
   *  - lastSeenServerSeq >= buffer.serverSeq → no gap; session.state{gapDetected:false}
   *  - gap within buffer → replay missing entries, then session.state{gapDetected:false}
   *  - gap exceeds buffer → session.state{gapDetected:true} (client recovers via history.get in M4)
   */
  private handleRequestState(ws: WsSocket, lastSeenServerSeq: number | null): void {
    if (this.chatSessionId === null || this.registry === null) {
      // No active chat session on this WS connection.
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: null,
        serverSeq: 0,
        gapDetected: false,
      };
      this.sendFrame(ws, payload);
      return;
    }

    const sessionState = this.registry.get(this.chatSessionId);
    if (sessionState === undefined) {
      // Session id set but not found in registry — treat as no session.
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: null,
        serverSeq: 0,
        gapDetected: false,
      };
      this.sendFrame(ws, payload);
      return;
    }

    const { buffer } = sessionState;
    const result = buffer.getSince(lastSeenServerSeq);

    if (result === "GAP_EXCEEDS") {
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: this.chatSessionId,
        serverSeq: buffer.serverSeq,
        gapDetected: true,
      };
      this.sendFrame(ws, payload);
      return;
    }

    // Replay missing entries (idempotent — keep original seq values).
    for (const entry of result) {
      ws.send(JSON.stringify(entry.frame));
    }

    // Then confirm state to client.
    const payload: SessionStatePayload = {
      type: "session.state",
      sessionId: this.chatSessionId,
      serverSeq: buffer.serverSeq,
      gapDetected: false,
    };
    this.sendFrame(ws, payload);
  }

  /**
   * Sends a frame to the client, injecting `seq` and `ts` automatically.
   * `payload` must contain all fields except `seq` and `ts`.
   */
  private sendFrame(ws: WsSocket, payload: PongPayload | SessionStatePayload): void {
    const seq = this.outboundSeq++;
    const ts = Date.now();
    ws.send(JSON.stringify({ ...payload, seq, ts }));
  }

  /**
   * Emits chat.error{code:'BRIDGE_UNAVAILABLE'} when no bridge is configured.
   * Used in development/test mode.
   */
  private sendBridgeUnavailable(ws: WsSocket): void {
    const frame: Omit<ChatError, "seq" | "ts"> = {
      type: "chat.error",
      code: "BRIDGE_UNAVAILABLE",
      message: "No SDK bridge is configured on this server",
    };
    const seq = this.outboundSeq++;
    const ts = Date.now();
    ws.send(JSON.stringify({ ...frame, seq, ts }));
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
