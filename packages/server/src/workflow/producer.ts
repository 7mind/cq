/**
 * producer.ts — the headless "producer" subagent abstraction (Q8).
 *
 * The WorkflowRuntime dispatches a producer in a HEADLESS lane that does NOT
 * stream to the interactive chat WS and does NOT occupy the pool=1
 * interactive `Bridge.active` session. The producer's sole job is to PRODUCE
 * a structured `{ goal, questions }` payload; the HARNESS (WorkflowRuntime)
 * writes the ledgers. The producer MUST NOT touch the ledgers.
 *
 * Structured output is forced via a single harness-owned `submit_plan` tool
 * the producer must call (Claude path); the handler validates the payload
 * against `ProducerOutputSchema` and resolves the run. This is the
 * "structured output" mechanism rather than free-text parsing.
 *
 * Backends: `ClaudeProducer` ships this cycle. The Codex path is documented
 * in defects.md (WF-D01) — Codex's structured-output forcing differs and is
 * deferred; the runtime selects the producer by `platform`.
 */

import { z } from "zod";

/** One clarifying question the producer proposes. Mirrors the questions ledger fields. */
export const ProducerQuestionSchema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
});
export type ProducerQuestion = z.infer<typeof ProducerQuestionSchema>;

/** The structured payload the producer must submit. */
export const ProducerOutputSchema = z.object({
  goal: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
  }),
  questions: z.array(ProducerQuestionSchema).min(1),
});
export type ProducerOutput = z.infer<typeof ProducerOutputSchema>;

/**
 * A sink the dispatch calls EXACTLY ONCE with a promise that resolves when the
 * underlying SDK `query()` subprocess has been fully torn down (its async
 * generator returned after `close()`), i.e. the child process is gone. Lets the
 * runtime expose a "fully drained" awaitable without changing when `produce`
 * resolves to the caller (it still resolves at submit-time). Optional so
 * existing callers/tests need not supply it.
 */
export type TeardownSink = (settled: Promise<void>) => void;

/** Inputs to a single producer dispatch. */
export interface ProduceRequest {
  /** The refined user goal text (already stripped of the `/plan` token). */
  readonly text: string;
  /** Optional model override (from the model selection active at /plan time). */
  readonly model?: string;
  /** Abort signal — the runtime aborts on busy-preempt or shutdown. */
  readonly signal?: AbortSignal;
  /** Optional sink for the subprocess-teardown awaitable (see TeardownSink). */
  readonly registerTeardown?: TeardownSink;
}

/**
 * A producer dispatches the headless subagent and resolves with the
 * validated structured output. It rejects on timeout, abort, malformed
 * output, or a producer that finished without submitting.
 */
export interface WorkflowProducer {
  produce(req: ProduceRequest): Promise<ProducerOutput>;
}

/**
 * Explore-first instruction prepended to EVERY phase prompt (producer, clarify-
 * reviewer, planner, plan-reviewer, continuation) on BOTH backends (PLAN-D01).
 *
 * The phase subagent now has read-only tools (Claude: Read/Grep/Glob via
 * `canUseTool`; Codex: file reads via its sandbox), so it must GROUND its work
 * in the actual repository instead of asking questions whose answers are
 * discoverable in the codebase. Kept backend-neutral: it names tools only
 * generically so the Codex submit-instruction override (codexHeadless.ts) does
 * not contradict it.
 */
export const EXPLORE_FIRST_INSTRUCTION: string = [
  "Before producing your output, EXPLORE this repository to ground your work:",
  "read `CLAUDE.md`, `README.md`, the key source under `packages/`, and the",
  "existing on-disk ledgers in `docs/` (e.g. milestones.md, defects.md,",
  "tasks.md). The working directory IS the project, so these are all readable.",
  "Do NOT ask clarifying questions whose answers are discoverable in the",
  "codebase (e.g. what the project is, what existing terms refer to); ask ONLY",
  "about genuine product/scope decisions the user must make.",
  "",
].join("\n");

/**
 * The single instruction handed to the producer. Kept terse and explicit:
 * the producer must call `submit_plan` exactly once and must NOT attempt to
 * write any ledger.
 */
export function buildProducerPrompt(text: string): string {
  return [
    EXPLORE_FIRST_INSTRUCTION,
    "You are a planning producer. Given a user's goal, produce:",
    "1. A SHORT goal `title` (≤ ~8 words, a crisp name for the goal — what it",
    "   would read as in a one-line list).",
    "2. A detailed multi-sentence goal `description` that refines the scope.",
    "3. A batch of clarifying questions that must be answered before the goal can be planned.",
    "",
    "Each question must have: a `question` (required), optional `context`, optional",
    "`suggestions` (an array of candidate answers), and an optional `recommendation`.",
    "",
    "You MUST call the `submit_plan` tool exactly once with the structured result.",
    "Do NOT write to any ledger or file. Do NOT ask the user anything directly.",
    "",
    `User goal: ${text}`,
  ].join("\n");
}
