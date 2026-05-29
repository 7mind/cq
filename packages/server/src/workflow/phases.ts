/**
 * phases.ts — the phase-subagent dispatch seam (cycle 3) and the structured
 * output schemas for each `/plan` loop phase.
 *
 * Every phase (producer, clarify-reviewer, planner, plan-reviewer) is a
 * HEADLESS subagent that returns a Zod-validated structured payload via a
 * harness-owned in-process `submit_*` MCP tool. The subagent NEVER writes
 * ledgers; the WorkflowRuntime (HARNESS) does. This is the same mechanism the
 * phase-1 producer uses, lifted to a generic `PhaseSubagent` so the loop logic
 * does not branch on backend and the Codex relay variant (next cycle) slots in
 * without reworking the loops.
 *
 * A `PhaseSpec<O>` couples a submit-tool name, its Zod schema, and a
 * prompt-builder. A `PhaseSubagent` dispatches a spec + a request and resolves
 * with the validated output. `ClaudePhaseSubagent` (claudePhaseSubagent.ts) is
 * the Claude implementation; a Codex variant is a documented stub.
 */

import { z } from "zod";
import type { TeardownSink } from "./producer.js";

// ---------------------------------------------------------------------------
// Clarify-reviewer phase (Q5 auto-advance loop).
// ---------------------------------------------------------------------------

/** A fresh clarifying question the reviewer wants answered before planning. */
export const ReviewQuestionSchema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
});
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;

/**
 * The clarify-reviewer verdict. `clear` true → scope is settled, advance to the
 * planner. Otherwise `newQuestions` (and any `contradictions` to surface) drive
 * another human-gated clarify round.
 */
export const ClarifyReviewOutputSchema = z.object({
  clear: z.boolean(),
  contradictions: z.array(z.string()),
  newQuestions: z.array(ReviewQuestionSchema),
});
export type ClarifyReviewOutput = z.infer<typeof ClarifyReviewOutputSchema>;

// ---------------------------------------------------------------------------
// Planner phase.
// ---------------------------------------------------------------------------

/** A planner-proposed milestone (the spec milestone stays first; these follow). */
export const PlanMilestoneSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});
export type PlanMilestone = z.infer<typeof PlanMilestoneSchema>;

/**
 * A planner-proposed task. `milestoneRef` is the zero-based index into the
 * planner's own `milestones` array; the harness resolves it to the freshly
 * created milestone id before writing the task.
 */
export const PlanTaskSchema = z.object({
  milestoneRef: z.number().int().nonnegative(),
  headline: z.string().min(1),
  description: z.string().min(1),
  acceptance: z.string().optional(),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanOutputSchema = z.object({
  milestones: z.array(PlanMilestoneSchema).min(1),
  tasks: z.array(PlanTaskSchema).min(1),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ---------------------------------------------------------------------------
// Plan-reviewer phase (adversarial; no-progress guard wraps this loop).
// ---------------------------------------------------------------------------

export const PlanFindingSchema = z.object({
  severity: z.string().min(1),
  issue: z.string().min(1),
  suggestion: z.string().min(1),
});
export type PlanFinding = z.infer<typeof PlanFindingSchema>;

/**
 * The plan-reviewer verdict. `satisfied` true → goal is `planned`. Otherwise:
 * `newQuestions` re-enter the clarify gate; absent that, `findings` drive a
 * planner revision. The no-progress guard escalates if revisions stop changing
 * the plan without raising questions.
 */
export const PlanReviewOutputSchema = z.object({
  satisfied: z.boolean(),
  findings: z.array(PlanFindingSchema),
  newQuestions: z.array(ReviewQuestionSchema),
});
export type PlanReviewOutput = z.infer<typeof PlanReviewOutputSchema>;

// ---------------------------------------------------------------------------
// Dispatch seam.
// ---------------------------------------------------------------------------

/** A request to dispatch a phase subagent. */
export interface PhaseRequest {
  /** The fully-built prompt for this dispatch. */
  readonly prompt: string;
  /** Optional model override. */
  readonly model?: string;
  /** Abort signal — the runtime aborts on shutdown / busy-preempt. */
  readonly signal?: AbortSignal;
  /** Optional sink for the subprocess-teardown awaitable (see TeardownSink). */
  readonly registerTeardown?: TeardownSink;
}

/**
 * A phase spec couples the harness-owned submit-tool name, the Zod schema the
 * payload is validated against, and a short human label used in logs. The
 * schema's input shape is what the SDK tool advertises; the output is the
 * parsed, validated value.
 */
export interface PhaseSpec<O> {
  /** Tool name suffix; the SDK exposes it as `mcp__wf__<toolName>`. */
  readonly toolName: string;
  /** Validates the submitted payload; rejects malformed submits at the boundary. */
  readonly schema: z.ZodType<O>;
  /** Short label for logs ("clarify-review", "planner", "plan-review"). */
  readonly label: string;
}

/**
 * Dispatches a headless phase subagent and resolves with the validated output.
 * Rejects on timeout, abort, malformed output, or a subagent that finished
 * without submitting. The implementation owns its own `query()` and exposes the
 * single harness submit tool; it never touches the interactive Bridge.
 */
export interface PhaseSubagent {
  dispatch<O>(spec: PhaseSpec<O>, req: PhaseRequest): Promise<O>;
}

/** Identifies which phase subagent the runtime wants for a platform. */
export type PhaseKind = "clarify_review" | "plan" | "plan_review";

/** Selects a phase subagent for a platform (Claude this cycle; Codex stubbed). */
export type PhaseSubagentSelector = (platform: "claude" | "codex") => PhaseSubagent;

// ---------------------------------------------------------------------------
// Canonical phase specs.
// ---------------------------------------------------------------------------

export const CLARIFY_REVIEW_SPEC: PhaseSpec<ClarifyReviewOutput> = {
  toolName: "submit_clarify_review",
  schema: ClarifyReviewOutputSchema,
  label: "clarify-review",
};

export const PLAN_SPEC: PhaseSpec<PlanOutput> = {
  toolName: "submit_plan_doc",
  schema: PlanOutputSchema,
  label: "planner",
};

export const PLAN_REVIEW_SPEC: PhaseSpec<PlanReviewOutput> = {
  toolName: "submit_plan_review",
  schema: PlanReviewOutputSchema,
  label: "plan-review",
};

// ---------------------------------------------------------------------------
// Prompt builders. Each phase gets the goal + the relevant prior artefacts and
// a strict instruction to call its submit tool exactly once and write nothing.
// ---------------------------------------------------------------------------

/** One answered/open Q&A pair, as the runtime hands it to a reviewer. */
export interface QnA {
  readonly question: string;
  readonly context?: string;
  readonly answer?: string;
}

function renderQnA(qna: readonly QnA[]): string {
  return qna
    .map((q, i) => {
      const ctx = q.context !== undefined ? `\n   context: ${q.context}` : "";
      const ans = q.answer !== undefined ? `\n   answer: ${q.answer}` : "\n   answer: (unanswered)";
      return `${i + 1}. ${q.question}${ctx}${ans}`;
    })
    .join("\n");
}

export function buildClarifyReviewPrompt(goalDescription: string, qna: readonly QnA[]): string {
  return [
    "You are a clarify-reviewer for a planning workflow. Decide whether the",
    "goal's scope is clear enough to plan, given the answered clarifying",
    "questions below.",
    "",
    `Goal: ${goalDescription}`,
    "",
    "Q&A:",
    renderQnA(qna),
    "",
    "If the scope is clear and free of contradictions, set `clear: true` with",
    "empty `contradictions` and `newQuestions`. Otherwise set `clear: false`,",
    "list any `contradictions` you found, and propose `newQuestions` (each with",
    "a `question`, optional `context`, optional `suggestions`, optional",
    "`recommendation`) that must be answered before planning.",
    "",
    "You MUST call the `submit_clarify_review` tool exactly once. Do NOT write",
    "to any ledger or file. Do NOT ask the user anything directly.",
  ].join("\n");
}

export function buildPlannerPrompt(goalDescription: string, qna: readonly QnA[]): string {
  return [
    "You are a planner for a planning workflow. Given the clarified goal and",
    "the answered clarifying questions, produce milestones and tasks.",
    "",
    `Goal: ${goalDescription}`,
    "",
    "Q&A:",
    renderQnA(qna),
    "",
    "Return `milestones` (each `title` + `description`) and `tasks` (each with",
    "a `milestoneRef` = the zero-based index into your `milestones` array, a",
    "`headline`, a `description`, and an optional `acceptance` criterion).",
    "",
    "You MUST call the `submit_plan_doc` tool exactly once. Do NOT write to any",
    "ledger or file. Do NOT ask the user anything directly.",
  ].join("\n");
}

export interface PlanArtifacts {
  readonly milestones: ReadonlyArray<{ title: string; description: string }>;
  readonly tasks: ReadonlyArray<{
    milestone: string;
    headline: string;
    description: string;
    acceptance?: string;
  }>;
}

export function buildPlanReviewPrompt(
  goalDescription: string,
  qna: readonly QnA[],
  plan: PlanArtifacts,
  priorFindings: readonly PlanFinding[],
): string {
  const milestoneLines = plan.milestones.map((m, i) => `${i + 1}. ${m.title} — ${m.description}`).join("\n");
  const taskLines = plan.tasks
    .map(
      (t, i) =>
        `${i + 1}. [${t.milestone}] ${t.headline} — ${t.description}` +
        (t.acceptance !== undefined ? ` (acceptance: ${t.acceptance})` : ""),
    )
    .join("\n");
  const findingsBlock =
    priorFindings.length > 0
      ? [
          "",
          "Prior round findings the planner attempted to address:",
          priorFindings.map((f) => `- [${f.severity}] ${f.issue} → ${f.suggestion}`).join("\n"),
        ].join("\n")
      : "";
  return [
    "You are an adversarial plan-reviewer for a planning workflow. Find what is",
    "wrong with this plan: missing milestones, weak acceptance criteria, hidden",
    "assumptions, mis-sequenced work, scope the answered questions do not cover.",
    "",
    `Goal: ${goalDescription}`,
    "",
    "Q&A:",
    renderQnA(qna),
    "",
    "Milestones:",
    milestoneLines,
    "",
    "Tasks:",
    taskLines,
    findingsBlock,
    "",
    "If the plan adequately satisfies the goal and answered questions, set",
    "`satisfied: true` with empty `findings` and `newQuestions`. Otherwise set",
    "`satisfied: false`. If the plan needs more information from the user, put",
    "it in `newQuestions`; otherwise list concrete `findings` (each `severity`,",
    "`issue`, `suggestion`) for the planner to revise.",
    "",
    "You MUST call the `submit_plan_review` tool exactly once. Do NOT write to",
    "any ledger or file. Do NOT ask the user anything directly.",
  ].join("\n");
}
