/**
 * backendBridge.ts — interface implemented by the per-platform bridges.
 *
 * The cq facade (`Bridge` in `bridge.ts`) holds the pool=1 invariant and
 * routes each ChatStart to either ClaudeBridge or CodexBridge based on
 * `ChatStart.platform`. Both backends must expose the same lifecycle
 * methods so the facade can delegate uniformly.
 *
 * Lifecycle (same shape as the original Bridge class):
 *   handleChatStart           — start a session for one ChatStart frame
 *   handleChatRejoin          — rebind an existing/persisted session to a new WS
 *   handleChatInput           — push a user message into the running session
 *   handleChatInterrupt       — request the SDK to abort the current turn
 *   handleChatPermissionReply — forward the client's allow/deny decision
 *   handleChatElicitationReply — forward MCP elicitation reply
 *   handleChatQuestionReply   — forward AskUserQuestion answer
 *   handleChatReadFileRequest — answer the file-context expand request
 *   interruptActive           — synchronous fire-and-forget interrupt for shutdown
 *   shutdown                  — drain the active session
 *   isBusy                    — true iff a session is currently active
 *   activeSessionId           — the active session id, or null
 *
 * Errors emitted via the bound WsSocket; no backends throw at the
 * facade boundary unless the brief is malformed (programmer error).
 */

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

/**
 * Minimal WsSocket shape the bridge needs — structurally compatible with
 * Bun's ServerWebSocket and with MockWsSocket in tests.
 *
 * Re-exported here so the interface is self-contained; the canonical
 * source remains `bridge.ts`.
 */
export type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export interface BackendBridge {
  isBusy(): boolean;
  activeSessionId(): string | null;
  handleChatStart(ws: WsSocket, frame: ChatStart): Promise<void>;
  handleChatRejoin(ws: WsSocket, frame: ChatRejoin): Promise<void>;
  handleChatInput(ws: WsSocket, frame: ChatInput): Promise<void>;
  handleChatInterrupt(ws: WsSocket, frame: ChatInterrupt): Promise<void>;
  handleChatPermissionReply(ws: WsSocket, frame: ChatPermissionReply): void;
  handleChatElicitationReply(ws: WsSocket, frame: ChatElicitationReply): void;
  handleChatQuestionReply(ws: WsSocket, frame: ChatQuestionReply): void;
  handleChatReadFileRequest(ws: WsSocket, frame: ChatReadFileRequest): Promise<void>;
  interruptActive(): void;
  shutdown(): Promise<void>;
}
