/**
 * bridge.ts — Bridge facade routing by ChatStart.platform.
 *
 * Holds the pool=1 invariant across both Claude and Codex backends.
 * The first ChatStart in a server lifetime constructs the appropriate
 * BackendBridge instance; subsequent ChatStart frames either keep the
 * same backend (delegated through), or switch backends — in which case
 * the prior backend is shut down before the new one starts.
 *
 * Public surface is identical to the pre-codex-4 Bridge class so
 * existing consumers (server.ts, devServer.ts, shutdown.ts, ws/session.ts,
 * and all bridge.test.ts / bridge-persist.test.ts / etc. fixtures)
 * compile and run unchanged.
 *
 * The classic broker properties (permissionBroker, elicitationBroker,
 * askBroker) are surfaced as getters that proxy to the active backend
 * — they are only meaningful for ClaudeBridge (CodexBridge does not
 * use them in v1, see defects.md D-GC-1).
 *
 * Routing rules:
 *   - ChatStart.platform === 'claude' (or absent) → ClaudeBridge
 *   - ChatStart.platform === 'codex'              → CodexBridge (codex-5)
 *
 * For non-start frames (input/interrupt/permission/etc.) the facade
 * routes to whichever backend currently owns `active`.
 */

import type { Logger } from "../log/logger";
import type { SessionRegistry } from "../seq/sessionRegistry";
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
} from "@cq/shared";
import { PermissionBroker } from "./permission";
import { ElicitationBroker } from "./elicitation";
import { AskBroker } from "./askUserQuestion";
import type { TitleGenerator } from "./titleGenerator";
import type { LedgerStore } from "@cq/ledger";
import { ClaudeBridge } from "./claudeBridge";
import { CodexBridge } from "./codexBridge";
import type { CodexFactory } from "./codexBridge";
import type { BackendBridge, WsSocket } from "./backendBridge";
import type { QueryFactory, BridgeOpts as ClaudeBridgeOpts } from "./claudeBridge";

// Re-export public types so downstream imports of `bridge.ts` keep working.
export type { WsSocket } from "./backendBridge";
export type { QueryFactory } from "./claudeBridge";
export type { CodexFactory } from "./codexBridge";
export { ClaudeBridge } from "./claudeBridge";
export { CodexBridge } from "./codexBridge";
export type { BackendBridge } from "./backendBridge";

/**
 * Facade-level options. Superset of the existing BridgeOpts: tests that
 * passed `{logger, registry, queryFactory, cwd, ...}` continue to work
 * verbatim; the facade forwards those to ClaudeBridge.
 */
export interface BridgeOpts {
  logger: Logger;
  registry: SessionRegistry;
  /** Override the Claude SDK `query()` for tests. */
  queryFactory?: QueryFactory;
  /** Forwarded to both backends as their cwd. */
  cwd: string;
  /** HOME override for MCP server discovery (Claude only). */
  home?: string;
  /** Pre-constructed PermissionBroker; ClaudeBridge only. */
  permissionBroker?: PermissionBroker;
  /** Pre-constructed ElicitationBroker; ClaudeBridge only. */
  elicitationBroker?: ElicitationBroker;
  /** Pre-constructed AskBroker; ClaudeBridge only. */
  askBroker?: AskBroker;
  /** Persistence adapter shared by both backends. */
  persistence?: Persistence;
  /** Title generator; both backends share the same Haiku-backed generator. */
  titleGenerator?: TitleGenerator;
  /** Ledger store; ClaudeBridge passes it to the MCP wiring. */
  ledgerStore?: LedgerStore;
  /** Override Codex SDK construction for tests. */
  codexFactory?: CodexFactory;
  /** Override Codex auth detection for tests. */
  detectCodexAuth?: () => boolean;
  /**
   * Internal WS URL forwarded to spawned cq-mcp via env (D-COHERENCE).
   * Threaded through CodexBridge so each new Codex session's MCP child
   * connects back to the cq server for cache invalidation.
   */
  internalWsUrl?: string;
  /** Token paired with `internalWsUrl`. */
  internalWsToken?: string;
  /**
   * Send an `ask.reply` upstream to cq-mcp (askproxy / outer-14). Wired to
   * `InternalWsService.broadcast` by server.ts / devServer.ts and forwarded
   * to the Codex backend. Undefined in tests that do not exercise the proxy.
   */
  sendAskReply?: (msg: import("@cq/shared").InternalWsMessage) => void;
  /**
   * Fired on EVERY transition of the chat-lane busy state across both backends
   * (a turn starting or ending), AFTER the backend's `active` slot is updated
   * (ACTIVITY-01). The facade forwards this single callback to both ClaudeBridge
   * and CodexBridge, so the aggregate activity tracker is notified whichever
   * backend owns the active session. Observe-only: never changes pool=1.
   */
  onBusyChange?: () => void;
}

export class Bridge implements BackendBridge {
  private opts: BridgeOpts;
  private readonly persistence: Persistence;
  /** The Claude backend is constructed eagerly so the broker getters always have a target. */
  private readonly claude: ClaudeBridge;
  /** Codex backend, lazily constructed on the first Codex ChatStart. */
  private codex: CodexBridge | null = null;
  /** The backend that owns the currently-active session, or null. */
  private active: BackendBridge | null = null;

  constructor(opts: BridgeOpts) {
    this.opts = opts;
    this.persistence = opts.persistence ?? new InMemoryPersistence();
    // Construct ClaudeBridge eagerly with a shared persistence so both backends
    // see the same session table.
    const claudeOpts: ClaudeBridgeOpts = {
      logger: opts.logger,
      registry: opts.registry,
      cwd: opts.cwd,
      persistence: this.persistence,
      ...(opts.queryFactory !== undefined ? { queryFactory: opts.queryFactory } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.permissionBroker !== undefined ? { permissionBroker: opts.permissionBroker } : {}),
      ...(opts.elicitationBroker !== undefined ? { elicitationBroker: opts.elicitationBroker } : {}),
      ...(opts.askBroker !== undefined ? { askBroker: opts.askBroker } : {}),
      ...(opts.titleGenerator !== undefined ? { titleGenerator: opts.titleGenerator } : {}),
      ...(opts.ledgerStore !== undefined ? { ledgerStore: opts.ledgerStore } : {}),
      ...(opts.onBusyChange !== undefined ? { onBusyChange: opts.onBusyChange } : {}),
    };
    this.claude = new ClaudeBridge(claudeOpts);
  }

  /**
   * Set the internal WS URL (D-COHERENCE). Must be called before the
   * first Codex session starts; `server.ts` invokes it immediately
   * after `Bun.serve(...)` returns the bound port. No-op if `CodexBridge`
   * has already been constructed (rare; would only happen if a Codex
   * frame raced server startup, which the caller serialises).
   */
  setInternalWsUrl(url: string): void {
    this.opts = { ...this.opts, internalWsUrl: url };
  }

  // -- Broker accessors (proxy to ClaudeBridge) -------------------------------
  // Codex sessions do not use these brokers in v1 (see defects.md D-GC-1).
  // Tests and consumers that read these properties want the Claude brokers,
  // which is what they get for any Claude-or-default invocation.
  get permissionBroker(): PermissionBroker { return this.claude.permissionBroker; }
  get elicitationBroker(): ElicitationBroker { return this.claude.elicitationBroker; }
  get askBroker(): AskBroker { return this.claude.askBroker; }

  // -- Lifecycle --------------------------------------------------------------

  isBusy(): boolean {
    return this.active !== null && this.active.isBusy();
  }

  /** ACTIVITY-01: true iff the active backend has a turn currently streaming. */
  isTurnInFlight(): boolean {
    return this.active !== null && this.active.isTurnInFlight();
  }

  activeSessionId(): string | null {
    return this.active?.activeSessionId() ?? null;
  }

  /**
   * Resolve which backend should handle a ChatStart. Codex backend is
   * lazily constructed on first need so tests that never touch Codex
   * do not pay the import-time cost.
   */
  private resolveBackend(frame: ChatStart): BackendBridge {
    const requested: "claude" | "codex" = frame.platform ?? "claude";
    if (requested === "codex") {
      if (this.codex === null) {
        this.codex = new CodexBridge({
          logger: this.opts.logger,
          registry: this.opts.registry,
          cwd: this.opts.cwd,
          persistence: this.persistence,
          ...(this.opts.codexFactory !== undefined ? { codexFactory: this.opts.codexFactory } : {}),
          ...(this.opts.detectCodexAuth !== undefined ? { detectAuth: this.opts.detectCodexAuth } : {}),
          ...(this.opts.internalWsUrl !== undefined ? { internalWsUrl: this.opts.internalWsUrl } : {}),
          ...(this.opts.internalWsToken !== undefined ? { internalWsToken: this.opts.internalWsToken } : {}),
          ...(this.opts.sendAskReply !== undefined ? { sendAskReply: this.opts.sendAskReply } : {}),
          ...(this.opts.onBusyChange !== undefined ? { onBusyChange: this.opts.onBusyChange } : {}),
        });
      }
      return this.codex;
    }
    return this.claude;
  }

  async handleChatStart(ws: WsSocket, frame: ChatStart): Promise<void> {
    // codex-3 + codex-4: the platform-mismatch refusal is the facade's
    // responsibility, not a backend's. Performing it here guarantees the
    // refusal short-circuits BEFORE either backend's own auth/initialisation
    // path runs — a Codex resume against a Claude row must not trip
    // Codex's auth check, and a Claude resume against a Codex row must
    // not pollute Claude's persistence.
    const requestedPlatform: "claude" | "codex" = frame.platform ?? "claude";

    // gcn1-2: approvalPolicy is a Codex-only knob. A Claude request that
    // sets it is a client bug; reject loudly with a specific code so the
    // UI can flag the misconfiguration instead of silently dropping the
    // value. This check runs before the platform-mismatch resume check
    // because it does not depend on prior session lookup.
    if (frame.approvalPolicy !== undefined && requestedPlatform === "claude") {
      this.sendError(
        ws,
        null,
        "approval-policy-on-claude",
        "approvalPolicy is a Codex-only setting; switch the model dropdown to a Codex model or clear the approval-policy picker.",
      );
      return;
    }

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

    const next = this.resolveBackend(frame);
    // Pool=1 across backends: if a different backend is currently active,
    // shut it down before starting on the new one. (Same-backend preempt
    // is handled inside the backend itself.)
    if (this.active !== null && this.active !== next && this.active.isBusy()) {
      this.opts.logger.info("bridge.cross_backend_preempt", {
        from: this.active === this.claude ? "claude" : "codex",
        to: next === this.claude ? "claude" : "codex",
      });
      this.active.interruptActive();
      await this.active.shutdown();
    }
    this.active = next;
    await next.handleChatStart(ws, frame);
    // If the start was refused (e.g. codex-not-authenticated), the backend's
    // activeSessionId is null and we release `active` so isBusy() reports
    // the truth.
    if (next.activeSessionId() === null) {
      this.active = null;
    }
  }

  /** Facade-level error sender (used for refusals before any backend runs). */
  private sendError(ws: WsSocket, sessionId: string | null, code: string, message: string): void {
    ws.send(JSON.stringify({
      type: "chat.error",
      seq: 0,
      ts: Date.now(),
      ...(sessionId !== null ? { sessionId } : {}),
      code,
      message,
    }));
    this.opts.logger.warn("bridge.chat_error", { sessionId, code, message });
  }

  async handleChatRejoin(ws: WsSocket, frame: ChatRejoin): Promise<void> {
    // Rejoin always targets the currently-active session if any, else the
    // claude backend (existing behaviour — pre-platform routing).
    const target = this.active ?? this.claude;
    this.active = target;
    await target.handleChatRejoin(ws, frame);
    if (target.activeSessionId() === null) this.active = null;
  }

  async handleChatInput(ws: WsSocket, frame: ChatInput): Promise<void> {
    const target = this.active ?? this.claude;
    await target.handleChatInput(ws, frame);
  }

  async handleChatInterrupt(ws: WsSocket, frame: ChatInterrupt): Promise<void> {
    const target = this.active ?? this.claude;
    await target.handleChatInterrupt(ws, frame);
  }

  handleChatPermissionReply(ws: WsSocket, frame: ChatPermissionReply): void {
    const target = this.active ?? this.claude;
    target.handleChatPermissionReply(ws, frame);
  }

  handleChatElicitationReply(ws: WsSocket, frame: ChatElicitationReply): void {
    const target = this.active ?? this.claude;
    target.handleChatElicitationReply(ws, frame);
  }

  handleChatQuestionReply(ws: WsSocket, frame: ChatQuestionReply): void {
    const target = this.active ?? this.claude;
    target.handleChatQuestionReply(ws, frame);
  }

  /**
   * Route an inbound internal-WS `ask.request` (from a spawned cq-mcp) to
   * the Codex backend's WS-back-proxy (askproxy / outer-14). Only a Codex
   * session spawns cq-mcp with the ask tool, so this always targets the
   * Codex backend; if it has not been constructed yet the request cannot
   * correspond to any live session and is dropped with a warning.
   */
  handleAskRequest(req: {
    askId: string;
    toolUseId: string;
    sessionId: string;
    questions: unknown[];
  }): void {
    if (this.codex === null) {
      this.opts.logger.warn("bridge.ask_request_no_codex", {
        askId: req.askId,
        sessionId: req.sessionId,
      });
      return;
    }
    this.codex.handleAskRequest(req);
  }

  async handleChatReadFileRequest(ws: WsSocket, frame: ChatReadFileRequest): Promise<void> {
    const target = this.active ?? this.claude;
    await target.handleChatReadFileRequest(ws, frame);
  }

  interruptActive(): void {
    if (this.active !== null) this.active.interruptActive();
  }

  async shutdown(): Promise<void> {
    // Shut down whichever backend is active. Tests typically call shutdown
    // exactly once at end-of-test; Claude is the only constructed backend
    // in this PR.
    if (this.active !== null) {
      await this.active.shutdown();
      this.active = null;
    } else {
      // No active session — still call into Claude's shutdown so any pending
      // state (pre-empt during start) drains cleanly.
      await this.claude.shutdown();
    }
    if (this.codex !== null) {
      await this.codex.shutdown();
    }
  }
}
