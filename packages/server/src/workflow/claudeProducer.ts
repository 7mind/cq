/**
 * claudeProducer.ts — Claude-backed headless producer (Q8 Claude path).
 *
 * Runs its OWN `query()` (via an injectable QueryFactory, default = the SDK's
 * `query`) with a single in-process MCP tool `submit_plan`. The tool handler
 * is the HARNESS: it validates the model's payload against
 * `ProducerOutputSchema` and resolves the dispatch. The producer is given NO
 * ledger MCP tools, so it CANNOT write ledgers.
 *
 * This path NEVER goes through the `Bridge` facade: it constructs its own
 * query, never registers a `SessionRegistry` session, and never emits
 * `chat.*` frames. The pool=1 interactive-chat invariant is therefore held by
 * construction — the interactive `Bridge.active` is untouched.
 *
 * A default 120 s timeout bounds a producer that never submits; on timeout
 * (or abort) the dispatch rejects and the query is closed.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options as SDKOptions,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Logger } from "../log/logger";
import {
  ProducerOutputSchema,
  buildProducerPrompt,
  type ProduceRequest,
  type ProducerOutput,
  type WorkflowProducer,
} from "./producer.js";
import {
  SingleMessageQueue,
  resolveNativeBinaryPath,
  makePhaseCanUseTool,
} from "./headlessQuery.js";

/** Same shape as ClaudeBridge.QueryFactory — injectable for tests. */
export type QueryFactory = (opts: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: SDKOptions;
}) => Query;

export interface ClaudeProducerOpts {
  logger: Logger;
  cwd: string;
  /** Override `query()` for tests. Defaults to the real SDK `query`. */
  queryFactory?: QueryFactory;
  /** Dispatch timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Zod schema for the `submit_plan` tool input. The producer fills this; the
 * handler re-validates against the stricter `ProducerOutputSchema` (min
 * lengths) before resolving so a vacuous `{goal:{description:""},questions:[]}`
 * is rejected at the harness boundary, not silently written.
 */
const submitPlanSchema = {
  goal: z.object({ title: z.string(), description: z.string() }),
  questions: z.array(
    z.object({
      question: z.string(),
      context: z.string().optional(),
      suggestions: z.array(z.string()).optional(),
      recommendation: z.string().optional(),
    }),
  ),
} as const;

export class ClaudeProducer implements WorkflowProducer {
  private readonly logger: Logger;
  private readonly cwd: string;
  private readonly queryFactory: QueryFactory;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeProducerOpts) {
    this.logger = opts.logger;
    this.cwd = opts.cwd;
    this.queryFactory =
      opts.queryFactory ??
      (({ prompt, options }) =>
        options !== undefined ? sdkQuery({ prompt, options }) : sdkQuery({ prompt }));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async produce(req: ProduceRequest): Promise<ProducerOutput> {
    // The harness resolves this when the producer calls submit_plan with a
    // valid payload. Rejects on timeout / abort / no-submit-before-stream-end.
    let resolveOutput!: (out: ProducerOutput) => void;
    let rejectOutput!: (err: Error) => void;
    const outputPromise = new Promise<ProducerOutput>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    let submitted = false;

    const submitTool = tool(
      "submit_plan",
      "Submit the refined goal description and the clarifying-question batch. Call exactly once.",
      submitPlanSchema,
      async (args) => {
        const parsed = ProducerOutputSchema.safeParse(args);
        if (!parsed.success) {
          // Surface the validation failure back to the model so it can retry,
          // but do NOT resolve — an invalid submit must not write ledgers.
          return {
            content: [
              {
                type: "text" as const,
                text: `submit_plan rejected: ${parsed.error.message}. Fix and resubmit.`,
              },
            ],
            isError: true,
          };
        }
        submitted = true;
        resolveOutput(parsed.data);
        return {
          content: [{ type: "text" as const, text: "submit_plan accepted." }],
        };
      },
    );

    const mcpServer = createSdkMcpServer({
      name: "wf",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [submitTool] as any,
    });

    // Bun workaround (mirrors ClaudeBridge.resolveNativeBinaryPath): under
    // Bun, child_process.spawn of the native CLI binary can intermittently
    // ENOENT even when the file exists. Passing the explicit path bypasses the
    // flaky spawn lookup; omitting it caused intermittent producer-startup
    // hangs (→ timeout) under load in the e2e suite.
    const nativeBinPath = resolveNativeBinaryPath();

    const options: SDKOptions = {
      cwd: this.cwd,
      // Headless: no partial messages, no subagent forwarding, no external MCP.
      mcpServers: { wf: mcpServer },
      ...(nativeBinPath !== undefined ? { pathToClaudeCodeExecutable: nativeBinPath } : {}),
      // Allow read-only exploration (Read/Grep/Glob) so the producer can GROUND
      // its goal + questions in the repo (codebase + on-disk `docs/*.md`
      // ledgers) instead of reasoning blind, PLUS the harness submit tool.
      // Everything else — including every write/exec tool — is denied: the
      // producer must NOT write files or ledgers (PLAN-D01).
      canUseTool: makePhaseCanUseTool("mcp__wf__submit_plan"),
    };
    if (req.model !== undefined) options.model = req.model;

    // Streaming-input queue: push the single prompt, then leave open until done.
    const queue = new SingleMessageQueue(buildProducerPrompt(req.text));
    const q = this.queryFactory({ prompt: queue, options });

    const timer = setTimeout(() => {
      rejectOutput(new Error(`producer timed out after ${this.timeoutMs}ms without submitting`));
    }, this.timeoutMs);

    const onAbort = (): void => {
      rejectOutput(new Error("producer aborted"));
    };
    if (req.signal !== undefined) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Drive the SDK iteration in the background. If the stream ends before a
    // submit, reject (a producer that never submitted is a failure).
    const drain = (async () => {
      try {
        for await (const _msg of q) {
          // Events are intentionally discarded — headless lane does not stream.
          if (submitted) break;
        }
        if (!submitted) {
          rejectOutput(new Error("producer finished without calling submit_plan"));
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
      // Close the query so the subprocess is reaped; ignore drain errors (the
      // outcome — resolve or reject — is already decided).
      try {
        queue.end();
        q.close();
      } catch (err: unknown) {
        this.logger.warn("producer.close_error", { err: String(err) });
      }
      // `drain` resolves when the async generator returns — which, after
      // `q.close()`, happens once the SDK subprocess is fully reaped. Surface it
      // as the teardown awaitable so the runtime can await real subprocess exit
      // (the produce call still resolves at submit-time above — timing unchanged).
      const teardown = drain.then(
        () => undefined,
        () => undefined,
      );
      if (req.registerTeardown !== undefined) req.registerTeardown(teardown);
      else void teardown;
    }
  }
}
