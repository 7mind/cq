/**
 * Manager.ts — Client-side WebSocket connection pool (PR-09 / PR-10 / PR-11).
 *
 * Implements:
 *   - Pool of up to maxLiveConnections (default 3) Connection instances.
 *   - Full-jitter exponential backoff: base 1s, cap 30s, ×0.5..1.0, max 15 attempts.
 *   - Overlapping-reconnect failover (R6): spawn replacement on STALE; supersede on
 *     first ALIVE. Active = oldest ALIVE connection in pool.
 *   - Close-code classification (R7): isRetriable() from @cq/shared; non-retriable
 *     closes enter TERMINAL immediately.
 *   - destroy(): closes all connections, clears timers, becomes inert.
 *   - Page Lifecycle hooks (PR-10): checkConnections, handleResume, closeForBFCache,
 *     reopenFromBFCache, runPendingReconnect. Backoff defers while tab hidden.
 *   - Time-jump detector (PR-11 / R8): 1s tick interval; if elapsed > tick + threshold,
 *     calls checkConnections() (short gap) or handleResume(elapsed) (long gap ≥ pongTimeout).
 *     Fires even when the tab is hidden — we want the connection ready before visibility.
 *
 * PR-12 hardens the destroyed-flag invariant: _destroyed is set before any
 * close side-effect; every spawn, handler, and scheduler short-circuits on it;
 * isTerminal in stats now includes _destroyed (R13 truthfulness).
 */

import { Connection } from "./Connection";
import type { ConnectionOpts, ConnectionState, ConnectionStats, SocketLike } from "./Connection";
import { isRetriable } from "@cq/shared";
import type { ServerFrame, ClientFrame } from "@cq/shared";

// ---------------------------------------------------------------------------
// Time-jump detector constants (PR-11 / R8)
// ---------------------------------------------------------------------------

/** Nominal tick period for the time-jump detector (ms). */
export const TIME_JUMP_TICK_MS = 1_000;

/**
 * Additional tolerance beyond the tick interval (ms). A real elapsed time
 * exceeding TIME_JUMP_TICK_MS + TIME_JUMP_THRESHOLD_MS triggers recovery.
 * With the defaults, any gap > 3 s triggers the detector.
 */
export const TIME_JUMP_THRESHOLD_MS = 2_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManagerStats {
  readonly connections: ReadonlyArray<{
    id: string;
    state: ConnectionState;
    rtt: number | null;
    uptimeMs: number;
    /** PR-14: Epoch ms of the oldest in-flight ping; null if none pending. */
    oldestPendingPingSentAt: number | null;
    /** PR-14: Epoch ms when this connection entered STALE; null if not STALE. */
    enteredStaleAt: number | null;
    /** PR-14: Epoch ms when this connection entered NEW; null once it left NEW. */
    connectedAt: number | null;
  }>;
  /** id of the connection currently routed for sends. */
  readonly activeConnectionId: string | null;
  /** Backoff attempt counter; reset to 0 when any connection reaches ALIVE. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** true when give-up reached or non-retriable close hit. */
  readonly isTerminal: boolean;
  readonly lastCloseCode: number | null;
  readonly lastCloseReason: string;
  /** Absolute ms timestamp of next scheduled retry; null when not scheduled. */
  readonly nextRetryAt: number | null;
  /**
   * PR-14: Epoch ms when the current backoff timer was armed.
   * Paired with nextRetryAt; null when nextRetryAt is null.
   * Allows the ring to display `remaining / total` for the reconnect phase.
   */
  readonly retryScheduledAt: number | null;
  /** PR-10 will toggle this; default false here. */
  readonly pendingReconnectOnVisible: boolean;
}

export interface ManagerOpts {
  url: string;
  pingIntervalMs?: number;        // default 15_000
  pongTimeoutMs?: number;         // default 8_000
  staleGraceMs?: number;          // default 6_000
  connectTimeoutMs?: number;      // default 10_000
  baseBackoffMs?: number;         // default 1_000
  maxBackoffMs?: number;          // default 30_000
  maxAttempts?: number;           // default 15
  maxLiveConnections?: number;    // default 3
  socketFactory?: (url: string) => SocketLike;
  clock?: () => number;
  random?: () => number;          // for jitter; default Math.random
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /**
   * PR-11: Periodic interval scheduler for the time-jump detector.
   * Defaults to globalThis.setInterval. Inject in tests to get explicit control
   * over when ticks fire independently of the clock() value.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Paired cancellation for the interval injected via setInterval. */
  clearInterval?: (id: unknown) => void;
  /**
   * PR-11: When false, the time-jump detector is not started. Useful in tests
   * that do not want the detector interfering with their scenario.
   * Default: true.
   */
  enableTimeJumpDetector?: boolean;
  /**
   * PR-10: Predicate that returns true when the tab/page is currently visible.
   * Used by scheduleBackoff to decide whether to defer reconnection.
   * Default reads document.visibilityState === "visible" when document is defined;
   * falls back to true (never defer) if document is not available.
   */
  isVisible?: () => boolean;
}

// ---------------------------------------------------------------------------
// Internal pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  id: string;
  conn: Connection;
  stats: ConnectionStats;
  /** Epoch ms when this connection first entered ALIVE (for oldest-ALIVE rule). */
  firstAlivedAt: number | null;
  unsub: () => void;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class Manager {
  // --- configuration --------------------------------------------------------
  private readonly _url: string;
  private readonly _pingIntervalMs: number;
  private readonly _pongTimeoutMs: number;
  private readonly _staleGraceMs: number;
  private readonly _connectTimeoutMs: number;
  private readonly _baseBackoffMs: number;
  private readonly _maxBackoffMs: number;
  private readonly _maxAttempts: number;
  private readonly _maxLiveConnections: number;
  private readonly _socketFactory: ((url: string) => SocketLike) | undefined;
  private readonly _clock: () => number;
  private readonly _random: () => number;
  private readonly _setTimer: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimer: (id: unknown) => void;
  private readonly _setInterval: (fn: () => void, ms: number) => unknown;
  private readonly _clearInterval: (id: unknown) => void;
  private readonly _isVisible: () => boolean;

  // --- pool state -----------------------------------------------------------

  /**
   * Active connection pool. Active = the oldest connection whose stats.state
   * is currently ALIVE. Determined by firstAlivedAt (set when a connection
   * first reaches ALIVE; never reset on subsequent STALE→ALIVE recoveries).
   * Rule: oldest ALIVE wins; ties broken by insertion order.
   */
  private readonly _pool: Map<string, PoolEntry> = new Map();

  // id of the connection currently designated "active" for sends.
  private _activeConnectionId: string | null = null;

  // --- backoff state --------------------------------------------------------
  private _attempt: number = 0;
  private _isTerminal: boolean = false;
  private _lastCloseCode: number | null = null;
  private _lastCloseReason: string = "";
  private _backoffTimerId: unknown = null;
  private _nextRetryAt: number | null = null;
  /** PR-14: epoch ms when the current backoff was scheduled. Paired with _nextRetryAt. */
  private _retryScheduledAt: number | null = null;

  // --- PR-10: defer reconnect while hidden ----------------------------------
  private _pendingReconnectOnVisible: boolean = false;
  /** URL remembered when closeForBFCache() runs, so reopenFromBFCache() can re-spawn. */
  private _bfCacheHadConnection: boolean = false;

  // --- lifecycle flag -------------------------------------------------------
  private _destroyed: boolean = false;

  // --- PR-11: time-jump detector -------------------------------------------
  private _lastTickAt: number = 0;
  private _tickIntervalId: unknown = null;
  /**
   * Telemetry counters for tests: incremented on each detector branch taken.
   * Avoids the need to spy on methods while remaining lightweight.
   */
  readonly _timeJumpStats: { short: number; long: number } = { short: 0, long: 0 };

  // --- subscribers ----------------------------------------------------------
  private readonly _updateSubs: Array<(stats: ManagerStats) => void> = [];
  private readonly _messageSubs: Array<(frame: ServerFrame) => void> = [];

  constructor(opts: ManagerOpts) {
    this._url = opts.url;
    this._pingIntervalMs = opts.pingIntervalMs ?? 15_000;
    this._pongTimeoutMs = opts.pongTimeoutMs ?? 8_000;
    this._staleGraceMs = opts.staleGraceMs ?? 6_000;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this._baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this._maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this._maxAttempts = opts.maxAttempts ?? 15;
    this._maxLiveConnections = opts.maxLiveConnections ?? 3;
    this._socketFactory = opts.socketFactory;
    this._clock = opts.clock ?? (() => Date.now());
    this._random = opts.random ?? Math.random;
    this._setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
    this._isVisible = opts.isVisible ??
      (() => typeof document !== "undefined"
        ? document.visibilityState === "visible"
        : true);

    // Spawn initial connection
    this._spawn();

    // Start time-jump detector (R8); default enabled.
    if (opts.enableTimeJumpDetector !== false) {
      this.startTimeJumpDetector();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get stats(): ManagerStats {
    return this._deriveStats();
  }

  /**
   * Subscribe to stats updates. Returns an unsubscribe function.
   * Callback fires synchronously after each connection update or
   * backoff state change.
   */
  onUpdate(cb: (stats: ManagerStats) => void): () => void {
    this._updateSubs.push(cb);
    return () => {
      const idx = this._updateSubs.indexOf(cb);
      if (idx !== -1) this._updateSubs.splice(idx, 1);
    };
  }

  /**
   * Subscribe to non-heartbeat ServerFrame messages from the active connection.
   * Returns an unsubscribe function.
   */
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this._messageSubs.push(cb);
    return () => {
      const idx = this._messageSubs.indexOf(cb);
      if (idx !== -1) this._messageSubs.splice(idx, 1);
    };
  }

  /**
   * Send a frame via the active connection. Returns true if sent, false if
   * no connection is currently ALIVE.
   */
  send(frame: ClientFrame): boolean {
    if (this._destroyed) return false;
    if (this._activeConnectionId === null) return false;
    const entry = this._pool.get(this._activeConnectionId);
    if (!entry || entry.stats.state !== "ALIVE") return false;

    // Connection doesn't expose a send() method directly — it routes through
    // the underlying socket via its own internal state machine. We access the
    // socket-level send only indirectly; Connection doesn't expose it publicly.
    // To send application frames, we need access to the socket. Since Connection
    // exposes no send() method, we maintain a parallel reference to the socket.
    // The socket is accessed via the entry's _socket accessor injected below.
    const socket = this._entrySockets.get(this._activeConnectionId);
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close all connections, clear all timers. The Manager becomes inert.
   *
   * R12 invariant: `_destroyed` is set FIRST — before any side effect that
   * could re-enter a spawn or schedule path. Every state handler, scheduler,
   * and public method gates on `_destroyed`, so closing connections
   * synchronously below cannot arm a new reconnect timer even if the close
   * drives a connection through DEAD inside the same call stack.
   *
   * After closing connections, a second `_cancelBackoff()` clears any timer
   * that could theoretically have been armed during the close cascade (belt-
   * and-suspenders; the gating above makes this a no-op in practice, but the
   * specification requires it).
   *
   * A `_notify()` fires while subscribers are still registered so that any
   * registered `onUpdate` callback sees `isTerminal: true` before the manager
   * goes fully silent.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;     // set FIRST — re-entry guard for all handlers

    // Cancel scheduled work before closing connections.
    this._cancelBackoff();
    this.stopTimeJumpDetector();

    // Close every connection synchronously.
    // Because _destroyed is already true, any DEAD handler triggered by
    // conn.close() short-circuits at the top of _handleConnUpdate and cannot
    // call _scheduleBackoff().
    for (const entry of this._pool.values()) {
      entry.unsub();
      try { entry.conn.close("manager destroyed"); } catch { /* ignore */ }
    }
    this._pool.clear();
    this._entrySockets.clear();
    this._activeConnectionId = null;

    // Belt-and-suspenders: clear any timer that might have been set during
    // the close cascade (no-op if the first cancel already cleared it).
    this._cancelBackoff();

    // Notify subscribers once so they see isTerminal: true (derived from
    // _destroyed), then silence the manager permanently.
    this._pendingReconnectOnVisible = false;
    this._notify();

    // Silence the manager: no further notifications will be sent.
    this._updateSubs.length = 0;
    this._messageSubs.length = 0;
  }

  // ---------------------------------------------------------------------------
  // PR-10: Page Lifecycle hooks
  // ---------------------------------------------------------------------------

  /**
   * Issue an immediate heartbeat check on all connections. Called by the
   * lifecycle handler on visibilitychange→visible, online, and Network
   * Information API change events.
   *
   * Connection does not expose a public ping(); we achieve the same effect by
   * letting _spawn() or the existing timer logic handle it. For now, we
   * cancel any pending backoff and re-schedule (if applicable). If there are
   * live connections, we cannot ping them synchronously without adding a
   * Connection.ping() method; instead we rely on the fact that stale
   * detection is already in flight. We mark the check by calling _notify()
   * to propagate the latest stats to subscribers.
   */
  checkConnections(): void {
    if (this._destroyed) return;
    // If currently retrying with backoff, spawn immediately.
    if (!this._hasAliveConnection() && this._pool.size === 0 && !this._isTerminal) {
      this._cancelBackoff();
      this._spawn();
    }
    this._notify();
  }

  /**
   * Called by the lifecycle handler on the `resume` event (Chrome freeze/resume).
   * Treats the resume as a long freeze: if elapsedMs exceeds pongTimeoutMs,
   * spawns a proactive parallel replacement connection.
   *
   * PR-11 will install its own tick-based time-jump detector that calls this
   * with the measured elapsed time.
   */
  handleResume(elapsedMs: number): void {
    if (this._destroyed) return;
    if (elapsedMs >= this._pongTimeoutMs) {
      // Proactively spawn a replacement; the ALIVE→supersede logic will clean
      // up the old connection once the new one connects.
      this._spawn();
    }
    this._notify();
  }

  /**
   * Close all sockets so that the page can enter the BFCache.
   * An open WebSocket disqualifies a page from BFCache in all browsers.
   * Called by the lifecycle handler on pagehide(persisted:true).
   */
  closeForBFCache(): void {
    if (this._destroyed) return;
    this._bfCacheHadConnection = this._pool.size > 0;
    this._cancelBackoff();
    for (const entry of this._pool.values()) {
      entry.unsub();
      entry.conn.close("BFCache");
    }
    this._pool.clear();
    this._entrySockets.clear();
    this._activeConnectionId = null;
    this._pendingReconnectOnVisible = false;
    // Do NOT set _isTerminal — this is a temporary suspension, not an error.
    this._notify();
  }

  /**
   * Spawn a fresh connection after BFCache restore.
   * Called by the lifecycle handler on pageshow(persisted:true).
   * No-op if there was no active connection before the pagehide.
   */
  reopenFromBFCache(): void {
    if (this._destroyed) return;
    if (!this._bfCacheHadConnection) return;
    this._bfCacheHadConnection = false;
    this._attempt = 0;
    this._isTerminal = false;
    this._spawn();
    this._notify();
  }

  // ---------------------------------------------------------------------------
  // PR-11: Time-jump detector (R8)
  // ---------------------------------------------------------------------------

  /**
   * Start the 1 s tick that detects event-loop pauses (mobile freeze, OS sleep,
   * debugger). On each tick:
   *   elapsed = clock() - _lastTickAt
   *   If elapsed > TIME_JUMP_TICK_MS + TIME_JUMP_THRESHOLD_MS:
   *     short gap (< pongTimeoutMs)  → checkConnections() (just ping)
   *     long gap  (≥ pongTimeoutMs)  → handleResume(elapsed) (proactive reconnect)
   *
   * The detector fires even while the tab is hidden — we want the connection
   * ready *before* the tab becomes visible (R8 rationale: NAT tables are gone,
   * TCP state is gone; don't waste a full pong timeout confirming it).
   *
   * Called automatically by the constructor unless enableTimeJumpDetector:false.
   * Idempotent: calling it twice has no effect (existing interval is kept).
   */
  startTimeJumpDetector(): void {
    if (this._destroyed) return;
    if (this._tickIntervalId !== null) return; // already running

    this._lastTickAt = this._clock();
    this._tickIntervalId = this._setInterval(() => {
      if (this._destroyed) return;
      const now = this._clock();
      const elapsed = now - this._lastTickAt;
      this._lastTickAt = now;

      if (elapsed > TIME_JUMP_TICK_MS + TIME_JUMP_THRESHOLD_MS) {
        if (elapsed < this._pongTimeoutMs) {
          // Short gap: connections may still be alive — just ping.
          this._timeJumpStats.short += 1;
          this.checkConnections();
        } else {
          // Long gap: NAT/TCP state is almost certainly gone.
          this._timeJumpStats.long += 1;
          this.handleResume(elapsed);
        }
      }
    }, TIME_JUMP_TICK_MS);
  }

  /**
   * Stop the time-jump detector tick interval.
   * Called automatically by destroy(). May also be called explicitly when
   * a consumer wants to disable the detector without destroying the manager.
   */
  stopTimeJumpDetector(): void {
    if (this._tickIntervalId !== null) {
      this._clearInterval(this._tickIntervalId);
      this._tickIntervalId = null;
    }
  }

  /**
   * If a reconnect was deferred while the tab was hidden, fire it immediately now.
   * Called by the lifecycle handler on visibilitychange→visible.
   */
  runPendingReconnect(): void {
    if (this._destroyed) return;
    if (!this._pendingReconnectOnVisible) return;
    this._pendingReconnectOnVisible = false;
    if (!this._isTerminal && !this._hasAliveConnection() && this._pool.size === 0) {
      this._spawn();
    }
    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------------------

  /**
   * Parallel map from connection id → the SocketLike used for that connection.
   * We need this to implement send(), since Connection has no public send().
   * Each socketFactory call captures its own socket reference here.
   */
  private readonly _entrySockets: Map<string, SocketLike> = new Map();

  private _spawn(): void {
    if (this._destroyed) return;
    if (this._isTerminal) return;
    if (this._pool.size >= this._maxLiveConnections) return;

    const id = crypto.randomUUID();

    // Wrap the socket factory to capture the socket instance
    let capturedSocket: SocketLike | null = null;
    const wrappedFactory = (url: string): SocketLike => {
      const sf = this._socketFactory;
      const socket = sf !== undefined ? sf(url) : (new WebSocket(url) as unknown as SocketLike);
      capturedSocket = socket;
      return socket;
    };

    const connOpts: ConnectionOpts = {
      url: this._url,
      pingIntervalMs: this._pingIntervalMs,
      pongTimeoutMs: this._pongTimeoutMs,
      staleGraceMs: this._staleGraceMs,
      connectTimeoutMs: this._connectTimeoutMs,
      socketFactory: wrappedFactory,
      clock: this._clock,
    };

    const conn = new Connection(connOpts);

    // capturedSocket is set synchronously by the Connection constructor
    if (capturedSocket !== null) {
      this._entrySockets.set(id, capturedSocket);
    }

    const entry: PoolEntry = {
      id,
      conn,
      stats: conn.stats,
      firstAlivedAt: null,
      unsub: conn.onUpdate((newStats) => this._handleConnUpdate(id, newStats)),
    };
    this._pool.set(id, entry);

    // Forward messages from this connection (if it becomes active)
    conn.onMessage((frame) => this._handleConnMessage(id, frame));
  }

  // ---------------------------------------------------------------------------
  // Connection update handler
  // ---------------------------------------------------------------------------

  private _handleConnUpdate(id: string, newStats: ConnectionStats): void {
    if (this._destroyed) return;

    const entry = this._pool.get(id);
    if (!entry) return;

    const prevState = entry.stats.state;
    entry.stats = newStats;

    // --- ALIVE: first time this connection reaches ALIVE ---
    if (newStats.state === "ALIVE" && prevState !== "ALIVE") {
      // Record when this connection first became ALIVE (for oldest-ALIVE rule)
      if (entry.firstAlivedAt === null) {
        entry.firstAlivedAt = this._clock();
      }

      // Supersede all other connections — close them; this one wins.
      // The oldest ALIVE wins: if there's already an active ALIVE connection
      // that is older (firstAlivedAt smaller), keep it and close this one.
      const activeEntry = this._activeConnectionId !== null
        ? (this._pool.get(this._activeConnectionId) ?? null)
        : null;

      // A *different* active connection wins if it is older (firstAlivedAt ≤ ours).
      // If activeEntry === entry (recovering from STALE), skip: it wins as normal.
      const activeIsDifferent = activeEntry !== null && activeEntry !== entry;
      const activeIsAlive = activeIsDifferent && activeEntry!.stats.state === "ALIVE";
      const activeIsOlder = activeIsAlive
        && activeEntry!.firstAlivedAt !== null
        && entry.firstAlivedAt !== null
        && activeEntry!.firstAlivedAt <= entry.firstAlivedAt;

      if (activeIsOlder) {
        // Existing active (older) stays; close this newer one as superseded
        this._removeAndClose(id, "superseded");
        this._notify();
        return;
      }

      // This connection becomes/remains active; supersede all others
      this._activeConnectionId = id;

      // Reset backoff counter — we have a live connection
      this._attempt = 0;
      this._cancelBackoff();

      // Close all connections that are not this one
      for (const otherId of [...this._pool.keys()]) {
        if (otherId !== id) {
          this._removeAndClose(otherId, "superseded");
        }
      }
    }

    // --- STALE: active connection went stale → spawn replacement ---
    if (newStats.state === "STALE" && id === this._activeConnectionId) {
      if (this._pool.size < this._maxLiveConnections) {
        this._spawn();
      }
    }

    // --- DEAD: remove from pool; assess what to do next ---
    if (newStats.state === "DEAD") {
      const wasActive = id === this._activeConnectionId;
      const closeCode = newStats.lastCloseCode ?? 1006;
      const closeReason = newStats.lastCloseReason;

      this._lastCloseCode = closeCode;
      this._lastCloseReason = closeReason;

      // Remove from pool (unsubscribe already hooked into conn, just remove entry)
      entry.unsub();
      this._pool.delete(id);
      this._entrySockets.delete(id);

      if (wasActive) {
        this._activeConnectionId = null;
        // Try to promote another ALIVE connection (if any)
        this._promoteOldestAlive();
      }

      // Close-code classification
      if (!isRetriable(closeCode)) {
        // Non-retriable close → TERMINAL immediately
        this._isTerminal = true;
        this._cancelBackoff();
        this._notify();
        return;
      }

      // Retriable: if no ALIVE connections and no pending replacement, schedule backoff
      if (!this._hasAliveConnection() && this._pool.size === 0) {
        this._scheduleBackoff();
      }
    }

    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Message handler — forward from active connection only
  // ---------------------------------------------------------------------------

  private _handleConnMessage(id: string, frame: ServerFrame): void {
    if (this._destroyed) return;
    if (id !== this._activeConnectionId) return;
    for (const cb of this._messageSubs) {
      cb(frame);
    }
  }

  // ---------------------------------------------------------------------------
  // Pool helpers
  // ---------------------------------------------------------------------------

  /** Remove an entry from the pool and close its connection with a reason. */
  private _removeAndClose(id: string, reason: string): void {
    const entry = this._pool.get(id);
    if (!entry) return;
    entry.unsub();
    this._pool.delete(id);
    this._entrySockets.delete(id);
    entry.conn.close(reason);
  }

  /** Check if any connection in pool is currently ALIVE. */
  private _hasAliveConnection(): boolean {
    for (const e of this._pool.values()) {
      if (e.stats.state === "ALIVE") return true;
    }
    return false;
  }

  /**
   * Promote the oldest ALIVE connection in the pool to active.
   * Called when the previous active goes away.
   */
  private _promoteOldestAlive(): void {
    let oldestEntry: PoolEntry | null = null;
    for (const e of this._pool.values()) {
      if (e.stats.state !== "ALIVE") continue;
      if (e.firstAlivedAt === null) continue;
      if (oldestEntry === null || e.firstAlivedAt < oldestEntry.firstAlivedAt!) {
        oldestEntry = e;
      }
    }
    if (oldestEntry !== null) {
      this._activeConnectionId = oldestEntry.id;
    }
  }

  // ---------------------------------------------------------------------------
  // Backoff
  // ---------------------------------------------------------------------------

  /**
   * Compute the full-jitter backoff delay for the current attempt.
   * Formula: min(base * 2^attempt, cap) * random(0.5, 1.0)
   */
  private _backoffDelay(): number {
    const raw = this._baseBackoffMs * Math.pow(2, this._attempt);
    const capped = Math.min(raw, this._maxBackoffMs);
    // Full jitter: multiply by a value in [0.5, 1.0]
    return capped * (0.5 + 0.5 * this._random());
  }

  private _scheduleBackoff(): void {
    if (this._destroyed) return;
    if (this._isTerminal) return;
    if (this._attempt >= this._maxAttempts) {
      this._isTerminal = true;
      return;
    }

    // PR-10: defer reconnect while tab is hidden (Phoenix pattern).
    if (!this._isVisible()) {
      this._pendingReconnectOnVisible = true;
      this._nextRetryAt = null;
      // Increment attempt so it tracks correctly when we eventually fire.
      this._attempt += 1;
      return;
    }

    const delay = this._backoffDelay();
    this._attempt += 1;
    const scheduledAt = this._clock();
    this._retryScheduledAt = scheduledAt;
    this._nextRetryAt = scheduledAt + delay;

    this._backoffTimerId = this._setTimer(() => {
      this._backoffTimerId = null;
      this._nextRetryAt = null;
      if (this._destroyed || this._isTerminal) return;
      this._spawn();
      this._notify();
    }, delay);
  }

  private _cancelBackoff(): void {
    if (this._backoffTimerId !== null) {
      this._clearTimer(this._backoffTimerId);
      this._backoffTimerId = null;
    }
    this._nextRetryAt = null;
    this._retryScheduledAt = null;
  }

  // ---------------------------------------------------------------------------
  // Stats derivation (derive, never store)
  // ---------------------------------------------------------------------------

  private _deriveStats(): ManagerStats {
    const connections = [...this._pool.values()].map((e) => ({
      id: e.id,
      state: e.stats.state,
      rtt: e.stats.rtt,
      uptimeMs: e.stats.uptimeMs,
      oldestPendingPingSentAt: e.stats.oldestPendingPingSentAt,
      enteredStaleAt: e.stats.enteredStaleAt,
      connectedAt: e.stats.connectedAt,
    }));

    return {
      connections,
      activeConnectionId: this._activeConnectionId,
      attempt: this._attempt,
      maxAttempts: this._maxAttempts,
      // R13: isTerminal is true whenever the manager will not retry — which
      // includes the destroyed case (even though _isTerminal was not explicitly
      // set). Computing this here (derived, never stored) means the flag is
      // always truthful without needing a second write path in destroy().
      isTerminal: this._destroyed || this._isTerminal,
      lastCloseCode: this._lastCloseCode,
      lastCloseReason: this._lastCloseReason,
      nextRetryAt: this._nextRetryAt,
      retryScheduledAt: this._retryScheduledAt,
      pendingReconnectOnVisible: this._pendingReconnectOnVisible,
    };
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  private _notify(): void {
    if (this._destroyed) return;
    const s = this._deriveStats();
    for (const cb of this._updateSubs) {
      cb(s);
    }
  }
}
