/**
 * heartbeat.test.ts — Unit tests for the server-side heartbeat (PR-07).
 *
 * All 6 required cases:
 *  1. Server sends hb.sping on schedule.
 *  2. Current-nonce hb.spong clears pendingFlag → connection NOT closed.
 *  3. Previous-nonce hb.spong clears pendingFlag (one-tick lookback).
 *  4. Unknown nonce hb.spong is ignored; pendingFlag stays set.
 *  5. No pong → close 1011 within window.
 *  6. setImmediate defer: pong clearing pendingFlag before queued check runs
 *     prevents the 1011 close (explicit R11 race test).
 *
 * Uses compressed timers (pingIntervalMs: 100, pongTimeoutMs: 50) plus the
 * injected setImmediate seam for test 6 so all tests complete in ≤ 1 s each.
 * Bun's jest.useFakeTimers() is NOT used here because the setImmediate
 * injection seam gives us more precise control over the R11 race; compressed
 * real timers are simpler and more reliable for the other cases.
 */

import { describe, it, expect } from "bun:test";
import {
  createHeartbeat,
  type HeartbeatOpts,
  type HbSocket,
} from "../src/ws/heartbeat";
import type { ClientHbPond } from "@cq/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CloseRecord = { code: number; reason: string };

/** Build a minimal HbSocket stub that records calls. */
function makeSocket(): HbSocket & {
  sent: string[];
  closedWith: CloseRecord[];
} {
  return {
    sent: [],
    closedWith: [],
    send(data: string) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      this.closedWith.push({ code: code ?? 1000, reason: reason ?? "" });
    },
  };
}

/** Build a ClientHbPond (hb.spong) frame. */
function spong(echoNonce: string): ClientHbPond {
  return {
    type: "hb.spong",
    seq: 0,
    ts: Date.now(),
    echoNonce,
    serverTs: Date.now(),
  };
}

/** Shared compressed opts (no setImmediate override). */
const compressedOpts: Partial<HeartbeatOpts> = {
  pingIntervalMs: 100,
  pongTimeoutMs: 50,
};

/** Sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("heartbeat", () => {
  // -------------------------------------------------------------------------
  // Test 1: server sends hb.sping on schedule
  // -------------------------------------------------------------------------
  it("server sends hb.sping on schedule (≥2 frames in 250 ms with 100 ms interval)", async () => {
    const sock = makeSocket();

    const hb = createHeartbeat({
      ...compressedOpts,
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
    });
    hb.start(sock);

    await sleep(250);
    hb.stop(sock);

    // Should have received ≥2 hb.sping frames
    const spings = sock.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((f) => f["type"] === "hb.sping");
    expect(spings.length).toBeGreaterThanOrEqual(2);

    // Each nonce should be a 16-char hex string
    for (const f of spings) {
      expect(typeof f["nonce"]).toBe("string");
      expect((f["nonce"] as string).length).toBe(16);
    }

    // Consecutive pings should have distinct nonces
    if (spings.length >= 2) {
      expect(spings[0]!["nonce"]).not.toBe(spings[1]!["nonce"]);
    }
  }, 2_000);

  // -------------------------------------------------------------------------
  // Test 2: current-nonce pong clears pending → WS stays open
  // -------------------------------------------------------------------------
  it("current-nonce hb.spong clears pendingFlag; connection is not closed", async () => {
    const sock = makeSocket();

    const hb = createHeartbeat({
      ...compressedOpts,
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
    });
    hb.start(sock);

    // Wait for first ping
    await sleep(120);
    expect(sock.sent.length).toBeGreaterThanOrEqual(1);

    const pingFrame = JSON.parse(sock.sent[0]!) as { type: string; nonce: string };
    expect(pingFrame.type).toBe("hb.sping");

    // Reply with matching spong
    hb.onPong(sock, spong(pingFrame.nonce));

    // Wait past pong timeout — connection must still be open
    await sleep(100);
    expect(sock.closedWith.length).toBe(0);

    hb.stop(sock);
  }, 2_000);

  // -------------------------------------------------------------------------
  // Test 3: previous-nonce pong clears pending (one-tick lookback)
  // -------------------------------------------------------------------------
  it("previous-nonce hb.spong clears pendingFlag (one-tick lookback)", async () => {
    const sock = makeSocket();

    const hb = createHeartbeat({
      ...compressedOpts,
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
    });
    hb.start(sock);

    // Wait for first ping (nonce A)
    await sleep(120);
    const firstPing = JSON.parse(sock.sent[0]!) as { nonce: string };
    const nonceA = firstPing.nonce;

    // Respond to ping A so its pong-timer is cancelled
    hb.onPong(sock, spong(nonceA));

    // Wait for second ping (nonce B); current=B, previous=A
    await sleep(120);
    expect(sock.sent.length).toBeGreaterThanOrEqual(2);

    // Simulated server-stall / late pong scenario: client echoes nonce A
    // (the previous nonce) instead of nonce B.
    // The server must accept it (one-tick lookback) and NOT close.
    hb.onPong(sock, spong(nonceA));

    // Wait past pong timeout — connection must still be open
    await sleep(100);
    expect(sock.closedWith.length).toBe(0);

    hb.stop(sock);
  }, 2_000);

  // -------------------------------------------------------------------------
  // Test 4: unknown nonce pong is ignored; pendingFlag remains
  // -------------------------------------------------------------------------
  it("unknown nonce hb.spong is ignored; connection is not prematurely closed by onPong", async () => {
    const sock = makeSocket();

    // Use a very long pong timeout so we can verify state without racing
    const hb = createHeartbeat({
      pingIntervalMs: 100,
      pongTimeoutMs: 2_000, // long enough that timer doesn't fire during test
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
    });
    hb.start(sock);

    // Wait for first ping
    await sleep(120);
    expect(sock.sent.length).toBeGreaterThanOrEqual(1);

    // Send spong with unrecognised nonce
    hb.onPong(sock, spong("deadbeefdeadbeef"));

    // isAlive() should be false (pendingFlag still set, unknown nonce didn't clear it)
    expect(hb.isAlive(sock)).toBe(false);

    // No close should have happened
    expect(sock.closedWith.length).toBe(0);

    hb.stop(sock);
  }, 2_000);

  // -------------------------------------------------------------------------
  // Test 5: no pong → close 1011 within window
  // -------------------------------------------------------------------------
  it("no pong received → server closes with code 1011 within pong timeout window", async () => {
    const sock = makeSocket();

    const hb = createHeartbeat({
      pingIntervalMs: 100,
      pongTimeoutMs: 80,
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
    });
    hb.start(sock);

    // Wait for ping + pong timeout + setImmediate margin
    await sleep(350);
    hb.stop(sock);

    // Should have been closed with 1011
    expect(sock.closedWith.length).toBeGreaterThanOrEqual(1);
    expect(sock.closedWith[0]!.code).toBe(1011);
    expect(sock.closedWith[0]!.reason).toMatch(/heartbeat/i);
  }, 2_000);

  // -------------------------------------------------------------------------
  // Test 6: setImmediate defer — pong arriving between timer-fire and check
  //         still clears pendingFlag (explicit R11 race test)
  // -------------------------------------------------------------------------
  it("setImmediate defer: pong clearing pendingFlag before queued check prevents 1011 close", async () => {
    const sock = makeSocket();

    // Capture setImmediate callbacks instead of running them immediately
    const immediateQueue: Array<() => void> = [];
    const stubImmediate = (fn: () => void): void => {
      immediateQueue.push(fn);
    };

    const hb = createHeartbeat({
      pingIntervalMs: 100,
      pongTimeoutMs: 80,
      buildFrame: (p) => JSON.stringify({ ...p, seq: 0, ts: Date.now() }),
      setImmediate: stubImmediate,
    });
    hb.start(sock);

    // Wait for: first ping (100 ms) + pong timeout (80 ms) = ~180 ms
    // The pong timeout fires and schedules the close-check via stubImmediate
    // WITHOUT running it yet. We add a small margin.
    await sleep(220);

    // At this point: the pong timeout has fired and queued a check, but the
    // setImmediate queue has not been drained. pendingFlag is still true.
    expect(immediateQueue.length).toBeGreaterThanOrEqual(1);
    expect(sock.closedWith.length).toBe(0); // not closed yet

    // Now deliver a valid spong — this clears pendingFlag
    const pingFrame = JSON.parse(sock.sent[0]!) as { nonce: string };
    hb.onPong(sock, spong(pingFrame.nonce));

    // Drain the setImmediate queue — the check should see pendingFlag=false
    for (const fn of immediateQueue) {
      fn();
    }
    immediateQueue.length = 0;

    // Connection must NOT be closed
    expect(sock.closedWith.length).toBe(0);

    hb.stop(sock);
  }, 2_000);
});
