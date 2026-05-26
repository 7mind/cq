/**
 * PlanModeCard.tsx — EnterPlanMode / ExitPlanMode tool_use card.
 *
 * Detects name `EnterPlanMode` or `ExitPlanMode` and renders a distinct
 * orange/amber banner ("Plan Mode") to visually separate plan-related
 * activity from regular tool invocations.
 *
 * EnterPlanMode:
 *   - Renders the `plan` field from input (if present) as pre-formatted text.
 *   - Shows a "Plan Mode" header with an icon.
 *
 * ExitPlanMode:
 *   - Same banner.
 *   - Shows approval status derived from the tool_result content.
 *     The SDK encodes the approval outcome in the tool_result; we surface
 *     "Approved", "Denied", or "Pending" based on what the result contains.
 */

import styles from "../../styles/PlanModeCard.module.css";
import type { ToolUseBlock, ToolResultBlock } from "./index";

// ---------------------------------------------------------------------------
// Input shapes (structural, matching the claude-code SDK tool definitions)
// ---------------------------------------------------------------------------

export interface EnterPlanModeInput {
  plan?: string;
}

export interface ExitPlanModeInput {
  plan?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PlanModeCardProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable approval status from a tool_result content value. */
function parseApprovalStatus(content: unknown): "approved" | "denied" | "pending" {
  if (content === undefined || content === null) return "pending";

  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string"
      ) {
        text += (block as Record<string, unknown>)["text"] as string;
      }
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes("approved") || lower.includes("allow")) return "approved";
  if (lower.includes("denied") || lower.includes("deny") || lower.includes("rejected")) return "denied";
  return "pending";
}

// ---------------------------------------------------------------------------
// PlanModeCard component
// ---------------------------------------------------------------------------

export function PlanModeCard({ toolUse, toolResult }: PlanModeCardProps): React.ReactElement {
  const isExit = toolUse.name === "ExitPlanMode";
  const input = toolUse.input as EnterPlanModeInput | ExitPlanModeInput;
  const plan = typeof input.plan === "string" ? input.plan : undefined;

  const badge = isExit ? "Exit" : "Enter";
  const approvalStatus = isExit ? parseApprovalStatus(toolResult?.content) : undefined;

  return (
    <div className={styles.root} data-testid="plan-mode-card">
      <div className={styles.header}>
        <span className={styles.icon}>📋</span>
        <span className={styles.title}>Plan Mode</span>
        <span className={styles.badge} data-testid="plan-mode-badge">{badge}</span>
      </div>
      {plan !== undefined && plan !== "" && (
        <div className={styles.body}>
          <pre className={styles.plan} data-testid="plan-mode-content">{plan}</pre>
        </div>
      )}
      {isExit && (
        <div className={styles.status} data-testid="plan-mode-status">
          <span className={styles.statusLabel}>Approval:</span>
          {approvalStatus === "approved" && (
            <span className={styles.statusAllow} data-testid="plan-mode-approved">Approved</span>
          )}
          {approvalStatus === "denied" && (
            <span className={styles.statusDeny} data-testid="plan-mode-denied">Denied</span>
          )}
          {approvalStatus === "pending" && (
            <span className={styles.statusPending} data-testid="plan-mode-pending">Pending</span>
          )}
        </div>
      )}
    </div>
  );
}
