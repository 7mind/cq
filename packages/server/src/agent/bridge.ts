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
import type { BackendBridge, WsSocket } from "./backendBridge";
import type { QueryFactory, BridgeOpts as ClaudeBridgeOpts } from "./claudeBridge";

// Re-export public types so downstream imports of `bridge.ts` keep working.
export type { WsSocket } from "./backendBridge";
export type { QueryFactory } from "./claudeBridge";
export { ClaudeBridge } from "./claudeBridge";
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
}

export class Bridge implements BackendBridge {
  private readonly opts: BridgeOpts;
  private readonly persistence: Persistence;
  /** The Claude backend is constructed eagerly so the broker getters always have a target. */
  private readonly claude: ClaudeBridge;
  /** Codex backend, lazily constructed on the first Codex ChatStart (codex-5). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private codex: BackendBridge | null = null;
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
    };
    this.claude = new ClaudeBridge(claudeOpts);
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

  activeSessionId(): string | null {
    return this.active?.activeSessionId() ?? null;
  }

  /**
   * Resolve which backend should handle a ChatStart. For codex-4 only
   * Claude is wired; the Codex case still returns the Claude backend so
   * ClaudeBridge's platform-mismatch guard (codex-3) emits a refusal
   * frame instead of constructing a stub Codex backend.
   */
  private resolveBackend(frame: ChatStart): BackendBridge {
    const requested: "claude" | "codex" = frame.platform ?? "claude";
    if (requested === "codex") {
      // codex-5 will construct a CodexBridge here. Until then, route to
      // ClaudeBridge so its codex-3 guard emits the platform-mismatch
      // refusal cleanly (rather than silently downgrading to Claude).
      return this.claude;
    }
    return this.claude;
  }

  async handleChatStart(ws: WsSocket, frame: ChatStart): Promise<void> {
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
    // If the start was refused (e.g. platform-mismatch), the backend's
    // activeSessionId is null and we can release `active` so isBusy()
    // reports the truth.
    if (next.activeSessionId() === null) {
      this.active = null;
    }
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
