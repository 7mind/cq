/**
 * ws-origin.test.ts — Origin enforcement tests for the /ws endpoint.
 *
 * The server rejects pre-upgrade with HTTP 403 when the Origin host:port does
 * not match the server's bound address (plan § PR-06, option A).  The
 * POLICY_VIOLATION (1008) close-code constant is reserved for client-side
 * classification; the server never emits it because the WS handshake is
 * rejected before it completes.
 *
 * Test cases:
 *  1. Matching Origin → WebSocket opens successfully.
 *  2. Mismatched Origin → server returns HTTP 403.
 *  3. No Origin header → server returns HTTP 403.
 *
 * Surprises / implementation notes:
 *  - Bun's global `WebSocket` client does NOT send an `Origin` header by
 *    default (observed: `Origin: null` in the upgrade request).  This means
 *    a plain `new WebSocket(url)` will be rejected by the Origin check, which
 *    is what test 3 relies on.
 *  - When the server returns 403 the Bun WS client fires `onerror` and then
 *    `onclose` with code 1002 ("Expected 101 status code").  To assert the
 *    HTTP-level 403 reliably we probe with `fetch()` using the raw WS upgrade
 *    headers instead of the WebSocket constructor.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const MAIN_TS = path.resolve(import.meta.dir, "../src/main.ts");

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

/** Wait for WebSocket `open` event, reject on `error` or `close`. */
function waitOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws.open timeout")), timeoutMs);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (ev) => { clearTimeout(t); reject(new Error(`ws error: ${String(ev)}`)); };
    ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`ws closed (${ev.code}) before open`)); };
  });
}

/**
 * Probe the /ws upgrade endpoint with a raw HTTP fetch carrying the
 * WS headers.  The server's pre-upgrade Origin check operates at the HTTP
 * layer, so fetch() sees the exact HTTP status code (200 for a non-WS
 * response, 403 for rejection, 101 would mean full upgrade which fetch
 * won't interpret as WS).
 */
async function probeWsUpgrade(baseHttpUrl: string, origin: string | null): Promise<number> {
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    // Valid but arbitrary key for the probe
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  if (origin !== null) {
    headers["Origin"] = origin;
  }

  const res = await fetch(`${baseHttpUrl}/ws`, {
    method: "GET",
    headers,
  });
  return res.status;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ws-origin: Origin enforcement on /ws", () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let port: number;
  let baseHttpUrl: string;
  let baseWsUrl: string;
  let tmpCwd: string;

  beforeAll(async () => {
    port = await getFreePort();
    baseHttpUrl = `http://127.0.0.1:${port}`;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    // Per-test fresh cwd so the server bootstraps ledgers in an isolated
    // docs/ dir rather than the repo root. (TESTHYG-D01)
    tmpCwd = await mkdtemp(path.join(tmpdir(), "cq-ws-origin-"));

    proc = Bun.spawn(
      ["bun", "run", MAIN_TS, "--port", String(port), "--host", "127.0.0.1", "--cwd", tmpCwd],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) {
      proc.kill();
      throw new Error("proc.stdout is not a ReadableStream");
    }
    const decoder = new TextDecoder();
    const reader = stdout.getReader();
    let output = "";
    const deadline = Date.now() + 10_000;

    outer: while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
      if (output.includes('"cq listening"')) {
        reader.releaseLock();
        break outer;
      }
    }

    if (!output.includes('"cq listening"')) {
      proc.kill();
      throw new Error(`Server did not start within 10 s. stdout: ${output}`);
    }
  }, 20_000);

  afterAll(async () => {
    try { proc.kill(); } catch { /* already dead */ }
    await rm(tmpCwd, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: matching Origin → WS opens
  // -------------------------------------------------------------------------
  it("WebSocket with matching Origin opens successfully", async () => {
    // Bun's global WebSocket accepts Bun.WebSocketOptions as second arg — cast
    // to any to use Bun's extended overload (DOM types shadow it when both loaded).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(`${baseWsUrl}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);

    await waitOpen(ws);
    ws.close();
    // If we reach here the connection opened — assertion passed.
    expect(true).toBe(true);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 2: mismatched Origin → HTTP 403
  // -------------------------------------------------------------------------
  it("WebSocket upgrade with evil Origin is rejected with HTTP 403", async () => {
    const status = await probeWsUpgrade(baseHttpUrl, "http://evil.example");
    expect(status).toBe(403);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 3: no Origin header → HTTP 403
  // -------------------------------------------------------------------------
  it("WebSocket upgrade with no Origin header is rejected with HTTP 403", async () => {
    const status = await probeWsUpgrade(baseHttpUrl, null);
    expect(status).toBe(403);
  }, 10_000);
});
