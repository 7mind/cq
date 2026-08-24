import { TASKS_LEDGER } from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { LedgerError, type Item } from "./types.js";

export type TaskStateReader = Pick<LedgerStore, "fetch" | "fetchArchive">;

/** Resolve one task identity across every active group and advertised archive. */
export async function resolveUniqueTaskState(
  reader: TaskStateReader,
  taskId: string,
): Promise<Item> {
  const tasks = reader.fetch(TASKS_LEDGER);
  const matches = tasks.milestones.flatMap((group) =>
    group.items.filter((item) => item.id === taskId),
  );
  for (const pointer of tasks.archivePointers) {
    const archive = await reader.fetchArchive(TASKS_LEDGER, pointer.id);
    const items = archive.kind === "group" ? archive.milestone.items : [archive.item];
    matches.push(...items.filter((item) => item.id === taskId));
  }
  if (matches.length !== 1) {
    throw new LedgerError(
      `task ${taskId} resolves to ${String(matches.length)} active-or-archived records`,
    );
  }
  return matches[0]!;
}
