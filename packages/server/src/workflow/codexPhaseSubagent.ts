/**
 * codexPhaseSubagent.ts — Codex-backed generic phase subagent (codexwf —
 * closes WF-D01). The Codex analogue of `ClaudePhaseSubagent`.
 *
 * Generalizes the Codex producer's relay mechanism over the dispatch seam: for
 * any `PhaseSpec<O>` it dispatches a headless Codex thread wired to a
 * per-dispatch cq-mcp child whose harness-owned `submit_workflow_phase` tool
 * relays the model's payload upstream. The server-side `WorkflowSubmitProxy`
 * validates the payload against `spec.schema` (selected by `spec.submitPhase`)
 * and resolves the dispatch. The subagent is given NO ledger-write surface —
 * cq-mcp relays only; the HARNESS (WorkflowRuntime) writes the ledgers, exactly
 * as on the Claude path.
 *
 * Never goes through the interactive `Bridge` facade (own Codex instance +
 * thread, no SessionRegistry session, no chat.* frames), so the pool=1
 * interactive-chat invariant holds by construction.
 */

import type { Logger } from "../log/logger";
import type { PhaseSpec, PhaseRequest, PhaseSubagent } from "./phases.js";
import {
  dispatchCodexPhase,
  type CodexFactory,
  type CodexHeadlessDeps,
} from "./codexHeadless.js";
import type { CqMcpBin } from "../agent/codexBridge.js";
import type { WorkflowSubmitProxy } from "./workflowSubmitProxy.js";

export interface CodexPhaseSubagentOpts {
  logger: Logger;
  cwd: string;
  submitProxy: WorkflowSubmitProxy;
  internalWsUrl: string;
  internalWsToken: string;
  nextSubmitId: () => string;
  /** Override the Codex factory for tests. */
  codexFactory?: CodexFactory;
  /** Override the cq-mcp launch for tests. */
  cqMcpBin?: CqMcpBin;
  /**
   * Dispatch timeout in ms. When omitted, resolved by `resolvePhaseTimeoutMs`
   * in the shared codex lane: `CQ_WORKFLOW_PHASE_TIMEOUT_MS` env override → 300_000 default.
   */
  timeoutMs?: number;
}

export class CodexPhaseSubagent implements PhaseSubagent {
  private readonly deps: CodexHeadlessDeps;

  constructor(opts: CodexPhaseSubagentOpts) {
    this.deps = {
      logger: opts.logger,
      cwd: opts.cwd,
      submitProxy: opts.submitProxy,
      internalWsUrl: opts.internalWsUrl,
      internalWsToken: opts.internalWsToken,
      nextSubmitId: opts.nextSubmitId,
      ...(opts.codexFactory !== undefined ? { codexFactory: opts.codexFactory } : {}),
      ...(opts.cqMcpBin !== undefined ? { cqMcpBin: opts.cqMcpBin } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
  }

  async dispatch<O>(spec: PhaseSpec<O>, req: PhaseRequest): Promise<O> {
    return dispatchCodexPhase(this.deps, {
      phase: spec.submitPhase,
      schema: spec.schema,
      label: spec.label,
      prompt: req.prompt,
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(req.registerTeardown !== undefined ? { registerTeardown: req.registerTeardown } : {}),
    });
  }
}
