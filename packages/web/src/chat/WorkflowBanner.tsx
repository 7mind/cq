/**
 * WorkflowBanner.tsx — minimal system-style banner for `/plan` lifecycle
 * events (Q7). Full Goals-tab rendering is cycle 4; this just proves the
 * `workflow.event` notifications arrive and render in the chat stream.
 *
 * Renders a single line describing the latest lifecycle status. The parent
 * (ChatTab) holds the latest event and clears it on dismiss.
 */

import type { WorkflowEvent } from "@cq/shared";

export interface WorkflowBannerProps {
  event: WorkflowEvent;
  onDismiss: () => void;
}

function describe(event: WorkflowEvent): string {
  const goal = event.goalId !== undefined ? ` for ${event.goalId}` : "";
  switch (event.status) {
    case "started":
      return `Planning started${goal}…`;
    case "producing":
      return `Planning${goal}: producing goal and questions…`;
    case "questions_ready":
      return event.detail ?? `Questions ready${goal} in the Goals tab.`;
    case "clarifying":
      return event.detail ?? `Reviewing answers${goal}…`;
    case "planning":
      return event.detail ?? `Planning${goal}: drafting milestones and tasks…`;
    case "reviewing":
      return event.detail ?? `Reviewing the plan${goal}…`;
    case "planned":
      return event.detail ?? `Plan ready${goal}.`;
    case "done":
      return event.detail ?? `Planning complete${goal}.`;
    case "escalated":
      return `Planning needs your input${goal}: ${event.detail ?? "no further progress without guidance"}`;
    case "errored":
      return `Planning failed${goal}: ${event.detail ?? "unknown error"}`;
  }
}

export function WorkflowBanner({ event, onDismiss }: WorkflowBannerProps): React.ReactElement {
  const successStatuses: ReadonlyArray<WorkflowEvent["status"]> = ["questions_ready", "planned", "done"];
  const tone =
    event.status === "errored" || event.status === "escalated"
      ? "error"
      : successStatuses.includes(event.status)
        ? "success"
        : "info";
  return (
    <div
      data-testid="workflow-banner"
      data-status={event.status}
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.4rem 0.75rem",
        margin: "0.25rem 0.5rem",
        borderRadius: "4px",
        fontSize: "0.85rem",
        background:
          tone === "error" ? "rgba(220,60,60,0.12)" : tone === "success" ? "rgba(60,180,90,0.12)" : "rgba(90,130,220,0.12)",
        border:
          tone === "error" ? "1px solid rgba(220,60,60,0.4)" : tone === "success" ? "1px solid rgba(60,180,90,0.4)" : "1px solid rgba(90,130,220,0.4)",
      }}
    >
      <span style={{ flex: 1 }}>{describe(event)}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss planning notification"
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}
