/**
 * GoalsTab.tsx — the Goals tab (cycle 4). Read + answer + escalation.
 *
 * Data flow (mirrors HistoryTab's request-on-mount + request-on-event):
 *  - On mount (and whenever the connection goes ALIVE) send `goals.list`.
 *  - On every inbound `workflow.event` re-request `goals.list` (the lightweight
 *    refresh signal): a phase finished, a new question batch is ready, or the
 *    goal advanced. This is how the LAST-answer auto-advance result surfaces
 *    without a manual reload.
 *  - After the client's own `question.answer` / `workflow.escalation_reply` is
 *    sent, re-request once more so the optimistic state reconciles with the
 *    ledger (the badge + openQuestionCount always derive from the snapshot,
 *    never a stale client cache).
 *
 * Escalation: the snapshot carries only goal.status, so the escalated state is
 * tracked from the `workflow.event` stream — a goal enters the escalated set on
 * status:"escalated" and leaves it on planned/done/errored, or when a later
 * snapshot shows it terminal.
 */

import { useState, useEffect, useCallback } from "react";
import type { GoalSnapshot, GoalsSnapshot, WorkflowEvent } from "@cq/shared";
import { useConnection } from "../ws/useConnection";
import { GoalCard } from "./GoalCard";
import styles from "../styles/Goals.module.css";

export interface GoalsTabProps {
  /** Reports the badge value (Q13 — total open questions across all goals). */
  onBadgeChange: (totalOpenQuestions: number) => void;
}

export function GoalsTab({ onBadgeChange }: GoalsTabProps): React.ReactElement {
  const manager = useConnection();

  const [goals, setGoals] = useState<GoalSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Goal ids currently escalated (from the workflow.event stream). */
  const [escalated, setEscalated] = useState<Record<string, string | undefined>>({});

  const sendList = useCallback((): void => {
    manager.send({ type: "goals.list", seq: Date.now(), ts: Date.now() });
  }, [manager]);

  // Apply inbound goals.snapshot frames + track escalation from workflow.event.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "goals.snapshot") {
        const snap = frame as GoalsSnapshot;
        setGoals(snap.goals);
        setLoaded(true);
        onBadgeChange(snap.totalOpenQuestions);
        // Clear escalation for any goal the ledger now reports terminal.
        setEscalated((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const g of snap.goals) {
            if (
              next[g.id] !== undefined &&
              (g.status === "planned" || g.status === "done" || g.status === "abandoned")
            ) {
              delete next[g.id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        return;
      }
      if (frame.type === "workflow.event") {
        const ev = frame as WorkflowEvent;
        if (ev.goalId !== undefined) {
          if (ev.status === "escalated") {
            setEscalated((prev) => ({ ...prev, [ev.goalId!]: ev.detail }));
          } else if (ev.status === "planned" || ev.status === "done" || ev.status === "errored") {
            setEscalated((prev) => {
              if (prev[ev.goalId!] === undefined) return prev;
              const next = { ...prev };
              delete next[ev.goalId!];
              return next;
            });
          }
        }
        // Any lifecycle event is a refresh signal.
        sendList();
      }
    });
    return unsub;
  }, [manager, onBadgeChange, sendList]);

  // Fire goals.list on mount and whenever the connection (re)enters ALIVE.
  useEffect(() => {
    const tryFire = (): void => {
      const isAlive = manager.stats.connections.some((c) => c.state === "ALIVE");
      if (isAlive) sendList();
    };
    tryFire();
    const unsub = manager.onUpdate(() => { tryFire(); });
    return unsub;
  }, [manager, sendList]);

  const handleAnswer = useCallback(
    (questionId: string, answer: string): void => {
      manager.send({ type: "question.answer", seq: Date.now(), ts: Date.now(), questionId, answer });
      // Reconcile after the ack (auto-advance result + new openQuestionCount).
      sendList();
    },
    [manager, sendList],
  );

  const handleEscalationReply = useCallback(
    (goalId: string, choice: "proceed" | "guidance" | "abandon", guidance?: string): void => {
      manager.send({
        type: "workflow.escalation_reply",
        seq: Date.now(),
        ts: Date.now(),
        goalId,
        choice,
        ...(guidance !== undefined ? { guidance } : {}),
      });
      // Optimistically drop the escalation card; the snapshot/event reconciles.
      setEscalated((prev) => {
        if (prev[goalId] === undefined) return prev;
        const next = { ...prev };
        delete next[goalId];
        return next;
      });
      sendList();
    },
    [manager, sendList],
  );

  if (!loaded) {
    return <div className={styles.loading} data-testid="goals-loading">Loading goals…</div>;
  }
  if (goals.length === 0) {
    return <div className={styles.empty} data-testid="goals-empty">No goals yet. Use <code>/plan …</code> in the Chat tab to start one.</div>;
  }

  return (
    <div className={styles.wrapper} data-testid="goals-tab">
      {goals.map((g) => (
        <GoalCard
          key={g.id}
          goal={g}
          escalationDetail={escalated[g.id]}
          isEscalated={Object.prototype.hasOwnProperty.call(escalated, g.id)}
          onAnswer={handleAnswer}
          onEscalationReply={handleEscalationReply}
        />
      ))}
    </div>
  );
}
