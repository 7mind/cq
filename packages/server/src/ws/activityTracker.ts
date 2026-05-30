/**
 * activityTracker.ts — server-side AGGREGATE compute-activity tracker (ACTIVITY-01).
 *
 * The top-bar badge must reflect ALL active compute, not just the interactive
 * chat session. There are two independent compute lanes:
 *
 *   1. the interactive chat Bridge (pool=1) — `bridge.isBusy()` is 1 while a
 *      turn is streaming;
 *   2. the `/plan` WorkflowRuntime — `workflow.activeDispatchCount()` counts the
 *      phase dispatches (producer / clarify-reviewer / planner / plan-reviewer)
 *      actively computing right now.
 *
 * `running = (chat busy ? 1 : 0) + workflow active-dispatch count`. A workflow
 * PARKED waiting for the user to answer questions is NOT computing (no dispatch
 * in flight) and contributes 0.
 *
 * The tracker is OBSERVE-ONLY: it reads the two lanes' busy signals through
 * injected functions and is notified of every transition via the lanes' own
 * change callbacks (`Bridge.onBusyChange`, `WorkflowRuntime.onActivityChange`).
 * It never routes the workflow through the Bridge and never changes pool=1.
 *
 * Each subscriber (one per WS connection) is pushed the CURRENT value once on
 * subscribe (initial state on connect) and again on every change.
 */

/** A sink receiving the aggregate `running` count. */
export type ActivitySink = (running: number) => void;

/** The aggregate activity tracker surface (interface + impl pattern). */
export interface ActivityTracker {
  /** The current aggregate running count = chat-busy + workflow active dispatches. */
  running(): number;
  /**
   * Register a sink. Pushes the CURRENT value immediately (initial state), then
   * on every subsequent change. Returns an unsubscribe function.
   */
  subscribe(sink: ActivitySink): () => void;
  /**
   * Notify the tracker that a lane's busy state changed. Recomputes `running`
   * and, if it changed since the last push, fans the new value out to all sinks.
   * Wired to each lane's change callback.
   */
  onLaneChange(): void;
}

export interface ActivityTrackerOpts {
  /** Reads the interactive chat lane's busy flag (1 lane, 0/1). */
  isChatBusy: () => boolean;
  /**
   * Reads the workflow lane's active phase-dispatch count. Optional — devServer
   * wires no WorkflowRuntime, so the chat lane is the only contributor there.
   */
  workflowActiveDispatchCount?: () => number;
}

export class AggregateActivityTracker implements ActivityTracker {
  private readonly isChatBusy: () => boolean;
  private readonly workflowActiveDispatchCount: () => number;
  private readonly sinks = new Set<ActivitySink>();
  /**
   * The last value pushed to sinks. Initialised to a sentinel that can never
   * equal a real count (which is >= 0) so the FIRST `onLaneChange` always pushes
   * even when the real value is 0. `subscribe` pushes the current value directly
   * (it does not consult this), so a fresh connection always gets initial state.
   */
  private lastPushed = -1;

  constructor(opts: ActivityTrackerOpts) {
    this.isChatBusy = opts.isChatBusy;
    this.workflowActiveDispatchCount = opts.workflowActiveDispatchCount ?? ((): number => 0);
  }

  running(): number {
    return (this.isChatBusy() ? 1 : 0) + this.workflowActiveDispatchCount();
  }

  subscribe(sink: ActivitySink): () => void {
    this.sinks.add(sink);
    // Initial state on connect: push the current value to THIS sink only, and
    // sync `lastPushed` so a subsequent no-op `onLaneChange` (same aggregate)
    // does not fan out a redundant frame to every sink. All already-subscribed
    // sinks have, by construction, last received exactly this value.
    const current = this.running();
    this.lastPushed = current;
    sink(current);
    return () => {
      this.sinks.delete(sink);
    };
  }

  onLaneChange(): void {
    const next = this.running();
    // De-dupe: only fan out when the aggregate actually changed since the last
    // push. Two lane transitions that net the same sum still each invoke this
    // callback sequentially, so any intermediate value is observed; coalescing
    // to an unchanged sum is correct (that IS the current running count).
    if (next === this.lastPushed) return;
    this.lastPushed = next;
    for (const sink of this.sinks) {
      sink(next);
    }
  }
}
