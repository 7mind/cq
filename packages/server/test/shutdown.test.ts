/**
 * shutdown.test.ts — Graceful shutdown tests for PR-48.
 *
 * Tests (2, mandatory):
 *  1. happy-path SIGTERM closes with 1012 within 2s
 *     Boot a real in-process server, open a client WebSocket, call
 *     startGracefulShutdown directly, assert WS close code 1012 within 1s,
 *     and shutdown Promise resolves within 2s.
 *
 *  2. closes with 1012 even when SDK fails to drain within shutdown-timeout-ms
 *     (F-05 named test) — Bridge with a stub query whose iteration loop never
 *     settles; shutdown-timeout-ms=200; WS close code 1012 within 700ms.
 */

import { describe, it, expect } from "bun:test";
import net from "node:net";
import { startGracefulShutdown, type ShutdownServer } from "../src/shutdown";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import type { Logger } from "../src/log/logger";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function getFreePort(): Promise<number> {
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
// Stub Query helpers
// ---------------------------------------------------------------------------

function patchQueryStubs(obj: object): void {
  const stubs: Record<string, unknown> = {
    mcpServerStatus: async () => [],
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    streamInput: async () => {},
    stopTask: async () => {},
    backgroundTasks: async () => false,
    reconnectMcpServer: async () => {},
    toggleMcpServer: async () => {},
    seedReadState: async () => {},
    readFile: async () => null,
    getContextUsage: async () => { throw new Error("not implemented"); },
    initializationResult: async () => { throw new Error("not implemented"); },
    reloadPlugins: async () => { throw new Error("not implemented"); },
    accountInfo: async () => { throw new Error("not implemented"); },
    rewindFiles: async () => { throw new Error("not implemented"); },
    setMcpServers: async () => { throw new Error("not implemented"); },
  };
  for (const [k, v] of Object.entries(stubs)) {
    (obj as Record<string, unknown>)[k] = v;
  }
}

function makeInitMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    agents: [],
    apiKeySource: "user",
    betas: [],
    claude_code_version: "0.0.0-test",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-test",
    permissionMode: "default",
    slash_commands: [],
    output_style: "text",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-a000-000000000001",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as SDKMessage;
}

// ---------------------------------------------------------------------------
// MockShutdownServer — wraps a Bun.serve instance with socket tracking and
// a draining flag for the ShutdownServer interface.
// ---------------------------------------------------------------------------

type BunWsHandle = { close(code?: number, reason?: string): void };

type MockServerResult = {
  server: ShutdownServer & { stop(): void };
  port: number;
  /**
   * Wait for a WebSocket close event on the given client WS with the given code.
   * Resolves true if the code matches before timeoutMs; false on timeout.
   */
  waitForClose(ws: WebSocket, code: number, timeoutMs: number): Promise<boolean>;
};

async function bootMockServer(): Promise<MockServerResult> {
  const port = await getFreePort();
  const host = "127.0.0.1";

  const openSockets = new Set<BunWsHandle>();
  let draining = false;

  // WsSessionData shape to satisfy Bun type.
  type WsData = { id: string };

  const bunServer = Bun.serve<WsData>({
    hostname: host,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (draining) return new Response("Service Unavailable", { status: 503 });
        const upgraded = srv.upgrade(req, { data: { id: crypto.randomUUID() } });
        if (!upgraded) return new Response("Upgrade required", { status: 426 });
        return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { openSockets.add(ws); },
      message() {},
      close(ws) { openSockets.delete(ws); },
    },
  });

  const server: ShutdownServer & { stop(): void } = {
    markDraining() { draining = true; },
    closeAllSockets(code: number, reason: string) {
      for (const ws of openSockets) {
        try { ws.close(code, reason); } catch { /* already closed */ }
      }
      openSockets.clear();
    },
    stop() { bunServer.stop(true); },
  };

  function waitForClose(ws: WebSocket, code: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve((ev as CloseEvent).code === code);
      });
    });
  }

  return { server, port, waitForClose };
}

// ---------------------------------------------------------------------------
// Test 1: happy-path SIGTERM closes with 1012 within 2s
// ---------------------------------------------------------------------------

describe("shutdown.test.ts", () => {
  it("happy-path SIGTERM closes with 1012 within 2s", async () => {
    const persistence = new InMemoryPersistence();

    // Bridge with a query that idles forever until interrupted.
    let resolveIdle!: () => void;
    const idleGate = new Promise<void>((r) => { resolveIdle = r; });

    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      // Block until interrupt.
      await idleGate;
    })();

    const mockQuery = asyncGen as unknown as Query & Record<string, unknown>;
    patchQueryStubs(mockQuery);
    mockQuery["interrupt"] = async () => { resolveIdle(); };
    mockQuery["close"] = () => {};

    const queryFactory: QueryFactory = () => mockQuery as unknown as Query;
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, queryFactory, cwd: "/tmp/test", persistence });

    const { server, port, waitForClose } = await bootMockServer();

    // Open a client WebSocket.
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    // Wait for open.
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("WS open failed"));
      setTimeout(() => reject(new Error("WS open timeout")), 3000);
    });

    // Start a query in the bridge so there is an active session.
    const mockWs: WsSocket = { send: () => {}, close: () => {} };
    await bridge.handleChatStart(mockWs, { type: "chat.start", seq: 0, ts: Date.now() });

    // The query is now active. Trigger graceful shutdown.
    const t0 = Date.now();
    const shutdownPromise = startGracefulShutdown({
      server,
      persistence,
      bridge,
      logger: noopLogger,
      timeoutMs: 5000,
    });

    // WS should close with 1012 within 1s.
    const got1012 = await waitForClose(clientWs, 1012, 1000);
    expect(got1012).toBe(true);

    // Shutdown should resolve within 2s total.
    await Promise.race([
      shutdownPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("shutdown did not resolve within 2s")), 2000 - (Date.now() - t0)),
      ),
    ]);

    server.stop();
  }, 10_000);

  // ---------------------------------------------------------------------------
  // Test 2: closes with 1012 even when SDK fails to drain within shutdown-timeout-ms
  // ---------------------------------------------------------------------------

  it("closes with 1012 even when SDK fails to drain within shutdown-timeout-ms", async () => {
    const persistence = new InMemoryPersistence();

    // Query whose iteration loop never resolves even after interrupt().
    // interrupt() is a no-op; the generator just hangs.
    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();
      // Never yields again — simulates a stuck SDK.
      await new Promise<void>(() => {}); // never resolves
    })();

    const mockQuery = asyncGen as unknown as Query & Record<string, unknown>;
    patchQueryStubs(mockQuery);
    // interrupt() returns but the generator above never unblocks.
    mockQuery["interrupt"] = async () => {};
    mockQuery["close"] = () => {};

    const queryFactory: QueryFactory = () => mockQuery as unknown as Query;
    const registry = new SessionRegistry();
    const bridge = new Bridge({ logger: noopLogger, registry, queryFactory, cwd: "/tmp/test", persistence });

    const { server, port, waitForClose } = await bootMockServer();

    // Open a client WebSocket.
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = () => reject(new Error("WS open failed"));
      setTimeout(() => reject(new Error("WS open timeout")), 3000);
    });

    // Start the stuck query.
    const mockWs: WsSocket = { send: () => {}, close: () => {} };
    await bridge.handleChatStart(mockWs, { type: "chat.start", seq: 0, ts: Date.now() });

    // Shutdown with 200ms timeout. The SDK never drains, so the timeout fires.
    const TIMEOUT_MS = 200;
    const TOLERANCE_MS = 500;
    const t0 = Date.now();

    const shutdownPromise = startGracefulShutdown({
      server,
      persistence,
      bridge,
      logger: noopLogger,
      timeoutMs: TIMEOUT_MS,
    });

    // WS must close with 1012 within timeout + tolerance (700ms total).
    const got1012 = await waitForClose(clientWs, 1012, TIMEOUT_MS + TOLERANCE_MS);
    const elapsed = Date.now() - t0;

    expect(got1012).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(TIMEOUT_MS + TOLERANCE_MS);

    // Shutdown must also resolve within the same bound.
    await Promise.race([
      shutdownPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`shutdown did not resolve within ${TIMEOUT_MS + TOLERANCE_MS}ms`)),
          TIMEOUT_MS + TOLERANCE_MS - elapsed,
        ),
      ),
    ]);

    server.stop();
  }, 5_000);
});
