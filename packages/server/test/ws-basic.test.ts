/**
 * ws-basic.test.ts — Integration tests for the /ws WebSocket endpoint.
 *
 * Boots a real server on a free port, then exercises:
 *  1. Valid hb.ping → hb.pong with matching echoNonce and clientTs.
 *  2. Malformed JSON → close 4000.
 *  3. Frame missing required `type` field → close 4000.
 *  4. Frame with invalid enum value in a known discriminant type → close 4000.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const MAIN_TS = path.resolve(import.meta.dir, "../src/main.ts");
const ORIGIN_HEADER = "Origin";

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
// Helpers
// ---------------------------------------------------------------------------

/** Open a WebSocket to the server with a matching (allowed) Origin. */
function openWs(baseWsUrl: string, port: number): WebSocket {
  // Bun's global WebSocket accepts an options object (Bun.WebSocketOptions) as
  // the second arg, which is typed differently from the DOM protocols arg.
  // Cast to `any` to use Bun's extended overload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = new WebSocket(`${baseWsUrl}/ws`, { headers: { [ORIGIN_HEADER]: `http://127.0.0.1:${port}` } } as any);
  return ws;
}

/**
 * Wait for a single `message` event on a WebSocket; resolve with the parsed
 * JSON payload, or reject on `error`/`close`.
 */
function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws.message timeout")), timeoutMs);
    ws.onmessage = (ev) => {
      const parsed = JSON.parse(ev.data as string);
      // ACTIVITY-01: the server pushes an out-of-band `activity.status{running}`
      // frame on connect (initial aggregate-activity state). It is not a reply
      // to any client frame, so skip it here and wait for the next message.
      if ((parsed as { type?: unknown }).type === "activity.status") return;
      clearTimeout(t);
      resolve(parsed);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error before message"));
    };
    ws.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws closed (${ev.code}) before message`));
    };
  });
}

/**
 * Wait for the WebSocket `close` event and return the close code.
 */
function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws.close timeout")), timeoutMs);
    ws.onclose = (ev) => {
      clearTimeout(t);
      resolve(ev.code);
    };
    ws.onerror = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws error: ${String(ev)}`));
    };
  });
}

/**
 * Wait for the WebSocket `open` event.
 */
function waitOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws.open timeout")), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws error: ${String(ev)}`));
    };
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ws-basic: /ws endpoint frame handling", () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let port: number;
  let baseWsUrl: string;
  let tmpCwd: string;

  beforeAll(async () => {
    port = await getFreePort();
    baseWsUrl = `ws://127.0.0.1:${port}`;

    // Per-test fresh cwd so the server bootstraps ledgers in an isolated
    // docs/ dir rather than the repo root. (TESTHYG-D01)
    tmpCwd = await mkdtemp(path.join(tmpdir(), "cq-ws-basic-"));

    proc = Bun.spawn(
      ["bun", "run", MAIN_TS, "--port", String(port), "--host", "127.0.0.1", "--cwd", tmpCwd],
      { stdout: "pipe", stderr: "pipe" },
    );

    // Wait for "cq listening" on stdout
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
  // Test 1: valid hb.ping → hb.pong
  // -------------------------------------------------------------------------
  it("valid hb.ping returns hb.pong with matching echoNonce and clientTs", async () => {
    const ws = openWs(baseWsUrl, port);
    await waitOpen(ws);

    const nonce = "abcdef1234567890"; // exactly 16 chars
    const clientTs = Date.now();
    const ping = JSON.stringify({
      type: "hb.ping",
      seq: 0,
      ts: clientTs,
      nonce,
      ackSeq: null,
    });

    ws.send(ping);
    const reply = await nextMessage(ws);

    expect(reply).toMatchObject({
      type: "hb.pong",
      echoNonce: nonce,
      clientTs,
    });
    // seq and serverTs should be present and numeric
    expect(typeof (reply as { seq: unknown }).seq).toBe("number");
    expect(typeof (reply as { serverTs: unknown }).serverTs).toBe("number");

    ws.close();
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 2: malformed JSON → close 4000
  // -------------------------------------------------------------------------
  it("malformed JSON causes server to close with code 4000", async () => {
    const ws = openWs(baseWsUrl, port);
    await waitOpen(ws);

    ws.send("this is not JSON {{{");
    const code = await nextClose(ws);
    expect(code).toBe(4000);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 3: frame missing `type` field → close 4000
  // -------------------------------------------------------------------------
  it("frame missing type field causes server to close with code 4000", async () => {
    const ws = openWs(baseWsUrl, port);
    await waitOpen(ws);

    ws.send(JSON.stringify({ seq: 0, ts: Date.now(), nonce: "abcdef1234567890" }));
    const code = await nextClose(ws);
    expect(code).toBe(4000);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 4: invalid enum value in a known frame type → close 4000
  // -------------------------------------------------------------------------
  it("chat.start with invalid permissionMode enum closes with 4000", async () => {
    const ws = openWs(baseWsUrl, port);
    await waitOpen(ws);

    ws.send(JSON.stringify({
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      permissionMode: "nope",  // not a valid enum value
    }));
    const code = await nextClose(ws);
    expect(code).toBe(4000);
  }, 10_000);
});
