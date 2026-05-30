/**
 * GoalCard.tsx — one expandable goal row.
 *
 * Collapsed: `G<id>` + truncated short title + a status chip. Click to expand.
 * Expanded: the detailed goal description, then milestones in order; under each,
 * its OPEN questions (answered ones collapsed behind a "show N answered"
 * toggle); tasks as read-only chips once planned. When the goal is escalated,
 * the EscalationCard renders at the top of the body.
 */

import { useState } from "react";
import type { GoalSnapshot, GoalMilestone } from "@cq/shared";
import { QuestionCard } from "./QuestionCard";
import { EscalationCard, type EscalationChoice } from "./EscalationCard";
import styles from "../styles/Goals.module.css";

const STATUS_CLASS: Record<string, string> = {
  clarifying: styles.statusClarifying!,
  planning: styles.statusPlanning!,
  planned: styles.statusPlanned!,
  building: styles.statusBuilding!,
  done: styles.statusDone!,
  abandoned: styles.statusAbandoned!,
};

export interface GoalCardProps {
  goal: GoalSnapshot;
  isEscalated: boolean;
  escalationDetail: string | undefined;
  onAnswer: (questionId: string, answer: string) => void;
  onEscalationReply: (goalId: string, choice: EscalationChoice, guidance?: string) => void;
}

export function GoalCard({
  goal,
  isEscalated,
  escalationDetail,
  onAnswer,
  onEscalationReply,
}: GoalCardProps): React.ReactElement {
  // Auto-expand goals with open questions or an active escalation.
  const [expanded, setExpanded] = useState(goal.openQuestionCount > 0 || isEscalated);

  return (
    <div className={styles.goal} data-testid={`goal-${goal.id}`} data-status={goal.status}>
      <button
        type="button"
        className={styles.goalHeader}
        aria-expanded={expanded}
        data-testid={`goal-header-${goal.id}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles.caret}>{expanded ? "▼" : "▶"}</span>
        <span className={styles.goalId}>{goal.id}</span>
        <span className={styles.goalDescription} data-testid={`goal-title-${goal.id}`}>
          {goal.title}
        </span>
        <span
          className={`${styles.statusChip} ${STATUS_CLASS[goal.status] ?? ""}`}
          data-testid={`goal-status-${goal.id}`}
        >
          {goal.status}
        </span>
      </button>
      {expanded && (
        <div className={styles.goalBody}>
          <div className={styles.goalDescriptionBody} data-testid={`goal-description-${goal.id}`}>
            {goal.description}
          </div>
          {isEscalated && (
            <EscalationCard goalId={goal.id} detail={escalationDetail} onReply={onEscalationReply} />
          )}
          {goal.milestones.map((m) => (
            <MilestoneSection key={m.id} milestone={m} onAnswer={onAnswer} />
          ))}
        </div>
      )}
    </div>
  );
}

function MilestoneSection({
  milestone,
  onAnswer,
}: {
  milestone: GoalMilestone;
  onAnswer: (questionId: string, answer: string) => void;
}): React.ReactElement {
  const [showAnswered, setShowAnswered] = useState(false);

  const open = milestone.questions.filter((q) => q.status === "open");
  const answered = milestone.questions.filter((q) => q.status === "answered");

  return (
    <div className={styles.milestone} data-testid={`goal-milestone-${milestone.id}`}>
      <div className={styles.milestoneTitle}>{milestone.title}</div>

      {open.map((q) => (
        <QuestionCard key={q.id} question={q} onSubmit={onAnswer} />
      ))}

      {answered.length > 0 && (
        <>
          <button
            type="button"
            className={styles.answeredToggle}
            data-testid={`goal-answered-toggle-${milestone.id}`}
            onClick={() => setShowAnswered((v) => !v)}
          >
            {showAnswered ? "hide" : `show ${answered.length} answered`}
          </button>
          {showAnswered &&
            answered.map((q) => <QuestionCard key={q.id} question={q} onSubmit={onAnswer} />)}
        </>
      )}

      {milestone.tasks.length > 0 && (
        <div className={styles.taskList} data-testid={`goal-tasks-${milestone.id}`}>
          {milestone.tasks.map((t) => (
            <span key={t.id} className={styles.taskChip} data-testid={`goal-task-${t.id}`}>
              {t.headline}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
