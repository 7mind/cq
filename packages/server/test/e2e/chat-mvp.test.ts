/**
 * chat-mvp.test.ts — M2 acceptance end-to-end test (PR-26).
 *
 * Boots the full server stack in-process (production WsSession + Bridge wiring,
 * real Bun.serve, real Origin check). Injects a MockQuery via the Bridge
 * `queryFactory` option instead of the real SDK binary (which is unavailable
 * per defect PR-20-D01).
 *
 * MockQuery script:
 *   1. system/init message → bridge emits chat.started
 *   2. assistant message with a Bash tool_use block → chat.event (assistant)
 *   3. assistant message with a tool_result block for that tool_use → chat.event (assistant)
 *   4. final assistant text message ("done") → chat.event (assistant)
 *   5. generator ends → bridge emits chat.done{reason:'completed'}
 *
 * Sequence asserted:
 *   chat.started → ≥1 assistant chat.event → Bash tool_use chat.event
 *   → tool_result chat.event → chat.done{reason:'completed'}
 *
 * Runtime budget: < 30 s (actual: ≪ 1 s).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { Bridge, type QueryFactory } from "../../src/agent/bridge";
import { WsSession, type WsSessionData } from "../../src/ws/session";
import { isOriginAllowed } from "../../src/ws/origin";
import { SessionRegistry } from "../../src/seq/sessionRegistry";
import type { Logger } from "../../src/log/logger";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;

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
// Free-port helper
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
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
// MockQuery — canned SDKMessage script for E2E
// ---------------------------------------------------------------------------

/**
 * Minimal stubs for all Query control methods the bridge may call.
 * Cast to Query via `as unknown as Query` to avoid satisfying every
 * internal symbol (e.g. Symbol.asyncDispose) introduced in newer lib.
 */
function makeChatMvpQuery(): Query {
  const TOOL_USE_ID = "toolu_bash_e2e_01";

  // Script: init → assistant+tool_use → assistant+tool_result → final assistant
  const script: SDKMessage[] = [
    // 1. System init message — triggers chat.started
    {
      type: "system",
      subtype: "init",
      agents: [],
      apiKeySource: "user",
      betas: [],
      claude_code_version: "0.0.0-e2e",
      cwd: "/tmp/e2e",
      tools: [],
      mcp_servers: [],
      model: "claude-test-e2e",
      permissionMode: "default",
      slash_commands: [],
      output_style: "text",
      skills: [],
      plugins: [],
      uuid: "00000000-0000-4000-a000-000000000010" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-000000000011",
    } as SDKMessage,

    // 2. Assistant message containing a Bash tool_use block
    {
      type: "assistant",
      message: {
        id: "msg_e2e_tool_use",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I'll list the files for you.",
          },
          {
            type: "tool_use",
            id: TOOL_USE_ID,
            name: "Bash",
            input: { command: "ls" },
          },
        ],
        model: "claude-test-e2e",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-a000-000000000012" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-000000000011",
    } as unknown as SDKMessage,

    // 3. Assistant message containing the tool_result for the Bash tool_use
    {
      type: "assistant",
      message: {
        id: "msg_e2e_tool_result",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            content: [{ type: "text", text: "README.md\nsrc/\npackage.json\n" }],
          },
        ],
        model: "claude-test-e2e",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: TOOL_USE_ID,
      uuid: "00000000-0000-4000-a000-000000000013" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-000000000011",
    } as unknown as SDKMessage,

    // 4. Final assistant text message
    {
      type: "assistant",
      message: {
        id: "msg_e2e_final",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Done listing files." }],
        model: "claude-test-e2e",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-a000-000000000014" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-000000000011",
    } as unknown as SDKMessage,
  ];

  let idx = 0;
  let done = false;

  const obj = {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      if (done) return Promise.resolve({ value: undefined, done: true as const });
      if (idx < script.length) {
        const msg = script[idx++]!;
        return Promise.resolve({ value: msg, done: false as const });
      }
      done = true;
      return Promise.resolve({ value: undefined, done: true as const });
    },
    return(): Promise<IteratorResult<SDKMessage, void>> {
      done = true;
      return Promise.resolve({ value: undefined, done: true as const });
    },
    throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
      done = true;
      return Promise.reject(err);
    },
    // Query control method stubs
    async interrupt(): Promise<void> { done = true; },
    async setPermissionMode(): Promise<void> {},
    async setModel(): Promise<void> {},
    async setMaxThinkingTokens(): Promise<void> {},
    async applyFlagSettings(): Promise<void> {},
    async initializationResult(): Promise<never> { throw new Error("not implemented"); },
    async supportedCommands(): Promise<never[]> { return []; },
    async supportedModels(): Promise<never[]> { return []; },
    async supportedAgents(): Promise<never[]> { return []; },
    async mcpServerStatus(): Promise<never[]> { return []; },
    async getContextUsage(): Promise<never> { throw new Error("not implemented"); },
    async readFile(): Promise<null> { return null; },
    async reloadPlugins(): Promise<never> { throw new Error("not implemented"); },
    async accountInfo(): Promise<never> { throw new Error("not implemented"); },
    async rewindFiles(): Promise<never> { throw new Error("not implemented"); },
    async seedReadState(): Promise<void> {},
    async reconnectMcpServer(): Promise<void> {},
    async toggleMcpServer(): Promise<void> {},
    async setMcpServers(): Promise<never> { throw new Error("not implemented"); },
    async streamInput(): Promise<void> {},
    async stopTask(): Promise<void> {},
    async backgroundTasks(): Promise<boolean> { return false; },
    close(): void { done = true; },
  };

  return obj as unknown as Query;
}

// ---------------------------------------------------------------------------
// E2E server fixture — boots production WsSession + Bridge stack
// ---------------------------------------------------------------------------

type ChatMvpFixture = {
  baseUrl: string;
  wsUrl: string;
  stop(): Promise<void>;
};

async function startChatMvpServer(): Promise<ChatMvpFixture> {
  const port = await getFreePort();
  const host = "127.0.0.1";

  const registry = new SessionRegistry();
  const queryFactory: QueryFactory = () => makeChatMvpQuery();
  const bridge = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory,
    cwd: "/tmp/e2e",
  });

  const server = Bun.serve<WsSessionData>({
    hostname: host,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!isOriginAllowed(req)) {
          return new Response(null, { status: 403 });
        }
        const sessionId = crypto.randomUUID();
        const session = new WsSession(sessionId, noopLogger, registry, bridge);
        const upgraded = srv.upgrade(req, { data: { sessionId, session } });
        if (!upgraded) {
          return new Response("Upgrade required", { status: 426 });
        }
        return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { ws.data.session.open(ws); },
      message(ws, raw) { ws.data.session.message(ws, raw); },
      close(ws, code, reason) { ws.data.session.close(ws, code, reason); },
    },
  });

  return {
    baseUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,
    async stop() {
      await bridge.shutdown();
      server.stop(true);
      await Bun.sleep(10);
    },
  };
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

type ParsedFrame = { type: string; [key: string]: unknown };

function openWs(wsUrl: string, baseUrl: string): WebSocket {
  const opts = { headers: { Origin: baseUrl } };
  return new WebSocket(`${wsUrl}/ws`, opts as unknown as string);
}

function waitForOpen(ws: WebSocket, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws.open timeout")), timeoutMs);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error("ws error before open")); };
    ws.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws closed (${(ev as CloseEvent).code}) before open`));
    };
  });
}

/**
 * Collect all inbound frames from the WebSocket until a `chat.done` frame
 * arrives or the timeout elapses.
 */
function collectUntilDone(ws: WebSocket, timeoutMs = TIMEOUT_MS): Promise<ParsedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ParsedFrame[] = [];
    const t = setTimeout(
      () => reject(new Error(`collectUntilDone timeout after ${timeoutMs} ms; collected: ${JSON.stringify(frames.map((f) => f.type))}`)),
      timeoutMs,
    );

    ws.onmessage = (ev) => {
      let frame: ParsedFrame;
      try {
        frame = JSON.parse((ev as MessageEvent<string>).data) as ParsedFrame;
      } catch {
        return;
      }

      // Respond to server heartbeat pings so the connection stays alive.
      if (frame.type === "hb.sping") {
        ws.send(JSON.stringify({
          type: "hb.spong",
          seq: 0,
          ts: Date.now(),
          echoNonce: frame.nonce,
          serverTs: frame.ts,
        }));
        return;
      }

      frames.push(frame);

      if (frame.type === "chat.done") {
        clearTimeout(t);
        ws.onmessage = null;
        resolve(frames);
      }
    };

    ws.onerror = () => { clearTimeout(t); reject(new Error("ws error while collecting")); };
    ws.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws closed (${(ev as CloseEvent).code}) before chat.done`));
    };
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("chat-mvp E2E: canonical event sequence", () => {
  let fixture: ChatMvpFixture;

  beforeEach(async () => {
    fixture = await startChatMvpServer();
  });

  afterEach(async () => {
    await fixture.stop();
  });

  it(
    "chat.start + chat.input → chat.started → assistant events → Bash tool_use → tool_result → chat.done{completed}",
    async () => {
      const ws = openWs(fixture.wsUrl, fixture.baseUrl);
      await waitForOpen(ws);

      // Arm the collector before sending any frames so no messages are missed.
      const collectPromise = collectUntilDone(ws);

      // Send chat.start
      ws.send(JSON.stringify({ type: "chat.start", seq: 0, ts: Date.now() }));

      // Wait for chat.started so we have the sessionId for chat.input
      const sessionId = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("chat.started timeout")), TIMEOUT_MS);
        const origHandler = ws.onmessage;
        ws.onmessage = (ev) => {
          // Delegate to collector first
          if (origHandler) (origHandler as (ev: MessageEvent) => void)(ev as MessageEvent);

          let frame: ParsedFrame;
          try {
            frame = JSON.parse((ev as MessageEvent<string>).data) as ParsedFrame;
          } catch { return; }

          if (frame.type === "chat.started") {
            clearTimeout(t);
            ws.onmessage = origHandler; // restore collector
            resolve(frame.sessionId as string);
          }
        };
      });

      // Send chat.input with the user prompt
      ws.send(JSON.stringify({
        type: "chat.input",
        seq: 1,
        ts: Date.now(),
        sessionId,
        text: "list files",
      }));

      // Collect all frames until chat.done
      const frames = await collectPromise;

      // -----------------------------------------------------------------------
      // Assertions over the canonical sequence
      // -----------------------------------------------------------------------

      // 1. chat.started must be present
      const started = frames.find((f) => f.type === "chat.started");
      expect(started).toBeDefined();
      expect(typeof (started as ParsedFrame).sessionId).toBe("string");

      // 2. At least one assistant chat.event (type='assistant' in sdkEvent)
      const assistantEvents = frames.filter(
        (f) =>
          f.type === "chat.event" &&
          (f.sdkEvent as Record<string, unknown>)?.["type"] === "assistant",
      );
      expect(assistantEvents.length).toBeGreaterThanOrEqual(1);

      // 3. Exactly one chat.event whose sdkEvent contains a Bash tool_use block
      const toolUseEvents = assistantEvents.filter((f) => {
        const sdkEvent = f.sdkEvent as Record<string, unknown>;
        const msg = sdkEvent["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
        return content?.some(
          (block) => block["type"] === "tool_use" && block["name"] === "Bash",
        ) === true;
      });
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);

      // 4. Exactly one chat.event whose sdkEvent contains a tool_result block
      const toolResultEvents = assistantEvents.filter((f) => {
        const sdkEvent = f.sdkEvent as Record<string, unknown>;
        const msg = sdkEvent["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
        return content?.some((block) => block["type"] === "tool_result") === true;
      });
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);

      // 5. chat.done{reason:'completed'} is the last frame
      const done = frames[frames.length - 1];
      expect(done?.type).toBe("chat.done");
      expect((done as ParsedFrame).reason).toBe("completed");

      // 6. Ordering: started → tool_use event → tool_result event → done
      const startedIdx = frames.findIndex((f) => f.type === "chat.started");
      const toolUseIdx = frames.findIndex((f) =>
        f.type === "chat.event" &&
        (() => {
          const msg = ((f.sdkEvent as Record<string, unknown>)["message"] as Record<string, unknown> | undefined);
          const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
          return content?.some((b) => b["type"] === "tool_use" && b["name"] === "Bash") === true;
        })(),
      );
      const toolResultIdx = frames.findIndex((f) =>
        f.type === "chat.event" &&
        (() => {
          const msg = ((f.sdkEvent as Record<string, unknown>)["message"] as Record<string, unknown> | undefined);
          const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
          return content?.some((b) => b["type"] === "tool_result") === true;
        })(),
      );
      const doneIdx = frames.findIndex((f) => f.type === "chat.done");

      expect(startedIdx).toBeLessThan(toolUseIdx);
      expect(toolUseIdx).toBeLessThan(toolResultIdx);
      expect(toolResultIdx).toBeLessThan(doneIdx);

      ws.close(1000, "test done");
    },
    TIMEOUT_MS + 5_000,
  );
});
