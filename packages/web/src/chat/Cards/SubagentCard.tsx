/**
 * SubagentCard.tsx — renders a sub-agent invocation as a boxed nested card.
 *
 * Props:
 *   task     — sub-agent task metadata (from SDKTaskStartedMessage fields).
 *   children — rendered nested content (assistant text + tool cards) accumulated
 *              from events whose parent_tool_use_id matches this task's tool_use_id.
 *
 * Status badge reflects the lifecycle:
 *   'running'   — task_started received; awaiting task_notification.
 *   'completed' — task_notification with status 'completed'.
 *   'failed'    — task_notification with status 'failed'.
 *   'stopped'   — task_notification with status 'stopped'.
 */

import styles from "../../styles/SubagentCard.module.css";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface SubagentTask {
  task_id: string;
  /** The tool_use_id that originated this sub-agent (matches parent_tool_use_id on nested events). */
  tool_use_id?: string;
  /** Human-readable label, e.g. 'Task' or 'subagent'. */
  agent_name: string;
  /** Short description of what the sub-agent is doing. */
  task_description: string;
  status: SubagentStatus;
  /** Live progress summary from task_progress events (agentProgressSummaries). */
  summary?: string;
}

export interface SubagentCardProps {
  task: SubagentTask;
  children?: React.ReactNode;
}

const DESCRIPTION_MAX = 120;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function badgeClass(status: SubagentStatus): string {
  switch (status) {
    case "running":   return styles.badgeRunning!;
    case "completed": return styles.badgeCompleted!;
    case "failed":    return styles.badgeFailed!;
    case "stopped":   return styles.badgeStopped!;
  }
}

export function SubagentCard({ task, children }: SubagentCardProps): React.ReactElement {
  return (
    <div
      className={styles.card}
      data-testid="subagent-card"
      data-task-id={task.task_id}
      data-status={task.status}
    >
      <div className={styles.header}>
        <span className={styles.agentLabel}>{task.agent_name}</span>
        <span className={styles.description}>
          {truncate(task.task_description, DESCRIPTION_MAX)}
        </span>
        <span className={`${styles.badge} ${badgeClass(task.status)}`} data-testid="subagent-status">
          {task.status}
        </span>
        {task.summary !== undefined && task.summary !== "" && (
          <span className={styles.summary}>{task.summary}</span>
        )}
      </div>
      {children !== undefined && (
        <div className={styles.children} data-testid="subagent-children">
          {children}
        </div>
      )}
    </div>
  );
}
