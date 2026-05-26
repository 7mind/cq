/**
 * ws-resilience.test.ts — End-to-end resilience suite (PR-18 / PR-18-D01 fix).
 *
 * Boots a real Bun.serve in-process via serverFixture. Drives a real client
 * Manager (packages/web/src/ws/Manager) against the live server. Verifies
 * three resilience scenarios by observing the Manager's state-machine
 * transitions via onUpdate().
 *
 *  A) Freeze recovery:
 *     Manager connects and reaches ALIVE. Server pauses hb.pong replies —
 *     simulating a frozen network where client pings go unanswered. The
 *     Connection's pong timeout fires (compressed to 100 ms), driving
 *     ALIVE → STALE → DEAD. Manager schedules backoff and spawns a
 *     replacement. Server resumes pong replies; replacement reaches ALIVE.
 *
 *  B) IP-change (server-forced socket drop):
 *     Manager connects and reaches ALIVE. Server calls dropAllSockets() —
 *     abruptly closes all WS connections (simulates NAT rebalance / IP
 *     change). Manager's Connection sees the close event → DEAD. Manager
 *     spawns a replacement and reaches ALIVE again within ~3 s.
 *
 *  C) Server restart with 1001:
 *     Manager connects and reaches ALIVE. Server is stopped (clients receive
 *     1001 GOING_AWAY). A fresh server starts on the same port 200 ms later.
 *     Manager reconnects and reaches ALIVE on the new server within ~5 s.
 *
 * Implementation notes:
 *
 * - Manager is imported from @cq/web (packages/web is now a TypeScript
 *   composite project with declaration output, closing PR-18-D01).
 *
 * - socketFactory: Bun's native WebSocket is used for the transport. A thin
 *   factory wrapper injects the `Origin` header so the server's origin check
 *   passes. This is the same cast pattern used by ws-origin.test.ts (PR-06).
 *
 * - enableTimeJumpDetector: false — the real-time tick would add noise to
 *   tests that rely on compressed timer intervals (100–150 ms). Each scenario
 *   drives reconnection via the Manager's normal state-machine paths without
 *   the time-jump overlay.
 *
 * - Heartbeat intervals are compressed:
 *   pingIntervalMs: 150 ms (client sends hb.ping every 150 ms)
 *   pongTimeoutMs:  100 ms (client goes STALE if hb.pong doesn't arrive in 100 ms)
 *   staleGraceMs:    80 ms (client goes DEAD if STALE lasts > 80 ms)
 *   connectTimeoutMs: 2000 ms
 *
 * - waitForManagerAlive polls manager.stats until activeConnectionId is non-null
 *   and the corresponding connection state is "ALIVE".
 *
 * - Each test gets a fresh server and a fresh Manager via beforeEach/afterEach.
 *
 * Total expected runtime: ≤ 15 s (well within the 60 s budget).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startFixtureServer,
  type ServerFixture,
  startFixtureServerOnPort,
} from "../helpers/serverFixture";
import { Manager } from "@cq/web";
import type { ManagerOpts } from "@cq/web";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Compressed heartbeat ping interval for both fixture and Manager. */
const PING_INTERVAL_MS = 150;
/** Compressed pong timeout for both fixture and Manager. */
const PONG_TIMEOUT_MS = 100;
/** Compressed stale grace for the Manager. */
const STALE_GRACE_MS = 80;
/** How long to poll for Manager to reach ALIVE. */
const ALIVE_TIMEOUT_MS = 4_000;
/** Recovery budget for scenario B (IP-change) in ms. */
const RECOVERY_BUDGET_MS_B = 5_000;
/** Recovery budget for scenarios A and C in ms. */
const RECOVERY_BUDGET_MS_AC = 8_000;

// ---------------------------------------------------------------------------
// Manager socketFactory helper
// ---------------------------------------------------------------------------

/**
 * Build a socketFactory for Manager that injects an Origin header so the
 * fixture server's isOriginAllowed() check passes.
 *
 * Bun's native WebSocket accepts Bun.WebSocketOptions (with `headers`) as its
 * second argument. DOM typings shadow that overload, so we cast via `unknown`
 * — the same pattern used by ws-origin.test.ts (PR-06).
 */
function makeSocketFactory(
  baseUrl: string,
): (url: string) => WebSocket {
  return (url: string): WebSocket => {
    const opts = { headers: { Origin: baseUrl } };
    return new WebSocket(url, opts as unknown as string) as WebSocket;
  };
}

/**
 * Build ManagerOpts pointing at the fixture server, with compressed timers
 * and a socket factory that passes the Origin check.
 */
function makeManagerOpts(fixture: ServerFixture, extra: Partial<ManagerOpts> = {}): ManagerOpts {
  return {
    url: `${fixture.wsUrl}/ws`,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    staleGraceMs: STALE_GRACE_MS,
    connectTimeoutMs: 2_000,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    maxAttempts: 15,
    socketFactory: makeSocketFactory(fixture.baseUrl),
    enableTimeJumpDetector: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

/**
 * Poll manager.stats until activeConnectionId is non-null and that connection's
 * state is "ALIVE". Rejects if the budget expires or the Manager goes terminal.
 */
function waitForManagerAlive(
  manager: Manager,
  timeoutMs = ALIVE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = (): void => {
      const stats = manager.stats;
      if (stats.isTerminal) {
        reject(new Error(`Manager became terminal (last close code ${stats.lastCloseCode ?? "none"})`));
        return;
      }
      if (stats.activeConnectionId !== null) {
        const conn = stats.connections.find((c) => c.id === stats.activeConnectionId);
        if (conn?.state === "ALIVE") {
          resolve();
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitForManagerAlive timed out after ${timeoutMs} ms; stats: ${JSON.stringify(stats)}`));
        return;
      }
      setTimeout(check, 20);
    };

    check();
  });
}

/**
 * Poll manager.stats until activeConnectionId changes from `previousId` to a
 * new non-null ALIVE connection. This detects the recovery after a drop.
 */
function waitForManagerRecovered(
  manager: Manager,
  previousActiveId: string | null,
  timeoutMs = RECOVERY_BUDGET_MS_B,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = (): void => {
      const stats = manager.stats;
      if (stats.isTerminal) {
        reject(new Error(`Manager became terminal during recovery (close code ${stats.lastCloseCode ?? "none"})`));
        return;
      }
      if (
        stats.activeConnectionId !== null &&
        stats.activeConnectionId !== previousActiveId
      ) {
        const conn = stats.connections.find((c) => c.id === stats.activeConnectionId);
        if (conn?.state === "ALIVE") {
          resolve();
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitForManagerRecovered timed out after ${timeoutMs} ms; stats: ${JSON.stringify(stats)}`));
        return;
      }
      setTimeout(check, 20);
    };

    check();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ws-resilience: E2E resilience scenarios (real Manager)", () => {
  let fixture: ServerFixture;
  let manager: Manager;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      pingIntervalMs: PING_INTERVAL_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
    });
    manager = new Manager(makeManagerOpts(fixture));
  });

  afterEach(async () => {
    manager.destroy();
    await fixture.stop();
  });

  // -------------------------------------------------------------------------
  // Scenario A: Freeze recovery
  // -------------------------------------------------------------------------
  it(
    "A: freeze — server stops replying to client pings → Connection STALE→DEAD → Manager reconnects ALIVE",
    async () => {
      const start = Date.now();

      // 1. Wait for Manager to reach ALIVE.
      await waitForManagerAlive(manager, ALIVE_TIMEOUT_MS);
      const firstActiveId = manager.stats.activeConnectionId;
      expect(firstActiveId).not.toBeNull();

      // 2. Simulate freeze: server stops replying to hb.ping frames.
      //    The client's pong timeout (100 ms) + stale grace (80 ms) will fire,
      //    driving the active Connection through ALIVE → STALE → DEAD.
      //    Keep paused for at least pingIntervalMs + pongTimeoutMs + staleGraceMs
      //    = 150 + 100 + 80 = 330 ms to ensure the timeout cycle completes.
      fixture.pausePongReplies();
      await Bun.sleep(PING_INTERVAL_MS + PONG_TIMEOUT_MS + STALE_GRACE_MS + 100);

      // 3. Resume pong replies so the replacement connection can reach ALIVE.
      //    The Manager has already scheduled a backoff after detecting DEAD;
      //    the replacement will connect and get pong replies.
      fixture.resumePongReplies();

      await waitForManagerRecovered(manager, firstActiveId, RECOVERY_BUDGET_MS_AC);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(RECOVERY_BUDGET_MS_AC);

      // New active connection is ALIVE.
      const newStats = manager.stats;
      expect(newStats.activeConnectionId).not.toBeNull();
      expect(newStats.activeConnectionId).not.toBe(firstActiveId);
      const newConn = newStats.connections.find((c) => c.id === newStats.activeConnectionId);
      expect(newConn?.state).toBe("ALIVE");
    },
    RECOVERY_BUDGET_MS_AC + 3_000,
  );

  // -------------------------------------------------------------------------
  // Scenario B: IP-change (server-forced socket drop)
  // -------------------------------------------------------------------------
  it(
    "B: IP-change — server force-drops all sockets → Manager detects close → reconnects ALIVE",
    async () => {
      const start = Date.now();

      // 1. Wait for Manager to reach ALIVE.
      await waitForManagerAlive(manager, ALIVE_TIMEOUT_MS);
      const firstActiveId = manager.stats.activeConnectionId;
      expect(firstActiveId).not.toBeNull();

      // 2. Server force-drops all connections (simulates NAT rebalance).
      //    Clients see a close event; Connection goes DEAD immediately.
      fixture.dropAllSockets();

      // 3. Manager detects DEAD, schedules backoff (base 100 ms), spawns replacement.
      await waitForManagerRecovered(manager, firstActiveId, RECOVERY_BUDGET_MS_B);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(RECOVERY_BUDGET_MS_B);

      const newStats = manager.stats;
      expect(newStats.activeConnectionId).not.toBeNull();
      expect(newStats.activeConnectionId).not.toBe(firstActiveId);
      const newConn = newStats.connections.find((c) => c.id === newStats.activeConnectionId);
      expect(newConn?.state).toBe("ALIVE");
    },
    RECOVERY_BUDGET_MS_B + 3_000,
  );

  // -------------------------------------------------------------------------
  // Scenario C: Server restart
  // -------------------------------------------------------------------------
  it(
    "C: server restart — server stops (1001) → fresh server on same port → Manager reconnects ALIVE",
    async () => {
      const start = Date.now();
      const savedPort = fixture.port;

      // 1. Wait for Manager to reach ALIVE.
      await waitForManagerAlive(manager, ALIVE_TIMEOUT_MS);
      const firstActiveId = manager.stats.activeConnectionId;
      expect(firstActiveId).not.toBeNull();

      // 2. Stop the server. All clients receive 1001 GOING_AWAY.
      //    afterEach's fixture.stop() will be a no-op on this fixture.
      const stoppedFixture = fixture;
      fixture = { ...fixture, stop: async () => {} };
      await stoppedFixture.stop();

      // 3. Wait 200 ms, then start a fresh server on the same port.
      await Bun.sleep(200);
      const freshFixture = await startFixtureServerOnPort(savedPort, {
        pingIntervalMs: PING_INTERVAL_MS,
        pongTimeoutMs: PONG_TIMEOUT_MS,
      });

      // Replace fixture reference so afterEach cleans up correctly.
      fixture = freshFixture;

      // 4. Manager (still running) will detect the close, schedule backoff,
      //    and reconnect to the new server on the same port.
      await waitForManagerRecovered(manager, firstActiveId, RECOVERY_BUDGET_MS_AC);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(RECOVERY_BUDGET_MS_AC);

      const newStats = manager.stats;
      expect(newStats.activeConnectionId).not.toBeNull();
      expect(newStats.activeConnectionId).not.toBe(firstActiveId);
      const newConn = newStats.connections.find((c) => c.id === newStats.activeConnectionId);
      expect(newConn?.state).toBe("ALIVE");
    },
    RECOVERY_BUDGET_MS_AC + 3_000,
  );
});
