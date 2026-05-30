/**
 * claudeBridge.ts — Claude-platform backend (was bridge.ts pre-codex-4).
 *
 * Implements BackendBridge. Dispatched to by the Bridge facade in
 * bridge.ts when ChatStart.platform === 'claude' (or absent).
 *
 * Original bridge.ts docstring:
 *   - Accepts `chat.start` → calls `query({ prompt: asyncIterable })`.
 *   - Accepts `chat.input` → pushes SDKUserMessage onto the async queue.
 *   - Accepts `chat.interrupt` → calls `Query.interrupt()`.
 *   - Iterates yielded SDKMessages and maps them to outbound frames:
 *       - SDKSystemMessage{subtype:'init'} → `chat.started`
 *       - All other SDKMessage variants → `chat.event` (via replay buffer)
 *       - Stream end → `chat.done{reason:'completed'}`
 *       - SDK iteration error → `chat.done{reason:'errored'}` + `chat.error`
 *   - Preempts any active session on concurrent `chat.start` (interruptActive
 *     + shutdown), then starts the new session (E2E-D04).
 *
 * Pool size: 1 (one active Query at a time). The facade enforces pool=1
 * across both backends.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge } from "./backendBridge";
import { createRequire } from "node:module";
import type {
  Query,
  Options as SDKOptions,
  SDKUserMessage,
  SDKMessage,
  SDKSystemMessage,
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
  CanUseTool,
  OnElicitation,
  ElicitationRequest,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../log/logger";
import type { SessionRegistry } from "../seq/sessionRegistry";
import type { Effort } from "@cq/shared";
import { effortToClaudeBudgetTokens } from "@cq/shared";
import path from "node:path";
import type { Persistence } from "../persist/Persistence.js";
import { InMemoryPersistence } from "../persist/InMemoryPersistence.js";
import type {
  ChatStart,
  ChatRejoin,
  ChatInput,
  ChatInterrupt,
  ChatPermissionReply,
  ChatElicitationReply,
  ChatQuestionReply,
  ChatReadFileRequest,
  ChatEvent,
  ChatStarted,
  ChatDone,
  ChatError,
  ChatPermissionRequest,
  ChatElicitationRequest,
  HistoryUpdate,
} from "@cq/shared";
import type { SessionRow, InvocationRow } from "@cq/shared";
import { handleReadFile } from "./readFile";
import { loadMcpServers } from "./mcp";
import { PermissionBroker } from "./permission";
import { ElicitationBroker } from "./elicitation";
import { applyReadOnlyOverlay } from "./readOnlyOverlay";
import { AskBroker, createAskUserQuestionTool } from "./askUserQuestion";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { LedgerStore } from "@cq/ledger";
import { createLedgerMcpTools } from "@cq/ledger";
import {
  AnthropicTitleGenerator,
  type TitleGenerator,
} from "./titleGenerator";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

// WsSocket is now defined in backendBridge.ts; re-export for downstream
// imports that targeted bridge.ts before codex-4. (The Bridge facade also
// re-exports it.)
import type { WsSocket } from "./backendBridge";
export type { WsSocket };

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
  /**
   * Override the AskBroker for tests.
   * Defaults to a fresh AskBroker instance per Bridge.
   */
  askBroker?: AskBroker;
  /**
   * Persistence adapter for recording sessions, invocations, and events.
   * Defaults to InMemoryPersistence (for tests and standalone use).
   * Wire SqlitePersistence in main.ts / server.ts for production.
   */
  persistence?: Persistence;
  /**
   * Optional LedgerStore. When provided, exposes the ledger MCP tools
   * (`mcp__cq__enumerate_ledgers`, `mcp__cq__fetch_ledger`, etc.) on the
   * in-process "cq" MCP server alongside `ask_user_question`.
   *
   * The store must already be `init()`-ed by the caller; the bridge does
   * not own its lifecycle. main.ts / server.ts construct and pass it.
   */
  ledgerStore?: LedgerStore;
  /**
   * Pluggable Haiku-based session title generator. Defaults to
   * AnthropicTitleGenerator (real HTTP API). Tests inject a fake to avoid
   * a real network call.
   */
  titleGenerator?: TitleGenerator;
  /**
   * Fired on EVERY transition of the chat-lane busy state (a turn starting or
   * ending), AFTER `this.active` is updated, so a listener reading `isBusy()`
   * sees the post-transition value (ACTIVITY-01). Wired by the Bridge facade to
   * the aggregate activity tracker. Observe-only: it never changes pool=1.
   */
  onBusyChange?: () => void;
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
   * ACTIVITY-01: true while a TURN is streaming (the model is working), false
   * between turns. Distinct from session-aliveness (`active !== null`): in the
   * multi-turn streaming model the session stays alive across turns, so the
   * aggregate-activity badge must track this per-turn flag, not session life.
   * Set true at turn start (chat.start first turn + each chat.input), cleared in
   * `sendDone` (per-turn chat.done). Read via `isTurnInFlight()`.
   */
  turnInFlight: boolean;
  /**
   * The UI-level permission mode label sent in ChatStart.permissionMode.
   * "read-only" activates the canUseTool deny overlay; all other values are
   * forwarded directly to the SDK. The SDK always receives "default" when
   * the UI label is "read-only" (SDK has no equivalent mode).
   */
  uiMode: string;
  /** Wall-clock start time for duration_ms calculation at finalisation. */
  readonly startedAt: number;
  /** Map from SDK task_id to child InvocationRow.id (for task finalisation). */
  readonly taskInvocationMap: Map<string, string>;
  /**
   * Map from parent_tool_use_id → child InvocationRow.id.
   * Built in handleTaskStarted from msg.tool_use_id. Used to route subagent
   * assistant messages to the correct child invocation row.
   */
  readonly toolUseInvocationMap: Map<string, string>;
  /** Running tool_call_count accumulator for the top-level invocation. */
  toolCallCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Per-child-invocation tool_call_count accumulators, keyed by child invocationId.
   * NOTE: cost_usd, input_tokens, output_tokens are NOT tracked per-child because
   * the SDK emits one result message per top-level turn boundary only; there is no
   * per-subagent cost breakdown available. Those fields remain 0 on child rows.
   */
  readonly childToolCallCounts: Map<string, number>;
  /**
   * The first user-typed message text for this session, captured the first
   * time `handleChatInput` runs. Used by the Haiku title generator. Empty
   * until `handleChatInput` populates it.
   */
  firstUserText: string;
  /**
   * Set once the title generator has been kicked off for this session.
   * Stops the bridge from firing duplicate requests on later `result`s.
   */
  titleRequested: boolean;
};

export class ClaudeBridge implements BackendBridge {
  private readonly logger: Logger;
  private readonly registry: SessionRegistry;
  private readonly queryFactory: QueryFactory;
  private readonly cwd: string;
  private readonly home: string | undefined;
  private active: ActiveSession | null = null;
  readonly permissionBroker: PermissionBroker;
  readonly elicitationBroker: ElicitationBroker;
  readonly askBroker: AskBroker;
  private readonly persistence: Persistence;
  private readonly ledgerStore: LedgerStore | null;
  private readonly titleGenerator: TitleGenerator;
  /** ACTIVITY-01: fired on every `active`-slot transition (assign-then-notify). */
  private readonly onBusyChange: (() => void) | undefined;

  constructor(opts: BridgeOpts) {
    this.logger = opts.logger;
    this.registry = opts.registry;
    this.onBusyChange = opts.onBusyChange;
    this.queryFactory = opts.queryFactory ?? (({ prompt, options }) =>
      options !== undefined ? sdkQuery({ prompt, options }) : sdkQuery({ prompt }));
    // Resolve cwd to an absolute path so the UI's path indicator shows
    // something meaningful (e.g. "/home/user/project") rather than the
    // literal CLI argument ("." or "./foo"). D-CWD.
    this.cwd = path.resolve(opts.cwd);
    this.home = opts.home;
    this.permissionBroker = opts.permissionBroker ?? new PermissionBroker();
    this.permissionBroker.setLogger(this.logger);
    this.elicitationBroker = opts.elicitationBroker ?? new ElicitationBroker();
    this.elicitationBroker.setLogger(this.logger);
    this.askBroker = opts.askBroker ?? new AskBroker();
    this.persistence = opts.persistence ?? new InMemoryPersistence();
    this.ledgerStore = opts.ledgerStore ?? null;
    this.titleGenerator = opts.titleGenerator ?? new AnthropicTitleGenerator();
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * ACTIVITY-01: true iff a TURN is currently streaming (the model is working).
   * Unlike `isBusy()` (session-active, used for pool=1 preempt), this is false
   * between turns of a live multi-turn session — the per-turn truth the
   * aggregate-activity badge needs.
   */
  isTurnInFlight(): boolean {
    return this.active !== null && this.active.turnInFlight;
  }

  activeSessionId(): string | null {
    return this.active?.chatSessionId ?? null;
  }

  /**
   * Fire the busy-change listener (ACTIVITY-01). Called after any transition of
   * either the `active` slot or the active session's `turnInFlight` flag, so the
   * aggregate tracker recomputes whenever chat-lane activity changes.
   */
  private notifyBusyChange(): void {
    if (this.onBusyChange !== undefined) {
      try {
        this.onBusyChange();
      } catch (err: unknown) {
        this.logger.warn("bridge.busy_listener_error", { err: String(err) });
      }
    }
  }

  /**
   * Assign the `active` slot and notify the busy-change listener (ACTIVITY-01).
   * The SINGLE point through which `this.active` is mutated — every set and
   * clear routes here so no transition can bypass the notification. Order is
   * assign-THEN-notify so a listener reading `isTurnInFlight()` sees the new value.
   */
  private setActive(next: ActiveSession | null): void {
    this.active = next;
    this.notifyBusyChange();
  }

  /**
   * Toggle the active session's per-turn `turnInFlight` flag and notify
   * (ACTIVITY-01). No-op when it is already at `value` (idempotent — avoids a
   * redundant notification) or when there is no active session.
   */
  private setTurnInFlight(value: boolean): void {
    if (this.active === null || this.active.turnInFlight === value) return;
    this.active.turnInFlight = value;
    this.notifyBusyChange();
  }

  // ---------------------------------------------------------------------------
  // chat.start
  // ---------------------------------------------------------------------------

  async handleChatStart(ws: WsSocket, frame: ChatStart): Promise<void> {
    // codex-3: this bridge only handles platform='claude'. Cross-platform
    // resume must be refused BEFORE preempting the active session so an
    // accidental mismatch does not destroy the live session.
    const requestedPlatform: "claude" | "codex" = frame.platform ?? "claude";
    if (frame.resumeFromInvocationId !== undefined) {
      const priorInv = this.persistence.invocations.get(frame.resumeFromInvocationId);
      const priorSession = priorInv !== undefined
        ? this.persistence.sessions.get(priorInv.sessionId)
        : undefined;
      if (priorSession !== undefined && priorSession.platform !== requestedPlatform) {
        this.sendError(
          ws,
          priorSession.id,
          "platform-mismatch",
          `Cannot resume a ${priorSession.platform} session with a ${requestedPlatform} model; switch the model dropdown back to a ${priorSession.platform} model and try again.`,
        );
        return;
      }
    }
    // ClaudeBridge only handles Claude sessions. If the facade routes a
    // Codex frame here, refuse rather than silently downgrading.
    if (requestedPlatform !== "claude") {
      this.sendError(
        ws,
        null,
        "platform-mismatch",
        `ClaudeBridge cannot handle platform='${requestedPlatform}'.`,
      );
      return;
    }

    // Preempt any active session before starting a new one (E2E-D04).
    if (this.active !== null) {
      this.logger.info("bridge.chat_start_preempt", {
        prior: this.active.chatSessionId,
      });
      this.interruptActive();
      await this.shutdown(); // awaits runLoop's finally — emits chat.done{interrupted}
      // this.active is now null
    }

    // Determine chatSessionId: reuse prior session when resuming, create fresh otherwise.
    let chatSessionId: string;
    let isResumption = false;
    let resumedFromInvocationId: string | null = null;

    if (frame.resumeFromInvocationId !== undefined) {
      const priorInv = this.persistence.invocations.get(frame.resumeFromInvocationId);
      const priorSession = priorInv !== undefined
        ? this.persistence.sessions.get(priorInv.sessionId)
        : undefined;
      if (priorInv !== undefined && priorSession !== undefined) {
        chatSessionId = priorSession.id;
        isResumption = true;
        resumedFromInvocationId = frame.resumeFromInvocationId;
        this.registry.register(chatSessionId);
      } else {
        this.logger.warn("bridge.resume_unknown_invocation", { invocationId: frame.resumeFromInvocationId });
        chatSessionId = this.registry.create().sessionId;
      }
    } else {
      chatSessionId = this.registry.create().sessionId;
    }

    const invocationId = crypto.randomUUID();
    const queue = new AsyncQueue<SDKUserMessage>();
    const startedAt = Date.now();

    // Load MCP servers from ~/.claude/mcp_servers.json (fallback path per PR-19-D01).
    // The bundled CLI binary would inherit these via HOME in a full installation;
    // since the native binary is unavailable in CI (PR-20-D01), we pass them
    // explicitly via Options.mcpServers so the bridge works in both paths.
    const externalMcpServers = await loadMcpServers(this.home, this.logger);
    const hasMcpServers = Object.keys(externalMcpServers).length > 0;

    // Build the in-process "cq" MCP server. Always contains the
    // AskUserQuestion tool; also exposes the @cq/ledger tools when a
    // LedgerStore was wired into the bridge.
    const cqTools: unknown[] = [createAskUserQuestionTool(this.askBroker)];
    if (this.ledgerStore !== null) {
      for (const t of createLedgerMcpTools(this.ledgerStore)) {
        cqTools.push(t);
      }
    }
    const cqMcpServer = createSdkMcpServer({
      name: "cq",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: cqTools as any,
    });
    const mcpServers = {
      ...externalMcpServers,
      cq: cqMcpServer,
    };

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
      // Auto-allow the internal "cq" MCP tools (e.g. mcp__cq__ask_user_question).
      // These are not user-facing tools; exposing them to the permission broker
      // would deadlock the AskUserQuestion flow (the WS client must not need to
      // grant permission before answering a question).
      // `updatedInput: {}` is included to satisfy the subprocess Zod schema
      // which requires a record (not undefined) even though the TS type marks it optional.
      if (toolName.startsWith("mcp__cq__")) {
        return { behavior: "allow", updatedInput: {} };
      }
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

    // Bun workaround: resolve the native binary path explicitly.
    // Under Bun, child_process.spawn can fail to launch the native CLI binary
    // even when the file exists (ENOENT-type spawn error in Bun's emulation).
    // Passing pathToClaudeCodeExecutable bypasses the SDK's default lookup and
    // the problematic spawn path. Returns undefined in non-Bun runtimes so the
    // SDK performs its own resolution unmodified.
    const nativeBinPath = resolveNativeBinaryPath();

    // gear-4: map ChatStart.effort → SDK thinking config. `none` disables
    // thinking entirely; the rest map to a numeric budget_tokens (see
    // @cq/shared/effort.ts for the canonical table). The SDK's `thinking`
    // option lives on its Options union — only present here when the
    // user explicitly requested reasoning.
    const requestedEffort: Effort = frame.effort ?? "none";
    const thinkingBudget = effortToClaudeBudgetTokens(requestedEffort);

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
      // Always include mcpServers (at minimum the "cq" in-process server for
      // AskUserQuestion interception; plus any external servers from config).
      mcpServers,
      // Redirect AskUserQuestion tool_uses to the in-process MCP handler so
      // the SDK round-trip happens via the native protocol rather than Candidate-A
      // synthetic SDKUserMessage injection.
      toolAliases: { AskUserQuestion: "mcp__cq__ask_user_question" },
      ...(nativeBinPath !== undefined ? { pathToClaudeCodeExecutable: nativeBinPath } : {}),
    };
    if (thinkingBudget !== null) {
      // The SDK's Options type does not export the `thinking` shape directly,
      // so we add it via an assertion. The runtime shape is documented by the
      // Anthropic SDK: `{ thinking: { type: 'enabled', budget_tokens: number } }`.
      (sdkOptions as unknown as Record<string, unknown>)["thinking"] = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
    }
    if (frame.model !== undefined) {
      sdkOptions.model = frame.model;
    }
    if (isResumption) {
      // Pass the prior session's sdkSessionId so the SDK reattaches to the conversation.
      const priorSession = this.persistence.sessions.get(chatSessionId);
      if (priorSession?.sdkSessionId !== undefined && priorSession.sdkSessionId !== null) {
        sdkOptions.resume = priorSession.sdkSessionId;
      }
    }

    if (hasMcpServers) {
      this.logger.info("bridge.mcp_servers_loaded", {
        names: Object.keys(externalMcpServers),
        source: "~/.claude/mcp_servers.json (explicit fallback)",
      });
    }

    // Insert/re-open session and top-level invocation rows before the query starts.
    const invocationEventLogPath = `${chatSessionId}/${invocationId}.jsonl`;
    const invocationRow: InvocationRow = {
      id: invocationId,
      sessionId: chatSessionId,
      parentInvocationId: null,
      resumedFromInvocationId,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: frame.model ?? "",
      startedAt,
      endedAt: null,
      durationMs: null,
      status: "running",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: "",
      eventLogPath: invocationEventLogPath,
      ownerPid: process.pid,
    };
    this.persistence.withTx(() => {
      if (isResumption) {
        // Re-open the prior session row (it was closed when the prior invocation ended).
        this.persistence.sessions.update(chatSessionId, {
          endedAt: null,
          endedReason: null,
        });
      } else {
        const sessionRow: SessionRow = {
          id: chatSessionId,
          startedAt,
          endedAt: null,
          cwd: this.cwd,
          model: frame.model ?? "",
          permissionMode: uiMode,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheRead: 0,
          totalCacheCreate: 0,
          totalCostUsd: 0,
          endedReason: null,
          title: "",
          lastServerSeq: 0,
          sdkSessionId: null,
          // gear-2: platform always "claude" until codex-3 wires platform routing.
          platform: "claude",
          // gear-2: effort taken from ChatStart.effort or default "none".
          effort: frame.effort ?? "none",
          // gcn1-1: Claude sessions never carry a Codex approvalPolicy.
          // Stored as NULL so both adapters' shapes match on read.
          approvalPolicy: null,
        };
        this.persistence.sessions.insert(sessionRow);
      }
      this.persistence.invocations.insert(invocationRow);
    });

    const activeQuery = this.queryFactory({ prompt: queue, options: sdkOptions });

    const session: ActiveSession = {
      chatSessionId,
      invocationId,
      query: activeQuery,
      queue,
      ws,
      aborting: false,
      // ACTIVITY-01: the first turn begins immediately on session creation (the
      // SDK starts working on the initial prompt), so the turn is in flight.
      turnInFlight: true,
      uiMode,
      startedAt,
      taskInvocationMap: new Map(),
      toolUseInvocationMap: new Map(),
      toolCallCount: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      childToolCallCounts: new Map(),
      firstUserText: "",
      titleRequested: false,
    };
    this.setActive(session);

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

    // Emit chat.started preemptively so the client learns its sessionId
    // immediately and can begin sending chat.input. The real SDK subprocess
    // emits its `system/init` message only AFTER it receives the first user
    // message on stdin — so without this preemptive frame, the client and
    // SDK deadlock waiting for each other.
    //
    // The runLoop will fire chat.started a second time when the SDK actually
    // emits init (carrying real cwd, slash_commands, mcp_servers, etc.). The
    // client treats the second one as an update for the same sessionId.
    this.sendStartedEarly(ws, session);

    // Run the iteration loop in the background.
    this.runLoop(session, ws).catch((err: unknown) => {
      this.logger.error("bridge.loop_uncaught", {
        chatSessionId: session.chatSessionId,
        err: String(err),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // chat.rejoin
  // ---------------------------------------------------------------------------

  async handleChatRejoin(ws: WsSocket, frame: ChatRejoin): Promise<void> {
    // Case A: the requested session IS our currently-active session.
    if (this.active !== null && this.active.chatSessionId === frame.sessionId) {
      // Bind the new WS to the active session so subsequent frames go to it.
      this.active.ws = ws;
      // Re-emit chat.started so the client knows it has rejoined.
      this.sendStartedEarly(ws, this.active);
      // Replay all events from the active invocation's log.
      await this.replayInvocationEvents(ws, frame.seq, this.active.invocationId);
      this.logger.info("bridge.chat_rejoin_active", { chatSessionId: frame.sessionId });
      return;
    }

    // Case B: no matching active session — look up the most recent invocation
    // for this session in persistence and delegate to handleChatStart with a
    // resumeFromInvocationId so the existing resume path handles it.
    const sessionRow = this.persistence.sessions.get(frame.sessionId);
    if (sessionRow === undefined) {
      this.sendError(ws, frame.sessionId, "REJOIN_FAILED", "Session not found");
      return;
    }

    const invs = this.persistence.invocations.listForSession(frame.sessionId);
    const main = invs
      .filter((i) => i.parentInvocationId === null && i.agentName === "main")
      .sort((a, b) => b.startedAt - a.startedAt)[0];

    if (main === undefined) {
      this.sendError(ws, frame.sessionId, "REJOIN_FAILED", "No invocations in session");
      return;
    }

    this.logger.info("bridge.chat_rejoin_resume", {
      chatSessionId: frame.sessionId,
      resumeFromInvocationId: main.id,
    });

    // Emit chat.started immediately so the client sees the expected sessionId
    // before any replay frames arrive.  The live handleChatStart below will
    // emit a second chat.started (chat.started_late) once the SDK subprocess
    // sends its init message — clients tolerate this sequence.
    const earlySeq = (() => {
      const state = this.registry.get(frame.sessionId);
      return state !== undefined ? state.buffer.serverSeq + 1 : 0;
    })();
    const earlyStarted: ChatStarted = {
      type: "chat.started",
      seq: earlySeq,
      ts: Date.now(),
      sessionId: frame.sessionId,
      invocationId: main.id,
      initInfo: { cwd: this.cwd },
    };
    ws.send(JSON.stringify(earlyStarted));

    // Replay prior invocation events before spinning up the new live runLoop.
    // This prevents the SDK's independent chat.started from interleaving with
    // history.replay_event frames (R3 ordering fix).
    await this.replayInvocationEvents(ws, frame.seq, main.id);

    // Now start the live session (emits its own chat.started when SDK init arrives).
    await this.handleChatStart(ws, {
      type: "chat.start",
      seq: frame.seq,
      ts: frame.ts,
      resumeFromInvocationId: main.id,
    });
  }

  /**
   * Streams all persisted events for an invocation as history.replay_event frames,
   * then emits history.replay_done. Used by handleChatRejoin to restore client state.
   */
  private async replayInvocationEvents(
    ws: WsSocket,
    requestSeq: number,
    invocationId: string,
  ): Promise<void> {
    let ordinal = 0;
    for await (const event of this.persistence.events.readAll(invocationId)) {
      ws.send(JSON.stringify({
        type: "history.replay_event",
        seq: 0,
        ts: Date.now(),
        requestSeq,
        invocationId,
        ordinal: ordinal++,
        sdkEvent: event,
      }));
    }
    ws.send(JSON.stringify({
      type: "history.replay_done",
      seq: 0,
      ts: Date.now(),
      requestSeq,
    }));
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

    // Capture the first user message text for the title generator (PR-01).
    // Only the first call wins — later inputs in the same session are ignored
    // by this branch.
    if (session.firstUserText === "" && frame.text.length > 0) {
      session.firstUserText = frame.text;
    }

    const userMsg: SDKUserMessage = {
      type: "user",
      message: buildMessageParam(frame.text),
      parent_tool_use_id: null,
    };

    // D24: persist the user's typed input as a chat.event so it (a) appears
    // in the live stream and (b) is preserved in the JSONL log for replay on
    // resume. The SDK does not echo typed-user input back through the
    // iterator (only tool_result wrapper "user" frames are emitted there),
    // so without this synthesis the user's bubble never renders.
    const echoMsg = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: frame.text }],
        id: `user-${session.chatSessionId}-${Date.now()}`,
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage;
    this.persistence.events.append(session.invocationId, echoMsg);
    this.sendEvent(ws, session, echoMsg);

    session.queue.push(userMsg);
    // ACTIVITY-01: a new user message begins a new turn — the model resumes
    // working, so mark the turn in flight (push the badge back to BUSY).
    this.setTurnInFlight(true);
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
  // chat.question_reply
  // ---------------------------------------------------------------------------

  handleChatQuestionReply(_ws: WsSocket, frame: ChatQuestionReply): void {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      // Stale reply (session already ended) — ignore silently.
      return;
    }
    const resolved = this.askBroker.reply(frame.toolUseId, frame.answers);
    this.logger.info("bridge.question_reply", {
      chatSessionId: session.chatSessionId,
      toolUseId: frame.toolUseId,
      brokered: resolved,
    });
  }

  // ---------------------------------------------------------------------------
  // chat.read_file_request
  // ---------------------------------------------------------------------------

  async handleChatReadFileRequest(ws: WsSocket, frame: ChatReadFileRequest): Promise<void> {
    const session = this.active;
    if (session === null || session.chatSessionId !== frame.sessionId) {
      // No active session — return an error result so the UI can surface it.
      const result = {
        type: "chat.read_file_result" as const,
        seq: 0,
        ts: Date.now(),
        requestId: frame.requestId,
        content: "",
        startLine: 0,
        error: "No active session",
      };
      ws.send(JSON.stringify(result));
      return;
    }

    const seq = (() => {
      const state = this.registry.get(session.chatSessionId);
      return state !== undefined ? state.buffer.serverSeq + 1 : 0;
    })();

    const result = await handleReadFile(session.query, frame, seq);
    ws.send(JSON.stringify(result));
  }

  // ---------------------------------------------------------------------------
  // interruptActive — for graceful shutdown
  // ---------------------------------------------------------------------------

  /**
   * Signal the currently-active query (if any) to stop.
   * Sets the aborting flag and calls Query.interrupt() so the SDK unblocks.
   * Returns immediately — the caller should then wait for activeSessionId()
   * to become null (i.e. the runLoop finally block fires).
   */
  interruptActive(): void {
    const session = this.active;
    if (session === null) return;
    this.logger.info("bridge.interrupt_active", { chatSessionId: session.chatSessionId });
    session.aborting = true;
    // Fire-and-forget: interrupt() is async but we cannot await here because
    // the caller (shutdown.ts) will race against the timeout independently.
    session.query.interrupt().catch((err: unknown) => {
      this.logger.warn("bridge.interrupt_active_error", { err: String(err) });
    });
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
      this.setActive(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal loop
  // ---------------------------------------------------------------------------

  private async runLoop(session: ActiveSession, initialWs: WsSocket): Promise<void> {
    let ws = initialWs;
    let initSent = false;
    let doneReason: ChatDone["reason"] = "completed";
    // Tracks whether we already emitted chat.done for the most recent turn.
    // Prevents a second chat.done (reason='interrupted') from being emitted when
    // the for-await ends or catches after a turn that already completed normally.
    let turnDoneSent = false;

    try {
      for await (const msg of session.query) {
        // Always use the latest ws reference (updated by handleChatInput).
        ws = session.ws;

        // If an interrupt was received, discard all further SDK events.
        if (session.aborting) continue;

        if (isInitMessage(msg)) {
          if (!initSent) {
            initSent = true;
            // Capture the SDK session_id from the init message for session row.
            const sdkSessionId = (msg as Record<string, unknown>)["session_id"] as string | undefined;
            if (sdkSessionId) {
              this.persistence.sessions.update(session.chatSessionId, { sdkSessionId });
            }
            // Update model from init if not specified in ChatStart.
            const initModel = msg.model;
            if (initModel) {
              this.persistence.sessions.update(session.chatSessionId, { model: initModel });
              this.persistence.invocations.update(session.invocationId, { model: initModel });
            }
            this.sendStarted(ws, session, msg);
          }
          // Don't also send as a chat.event — init is consumed by chat.started.
          continue;
        }

        // D30: fwdMsg may be augmented (e.g. with child_invocation_id on task_started)
        // before persisting and forwarding. Starts as the raw SDK message.
        let fwdMsg: SDKMessage = msg;

        // Intercept SDKElicitationCompleteMessage to resolve URL-mode elicitations.
        if (isElicitationCompleteMessage(msg)) {
          this.elicitationBroker.completeUrl(
            (msg as Record<string, unknown>)["elicitation_id"] as string,
          );
          // Still forward as a chat.event so the client can remove the card.
        }

        // Handle task_started: insert a child invocation row.
        // D30: inject the child_invocation_id into the forwarded event so the
        // renderer can attach a "View transcript →" link to the SubagentCard.
        if (isTaskStartedMessage(msg)) {
          const childInvId = this.handleTaskStarted(session, ws, msg as SDKTaskStartedMessage);
          fwdMsg = { ...msg, child_invocation_id: childInvId } as unknown as SDKMessage;
        }

        // Handle task_notification: finalise the child invocation row.
        if (isTaskNotificationMessage(msg)) {
          this.handleTaskNotification(session, ws, msg as SDKTaskNotificationMessage);
          // Still forward as a chat.event.
        }

        // Persist the raw SDK event to the JSONL log (with any augmentations).
        // D36: if parent_tool_use_id resolves to a known child invocation, append to
        // the child log (and also to the parent for continuity). task_started and
        // task_notification are control messages about the task lifecycle — they always
        // go to the parent only (the child row doesn't exist yet at task_started time).
        {
          const rawParentToolUseId = (fwdMsg as Record<string, unknown>)["parent_tool_use_id"];
          const parentToolUseId = typeof rawParentToolUseId === "string" ? rawParentToolUseId : null;
          const childInvId = parentToolUseId !== null
            ? session.toolUseInvocationMap.get(parentToolUseId)
            : undefined;

          if (childInvId !== undefined) {
            // Write to child log + parent log for streaming UX continuity.
            this.persistence.events.append(childInvId, fwdMsg);
            this.persistence.events.append(session.invocationId, fwdMsg);
          } else {
            this.persistence.events.append(session.invocationId, fwdMsg);
          }
        }

        // All other messages → chat.event via replay buffer.
        this.sendEvent(ws, session, fwdMsg);

        // Count tool_use content blocks on assistant messages.
        // If parent_tool_use_id identifies a known child invocation, credit that
        // child row; otherwise credit the top-level invocation (existing behaviour).
        if (msg.type === "assistant") {
          const assistantMsg = msg as Record<string, unknown> & {
            message?: { content?: unknown; model?: string };
            parent_tool_use_id?: string | null;
          };
          const content = assistantMsg.message?.content;
          const parentToolUseId = assistantMsg.parent_tool_use_id ?? null;
          const childInvId = parentToolUseId !== null
            ? session.toolUseInvocationMap.get(parentToolUseId)
            : undefined;

          if (Array.isArray(content)) {
            const toolUses = (content as Array<{ type: string }>).filter(
              (b) => b.type === "tool_use",
            ).length;
            if (toolUses > 0) {
              if (childInvId !== undefined) {
                // Subagent assistant message → update child row.
                const prev = session.childToolCallCounts.get(childInvId) ?? 0;
                const next = prev + toolUses;
                session.childToolCallCounts.set(childInvId, next);
                this.persistence.invocations.update(childInvId, { toolCallCount: next });
                this.sendHistoryUpdate(ws, childInvId, { toolCallCount: next });
              } else {
                // Top-level assistant message → update parent row.
                session.toolCallCount += toolUses;
                this.persistence.invocations.update(session.invocationId, {
                  toolCallCount: session.toolCallCount,
                });
                this.sendHistoryUpdate(ws, session.invocationId, {
                  toolCallCount: session.toolCallCount,
                });
              }
            }
          }

          // Capture the model for the child row on its first assistant message.
          // The model field is only meaningful on child rows when they first
          // arrive; thereafter it stays fixed.
          if (childInvId !== undefined) {
            const msgModel = assistantMsg.message?.model;
            if (typeof msgModel === "string" && msgModel.length > 0) {
              const childRow = this.persistence.invocations.get(childInvId);
              if (childRow !== undefined && childRow.model === "") {
                this.persistence.invocations.update(childInvId, { model: msgModel });
                this.sendHistoryUpdate(ws, childInvId, { model: msgModel });
              }
            }
          }
        }

        // End-of-turn marker. The SDK emits exactly one `result` per turn
        // (subtype 'success' on normal completion, 'error_*' on failure).
        // The client treats chat.done as "turn finished; textarea re-enables;
        // ready for next user input". We KEEP the session alive (don't break)
        // so the next chat.input can drive another turn through the same
        // subprocess — that's the SDK's multi-turn semantics.
        if ((msg as { type?: string }).type === "result") {
          // Accumulate cost + token counts from the result message onto the invocation row.
          const resultMsg = msg as {
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          const patch: Partial<InvocationRow> = {};
          if (typeof resultMsg.total_cost_usd === "number") {
            session.costUsd += resultMsg.total_cost_usd;
            patch.costUsd = session.costUsd;
          }
          if (typeof resultMsg.usage?.input_tokens === "number") {
            session.inputTokens += resultMsg.usage.input_tokens;
            patch.inputTokens = session.inputTokens;
          }
          if (typeof resultMsg.usage?.output_tokens === "number") {
            session.outputTokens += resultMsg.usage.output_tokens;
            patch.outputTokens = session.outputTokens;
          }
          if (Object.keys(patch).length > 0) {
            this.persistence.invocations.update(session.invocationId, patch);
            this.sendHistoryUpdate(ws, session.invocationId, patch);
            // Drive the live top-bar usage counter (ChatTab listens for chat.usage).
            const usageState = this.registry.get(session.chatSessionId);
            const usageSeq = usageState !== undefined ? usageState.buffer.serverSeq + 1 : 0;
            ws.send(JSON.stringify({
              type: "chat.usage",
              seq: usageSeq,
              ts: Date.now(),
              sessionId: session.chatSessionId,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
              costUsd: session.costUsd,
            }));
          }

          const sub = (msg as { subtype?: string }).subtype ?? "";
          const turnDone: ChatDone["reason"] = sub.startsWith("error")
            ? "errored"
            : "completed";

          // PR-01: trigger Haiku title generation once per session after the
          // first successful `result`. Idempotent: gated by titleRequested
          // (in-memory) and the persisted session.title === "" check.
          // Subagent rows are never affected because `result` is emitted only
          // at the top-level turn boundary.
          if (sub === "success" && !session.titleRequested) {
            session.titleRequested = true;
            const sessionRow = this.persistence.sessions.get(session.chatSessionId);
            const alreadyTitled =
              sessionRow !== undefined && sessionRow.title.trim().length > 0;
            const haveUserText = session.firstUserText.trim().length > 0;
            const assistantText = (msg as { result?: string }).result ?? "";
            const haveAssistantText = assistantText.trim().length > 0;
            if (!alreadyTitled && haveUserText && haveAssistantText) {
              const sessionIdForLog = session.chatSessionId;
              const firstUserText = session.firstUserText;
              this.titleGenerator
                .generate({ firstUserMessage: firstUserText, firstAssistantText: assistantText })
                .then((title) => {
                  const trimmed = title.trim();
                  if (trimmed.length === 0) return;
                  // Re-check before write to avoid clobbering a concurrent
                  // update (e.g. parallel session reuse race).
                  const fresh = this.persistence.sessions.get(sessionIdForLog);
                  if (fresh === undefined) return;
                  if (fresh.title.trim().length > 0) return;
                  this.persistence.sessions.update(sessionIdForLog, { title: trimmed });
                  this.logger.info("bridge.title_generated", {
                    chatSessionId: sessionIdForLog,
                    title: trimmed,
                  });
                })
                .catch((err: unknown) => {
                  this.logger.warn("bridge.title_generate_failed", {
                    chatSessionId: sessionIdForLog,
                    err: String(err),
                  });
                });
            }
          }

          this.sendDone(session.ws, session, turnDone);
          turnDoneSent = true;

          // D28b: when the SDK closes the turn with an error subtype, surface
          // a chat.error frame so the UI toast fires. Without this, the session
          // row silently flips to 'failed' with no visible message to the user.
          // SDKResultError carries an `errors` string[] for the error detail.
          if (sub.startsWith("error")) {
            const errMsg = (msg as { errors?: string[] }).errors?.[0] ?? sub;
            this.sendError(session.ws, session.chatSessionId, sub, errMsg);
          }

          continue;
        }
      }

      // Iteration ended (subprocess closed stdin / queue ended): choose reason
      // based on whether an interrupt was requested. Note: on a healthy
      // multi-turn flow we never reach here because turn-level chat.done is
      // sent above; this only fires on shutdown() / interruptActive() that
      // close the query.
      ws = session.ws;
      doneReason = session.aborting ? "interrupted" : "completed";
      // Only emit if the current turn didn't already complete (avoids double chat.done
      // when the for-await ends immediately after a result message sent turnDoneSent=true).
      if (!turnDoneSent) {
        this.sendDone(ws, session, doneReason);
        turnDoneSent = true;
      }
    } catch (err: unknown) {
      ws = session.ws;
      // If the SDK throws after an interrupt, still report interrupted, not errored.
      if (session.aborting) {
        doneReason = "interrupted";
        // Suppress the duplicate chat.done when the last turn already completed.
        if (!turnDoneSent) {
          this.sendDone(ws, session, doneReason);
          turnDoneSent = true;
        }
      } else {
        this.logger.error("bridge.sdk_error", {
          chatSessionId: session.chatSessionId,
          err: String(err),
        });
        doneReason = "errored";
        // D31: persist the failure into the event log so History Detail shows
        // the error reason when replaying a failed invocation.
        const errMessage = err instanceof Error ? err.message : String(err);
        this.persistence.events.append(session.invocationId, {
          type: "system",
          subtype: "error",
          error: errMessage,
          timestamp: Date.now(),
        } as unknown as SDKMessage);
        if (!turnDoneSent) {
          this.sendDone(ws, session, doneReason);
          turnDoneSent = true;
        }
        this.sendError(ws, session.chatSessionId, "SDK_ERROR", errMessage);
      }
    } finally {
      // Finalise the top-level invocation and session in persistence.
      // Note: if the server is killed (SIGKILL) while a session is mid-flight,
      // this finally block never runs and the row stays 'running'. On the next
      // start, D29's PID-file lock ensures only the newly-started process runs
      // the reaper, which marks that row 'failed'. This is the intended behaviour
      // for genuine orphans — the D29 lock makes it safe.
      const endedAt = Date.now();
      const durationMs = endedAt - session.startedAt;
      const invStatus: InvocationRow["status"] = doneReason === "completed"
        ? "completed"
        : doneReason === "interrupted"
          ? "stopped"
          : "failed";
      this.persistence.events.close(session.invocationId);
      this.persistence.invocations.update(session.invocationId, {
        endedAt,
        durationMs,
        status: invStatus,
      });
      this.persistence.sessions.update(session.chatSessionId, {
        endedAt,
        endedReason: doneReason,
      });
      this.sendHistoryUpdate(ws, session.invocationId, {
        endedAt,
        durationMs,
        status: invStatus,
      });

      if (this.active === session) {
        this.setActive(null);
        session.queue.end();
        // Reject any pending permission requests — the session is over.
        this.permissionBroker.rejectAll();
        this.permissionBroker.clearSendFrame();
        // Cancel any pending elicitation requests — the session is over.
        this.elicitationBroker.rejectAll();
        this.elicitationBroker.clearSendFrame();
        // Cancel any pending AskUserQuestion broker promises — the session is over.
        this.askBroker.rejectAll();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Task sub-invocation helpers
  // ---------------------------------------------------------------------------

  private handleTaskStarted(
    session: ActiveSession,
    ws: WsSocket,
    msg: SDKTaskStartedMessage,
  ): string {
    const childInvocationId = crypto.randomUUID();
    session.taskInvocationMap.set(msg.task_id, childInvocationId);
    // Build the tool_use_id → child invocation id index so we can route
    // assistant messages with parent_tool_use_id to the correct child row.
    if (msg.tool_use_id !== undefined) {
      session.toolUseInvocationMap.set(msg.tool_use_id, childInvocationId);
    }

    const childRow: InvocationRow = {
      id: childInvocationId,
      sessionId: session.chatSessionId,
      parentInvocationId: session.invocationId,
      resumedFromInvocationId: null,
      agentName: msg.subagent_type ?? msg.task_type ?? "subagent",
      agentId: null,
      taskId: msg.task_id,
      toolUseId: msg.tool_use_id ?? null,
      model: "",
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: "running",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: (msg.prompt ?? msg.description).slice(0, 500),
      eventLogPath: `${session.chatSessionId}/${childInvocationId}.jsonl`,
      ownerPid: process.pid,
    };
    this.persistence.invocations.insert(childRow);
    this.sendHistoryUpdate(ws, childInvocationId, {
      status: "running",
      parentInvocationId: session.invocationId,
      agentName: childRow.agentName,
    });
    this.logger.info("bridge.task_started", {
      chatSessionId: session.chatSessionId,
      taskId: msg.task_id,
      childInvocationId,
    });
    return childInvocationId;
  }

  private handleTaskNotification(
    session: ActiveSession,
    ws: WsSocket,
    msg: SDKTaskNotificationMessage,
  ): void {
    const childInvocationId = session.taskInvocationMap.get(msg.task_id);
    if (!childInvocationId) return;

    const endedAt = Date.now();
    const childRow = this.persistence.invocations.get(childInvocationId);
    const durationMs = childRow ? endedAt - childRow.startedAt : null;
    const status: InvocationRow["status"] = msg.status === "completed"
      ? "completed"
      : msg.status === "failed"
        ? "failed"
        : "stopped";

    // D45: task_notification carries usage.{total_tokens, tool_uses, duration_ms}
    // for the subagent. We can populate the child row's token count from
    // total_tokens (no input/output split available — store in inputTokens as a
    // single aggregate; cost remains 0 because the SDK does not report
    // per-subagent cost).
    const patch: Partial<InvocationRow> = {
      endedAt,
      durationMs: durationMs ?? null,
      status,
    };
    const usage = (msg as { usage?: { total_tokens?: number; tool_uses?: number } }).usage;
    if (usage !== undefined && typeof usage.total_tokens === "number") {
      patch.inputTokens = usage.total_tokens;
    }
    if (usage !== undefined && typeof usage.tool_uses === "number" && usage.tool_uses > 0) {
      // Authoritative count from the SDK; overrides the per-message accumulator.
      patch.toolCallCount = usage.tool_uses;
    }
    this.persistence.invocations.update(childInvocationId, patch);
    this.sendHistoryUpdate(ws, childInvocationId, { endedAt, durationMs, status, ...patch });
    this.logger.info("bridge.task_notification", {
      chatSessionId: session.chatSessionId,
      taskId: msg.task_id,
      childInvocationId,
      status,
    });
  }

  // ---------------------------------------------------------------------------
  // Frame senders
  // ---------------------------------------------------------------------------

  /**
   * Emit chat.started immediately after handleChatStart, before the SDK
   * subprocess has produced its system/init message. Carries the session and
   * invocation IDs so the client can send chat.input; carries cwd from the
   * server config (the only initInfo field knowable up-front). Other init
   * fields (slash_commands, mcp_servers, model) arrive in the second
   * chat.started fired by sendStarted() once the SDK emits init.
   */
  private sendStartedEarly(ws: WsSocket, session: ActiveSession): void {
    const sessionState = this.registry.get(session.chatSessionId);
    const seq = sessionState !== undefined ? sessionState.buffer.serverSeq + 1 : 0;
    const frame: ChatStarted = {
      type: "chat.started",
      seq,
      ts: Date.now(),
      sessionId: session.chatSessionId,
      invocationId: session.invocationId,
      initInfo: { cwd: this.cwd },
    };
    ws.send(JSON.stringify(frame));
    this.logger.info("bridge.chat_started_early", {
      chatSessionId: session.chatSessionId,
    });
  }

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
    // ACTIVITY-01: the turn finished — the model is no longer working. Clear the
    // per-turn flag on this session and, if it is the live active session, notify
    // the aggregate tracker so the badge drops back toward IDLE.
    if (session.turnInFlight) {
      session.turnInFlight = false;
      if (this.active === session) this.notifyBusyChange();
    }
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

  private sendHistoryUpdate(
    ws: WsSocket,
    invocationId: string,
    patch: Record<string, unknown>,
  ): void {
    const frame: HistoryUpdate = {
      type: "history.update",
      seq: 0,
      ts: Date.now(),
      invocationId,
      patch,
    };
    ws.send(JSON.stringify(frame));
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

function isTaskStartedMessage(msg: SDKMessage): msg is SDKTaskStartedMessage {
  return msg.type === "system" && (msg as SDKTaskStartedMessage).subtype === "task_started";
}

function isTaskNotificationMessage(msg: SDKMessage): msg is SDKTaskNotificationMessage {
  return msg.type === "system" && (msg as SDKTaskNotificationMessage).subtype === "task_notification";
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

/**
 * Resolve the native Claude Code CLI binary path for the current platform.
 *
 * When running under Bun, the SDK's default binary lookup uses `createRequire`
 * from the sdk.mjs location to resolve the optional peer package, then spawns
 * it via `child_process.spawn`. In the Bun test runner, Bun's `child_process`
 * emulation can fail to launch the resolved binary (spawn returns an ENOENT-type
 * error even though the file exists). Passing `pathToClaudeCodeExecutable`
 * explicitly to the SDK bypasses the problematic spawn path.
 *
 * This helper resolves the platform-specific package path relative to this
 * file so the Bridge always passes an explicit, absolute path under Bun.
 * Under Node.js (non-Bun runtimes), the SDK's built-in lookup works fine and
 * `undefined` is returned to let the SDK do its own resolution.
 */
function resolveNativeBinaryPath(): string | undefined {
  // Only apply the workaround when running under Bun.
  if (typeof (process.versions as Record<string, unknown>)["bun"] === "undefined") {
    return undefined;
  }
  try {
    const req = createRequire(import.meta.url);
    const platform = process.platform;
    const arch = process.arch;
    // Attempt both plain and -musl variants (musl check mirrors SDK's bx()).
    const pkgCandidates = [
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`,
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}-musl/claude`,
    ];
    for (const pkg of pkgCandidates) {
      try {
        const resolved = req.resolve(pkg);
        if (resolved) return resolved;
      } catch {
        // Not found — try next candidate.
      }
    }
  } catch {
    // Fallback: let the SDK do its own lookup.
  }
  return undefined;
}
