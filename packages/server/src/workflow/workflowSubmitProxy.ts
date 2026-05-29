/**
 * workflowSubmitProxy.ts — cq-server side of the Codex `/plan` structured-output
 * relay (codexwf). Analogous to `agent/askProxy.ts` for the workflow lane.
 *
 * A headless-Codex phase dispatch (`CodexPhaseSubagent` / `CodexProducer`)
 * spawns a `cq-mcp` child wired to this server's internal-WS channel and primed
 * with a `submitId` + `phase`. The child exposes the harness-owned
 * `submit_workflow_phase` tool; when the Codex model calls it, the child relays
 * `workflow.submit{submitId, phase, payload}` upstream. THIS proxy:
 *
 *   1. correlates `submitId` to the waiting dispatch (registered via `register`
 *      before the codex run starts);
 *   2. validates `payload` against THAT dispatch's Zod schema (the per-phase
 *      schema, supplied at registration; the proxy also asserts the relayed
 *      `phase` matches the registered one);
 *   3. on success → resolves the dispatch's parked promise with the validated
 *      value (the WorkflowRuntime then writes the ledgers, exactly as on the
 *      Claude path) and replies `workflow.submit_ack{ok:true}`;
 *   4. on a malformed payload / phase mismatch → replies
 *      `workflow.submit_ack{ok:false,error}` and LEAVES the dispatch pending so
 *      the model can resubmit a corrected payload (the dispatch's own timeout /
 *      abort bounds a model that never recovers). NO ledger is written on a
 *      rejected submit — the runtime only writes after the promise resolves.
 *
 * The HARNESS still owns every ledger write: this proxy only validates +
 * resolves; cq-mcp only relays. Same guarantee as the Claude path.
 *
 * Correlation soundness. `submitId` is minted per dispatch and unique; a submit
 * for an unknown id (dispatch already settled / torn down) is acked
 * `{ok:false}` so the model's tool returns cleanly rather than hanging. A
 * dispatch torn down mid-submit calls `reject(submitId)` which rejects the
 * parked promise AND drops the correlation, so a late relayed submit is treated
 * as unknown. Uniform-async: all handlers return `Promise<void>`.
 */

import type { z } from "zod";
import type { Logger } from "../log/logger";
import type { WorkflowSubmitPhase } from "@cq/shared";

/** How the proxy replies upstream. Production wires this to InternalWsService.broadcast. */
export type SendSubmitAck = (submitId: string, ok: boolean, error?: string) => void;

export interface WorkflowSubmitProxyOpts {
  logger: Logger;
  sendAck: SendSubmitAck;
}

/** A registered, in-flight dispatch awaiting its relayed submit. */
interface PendingDispatch {
  readonly phase: WorkflowSubmitPhase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly schema: z.ZodType<any>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
}

export class WorkflowSubmitProxy {
  private readonly logger: Logger;
  private readonly sendAck: SendSubmitAck;
  /** submitId → the waiting dispatch. */
  private readonly pending = new Map<string, PendingDispatch>();

  constructor(opts: WorkflowSubmitProxyOpts) {
    this.logger = opts.logger;
    this.sendAck = opts.sendAck;
  }

  /**
   * Register a dispatch awaiting the relayed submit for `submitId`. Returns a
   * promise that resolves with the validated payload (typed by the phase
   * schema) when a well-formed `workflow.submit` arrives, or rejects if the
   * dispatch is torn down (`reject(submitId)`). The caller (CodexPhaseSubagent /
   * CodexProducer) registers BEFORE starting the codex run so a fast relay
   * cannot arrive before the correlation exists.
   */
  register<O>(submitId: string, phase: WorkflowSubmitPhase, schema: z.ZodType<O>): Promise<O> {
    const prior = this.pending.get(submitId);
    if (prior !== undefined) {
      // submitIds are unique per dispatch; a collision is a programming error.
      prior.reject(new Error(`WorkflowSubmitProxy: submitId ${submitId} re-registered`));
      this.pending.delete(submitId);
    }
    return new Promise<O>((resolve, reject) => {
      this.pending.set(submitId, {
        phase,
        schema: schema as z.ZodType<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  /**
   * Handle an inbound `workflow.submit`. Validates the payload against the
   * registered phase schema, resolves the dispatch on success, and acks the
   * cq-mcp child either way. Uniform-async (`Promise<void>`).
   */
  onSubmit(msg: { submitId: string; phase: WorkflowSubmitPhase; payload: unknown }): void {
    const entry = this.pending.get(msg.submitId);
    if (entry === undefined) {
      // No dispatch waiting (already settled / torn down / unknown id). Ack
      // false so the model's tool returns cleanly rather than hanging.
      this.logger.info("workflowSubmit.unknown_submit", { submitId: msg.submitId, phase: msg.phase });
      this.sendAck(msg.submitId, false, "no in-flight phase dispatch for this submit");
      return;
    }
    if (entry.phase !== msg.phase) {
      // The relayed phase must match what the dispatch registered. A mismatch
      // means a crossed wire; reject the submit but KEEP the dispatch pending
      // so a correct resubmit can still land.
      this.logger.warn("workflowSubmit.phase_mismatch", {
        submitId: msg.submitId,
        expected: entry.phase,
        got: msg.phase,
      });
      this.sendAck(
        msg.submitId,
        false,
        `phase mismatch: dispatch expects ${entry.phase}, got ${msg.phase}`,
      );
      return;
    }
    const parsed = entry.schema.safeParse(msg.payload);
    if (!parsed.success) {
      // Malformed payload → ack false; LEAVE the dispatch pending so the model
      // can resubmit. NO ledger is written (the runtime writes only after the
      // promise resolves below).
      this.logger.info("workflowSubmit.invalid_payload", {
        submitId: msg.submitId,
        phase: msg.phase,
        error: parsed.error.message,
      });
      this.sendAck(msg.submitId, false, parsed.error.message);
      return;
    }
    // Valid: settle the dispatch, drop the correlation, ack ok. The runtime
    // resumes from the resolved promise and writes the ledgers.
    this.pending.delete(msg.submitId);
    entry.resolve(parsed.data);
    this.sendAck(msg.submitId, true);
    this.logger.info("workflowSubmit.accepted", { submitId: msg.submitId, phase: msg.phase });
  }

  /**
   * Reject + drop the correlation for `submitId` (dispatch torn down: timeout /
   * abort / shutdown). The parked promise rejects; a subsequently-arriving
   * `workflow.submit` is then treated as unknown (acked false). Idempotent.
   */
  reject(submitId: string, reason: string): void {
    const entry = this.pending.get(submitId);
    if (entry === undefined) return;
    this.pending.delete(submitId);
    entry.reject(new Error(reason));
  }

  /** Exposed for tests. */
  hasPending(submitId: string): boolean {
    return this.pending.has(submitId);
  }
}
