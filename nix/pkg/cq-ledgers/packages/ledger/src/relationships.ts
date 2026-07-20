/**
 * Pure relationship-resolution helpers.
 *
 * These functions derive cross-item relationships from a flat list of
 * fetched items. They are intentionally side-effect-free so that they are
 * trivially unit-testable and can be imported by both the TUI and the web
 * client without any store dependency.
 *
 * Supported derivations (T46):
 *  - defectFixTaskIds: for a defect item D, the set of task ids that fix it.
 *  - hypothesisRelationships: for a hypothesis H, the ancestry chain to the
 *    root and the set of direct children.
 */

import type { Item } from "./types.js";
import { CANONICAL_LEDGERS, TASKS_LEDGER } from "./constants.js";
import { buildPrefixRegistry, canonicalizeRef, RefParseError } from "./refs.js";

// Static prefix→ledger registry (G80/M245): built once from the canonical
// ledger set, not from any store I/O — this keeps the module pure. Used to
// resolve `dependsOn` entries in EITHER the legacy bare form ("T523") or the
// canonical prefixed form ("tasks:T523") to the ledger they belong to.
const REF_REGISTRY = buildPrefixRegistry(CANONICAL_LEDGERS);

/**
 * Resolves a raw `dependsOn` entry to a bare task id, or `undefined` if it
 * does not name a task (resolves to another ledger, or fails to parse at
 * all — e.g. malformed refs). Accepts both the legacy bare form ("T523") and
 * the canonical prefixed form ("tasks:T523").
 */
function resolveTaskId(ref: string): string | undefined {
  let canonical: string;
  try {
    canonical = canonicalizeRef(ref, REF_REGISTRY);
  } catch (err) {
    if (err instanceof RefParseError) return undefined;
    throw err;
  }
  const colonIndex = canonical.indexOf(":");
  const ledger = canonical.slice(0, colonIndex);
  const id = canonical.slice(colonIndex + 1);
  return ledger === TASKS_LEDGER ? id : undefined;
}

// ---------------------------------------------------------------------------
// Defect → fix-task resolution
// ---------------------------------------------------------------------------

/**
 * Returns the de-duplicated set of task ids that fix defect `defectId`.
 *
 * Two link directions are unioned:
 *  1. Forward links: the defect item's `dependsOn` field, resolved via the
 *     `<ledger>:<id>` ref grammar (G80/M245) — entries that resolve to the
 *     `tasks` ledger are kept (as their bare id), entries resolving to any
 *     other ledger (e.g. a hypothesis or another defect) are excluded, and
 *     entries that fail to parse at all are skipped. Accepts both the legacy
 *     bare form ("T523") and the canonical prefixed form ("tasks:T523").
 *  2. Reverse links: any task item whose `ledgerRefs` field contains the
 *     cross-ledger reference string `"defects:<defectId>"`.
 *
 * @param defectId  The id of the defect item (e.g. `"D3"`).
 * @param defects   All defect items available to search (the defect ledger's
 *                  active items, possibly from one or more milestones).
 * @param tasks     All task items available to search.
 * @returns         A de-duplicated array of task ids, in insertion order
 *                  (forward links first, then reverse links not already
 *                  included).
 */
export function defectFixTaskIds(
  defectId: string,
  defects: readonly Item[],
  tasks: readonly Item[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  function add(id: string): void {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  // 1. Forward: defect.dependsOn resolved via the ref grammar, kept when the
  //    resolved ledger is "tasks".
  const defect = defects.find((d) => d.id === defectId);
  if (defect !== undefined) {
    const dependsOn = defect.fields["dependsOn"];
    if (Array.isArray(dependsOn)) {
      for (const ref of dependsOn) {
        if (typeof ref !== "string") continue;
        const taskId = resolveTaskId(ref);
        if (taskId !== undefined) add(taskId);
      }
    }
  }

  // 2. Reverse: tasks whose ledgerRefs contains "defects:<defectId>".
  const crossRef = `defects:${defectId}`;
  for (const task of tasks) {
    const ledgerRefs = task.fields["ledgerRefs"];
    if (Array.isArray(ledgerRefs) && ledgerRefs.includes(crossRef)) {
      add(task.id);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hypothesis ancestry + children
// ---------------------------------------------------------------------------

/**
 * The resolved relationships for a single hypothesis item.
 */
export interface HypothesisRelationships {
  /**
   * The ancestry chain from `hypothesisId` up to the root, NOT including
   * the hypothesis itself.  The first element is the direct parent; the last
   * element is the root.  Empty if the hypothesis has no parent.
   */
  ancestors: string[];
  /**
   * Ids of hypotheses whose `parentHypothesis` field equals `hypothesisId`
   * (direct children only, not grandchildren).
   */
  children: string[];
}

/**
 * Resolves the ancestry chain and direct children for hypothesis `hypothesisId`.
 *
 * @param hypothesisId  The id of the hypothesis to resolve (e.g. `"H2"`).
 * @param hypotheses    All hypothesis items available to search.
 * @returns             The ancestry chain (parent → root, oldest last) and
 *                      the list of direct child ids.
 */
export function hypothesisRelationships(
  hypothesisId: string,
  hypotheses: readonly Item[],
): HypothesisRelationships {
  // Build a lookup by id for O(1) parent resolution.
  const byId = new Map<string, Item>();
  for (const h of hypotheses) {
    byId.set(h.id, h);
  }

  // Walk parentHypothesis links up to the root.
  const ancestors: string[] = [];
  const visitedAncestors = new Set<string>([hypothesisId]);
  let current = byId.get(hypothesisId);
  while (current !== undefined) {
    const parentField = current.fields["parentHypothesis"];
    if (typeof parentField !== "string" || parentField === "") break;
    if (visitedAncestors.has(parentField)) break; // guard against cycles
    visitedAncestors.add(parentField);
    ancestors.push(parentField);
    current = byId.get(parentField);
  }

  // Direct children: hypotheses that name hypothesisId as their parent.
  const children: string[] = [];
  for (const h of hypotheses) {
    if (h.id === hypothesisId) continue;
    const parentField = h.fields["parentHypothesis"];
    if (parentField === hypothesisId) {
      children.push(h.id);
    }
  }

  return { ancestors, children };
}
