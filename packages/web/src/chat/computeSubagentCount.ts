/**
 * computeSubagentCount.ts — count running subagents from chat events.
 *
 * A subagent is "running" once `task_started` has been observed and
 * `task_notification{status:'completed'|'failed'|'stopped'}` has NOT yet
 * been observed for the same task_id. Used by the top-bar status badge.
 */

import type { ChatEvent } from "@cq/shared";

export function computeSubagentCount(chatEvents: ChatEvent[]): { running: number; total: number } {
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const evt of chatEvents) {
    const sdk = evt.sdkEvent as Record<string, unknown>;
    if (sdk["type"] !== "system") continue;
    const sub = sdk["subtype"];
    const taskId = sdk["task_id"];
    if (typeof taskId !== "string" || taskId === "") continue;
    if (sub === "task_started") started.add(taskId);
    else if (sub === "task_notification") finished.add(taskId);
  }
  let running = 0;
  for (const id of started) {
    if (!finished.has(id)) running++;
  }
  return { running, total: started.size };
}
