/**
 * Connection.ts — Client-side WebSocket state machine (PR-08).
 *
 * Implements NEW → ALIVE → STALE → DEAD transitions with:
 *   - Per-nonce heartbeat correlation (Map<nonce, sentAt>)
 *   - Per-nonce pong timeouts; STALE grace period
 *   - Connect timeout that also checks native readyState (R4)
 *   - RTT measurement on each matched pong (R3)
 *   - Symmetric hb.sping → hb.spong reply (R11 client side)
 *
 * No reconnect, no pool — those are Manager's job (PR-09).
 */

import type { ServerFrame, ClientHbPing, ClientHbPong } from "@cq/shared";
import { ServerFrame as ServerFrameSchema } from "@cq/shared";

// ---------------------------------------------------------------------------
// Close code for connect timeout (application-level, outside 1000–4000 range)
// ---------------------------------------------------------------------------
/** Application-level close code synthesised when the connect timeout fires. */
export const CLOSE_CONNECT_TIMEOUT = 4003 as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConnectionState = "NEW" | "ALIVE" | "STALE" | "DEAD";

export interface ConnectionStats {
  readonly state: ConnectionState;
  /** Last measured RTT in ms. Null until at least one matched pong arrives. */
  readonly rtt: number | null;
  /** Number of currently-pending client pings (size of the nonce Map). */
  readonly inFlight: number;
  readonly lastCloseCode: number | null;
  readonly lastCloseReason: string;
  /** Cumulative time (ms) spent in ALIVE state. */
  readonly uptimeMs: number;
  /**
   * PR-14: Epoch ms when the oldest in-flight ping was sent.
   * Null when no pings are pending. Used by computeRingRemaining to derive
   * the countdown for the pong-timeout phase.
   */
  readonly oldestPendingPingSentAt: number | null;
  /**
   * PR-14: Epoch ms when this connection first entered the STALE state in
   * its current stint. Null when not STALE. Used by computeRingRemaining
   * to derive the countdown for the stale-grace phase.
   */
  readonly enteredStaleAt: number | null;
  /**
   * PR-14: Epoch ms when this connection entered NEW and began waiting for
   * the open event. Null once the connection leaves NEW. Used by
   * computeRingRemaining to derive the countdown for the connect phase.
   */
  readonly connectedAt: number | null;
}

/**
 * Minimal structural interface for what Connection needs from a WebSocket.
 * Both the native browser `WebSocket` and `MockWebSocket` satisfy this
 * structurally — Connection only needs these members.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: Event | MessageEvent | CloseEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: Event | MessageEvent | CloseEvent) => void,
  ): void;
}

export interface ConnectionOpts {
  url: string;
  /** Interval between client-initiated pings. Default: 15_000 ms. */
  pingIntervalMs?: number;
  /** Timeout per ping nonce before the connection goes STALE. Default: 8_000 ms. */
  pongTimeoutMs?: number;
  /** How long STALE is tolerated before closing (DEAD). Default: 6_000 ms. */
  staleGraceMs?: number;
  /** How long to wait for the initial open event. Default: 10_000 ms. */
  connectTimeoutMs?: number;
  /** Injectable socket factory (default: `new WebSocket(url)`). */
  socketFactory?: (url: string) => SocketLike;
  /** Injectable monotonic clock (default: `Date.now`). */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// Seq counter (monotonically increasing per Connection instance)
// ---------------------------------------------------------------------------

function makeSeqCounter(): () => number {
  let n = 0;
  return () => n++;
}

// ---------------------------------------------------------------------------
// Nonce generation: 16 hex characters
// ---------------------------------------------------------------------------

function generateNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export class Connection {
  // --- configuration --------------------------------------------------------
  private readonly _url: string;
  private readonly _pingIntervalMs: number;
  private readonly _pongTimeoutMs: number;
  private readonly _staleGraceMs: number;
  private readonly _connectTimeoutMs: number;
  private readonly _socketFactory: (url: string) => SocketLike;
  private readonly _clock: () => number;

  // --- state ----------------------------------------------------------------
  private _state: ConnectionState = "NEW";
  private _rtt: number | null = null;
  private _lastCloseCode: number | null = null;
  private _lastCloseReason: string = "";
  private _aliveStart: number | null = null;      // when we entered ALIVE
  private _aliveAccumMs: number = 0;              // uptime before current ALIVE stint

  // --- PR-14: ring countdown fields -----------------------------------------
  /** Epoch ms when this connection first entered NEW (connect-timeout countdown). */
  private readonly _newAt: number;
  /** Epoch ms when this connection entered the STALE state (stale-grace countdown). Null if not yet stale. */
  private _enteredStaleAt: number | null = null;

  // --- socket ---------------------------------------------------------------
  private readonly _socket: SocketLike;

  // --- heartbeat state ------------------------------------------------------
  private _seq: () => number = makeSeqCounter();
  // Map<nonce, sentAt (ms)>
  private readonly _pendingPings: Map<string, number> = new Map();
  // Map<nonce, timeoutId> — per-nonce pong timeout timers
  private readonly _pingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // --- timers ---------------------------------------------------------------
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _staleGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- subscribers ----------------------------------------------------------
  private readonly _updateSubs: Array<(stats: ConnectionStats) => void> = [];
  private readonly _messageSubs: Array<(frame: ServerFrame) => void> = [];

  // --- bound event handlers (kept for removeEventListener) ------------------
  private readonly _onOpen: (e: Event) => void;
  private readonly _onMessage: (e: Event | MessageEvent) => void;
  private readonly _onClose: (e: Event | CloseEvent) => void;
  private readonly _onError: (e: Event) => void;

  constructor(opts: ConnectionOpts) {
    this._url = opts.url;
    this._pingIntervalMs = opts.pingIntervalMs ?? 15_000;
    this._pongTimeoutMs = opts.pongTimeoutMs ?? 8_000;
    this._staleGraceMs = opts.staleGraceMs ?? 6_000;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this._socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url) as SocketLike);
    this._clock = opts.clock ?? (() => Date.now());

    // Record the epoch ms when this connection was created (start of NEW state).
    this._newAt = this._clock();

    // Build handlers once so we can remove them later
    this._onOpen = () => this._handleOpen();
    this._onMessage = (e: Event | MessageEvent) => {
      if (e instanceof MessageEvent) {
        this._handleMessage(e);
      } else if ("data" in e) {
        // duck-typed MessageEvent from MockWebSocket
        this._handleMessage(e as unknown as MessageEvent);
      }
    };
    this._onClose = (e: Event | CloseEvent) => {
      const code = "code" in e ? (e as CloseEvent).code : 1006;
      const reason = "reason" in e ? (e as CloseEvent).reason : "";
      this._handleClose(code, reason);
    };
    this._onError = () => {
      // Errors are followed by close; no additional action required here.
    };

    // Create socket and attach listeners
    this._socket = this._socketFactory(this._url);
    this._socket.addEventListener("open", this._onOpen);
    this._socket.addEventListener("message", this._onMessage);
    this._socket.addEventListener("close", this._onClose);
    this._socket.addEventListener("error", this._onError);

    // Arm connect timeout (R4)
    this._connectTimer = setTimeout(() => {
      if (this._state === "NEW" && this._socket.readyState !== 1 /* OPEN */) {
        this._transitionDead(CLOSE_CONNECT_TIMEOUT, "connect timeout");
      }
    }, this._connectTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get state(): ConnectionState {
    return this._state;
  }

  get stats(): ConnectionStats {
    return this._deriveStats();
  }

  /**
   * Subscribe to stats updates. Returns an unsubscribe function.
   * Callbacks are fired synchronously on every state change, RTT update,
   * or pending-set change.
   */
  onUpdate(cb: (stats: ConnectionStats) => void): () => void {
    this._updateSubs.push(cb);
    return () => {
      const idx = this._updateSubs.indexOf(cb);
      if (idx !== -1) this._updateSubs.splice(idx, 1);
    };
  }

  /**
   * Subscribe to non-heartbeat ServerFrame messages.
   * Returns an unsubscribe function.
   */
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this._messageSubs.push(cb);
    return () => {
      const idx = this._messageSubs.indexOf(cb);
      if (idx !== -1) this._messageSubs.splice(idx, 1);
    };
  }

  /** Close the connection explicitly. Moves to DEAD immediately. */
  close(reason?: string): void {
    if (this._state === "DEAD") return;
    this._transitionDead(1000, reason ?? "closed by application");
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  private _transitionAlive(): void {
    if (this._state === "DEAD") return;
    const wasStale = this._state === "STALE";

    // Clear stale grace timer if recovering from STALE
    if (wasStale) {
      this._clearStaleGraceTimer();
      // PR-14: no longer in STALE
      this._enteredStaleAt = null;
    }

    // Record when we entered ALIVE (for uptime tracking)
    this._aliveStart = this._clock();
    this._state = "ALIVE";
    this._notify();

    // Start ping interval if not already running
    if (this._pingInterval === null) {
      this._pingInterval = setInterval(() => {
        this._sendPing();
      }, this._pingIntervalMs);
    }
  }

  private _transitionStale(): void {
    if (this._state === "DEAD" || this._state === "STALE") return;

    // Accumulate uptime
    if (this._aliveStart !== null) {
      this._aliveAccumMs += this._clock() - this._aliveStart;
      this._aliveStart = null;
    }

    // PR-14: record when we entered STALE for ring countdown
    this._enteredStaleAt = this._clock();

    this._state = "STALE";
    this._notify();

    // Arm stale grace timer
    this._staleGraceTimer = setTimeout(() => {
      this._transitionDead(1006, "stale grace expired");
    }, this._staleGraceMs);
  }

  private _transitionDead(code: number, reason: string): void {
    if (this._state === "DEAD") return;

    // Accumulate uptime
    if (this._aliveStart !== null) {
      this._aliveAccumMs += this._clock() - this._aliveStart;
      this._aliveStart = null;
    }

    this._lastCloseCode = code;
    this._lastCloseReason = reason;
    this._state = "DEAD";

    // Clear all timers
    this._clearAllTimers();

    // Detach socket listeners
    this._socket.removeEventListener("open", this._onOpen);
    this._socket.removeEventListener("message", this._onMessage);
    this._socket.removeEventListener("close", this._onClose);
    this._socket.removeEventListener("error", this._onError);

    // Close socket (idempotent — WebSocket.close() is safe to call multiple times)
    try {
      this._socket.close(code, reason);
    } catch {
      // Ignore errors from close (e.g., already closed)
    }

    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _handleOpen(): void {
    if (this._state !== "NEW") return;

    // Cancel connect timer
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    this._transitionAlive();
  }

  private _handleMessage(e: MessageEvent): void {
    if (this._state === "DEAD") return;

    let data: unknown;
    try {
      data = JSON.parse(e.data as string) as unknown;
    } catch {
      return; // Ignore non-JSON frames
    }

    const result = ServerFrameSchema.safeParse(data);
    if (!result.success) return;

    const frame = result.data;

    if (frame.type === "hb.pong") {
      this._handlePong(frame.echoNonce);
      return;
    }

    if (frame.type === "hb.sping") {
      // R11 client side: reply with hb.spong echoing the nonce
      const spong: ClientHbPong = {
        type: "hb.spong",
        seq: this._seq(),
        ts: this._clock(),
        echoNonce: frame.nonce,
        serverTs: frame.ts,
      };
      try {
        this._socket.send(JSON.stringify(spong));
      } catch {
        // Ignore send errors; the close handler will clean up
      }
      return;
    }

    // Non-heartbeat frame: fan out to onMessage subscribers
    for (const cb of this._messageSubs) {
      cb(frame);
    }
  }

  private _handlePong(echoNonce: string): void {
    if (this._state === "DEAD") return;

    const sentAt = this._pendingPings.get(echoNonce);
    if (sentAt === undefined) {
      // Unknown nonce — ignore (does not promote STALE→ALIVE)
      return;
    }

    // Clear per-nonce timeout
    const timer = this._pingTimers.get(echoNonce);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._pingTimers.delete(echoNonce);
    }

    // Remove from pending set
    this._pendingPings.delete(echoNonce);

    // Measure RTT
    this._rtt = this._clock() - sentAt;

    // Recover from STALE if applicable
    if (this._state === "STALE") {
      this._transitionAlive();
    } else {
      this._notify();
    }
  }

  private _handleClose(code: number, reason: string): void {
    if (this._state === "DEAD") return;
    this._transitionDead(code, reason);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat: client sends hb.ping
  // ---------------------------------------------------------------------------

  private _sendPing(): void {
    if (this._state === "DEAD") return;

    const nonce = generateNonce();
    const sentAt = this._clock();
    const ping: ClientHbPing = {
      type: "hb.ping",
      seq: this._seq(),
      ts: sentAt,
      nonce,
      ackSeq: null,
    };

    try {
      this._socket.send(JSON.stringify(ping));
    } catch {
      return; // Send failed; close handler will handle it
    }

    this._pendingPings.set(nonce, sentAt);

    // Arm per-nonce timeout
    const timerId = setTimeout(() => {
      this._pingTimers.delete(nonce);
      if (this._pendingPings.has(nonce)) {
        // Nonce still pending — go STALE
        this._transitionStale();
      }
    }, this._pongTimeoutMs);
    this._pingTimers.set(nonce, timerId);

    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Stats derivation (V2: derive, never store)
  // ---------------------------------------------------------------------------

  private _deriveStats(): ConnectionStats {
    let uptime = this._aliveAccumMs;
    if (this._state === "ALIVE" && this._aliveStart !== null) {
      uptime += this._clock() - this._aliveStart;
    }

    // PR-14: oldest pending ping sent-at (for pong-timeout countdown)
    let oldestPendingPingSentAt: number | null = null;
    for (const sentAt of this._pendingPings.values()) {
      if (oldestPendingPingSentAt === null || sentAt < oldestPendingPingSentAt) {
        oldestPendingPingSentAt = sentAt;
      }
    }

    return {
      state: this._state,
      rtt: this._rtt,
      inFlight: this._pendingPings.size,
      lastCloseCode: this._lastCloseCode,
      lastCloseReason: this._lastCloseReason,
      uptimeMs: uptime,
      oldestPendingPingSentAt,
      enteredStaleAt: this._enteredStaleAt,
      // connectedAt is the creation time (when NEW state began); null once left NEW
      connectedAt: this._state === "NEW" ? this._newAt : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  private _notify(): void {
    const stats = this._deriveStats();
    for (const cb of this._updateSubs) {
      cb(stats);
    }
  }

  // ---------------------------------------------------------------------------
  // Timer cleanup
  // ---------------------------------------------------------------------------

  private _clearStaleGraceTimer(): void {
    if (this._staleGraceTimer !== null) {
      clearTimeout(this._staleGraceTimer);
      this._staleGraceTimer = null;
    }
  }

  private _clearAllTimers(): void {
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    if (this._pingInterval !== null) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    this._clearStaleGraceTimer();
    // Clear all per-nonce timers
    for (const timerId of this._pingTimers.values()) {
      clearTimeout(timerId);
    }
    this._pingTimers.clear();
    this._pendingPings.clear();
  }
}
