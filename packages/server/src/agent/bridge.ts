/**
 * bridge.ts — SDK bridge: one active Query per server (pool=1).
 *
 * Responsibilities:
 *  - Accepts `chat.start` → calls `query({ prompt: asyncIterable })`.
 *  - Accepts `chat.input` → pushes SDKUserMessage onto the async queue.
 *  - Accepts `chat.interrupt` → calls `Query.interrupt()`.
 *  - Iterates yielded SDKMessages and maps them to outbound frames:
 *      - SDKSystemMessage{subtype:'init'} → `chat.started`
 *      - All other SDKMessage variants → `chat.event` (via replay buffer)
 *      - Stream end → `chat.done{reason:'completed'}`
 *      - SDK iteration error → `chat.done{reason:'errored'}` + `chat.error`
 *  - Rejects concurrent `chat.start` with `chat.error{code:'SESSION_BUSY'}`.
 *
 * Pool size: 1 (one active Query at a time). PR-27 will revisit.
 * Abort/cancel beyond stub `handleChatInterrupt`: deferred to PR-24.
 * Nested invocations (sub-agents): deferred to PR-27.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options as SDKOptions,
  SDKUserMessage,
  SDKMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../log/logger";
import type { SessionRegistry } from "../seq/sessionRegistry";
import type {
  ChatStart,
  ChatInput,
  ChatInterrupt,
  ChatEvent,
  ChatStarted,
  ChatDone,
  ChatError,
} from "@cq/shared";
import { loadMcpServers } from "./mcp";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Minimal WsSocket shape the bridge needs — structurally compatible with
 * Bun's ServerWebSocket and with MockWsSocket in tests.
 */
export type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/**
 * A factory that creates a Query from options.
 * The default implementation delegates to the SDK's `query()` function.
 * Tests inject a `MockQuery`-producing factory to avoid hitting the real API.
 */
export type QueryFactory = (opts: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: SDKOptions;
}) => Query;

export interface BridgeOpts {
  logger: Logger;
  registry: SessionRegistry;
  /** Override `query()` for tests. Defaults to the real SDK `query`. */
  queryFactory?: QueryFactory;
  /** Forwarded to SDK as `options.cwd`. */
  cwd: string;
  /**
   * Override the HOME directory used for MCP server config loading
   * (`~/.claude/mcp_servers.json`). Defaults to `process.env.HOME`.
   * Primarily for tests that set a temporary HOME.
   */
  home?: string;
}

// ---------------------------------------------------------------------------
// AsyncQueue — streaming-input queue feeding the SDK's AsyncIterable<SDKUserMessage>
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterator<T>, AsyncIterable<T> {
  private readonly buf: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buf.length > 0) {
      const value = this.buf.shift()!;
      return Promise.resolve({ value, done: false });
    }
    if (this.done) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiter = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Active session state held while a Query is running.
 */
type ActiveSession = {
  readonly chatSessionId: string;
  readonly invocationId: string;
  readonly query: Query;
  readonly queue: AsyncQueue<SDKUserMessage>;
  /** The WS socket that started this session (best-effort; may be stale after reconnect). */
  ws: WsSocket;
  /** Set to true once chat.interrupt has been received; suppresses late chat.event frames. */
  aborting: boolean;
};

export class Bridge {
  private readonly logger: Logger;
  private readonly registry: SessionRegistry;
  private readonly queryFactory: QueryFactory;
  private readonly cwd: string;
  private readonly home: string | undefined;
  private active: ActiveSession | null = null;

  constructor(opts: BridgeOpts) {
    this.logger = opts.logger;
    this.registry = opts.registry;
    this.queryFactory = opts.queryFactory ?? (({ prompt, options }) =>
      options !== undefined ? sdkQuery({ prompt, options }) : sdkQuery({ prompt }));
    this.cwd = opts.cwd;
    this.home = opts.home;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  activeSessionId(): string | null {
    return this.active?.chatSessionId ?? null;
  }

  // ---------------------------------------------------------------------------
  // chat.start
  // ---------------------------------------------------------------------------

  async handleChatStart(ws: WsSocket, frame: ChatStart): Promise<void> {
    if (this.active !== null) {
      this.sendError(ws, null, "SESSION_BUSY", "A session is already active");
      return;
    }

    const { sessionId: chatSessionId } = this.registry.create();
    const invocationId = crypto.randomUUID();
    const queue = new AsyncQueue<SDKUserMessage>();

    // Load MCP servers from ~/.claude/mcp_servers.json (fallback path per PR-19-D01).
    // The bundled CLI binary would inherit these via HOME in a full installation;
    // since the native binary is unavailable in CI (PR-20-D01), we pass them
    // explicitly via Options.mcpServers so the bridge works in both paths.
    const mcpServers = await loadMcpServers(this.home);
    const hasMcpServers = Object.keys(mcpServers).length > 0;

    const sdkOptions: SDKOptions = {
      cwd: this.cwd,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // Emit SDKPartialAssistantMessage frames so the web UI can stream
      // token-level text through Stream.tsx (PR-22b).
      includePartialMessages: true,
      permissionMode: frame.permissionMode ?? "default",
      ...(hasMcpServers ? { mcpServers } : {}),
    };
    if (frame.model !== undefined) {
      sdkOptions.model = frame.model;
    }
    if (frame.resumeFromInvocationId !== undefined) {
      // resume is a sessionId in the SDK; PR-39 will wire real resume logic.
      sdkOptions.resume = frame.resumeFromInvocationId;
    }

    if (hasMcpServers) {
      this.logger.info("bridge.mcp_servers_loaded", {
        names: Object.keys(mcpServers),
        source: "~/.claude/mcp_servers.json (explicit fallback)",
      });
    }

    const activeQuery = this.queryFactory({ prompt: queue, options: sdkOptions });

    const session: ActiveSession = {
      chatSessionId,
      invocationId,
      query: activeQuery,
      queue,
      ws,
      aborting: false,
    };
    this.active = session;

    this.logger.info("bridge.chat_start", { chatSessionId, invocationId });

    // Run the iteration loop in the background.
    this.runLoop(session, ws).catch((err: unknown) => {
      this.logger.error("bridge.loop_uncaught", {
        chatSessionId: session.chatSessionId,
        err: String(err),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // chat.input
  // ---------------------------------------------------------------------------

  async handleChatInput(ws: WsSocket, frame: ChatInput): Promise<void> {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      this.sendError(ws, frame.sessionId, "NO_ACTIVE_SESSION", "No active session for this id");
      return;
    }

    // Update ws reference so emits go to the current connection.
    session.ws = ws;

    const userMsg: SDKUserMessage = {
      type: "user",
      message: buildMessageParam(frame.text),
      parent_tool_use_id: null,
    };
    session.queue.push(userMsg);
    this.logger.info("bridge.chat_input", {
      chatSessionId: session.chatSessionId,
      textLen: frame.text.length,
    });
  }

  // ---------------------------------------------------------------------------
  // chat.interrupt
  // ---------------------------------------------------------------------------

  async handleChatInterrupt(ws: WsSocket, frame: ChatInterrupt): Promise<void> {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      this.sendError(ws, frame.sessionId, "NO_ACTIVE_SESSION", "No active session for this id");
      return;
    }

    this.logger.info("bridge.chat_interrupt", { chatSessionId: session.chatSessionId });
    // Set abort flag first so the loop stops emitting chat.event frames immediately.
    session.aborting = true;
    await session.query.interrupt();
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.active !== null) {
      const session = this.active;
      this.logger.info("bridge.shutdown", { chatSessionId: session.chatSessionId });
      session.queue.end();
      session.query.close();
      this.active = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal loop
  // ---------------------------------------------------------------------------

  private async runLoop(session: ActiveSession, initialWs: WsSocket): Promise<void> {
    let ws = initialWs;
    let initSent = false;

    try {
      for await (const msg of session.query) {
        // Always use the latest ws reference (updated by handleChatInput).
        ws = session.ws;

        // If an interrupt was received, discard all further SDK events.
        if (session.aborting) continue;

        if (isInitMessage(msg)) {
          if (!initSent) {
            initSent = true;
            this.sendStarted(ws, session, msg);
          }
          // Don't also send as a chat.event — init is consumed by chat.started.
          continue;
        }

        // All other messages → chat.event via replay buffer.
        this.sendEvent(ws, session, msg);
      }

      // Iteration ended: choose reason based on whether an interrupt was requested.
      ws = session.ws;
      this.sendDone(ws, session, session.aborting ? "interrupted" : "completed");
    } catch (err: unknown) {
      ws = session.ws;
      // If the SDK throws after an interrupt, still report interrupted, not errored.
      if (session.aborting) {
        this.sendDone(ws, session, "interrupted");
      } else {
        this.logger.error("bridge.sdk_error", {
          chatSessionId: session.chatSessionId,
          err: String(err),
        });
        this.sendDone(ws, session, "errored");
        this.sendError(ws, session.chatSessionId, "SDK_ERROR", String(err));
      }
    } finally {
      if (this.active === session) {
        this.active = null;
        session.queue.end();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Frame senders
  // ---------------------------------------------------------------------------

  private sendStarted(ws: WsSocket, session: ActiveSession, initMsg: SDKSystemMessage): void {
    const sessionState = this.registry.get(session.chatSessionId);
    const seq = sessionState !== undefined
      ? sessionState.buffer.serverSeq + 1
      : 0;

    const frame: ChatStarted = {
      type: "chat.started",
      seq,
      ts: Date.now(),
      sessionId: session.chatSessionId,
      invocationId: session.invocationId,
      initInfo: {
        model: initMsg.model,
        // Passthrough: SDKInitInfo is a looseObject so unknown fields survive.
        ...(initMsg as Record<string, unknown>),
        // Ensure type field from init message doesn't clobber our frame type.
        type: "system",
      },
    };
    ws.send(JSON.stringify(frame));
    this.logger.info("bridge.chat_started", {
      chatSessionId: session.chatSessionId,
      model: initMsg.model,
    });
  }

  private sendEvent(ws: WsSocket, session: ActiveSession, msg: SDKMessage): void {
    const sessionState = this.registry.get(session.chatSessionId);

    // Build the ChatEvent frame without seq — the buffer assigns it.
    const partial = {
      type: "chat.event" as const,
      seq: 0, // will be overwritten by buffer seq
      ts: Date.now(),
      sessionId: session.chatSessionId,
      invocationId: session.invocationId,
      parentInvocationId: null,
      sdkEvent: msg as Record<string, unknown> & { type: string },
    };

    let seq: number;
    if (sessionState !== undefined) {
      const result = sessionState.buffer.append(partial as ChatEvent);
      seq = result.seq;
    } else {
      seq = 0;
    }

    const frame: ChatEvent = { ...partial, seq };
    ws.send(JSON.stringify(frame));
  }

  private sendDone(ws: WsSocket, session: ActiveSession, reason: ChatDone["reason"]): void {
    const frame: ChatDone = {
      type: "chat.done",
      seq: 0,
      ts: Date.now(),
      sessionId: session.chatSessionId,
      reason,
    };
    ws.send(JSON.stringify(frame));
    this.logger.info("bridge.chat_done", {
      chatSessionId: session.chatSessionId,
      reason,
    });
  }

  private sendError(
    ws: WsSocket,
    sessionId: string | null,
    code: string,
    message: string,
  ): void {
    const frame: ChatError = {
      type: "chat.error",
      seq: 0,
      ts: Date.now(),
      ...(sessionId !== null ? { sessionId } : {}),
      code,
      message,
    };
    ws.send(JSON.stringify(frame));
    this.logger.warn("bridge.chat_error", { sessionId, code, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInitMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system" && (msg as SDKSystemMessage).subtype === "init";
}

/**
 * Build a MessageParam-compatible value from a plain text string.
 * MessageParam is imported from @anthropic-ai/sdk/resources which is not
 * a direct dependency — we use a structural cast since the shape is stable.
 */
function buildMessageParam(text: string): SDKUserMessage["message"] {
  // The 'as' here bridges SDKUserMessage.message (MessageParam) with our local
  // construction. The Anthropic SDK's MessageParam{role:'user', content:string}
  // is the simplest valid form and matches what the CLI subprocess expects.
  return { role: "user", content: text } as SDKUserMessage["message"];
}
