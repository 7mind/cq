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
  /**
   * Optional declarative satisfies-dependency status list (G80). When a
   * dependency (`dependsOn` / `blockedBy`) points at an item in THIS ledger,
   * these are the statuses of that TARGET item that count as SATISFYING the
   * dependency — distinct from `terminalStatuses`, which marks an item
   * archivable regardless of whether it satisfied anything (e.g. a `wontfix`
   * defect is terminal but must never silently satisfy a dependency on it).
   *
   * This field is purely declarative — it has no behavior of its own. A later
   * predicates-resolver task consumes it under two rules:
   *
   *  (a) AUTHORITATIVE SOURCE — for a CANONICAL ledger name (tasks, defects,
   *      questions, goals, decisions, hypothesis, ideas, …) the resolver reads
   *      the canonical constant's declaration (`constants.ts`), NOT the
   *      persisted/live schema. This matters because `schemasEqual` /
   *      `schemaCompatible` (`schemaCompat.ts`) compare a FIXED property list
   *      that does not include this field, so an existing store's persisted
   *      schema that PREDATES this field is treated as unchanged (neither
   *      widened nor divergent) and is never upgraded in place — reading the
   *      canonical constant is what makes the answer correct regardless. For
   *      a CUSTOM (non-canonical) ledger there is no canonical constant to
   *      fall back to, so the resolver reads the persisted schema.
   *  (b) FALLBACK — a target ledger whose (canonical-or-persisted) schema does
   *      NOT declare this field satisfies a dependency on its
   *      `terminalStatuses` instead: absence of the declaration means "every
   *      terminal status satisfies", not "nothing satisfies".
   */
  satisfiesDependencyStatuses?: string[];
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
  /**
   * Optional declarative status-transition guard (F1). Maps a from-status to
   * the set of to-statuses an item may move INTO from it. When present, a
   * `updateItem` patch that changes `status` is rejected unless the new status
   * is listed under `transitions[currentStatus]`. When ABSENT, no transition
   * enforcement applies (back-compat for user-created ledgers) — only the
   * status-membership check (`statusValues`) still runs.
   *
   * Terminal statuses map to `[]` (no outgoing transitions). A `transitions`
   * map does NOT need an entry for every status: a status with no entry has
   * no permitted outgoing transitions (treated as `[]`).
   */
  transitions?: Record<string, string[]>;
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
 * (the `## active` group; the items resolve to themselves with
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

/**
 * Lightweight per-ledger summary returned by `enumerate_ledgers`: the
 * ledger name and its count of active (non-archived) items. Lets a client
 * show counts in a ledger list without fetching each ledger in full.
 *
 * The two optional fields are computed server-side and schema-free for the
 * consumer (both fields absent on older servers — fall back gracefully):
 *  - `statusCounts`: raw status → active-item count for this ledger.
 *  - `completedCount`: items that count as COMPLETED for the progress bar,
 *    classified against the ledger's OWN schema server-side. For the
 *    questions ledger this means items in the `answered` status only (NOT
 *    all terminals); for every other ledger it means items whose status is
 *    in the schema's `terminalStatuses`.
 */
export interface LedgerSummary {
  name: string;
  itemCount: number;
  /** Raw status → active-item count. Optional: absent on older servers. */
  statusCounts?: Record<string, number>;
  /**
   * Number of active items that count as completed for the progress bar,
   * computed server-side against each ledger's schema. Optional: absent on
   * older servers.
   */
  completedCount?: number;
  /**
   * Denominator for the progress bar, computed server-side against each
   * ledger's schema; for the questions ledger this is open + answered
   * (excludes the terminal `withdrawn`); for every other ledger it equals
   * itemCount. Optional: absent on older servers (clients fall back to
   * itemCount).
   */
  progressTotal?: number;
}

export interface ArchivePointer {
  /** Milestone id. */
  id: string;
  /** Path relative to the ledger root (i.e. `./archive/<ledger>/<id>.md`). */
  path: string;
  /** One-line human-readable summary. */
  summary: string;
  /** Milestone title (from the milestones-ledger item's `title` field). */
  title: string;
  /** Milestone status at the time of archiving (e.g. `"done"`, `"postponed"`). */
  status: string;
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
 * Registry entry stored in `./.cq/ledgers.yaml`.
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

/**
 * Thrown by `updateItem` when a status change is not permitted by the
 * ledger schema's declarative `transitions` map (F1). Only fires when the
 * schema declares a `transitions` map AND the patch moves the item to a
 * different status that is not listed under `transitions[from]`.
 */
export class InvalidTransitionError extends LedgerError {
  constructor(
    ledgerId: string,
    itemId: string,
    from: string,
    to: string,
    allowed: string[],
  ) {
    super(
      `Invalid status transition for item ${itemId} in ledger ${ledgerId}: ` +
        `"${from}" → "${to}"; allowed from "${from}": ${allowed.length > 0 ? allowed.join(", ") : "(none)"}`,
    );
    this.name = "InvalidTransitionError";
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
 * Thrown when a server-enforced cross-ledger precondition on a `goals`
 * phase change is violated (F2):
 *  - leaving `clarifying` while an `open` `questions` item still links to
 *    the goal, or
 *  - entering `planned` without a `locked` `decisions` item linking the goal.
 *
 * The message names the goal, the rule, and the blocking item ids so the
 * caller can act without a second round-trip. These are goal-specific
 * business rules enforced at the store layer so no client can bypass them.
 */
export class GoalPreconditionError extends LedgerError {
  constructor(reason: string) {
    super(`Goal precondition violated: ${reason}`);
    this.name = "GoalPreconditionError";
  }
}

/**
 * Thrown when an operation would violate a bootstrapped invariant of
 * the `milestones` ledger — e.g. attempting to archive the bootstrap
 * active group, or to re-create the milestones ledger with a different
 * schema, or to delete it.
 */
export class BootstrapViolationError extends LedgerError {
  constructor(reason: string) {
    super(`Bootstrap invariant violated: ${reason}`);
    this.name = "BootstrapViolationError";
  }
}
