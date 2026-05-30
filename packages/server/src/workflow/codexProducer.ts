/**
 * codexProducer.ts — Codex-backed headless producer (codexwf — closes WF-D01).
 *
 * The Codex analogue of `ClaudeProducer`. Whereas the Claude path forces
 * structured output via an IN-PROCESS `submit_plan` MCP tool, the Codex SDK
 * (`@openai/codex-sdk@0.134.0`) has no in-process forced-tool mechanism — its
 * only MCP surface is the standalone `cq-mcp` stdio binary. So the Codex
 * producer forces structured output via the harness-owned
 * `submit_workflow_phase` tool exposed by a per-dispatch cq-mcp child: the
 * model calls it, the child relays `workflow.submit` upstream, the server's
 * `WorkflowSubmitProxy` validates against `ProducerOutputSchema` and resolves
 * the dispatch. The producer is given NO ledger-write surface for this — cq-mcp
 * relays only; the HARNESS (WorkflowRuntime) writes every ledger, exactly as on
 * the Claude path.
 *
 * This path NEVER goes through the interactive `Bridge` facade (own Codex
 * instance + thread, no SessionRegistry session, no chat.* frames), so the
 * pool=1 interactive-chat invariant holds by construction.
 */

import type { Logger } from "../log/logger";
import {
  ProducerOutputSchema,
  buildProducerPrompt,
  type ProduceRequest,
  type ProducerOutput,
  type WorkflowProducer,
} from "./producer.js";
import {
  dispatchCodexPhase,
  type CodexFactory,
  type CodexHeadlessDeps,
} from "./codexHeadless.js";
import type { CqMcpBin } from "../agent/codexBridge.js";
import type { WorkflowSubmitProxy } from "./workflowSubmitProxy.js";

export interface CodexProducerOpts {
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

export class CodexProducer implements WorkflowProducer {
  private readonly deps: CodexHeadlessDeps;

  constructor(opts: CodexProducerOpts) {
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

  async produce(req: ProduceRequest): Promise<ProducerOutput> {
    return dispatchCodexPhase(this.deps, {
      phase: "produce",
      schema: ProducerOutputSchema,
      label: "producer",
      prompt: buildProducerPrompt(req.text),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(req.registerTeardown !== undefined ? { registerTeardown: req.registerTeardown } : {}),
    });
  }
}
