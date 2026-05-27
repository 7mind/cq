/**
 * mock-server.ts — Admin-enabled Anthropic HTTP stub.
 *
 * Run as a child Bun process by globalSetup.ts. Writes the bound port to
 * stdout on line 1 so the parent can parse it.
 *
 * Admin endpoints:
 *   POST /__admin/script  { sse: SSEEvent[] } — queue next response
 *   POST /__admin/reset   {}                  — clear queue + log
 *   GET  /__admin/log     → { requests: LogEntry[] }
 *
 * Anthropic stub:
 *   HEAD /              — 200 (SDK connectivity probe)
 *   POST /v1/messages   — streams queued SSE or DEFAULT_SSE_EVENTS
 *   *                   — 404
 */

import net from "node:net";

// ---------------------------------------------------------------------------
// SSE event types (inline to avoid cross-package path issues)
// ---------------------------------------------------------------------------

type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
};

type LogEntry = {
  path: string;
  method: string;
  ts: number;
};

// ---------------------------------------------------------------------------
// Default SSE response (simple "hello" text message)
// ---------------------------------------------------------------------------

const DEFAULT_SSE_EVENTS: SSEEvent[] = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_stub_default",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-5-sonnet-stub",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeSSEEvents(events: SSEEvent[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

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
        if (err !== undefined) reject(err);
        else resolve(p);
      });
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

const scriptQueue: SSEEvent[][] = [];
const requestLog: LogEntry[] = [];
/**
 * Optional alternative sticky response returned when the incoming
 * /v1/messages body contains a tool_result block. Lets a test script two
 * distinct turns: the initial tool_use, then a confirmation after the
 * tool returned. Cleared by /__admin/reset.
 */
let scriptOnToolResult: SSEEvent[] | null = null;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const port = await getFreePort();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    requestLog.push({ path: pathname, method, ts: Date.now() });

    // ---- Admin ----

    if (method === "POST" && pathname === "/__admin/script") {
      const body = (await req.json()) as { sse: SSEEvent[] };
      scriptQueue.push(body.sse);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && pathname === "/__admin/scriptOnToolResult") {
      const body = (await req.json()) as { sse: SSEEvent[] };
      scriptOnToolResult = body.sse;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && pathname === "/__admin/reset") {
      scriptQueue.length = 0;
      requestLog.length = 0;
      scriptOnToolResult = null;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "GET" && pathname === "/__admin/log") {
      return new Response(JSON.stringify({ requests: [...requestLog] }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---- Anthropic stub ----

    if (method === "HEAD" && pathname === "/") {
      return new Response(null, { status: 200 });
    }

    if (method === "POST" && pathname === "/v1/messages") {
      // The SDK fires multiple parallel /v1/messages requests per turn (one
      // for the user prompt, one for the system-reminder context). To keep
      // mocking ergonomic, the latest scripted response is treated as
      // "sticky" — returned to every request until `reset` clears it. Tests
      // that need per-request specificity can call reset between calls.
      //
      // If a scriptOnToolResult was set and the body carries a tool_result,
      // return that sticky response instead — this lets a test mock two
      // distinct turns of a single tool round-trip.
      let bodyText = "";
      try {
        bodyText = await req.text();
      } catch {
        /* ignore */
      }
      const events = (scriptOnToolResult !== null && bodyText.includes("tool_result"))
        ? scriptOnToolResult
        : scriptQueue.length > 0
        ? scriptQueue[scriptQueue.length - 1]!
        : DEFAULT_SSE_EVENTS;
      const sseBody = encodeSSEEvents(events);
      return new Response(sseBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return new Response(
      JSON.stringify({ error: `stub: no handler for ${method} ${pathname}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },
});

// Write the port to stdout so the parent process can read it.
process.stdout.write(`MOCK_PORT=${server.port}\n`);

// Keep the process alive until a SIGTERM is received.
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
