/**
 * G192/T6627 — the runtime-closed memory-kind contract.
 *
 * `memories` items carry an optional scalar `kind` drawn from the closed
 * {@link MEMORY_KINDS} set. Activity stays solely in the lifecycle status
 * (`active | superseded | forgotten`); `kind` classifies content only.
 *
 * Physical versus semantic:
 *  - A legacy record is represented ONLY by the physical absence of `kind`.
 *    Init, restore, and reads never write it.
 *  - Every item-bearing public read materializes an absent `kind` as semantic
 *    {@link DEFAULT_MEMORY_KIND} through {@link resolveMemoryKind}, on a copy.
 *  - A record's next successful mutation normalizes it to the literal
 *    `kind: fact` ({@link normalizeMemoryKindForWrite}).
 *  - Physical export ({@link LedgerStore.exportPhysicalLedgerState}) keeps the
 *    absence so backup/restore round-trips it.
 *
 * Any present value outside the closed set is an invariant violation: reads,
 * physical export, and every import path reject it before any effect.
 */

import { MEMORIES_LEDGER } from "./constants.js";
import type { FetchedLedger, FieldValue, Item, Ledger } from "./types.js";
import { SchemaValidationError } from "./types.js";
import type { ArchiveContent } from "./store/LedgerStore.js";

export const MEMORY_KINDS = ["fact", "rule", "environment"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_FIELD = "kind" as const;

/** Semantic kind of a legacy record and the literal a kind-less create stores. */
export const DEFAULT_MEMORY_KIND: MemoryKind = "fact";

const MEMORY_KIND_SET: ReadonlySet<string> = new Set(MEMORY_KINDS);

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KIND_SET.has(value);
}

export class UnsupportedMemoryKindError extends SchemaValidationError {
  readonly itemId: string;
  readonly value: FieldValue;

  constructor(itemId: string, value: FieldValue) {
    super(
      `memory ${itemId} has unsupported kind ${JSON.stringify(value)}; expected one of ${MEMORY_KINDS.join(", ")}`,
    );
    this.name = "UnsupportedMemoryKindError";
    this.itemId = itemId;
    this.value = value;
  }
}

/** Reject a present `kind` outside the closed set; absence is the legacy form. */
function assertKindValue(itemId: string, fields: Readonly<Record<string, FieldValue>>): void {
  const value = fields[MEMORY_KIND_FIELD];
  if (value !== undefined && !isMemoryKind(value)) {
    throw new UnsupportedMemoryKindError(itemId, value);
  }
}

/** Validate one physical payload without materializing anything. */
export function assertMemoryKindPayload(ledgerId: string, item: Item): void {
  if (ledgerId !== MEMORIES_LEDGER) return;
  assertKindValue(item.id, item.fields);
}

/**
 * The shared read resolver. Validates the payload and returns a copy whose
 * absent `kind` is materialized as {@link DEFAULT_MEMORY_KIND}. Items outside
 * `memories`, and memories that already carry a kind, are returned as given.
 */
export function resolveMemoryKind(ledgerId: string, item: Item): Item {
  if (ledgerId !== MEMORIES_LEDGER) return item;
  assertKindValue(item.id, item.fields);
  return materializeMemoryKind(ledgerId, item);
}

/**
 * Materialize an absent `kind` WITHOUT validating a present one. Only for the
 * derived search projection, which must mount over any stored state; every
 * public read re-validates its hits through {@link resolveMemoryKind}.
 */
export function materializeMemoryKind(ledgerId: string, item: Item): Item {
  if (ledgerId !== MEMORIES_LEDGER || item.fields[MEMORY_KIND_FIELD] !== undefined) return item;
  return { ...item, fields: { ...item.fields, [MEMORY_KIND_FIELD]: DEFAULT_MEMORY_KIND } };
}

export function resolveMemoryKinds(ledgerId: string, items: readonly Item[]): Item[] {
  return items.map((item) => resolveMemoryKind(ledgerId, item));
}

export function resolveFetchedLedgerMemoryKinds(view: FetchedLedger): FetchedLedger {
  if (view.id !== MEMORIES_LEDGER) return view;
  return {
    ...view,
    milestones: view.milestones.map((group) => ({
      ...group,
      items: resolveMemoryKinds(view.id, group.items),
    })),
  };
}

/** A copy of a raw `Ledger` whose memories are resolved (substring search input). */
export function resolveLedgerMemoryKinds(ledger: Ledger): Ledger {
  if (ledger.id !== MEMORIES_LEDGER) return ledger;
  return {
    ...ledger,
    milestones: ledger.milestones.map((group) => ({
      ...group,
      items: resolveMemoryKinds(ledger.id, group.items),
    })),
  };
}

export function resolveArchiveContentMemoryKinds(
  ledgerId: string,
  content: ArchiveContent,
): ArchiveContent {
  if (ledgerId !== MEMORIES_LEDGER) return content;
  if (content.kind === "item") {
    return { kind: "item", item: resolveMemoryKind(ledgerId, content.item) };
  }
  return {
    kind: "group",
    milestone: {
      ...content.milestone,
      items: resolveMemoryKinds(ledgerId, content.milestone.items),
    },
  };
}

/**
 * Write-side normalization for a record being created or mutated: validate a
 * supplied kind and persist the literal default when the record has none.
 * Mutates `fields` in place; callers pass the record they are committing.
 */
export function normalizeMemoryKindForWrite(
  ledgerId: string,
  itemId: string,
  fields: Record<string, FieldValue>,
): void {
  if (ledgerId !== MEMORIES_LEDGER) return;
  assertKindValue(itemId, fields);
  if (fields[MEMORY_KIND_FIELD] === undefined) fields[MEMORY_KIND_FIELD] = DEFAULT_MEMORY_KIND;
}

/** Validate a caller-supplied kind before any write guard commits. */
export function assertWritableMemoryKind(
  ledgerId: string,
  itemId: string,
  fields: Readonly<Record<string, FieldValue>>,
): void {
  if (ledgerId !== MEMORIES_LEDGER) return;
  assertKindValue(itemId, fields);
}

/**
 * Validate complete active and archived payloads of a replacement state
 * (parsed restore, SQLite/PostgreSQL import, in-memory parsed replacement)
 * before the caller performs any clear, normalization, or index rebuild.
 */
export function assertLedgerStateMemoryKinds(
  ledgers: ReadonlyMap<string, Ledger>,
  archives: ReadonlyMap<string, ReadonlyMap<string, ArchiveContent>>,
): void {
  const ledger = ledgers.get(MEMORIES_LEDGER);
  if (ledger !== undefined) {
    for (const group of ledger.milestones) {
      for (const item of group.items) assertMemoryKindPayload(MEMORIES_LEDGER, item);
    }
  }
  const archived = archives.get(MEMORIES_LEDGER);
  if (archived !== undefined) {
    for (const content of archived.values()) {
      const items = content.kind === "item" ? [content.item] : content.milestone.items;
      for (const item of items) assertMemoryKindPayload(MEMORIES_LEDGER, item);
    }
  }
}
