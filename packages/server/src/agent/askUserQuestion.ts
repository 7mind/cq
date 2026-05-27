/**
 * askUserQuestion.ts — AskUserQuestion MCP server (toolAliases + SDK-MCP path).
 *
 * Mechanism (PR-31-D02):
 *  - `createAskUserQuestionMcpServer(broker)` registers an in-process MCP server
 *    named "cq" with one tool: "ask_user_question".
 *  - Bridge wires `Options.toolAliases = { AskUserQuestion: 'mcp__cq__ask_user_question' }`
 *    so when the model emits an AskUserQuestion tool_use, the SDK routes it to our
 *    MCP handler instead of the built-in implementation.
 *  - The handler calls `broker.ask(questions)` which parks a Promise. The Promise
 *    resolves when the WS client posts `chat.question_reply` and the bridge calls
 *    `broker.reply(toolUseId, answers)`.
 *  - The handler returns the resolved output as a `CallToolResult`, completing the
 *    native tool call round-trip — no synthetic SDKUserMessage injection.
 */

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// AskBroker
// ---------------------------------------------------------------------------

/**
 * Minimal question shape forwarded from the MCP handler to the broker.
 * Uses `unknown` so any model-emitted input passes through without type friction.
 */
export type AskQuestion = unknown;

/**
 * The output returned by the broker when the user answers.
 * Mirrors AskUserQuestionOutput:
 *   questions: echo of the input questions array
 *   answers: { [questionText]: string } — comma-separated for multi-select
 */
export type AskUserQuestionOutput = {
  questions: AskQuestion[];
  answers: Record<string, string>;
};

type PendingEntry = {
  resolve: (output: AskUserQuestionOutput) => void;
  reject: (err: Error) => void;
  questions: AskQuestion[];
};

type BufferedReply = {
  toolUseId: string;
  answers: Record<string, unknown>;
};

/**
 * Broker that coordinates the AskUserQuestion MCP handler (which parks the
 * Promise) with the WS `chat.question_reply` handler (which resolves it).
 *
 * Timing: the WS reply may arrive before the MCP handler calls `ask()` (because
 * the assistant message surfaces in a chat.event before the MCP handler runs in
 * the SDK bridge). The broker handles this with a "buffered reply" slot: if
 * `reply()` is called while no ask is pending, the reply is stored and the next
 * `ask()` call resolves immediately.
 *
 * At most one pending ask per session (enforced by SESSION_BUSY + serial tool
 * call protocol).
 */
export class AskBroker {
  private pending: PendingEntry | null = null;
  private pendingToolUseId: string | null = null;
  /** Buffered reply that arrived before the MCP handler called ask(). */
  private bufferedReply: BufferedReply | null = null;

  /**
   * Called by the MCP handler to park a Promise until the user replies.
   * If a buffered reply is already waiting (race: WS reply arrived before this
   * call), resolves immediately with that reply.
   */
  ask(toolUseId: string, questions: AskQuestion[]): Promise<AskUserQuestionOutput> {
    if (this.pending !== null) {
      // Reject the stale pending entry to avoid leaking the Promise.
      this.pending.reject(new Error("AskBroker: new ask replaced pending ask"));
      this.pending = null;
      this.pendingToolUseId = null;
    }

    // If a reply arrived before this ask, resolve immediately.
    if (this.bufferedReply !== null) {
      const buf = this.bufferedReply;
      this.bufferedReply = null;
      return Promise.resolve({
        questions,
        answers: normaliseAnswers(buf.answers),
      });
    }

    return new Promise<AskUserQuestionOutput>((resolve, reject) => {
      this.pending = { resolve, reject, questions };
      this.pendingToolUseId = toolUseId;
    });
  }

  /**
   * Called by the bridge when `chat.question_reply` arrives from the WS client.
   * If no ask is currently pending (race: WS reply arrived before MCP handler),
   * buffers the reply for the next `ask()` call.
   * Returns true if a pending ask was resolved; false if the reply was buffered.
   */
  reply(toolUseId: string, answers: Record<string, unknown>): boolean {
    if (this.pending !== null) {
      const { resolve, questions } = this.pending;
      this.pending = null;
      this.pendingToolUseId = null;
      resolve({ questions, answers: normaliseAnswers(answers) });
      return true;
    }

    // Buffer the reply for when ask() is called.
    this.bufferedReply = { toolUseId, answers };
    return false;
  }

  /**
   * Reject any pending ask and discard any buffered reply.
   * Called on session end or bridge shutdown.
   */
  rejectAll(): void {
    if (this.pending !== null) {
      this.pending.reject(new Error("AskBroker: session ended"));
      this.pending = null;
      this.pendingToolUseId = null;
    }
    this.bufferedReply = null;
  }

  /** Exposed for tests. */
  pendingToolUseId_(): string | null {
    return this.pendingToolUseId;
  }

  /** Exposed for tests. */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Exposed for tests. */
  hasBufferedReply(): boolean {
    return this.bufferedReply !== null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise answers from the WS frame:
 * - string[] → comma-joined string (multi-select)
 * - string → as-is
 * - other → String() coercion
 */
function normaliseAnswers(answers: Record<string, unknown>): Record<string, string> {
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

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Input schema for the MCP tool.
 *
 * The SDK passes the model's raw parsed JSON to our handler. We use
 * `z.array(z.any())` for `questions` so that any well-formed array accepted
 * by the subprocess — including variations in the options structure — passes
 * through without schema rejection. Strict typing lives in AskUserQuestionInput
 * (sdk-tools.d.ts) and is enforced at the model/subprocess level.
 *
 * The extra `toolUseId` field is not part of AskUserQuestionInput; the broker
 * needs it for correlation. The SDK MCP handler receives it via the `extra`
 * parameter (typed `unknown`), which we cast below.
 */
const askUserQuestionSchema = {
  questions: z.array(z.any()).min(1).max(4),
} as const;

/**
 * Build just the `ask_user_question` tool. Exposed so the bridge can
 * combine it with sibling tools (e.g. the @cq/ledger tools) into one
 * `cq` MCP server, instead of registering multiple servers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAskUserQuestionTool(broker: AskBroker): any {
  return tool(
    "ask_user_question",
    "Ask the user one or more multiple-choice questions and await their answers.",
    askUserQuestionSchema,
    async (args, extra) => {
      // Extract toolUseId from the `extra` context if available.
      // The MCP SDK populates `extra` with request context; the toolUseId is
      // not guaranteed to be present, so we fall back to a generated UUID.
      let toolUseId: string = crypto.randomUUID();
      if (
        extra !== null &&
        typeof extra === "object" &&
        "requestId" in (extra as Record<string, unknown>)
      ) {
        const maybeId = (extra as Record<string, unknown>)["requestId"];
        if (typeof maybeId === "string" && maybeId.length > 0) {
          toolUseId = maybeId;
        }
      }

      const output = await broker.ask(toolUseId, args.questions as AskQuestion[]);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output),
          },
        ],
      };
    },
  );
}

/**
 * Build and return an in-process MCP server named "cq" that owns the
 * `ask_user_question` tool. Wire it into `Options.mcpServers` and pair with
 * `Options.toolAliases = { AskUserQuestion: 'mcp__cq__ask_user_question' }`.
 */
export function createAskUserQuestionMcpServer(
  broker: AskBroker,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "cq",
    tools: [createAskUserQuestionTool(broker)],
  });
}
