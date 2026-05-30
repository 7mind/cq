/**
 * claudePhaseSubagent.ts — Claude-backed generic phase subagent (cycle 3).
 *
 * Generalizes the phase-1 ClaudeProducer mechanism: dispatch a HEADLESS
 * `query()` exposing a single harness-owned `submit_<phase>` in-process MCP
 * tool. The tool handler validates the model's payload against the phase's Zod
 * schema and resolves the dispatch. The subagent is given NO ledger tools so it
 * CANNOT write ledgers — the WorkflowRuntime (HARNESS) does.
 *
 * This path never goes through the `Bridge` facade (own query, no
 * SessionRegistry session, no chat.* frames), so the pool=1 interactive-chat
 * invariant holds by construction.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Query, Options as SDKOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Logger } from "../log/logger";
import {
  SingleMessageQueue,
  resolveNativeBinaryPath,
  makePhaseCanUseTool,
  extractUsageFromResult,
} from "./headlessQuery.js";
import type { PhaseSpec, PhaseRequest, PhaseSubagent } from "./phases.js";
import { resolvePhaseTimeoutMs } from "./phaseTimeout.js";

/** Same shape as ClaudeProducer.QueryFactory — injectable for tests. */
export type QueryFactory = (opts: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: SDKOptions;
}) => Query;

export interface ClaudePhaseSubagentOpts {
  logger: Logger;
  cwd: string;
  /** Override `query()` for tests. Defaults to the real SDK `query`. */
  queryFactory?: QueryFactory;
  /**
   * Dispatch timeout in ms. When omitted, resolved by `resolvePhaseTimeoutMs`:
   * `CQ_WORKFLOW_PHASE_TIMEOUT_MS` env override → 300_000 default.
   */
  timeoutMs?: number;
}

export class ClaudePhaseSubagent implements PhaseSubagent {
  private readonly logger: Logger;
  private readonly cwd: string;
  private readonly queryFactory: QueryFactory;
  private readonly timeoutMs: number;

  constructor(opts: ClaudePhaseSubagentOpts) {
    this.logger = opts.logger;
    this.cwd = opts.cwd;
    this.queryFactory =
      opts.queryFactory ??
      (({ prompt, options }) =>
        options !== undefined ? sdkQuery({ prompt, options }) : sdkQuery({ prompt }));
    this.timeoutMs = resolvePhaseTimeoutMs(opts.timeoutMs);
  }

  async dispatch<O>(spec: PhaseSpec<O>, req: PhaseRequest): Promise<O> {
    let resolveOutput!: (out: O) => void;
    let rejectOutput!: (err: Error) => void;
    const outputPromise = new Promise<O>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    let submitted = false;

    // The submit tool advertises a permissive object shape; the handler
    // re-validates against the strict phase schema so a malformed submit is
    // rejected at the harness boundary and the model is asked to resubmit.
    const submitTool = tool(
      spec.toolName,
      `Submit the structured ${spec.label} result. Call exactly once.`,
      { payload: z.unknown() } as const,
      async (args: { payload: unknown }) => {
        const parsed = spec.schema.safeParse(args.payload);
        if (!parsed.success) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${spec.toolName} rejected: ${parsed.error.message}. Fix and resubmit.`,
              },
            ],
            isError: true,
          };
        }
        submitted = true;
        resolveOutput(parsed.data);
        return { content: [{ type: "text" as const, text: `${spec.toolName} accepted.` }] };
      },
    );

    const mcpServer = createSdkMcpServer({
      name: "wf",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [submitTool] as any,
    });

    const nativeBinPath = resolveNativeBinaryPath();
    const fqToolName = `mcp__wf__${spec.toolName}`;
    const options: SDKOptions = {
      cwd: this.cwd,
      mcpServers: { wf: mcpServer },
      ...(nativeBinPath !== undefined ? { pathToClaudeCodeExecutable: nativeBinPath } : {}),
      // Allow read-only exploration (Read/Grep/Glob) so the phase subagent can
      // GROUND its output in the repo (codebase + on-disk `docs/*.md` ledgers)
      // instead of reasoning blind, PLUS this phase's harness submit tool.
      // Everything else — including every write/exec tool — is denied: the
      // subagent must NOT write files or ledgers (PLAN-D01).
      canUseTool: makePhaseCanUseTool(fqToolName),
    };
    if (req.model !== undefined) options.model = req.model;

    const queue = new SingleMessageQueue(req.prompt);
    const q = this.queryFactory({ prompt: queue, options });

    const timer = setTimeout(() => {
      rejectOutput(new Error(`${spec.label} timed out after ${this.timeoutMs}ms without submitting`));
    }, this.timeoutMs);

    const onAbort = (): void => {
      rejectOutput(new Error(`${spec.label} aborted`));
    };
    if (req.signal !== undefined) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Capture usage from the SDK `result` message. The dispatch resolves at
    // submit-time (outputPromise, above); we keep draining past the submit so
    // the `result` message — which the SDK emits AFTER the tool call completes
    // (a second round-trip: the tool_result re-enters, the model replies,
    // end_turn → result) — can be observed and fired through `onUsage` exactly
    // once. The drain breaks on the first `result`, then closes the query. A
    // grace timer (see finally) force-closes if no `result` arrives, so the
    // subprocess is always reaped.
    const fallbackModel = req.model ?? "";
    let usageFired = false;
    const drain = (async () => {
      try {
        for await (const msg of q) {
          const usage = extractUsageFromResult(msg, fallbackModel);
          if (usage !== undefined && !usageFired) {
            usageFired = true;
            if (req.onUsage !== undefined) req.onUsage(usage);
            // A `result` message marks the end of the turn; once we have usage
            // there is nothing further to observe — stop draining and close.
            break;
          }
        }
        if (!submitted) {
          rejectOutput(new Error(`${spec.label} finished without calling ${spec.toolName}`));
        }
      } catch (err: unknown) {
        rejectOutput(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    try {
      return await outputPromise;
    } finally {
      clearTimeout(timer);
      if (req.signal !== undefined) req.signal.removeEventListener("abort", onAbort);
      // End the input queue immediately (no further turns) but DEFER `q.close()`
      // until the drain has observed the `result` message — otherwise an eager
      // close cuts off the post-submit round-trip and usage is never captured.
      // The drain self-terminates on the first `result`; a grace timer bounds
      // the wait so a turn that never produces a `result` still reaps the child.
      // This does NOT delay the caller (the dispatch already returned above) nor
      // touch the interactive Bridge — pool=1 holds.
      try {
        queue.end();
      } catch (err: unknown) {
        this.logger.warn("phase.close_error", { phase: spec.label, err: String(err) });
      }
      // Only wait for a post-submit `result` when the model actually submitted;
      // on the reject paths (timeout/abort/no-submit) there is no usage to await,
      // so close immediately.
      const teardown = closeAfterDrain(q, drain, this.logger, spec.label, submitted);
      if (req.registerTeardown !== undefined) req.registerTeardown(teardown);
      else void teardown;
    }
  }
}

/** Grace window (ms) to observe the post-submit `result` before force-closing. */
const RESULT_GRACE_MS = 5_000;

/**
 * Wait for the drain to settle (it breaks on the first `result`) OR a grace
 * timeout, then close the query so the SDK subprocess is reaped. Returns a
 * teardown awaitable that resolves once the generator has fully returned after
 * close. Shared by both Claude headless lanes.
 */
export async function closeAfterDrain(
  q: { close: () => void },
  drain: Promise<void>,
  logger: Logger,
  label: string,
  waitForResult: boolean,
): Promise<void> {
  if (waitForResult) {
    const grace = new Promise<void>((res) => setTimeout(res, RESULT_GRACE_MS));
    await Promise.race([drain, grace]);
  }
  try {
    q.close();
  } catch (err: unknown) {
    logger.warn("phase.close_error", { phase: label, err: String(err) });
  }
  // After close the generator returns; await the drain so the awaitable reflects
  // real subprocess exit.
  await drain.catch(() => undefined);
}
