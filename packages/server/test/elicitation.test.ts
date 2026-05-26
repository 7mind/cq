/**
 * elicitation.test.ts — PR-30: ElicitationBroker + bridge onElicitation roundtrip.
 *
 * Test cases:
 *  1. Form-mode: stub ElicitationRequest{mode:'form', requestedSchema} via broker.request;
 *     assert WS frame chat.elicitation_request; reply {action:'accept', content:{name:'X'}};
 *     assert Promise resolves identically.
 *  2. URL-mode: stub ElicitationRequest{mode:'url', url:...}; assert WS frame;
 *     simulate SDKElicitationCompleteMessage → assert Promise resolves {action:'accept'}.
 *  3. cancel: reply with {action:'cancel'} resolves with {action:'cancel'}.
 *  4. decline: reply with {action:'decline'} resolves with {action:'decline'}.
 *  5. rejectAll cancels all pending requests.
 *  6. Bridge integration (form-mode): onElicitation callback → WS frame → reply → resolved.
 *  7. Bridge integration (URL-mode): onElicitation callback → WS frame →
 *     SDKElicitationCompleteMessage in stream → resolved {action:'accept'}.
 */

import { describe, it, expect } from "bun:test";
import { ElicitationBroker } from "../src/agent/elicitation";
import { Bridge } from "../src/agent/bridge";
import type { QueryFactory, WsSocket } from "../src/agent/bridge";
import type { Query, SDKMessage, OnElicitation } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import type { Logger } from "../src/log/logger";
import type { ChatElicitationRequest } from "@cq/shared";

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
// MockWsSocket
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

  async waitForFrames(type: string, count = 1, timeoutMs = 3000): Promise<ParsedFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frames = this.framesOfType(type);
      if (frames.length >= count) return frames;
      await Bun.sleep(10);
    }
    throw new Error(
      `Timed out waiting for ${count} frame(s) of type '${type}'; got ${this.framesOfType(type).length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// MockQuery — hangs until resolveHang is called; captures onElicitation callback.
// ---------------------------------------------------------------------------

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

function makeElicitationCompleteMessage(elicitationId: string): SDKMessage {
  return {
    type: "system",
    subtype: "elicitation_complete",
    mcp_server_name: "test-mcp",
    elicitation_id: elicitationId,
    uuid: "00000000-0000-4000-a000-000000000099",
    session_id: "00000000-0000-4000-a000-000000000002",
  } as unknown as SDKMessage;
}

type HangingQueryResult = {
  queryFactory: QueryFactory;
  onElicitationCapture: { fn: OnElicitation | null };
  /** Inject an SDK message into the running stream (after init). */
  injectMessage: (msg: SDKMessage) => void;
  /** End the stream. */
  resolveHang: () => void;
};

function makeHangingQueryFactory(): HangingQueryResult {
  const onElicitationCapture: { fn: OnElicitation | null } = { fn: null };
  let resolveHang!: () => void;
  const injectQueue: SDKMessage[] = [];
  let injectNotify: (() => void) | null = null;

  function injectMessage(msg: SDKMessage): void {
    injectQueue.push(msg);
    if (injectNotify !== null) {
      const notify = injectNotify;
      injectNotify = null;
      notify();
    }
  }

  function resolveHangFn(): void {
    resolveHang?.();
  }

  const queryFactory: QueryFactory = ({ options }) => {
    if (options?.onElicitation !== undefined) {
      onElicitationCapture.fn = options.onElicitation;
    }

    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });

    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield makeInitMessage();

      // Yield injected messages as they arrive, then hang.
      while (true) {
        if (injectQueue.length > 0) {
          yield injectQueue.shift()!;
          continue;
        }
        // Check if hang is resolved.
        let hangResolved = false;
        const raceResult = await Promise.race([
          hangPromise.then(() => "hang"),
          new Promise<"inject">((r) => { injectNotify = () => r("inject"); }),
        ]);
        if (raceResult === "hang") {
          hangResolved = true;
        }
        if (hangResolved) break;
        // Flush remaining inject queue.
        while (injectQueue.length > 0) {
          yield injectQueue.shift()!;
        }
      }
    })();

    const obj: Query = Object.assign(gen as unknown as Query, {
      interrupt: async () => { resolveHang(); },
      close: () => { resolveHang(); },
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
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
    });
    return obj;
  };

  return { queryFactory, onElicitationCapture, injectMessage, resolveHang: resolveHangFn };
}

function makeChatStart(): import("@cq/shared").ChatStart {
  return { type: "chat.start", seq: 0, ts: Date.now() };
}

// ---------------------------------------------------------------------------
// Unit tests for ElicitationBroker in isolation
// ---------------------------------------------------------------------------

describe("ElicitationBroker (unit)", () => {
  it("form-mode: request emits chat.elicitation_request; accept reply resolves with content", async () => {
    const broker = new ElicitationBroker();
    const emitted: ChatElicitationRequest[] = [];
    broker.setSendFrame((f) => { emitted.push(f); });

    const resultPromise = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "test-mcp",
      message: "Please enter your name",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    });

    expect(emitted).toHaveLength(1);
    const frame = emitted[0]!;
    expect(frame.type).toBe("chat.elicitation_request");
    expect(frame.mcpServerName).toBe("test-mcp");
    expect(frame.message).toBe("Please enter your name");
    expect(frame.mode).toBe("form");
    expect(typeof frame.elicitationId).toBe("string");
    expect(broker.pendingCount()).toBe(1);

    broker.reply(frame.elicitationId, "accept", { name: "X" });

    const result = await resultPromise;
    expect(result.action).toBe("accept");
    expect((result as { action: string; content?: Record<string, unknown> }).content).toEqual({ name: "X" });
    expect(broker.pendingCount()).toBe(0);
  });

  it("URL-mode: request emits frame; completeUrl resolves with {action:'accept'}", async () => {
    const broker = new ElicitationBroker();
    const emitted: ChatElicitationRequest[] = [];
    broker.setSendFrame((f) => { emitted.push(f); });

    const elicitationId = "00000000-0000-4000-b000-000000000007";
    const resultPromise = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "test-mcp",
      message: "Open this URL to authenticate",
      mode: "url",
      url: "https://example.com/auth",
      elicitationId,
    });

    expect(emitted).toHaveLength(1);
    const frame = emitted[0]!;
    expect(frame.type).toBe("chat.elicitation_request");
    expect(frame.mode).toBe("url");
    expect(frame.url).toBe("https://example.com/auth");
    // The SDK-provided elicitationId should be reused for correlation.
    expect(frame.elicitationId).toBe(elicitationId);

    broker.completeUrl(elicitationId);

    const result = await resultPromise;
    expect(result.action).toBe("accept");
    expect(broker.pendingCount()).toBe(0);
  });

  it("cancel reply resolves with {action:'cancel'}", async () => {
    const broker = new ElicitationBroker();
    let capturedId = "";
    broker.setSendFrame((f) => { capturedId = f.elicitationId; });

    const resultPromise = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "test-mcp",
      message: "test",
    });

    broker.reply(capturedId, "cancel");
    const result = await resultPromise;
    expect(result.action).toBe("cancel");
  });

  it("decline reply resolves with {action:'decline'}", async () => {
    const broker = new ElicitationBroker();
    let capturedId = "";
    broker.setSendFrame((f) => { capturedId = f.elicitationId; });

    const resultPromise = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "test-mcp",
      message: "test",
    });

    broker.reply(capturedId, "decline");
    const result = await resultPromise;
    expect(result.action).toBe("decline");
  });

  it("rejectAll cancels all pending requests", async () => {
    const broker = new ElicitationBroker();
    broker.setSendFrame(() => {});

    const p1 = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "s1",
      message: "m1",
    });
    const p2 = broker.request("sess-0000-0000-0000-000000000001", {
      serverName: "s2",
      message: "m2",
    });

    expect(broker.pendingCount()).toBe(2);
    broker.rejectAll();
    expect(broker.pendingCount()).toBe(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.action).toBe("cancel");
    expect(r2.action).toBe("cancel");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: Bridge wires onElicitation → ElicitationBroker
// ---------------------------------------------------------------------------

describe("Bridge + ElicitationBroker (integration)", () => {
  it("form-mode: onElicitation callback → chat.elicitation_request on WS → reply accept → resolves", async () => {
    const { queryFactory, onElicitationCapture } = makeHangingQueryFactory();

    const registry = new SessionRegistry();
    const broker = new ElicitationBroker();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      elicitationBroker: broker,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());

    const [startedFrame] = await ws.waitForFrames("chat.started");
    const sessionId = startedFrame!.sessionId as string;

    expect(onElicitationCapture.fn).not.toBeNull();
    const onElicitation = onElicitationCapture.fn!;

    const elicitationPromise = onElicitation(
      {
        serverName: "test-mcp",
        message: "What is your name?",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      { signal: new AbortController().signal },
    );

    const [elicFrame] = await ws.waitForFrames("chat.elicitation_request");
    expect(elicFrame!.type).toBe("chat.elicitation_request");
    expect(elicFrame!.mcpServerName).toBe("test-mcp");
    expect(elicFrame!.sessionId).toBe(sessionId);

    bridge.handleChatElicitationReply(ws, {
      type: "chat.elicitation_reply",
      seq: 1,
      ts: Date.now(),
      sessionId,
      elicitationId: elicFrame!.elicitationId as string,
      action: "accept",
      content: { name: "X" },
    });

    const result = await elicitationPromise;
    expect(result.action).toBe("accept");
    expect((result as { action: string; content?: Record<string, unknown> }).content).toEqual({ name: "X" });

    await bridge.shutdown();
  });

  it("URL-mode: onElicitation callback → WS frame → SDKElicitationCompleteMessage → resolves {action:'accept'}", async () => {
    const { queryFactory, onElicitationCapture, injectMessage } = makeHangingQueryFactory();

    const registry = new SessionRegistry();
    const broker = new ElicitationBroker();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory,
      cwd: "/tmp/test",
      elicitationBroker: broker,
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started");

    expect(onElicitationCapture.fn).not.toBeNull();
    const onElicitation = onElicitationCapture.fn!;

    const elicitationId = "00000000-0000-4000-c000-000000000042";
    const elicitationPromise = onElicitation(
      {
        serverName: "test-mcp",
        message: "Open URL to authenticate",
        mode: "url",
        url: "https://example.com/auth",
        elicitationId,
      },
      { signal: new AbortController().signal },
    );

    const [elicFrame] = await ws.waitForFrames("chat.elicitation_request");
    expect(elicFrame!.mode).toBe("url");
    expect(elicFrame!.elicitationId).toBe(elicitationId);

    // Simulate the SDK emitting SDKElicitationCompleteMessage.
    injectMessage(makeElicitationCompleteMessage(elicitationId));

    const result = await elicitationPromise;
    expect(result.action).toBe("accept");

    await bridge.shutdown();
  });
});
