/**
 * QuestionCard.tsx — the async cousin of AskCard (Q4 structure).
 *
 * Renders one clarifying question from a goals.snapshot:
 *   - question text;
 *   - context (muted), when present;
 *   - suggestion chips — the `recommendation` one marked "recommended";
 *     clicking a chip PRE-FILLS the free-form field (it does NOT auto-submit);
 *   - a free-form <textarea>;
 *   - a per-question "Submit answer" button that emits the trimmed answer.
 *
 * An answered question renders read-only (its answer text), behind the parent's
 * "show N answered" toggle. Submit is disabled on empty/whitespace input.
 */

import { useState } from "react";
import type { GoalQuestion } from "@cq/shared";
import styles from "../styles/Goals.module.css";

export interface QuestionCardProps {
  question: GoalQuestion;
  /** Emits the trimmed answer for this question (drives `question.answer`). */
  onSubmit: (questionId: string, answer: string) => void;
}

export function QuestionCard({ question, onSubmit }: QuestionCardProps): React.ReactElement {
  const [draft, setDraft] = useState("");

  const answered = question.status === "answered";
  if (answered) {
    return (
      <div className={`${styles.question} ${styles.questionAnswered}`} data-testid={`goal-question-${question.id}`} data-answered="true">
        <div className={styles.questionText}>{question.question}</div>
        <div className={styles.answeredText} data-testid={`goal-question-answer-${question.id}`}>
          {question.answer ?? ""}
        </div>
      </div>
    );
  }

  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <div className={styles.question} data-testid={`goal-question-${question.id}`} data-answered="false">
      <div className={styles.questionText}>{question.question}</div>
      {question.context !== undefined && question.context !== "" && (
        <div className={styles.questionContext}>{question.context}</div>
      )}
      {question.suggestions.length > 0 && (
        <div className={styles.chips}>
          {question.suggestions.map((s, i) => {
            const recommended = question.recommendation !== undefined && s === question.recommendation;
            return (
              <button
                key={i}
                type="button"
                className={`${styles.chip} ${recommended ? styles.chipRecommended : ""}`}
                data-testid={`goal-suggestion-${question.id}-${i}`}
                // Pre-fill the free-form field; do NOT auto-submit (Q4).
                onClick={() => setDraft(s)}
              >
                {s}
                {recommended && <span className={styles.recommendedTag}>recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      <textarea
        className={styles.answerField}
        value={draft}
        placeholder="Type your answer…"
        aria-label={`Answer for: ${question.question}`}
        data-testid={`goal-answer-input-${question.id}`}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnSubmit}`}
          disabled={!canSubmit}
          data-testid={`goal-answer-submit-${question.id}`}
          onClick={() => {
            if (!canSubmit) return;
            onSubmit(question.id, trimmed);
          }}
        >
          Submit answer
        </button>
      </div>
    </div>
  );
}
