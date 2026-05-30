/**
 * commandRegistry.ts — tiny extensible slash-command registry (Q9).
 *
 * The client routes a leading `/plan …` input line to a `workflow.start`
 * frame rather than `chat.input`. The server-side registry parses that
 * frame's `kind` + `text` into a typed command and routes it to the
 * WorkflowRuntime. `/plan` is the only command this cycle; the registry is
 * extensible for future commands (`/build`, …) without touching callers.
 *
 * Parsing is pure and total: it never throws. A malformed `/plan` line maps
 * to a `{ kind: "malformed" }` result the caller surfaces as a lifecycle
 * error.
 *
 * Continuation semantics (Q9/Q10): `/plan G<id> <text>` parses to a
 * `plan_continue` command. The WorkflowRuntime's `continueGoal` appends an
 * increment to the referenced goal (gating on goal state — the registry only
 * classifies; it does not validate the goal exists or its status).
 */

/** A new-goal `/plan <text>` command. */
export interface PlanNewCommand {
  readonly kind: "plan_new";
  readonly text: string;
}

/** A continuation `/plan G<id> <text>` command. */
export interface PlanContinueCommand {
  readonly kind: "plan_continue";
  readonly goalRef: string;
  readonly text: string;
}

/** A `/plan` line that could not be parsed (empty text, etc.). */
export interface MalformedCommand {
  readonly kind: "malformed";
  readonly reason: string;
}

export type ParsedCommand = PlanNewCommand | PlanContinueCommand | MalformedCommand;

/**
 * Matches a goal reference token: `G` followed by one or more digits
 * (the goals ledger idPrefix is `G`). Anchored so a leading token that
 * merely starts with `G` (e.g. "Goal") is NOT treated as a goalRef.
 */
const GOAL_REF_RE = /^G\d+$/;

/**
 * Parse the `text` payload of a `workflow.start{kind:"plan"}` frame into a
 * typed command. `goalRef` is the optional frame field — when present the
 * client already split the `G<id>` token off the input; when absent we still
 * inspect the leading token of `text` so a hand-built frame (or a client that
 * does not pre-split) is classified correctly.
 *
 * Rules:
 *  - Empty / whitespace-only text with no goalRef → malformed.
 *  - goalRef present and well-formed (`^G\d+$`) → plan_continue.
 *  - goalRef present but malformed → malformed.
 *  - No goalRef but leading token matches `^G\d+$` → plan_continue (token
 *    consumed as the ref; remainder is the text).
 *  - Otherwise → plan_new with the full trimmed text.
 */
export function parsePlanCommand(text: string, goalRef?: string): ParsedCommand {
  const trimmed = text.trim();

  if (goalRef !== undefined) {
    if (!GOAL_REF_RE.test(goalRef)) {
      return { kind: "malformed", reason: `invalid goal reference "${goalRef}" (expected G<number>)` };
    }
    if (trimmed.length === 0) {
      return { kind: "malformed", reason: "continuation requires descriptive text after the goal reference" };
    }
    return { kind: "plan_continue", goalRef, text: trimmed };
  }

  if (trimmed.length === 0) {
    return { kind: "malformed", reason: "/plan requires a goal description" };
  }

  // No explicit goalRef: inspect the leading token for an inline `G<id>`.
  const spaceIdx = trimmed.indexOf(" ");
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  if (GOAL_REF_RE.test(firstToken)) {
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    if (rest.length === 0) {
      return { kind: "malformed", reason: "continuation requires descriptive text after the goal reference" };
    }
    return { kind: "plan_continue", goalRef: firstToken, text: rest };
  }

  return { kind: "plan_new", text: trimmed };
}
