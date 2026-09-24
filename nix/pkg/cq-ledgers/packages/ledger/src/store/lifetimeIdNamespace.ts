/**
 * D434 / questions:Q417 — the lifetime item-id namespace policy.
 *
 * An item id is taken for the LIFETIME of its ledger: `applyCreateItem`
 * refuses a supplied or generated id that exists in either the active or the
 * archived namespace. This module is the OTHER half — what a store does about
 * collisions that already exist in durable state when it opens.
 *
 * The policy is deliberately asymmetric, because the two collision shapes are
 * not the same defect:
 *
 *  - ACTIVE vs ARCHIVED is live ambiguity. A record still in play shares its
 *    canonical `<ledger>:<id>` with an archived generation, so an ordinary ref
 *    to live work resolves to two records. It is also cheaply repairable, by
 *    renaming the ACTIVE side — which is still in play and rewrites no
 *    history. This REFUSES the store.
 *
 *  - ARCHIVE vs ARCHIVE is history. Both generations are terminal, and the
 *    remaining ambiguity lives in prose that renaming cannot reach: on this
 *    project's own ledger the seventeen such ids have ZERO structured
 *    references and ZERO canonical citations, but 153 bare-id mentions inside
 *    archived narrative. Renaming one generation would make every historical
 *    mention silently resolve to the other, including mentions written before
 *    the other existed — converting visible ambiguity into confident
 *    wrongness, by mutating durable archived records, for items nothing points
 *    at. So this is REPORTED and never repaired automatically.
 *
 * The consequence for readers: a bare `<ledger>:<id>` is unique only among
 * ACTIVE records. The canonical identity of an archived generation is
 * `<ledger>:<id>@<pointerId>`.
 */
import { LedgerError } from "../types.js";

/** One `<ledger>:<id>` that occupies more than one durable slot. */
export interface LifetimeIdCollision {
  readonly ledgerId: string;
  readonly itemId: string;
  /** True when a live row holds the id. */
  readonly active: boolean;
  /** Archive pointers holding a generation of the id. */
  readonly archivePointerIds: readonly string[];
}

export interface LifetimeIdNamespaceReport {
  /** Active-vs-archived: live ambiguity. Refuses the store. */
  readonly conflicting: readonly LifetimeIdCollision[];
  /** Archive-vs-archive: pointer-qualified history. Reported only. */
  readonly archiveGenerations: readonly LifetimeIdCollision[];
}

function sortedPointers(collision: LifetimeIdCollision): LifetimeIdCollision {
  return { ...collision, archivePointerIds: [...collision.archivePointerIds].sort() };
}

function refOf(collision: LifetimeIdCollision): string {
  return `${collision.ledgerId}:${collision.itemId}`;
}

/**
 * Split observed collisions into the refusing arm and the reporting arm.
 *
 * Total over its input: a row that is neither (a single active row, or a
 * single archived generation) is not a collision and is ignored, so a caller
 * may pass its whole inventory without pre-filtering.
 */
export function classifyLifetimeIdNamespace(
  collisions: readonly LifetimeIdCollision[],
): LifetimeIdNamespaceReport {
  const conflicting: LifetimeIdCollision[] = [];
  const archiveGenerations: LifetimeIdCollision[] = [];
  for (const collision of collisions) {
    const sorted = sortedPointers(collision);
    if (sorted.active && sorted.archivePointerIds.length > 0) {
      conflicting.push(sorted);
    } else if (!sorted.active && sorted.archivePointerIds.length > 1) {
      archiveGenerations.push(sorted);
    }
  }
  const byRef = (left: LifetimeIdCollision, right: LifetimeIdCollision): number =>
    refOf(left).localeCompare(refOf(right));
  return {
    conflicting: conflicting.sort(byRef),
    archiveGenerations: archiveGenerations.sort(byRef),
  };
}

/** The one-line summary emitted for pointer-qualified history. */
export function lifetimeIdNamespaceNotice(
  storeLabel: string,
  archiveGenerations: readonly LifetimeIdCollision[],
): string {
  const first = archiveGenerations
    .slice(0, 3)
    .map((entry) => `${refOf(entry)}@{${entry.archivePointerIds.join(",")}}`)
    .join(" ");
  const more =
    archiveGenerations.length > 3 ? ` (+${String(archiveGenerations.length - 3)} more)` : "";
  return (
    `${storeLabel}: ${String(archiveGenerations.length)} archived item id(s) have more than ` +
    `one archived generation; a bare <ledger>:<id> is unique only among ACTIVE records, so ` +
    `address history as <ledger>:<id>@<pointerId>. ${first}${more}`
  );
}

/**
 * Apply the policy at store open. Throws on live ambiguity; reports
 * pointer-qualified history through `warn` exactly once.
 *
 * `warn` is injected rather than defaulted so a caller cannot silently lose
 * the report, and so the reporting arm is observable in a test.
 */
export function assertLifetimeIdNamespace(
  storeLabel: string,
  collisions: readonly LifetimeIdCollision[],
  warn: (line: string) => void,
): LifetimeIdNamespaceReport {
  const report = classifyLifetimeIdNamespace(collisions);
  if (report.conflicting.length > 0) {
    const detail = report.conflicting
      .map((entry) => `${refOf(entry)} (archived under ${entry.archivePointerIds.join(", ")})`)
      .join("; ");
    throw new LedgerError(
      `${storeLabel}: ${String(report.conflicting.length)} item id(s) exist as BOTH an active ` +
        `record and an archived generation, so a live canonical reference is ambiguous. ` +
        `Rename the ACTIVE record — it is still in play and rewrites no history. ${detail}`,
    );
  }
  if (report.archiveGenerations.length > 0) {
    warn(lifetimeIdNamespaceNotice(storeLabel, report.archiveGenerations));
  }
  return report;
}
