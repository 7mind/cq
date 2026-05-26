import { type ClientHbPond, type ServerHbPing } from "@cq/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PING_INTERVAL_MS = 15_000;
export const DEFAULT_PONG_TIMEOUT_MS = 8_000;
export const NONCE_BYTES = 8; // → 16 hex chars

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

type HeartbeatState = {
  currentNonce: string;
  previousNonce: string | null;
  pingTimerId: ReturnType<typeof setInterval>;
  pendingTimerId: ReturnType<typeof setTimeout> | null;
  pendingFlag: boolean;
};

// ---------------------------------------------------------------------------
// Minimal socket shape — mirrors the subset heartbeat.ts needs
// ---------------------------------------------------------------------------

export type HbSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

// ---------------------------------------------------------------------------
// Heartbeat factory options
// ---------------------------------------------------------------------------

export type HeartbeatOpts = {
  /** Called by WsSession to inject the outbound seq+ts envelope. */
  buildFrame: (payload: Omit<ServerHbPing, "seq" | "ts">) => string;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /**
   * Injected setImmediate — allows tests to intercept the deferral callback
   * (the R11 race test, test 6). Defaults to the global setImmediate.
   */
  setImmediate?: (fn: () => void) => void;
};

export type HeartbeatHandle = {
  start(ws: HbSocket): void;
  stop(ws: HbSocket): void;
  onPong(ws: HbSocket, frame: ClientHbPond): void;
  isAlive(ws: HbSocket): boolean;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHeartbeat(opts: HeartbeatOpts): HeartbeatHandle {
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const scheduleImmediate = opts.setImmediate ?? setImmediate;

  const states = new WeakMap<HbSocket, HeartbeatState>();

  function generateNonce(): string {
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function sendPing(ws: HbSocket, state: HeartbeatState): void {
    // Roll nonces
    state.previousNonce = state.currentNonce;
    state.currentNonce = generateNonce();
    state.pendingFlag = true;

    // Send hb.sping
    const payload: Omit<ServerHbPing, "seq" | "ts"> = {
      type: "hb.sping",
      nonce: state.currentNonce,
    };
    ws.send(opts.buildFrame(payload));

    // Schedule pong-timeout check (with setImmediate deferral per R11)
    if (state.pendingTimerId !== null) {
      clearTimeout(state.pendingTimerId);
    }
    state.pendingTimerId = setTimeout(() => {
      scheduleImmediate(() => {
        if (state.pendingFlag) {
          ws.close(1011, "heartbeat timeout");
        }
      });
      state.pendingTimerId = null;
    }, pongTimeoutMs);
  }

  return {
    start(ws: HbSocket): void {
      const state: HeartbeatState = {
        currentNonce: generateNonce(),
        previousNonce: null,
        pendingFlag: false,
        pendingTimerId: null,
        pingTimerId: setInterval(() => {
          sendPing(ws, state);
        }, pingIntervalMs),
      };
      states.set(ws, state);
    },

    stop(ws: HbSocket): void {
      const state = states.get(ws);
      if (state === undefined) return;
      clearInterval(state.pingTimerId);
      if (state.pendingTimerId !== null) {
        clearTimeout(state.pendingTimerId);
        state.pendingTimerId = null;
      }
      states.delete(ws);
    },

    onPong(ws: HbSocket, frame: ClientHbPond): void {
      const state = states.get(ws);
      if (state === undefined) return;

      const matched =
        frame.echoNonce === state.currentNonce ||
        frame.echoNonce === state.previousNonce;

      if (matched) {
        state.pendingFlag = false;
        if (state.pendingTimerId !== null) {
          clearTimeout(state.pendingTimerId);
          state.pendingTimerId = null;
        }
      }
      // Unknown nonce: ignore (unsolicited pong — legal per RFC 6455 § 5.5.3)
    },

    isAlive(ws: HbSocket): boolean {
      const state = states.get(ws);
      return state !== undefined && !state.pendingFlag;
    },
  };
}
