/**
 * CqMcpAskBroker — cq-mcp side of the Codex `ask_user_question`
 * WS-back-proxy (askproxy / outer-14).
 *
 * Mirrors the server-side `AskBroker` two-slot race machine
 * (`packages/server/src/agent/askUserQuestion.ts`) but keyed by `askId`
 * rather than a single implicit slot, because the broker lives in a
 * short-lived process where, in principle, more than one `askId` could
 * be in flight (the cq facade enforces at most one active ask per turn,
 * but keying by `askId` is correct regardless and matches the wire id).
 *
 * Timing. The inbound `ask.reply` (server → cq-mcp) could be processed
 * before the tool handler parks its Promise via `ask(askId)` — the same
 * timing class the Claude broker guards against. Each `askId` therefore
 * has a buffered-reply slot: if `reply()` arrives first, it is stored and
 * the matching `ask()` resolves immediately.
 *
 * Disconnect. `rejectAll()` rejects every pending ask and clears every
 * buffered reply; the cq-mcp `main` wires it to the channel's `onClose`
 * so the `ask_user_question` tool handler returns an error result instead
 * of hanging after the WS drops.
 */

/** Answers normalised to the same comma-joined-string shape the Claude broker emits. */
export type CqMcpAskOutput = {
  questions: unknown[];
  answers: Record<string, string>;
};

type PendingEntry = {
  resolve: (output: CqMcpAskOutput) => void;
  reject: (err: Error) => void;
  questions: unknown[];
};

export class CqMcpAskBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly bufferedReplies = new Map<string, Record<string, unknown>>();
  private rejected = false;

  /**
   * Park a Promise for `askId` until the matching `ask.reply` arrives.
   * If a reply is already buffered (reply-before-ask race), resolves
   * immediately. Throws synchronously if the broker has been torn down.
   */
  ask(askId: string, questions: unknown[]): Promise<CqMcpAskOutput> {
    if (this.rejected) {
      return Promise.reject(new Error("CqMcpAskBroker: channel closed"));
    }
    const buffered = this.bufferedReplies.get(askId);
    if (buffered !== undefined) {
      this.bufferedReplies.delete(askId);
      return Promise.resolve({ questions, answers: normaliseAnswers(buffered) });
    }
    // Replace any prior pending entry for the same askId (should not
    // happen — askIds are unique — but reject the stale one to avoid a
    // leaked Promise rather than silently dropping it).
    const prior = this.pending.get(askId);
    if (prior !== undefined) {
      prior.reject(new Error("CqMcpAskBroker: ask replaced for same askId"));
      this.pending.delete(askId);
    }
    return new Promise<CqMcpAskOutput>((resolve, reject) => {
      this.pending.set(askId, { resolve, reject, questions });
    });
  }

  /**
   * Resolve the pending ask for `askId`, or buffer the reply if the tool
   * handler has not parked yet. Returns true when a pending ask was
   * resolved, false when the reply was buffered.
   */
  reply(askId: string, answers: Record<string, unknown>): boolean {
    const entry = this.pending.get(askId);
    if (entry !== undefined) {
      this.pending.delete(askId);
      entry.resolve({ questions: entry.questions, answers: normaliseAnswers(answers) });
      return true;
    }
    this.bufferedReplies.set(askId, answers);
    return false;
  }

  /**
   * Reject every pending ask and discard every buffered reply. Idempotent.
   * After this call, future `ask()` calls reject synchronously so a tool
   * invocation racing the disconnect still fails fast.
   */
  rejectAll(reason = "CqMcpAskBroker: channel closed"): void {
    this.rejected = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.bufferedReplies.clear();
  }

  /** Exposed for tests. */
  hasPending(askId: string): boolean {
    return this.pending.has(askId);
  }

  /** Exposed for tests. */
  hasBufferedReply(askId: string): boolean {
    return this.bufferedReplies.has(askId);
  }
}

/**
 * Normalise answers identically to the server `AskBroker`:
 *   string[] → comma-joined; string → as-is; other → String() coercion.
 * Keeping this in lockstep means the Codex tool result is byte-identical
 * in shape to the Claude one.
 */
export function normaliseAnswers(
  answers: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(answers)) {
    if (Array.isArray(val)) {
      result[key] = (val as unknown[]).map(String).join(", ");
    } else {
      result[key] = String(val ?? "");
    }
  }
  return result;
}
