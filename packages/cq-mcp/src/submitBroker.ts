/**
 * CqMcpSubmitBroker — cq-mcp side of the Codex `/plan` structured-output relay
 * (codexwf).
 *
 * Mirrors `CqMcpAskBroker` (the askproxy two-slot race machine), keyed by
 * `submitId` rather than `askId`. A Codex phase subagent calls the harness-
 * owned `submit_workflow_phase` tool; the tool relays `workflow.submit` upstream
 * and parks a Promise here until the server replies `workflow.submit_ack`.
 *
 * Timing. The inbound `workflow.submit_ack` (server → cq-mcp) could be
 * processed before the tool handler parks its Promise via `submit(submitId)` —
 * the same reply-before-park timing class the ask broker guards against. Each
 * `submitId` therefore has a buffered-ack slot: if `ack()` arrives first it is
 * stored and the matching `submit()` resolves immediately.
 *
 * Disconnect. `rejectAll()` rejects every pending submit and clears every
 * buffered ack; cq-mcp `main` wires it to the channel's `onClose` so the submit
 * tool handler returns an error result instead of hanging after the WS drops.
 *
 * cq-mcp NEVER writes ledgers here — the broker only carries the ack back to
 * the parked tool; the HARNESS (WorkflowRuntime) owns every ledger write.
 */

/** The ack outcome the parked submit tool resolves with. */
export type CqMcpSubmitOutcome = {
  ok: boolean;
  /** Present (and human-readable) only when ok is false. */
  error?: string;
};

type PendingEntry = {
  resolve: (outcome: CqMcpSubmitOutcome) => void;
  reject: (err: Error) => void;
};

export class CqMcpSubmitBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly bufferedAcks = new Map<string, CqMcpSubmitOutcome>();
  private rejected = false;

  /**
   * Park a Promise for `submitId` until the matching `workflow.submit_ack`
   * arrives. If an ack is already buffered (ack-before-submit race), resolves
   * immediately. Rejects (via a rejected Promise) if the broker has been torn
   * down — uniform-async: always returns a `Promise`.
   */
  submit(submitId: string): Promise<CqMcpSubmitOutcome> {
    if (this.rejected) {
      return Promise.reject(new Error("CqMcpSubmitBroker: channel closed"));
    }
    const buffered = this.bufferedAcks.get(submitId);
    if (buffered !== undefined) {
      this.bufferedAcks.delete(submitId);
      return Promise.resolve(buffered);
    }
    // Replace any prior pending entry for the same submitId (should not happen
    // — submitIds are unique — but reject the stale one to avoid a leaked
    // Promise rather than silently dropping it).
    const prior = this.pending.get(submitId);
    if (prior !== undefined) {
      prior.reject(new Error("CqMcpSubmitBroker: submit replaced for same submitId"));
      this.pending.delete(submitId);
    }
    return new Promise<CqMcpSubmitOutcome>((resolve, reject) => {
      this.pending.set(submitId, { resolve, reject });
    });
  }

  /**
   * Resolve the pending submit for `submitId`, or buffer the ack if the tool
   * handler has not parked yet. Returns true when a pending submit was resolved,
   * false when the ack was buffered.
   */
  ack(submitId: string, outcome: CqMcpSubmitOutcome): boolean {
    const entry = this.pending.get(submitId);
    if (entry !== undefined) {
      this.pending.delete(submitId);
      entry.resolve(outcome);
      return true;
    }
    this.bufferedAcks.set(submitId, outcome);
    return false;
  }

  /**
   * Reject every pending submit and discard every buffered ack. Idempotent.
   * After this call, future `submit()` calls reject synchronously so a tool
   * invocation racing the disconnect still fails fast.
   */
  rejectAll(reason = "CqMcpSubmitBroker: channel closed"): void {
    this.rejected = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.bufferedAcks.clear();
  }

  /** Exposed for tests. */
  hasPending(submitId: string): boolean {
    return this.pending.has(submitId);
  }

  /** Exposed for tests. */
  hasBufferedAck(submitId: string): boolean {
    return this.bufferedAcks.has(submitId);
  }
}
