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
 *
 * G80/M246 (T561, Q262) — the hypothesis ledger is reused as-is for research
 * hypotheses, linked via `ledgerRefs: ["researches:<RS>"]` the same way a
 * defect's hypothesis tree is linked via `ledgerRefs: ["defects:<D>"]`
 * (`nix/pkg/cq-assets/commands/cq/investigate/advance.md` — every node in the
 * tree, not just the root, carries the owning ref). Two more owner-agnostic
 * helpers support rendering a FULL forest (multiple roots, arbitrary depth)
 * for a given owning ref, as opposed to `hypothesisRelationships`'s
 * single-hypothesis ancestry/children view:
 *  - hypothesesLinkedToRef: filters hypotheses whose `ledgerRefs` contains a
 *    given owning ref (e.g. `"researches:RS1"` or `"defects:D3"`).
 *  - hypothesisForest: nests a (typically pre-filtered) set of hypotheses into
 *    a forest via `parentHypothesis`, tolerating parents outside the set (they
 *    become forest roots) and parentHypothesis cycles.
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

// ---------------------------------------------------------------------------
// Hypothesis forest, keyed by an arbitrary owning ref (G80/M246, Q262)
// ---------------------------------------------------------------------------

/**
 * Returns the hypothesis items whose `ledgerRefs` field contains `ownerRef`
 * verbatim (e.g. `"researches:RS1"` or `"defects:D3"`).
 *
 * @param ownerRef    The exact cross-ledger ref string to match.
 * @param hypotheses  All hypothesis items available to search.
 */
export function hypothesesLinkedToRef(ownerRef: string, hypotheses: readonly Item[]): Item[] {
  return hypotheses.filter((h) => {
    const ledgerRefs = h.fields["ledgerRefs"];
    return Array.isArray(ledgerRefs) && ledgerRefs.includes(ownerRef);
  });
}

/** One node of a hypothesis forest: an id plus its nested children. */
export interface HypothesisForestNode {
  id: string;
  children: HypothesisForestNode[];
}

/**
 * Nests a set of hypothesis items into a forest via `parentHypothesis`. A
 * hypothesis is a ROOT of the forest when its `parentHypothesis` is absent OR
 * names an item NOT present in `hypotheses` (e.g. the parent belongs to a
 * different owning ref, or was archived) — this keeps the forest well-formed
 * even over an already-filtered subset such as `hypothesesLinkedToRef`'s
 * result. Guards against `parentHypothesis` cycles the same way
 * `hypothesisRelationships` does (a visited-set per root-to-node path).
 *
 * @param hypotheses  The hypothesis items to nest (typically pre-filtered to
 *                     one owning ref via `hypothesesLinkedToRef`).
 * @returns           The forest roots, each with its `children` nested
 *                     recursively. Order follows `hypotheses`' input order.
 */
export function hypothesisForest(hypotheses: readonly Item[]): HypothesisForestNode[] {
  const byId = new Map<string, Item>();
  for (const h of hypotheses) byId.set(h.id, h);

  const childrenOf = new Map<string, string[]>();
  const rootIds: string[] = [];
  for (const h of hypotheses) {
    const parentField = h.fields["parentHypothesis"];
    if (typeof parentField === "string" && parentField !== "" && byId.has(parentField)) {
      const siblings = childrenOf.get(parentField) ?? [];
      siblings.push(h.id);
      childrenOf.set(parentField, siblings);
    } else {
      rootIds.push(h.id);
    }
  }

  function buildNode(id: string, ancestry: ReadonlySet<string>): HypothesisForestNode {
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);
    const kids = (childrenOf.get(id) ?? [])
      .filter((cid) => !ancestry.has(cid)) // cycle guard
      .map((cid) => buildNode(cid, nextAncestry));
    return { id, children: kids };
  }

  return rootIds.map((id) => buildNode(id, new Set()));
}
