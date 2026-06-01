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
  /**
   * Item-id prefix for this ledger (Q-CANL-8). Auto-allocated item ids are
   * `<idPrefix><n>` and caller-supplied ids must match `^<idPrefix>\d+$`.
   * Optional in the on-disk/wire form; when absent it defaults to the first
   * uppercase letter of the ledger name (`defects` → `D`). Must be a
   * non-empty run of `[A-Za-z][A-Za-z0-9]*`.
   *
   * Prefixes are GLOBALLY UNIQUE across ledgers — this is what makes item
   * ids unique across the whole store. `createLedger` refuses a colliding
   * prefix with `DuplicatePrefixError`.
   */
  idPrefix?: string;
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
  /**
   * Provenance: who last wrote this item — either the literal `"user"` (a
   * human, e.g. via the TUI/web editor) or a model class such as
   * `"opus-4.8[1m]"` (an agent writing through the MCP tools). Intrinsic and
   * optional: like createdAt/updatedAt it is NOT a schema field (so it never
   * affects schema-divergence detection), and absent on items written before
   * the convention or by callers that don't supply it. Set on createItem and
   * overwritten on every updateItem that supplies it (last-writer wins).
   */
  author?: string;
  /**
   * Provenance: the writing session id (e.g. the agent's
   * `CLAUDE_CODE_SESSION_ID`). Same intrinsic/optional/last-writer semantics
   * as {@link Item.author}.
   */
  session?: string;
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

/**
 * Thrown by `createLedger` when the new ledger's `idPrefix` (explicit or
 * defaulted) collides with an existing ledger's prefix. Prefix uniqueness
 * is what guarantees global item-id uniqueness across ledgers (Q-CANL-8).
 */
export class DuplicatePrefixError extends LedgerError {
  constructor(prefix: string, existingLedger: string) {
    super(
      `idPrefix "${prefix}" already used by ledger "${existingLedger}"; prefixes must be globally unique`,
    );
    this.name = "DuplicatePrefixError";
  }
}

/**
 * Thrown when a caller-supplied item id does not begin with the target
 * ledger's `idPrefix` followed by digits (`^<idPrefix>\d+$`). Refuses
 * cross-ledger id supply such as `create_item('tasks', …, id:'D5')`
 * (Q-CANL-8). The milestones ledger's bootstrap id `M-AMBIENT` is the one
 * exception, handled before this error fires.
 */
export class CrossPrefixIdError extends LedgerError {
  constructor(itemId: string, ledgerId: string, idPrefix: string) {
    super(
      `item id "${itemId}" does not match ledger "${ledgerId}" prefix "${idPrefix}" (expected ^${idPrefix}\\d+$)`,
    );
    this.name = "CrossPrefixIdError";
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
