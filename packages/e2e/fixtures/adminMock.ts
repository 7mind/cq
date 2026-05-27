/**
 * adminMock.ts — Admin API helpers for scripting the mock Anthropic HTTP server.
 *
 * The actual mock server runs as a child Bun process (started in globalSetup).
 * This module provides typed fetch wrappers so tests can script responses
 * without low-level fetch calls.
 *
 * Admin API (all on the same port as the mock):
 *   POST /__admin/script   { sse: SSEEvent[] }  — queue next scripted response
 *   POST /__admin/reset    {}                   — clear queue and counters
 *   GET  /__admin/log      → { requests: LogEntry[] }
 */

export type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type LogEntry = {
  path: string;
  method: string;
  ts: number;
};

export class MockServerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async script(events: SSEEvent[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/__admin/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sse: events }),
    });
    if (!res.ok) throw new Error(`/__admin/script failed: ${res.status}`);
  }

  /**
   * Set the sticky response returned when the incoming /v1/messages body
   * carries a tool_result block (i.e. a follow-up turn after a tool round-
   * trip). Cleared by reset().
   */
  async scriptOnToolResult(events: SSEEvent[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/__admin/scriptOnToolResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sse: events }),
    });
    if (!res.ok) throw new Error(`/__admin/scriptOnToolResult failed: ${res.status}`);
  }

  async reset(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/__admin/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`/__admin/reset failed: ${res.status}`);
  }

  async log(): Promise<LogEntry[]> {
    const res = await fetch(`${this.baseUrl}/__admin/log`);
    if (!res.ok) throw new Error(`/__admin/log failed: ${res.status}`);
    const data = (await res.json()) as { requests: LogEntry[] };
    return data.requests;
  }
}

// ---------------------------------------------------------------------------
// Default SSE events that mimic a simple text response
// ---------------------------------------------------------------------------

export function makeTextSSEEvents(text: string): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_e2e_${Date.now()}`,
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
        delta: { type: "text_delta", text },
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
        usage: { output_tokens: text.split(" ").length },
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];
}

// Slow response: multiple deltas with pauses (used for the stop test via a
// scripted long response; the actual pause is implemented in the mock server
// process via a long SSE body that the server sends immediately but is large
// enough that the bridge hasn't finished processing before Stop is clicked).
export function makeSlowTextSSEEvents(text: string, chunkCount = 10): SSEEvent[] {
  const events: SSEEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_slow_${Date.now()}`,
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
  ];

  const chunkSize = Math.max(1, Math.ceil(text.length / chunkCount));
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(i, i + chunkSize) },
      },
    });
  }

  events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: chunkCount },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });

  return events;
}
