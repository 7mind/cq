/**
 * EscalationCard.tsx — the WFL-D01 no-progress escalation choice UI.
 *
 * Rendered inside a goal when the no-progress guard has emitted a
 * `workflow.event{status:"escalated"}` for it. Offers three choices that emit a
 * `workflow.escalation_reply`:
 *   - proceed-as-is  → accept the current plan (goal → planned + done).
 *   - give-guidance  → opens a textarea; submit re-dispatches the planner.
 *   - abandon        → goal → abandoned.
 */

import { useState } from "react";
import styles from "../styles/Goals.module.css";

export type EscalationChoice = "proceed" | "guidance" | "abandon";

export interface EscalationCardProps {
  goalId: string;
  detail: string | undefined;
  onReply: (goalId: string, choice: EscalationChoice, guidance?: string) => void;
}

export function EscalationCard({ goalId, detail, onReply }: EscalationCardProps): React.ReactElement {
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState("");

  const trimmed = guidance.trim();

  return (
    <div className={styles.escalation} data-testid={`goal-escalation-${goalId}`}>
      <div className={styles.escalationTitle}>Planning needs your input</div>
      <div className={styles.escalationDetail}>
        {detail ?? "The plan-review loop made no further progress without guidance."}
      </div>
      {!guidanceOpen ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSubmit}`}
            data-testid={`goal-escalation-proceed-${goalId}`}
            onClick={() => onReply(goalId, "proceed")}
          >
            Proceed as-is
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            data-testid={`goal-escalation-guidance-${goalId}`}
            onClick={() => setGuidanceOpen(true)}
          >
            Give guidance
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            data-testid={`goal-escalation-abandon-${goalId}`}
            onClick={() => onReply(goalId, "abandon")}
          >
            Abandon
          </button>
        </div>
      ) : (
        <>
          <textarea
            className={styles.answerField}
            value={guidance}
            placeholder="What should the planner do differently?"
            aria-label="Planning guidance"
            data-testid={`goal-escalation-guidance-input-${goalId}`}
            onChange={(e) => setGuidance(e.target.value)}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSubmit}`}
              disabled={trimmed.length === 0}
              data-testid={`goal-escalation-guidance-submit-${goalId}`}
              onClick={() => {
                if (trimmed.length === 0) return;
                onReply(goalId, "guidance", trimmed);
              }}
            >
              Submit guidance
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              data-testid={`goal-escalation-guidance-cancel-${goalId}`}
              onClick={() => setGuidanceOpen(false)}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
