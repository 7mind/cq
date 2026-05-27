/**
 * sdk-stub.test.ts — PR-20: bridge invocation against MockAnthropicHTTP.
 *
 * Two describe blocks:
 *
 * 1. "Bridge against MockAnthropicHTTP (PR-20 fallback path)" — kept for
 *    regression coverage. Uses a `queryFactory` that fetches directly from the
 *    mock via fetch(), bypassing the native CLI binary. Tests that the bridge
 *    SSE parsing and message-mapping path work correctly in isolation.
 *
 * 2. "Bridge against MockAnthropicHTTP (REAL SDK, PR-20-D01)" — added when
 *    @anthropic-ai/claude-agent-sdk-linux-x64 is installed. Uses the real
 *    `query()` from the SDK, which spawns the native CLI subprocess. The
 *    subprocess inherits `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from the
 *    environment, pointing it at MockAnthropicHTTP. No `queryFactory` injection —
 *    the Bridge uses the default SDK path. Resolves PR-20-D01.
 *
 * The real SDK subprocess sends `HEAD /` as a connectivity probe before making
 * API calls; MockAnthropicHTTP now handles this (returns 200). The subprocess
 * also makes two simultaneous `/v1/messages` requests on startup (one with the
 * raw user prompt, one with system-reminder context); MockAnthropicHTTP returns
 * the scripted SSE response for each.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import type { Logger } from "../src/log/logger";
import { startMockAnthropic, DEFAULT_SSE_EVENTS } from "./helpers/MockAnthropicHTTP";
import type { MockAnthropicHTTP, SSEEvent } from "./helpers/MockAnthropicHTTP";

// ---------------------------------------------------------------------------
// Noop logger
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// MockWsSocket — records outbound frames (same as bridge.test.ts)
// ---------------------------------------------------------------------------

interface ParsedFrame {
  type: string;
  [key: string]: unknown;
}

class MockWsSocket implements WsSocket {
  readonly sent: ParsedFrame[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ParsedFrame);
  }

  close(): void {}

  framesOfType(type: string): ParsedFrame[] {
    return this.sent.filter((f) => f.type === type);
  }

  async waitForFrames(type: string, count = 1, timeoutMs = 5000): Promise<ParsedFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frames = this.framesOfType(type);
      if (frames.length >= count) return frames;
      await Bun.sleep(20);
    }
    throw new Error(
      `Timed out waiting for ${count} frame(s) of type '${type}'; ` +
      `got ${this.framesOfType(type).length}; all types: ${[...new Set(this.sent.map(f => f.type))].join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SSE-fetch QueryFactory
//
// This factory builds a Query that:
//  1. Issues a real `fetch(mockUrl + "/v1/messages")` — exercising the stub.
//  2. Reads the SSE response body and maps events to SDKMessage values.
//  3. Emits: SDKSystemMessage{subtype:'init'} first, then SDKAssistantMessage for
//     each content_block_delta, then signals done via generator return.
//
// This is NOT the real SDK `query()` — it is the documented fallback for
// environments where the native binary is unavailable (PR-20-D01).
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE body into an array of { event, data } pairs.
 * Each SSE block is separated by a blank line; `event:` and `data:` lines
 * are expected per the Anthropic streaming protocol.
 */
function parseSSEBody(body: string): SSEEvent[] {
  const result: SSEEvent[] = [];
  const blocks = body.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let eventName = "";
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
    }
    if (eventName && dataLine) {
      try {
        result.push({ event: eventName, data: JSON.parse(dataLine) as Record<string, unknown> });
      } catch {
        // Skip malformed data lines.
      }
    }
  }
  return result;
}

/**
 * Build a synthetic SDKSystemMessage (init) from constants.
 * The Bridge's runLoop checks `msg.type === 'system' && msg.subtype === 'init'`
 * to identify the init message and send chat.started.
 */
function makeSyntheticInit(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    agents: [],
    apiKeySource: "user",
    betas: [],
    claude_code_version: "0.3.150-stub",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-3-5-sonnet-stub",
    permissionMode: "default",
    slash_commands: [],
    output_style: "text",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-a000-000000000010",
    session_id: "00000000-0000-4000-a000-000000000011",
  } as unknown as SDKMessage;
}

/**
 * Build a synthetic SDKAssistantMessage from a content_block_delta SSE event.
 * The Bridge's sendEvent() wraps it in a `chat.event { sdkEvent }` frame.
 */
function makeSyntheticAssistant(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_stub_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-3-5-sonnet-stub",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-a000-000000000012",
    session_id: "00000000-0000-4000-a000-000000000011",
  } as unknown as SDKMessage;
}

/**
 * Create a QueryFactory that fetches from `mockBaseUrl + /v1/messages`, parses
 * the SSE response, and yields synthetic SDKMessage values that the Bridge
 * can process identically to real SDK output.
 *
 * When `returnError` is true, the fetch will fail (502/500), and the generator
 * throws so the Bridge's error path triggers.
 */
function makeSSEQueryFactory(mockBaseUrl: string): QueryFactory {
  return ({ prompt }) => {
    // Consume the prompt iterable in background (not used by stub — it just
    // fires immediately for any input, mirroring the canned nature of the stub).
    void (async () => {
      try {
        // Drain the prompt iterable (not used by the stub — it fires immediately).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _msg of prompt) { /* drain */ }
      } catch (e) {
        void e; // ignore errors from the prompt drain
      }
    })();

    let done = false;
    let messages: SDKMessage[] = [];
    let fetchError: unknown = null;
    let fetchDone = false;

    // Kick off the fetch immediately.
    const fetchPromise = (async () => {
      const resp = await fetch(`${mockBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-test-fake",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "claude-3-5-sonnet-stub", max_tokens: 1024, messages: [] }),
      });

      if (!resp.ok) {
        throw new Error(`MockAnthropicHTTP returned HTTP ${resp.status}: ${await resp.text()}`);
      }

      const body = await resp.text();
      const sseEvents = parseSSEBody(body);

      // Convert SSE events to SDKMessage sequence:
      // First emit a synthetic init message, then one assistant message per
      // content_block_delta event.
      const msgs: SDKMessage[] = [makeSyntheticInit()];
      const textParts: string[] = [];

      for (const e of sseEvents) {
        if (e.event === "content_block_delta") {
          const delta = e.data["delta"] as Record<string, unknown> | undefined;
          if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
            textParts.push(delta["text"]);
          }
        }
      }

      if (textParts.length > 0) {
        msgs.push(makeSyntheticAssistant(textParts.join("")));
      }

      return msgs;
    })();

    fetchPromise.then(
      (msgs) => { messages = msgs; fetchDone = true; },
      (err) => { fetchError = err; fetchDone = true; },
    );

    // Build async generator that waits for fetch to complete then yields messages.
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      // Wait for fetch to complete.
      while (!fetchDone) {
        await Bun.sleep(10);
      }

      if (fetchError !== null) {
        throw fetchError;
      }

      for (const msg of messages) {
        if (done) return;
        yield msg;
      }
    })();

    // Satisfy the Query interface minimally.
    const query = Object.assign(gen, {
      interrupt: async () => { done = true; },
      close: () => { done = true; },
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      applyFlagSettings: async () => {},
      initializationResult: async () => { throw new Error("not implemented"); },
      supportedCommands: async () => [] as string[],
      supportedModels: async () => [] as string[],
      supportedAgents: async () => [] as string[],
      mcpServerStatus: async () => [] as never[],
      getContextUsage: async () => { throw new Error("not implemented"); },
      readFile: async () => null,
      reloadPlugins: async () => { throw new Error("not implemented"); },
      accountInfo: async () => { throw new Error("not implemented"); },
      rewindFiles: async () => { throw new Error("not implemented"); },
      seedReadState: async () => {},
      reconnectMcpServer: async () => {},
      toggleMcpServer: async () => {},
      setMcpServers: async () => { throw new Error("not implemented"); },
      streamInput: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => false,
    });

    return query as unknown as Query;
  };
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

let savedBaseUrl: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  savedBaseUrl = process.env["ANTHROPIC_BASE_URL"];
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
});

afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
  else process.env["ANTHROPIC_BASE_URL"] = savedBaseUrl;

  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChatStart(): import("@cq/shared").ChatStart {
  return { type: "chat.start", seq: 0, ts: Date.now() };
}

function makeChatInput(sessionId: string, text: string): import("@cq/shared").ChatInput {
  return { type: "chat.input", seq: 1, ts: Date.now(), sessionId, text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bridge against MockAnthropicHTTP (PR-20 fallback path)", () => {
  // --------------------------------------------------------------------------
  // Case 1: happy path — chat.input → streamed assistant chat.event → chat.done
  // --------------------------------------------------------------------------
  it("chat.input → streamed assistant chat.event via MockAnthropicHTTP SSE; chat.done reason=completed", async () => {
    let mock: MockAnthropicHTTP | null = null;
    try {
      mock = await startMockAnthropic({ scriptedResponse: DEFAULT_SSE_EVENTS });

      // Set env vars that the real SDK subprocess would inherit.
      process.env["ANTHROPIC_BASE_URL"] = mock.url;
      process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";

      const registry = new SessionRegistry();
      const bridge = new Bridge({
        logger: noopLogger,
        registry,
        // Fallback queryFactory that fetches from MockAnthropicHTTP.
        queryFactory: makeSSEQueryFactory(mock.url),
        cwd: "/tmp/sdk-stub-test",
      });

      const ws = new MockWsSocket();
      await bridge.handleChatStart(ws, makeChatStart());

      // Wait for chat.started.
      const [startedFrame] = await ws.waitForFrames("chat.started", 1, 5000);
      expect(startedFrame).toBeDefined();
      expect(startedFrame!.type).toBe("chat.started");
      const sessionId = startedFrame!.sessionId as string;
      expect(typeof sessionId).toBe("string");

      // Send chat.input.
      await bridge.handleChatInput(ws, makeChatInput(sessionId, "echo hello"));

      // Wait for at least one chat.event with assistant text. The bridge
      // also emits a user-echo chat.event (D24) — skip past it.
      const events = await ws.waitForFrames("chat.event", 2, 5000);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const evtFrame = events.find((f) => {
        const sdk = f.sdkEvent as Record<string, unknown>;
        return sdk?.type === "assistant";
      })!;
      expect(evtFrame).toBeDefined();
      expect(evtFrame.type).toBe("chat.event");
      const sdkEvt = evtFrame.sdkEvent as Record<string, unknown>;
      expect(sdkEvt.type).toBe("assistant");

      // Verify the text contains "hello" (from DEFAULT_SSE_EVENTS content_block_delta).
      const msg = sdkEvt.message as { content: Array<{ type: string; text: string }> };
      const textContent = msg.content.find((c) => c.type === "text");
      expect(textContent?.text).toContain("hello");

      // Wait for chat.done.
      const [doneFrame] = await ws.waitForFrames("chat.done", 1, 5000);
      expect(doneFrame!.reason).toBe("completed");

      // Verify MockAnthropicHTTP received exactly one request.
      expect(mock.requestCount()).toBe(1);

      await bridge.shutdown();
    } finally {
      await mock?.stop();
    }
  });

  // --------------------------------------------------------------------------
  // Case 2: error path — HTTP 500 → bridge emits chat.done reason=errored
  // --------------------------------------------------------------------------
  it("HTTP 500 from MockAnthropicHTTP → chat.done reason=errored surfaced visibly", async () => {
    let mock: MockAnthropicHTTP | null = null;
    try {
      mock = await startMockAnthropic({ returnError: true, errorStatus: 500 });

      process.env["ANTHROPIC_BASE_URL"] = mock.url;
      process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";

      const registry = new SessionRegistry();
      const bridge = new Bridge({
        logger: noopLogger,
        registry,
        queryFactory: makeSSEQueryFactory(mock.url),
        cwd: "/tmp/sdk-stub-test",
      });

      const ws = new MockWsSocket();
      await bridge.handleChatStart(ws, makeChatStart());

      // The fetch will fail; the bridge should emit chat.done reason=errored.
      const [doneFrame] = await ws.waitForFrames("chat.done", 1, 5000);
      expect(doneFrame!.reason).toBe("errored");

      // chat.error should also be emitted (SDK_ERROR code).
      const errorFrames = ws.framesOfType("chat.error");
      expect(errorFrames.length).toBeGreaterThanOrEqual(1);
      const errFrame = errorFrames[0]!;
      expect(errFrame.code).toBe("SDK_ERROR");
      // The message should contain the HTTP status.
      expect(String(errFrame.message)).toContain("500");

      await bridge.shutdown();
    } finally {
      await mock?.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Real-SDK tests (PR-20-D01 resolution)
//
// These tests use the REAL `query()` from @anthropic-ai/claude-agent-sdk —
// no `queryFactory` injection. The Bridge spawns the native CLI subprocess,
// which inherits ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY from the environment
// and hits MockAnthropicHTTP instead of the real Anthropic API.
//
// The subprocess sends HEAD / (connectivity probe) and then POST /v1/messages.
// MockAnthropicHTTP now handles HEAD / (returns 200) and POST /v1/messages
// (returns the scripted SSE sequence).
//
// Timeout is 28 s (well within bun test's default) to account for the
// subprocess startup overhead (~2–4 s) and any CI variance.
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("Bridge against MockAnthropicHTTP (REAL SDK, PR-20-D01)", () => {
  // PR-20-D01 resolution: real SDK subprocess invoked; ANTHROPIC_BASE_URL
  // points at MockAnthropicHTTP. No queryFactory injection.
  it(
    "REAL SDK: chat.input → streamed assistant chat.event via MockAnthropicHTTP; chat.done reason=completed",
    async () => {
      let mock: MockAnthropicHTTP | null = null;
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cq-sdk-real-"));
      await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });

      try {
        // The real subprocess returns DEFAULT_SSE_EVENTS for all /v1/messages requests.
        mock = await startMockAnthropic({ scriptedResponse: DEFAULT_SSE_EVENTS });

        // Inherit these env vars into the spawned subprocess.
        process.env["ANTHROPIC_BASE_URL"] = mock.url;
        process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
        process.env["HOME"] = tmpHome;

        // Bridge with NO queryFactory — uses real SDK query().
        const registry = new SessionRegistry();
        const bridge = new Bridge({
          logger: noopLogger,
          registry,
          cwd: tmpHome,
          home: tmpHome,
        });

        const ws = new MockWsSocket();
        await bridge.handleChatStart(ws, makeChatStart());

        // With the real SDK subprocess, chat.started (system/init) is only emitted
        // AFTER the subprocess processes the first user message. We therefore send
        // chat.input immediately using bridge.activeSessionId() — which is set by
        // handleChatStart before the background loop starts — then wait for both
        // chat.started and the subsequent chat.event.
        const sessionId = bridge.activeSessionId()!;
        expect(typeof sessionId).toBe("string");
        await bridge.handleChatInput(ws, makeChatInput(sessionId, "say hello"));

        // Wait for chat.started — subprocess startup + first API round-trip.
        const [startedFrame] = await ws.waitForFrames("chat.started", 1, 25000);
        expect(startedFrame).toBeDefined();
        expect(startedFrame!.type).toBe("chat.started");

        // Wait for the "assistant" sdkEvent — one of the chat.event frames emitted
        // during a turn. Other frames include stream_event and system/status events
        // that arrive before the assistant frame, so we must poll until the
        // assistant-type frame is present rather than stopping at the first event.
        let assistantEvent: ParsedFrame | undefined;
        const evtDeadline = Date.now() + 25000;
        while (Date.now() < evtDeadline) {
          assistantEvent = ws.framesOfType("chat.event").find((f) => {
            const sdkEvt = f.sdkEvent as Record<string, unknown>;
            return sdkEvt.type === "assistant";
          });
          if (assistantEvent !== undefined) break;
          await Bun.sleep(50);
        }
        expect(assistantEvent).toBeDefined();

        // The SSE response contained "hello" via DEFAULT_SSE_EVENTS.
        const sdkEvt = assistantEvent!.sdkEvent as Record<string, unknown>;
        const msg = sdkEvt.message as { content: Array<{ type: string; text?: string }> };
        const textContent = msg.content.find((c) => c.type === "text");
        expect(textContent?.text).toContain("hello");

        // The mock received at least one /v1/messages request.
        expect(mock.requestCount()).toBeGreaterThanOrEqual(1);

        // After the turn completes the subprocess waits for more input (the bridge
        // queue stays open for multi-turn conversations). Calling shutdown() closes
        // the query which unblocks the runLoop, causing it to emit
        // chat.done{reason:'completed'}.
        await bridge.shutdown();

        const [doneFrame] = await ws.waitForFrames("chat.done", 1, 5000);
        expect(doneFrame!.reason).toBe("completed");
      } finally {
        await mock?.stop();
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
    30000, // test-level timeout: 30 s for subprocess startup overhead
  );
});
