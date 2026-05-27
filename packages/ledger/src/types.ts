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
 * - `timestamp`: epoch millis as a number
 */
export type FieldValue = string | string[] | number;

export interface Item {
  id: string;
  milestoneId: string;
  status: string;
  fields: Record<string, FieldValue>;
  /** Epoch millis. Set on createItem; preserved across updates. */
  createdAt: number;
  /** Epoch millis. Bumped on every updateItem. */
  updatedAt: number;
}

export interface Milestone {
  id: string;
  title: string;
  /** Free-form markdown paragraph; empty string if none. */
  description: string;
  items: Item[];
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
  constructor(ledgerId: string, holder: { pid: number; hostname: string }) {
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
