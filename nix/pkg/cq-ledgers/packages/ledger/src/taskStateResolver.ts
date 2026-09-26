import { DEFECTS_LEDGER, GOALS_LEDGER, TASKS_LEDGER } from "./constants.js";
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
  const active = ledger.milestones.flatMap((group) =>
    group.items.filter((item) => item.id === itemId),
  );
  const generations: { readonly pointerId: string; readonly item: Item }[] = [];
  for (const pointer of ledger.archivePointers) {
    const archive = await reader.fetchArchive(ledgerId, pointer.id);
    const items = archive.kind === "group" ? archive.milestone.items : [archive.item];
    for (const item of items) {
      if (item.id === itemId) generations.push({ pointerId: pointer.id, item });
    }
  }

  // D434 / questions:Q417. Every archive is still read, deliberately. The
  // open-time detector refuses a store whose id is both active and archived,
  // but it cannot see corruption that arrives while the store is already OPEN
  // — a second writer on the same ledger.db can still produce that shape, and
  // this resolver guards mutating operations such as terminal release. So
  // live ambiguity is refused here too rather than silently resolved to the
  // active record.
  const total = active.length + generations.length;
  if (active.length > 0 && generations.length > 0) {
    throw new LedgerError(
      `${itemKind} ${itemId} resolves to ${String(total)} active-or-archived records`,
    );
  }
  const onlyActive = active[0];
  if (active.length === 1 && onlyActive !== undefined) return onlyActive;
  if (active.length > 1) {
    throw new LedgerError(
      `${itemKind} ${itemId} resolves to ${String(total)} active-or-archived records`,
    );
  }
  const onlyArchived = generations[0];
  if (generations.length === 1 && onlyArchived !== undefined) return onlyArchived.item;
  if (generations.length === 0) {
    throw new LedgerError(
      `${itemKind} ${itemId} resolves to 0 active-or-archived records`,
    );
  }
  // The one case the policy DOES change: two archived generations are
  // pointer-qualified history that is never renamed, so name the pointers and
  // the addressing form instead of reporting an opaque count.
  const pointers = generations.map((entry) => entry.pointerId).sort();
  throw new LedgerError(
    `${itemKind} ${itemId} is archive-ambiguous across ${String(generations.length)} archived ` +
      `generations (${pointers.join(", ")}); address history as ` +
      `${ledgerId}:${itemId}@<pointerId>`,
  );
}

/** Resolve one task identity across every active group and advertised archive. */
export async function resolveUniqueTaskState(
  reader: TaskStateReader,
  taskId: string,
): Promise<Item> {
  return await resolveUniqueItemState(reader, TASKS_LEDGER, taskId, "task");
}

/** Resolve one defect identity across every active group and advertised archive. */
export async function resolveUniqueDefectState(
  reader: TaskStateReader,
  defectId: string,
): Promise<Item> {
  return await resolveUniqueItemState(reader, DEFECTS_LEDGER, defectId, "defect");
}

/** Resolve one goal identity across every active group and advertised archive. */
export async function resolveUniqueGoalState(
  reader: TaskStateReader,
  goalId: string,
): Promise<Item> {
  return await resolveUniqueItemState(reader, GOALS_LEDGER, goalId, "goal");
}
