/**
 * D558 — the tier the dispatched unit of work declares for itself.
 *
 * `[agent_tiers]` is the per-role DEFAULT, so a task that states the tier it
 * needs must outrank it. That declaration lives in the ledger (`tasks.suggestedModel`),
 * not in the dispatch input, and nothing read it: it was recorded, projected on
 * the compact wire and shown in the tasks table, then discarded at the one
 * moment it mattered — silently, and downward.
 */

import { TIERS, type Tier } from "@cq/config";
import { TASKS_LEDGER, type LedgerStore } from "@cq/ledger";

/** Strongest first: a cohort must never be under-served for one of its members. */
const TIER_STRENGTH: readonly Tier[] = ["frontier", "standard", "fast"];

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * The task ids one dispatch input speaks for: a single task anchor, or every
 * member of a cohort. Unknown shapes contribute nothing.
 */
export function dispatchedTaskIds(input: unknown): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Readonly<Record<string, unknown>>;
  const taskId = record["taskId"];
  if (typeof taskId === "string" && /^T\d+$/u.test(taskId)) return [taskId];
  const members = record["members"];
  if (!Array.isArray(members)) return [];
  return members.flatMap((member) => {
    if (member === null || typeof member !== "object" || Array.isArray(member)) return [];
    const memberRef = (member as Readonly<Record<string, unknown>>)["memberRef"];
    return typeof memberRef === "string" && memberRef.startsWith(`${TASKS_LEDGER}:`)
      ? [memberRef.slice(TASKS_LEDGER.length + 1)]
      : [];
  });
}

/**
 * Resolve the strongest tier the dispatched work declares, or `undefined` when
 * it declares none. A task that names something outside the tier vocabulary is
 * ignored here and fails closed later only if nothing else resolves a model.
 */
export function declaredDispatchTier(store: LedgerStore, input: unknown): Tier | undefined {
  const declared = new Set<Tier>();
  for (const taskId of dispatchedTaskIds(input)) {
    let suggested: unknown;
    try {
      suggested = store.fetchItem(TASKS_LEDGER, taskId).fields["suggestedModel"];
    } catch {
      // A dispatch may speak for a task this store cannot read (an archived or
      // foreign member). Its declaration simply does not participate.
      continue;
    }
    if (isTier(suggested)) declared.add(suggested);
  }
  return TIER_STRENGTH.find((tier) => declared.has(tier));
}
