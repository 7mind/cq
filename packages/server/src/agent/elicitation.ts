/**
 * elicitation.ts — ElicitationBroker: bridges SDK onElicitation callbacks to WS roundtrips.
 *
 * Flow:
 *  1. Bridge calls `broker.request(...)` from the SDK `onElicitation` callback.
 *  2. Broker generates an elicitationId, emits `chat.elicitation_request` over WS, parks a Promise.
 *  3. When the client replies with `chat.elicitation_reply`, the session routes it to
 *     `broker.reply(elicitationId, action, content?)`.
 *  4. For URL-mode elicitations: the bridge watches for `SDKElicitationCompleteMessage` events
 *     from the SDK stream and calls `broker.completeUrl(elicitationId)` which resolves with
 *     `{action:'accept'}`.
 *  5. Broker resolves the parked Promise with an ElicitationResult-compatible value.
 */

import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { ChatElicitationRequest } from "@cq/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElicitationAction = "accept" | "decline" | "cancel";

/** Callback type: sends a raw JSON frame over the active WS connection. */
export type SendElicitationFrame = (frame: ChatElicitationRequest) => void;

// ---------------------------------------------------------------------------
// ElicitationBroker
// ---------------------------------------------------------------------------

/**
 * Holds in-flight elicitation requests keyed by `elicitationId`.
 * One broker instance is created per Bridge and reused across sessions.
 */
export class ElicitationBroker {
  private readonly pending = new Map<string, (result: ElicitationResult) => void>();
  private sendFrame: SendElicitationFrame | null = null;

  /**
   * Attach the WS send callback for the current active session.
   * Called by Bridge when a new session starts.
   */
  setSendFrame(fn: SendElicitationFrame): void {
    this.sendFrame = fn;
  }

  /**
   * Detach the send callback (e.g. when a session ends).
   */
  clearSendFrame(): void {
    this.sendFrame = null;
  }

  /**
   * Called from the SDK `onElicitation` callback.
   * Emits `chat.elicitation_request` and returns a Promise that resolves
   * when the client sends `chat.elicitation_reply` or when `completeUrl` is called.
   */
  request(
    sessionId: string,
    req: ElicitationRequest,
  ): Promise<ElicitationResult> {
    // Use the SDK-provided elicitationId for URL mode (so we can correlate
    // SDKElicitationCompleteMessage), or generate a new UUID for form mode.
    const elicitationId: string =
      typeof req.elicitationId === "string" && req.elicitationId.length > 0
        ? req.elicitationId
        : crypto.randomUUID();

    const frame: ChatElicitationRequest = {
      type: "chat.elicitation_request",
      seq: 0,
      ts: Date.now(),
      sessionId,
      elicitationId,
      mcpServerName: req.serverName,
      message: req.message,
      ...(req.mode !== undefined ? { mode: req.mode } : {}),
      ...(req.url !== undefined ? { url: req.url } : {}),
      ...(req.requestedSchema !== undefined ? { requestedSchema: req.requestedSchema } : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
    };

    const promise = new Promise<ElicitationResult>((resolve) => {
      this.pending.set(elicitationId, resolve);
    });

    if (this.sendFrame !== null) {
      this.sendFrame(frame);
    }

    return promise;
  }

  /**
   * Called when `chat.elicitation_reply` arrives from the client.
   * Resolves the parked Promise with the appropriate ElicitationResult.
   */
  reply(
    elicitationId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
  ): void {
    const resolve = this.pending.get(elicitationId);
    if (resolve === undefined) return; // stale or duplicate — ignore

    this.pending.delete(elicitationId);

    // ElicitationResult.content is typed narrowly by the MCP SDK as
    // Record<string, string | number | boolean | string[]>. We receive
    // Record<string, unknown> from the WS frame and cast here — the SDK
    // will validate/coerce the actual values when it processes the result.
    type ElicitContent = Record<string, string | number | boolean | string[]>;
    const result: ElicitationResult =
      action === "accept" && content !== undefined
        ? { action: "accept", content: content as ElicitContent }
        : action === "accept"
          ? { action: "accept" }
          : action === "decline"
            ? { action: "decline" }
            : { action: "cancel" };

    resolve(result);
  }

  /**
   * Called by the bridge when `SDKElicitationCompleteMessage` arrives for a URL-mode
   * elicitation. Resolves the pending request with `{action:'accept'}`.
   */
  completeUrl(elicitationId: string): void {
    const resolve = this.pending.get(elicitationId);
    if (resolve === undefined) return;

    this.pending.delete(elicitationId);
    resolve({ action: "accept" });
  }

  /** Reject all pending requests (e.g. on session end or bridge shutdown). */
  rejectAll(): void {
    for (const resolve of this.pending.values()) {
      resolve({ action: "cancel" });
    }
    this.pending.clear();
  }

  /** Number of pending (unresolved) requests — exposed for tests. */
  pendingCount(): number {
    return this.pending.size;
  }
}
