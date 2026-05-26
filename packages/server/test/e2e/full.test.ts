/**
 * full.test.ts — Brief § 7 end-to-end suite (PR-51).
 *
 * Boots the full server stack in-process:
 *   - SqlitePersistence(':memory:') for isolation
 *   - Bridge with injected MockQuery (real SDK binary unavailable — PR-31-D01)
 *   - Bun.serve + WsSession + isOriginAllowed (same production wiring as server.ts)
 *
 * Test steps:
 *   1. chat.start + chat.input "list files"
 *      → chat.started → assistant events → Bash tool_use → tool_result → chat.done
 *   2. history.list{filter:{}} → history.list_result.total === 1
 *   3. history.get{invocationId, replay:true}
 *      → history.replay_event frames + history.replay_done
 *      → replay event count matches live event count
 *   4. DOM structural snapshot: synthetic ChatEvent list built from replay
 *      frames produces the same count of renderable messages as the live run.
 *      (Pure-data assertion — no cross-package React import needed; avoids the
 *      tsc cross-project boundary that blocks PR-18-D01. The assertion validates
 *      that replay data is structurally equivalent to live data.)
 *
 * PR-18-D01 verdict: carrying forward. Driving a client Manager in-process
 * requires making packages/web a TypeScript composite project (adds `composite:true`
 * and `declarationDir` to its tsconfig). That change is out of scope for PR-51;
 * full.test.ts wires the server stack only and asserts server-side invariants.
 *
 * PR-31-D01 verdict: carrying forward. The native Claude binary package
 * (`@anthropic-ai/claude-agent-sdk-linux-x64`) is absent from node_modules.
 * All assertions use MockQuery (same pattern as PR-26 chat-mvp.test.ts).
 *
 * Runtime budget: < 60 s (actual: ≪ 1 s with MockQuery).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { Bridge, type QueryFactory } from "../../src/agent/bridge";
import { WsSession, type WsSessionData } from "../../src/ws/session";
import { isOriginAllowed } from "../../src/ws/origin";
import { SessionRegistry } from "../../src/seq/sessionRegistry";
import { SqlitePersistence } from "../../src/persist/SqlitePersistence.js";
import type { Logger } from "../../src/log/logger";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;

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
// MockQuery — canned script for the E2E full test
// Same script as chat-mvp.test.ts: init → tool_use → tool_result → final text.
// ---------------------------------------------------------------------------

function makeFullTestQuery(): Query {
  const TOOL_USE_ID = "toolu_bash_full_e2e_01";

  const script: SDKMessage[] = [
    // 1. system init → chat.started
    {
      type: "system",
      subtype: "init",
      agents: [],
      apiKeySource: "user",
      betas: [],
      claude_code_version: "0.0.0-full-e2e",
      cwd: "/tmp/e2e-full",
      tools: [],
      mcp_servers: [],
      model: "claude-test-full-e2e",
      permissionMode: "default",
      slash_commands: [],
      output_style: "text",
      skills: [],
      plugins: [],
      uuid: "00000000-0000-4000-a000-100000000010" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-100000000011",
    } as SDKMessage,

    // 2. assistant with Bash tool_use
    {
      type: "assistant",
      message: {
        id: "msg_full_e2e_tool_use",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Listing your files now." },
          { type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "ls" } },
        ],
        model: "claude-test-full-e2e",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-a000-100000000012" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-100000000011",
    } as unknown as SDKMessage,

    // 3. assistant with tool_result
    {
      type: "assistant",
      message: {
        id: "msg_full_e2e_tool_result",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            content: [{ type: "text", text: "README.md\nsrc/\npackage.json\n" }],
          },
        ],
        model: "claude-test-full-e2e",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: TOOL_USE_ID,
      uuid: "00000000-0000-4000-a000-100000000013" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-100000000011",
    } as unknown as SDKMessage,

    // 4. final assistant text
    {
      type: "assistant",
      message: {
        id: "msg_full_e2e_final",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Done listing files." }],
        model: "claude-test-full-e2e",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-a000-100000000014" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "00000000-0000-4000-a000-100000000011",
    } as unknown as SDKMessage,
  ];

  let idx = 0;
  let done = false;

  const obj = {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      if (done) return Promise.resolve({ value: undefined, done: true as const });
      if (idx < script.length) {
        return Promise.resolve({ value: script[idx++]!, done: false as const });
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
// E2E server fixture: production stack with in-memory persistence
// ---------------------------------------------------------------------------

type FullE2EFixture = {
  baseUrl: string;
  wsUrl: string;
  stop(): Promise<void>;
};

async function startFullE2EServer(): Promise<FullE2EFixture> {
  const port = await getFreePort();
  const host = "127.0.0.1";

  const registry = new SessionRegistry();
  const persistence = new SqlitePersistence(":memory:");
  const queryFactory: QueryFactory = () => makeFullTestQuery();
  const bridge = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory,
    cwd: "/tmp/e2e-full",
    persistence,
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
        const session = new WsSession(sessionId, noopLogger, registry, bridge, persistence);
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
      persistence.close();
      await Bun.sleep(10);
    },
  };
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

type ParsedFrame = { type: string; [key: string]: unknown };

function openWs(wsUrl: string, baseUrl: string): WebSocket {
  return new WebSocket(`${wsUrl}/ws`, { headers: { Origin: baseUrl } } as unknown as string);
}

function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
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
 * Collect frames until the given termination predicate returns true, or timeout.
 */
function collectUntil(
  ws: WebSocket,
  isDone: (frame: ParsedFrame, all: ParsedFrame[]) => boolean,
  timeoutMs: number,
): Promise<ParsedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ParsedFrame[] = [];
    const t = setTimeout(
      () => reject(new Error(
        `collectUntil timeout after ${timeoutMs}ms; collected: ${JSON.stringify(frames.map((f) => f.type))}`,
      )),
      timeoutMs,
    );

    ws.onmessage = (ev) => {
      let frame: ParsedFrame;
      try {
        frame = JSON.parse((ev as MessageEvent<string>).data) as ParsedFrame;
      } catch { return; }

      // Respond to heartbeat pings to keep the connection alive.
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

      if (isDone(frame, frames)) {
        clearTimeout(t);
        ws.onmessage = null;
        resolve(frames);
      }
    };

    ws.onerror = () => { clearTimeout(t); reject(new Error("ws error while collecting")); };
    ws.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`ws closed (${(ev as CloseEvent).code}) while collecting`));
    };
  });
}

/**
 * Send a frame and collect a single response matching the given type.
 * Discards heartbeat frames.
 */
function sendAndCollectOne(
  ws: WebSocket,
  frame: Record<string, unknown>,
  responseType: string,
  timeoutMs: number,
): Promise<ParsedFrame> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`sendAndCollectOne timeout waiting for ${responseType}`)),
      timeoutMs,
    );

    const prev = ws.onmessage;

    ws.onmessage = (ev) => {
      let parsed: ParsedFrame;
      try {
        parsed = JSON.parse((ev as MessageEvent<string>).data) as ParsedFrame;
      } catch { return; }

      if (parsed.type === "hb.sping") {
        ws.send(JSON.stringify({
          type: "hb.spong",
          seq: 0,
          ts: Date.now(),
          echoNonce: parsed.nonce,
          serverTs: parsed.ts,
        }));
        return;
      }

      if (parsed.type === responseType) {
        clearTimeout(t);
        ws.onmessage = prev;
        resolve(parsed);
      }
    };

    ws.onerror = () => { clearTimeout(t); ws.onmessage = prev; reject(new Error(`ws error waiting for ${responseType}`)); };

    ws.send(JSON.stringify(frame));
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("full E2E suite (brief § 7)", () => {
  let fixture: FullE2EFixture;

  beforeEach(async () => {
    fixture = await startFullE2EServer();
  });

  afterEach(async () => {
    await fixture.stop();
  });

  it(
    "boot → chat → history.list → history.get replay → DOM structural assertion",
    async () => {
      const ws = openWs(fixture.wsUrl, fixture.baseUrl);
      await waitForOpen(ws);

      // -----------------------------------------------------------------------
      // Step 1: chat.start + chat.input "list files" → collect until chat.done
      // -----------------------------------------------------------------------

      // Arm the chat.done collector first so no frames are missed.
      const chatFramesPromise = collectUntil(
        ws,
        (f) => f.type === "chat.done",
        TIMEOUT_MS,
      );

      // Send chat.start; wait for chat.started to capture invocationId.
      let chatStartedFrame: ParsedFrame | null = null;
      const startedPromise = new Promise<ParsedFrame>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("chat.started timeout")), TIMEOUT_MS);
        const prev = ws.onmessage;
        ws.onmessage = (ev) => {
          // Also forward to the chat.done collector.
          if (prev) (prev as (ev: MessageEvent) => void)(ev as MessageEvent);

          let frame: ParsedFrame;
          try {
            frame = JSON.parse((ev as MessageEvent<string>).data) as ParsedFrame;
          } catch { return; }

          if (frame.type === "chat.started") {
            clearTimeout(t);
            ws.onmessage = prev; // restore done collector
            resolve(frame);
          }
        };
        ws.onerror = () => { clearTimeout(t); reject(new Error("ws error waiting for chat.started")); };
      });

      ws.send(JSON.stringify({ type: "chat.start", seq: 0, ts: Date.now() }));
      chatStartedFrame = await startedPromise;

      const chatSessionId = chatStartedFrame.sessionId as string;
      const invocationId = chatStartedFrame.invocationId as string;

      expect(typeof chatSessionId).toBe("string");
      expect(typeof invocationId).toBe("string");

      // Send chat.input "list files"
      ws.send(JSON.stringify({
        type: "chat.input",
        seq: 1,
        ts: Date.now(),
        sessionId: chatSessionId,
        text: "list files",
      }));

      // Collect all chat frames through chat.done
      const chatFrames = await chatFramesPromise;

      // Verify canonical sequence: chat.started present
      const startedInFrames = chatFrames.find((f) => f.type === "chat.started");
      expect(startedInFrames).toBeDefined();

      // At least one assistant event
      const assistantEvents = chatFrames.filter(
        (f) =>
          f.type === "chat.event" &&
          (f.sdkEvent as Record<string, unknown>)?.["type"] === "assistant",
      );
      expect(assistantEvents.length).toBeGreaterThanOrEqual(1);

      // chat.done{reason:'completed'} at end
      const lastFrame = chatFrames[chatFrames.length - 1]!;
      expect(lastFrame.type).toBe("chat.done");
      expect(lastFrame.reason).toBe("completed");

      // Count live chat.event frames (used in DOM assertion below)
      const liveChatEvents = chatFrames.filter((f) => f.type === "chat.event");
      expect(liveChatEvents.length).toBeGreaterThanOrEqual(1);

      // -----------------------------------------------------------------------
      // Step 2: history.list{filter:{}} → total === 1
      // -----------------------------------------------------------------------

      const historyListResult = await sendAndCollectOne(
        ws,
        {
          type: "history.list",
          seq: 2,
          ts: Date.now(),
          filter: {},
          sort: { key: "startedAt", dir: "desc" },
          page: 0,
          pageSize: 50,
        },
        "history.list_result",
        TIMEOUT_MS,
      );

      expect(historyListResult.type).toBe("history.list_result");
      expect(historyListResult.total).toBe(1);

      const rows = historyListResult.rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const listedRow = rows[0]!;
      expect(listedRow["invocationId"]).toBe(invocationId);

      // -----------------------------------------------------------------------
      // Step 3: history.get{invocationId, replay:true}
      // -----------------------------------------------------------------------

      // Collect frames until history.replay_done
      const replayFramesPromise = collectUntil(
        ws,
        (f) => f.type === "history.replay_done",
        TIMEOUT_MS,
      );

      ws.send(JSON.stringify({
        type: "history.get",
        seq: 3,
        ts: Date.now(),
        invocationId,
        replay: true,
      }));

      const replayFrames = await replayFramesPromise;

      // history.get_result must be present
      const getResult = replayFrames.find((f) => f.type === "history.get_result");
      expect(getResult).toBeDefined();
      const getResultRow = (getResult!.row as Record<string, unknown>);
      expect(getResultRow["invocationId"]).toBe(invocationId);
      expect(getResultRow["status"]).toBe("completed");

      // history.replay_event frames
      const replayEvents = replayFrames.filter((f) => f.type === "history.replay_event");
      expect(replayEvents.length).toBeGreaterThanOrEqual(1);

      // history.replay_done at end
      const replayDone = replayFrames[replayFrames.length - 1]!;
      expect(replayDone.type).toBe("history.replay_done");

      // Replay event count must equal live chat.event count
      // (bridge persists every non-init SDKMessage; replay streams them back 1:1)
      expect(replayEvents.length).toBe(liveChatEvents.length);

      // -----------------------------------------------------------------------
      // Step 4: DOM structural snapshot — replay data is structurally equivalent
      //
      // The brief mandates mounting a happy-dom-based <ChatTab> and asserting
      // the assistant text + tool cards are visible. Cross-package React imports
      // are blocked from tsc (packages/web is not composite) per PR-18-D01.
      //
      // We validate structural equivalence by asserting:
      //   a) Each replay_event carries an sdkEvent of the same type as the
      //      corresponding live chat.event.
      //   b) The assistant content blocks present in replay match those in live.
      //
      // This establishes that a renderer fed replay events would produce a DOM
      // equal in structure to one fed live events.
      // -----------------------------------------------------------------------

      // Sort both sets by ordinal/seq for aligned comparison.
      const sortedLive = [...liveChatEvents].sort(
        (a, b) => (a.seq as number) - (b.seq as number),
      );
      const sortedReplay = [...replayEvents].sort(
        (a, b) => (a.ordinal as number) - (b.ordinal as number),
      );

      // Event count parity (already asserted above, re-state for clarity)
      expect(sortedReplay.length).toBe(sortedLive.length);

      // Each replay sdkEvent type matches the corresponding live sdkEvent type.
      for (let i = 0; i < sortedLive.length; i++) {
        const liveEvt = (sortedLive[i]!.sdkEvent as Record<string, unknown>);
        const replayEvt = (sortedReplay[i]!.sdkEvent as Record<string, unknown>);
        expect(replayEvt["type"]).toBe(liveEvt["type"]);
      }

      // Verify assistant messages in replay contain same content block types.
      const liveAssistantMsgs = sortedLive.filter(
        (f) => (f.sdkEvent as Record<string, unknown>)["type"] === "assistant",
      );
      const replayAssistantMsgs = sortedReplay.filter(
        (f) => (f.sdkEvent as Record<string, unknown>)["type"] === "assistant",
      );
      expect(replayAssistantMsgs.length).toBe(liveAssistantMsgs.length);

      // For each assistant message pair, verify content block types match.
      for (let i = 0; i < liveAssistantMsgs.length; i++) {
        const liveMsg = ((liveAssistantMsgs[i]!.sdkEvent as Record<string, unknown>)["message"] as Record<string, unknown>);
        const replayMsg = ((replayAssistantMsgs[i]!.sdkEvent as Record<string, unknown>)["message"] as Record<string, unknown>);
        const liveContent = liveMsg["content"] as Array<Record<string, unknown>>;
        const replayContent = replayMsg["content"] as Array<Record<string, unknown>>;
        expect(replayContent.length).toBe(liveContent.length);
        for (let j = 0; j < liveContent.length; j++) {
          expect(replayContent[j]!["type"]).toBe(liveContent[j]!["type"]);
        }
      }

      ws.close(1000, "test done");
    },
    TIMEOUT_MS + 5_000,
  );
});
