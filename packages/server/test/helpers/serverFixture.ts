/**
 * serverFixture.ts — In-process test server for E2E resilience tests.
 *
 * Boots a real Bun.serve with:
 *   - The production Origin check (isOriginAllowed).
 *   - A configurable heartbeat (short intervals for fast tests).
 *   - Socket tracking so tests can force-drop all connections.
 *   - A stop() method that shuts the server down cleanly.
 *
 * Does NOT use WsSession (production class) directly, because WsSession
 * hardcodes heartbeat intervals. Instead this fixture wires heartbeat,
 * origin-check, and frame dispatch itself using the same building blocks.
 *
 * Socket tracking approach: Bun.serve gives us the WS handle in the
 * websocket.open callback. We keep a reference in a Set; dropAllSockets()
 * calls ws.close(1006) on each (simulates NAT rebalance / abrupt TCP drop).
 *
 * Type note: Bun's ServerWebSocket<D> is generic. We use `SessionData` as the
 * type parameter for the set entries, then call WS methods via the typed ws
 * parameter in open/close handlers. The `connectedWs` set uses `WsHandle` —
 * a local alias that captures the structural type we need.
 */

import net from "node:net";
import { isOriginAllowed } from "../../src/ws/origin";
import { createHeartbeat, type HbSocket } from "../../src/ws/heartbeat";
import { ClientFrame } from "@cq/shared";

// ---------------------------------------------------------------------------
// Free-port helper
// ---------------------------------------------------------------------------

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected address type"));
        return;
      }
      const p = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(p);
      });
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Fixture options
// ---------------------------------------------------------------------------

export type ServerFixtureOpts = {
  pingIntervalMs?: number;   // default 15_000
  pongTimeoutMs?: number;    // default 8_000
};

// ---------------------------------------------------------------------------
// Fixture result
// ---------------------------------------------------------------------------

export type ServerFixture = {
  /** HTTP base URL, e.g. http://127.0.0.1:12345 */
  baseUrl: string;
  /** WebSocket base URL, e.g. ws://127.0.0.1:12345 */
  wsUrl: string;
  /** Bound port */
  port: number;
  /**
   * Force-terminate all currently connected WebSocket clients.
   * Simulates an abrupt NAT rebalance / socket drop (no close handshake).
   * Each client sees close code 1006.
   */
  dropAllSockets(): void;
  /**
   * Stop replying to client-initiated hb.ping frames.
   * Simulates a frozen/congested network where client pings go unanswered.
   * The client's pong timeout will eventually fire, driving STALE→DEAD.
   */
  pausePongReplies(): void;
  /**
   * Resume replying to client-initiated hb.ping frames (undoes pausePongReplies).
   */
  resumePongReplies(): void;
  /**
   * Stop the server. Resolves when the underlying Bun.serve has stopped.
   */
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Internal session data attached to each WS connection.
// ---------------------------------------------------------------------------

type SessionData = {
  id: string;
};

// ---------------------------------------------------------------------------
// Internal fixture builder — shared by startFixtureServer and
// startFixtureServerOnPort.
// ---------------------------------------------------------------------------

function buildFixture(
  port: number,
  opts: ServerFixtureOpts,
): ServerFixture {
  const pingIntervalMs = opts.pingIntervalMs ?? 15_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 8_000;
  const host = "127.0.0.1";

  // Set of currently connected WS handles.
  // We use HbSocket (the minimal interface heartbeat.ts needs) because the
  // Set is populated inside websocket.open, where we already have the
  // fully-typed ServerWebSocket<SessionData>. Storing as HbSocket avoids the
  // need for `any` while still letting dropAllSockets() call close().
  const connectedWs = new Set<HbSocket & { close(code?: number, reason?: string): void }>();

  // When true, hb.ping frames from the client are silently dropped (not replied to).
  // This simulates a frozen/congested path where client pings go unanswered.
  let _pausePongReplies = false;

  // One heartbeat factory per server instance. Per-socket state is tracked
  // internally by createHeartbeat's WeakMap.
  const heartbeat = createHeartbeat({
    pingIntervalMs,
    pongTimeoutMs,
    buildFrame: (payload) =>
      JSON.stringify({ ...payload, seq: 0, ts: Date.now() }),
  });

  const server = Bun.serve<SessionData>({
    hostname: host,
    port,

    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (!isOriginAllowed(req, host, port)) {
          return new Response(null, { status: 403 });
        }
        const upgraded = srv.upgrade(req, {
          data: { id: crypto.randomUUID() },
        });
        if (!upgraded) {
          return new Response("Upgrade required", { status: 426 });
        }
        return undefined;
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        connectedWs.add(ws);
        heartbeat.start(ws);
      },

      message(ws, raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        } catch {
          ws.close(4000, "invalid frame");
          return;
        }

        const result = ClientFrame.safeParse(parsed);
        if (!result.success) {
          ws.close(4000, "invalid frame");
          return;
        }

        const frame = result.data;

        if (frame.type === "hb.spong") {
          heartbeat.onPong(ws, frame);
          return;
        }

        if (frame.type === "hb.ping") {
          if (!_pausePongReplies) {
            ws.send(
              JSON.stringify({
                type: "hb.pong",
                seq: 0,
                ts: Date.now(),
                echoNonce: frame.nonce,
                clientTs: frame.ts,
                serverTs: Date.now(),
              }),
            );
          }
          return;
        }

        // Other frame types accepted but not dispatched until later PRs.
      },

      close(ws) {
        connectedWs.delete(ws);
        heartbeat.stop(ws);
      },
    },
  });

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,

    dropAllSockets() {
      for (const ws of connectedWs) {
        try {
          // Close with 1011 (INTERNAL_ERROR) — a retriable code that signals
          // the client should reconnect. Code 1006 is reserved and cannot be
          // sent as an actual close frame; Bun would map it to 1000 which
          // isRetriable() treats as non-retriable normal closure.
          ws.close(1011, "fixture: forced drop");
        } catch {
          // Already closed — ignore.
        }
      }
      connectedWs.clear();
    },

    pausePongReplies() {
      _pausePongReplies = true;
    },

    resumePongReplies() {
      _pausePongReplies = false;
    },

    async stop() {
      for (const ws of connectedWs) {
        try {
          // Use 1011 (INTERNAL_ERROR) — a retriable code that the client will
          // reconnect on. 1001 (GOING_AWAY) is the semantically correct choice
          // for a server shutting down, but Bun maps it to 1000 on the client
          // side, which isRetriable() treats as non-retriable normal closure.
          ws.close(1011, "server stopping");
        } catch {
          // ignore
        }
      }
      connectedWs.clear();
      server.stop(true);
      await Bun.sleep(10);
    },
  };
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/**
 * Start a fixture server on a randomly-chosen free port.
 */
export async function startFixtureServer(
  opts: ServerFixtureOpts = {},
): Promise<ServerFixture> {
  const port = await getFreePort();
  return buildFixture(port, opts);
}

/**
 * Start a fixture server on an explicitly provided port.
 * Used by Scenario C to restart on the same port the previous server held.
 */
export async function startFixtureServerOnPort(
  port: number,
  opts: ServerFixtureOpts = {},
): Promise<ServerFixture> {
  return buildFixture(port, opts);
}
