/**
 * workflowHistory.ts — the persistence recorder for `/plan` workflow runs
 * (wfhist-3 / wfhist-4).
 *
 * A `/plan` run becomes its OWN History entry: a workflow-`kind` session + a
 * root `main` invocation, with one CHILD invocation per phase dispatch
 * (producer, each clarify/planner/review/revise round, continuation). All rows
 * are written DIRECTLY through the `Persistence` adapter — this recorder NEVER
 * touches the interactive `Bridge` / `SessionRegistry`, so the pool=1
 * interactive-chat invariant holds by construction.
 *
 * The recorder is the single place that knows the row shapes, so the
 * WorkflowRuntime body stays free of persistence detail and tests can drive it
 * against either persistence adapter.
 */

import type { InvocationRow, SessionRow } from "@cq/shared";
import type { Persistence } from "../persist/Persistence.js";
import type { Logger } from "../log/logger.js";
import type { PhaseUsage } from "./producer.js";

/** A handle to an in-flight workflow run's session + root invocation. */
export interface WorkflowRunHandle {
  readonly sessionId: string;
  readonly rootInvocationId: string;
}

/** A handle to one in-flight phase child invocation under a run. */
export interface PhaseInvocationHandle {
  readonly invocationId: string;
}

/** Terminal disposition of a workflow run's root invocation + session. */
export type RunSettle = "completed" | "failed";

/**
 * Records `/plan` workflow activity into the History tables. Optional in the
 * runtime: when persistence is absent (legacy callers / some tests) every method
 * is a no-op via the `NullWorkflowHistoryRecorder`.
 */
export interface WorkflowHistoryRecorder {
  /**
   * Begin a run: insert a workflow-`kind` session + a running root `main`
   * invocation. `title` is a placeholder (the user's `/plan` text) until the
   * goal title is known (see `linkGoal`).
   */
  startRun(opts: {
    workflowId: string;
    platform: "claude" | "codex";
    model: string;
    title: string;
  }): WorkflowRunHandle;

  /**
   * Bind a run to its goal once known: persist the goalId → (session, root) link
   * and update the session title to the goal title. Idempotent on title.
   */
  linkGoal(handle: WorkflowRunHandle, goalId: string, title: string): void;

  /**
   * Resume the run for an existing goal (continuation / reconcile after a
   * restart): returns the SAME session + root if a link exists, else undefined
   * (caller then starts a fresh run and links it).
   */
  resumeRun(goalId: string): WorkflowRunHandle | undefined;

  /** Insert a running CHILD invocation for a phase dispatch under the run root. */
  startPhase(handle: WorkflowRunHandle, agentName: string, model: string): PhaseInvocationHandle;

  /** Record usage captured from the phase's SDK `result` onto its child row. */
  recordPhaseUsage(phase: PhaseInvocationHandle, usage: PhaseUsage): void;

  /** Settle a phase child: completed or failed, with end time + duration. */
  settlePhase(phase: PhaseInvocationHandle, status: RunSettle): void;

  /** Settle the run's root invocation + close the session. */
  settleRun(handle: WorkflowRunHandle, status: RunSettle, endedReason: string): void;
}

const PLACEHOLDER_MODEL = "" as const;

/** No-op recorder used when the runtime has no persistence wired. */
export class NullWorkflowHistoryRecorder implements WorkflowHistoryRecorder {
  startRun(): WorkflowRunHandle {
    return { sessionId: "", rootInvocationId: "" };
  }
  linkGoal(): void {}
  resumeRun(): WorkflowRunHandle | undefined {
    return undefined;
  }
  startPhase(): PhaseInvocationHandle {
    return { invocationId: "" };
  }
  recordPhaseUsage(): void {}
  settlePhase(): void {}
  settleRun(): void {}
}

/** Persistence-backed recorder. */
export class PersistentWorkflowHistoryRecorder implements WorkflowHistoryRecorder {
  constructor(
    private readonly persistence: Persistence,
    private readonly cwd: string,
    private readonly logger: Logger,
  ) {}

  startRun(opts: {
    workflowId: string;
    platform: "claude" | "codex";
    model: string;
    title: string;
  }): WorkflowRunHandle {
    const sessionId = crypto.randomUUID();
    const rootInvocationId = crypto.randomUUID();
    const now = Date.now();
    const session: SessionRow = {
      id: sessionId,
      startedAt: now,
      endedAt: null,
      cwd: this.cwd,
      model: opts.model,
      permissionMode: "default",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: null,
      title: opts.title,
      lastServerSeq: 0,
      sdkSessionId: null,
      platform: opts.platform,
      effort: "none",
      approvalPolicy: null,
      kind: "workflow",
    };
    const root: InvocationRow = {
      id: rootInvocationId,
      sessionId,
      parentInvocationId: null,
      resumedFromInvocationId: null,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: opts.model,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      status: "running",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      // The `/plan` command line is the root's prompt excerpt (the History list
      // shows the session title; this keeps the FTS index useful for plan runs).
      promptExcerpt: opts.title.slice(0, 500),
      eventLogPath: `${sessionId}/${rootInvocationId}.jsonl`,
      ownerPid: process.pid,
    };
    this.persistence.withTx(() => {
      this.persistence.sessions.insert(session);
      this.persistence.invocations.insert(root);
    });
    this.logger.info("workflow.history.run_started", { sessionId, rootInvocationId });
    return { sessionId, rootInvocationId };
  }

  linkGoal(handle: WorkflowRunHandle, goalId: string, title: string): void {
    this.persistence.withTx(() => {
      this.persistence.workflowSessions.link({
        goalId,
        sessionId: handle.sessionId,
        rootInvocationId: handle.rootInvocationId,
      });
      this.persistence.sessions.update(handle.sessionId, { title });
    });
  }

  resumeRun(goalId: string): WorkflowRunHandle | undefined {
    const link = this.persistence.workflowSessions.getByGoal(goalId);
    if (link === undefined) return undefined;
    // Re-open the session row (it was closed when the prior phase settled) so the
    // resumed run's child rows attach to a live, open session.
    this.persistence.sessions.update(link.sessionId, { endedAt: null, endedReason: null });
    this.persistence.invocations.update(link.rootInvocationId, {
      status: "running",
      endedAt: null,
      durationMs: null,
    });
    return { sessionId: link.sessionId, rootInvocationId: link.rootInvocationId };
  }

  startPhase(handle: WorkflowRunHandle, agentName: string, model: string): PhaseInvocationHandle {
    const invocationId = crypto.randomUUID();
    const now = Date.now();
    const row: InvocationRow = {
      id: invocationId,
      sessionId: handle.sessionId,
      parentInvocationId: handle.rootInvocationId,
      resumedFromInvocationId: null,
      agentName,
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: model === "" ? PLACEHOLDER_MODEL : model,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      status: "running",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: agentName,
      eventLogPath: `${handle.sessionId}/${invocationId}.jsonl`,
      ownerPid: process.pid,
    };
    this.persistence.invocations.insert(row);
    return { invocationId };
  }

  recordPhaseUsage(phase: PhaseInvocationHandle, usage: PhaseUsage): void {
    const patch: Partial<InvocationRow> = {
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    // A usage `result` carries the model that actually ran; prefer it over the
    // placeholder model recorded at startPhase when it is non-empty.
    if (usage.model !== "") patch.model = usage.model;
    this.persistence.invocations.update(phase.invocationId, patch);
  }

  settlePhase(phase: PhaseInvocationHandle, status: RunSettle): void {
    const existing = this.persistence.invocations.get(phase.invocationId);
    const now = Date.now();
    const startedAt = existing?.startedAt ?? now;
    this.persistence.invocations.update(phase.invocationId, {
      status: status === "completed" ? "completed" : "failed",
      endedAt: now,
      durationMs: now - startedAt,
    });
  }

  settleRun(handle: WorkflowRunHandle, status: RunSettle, endedReason: string): void {
    const existing = this.persistence.invocations.get(handle.rootInvocationId);
    const now = Date.now();
    const startedAt = existing?.startedAt ?? now;
    this.persistence.withTx(() => {
      this.persistence.invocations.update(handle.rootInvocationId, {
        status: status === "completed" ? "completed" : "failed",
        endedAt: now,
        durationMs: now - startedAt,
      });
      this.persistence.sessions.update(handle.sessionId, { endedAt: now, endedReason });
    });
  }
}
