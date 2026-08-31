/**
 * schemaCompat.ts — pure schema-divergence comparison helpers shared by every
 * backend's init()-time canonical-bootstrap check (AbstractLedgerStore for the
 * fs/git backends, SqliteLedgerStore for the sqlite backend).
 *
 * Extracted from AbstractLedgerStore.ts (T527) so the sqlite backend can reuse
 * the detection WITHOUT dragging the parser/serialize funnel into its module
 * graph — K102 forbids that funnel for the normalized-row backend, and
 * AbstractLedgerStore imports parser/serialize.js for its own write path.
 * No behavioural change; AbstractLedgerStore re-exports these names.
 */

import type { LedgerSchema } from "../types.js";

export function schemasEqual(a: LedgerSchema, b: LedgerSchema): boolean {
  // Cheap structural equality. Ordering of statusValues matters since it
  // affects display, but for schema-divergence-detection we treat
  // order-significant equality as the contract.
  if ((a.idPrefix ?? undefined) !== (b.idPrefix ?? undefined)) return false;
  if (a.statusValues.length !== b.statusValues.length) return false;
  for (let i = 0; i < a.statusValues.length; i++) {
    if (a.statusValues[i] !== b.statusValues[i]) return false;
  }
  if (a.terminalStatuses.length !== b.terminalStatuses.length) return false;
  for (let i = 0; i < a.terminalStatuses.length; i++) {
    if (a.terminalStatuses[i] !== b.terminalStatuses[i]) return false;
  }
  const aFieldNames = Object.keys(a.fields).sort();
  const bFieldNames = Object.keys(b.fields).sort();
  if (aFieldNames.length !== bFieldNames.length) return false;
  for (let i = 0; i < aFieldNames.length; i++) {
    if (aFieldNames[i] !== bFieldNames[i]) return false;
  }
  for (const name of aFieldNames) {
    const af = a.fields[name];
    const bf = b.fields[name];
    if (af === undefined || bf === undefined) return false;
    if (af.type !== bf.type || af.required !== bf.required) return false;
  }
  if (!transitionsEqual(a.transitions, b.transitions)) return false;
  return true;
}

/**
 * Forward-compatibility check for schema bootstrap (T407): is an EXISTING
 * on-disk schema `onDisk` compatible with the current `canonical` bootstrap
 * schema, such that loading it requires NO destructive backup-reinit?
 *
 * Compatible means the two schemas are equal EXCEPT that `canonical` may add
 * optional fields or append statuses. An appended status may be terminal only
 * when it is itself new; existing transition lists may only append targets
 * that are also new. Existing items and transitions therefore retain their
 * meaning, and the store can upgrade the persisted schema in place.
 *
 * Everything else remains divergent: removals/reordering, changed transitions
 * among existing statuses, a field present on disk but absent from canon, an
 * added required field, or a field whose type/required flag changed.
 */
export function schemaCompatible(a: LedgerSchema, b: LedgerSchema): boolean {
  if (schemasEqual(a, b)) return true;
  if ((a.idPrefix ?? undefined) !== (b.idPrefix ?? undefined)) return false;
  if (!statusWideningCompatible(a, b)) return false;
  // Every on-disk field must exist in canon UNCHANGED (no removed/retyped
  // field, no required-flag flip).
  for (const [name, af] of Object.entries(a.fields)) {
    const bf = b.fields[name];
    if (bf === undefined) return false;
    if (af.type !== bf.type || af.required !== bf.required) return false;
  }
  // Every canon field MISSING from on-disk must be OPTIONAL (added-optional).
  for (const [name, bf] of Object.entries(b.fields)) {
    if (a.fields[name] === undefined && bf.required) return false;
  }
  return true;
}

function orderedPrefix<T>(prefix: readonly T[], whole: readonly T[]): boolean {
  return (
    prefix.length <= whole.length &&
    prefix.every((value, index) => value === whole[index])
  );
}

function statusWideningCompatible(a: LedgerSchema, b: LedgerSchema): boolean {
  if (!orderedPrefix(a.statusValues, b.statusValues)) return false;
  if (!orderedPrefix(a.terminalStatuses, b.terminalStatuses)) return false;
  const addedStatuses = new Set(b.statusValues.slice(a.statusValues.length));
  if (
    b.terminalStatuses
      .slice(a.terminalStatuses.length)
      .some((status) => !addedStatuses.has(status))
  ) {
    return false;
  }
  return transitionsWideningCompatible(a.transitions, b.transitions, addedStatuses);
}

function transitionsWideningCompatible(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
  addedStatuses: ReadonlySet<string>,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  for (const [status, oldTargets] of Object.entries(a)) {
    const newTargets = b[status];
    if (newTargets === undefined || !orderedPrefix(oldTargets, newTargets)) return false;
    if (newTargets.slice(oldTargets.length).some((target) => !addedStatuses.has(target))) {
      return false;
    }
  }
  for (const status of Object.keys(b)) {
    if (a[status] === undefined && !addedStatuses.has(status)) return false;
  }
  for (const status of addedStatuses) {
    if (b[status] === undefined) return false;
  }
  return true;
}

/**
 * Structural equality for the optional `transitions` map (F1). Both absent is
 * equal; one absent is unequal. Order of the to-status arrays is significant.
 */
function transitionsEqual(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined || bv === undefined) return false;
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}
