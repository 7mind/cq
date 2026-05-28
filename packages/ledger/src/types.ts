/**
 * Public types for the @cq/ledger library.
 *
 * A Ledger is an ordered set of Milestones; each Milestone is an ordered set
 * of Items; each Item has a status (drawn from the ledger's schema) and a
 * record of fields. Schemas are per-ledger and are defined at create time.
 *
 * IDs are hybrid: a per-ledger monotonic counter persisted in the ledger
 * file's frontmatter (e.g. `D27`, `M3`); callers may supply their own id
 * at create time and the library refuses duplicates.
 */

export type FieldType = "string" | "string[]" | "id" | "id[]" | "timestamp";

export interface FieldSpec {
  /** Value type. */
  type: FieldType;
  /** When true the field must be present at create time. */
  required: boolean;
}

export interface LedgerSchema {
  /** Allowed values for `Item.status`. Always required. */
  statusValues: string[];
  /** Subset of statusValues that mark an item as terminal (archivable). */
  terminalStatuses: string[];
  /** Per-field schema. Field names are stable identifiers (no spaces). */
  fields: Record<string, FieldSpec>;
}

/**
 * Stored value for an item field.
 *
 * - `string`: any string
 * - `string[]`: array of strings
 * - `id` / `id[]`: free-form id references (no FK enforcement in v1)
 * - `timestamp`: ISO-8601 timestamp string (UTC, ms precision).
 *
 * Note: `timestamp` values are STRINGS, not numbers. The msunify cycle
 * removed numeric epoch-ms timestamps; everything stores ISO 8601 to
 * keep human-readable diffs. See `constants.ts::ISO_TIMESTAMP_RE`.
 */
export type FieldValue = string | string[];

export interface Item {
  id: string;
  milestoneId: string;
  status: string;
  fields: Record<string, FieldValue>;
  /** ISO 8601 UTC timestamp (ms precision). Set on createItem; preserved across updates. */
  createdAt: string;
  /** ISO 8601 UTC timestamp (ms precision). Bumped on every updateItem. */
  updatedAt: string;
}

export interface Milestone {
  id: string;
  /** Title — empty string for milestone-groups in non-milestones ledgers. */
  title: string;
  /** Free-form markdown paragraph; empty string for non-milestones ledgers. */
  description: string;
  items: Item[];
}

/**
 * A resolved milestone view — the metadata of a milestone-item in the
 * `milestones` ledger, joined with the status it carries there. Returned
 * by `fetch_ledger` for each milestone-group inside a non-milestones
 * ledger (Q9 in the msunify brief).
 *
 * The fields mirror what callers used to read off `Milestone.title` /
 * `.description` before unification; now those values live in the
 * milestones ledger and the per-ledger group only carries the ID.
 */
export interface ResolvedMilestone {
  id: string;
  status: string;
  title: string;
  description: string;
}

/**
 * View shape returned by `LedgerStore.fetch(ledgerId)`. Each
 * milestone-group is paired with the resolved metadata of its
 * corresponding milestone-item in the `milestones` ledger. For the
 * milestones ledger itself the resolution is the trivial self-resolution
 * (the group is `M0 — active`; the items resolve to themselves with
 * `title` / `description` pulled from their own fields).
 */
export interface FetchedMilestoneGroup {
  id: string;
  milestone: ResolvedMilestone;
  items: Item[];
}

export interface FetchedLedger {
  id: string;
  schema: LedgerSchema;
  counters: LedgerCounters;
  milestones: FetchedMilestoneGroup[];
  archivePointers: ArchivePointer[];
}

export interface ArchivePointer {
  /** Milestone id. */
  id: string;
  /** Path relative to the ledger root (i.e. `./archive/<ledger>/<id>.md`). */
  path: string;
  /** One-line human-readable summary. */
  summary: string;
}

export interface LedgerCounters {
  /** Next milestone numeric counter (current max + 1, or 1 initially). */
  milestone: number;
  /** Next item numeric counter. */
  item: number;
}

export interface Ledger {
  /** Stable ledger name (matches the entry in ledgers.yaml). */
  id: string;
  schema: LedgerSchema;
  counters: LedgerCounters;
  /** Active milestones (archived ones are referenced via `archivePointers`). */
  milestones: Milestone[];
  archivePointers: ArchivePointer[];
}

/**
 * Registry entry stored in `./docs/ledgers.yaml`.
 */
export interface LedgerRegistryEntry {
  name: string;
  schema: LedgerSchema;
}

export interface LedgerRegistry {
  version: 1;
  ledgers: LedgerRegistryEntry[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class LedgerNotFoundError extends LedgerError {
  constructor(ledgerId: string) {
    super(`Ledger not found: ${ledgerId}`);
    this.name = "LedgerNotFoundError";
  }
}

export class MilestoneNotFoundError extends LedgerError {
  constructor(ledgerId: string, milestoneId: string) {
    super(`Milestone not found in ledger ${ledgerId}: ${milestoneId}`);
    this.name = "MilestoneNotFoundError";
  }
}

export class ItemNotFoundError extends LedgerError {
  constructor(ledgerId: string, itemId: string) {
    super(`Item not found in ledger ${ledgerId}: ${itemId}`);
    this.name = "ItemNotFoundError";
  }
}

export class DuplicateIdError extends LedgerError {
  constructor(kind: "milestone" | "item" | "ledger", id: string) {
    super(`Duplicate ${kind} id: ${id}`);
    this.name = "DuplicateIdError";
  }
}

/**
 * Thrown when a caller-supplied milestone/item id contains characters that
 * could escape the filesystem path derived from it (e.g. "..", "/", spaces).
 * Only `A-Za-z0-9_-` are permitted. D-LED-01.
 */
export class InvalidIdError extends LedgerError {
  constructor(kind: "milestone" | "item", id: string) {
    super(
      `Invalid ${kind} id "${id}": only A-Za-z0-9_- are allowed`,
    );
    this.name = "InvalidIdError";
  }
}

export class InvalidStatusError extends LedgerError {
  constructor(status: string, allowed: string[]) {
    super(`Invalid status "${status}"; allowed: ${allowed.join(", ")}`);
    this.name = "InvalidStatusError";
  }
}

export class MissingRequiredFieldError extends LedgerError {
  constructor(field: string) {
    super(`Missing required field: ${field}`);
    this.name = "MissingRequiredFieldError";
  }
}

export class NonTerminalItemsError extends LedgerError {
  constructor(milestoneId: string, offendingItemIds: string[]) {
    super(
      `Cannot archive milestone ${milestoneId}: items not in terminal status: ${offendingItemIds.join(", ")}`,
    );
    this.name = "NonTerminalItemsError";
  }
}

export class LedgerBusyError extends LedgerError {
  constructor(ledgerId: string, holder: { pid: number; hostname: string; startedAt?: number }) {
    super(
      `Ledger ${ledgerId} is locked by pid ${holder.pid} on ${holder.hostname}`,
    );
    this.name = "LedgerBusyError";
  }
}

export class SchemaValidationError extends LedgerError {
  constructor(reason: string) {
    super(`Schema validation failed: ${reason}`);
    this.name = "SchemaValidationError";
  }
}

/**
 * Thrown when a caller attempts to act on a milestone that does not
 * exist in the `milestones` ledger, OR exists but is in a terminal
 * status (e.g. `done`), OR has been archived. Used by `create_item`
 * to enforce the strict-existence rule (Q5).
 *
 * Distinct from the existing `MilestoneNotFoundError` which is thrown
 * for missing depth-2 groups inside a specific ledger.
 */
export class MilestoneItemNotFoundError extends LedgerError {
  constructor(milestoneId: string, reason: "absent" | "archived" | "terminal") {
    super(
      reason === "absent"
        ? `Milestone ${milestoneId} does not exist in the milestones ledger`
        : reason === "archived"
          ? `Milestone ${milestoneId} is archived; un-archive it or pick another milestone`
          : `Milestone ${milestoneId} is in a terminal status; pick another milestone`,
    );
    this.name = "MilestoneItemNotFoundError";
  }
}

/**
 * Thrown when an operation would violate a bootstrapped invariant of
 * the `milestones` ledger — e.g. attempting to archive the bootstrap
 * group `M0`, or to re-create the milestones ledger with a different
 * schema, or to delete it.
 */
export class BootstrapViolationError extends LedgerError {
  constructor(reason: string) {
    super(`Bootstrap invariant violated: ${reason}`);
    this.name = "BootstrapViolationError";
  }
}
