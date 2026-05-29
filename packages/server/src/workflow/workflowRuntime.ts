/**
 * workflowRuntime.ts — deterministic engine behind `/plan` (cycle 3: full loop).
 *
 * Phase 1 (`startPlan`) produces a goal(clarifying) + the mandatory spec
 * milestone + a first question batch. Cycle 3 drives the rest:
 *
 *   Phase 2 — clarify loop (human-gated by answers).
 *     When the last open question for the goal flips to answered, dispatch the
 *     clarify-reviewer. Not clear / new questions → HARNESS writes the new
 *     questions under the spec milestone, emit questions_ready, wait. Clear →
 *     phase 3.
 *   Phase 3 — planner.
 *     Dispatch the planner with the clarified scope + Q&A. HARNESS writes the
 *     planner milestones (after the spec milestone) + tasks grouped under them,
 *     all linked to the goal. Goal status → planning.
 *   Phase 4 — plan-review loop (adversarial; no hard cap, Q6).
 *     Dispatch the plan-reviewer. satisfied → goal status planned + a `done`
 *     lifecycle frame. not satisfied + newQuestions → write them, emit
 *     questions_ready, wait; on answer re-run the clarify gate then re-plan.
 *     not satisfied + no questions → re-dispatch the planner with the findings.
 *     A NO-PROGRESS liveness guard escalates (and STOPS) if a revise round
 *     produces a structurally identical plan AND no new questions twice — so a
 *     reviewer↔planner runaway cannot spin without human input.
 *
 * Durable state = the LEDGERS (closes WF-D02). The workflow's position is a
 * pure function of goal.status + whether the goal's questions are all answered;
 * `reconcile()` resumes the right phase on startup. The only in-memory state is
 * the global busy slot (pool=1 for the workflow lane), the per-goal in-flight
 * latch (prevents double-dispatch / double-auto-advance), the per-goal review
 * fingerprint (no-progress guard), and the per-goal platform (Claude-only this
 * cycle; defaults to claude on resume).
 *
 * The HARNESS owns all ledger writes; producer and phase subagents only return
 * validated structured data via their harness-owned submit tools.
 */

import type { Logger } from "../log/logger";
import type { Item, LedgerStore } from "@cq/ledger";
import { GOALS_LEDGER, QUESTIONS_LEDGER } from "@cq/ledger";
import type { WorkflowEvent } from "@cq/shared";
import type { WorkflowProducer, ProducerOutput } from "./producer.js";
import {
  CLARIFY_REVIEW_SPEC,
  PLAN_SPEC,
  PLAN_REVIEW_SPEC,
  buildClarifyReviewPrompt,
  buildPlannerPrompt,
  buildPlanReviewPrompt,
  type PhaseSubagentSelector,
  type QnA,
  type PlanFinding,
  type PlanOutput,
} from "./phases.js";

/** The mandatory first milestone (Q11). Its deliverable is the converged Q&A + scope. */
export const SPEC_MILESTONE_TITLE = "produce an actionable specification" as const;

/** A sink for outbound lifecycle frames (server wires this to WS sessions). */
export type WorkflowEventSink = (event: Omit<WorkflowEvent, "seq" | "ts">) => void;

/** Selects the producer for a given platform (Q8). */
export type ProducerSelector = (platform: "claude" | "codex") => WorkflowProducer;

export interface WorkflowRuntimeOpts {
  logger: Logger;
  store: LedgerStore;
  /** Resolves a producer per platform (phase 1). */
  selectProducer: ProducerSelector;
  /** Resolves a phase subagent per platform (clarify/plan/review loops). */
  selectPhaseSubagent: PhaseSubagentSelector;
}

/** Input to a single `/plan <text>` (new-goal) run. */
export interface StartPlanInput {
  readonly text: string;
  readonly platform: "claude" | "codex";
}

/** A tracked active phase dispatch (pool=1 for the workflow lane). */
interface ActiveWorkflow {
  readonly workflowId: string;
  readonly abort: AbortController;
}

/** Result of the `/plan` entry point (for the caller / tests). */
export type StartPlanResult =
  | { readonly outcome: "questions_ready"; readonly workflowId: string; readonly goalId: string }
  | { readonly outcome: "busy"; readonly workflowId: string }
  | { readonly outcome: "errored"; readonly workflowId: string; readonly reason: string };

/**
 * The workflow position derived from the ledgers for one goal. Drives both
 * auto-advance (on the last answer) and startup reconcile.
 */
export type WorkflowPosition =
  | { kind: "terminal" } // goal done/abandoned/planned
  | { kind: "awaiting_answers" } // open questions remain — human-gated, sit idle
  | { kind: "clarify_ready" } // status=clarifying, all answered → run clarify-reviewer
  | { kind: "review_ready" }; // status=planning, all answered → run plan-reviewer

export class WorkflowRuntime {
  private readonly logger: Logger;
  private readonly store: LedgerStore;
  private readonly selectProducer: ProducerSelector;
  private readonly selectPhaseSubagent: PhaseSubagentSelector;

  /** Single active phase dispatch (Q D: pool=1 for the workflow lane). */
  private active: ActiveWorkflow | null = null;
  /** Lifecycle subscribers (all connected WS sessions). De-duped by identity. */
  private readonly subscribers = new Set<WorkflowEventSink>();
  /** Per-goal in-flight latch: true while a phase is dispatching for that goal. */
  private readonly inFlight = new Set<string>();
  /** Per-goal platform (Claude-only this cycle; defaults to claude on resume). */
  private readonly goalPlatform = new Map<string, "claude" | "codex">();
  /**
   * Per-goal no-progress fingerprint: the structural fingerprint of the LAST
   * planner output written during a no-questions revise round. If the next
   * such round produces an identical fingerprint, the loop has made no progress
   * → escalate.
   */
  private readonly lastReviseFingerprint = new Map<string, string>();
  /**
   * In-flight subprocess-teardown awaitables. Each producer/phase dispatch
   * registers a promise that resolves when its underlying SDK `query()`
   * subprocess is fully reaped (its async generator returned after `close()`).
   * The promise self-removes on settle. `whenDrained()` awaits a snapshot so a
   * caller can block until no workflow subprocess is still being torn down.
   * Used by graceful shutdown and E2E teardown; never gates production logic.
   */
  private readonly pendingTeardowns = new Set<Promise<void>>();

  constructor(opts: WorkflowRuntimeOpts) {
    this.logger = opts.logger;
    this.store = opts.store;
    this.selectProducer = opts.selectProducer;
    this.selectPhaseSubagent = opts.selectPhaseSubagent;
  }

  /** True iff a workflow phase is currently dispatching. */
  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Register a subprocess-teardown awaitable from a producer/phase dispatch.
   * The promise resolves when that dispatch's SDK subprocess is fully reaped;
   * it self-removes from the pending set on settle. Passed into each dispatch
   * as `registerTeardown`.
   */
  private readonly trackTeardown = (settled: Promise<void>): void => {
    this.pendingTeardowns.add(settled);
    void settled.finally(() => {
      this.pendingTeardowns.delete(settled);
    });
  };

  /**
   * Resolve when the workflow lane is fully quiescent: no phase is dispatching
   * AND every spawned SDK subprocess has been reaped. Unlike `isBusy()` (which
   * clears at submit-time, before `query().close()` finishes reaping the child),
   * this awaits actual subprocess exit. Re-checks after each await because a
   * phase may chain another dispatch (clarify→plan→review run in one slot).
   * Uniform-async: always returns `Promise<void>`, never a sync/async union.
   * For graceful shutdown and E2E teardown; does not gate production logic.
   */
  async whenDrained(): Promise<void> {
    // Bound the loop: each iteration must make progress (the pending set shrinks
    // or the active slot frees). A spinning loop would indicate a teardown that
    // never settles — fail loud rather than hang silently.
    const MAX_ROUNDS = 1_000;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const snapshot = [...this.pendingTeardowns];
      if (snapshot.length === 0 && this.active === null) return;
      if (snapshot.length > 0) {
        await Promise.allSettled(snapshot);
        continue;
      }
      // No teardowns pending but a phase is still dispatching — yield and re-poll
      // so a teardown registered by the in-flight dispatch gets captured.
      await new Promise<void>((res) => setTimeout(res, 25));
    }
    throw new Error("whenDrained: workflow lane did not quiesce within bound");
  }

  /** Register a lifecycle sink (called by each WsSession on open). */
  subscribe(sink: WorkflowEventSink): void {
    this.subscribers.add(sink);
  }

  /** Unregister a lifecycle sink (called by each WsSession on close). */
  unsubscribe(sink: WorkflowEventSink): void {
    this.subscribers.delete(sink);
  }

  /** Fan a lifecycle frame out to every subscriber. */
  private emitAll(event: Omit<WorkflowEvent, "seq" | "ts">): void {
    for (const sink of this.subscribers) {
      try {
        sink(event);
      } catch (err: unknown) {
        this.logger.warn("workflow.emit_error", { err: String(err) });
      }
    }
  }

  /**
   * Abort the active phase dispatch (if any). Fire-and-forget; the subagent's
   * AbortController is signalled so its headless query closes and the run
   * rejects. Used by graceful shutdown and the E2E teardown hook. No-op idle.
   */
  abortActive(): void {
    if (this.active === null) return;
    this.logger.info("workflow.abort_active", { workflowId: this.active.workflowId });
    this.active.abort.abort();
  }

  /**
   * `/plan G<id> <text>` continuation — not implemented this cycle (Q9/Q10).
   */
  startContinuation(goalRef: string, emit: WorkflowEventSink): StartPlanResult {
    this.subscribe(emit);
    const workflowId = crypto.randomUUID();
    const reason = `continuation of ${goalRef} is not implemented yet`;
    this.emitAll({ type: "workflow.event", workflowId, phase: "produce", status: "errored", detail: reason });
    this.logger.info("workflow.continuation_not_implemented", { workflowId, goalRef });
    return { outcome: "errored", workflowId, reason };
  }

  /**
   * Run a new-goal `/plan <text>` workflow to phase-1 completion (goal +
   * spec milestone + first question batch). The clarify loop is human-gated:
   * it advances when the user answers via `submitAnswer`.
   */
  async startPlan(input: StartPlanInput, emit: WorkflowEventSink): Promise<StartPlanResult> {
    this.subscribe(emit);
    const workflowId = crypto.randomUUID();

    if (this.active !== null) {
      const reason = "a planning workflow is already running; wait for it to finish";
      this.emitAll({ type: "workflow.event", workflowId, phase: "produce", status: "errored", detail: reason });
      this.logger.info("workflow.busy_rejected", { workflowId, active: this.active.workflowId });
      return { outcome: "busy", workflowId };
    }

    const abort = new AbortController();
    this.active = { workflowId, abort };
    this.emitAll({ type: "workflow.event", workflowId, phase: "produce", status: "started" });
    this.logger.info("workflow.started", { workflowId, platform: input.platform });

    try {
      this.emitAll({ type: "workflow.event", workflowId, phase: "produce", status: "producing" });
      const producer = this.selectProducer(input.platform);
      const output = await producer.produce({
        text: input.text,
        signal: abort.signal,
        registerTeardown: this.trackTeardown,
      });
      const goalId = await this.writeArtifacts(output);
      this.goalPlatform.set(goalId, input.platform);

      this.emitAll({
        type: "workflow.event",
        workflowId,
        goalId,
        phase: "produce",
        status: "questions_ready",
        detail: `${output.questions.length} question${output.questions.length === 1 ? "" : "s"} ready in the Goals tab`,
      });
      this.logger.info("workflow.questions_ready", { workflowId, goalId, questionCount: output.questions.length });
      return { outcome: "questions_ready", workflowId, goalId };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.emitAll({ type: "workflow.event", workflowId, phase: "produce", status: "errored", detail: reason });
      this.logger.warn("workflow.errored", { workflowId, reason });
      return { outcome: "errored", workflowId, reason };
    } finally {
      if (this.active?.workflowId === workflowId) this.active = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────── //
  // Answer submission + auto-advance (Q5).
  // ─────────────────────────────────────────────────────────────────────── //

  /**
   * Write a user's answer into the questions ledger (status open→answered) and,
   * if it was the LAST open question for that goal's current batch, AUTO-ADVANCE
   * the relevant loop exactly once. Idempotent against an already-answered
   * question (no re-advance). Returns the affected goalId (or null if the
   * question does not resolve to a goal).
   */
  async submitAnswer(questionId: string, answer: string): Promise<string | null> {
    const question = this.store.fetchItem(QUESTIONS_LEDGER, questionId);
    const goalId = this.resolveGoalForQuestion(questionId);
    // Only the open→answered transition matters; an answer to an already-
    // answered question is a no-op for auto-advance.
    const wasOpen = question.status === "open";
    if (wasOpen) {
      await this.store.updateItem(QUESTIONS_LEDGER, questionId, {
        status: "answered",
        fields: { ...question.fields, answer },
      });
    }
    if (goalId === null) return null;

    // Auto-advance only when THIS answer took the goal's open-question count to
    // zero and a phase is not already in flight for it.
    if (wasOpen && this.openQuestionCount(goalId) === 0) {
      void this.advanceGoal(goalId).catch((err: unknown) => {
        this.logger.warn("workflow.advance_error", { goalId, err: String(err) });
      });
    }
    return goalId;
  }

  // ─────────────────────────────────────────────────────────────────────── //
  // Resume-on-startup reconcile (closes WF-D02).
  // ─────────────────────────────────────────────────────────────────────── //

  /**
   * Resume any goal whose ledger position needs a phase dispatch. Called once
   * after `store.init()`. Goals waiting on open questions sit idle until a
   * `question.answer` arrives. Idempotent: the in-flight latch + busy slot
   * prevent double-dispatch if reconcile races a live answer.
   */
  async reconcile(): Promise<void> {
    const goals = this.goalIds();
    for (const goalId of goals) {
      const pos = this.derivePosition(goalId);
      if (pos.kind === "clarify_ready" || pos.kind === "review_ready") {
        this.logger.info("workflow.reconcile_resume", { goalId, position: pos.kind });
        await this.advanceGoal(goalId).catch((err: unknown) => {
          this.logger.warn("workflow.reconcile_error", { goalId, err: String(err) });
        });
      }
    }
  }

  /**
   * Derive the workflow position for one goal purely from the ledgers.
   */
  derivePosition(goalId: string): WorkflowPosition {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    if (goal.status === "planned" || goal.status === "done" || goal.status === "abandoned") {
      return { kind: "terminal" };
    }
    if (this.openQuestionCount(goalId) > 0) return { kind: "awaiting_answers" };
    if (goal.status === "clarifying") return { kind: "clarify_ready" };
    if (goal.status === "planning") return { kind: "review_ready" };
    // building or any other non-terminal status with no open questions: idle.
    return { kind: "awaiting_answers" };
  }

  // ─────────────────────────────────────────────────────────────────────── //
  // The phase driver.
  // ─────────────────────────────────────────────────────────────────────── //

  /**
   * Dispatch the next phase for a goal based on its derived position. Guards:
   *  - the per-goal in-flight latch prevents double-dispatch / double-advance;
   *  - the global busy slot enforces pool=1 across the workflow lane.
   */
  private async advanceGoal(goalId: string): Promise<void> {
    if (this.inFlight.has(goalId)) {
      this.logger.info("workflow.advance_skipped_inflight", { goalId });
      return;
    }
    const pos = this.derivePosition(goalId);
    if (pos.kind === "terminal" || pos.kind === "awaiting_answers") return;

    if (this.active !== null) {
      this.logger.info("workflow.advance_skipped_busy", { goalId, active: this.active.workflowId });
      return;
    }

    this.inFlight.add(goalId);
    const workflowId = crypto.randomUUID();
    const abort = new AbortController();
    this.active = { workflowId, abort };
    try {
      if (pos.kind === "clarify_ready") {
        await this.runClarifyReview(goalId, workflowId, abort.signal);
      } else {
        await this.runPlanReview(goalId, workflowId, abort.signal);
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "review", status: "errored", detail: reason });
      this.logger.warn("workflow.phase_errored", { goalId, workflowId, reason });
    } finally {
      this.inFlight.delete(goalId);
      if (this.active?.workflowId === workflowId) this.active = null;
    }
  }

  /** Phase 2: clarify-reviewer. Clear → planner; otherwise write new questions. */
  private async runClarifyReview(goalId: string, workflowId: string, signal: AbortSignal): Promise<void> {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const desc = String(goal.fields["description"] ?? "");
    this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "clarify", status: "clarifying", detail: "reviewing answers" });

    const subagent = this.selectPhaseSubagent(this.platformFor(goalId));
    const out = await subagent.dispatch(CLARIFY_REVIEW_SPEC, {
      prompt: buildClarifyReviewPrompt(desc, this.qnaFor(goalId)),
      signal,
      registerTeardown: this.trackTeardown,
    });

    if (!out.clear || out.newQuestions.length > 0) {
      const specId = this.specMilestoneId(goalId);
      for (const q of out.newQuestions) {
        await this.writeQuestion(specId, q);
      }
      this.emitAll({
        type: "workflow.event",
        workflowId,
        goalId,
        phase: "clarify",
        status: "questions_ready",
        detail: `${out.newQuestions.length} more question${out.newQuestions.length === 1 ? "" : "s"} ready in the Goals tab`,
      });
      return;
    }
    // Clear → advance to the planner (still within this dispatch slot).
    await this.runPlanner(goalId, workflowId, signal);
  }

  /** Phase 3: planner. Writes planner milestones + tasks; goal → planning. */
  private async runPlanner(goalId: string, workflowId: string, signal: AbortSignal): Promise<void> {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const desc = String(goal.fields["description"] ?? "");
    this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "plan", status: "planning", detail: "drafting milestones and tasks" });

    const subagent = this.selectPhaseSubagent(this.platformFor(goalId));
    const plan = await subagent.dispatch(PLAN_SPEC, {
      prompt: buildPlannerPrompt(desc, this.qnaFor(goalId)),
      signal,
      registerTeardown: this.trackTeardown,
    });

    await this.writePlan(goalId, plan);
    // Reset the no-progress fingerprint for a fresh review loop.
    this.lastReviseFingerprint.delete(goalId);
    // Proceed straight into the plan-review loop within this dispatch slot.
    await this.runPlanReview(goalId, workflowId, signal);
  }

  /**
   * Phase 4: plan-reviewer loop. satisfied → planned + done. not satisfied +
   * newQuestions → write + wait (clarify gate re-runs on answer). not satisfied
   * + no questions → re-plan, with a no-progress guard that escalates on an
   * identical revise round.
   */
  private async runPlanReview(goalId: string, workflowId: string, signal: AbortSignal): Promise<void> {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const desc = String(goal.fields["description"] ?? "");
    this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "review", status: "reviewing", detail: "reviewing the plan" });

    const subagent = this.selectPhaseSubagent(this.platformFor(goalId));
    const review = await subagent.dispatch(PLAN_REVIEW_SPEC, {
      // The reviewer sees the current plan; prior findings (if any) were already
      // folded into the planner prompt on the preceding revise round.
      prompt: buildPlanReviewPrompt(desc, this.qnaFor(goalId), this.planArtifacts(goalId), []),
      signal,
      registerTeardown: this.trackTeardown,
    });

    if (review.satisfied) {
      await this.store.updateItem(GOALS_LEDGER, goalId, { status: "planned" });
      this.lastReviseFingerprint.delete(goalId);
      this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "review", status: "planned", detail: "plan ready" });
      this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "review", status: "done", detail: "planning complete" });
      return;
    }

    if (review.newQuestions.length > 0) {
      const specId = this.specMilestoneId(goalId);
      for (const q of review.newQuestions) {
        await this.writeQuestion(specId, q);
      }
      // Reopening scope re-enters the CLARIFY gate: moving the goal back to
      // `clarifying` means the next answer batch is re-validated for clarity
      // before re-planning (K-WFL-4 — the clarity gate is never bypassed).
      await this.store.updateItem(GOALS_LEDGER, goalId, { status: "clarifying" });
      this.lastReviseFingerprint.delete(goalId);
      this.emitAll({
        type: "workflow.event",
        workflowId,
        goalId,
        phase: "review",
        status: "questions_ready",
        detail: `${review.newQuestions.length} more question${review.newQuestions.length === 1 ? "" : "s"} ready in the Goals tab`,
      });
      return;
    }

    // not satisfied + no questions → re-plan with the findings. No-progress
    // guard: if a revise round produces a structurally identical plan to the
    // prior revise round, STOP and escalate (liveness backstop, not a cap).
    await this.revisePlanWithGuard(goalId, workflowId, signal, review.findings);
  }

  /**
   * Re-dispatch the planner with the reviewer's findings, then either loop the
   * review or escalate if the plan did not change since the last revise round.
   */
  private async revisePlanWithGuard(
    goalId: string,
    workflowId: string,
    signal: AbortSignal,
    findings: readonly PlanFinding[],
  ): Promise<void> {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const desc = String(goal.fields["description"] ?? "");
    this.emitAll({ type: "workflow.event", workflowId, goalId, phase: "plan", status: "planning", detail: "revising the plan" });

    const subagent = this.selectPhaseSubagent(this.platformFor(goalId));
    const plan = await subagent.dispatch(PLAN_SPEC, {
      prompt: buildPlannerPrompt(desc, this.qnaFor(goalId)) + this.findingsAddendum(findings),
      signal,
      registerTeardown: this.trackTeardown,
    });

    const fingerprint = this.fingerprintPlan(plan);
    const prior = this.lastReviseFingerprint.get(goalId);
    if (prior !== undefined && prior === fingerprint) {
      // No delta + (the reviewer already raised no questions) → non-progress.
      this.emitAll({
        type: "workflow.event",
        workflowId,
        goalId,
        phase: "review",
        status: "escalated",
        detail:
          "the plan-review loop made no progress (identical revision, no new questions). " +
          "Choose: proceed-as-is, give-guidance, or abandon.",
      });
      this.logger.warn("workflow.no_progress_escalated", { goalId, workflowId });
      return;
    }
    this.lastReviseFingerprint.set(goalId, fingerprint);

    await this.writePlan(goalId, plan);
    // Re-run the reviewer against the revised plan.
    await this.runPlanReview(goalId, workflowId, signal);
  }

  // ─────────────────────────────────────────────────────────────────────── //
  // Ledger writes (HARNESS-owned). Phase 1 + loop phases.
  // ─────────────────────────────────────────────────────────────────────── //

  /**
   * Phase 1 write: goal + spec milestone + questions. Ordering chosen so no
   * half-written state is observable on a mid-write failure (spec → goal →
   * questions → link). Returns the goal id.
   */
  private async writeArtifacts(output: ProducerOutput): Promise<string> {
    const specMilestone = await this.store.createMilestone({
      title: SPEC_MILESTONE_TITLE,
      description:
        "The clarified scope + answered clarifying questions are this milestone's deliverable (Q11).",
    });
    const specId = specMilestone.id;

    const goalItem = await this.store.createItem(GOALS_LEDGER, specId, {
      status: "clarifying",
      fields: { description: output.goal.description },
    });
    const goalId = goalItem.id;

    for (const q of output.questions) {
      await this.writeQuestion(specId, q);
    }

    await this.store.updateItem(GOALS_LEDGER, goalId, { fields: { milestones: [specId] } });
    return goalId;
  }

  /** Write one question row (status open) under a milestone. */
  private async writeQuestion(
    milestoneId: string,
    q: {
      question: string;
      context?: string | undefined;
      suggestions?: string[] | undefined;
      recommendation?: string | undefined;
    },
  ): Promise<void> {
    const fields: Record<string, string | string[]> = { question: q.question };
    if (q.context !== undefined) fields["context"] = q.context;
    if (q.suggestions !== undefined) fields["suggestions"] = q.suggestions;
    if (q.recommendation !== undefined) fields["recommendation"] = q.recommendation;
    await this.store.createItem(QUESTIONS_LEDGER, milestoneId, { status: "open", fields });
  }

  /**
   * Write a planner output: create the planner milestones (after the spec
   * milestone), create the tasks grouped under their referenced milestone, link
   * all milestones to the goal, set goal status → planning.
   *
   * Re-planning replaces the prior planner milestones+tasks: the spec milestone
   * (goal.milestones[0]) is preserved; later planner milestones are archived?
   * No — archiving requires terminal items. Instead we append a fresh set and
   * relink the goal to [spec, ...new]; the prior planner milestones become
   * detached from the goal's milestone list (still in the ledger, unreferenced).
   * Tasks are always written under the freshly-created milestones, so the
   * goal's view is always the latest plan. (Cycle-4 may add a tidy-up pass.)
   */
  private async writePlan(goalId: string, plan: PlanOutput): Promise<void> {
    const specId = this.specMilestoneId(goalId);
    const milestoneIds: string[] = [];
    for (const m of plan.milestones) {
      const created = await this.store.createMilestone({ title: m.title, description: m.description });
      milestoneIds.push(created.id);
    }
    for (const t of plan.tasks) {
      const idx = Math.min(t.milestoneRef, milestoneIds.length - 1);
      const mId = milestoneIds[idx]!;
      const fields: Record<string, string | string[]> = { headline: t.headline, description: t.description };
      if (t.acceptance !== undefined) fields["acceptance"] = t.acceptance;
      await this.store.createItem("tasks", mId, { status: "planned", fields });
    }
    await this.store.updateItem(GOALS_LEDGER, goalId, {
      status: "planning",
      fields: { milestones: [specId, ...milestoneIds] },
    });
  }

  // ─────────────────────────────────────────────────────────────────────── //
  // Ledger-derived helpers.
  // ─────────────────────────────────────────────────────────────────────── //

  private goalIds(): string[] {
    return this.store
      .fetch(GOALS_LEDGER)
      .milestones.flatMap((g) => g.items)
      .map((i) => i.id);
  }

  /** The spec milestone id for a goal = goal.milestones[0] (always present). */
  private specMilestoneId(goalId: string): string {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const ms = goal.fields["milestones"];
    if (!Array.isArray(ms) || ms.length === 0) {
      throw new Error(`goal ${goalId} has no spec milestone linked`);
    }
    return ms[0]!;
  }

  /** All question items belonging to a goal (under any of its milestones). */
  private questionsFor(goalId: string): Item[] {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const ms = Array.isArray(goal.fields["milestones"]) ? (goal.fields["milestones"] as string[]) : [];
    const out: Item[] = [];
    for (const mId of ms) {
      const grouped = this.store.listMilestoneItems(mId)[QUESTIONS_LEDGER] ?? [];
      out.push(...grouped);
    }
    return out;
  }

  private openQuestionCount(goalId: string): number {
    return this.questionsFor(goalId).filter((q) => q.status === "open").length;
  }

  /** Assemble the goal's Q&A for a reviewer/planner prompt. */
  private qnaFor(goalId: string): QnA[] {
    return this.questionsFor(goalId).map((q) => {
      const qna: QnA = { question: String(q.fields["question"] ?? "") };
      const ctx = q.fields["context"];
      if (typeof ctx === "string") (qna as { context?: string }).context = ctx;
      const ans = q.fields["answer"];
      if (typeof ans === "string") (qna as { answer?: string }).answer = ans;
      return qna;
    });
  }

  /** The goal's current plan artefacts (latest milestones + tasks) for review. */
  private planArtifacts(goalId: string): {
    milestones: Array<{ title: string; description: string }>;
    tasks: Array<{ milestone: string; headline: string; description: string; acceptance?: string }>;
  } {
    const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
    const ms = Array.isArray(goal.fields["milestones"]) ? (goal.fields["milestones"] as string[]) : [];
    // The planner milestones follow the spec milestone (index 0).
    const plannerMilestoneIds = ms.slice(1);
    const milestones: Array<{ title: string; description: string }> = [];
    const tasks: Array<{ milestone: string; headline: string; description: string; acceptance?: string }> = [];
    for (const mId of plannerMilestoneIds) {
      const fetched = this.store.fetchMilestone(mId);
      milestones.push({ title: fetched.resolved.title, description: fetched.resolved.description });
      const tItems = this.store.listMilestoneItems(mId)["tasks"] ?? [];
      for (const t of tItems) {
        const task: { milestone: string; headline: string; description: string; acceptance?: string } = {
          milestone: fetched.resolved.title,
          headline: String(t.fields["headline"] ?? ""),
          description: String(t.fields["description"] ?? ""),
        };
        const acc = t.fields["acceptance"];
        if (typeof acc === "string") task.acceptance = acc;
        tasks.push(task);
      }
    }
    return { milestones, tasks };
  }

  /**
   * The no-progress fingerprint of a planner output: an order-sensitive
   * serialization of milestone titles+descriptions and task headline/desc/
   * acceptance/ref. Two planner outputs with the same fingerprint are
   * structurally identical → no progress.
   */
  private fingerprintPlan(plan: PlanOutput): string {
    const m = plan.milestones.map((x) => `${x.title} ${x.description}`).join("");
    const t = plan.tasks
      .map((x) => `${x.milestoneRef} ${x.headline} ${x.description} ${x.acceptance ?? ""}`)
      .join("");
    return `${m}${t}`;
  }

  /** Resolve the goal that owns a question (the goal whose milestones include the question's group). */
  private resolveGoalForQuestion(questionId: string): string | null {
    const question = this.store.fetchItem(QUESTIONS_LEDGER, questionId);
    const milestoneId = question.milestoneId;
    for (const goalId of this.goalIds()) {
      const goal = this.store.fetchItem(GOALS_LEDGER, goalId);
      const ms = Array.isArray(goal.fields["milestones"]) ? (goal.fields["milestones"] as string[]) : [];
      if (ms.includes(milestoneId)) return goalId;
    }
    return null;
  }

  private platformFor(goalId: string): "claude" | "codex" {
    return this.goalPlatform.get(goalId) ?? "claude";
  }

  private findingsAddendum(findings: readonly PlanFinding[]): string {
    if (findings.length === 0) return "";
    return (
      "\n\nThe prior plan-review raised these findings — revise to address them:\n" +
      findings.map((f) => `- [${f.severity}] ${f.issue} → ${f.suggestion}`).join("\n")
    );
  }
}
