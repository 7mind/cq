import { IDEAS_LEDGER, MILESTONES_AMBIENT_ID } from "./constants.js";
import type { Ledger, Milestone } from "./types.js";

/** Whether a loaded ideas ledger contains active items outside M-AMBIENT. */
export function hasLegacyIdeasOutsideAmbient(ledger: Ledger): boolean {
  return (
    ledger.id === IDEAS_LEDGER &&
    ledger.milestones.some(
      (group) => group.id !== MILESTONES_AMBIENT_ID && group.items.length > 0,
    )
  );
}

/** Relocate active legacy ideas to the sole supported ambient group. */
export function relocateActiveIdeasToAmbient(ledger: Ledger): boolean {
  if (!hasLegacyIdeasOutsideAmbient(ledger)) return false;

  const strayGroups = ledger.milestones.filter(
    (group) => group.id !== MILESTONES_AMBIENT_ID && group.items.length > 0,
  );
  if (strayGroups.length === 0) return false;

  let ambient = ledger.milestones.find((group) => group.id === MILESTONES_AMBIENT_ID);
  if (ambient === undefined) {
    ambient = {
      id: MILESTONES_AMBIENT_ID,
      title: "",
      description: "",
      items: [],
    } satisfies Milestone;
    ledger.milestones.push(ambient);
  }
  for (const group of strayGroups) {
    for (const item of group.items) {
      item.milestoneId = MILESTONES_AMBIENT_ID;
      ambient.items.push(item);
    }
  }
  ledger.milestones = ledger.milestones.filter(
    (group) => group.id === MILESTONES_AMBIENT_ID || !strayGroups.includes(group),
  );
  return true;
}
