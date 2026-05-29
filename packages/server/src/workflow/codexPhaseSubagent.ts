/**
 * codexPhaseSubagent.ts — Codex-backed phase subagent (deferred; WF-D01).
 *
 * The dispatch seam is backend-neutral: the WorkflowRuntime selects a
 * `PhaseSubagent` by platform and never branches on backend in the loop logic.
 * The Codex variant will relay the structured submit payload back to the cq
 * server over the internal-WS channel (the ask_user_question WS-back-proxy
 * pattern) so the HARNESS still validates + writes — see WF-D01. That relay is
 * the NEXT cycle; this cycle keeps the seam clean by rejecting with a clear,
 * actionable error rather than faking output.
 */

import type { Logger } from "../log/logger";
import type { PhaseSpec, PhaseRequest, PhaseSubagent } from "./phases.js";

export interface CodexPhaseSubagentOpts {
  logger: Logger;
}

export class CodexPhaseSubagent implements PhaseSubagent {
  private readonly logger: Logger;

  constructor(opts: CodexPhaseSubagentOpts) {
    this.logger = opts.logger;
  }

  dispatch<O>(spec: PhaseSpec<O>, _req: PhaseRequest): Promise<O> {
    this.logger.warn("workflow.codex_phase_subagent_unavailable", { phase: spec.label });
    return Promise.reject(
      new Error(
        `Codex ${spec.label} subagent is not implemented yet (WF-D01): the Codex ` +
          "structured-output relay over internal-WS is a later cycle. Switch the " +
          "model dropdown to a Claude model to run /plan.",
      ),
    );
  }
}
