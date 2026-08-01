import { TASKS_LEDGER } from "../constants.js";

export type PlanLifecycleSerializationContender = "task-start" | "task-block" | "follow-up-claim";

export type PlanLifecycleSerializationBoundaryHook = (
  contender: PlanLifecycleSerializationContender,
) => void | Promise<void>;

export function rawTaskSerializationContender(
  ledgerId: string,
  status: string | undefined,
): PlanLifecycleSerializationContender | null {
  if (ledgerId !== TASKS_LEDGER) return null;
  if (status === "wip") return "task-start";
  if (status === "blocked") return "task-block";
  return null;
}
