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
  CanUseTool,
  OnElicitation,
  ElicitationRequest,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../log/logger";
import type { SessionRegistry } from "../seq/sessionRegistry";
import type {
  ChatStart,
  ChatInput,
  ChatInterrupt,
  ChatPermissionReply,
  ChatElicitationReply,
  ChatEvent,
  ChatStarted,
  ChatDone,
  ChatError,
  ChatPermissionRequest,
  ChatElicitationRequest,
} from "@cq/shared";
import { loadMcpServers } from "./mcp";
import { PermissionBroker } from "./permission";
import { ElicitationBroker } from "./elicitation";
import { applyReadOnlyOverlay } from "./readOnlyOverlay";

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
  /**
   * Override the PermissionBroker for tests.
   * Defaults to a fresh PermissionBroker instance per Bridge.
   */
  permissionBroker?: PermissionBroker;
  /**
   * Override the ElicitationBroker for tests.
   * Defaults to a fresh ElicitationBroker instance per Bridge.
   */
  elicitationBroker?: ElicitationBroker;
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
  /**
   * The UI-level permission mode label sent in ChatStart.permissionMode.
   * "read-only" activates the canUseTool deny overlay; all other values are
   * forwarded directly to the SDK. The SDK always receives "default" when
   * the UI label is "read-only" (SDK has no equivalent mode).
   */
  uiMode: string;
};

export class Bridge {
  private readonly logger: Logger;
  private readonly registry: SessionRegistry;
  private readonly queryFactory: QueryFactory;
  private readonly cwd: string;
  private readonly home: string | undefined;
  private active: ActiveSession | null = null;
  readonly permissionBroker: PermissionBroker;
  readonly elicitationBroker: ElicitationBroker;

  constructor(opts: BridgeOpts) {
    this.logger = opts.logger;
    this.registry = opts.registry;
    this.queryFactory = opts.queryFactory ?? (({ prompt, options }) =>
      options !== undefined ? sdkQuery({ prompt, options }) : sdkQuery({ prompt }));
    this.cwd = opts.cwd;
    this.home = opts.home;
    this.permissionBroker = opts.permissionBroker ?? new PermissionBroker();
    this.elicitationBroker = opts.elicitationBroker ?? new ElicitationBroker();
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

    // Capture session identifiers for use inside the canUseTool closure.
    // These are assigned before the closure is called by the SDK.
    const capturedChatSessionId = chatSessionId;
    const capturedInvocationId = invocationId;

    // The UI-level mode label. "read-only" is a cq-level concept; the SDK
    // does not know about it and always receives "default" in that case.
    const uiMode: string = frame.permissionMode ?? "default";
    // Map the UI label to a valid SDK permissionMode. "read-only" has no SDK
    // equivalent so we fall back to "default" and let the overlay handle it.
    // We widen to `string` first to avoid an unsafe cast from a type that already
    // includes `"read-only"`, then narrow to the SDK-accepted union.
    const rawMode: string = uiMode === "read-only" ? "default" : uiMode;
    const sdkPermissionMode = rawMode as Exclude<SDKOptions["permissionMode"], undefined>;

    const brokerCanUseTool: CanUseTool = async (toolName, input, ctx) => {
      return this.permissionBroker.request({
        sessionId: capturedChatSessionId,
        invocationId: capturedInvocationId,
        toolName,
        toolUseId: ctx.toolUseID,
        input,
        ...(ctx.title !== undefined ? { title: ctx.title } : {}),
        ...(ctx.displayName !== undefined ? { displayName: ctx.displayName } : {}),
        ...(ctx.description !== undefined ? { description: ctx.description } : {}),
        ...(ctx.suggestions !== undefined ? { suggestions: ctx.suggestions } : {}),
      });
    };

    const onElicitation: OnElicitation = async (req: ElicitationRequest) => {
      return this.elicitationBroker.request(capturedChatSessionId, req);
    };

    // Wrap with the read-only overlay. The overlay reads uiMode via a getter
    // so any future mid-session change to the session object is reflected.
    // We use a mutable box so the getter can reference the session object even
    // though `session` is declared after this closure.
    const uiModeRef = { current: uiMode };
    const canUseTool: CanUseTool = applyReadOnlyOverlay(
      brokerCanUseTool,
      () => uiModeRef.current,
    );

    const sdkOptions: SDKOptions = {
      cwd: this.cwd,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // Emit SDKPartialAssistantMessage frames so the web UI can stream
      // token-level text through Stream.tsx (PR-22b).
      includePartialMessages: true,
      canUseTool,
      onElicitation,
      permissionMode: sdkPermissionMode,
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
      uiMode,
    };
    this.active = session;

    // Wire the permission broker's send callback to forward chat.permission_request
    // frames over the current WS connection.
    this.permissionBroker.setSendFrame((frame: ChatPermissionRequest) => {
      session.ws.send(JSON.stringify(frame));
    });

    // Wire the elicitation broker's send callback to forward chat.elicitation_request
    // frames over the current WS connection.
    this.elicitationBroker.setSendFrame((frame: ChatElicitationRequest) => {
      session.ws.send(JSON.stringify(frame));
    });

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
  // chat.permission_reply
  // ---------------------------------------------------------------------------

  handleChatPermissionReply(_ws: WsSocket, frame: ChatPermissionReply): void {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      // Stale reply (session already ended) — ignore silently.
      return;
    }
    this.permissionBroker.reply(frame.permissionRequestId, frame.decision);
  }

  // ---------------------------------------------------------------------------
  // chat.elicitation_reply
  // ---------------------------------------------------------------------------

  handleChatElicitationReply(_ws: WsSocket, frame: ChatElicitationReply): void {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      // Stale reply (session already ended) — ignore silently.
      return;
    }
    this.elicitationBroker.reply(
      frame.elicitationId,
      frame.action,
      frame.content,
    );
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

        // Intercept SDKElicitationCompleteMessage to resolve URL-mode elicitations.
        if (isElicitationCompleteMessage(msg)) {
          this.elicitationBroker.completeUrl(
            (msg as Record<string, unknown>)["elicitation_id"] as string,
          );
          // Still forward as a chat.event so the client can remove the card.
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
      // Reject any pending permission requests — the session is over.
      this.permissionBroker.rejectAll();
      this.permissionBroker.clearSendFrame();
      // Cancel any pending elicitation requests — the session is over.
      this.elicitationBroker.rejectAll();
      this.elicitationBroker.clearSendFrame();
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

function isElicitationCompleteMessage(msg: SDKMessage): boolean {
  return (
    msg.type === "system" &&
    (msg as Record<string, unknown>)["subtype"] === "elicitation_complete" &&
    typeof (msg as Record<string, unknown>)["elicitation_id"] === "string"
  );
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
