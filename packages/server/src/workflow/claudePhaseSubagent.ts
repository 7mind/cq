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
import { SingleMessageQueue, resolveNativeBinaryPath } from "./headlessQuery.js";
import type { PhaseSpec, PhaseRequest, PhaseSubagent } from "./phases.js";

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
  /** Dispatch timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      canUseTool: async (toolName: string) => {
        if (toolName === fqToolName) {
          return { behavior: "allow" as const, updatedInput: {} };
        }
        return { behavior: "deny" as const, message: `subagent may only call ${spec.toolName}` };
      },
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

    const drain = (async () => {
      try {
        for await (const _msg of q) {
          if (submitted) break;
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
      try {
        queue.end();
        q.close();
      } catch (err: unknown) {
        this.logger.warn("phase.close_error", { phase: spec.label, err: String(err) });
      }
      // `drain` resolves when the async generator returns — which, after
      // `q.close()`, happens once the SDK subprocess is fully reaped. Surface it
      // as the teardown awaitable so the runtime can await real subprocess exit
      // (the dispatch still resolves at submit-time above — timing unchanged).
      const teardown = drain.then(
        () => undefined,
        () => undefined,
      );
      if (req.registerTeardown !== undefined) req.registerTeardown(teardown);
      else void teardown;
    }
  }
}
