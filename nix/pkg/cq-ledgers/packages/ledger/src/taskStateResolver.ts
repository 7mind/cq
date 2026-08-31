import { GOALS_LEDGER, TASKS_LEDGER } from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { LedgerError, type Item } from "./types.js";

export type TaskStateReader = Pick<LedgerStore, "fetch" | "fetchArchive">;

async function resolveUniqueItemState(
  reader: TaskStateReader,
  ledgerId: string,
  itemId: string,
  itemKind: string,
): Promise<Item> {
  const ledger = reader.fetch(ledgerId);
  const matches = ledger.milestones.flatMap((group) =>
    group.items.filter((item) => item.id === itemId),
  );
  for (const pointer of ledger.archivePointers) {
    const archive = await reader.fetchArchive(ledgerId, pointer.id);
    const items = archive.kind === "group" ? archive.milestone.items : [archive.item];
    matches.push(...items.filter((item) => item.id === itemId));
  }
  if (matches.length !== 1) {
    throw new LedgerError(
      `${itemKind} ${itemId} resolves to ${String(matches.length)} active-or-archived records`,
    );
  }
  return matches[0]!;
}

/** Resolve one task identity across every active group and advertised archive. */
export async function resolveUniqueTaskState(
  reader: TaskStateReader,
  taskId: string,
): Promise<Item> {
  return await resolveUniqueItemState(reader, TASKS_LEDGER, taskId, "task");
}

/** Resolve one goal identity across every active group and advertised archive. */
export async function resolveUniqueGoalState(
  reader: TaskStateReader,
  goalId: string,
): Promise<Item> {
  return await resolveUniqueItemState(reader, GOALS_LEDGER, goalId, "goal");
}
