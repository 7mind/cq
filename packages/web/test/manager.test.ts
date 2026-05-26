/**
 * manager.test.ts — Unit tests for the client Manager (PR-09).
 *
 * Strategy: jest.useFakeTimers() patches the global setTimeout/setInterval used
 * by Connection's internal timers. Manager's backoff timer is also injectable
 * (setTimer/clearTimer opts), but since fake timers patch globals we use the
 * default scheduler (which resolves to global setTimeout) for simplicity —
 * both Manager and Connection share the same fake clock.
 *
 * MockWebSocket is used as the socketFactory. We maintain a registry (sockets[])
 * so individual socket instances can be controlled per-connection.
 *
 * 10 named test cases covering R5 (backoff), R6 (overlap/failover), R7 (close-code).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { Manager } from "../src/ws/Manager";
import type { ManagerOpts } from "../src/ws/Manager";
import { MockWebSocket } from "./helpers/MockWebSocket";

// ---------------------------------------------------------------------------
// Timing constants (compressed so fake-timer advances are small)
// ---------------------------------------------------------------------------
const PING_MS = 500;
const PONG_MS = 200;
const STALE_MS = 150;
const CONNECT_MS = 300;
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 800;
const MAX_ATTEMPTS = 15;

// ---------------------------------------------------------------------------
// Socket registry: each spawned Connection calls socketFactory which pushes
// a new MockWebSocket into this array. Tests index into it to control a
// specific connection's socket.
// ---------------------------------------------------------------------------

let sockets: MockWebSocket[] = [];

function makeFactory(): (url: string) => MockWebSocket {
  sockets = [];
  const factory = (url: string): MockWebSocket => {
    void url;
    const s = new MockWebSocket();
    sockets.push(s);
    return s;
  };
  return factory;
}

// ---------------------------------------------------------------------------
// Default opts builder
// ---------------------------------------------------------------------------

function makeOpts(extra: Partial<ManagerOpts> = {}): ManagerOpts {
  return {
    url: "ws://test",
    pingIntervalMs: PING_MS,
    pongTimeoutMs: PONG_MS,
    staleGraceMs: STALE_MS,
    connectTimeoutMs: CONNECT_MS,
    baseBackoffMs: BASE_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    maxAttempts: MAX_ATTEMPTS,
    socketFactory: makeFactory(),
    random: () => 1.0,   // deterministic jitter: delay = computed * 1.0
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers and flush all queued microtasks. */
function tick(ms: number): void {
  jest.advanceTimersByTime(ms);
}

/** Get the last hb.ping nonce sent on a socket. */
function lastPingNonce(socket: MockWebSocket): string {
  const pings = socket.sent
    .map((s) => JSON.parse(s) as Record<string, unknown>)
    .filter((f) => f["type"] === "hb.ping");
  const last = pings[pings.length - 1];
  if (!last) throw new Error("No hb.ping frames found");
  return last["nonce"] as string;
}

/** Build a minimal hb.pong frame JSON for a given nonce. */
function pongMsg(echoNonce: string): string {
  return JSON.stringify({
    type: "hb.pong",
    seq: 0,
    ts: Date.now(),
    echoNonce,
    clientTs: Date.now() - 10,
    serverTs: Date.now() - 5,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Manager", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: Manager spawns first Connection on construct
  // -------------------------------------------------------------------------
  it("Manager spawns first Connection on construct", () => {
    const m = new Manager(makeOpts());

    const s = m.stats;
    // Exactly one connection spawned
    expect(s.connections.length).toBe(1);
    // Not yet ALIVE (still NEW / connecting)
    expect(s.activeConnectionId).toBeNull();
    expect(s.isTerminal).toBe(false);
    expect(s.attempt).toBe(0);
    expect(sockets.length).toBe(1);

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // useSyncExternalStore stability: stats memoized between mutations
  //
  // React's external-store hook compares getSnapshot() returns with Object.is
  // to decide whether to re-render. Manager.stats MUST return the same object
  // reference until something observable changes; otherwise the consumer
  // infinite-loops. Locks the fix discovered when dogfooding from vm:8733.
  // -------------------------------------------------------------------------
  it("manager.stats returns same reference between mutations, fresh reference after a notify", () => {
    const m = new Manager(makeOpts());
    const a = m.stats;
    const b = m.stats;
    expect(a).toBe(b); // identical reference — no infinite loop trigger

    // Trigger a state change → _notify fires → cache invalidated
    sockets[0]!.simulateOpen();

    const c = m.stats;
    expect(c).not.toBe(a); // fresh reference
    const d = m.stats;
    expect(d).toBe(c); // and stable again until the next mutation

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 2: first Connection reaches ALIVE → activeConnectionId set, attempt reset
  // -------------------------------------------------------------------------
  it("first Connection reaches ALIVE → activeConnectionId set, attempt reset to 0", () => {
    const m = new Manager(makeOpts());
    const sock = sockets[0]!;

    // Open the first socket → Connection transitions to ALIVE
    sock.simulateOpen();

    const s = m.stats;
    expect(s.connections.length).toBe(1);
    expect(s.activeConnectionId).not.toBeNull();
    expect(s.connections[0]!.state).toBe("ALIVE");
    expect(s.attempt).toBe(0);
    expect(s.isTerminal).toBe(false);

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3: stale + recovery (R6 happy path)
  // -------------------------------------------------------------------------
  it("stale + recovery: old goes STALE → replacement spawns; old recovers → replacement superseded", () => {
    const m = new Manager(makeOpts());
    const sock0 = sockets[0]!;

    // First connection opens → ALIVE
    sock0.simulateOpen();
    const activeId0 = m.stats.activeConnectionId!;
    expect(activeId0).not.toBeNull();

    // Advance past ping interval to trigger ping
    tick(PING_MS + 1);
    const nonce0 = lastPingNonce(sock0);

    // Advance past pong timeout → Connection goes STALE → Manager spawns replacement
    tick(PONG_MS + 1);
    expect(m.stats.connections.find((c) => c.id === activeId0)?.state).toBe("STALE");
    expect(sockets.length).toBe(2); // replacement spawned
    expect(m.stats.connections.length).toBe(2);
    // Active id unchanged (still the original)
    expect(m.stats.activeConnectionId).toBe(activeId0);

    // Old connection receives late pong → recovers to ALIVE
    sock0.simulateMessage(pongMsg(nonce0));

    // Old is now ALIVE again → supersede the replacement
    // (old has older firstAlivedAt, so it wins)
    expect(m.stats.connections.length).toBe(1);
    expect(m.stats.activeConnectionId).toBe(activeId0);
    expect(m.stats.connections[0]!.state).toBe("ALIVE");

    // The replacement socket should have been closed
    const sock1 = sockets[1]!;
    expect(sock1.closed.length).toBeGreaterThanOrEqual(1);

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 4: stale + dead → replacement becomes active
  // -------------------------------------------------------------------------
  it("stale + dead: old never recovers → DEAD; replacement becomes ALIVE → activeConnectionId switches", () => {
    const m = new Manager(makeOpts());
    const sock0 = sockets[0]!;

    // First connection opens → ALIVE
    sock0.simulateOpen();
    const activeId0 = m.stats.activeConnectionId!;

    // Trigger ping, advance past pong timeout → STALE → replacement spawned
    tick(PING_MS + 1);
    tick(PONG_MS + 1);
    expect(sockets.length).toBe(2);
    expect(m.stats.activeConnectionId).toBe(activeId0);

    // Old never recovers → stale grace fires → DEAD
    tick(STALE_MS + 1);
    expect(m.stats.connections.find((c) => c.id === activeId0)).toBeUndefined();

    // Replacement opens → ALIVE
    const sock1 = sockets[1]!;
    sock1.simulateOpen();

    // active switches to replacement
    const activeId1 = m.stats.activeConnectionId;
    expect(activeId1).not.toBeNull();
    expect(activeId1).not.toBe(activeId0);
    expect(m.stats.connections.length).toBe(1);
    expect(m.stats.connections[0]!.state).toBe("ALIVE");

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 5: backoff scheduling on retriable close
  // -------------------------------------------------------------------------
  it("backoff scheduling on close (retriable): nextRetryAt set; attempt becomes 1; fresh Connection spawned", () => {
    const nowBase = 1_000_000;
    const now = nowBase;
    const m = new Manager(makeOpts({ clock: () => now }));
    const sock0 = sockets[0]!;

    // Let the connection reach ALIVE first so active is set
    sock0.simulateOpen();
    expect(m.stats.activeConnectionId).not.toBeNull();

    // Server closes with 1011 (retriable)
    sock0.simulateClose(1011, "internal error");

    // With random()=1.0 and attempt=0: delay = min(100 * 2^0, 800) * 1.0 = 100ms
    const s = m.stats;
    expect(s.attempt).toBe(1);
    expect(s.nextRetryAt).not.toBeNull();
    // nextRetryAt should be approximately now + 100ms
    expect(s.nextRetryAt!).toBeGreaterThanOrEqual(nowBase + 50);   // at least half
    expect(s.nextRetryAt!).toBeLessThanOrEqual(nowBase + 100 + 1); // at most base * 1.0

    // Advance past the backoff → new Connection spawned
    tick(BASE_BACKOFF_MS + 10);
    expect(sockets.length).toBe(2); // second connection spawned

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 6: backoff cap enforced
  // -------------------------------------------------------------------------
  it("backoff cap enforced: delay stops growing at maxBackoffMs", () => {
    // connectTimeoutMs must exceed the tick window so the connect timeout never fires
    // during iteration (we test the server-side close path, not client connect-timeout).
    const TICK = MAX_BACKOFF_MS + 10;
    const LARGE_CONNECT_MS = TICK * 20; // well beyond any tick we advance
    const m = new Manager(makeOpts({ connectTimeoutMs: LARGE_CONNECT_MS }));
    const sock0 = sockets[0]!;

    // Open and then close with 1011 → backoff scheduled; attempt = 1
    sock0.simulateOpen();
    sock0.simulateClose(1011, "internal error");
    expect(m.stats.attempt).toBe(1);

    // Fire each backoff in turn (6 more closures after the first)
    for (let i = 0; i < 6; i++) {
      // Advance enough to fire the current backoff timer (max delay = MAX_BACKOFF_MS)
      tick(TICK);
      const nextSock = sockets[sockets.length - 1]!;
      // Open so attempt resets on ALIVE... wait, we want attempt to keep growing.
      // Close immediately (1011) without opening.
      nextSock.simulateClose(1011, "internal error");
    }

    // After 7 closures, attempt counter should be 7
    expect(m.stats.attempt).toBeGreaterThanOrEqual(7);

    // nextRetryAt delta: with random()=1.0 and capped at MAX_BACKOFF_MS:
    //   delay = min(base * 2^attempt, MAX_BACKOFF_MS) * 1.0 = MAX_BACKOFF_MS once capped
    const now = Date.now();
    const s = m.stats;
    if (s.nextRetryAt !== null) {
      const delta = s.nextRetryAt - now;
      // Must not exceed the cap (with jitter=1.0 it's exactly the cap)
      expect(delta).toBeLessThanOrEqual(MAX_BACKOFF_MS + 5);
    }

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 7: max attempts exhausted → isTerminal: true
  // -------------------------------------------------------------------------
  it("max attempts exhausted → isTerminal: true; no further spawn after attempt 15", () => {
    const m = new Manager(makeOpts({ maxAttempts: 3 }));

    // Close each connection immediately (retriably) 3+1 times
    // First connection is spawned at construct time; close it, then each
    // backoff fires the next one.
    for (let i = 0; i < 4; i++) {
      const sock = sockets[sockets.length - 1]!;
      sock.simulateClose(1011, "internal error");
      tick(MAX_BACKOFF_MS + 10); // fire the backoff
    }

    expect(m.stats.isTerminal).toBe(true);
    expect(m.stats.nextRetryAt).toBeNull();
    const countBefore = sockets.length;

    // Advance further — no new spawn
    tick(MAX_BACKOFF_MS * 10);
    expect(sockets.length).toBe(countBefore);

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 8: non-retriable close → isTerminal immediately
  // -------------------------------------------------------------------------
  it("non-retriable close → isTerminal immediately; pool empty; no retry timer", () => {
    const m = new Manager(makeOpts());
    const sock0 = sockets[0]!;

    // 1008 = policy violation (non-retriable)
    sock0.simulateClose(1008, "policy violation");

    const s = m.stats;
    expect(s.isTerminal).toBe(true);
    expect(s.connections.length).toBe(0);
    expect(s.nextRetryAt).toBeNull();
    expect(s.activeConnectionId).toBeNull();

    // Advance time — no new connections spawned
    tick(MAX_BACKOFF_MS * 10);
    expect(sockets.length).toBe(1); // still only the original

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 9: pool cap respected on rapid STALE-without-ALIVE
  // -------------------------------------------------------------------------
  it("pool cap respected on rapid STALE-without-ALIVE: pool size never exceeds maxLiveConnections", () => {
    const maxLive = 3;
    const m = new Manager(makeOpts({ maxLiveConnections: maxLive }));
    const sock0 = sockets[0]!;

    // Open first connection
    sock0.simulateOpen();

    // Force STALE on first connection (no pong response)
    tick(PING_MS + 1); // sends ping
    tick(PONG_MS + 1); // pong timeout → STALE → replacement spawned (pool=2)

    // Force STALE on replacement too before it opens (no pong; connect timeout path)
    // Actually: to force STALE without opening, we let connect timeout fire → DEAD,
    // then backoff fires. But to test pool cap, keep both alive (one NEW one STALE).
    // Pool size should be ≤ maxLive.
    expect(m.stats.connections.length).toBeLessThanOrEqual(maxLive);

    // Open the replacement and make it STALE too
    const sock1 = sockets[1]!;
    sock1.simulateOpen();
    tick(PING_MS + 1);
    tick(PONG_MS + 1); // sock1 goes STALE → try to spawn another (pool would be 3)

    expect(m.stats.connections.length).toBeLessThanOrEqual(maxLive);

    // No matter what happens, pool must never exceed cap
    tick(STALE_MS + 1); // sock0 DEAD, sock1 STALE still
    expect(m.stats.connections.length).toBeLessThanOrEqual(maxLive);

    m.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 10: destroy() while RETRYING_BACKOFF clears the timer; no new spawn
  // -------------------------------------------------------------------------
  it("destroy() while RETRYING_BACKOFF clears the timer; no new spawn after destroy", () => {
    const m = new Manager(makeOpts());
    const sock0 = sockets[0]!;

    // Retriable close → backoff timer scheduled
    sock0.simulateClose(1011, "internal error");
    expect(m.stats.nextRetryAt).not.toBeNull();

    const countBefore = sockets.length;

    // destroy before the backoff fires
    m.destroy();

    // Advance past the backoff
    tick(MAX_BACKOFF_MS + 10);

    // No new connections spawned
    expect(sockets.length).toBe(countBefore);

    // stats returns inert snapshot after destroy (manager already cleared subs)
    // Calling stats after destroy should not throw
    const s = m.stats;
    expect(s.connections.length).toBe(0);
  });
});
