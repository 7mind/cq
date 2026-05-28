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
      // Read the body once so we can detect non-streaming requests (used by
      // the cq server's title generator: a single non-streaming Haiku call
      // per fresh session). The body is otherwise ignored.
      const bodyText = await req.text();
      let bodyJson: Record<string, unknown> | null = null;
      try { bodyJson = JSON.parse(bodyText) as Record<string, unknown>; } catch { /* swallow */ }

      // PR-01 title generator: non-streaming requests targeted at Haiku get a
      // canned JSON Message response so the title shows up in the History tab.
      // We key on `stream` being false/absent rather than on the model so the
      // mock also works for any future non-streaming uses. The returned title
      // is derived from the first user-content-line of the request so each
      // test gets a distinguishable title — this matters when multiple
      // sessions accumulate in the shared in-memory DB during an e2e run.
      const isStreaming = bodyJson !== null && bodyJson["stream"] === true;
      if (!isStreaming) {
        let derivedTitle = "Mock generated title";
        try {
          const messages = (bodyJson?.["messages"] ?? []) as Array<{ role?: string; content?: unknown }>;
          const userMsg = messages.find((m) => m.role === "user");
          let content: string | null = null;
          if (typeof userMsg?.content === "string") {
            content = userMsg.content;
          } else if (Array.isArray(userMsg?.content)) {
            const textBlock = (userMsg.content as Array<{ type?: string; text?: string }>).find(
              (b) => b.type === "text" && typeof b.text === "string",
            );
            content = textBlock?.text ?? null;
          }
          if (content !== null) {
            // The titleGenerator's user prompt looks like
            //   "User's first message:\n<TEXT>\n\nAssistant's first reply:\n..."
            // Extract <TEXT> (first line after the marker) and use it as the
            // mock's "title". Truncate to keep the title short.
            const marker = "User's first message:\n";
            const i = content.indexOf(marker);
            if (i >= 0) {
              const rest = content.slice(i + marker.length);
              const firstLine = rest.split("\n", 1)[0]!.trim();
              if (firstLine.length > 0) derivedTitle = `mock title: ${firstLine.slice(0, 40)}`;
            }
          }
        } catch { /* fall back to canned title */ }

        const messageBody = {
          id: "msg_mock_title",
          type: "message",
          role: "assistant",
          model: typeof bodyJson?.["model"] === "string" ? bodyJson["model"] : "claude-haiku-stub",
          content: [{ type: "text", text: derivedTitle }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        return new Response(JSON.stringify(messageBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // The SDK fires multiple parallel /v1/messages requests per turn (one
      // for the user prompt, one for the system-reminder context). To keep
      // mocking ergonomic, the latest scripted response is treated as
      // "sticky" — returned to every request until `reset` clears it. Tests
      // that need per-request specificity can call reset between calls.
      //
      // If a scriptOnToolResult was set and the body carries a tool_result,
      // return that sticky response instead — this lets a test mock two
      // distinct turns of a single tool round-trip. `bodyText` was already
      // read above for title-derivation detection.
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
