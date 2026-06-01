/**
 * Internal pure logic for mutating in-memory Ledger state.
 * No I/O, no locking — those concerns live in FsLedgerStore.
 *
 * Shared between FsLedgerStore (which wraps these with persist + lock) and
 * InMemoryLedgerStore (the dual-tests dummy).
 */

import type {
  ArchivePointer,
  FieldSpec,
  FieldValue,
  Item,
  Ledger,
  Milestone,
  ResolvedMilestone,
} from "../types.js";
import {
  BootstrapViolationError,
  CrossPrefixIdError,
  DuplicateIdError,
  DuplicatePrefixError,
  InvalidIdError,
  InvalidStatusError,
  InvalidTransitionError,
  ItemNotFoundError,
  MilestoneItemNotFoundError,
  MilestoneNotFoundError,
  MissingRequiredFieldError,
  NonTerminalItemsError,
  SchemaValidationError,
} from "../types.js";
import {
  isIsoTimestamp,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../constants.js";
import type { LedgerSchema } from "../types.js";
import type {
  CreateItemInit,
  CreateMilestoneItemInit,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./LedgerStore.js";

/**
 * Allowed shape for a ledger's `idPrefix` (Q-CANL-8). A non-empty run of
 * a leading letter followed by alphanumerics; no digits-only, no symbols.
 * Keeps `^<idPrefix>\d+$` unambiguous.
 */
const ID_PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * The effective item-id prefix for a ledger: explicit `schema.idPrefix`
 * when present, else the first uppercase letter of the ledger name. The
 * single source of truth for both auto-allocation and caller-supplied-id
 * validation. (§8a.)
 */
export function effectiveIdPrefix(name: string, schema: LedgerSchema): string {
  if (schema.idPrefix !== undefined && schema.idPrefix.length > 0) {
    return schema.idPrefix;
  }
  const first = name[0];
  if (first === undefined) {
    throw new SchemaValidationError(`cannot derive idPrefix for empty ledger name`);
  }
  return first.toUpperCase();
}

/**
 * Caller-supplied milestone/item ids must match this regex. The set is
 * deliberately narrow — no `/`, no `.`, no whitespace — so an id cannot
 * escape the filesystem path that `FsLedgerStore` derives from it
 * (`./archive/<ledger>/<id>.md`). D-LED-01.
 */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeId(kind: "milestone" | "item", id: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new InvalidIdError(kind, id);
  }
}

/**
 * Status values become markdown headings via the em-dash separator
 * `### <id> — <status>`; a status containing `—` would break heading
 * round-trip. Restrict to alphanumerics, space, dash, underscore.
 * D-LED-02.
 */
const STATUS_VALUE_RE = /^[A-Za-z0-9 _-]+$/;

/**
 * Field names are stable identifiers (no spaces, no `:` that would
 * collide with the field-list YAML serialization, no em-dash). Mirrors
 * the JS identifier convention. D-LED-02.
 */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reserved field names that collide with intrinsic Item fields. D-LED-02. */
const RESERVED_FIELD_NAMES = new Set(["createdAt", "updatedAt", "author", "session"]);

/**
 * Validate a LedgerSchema against the invariants every layer must honour
 * (Zod tool schema, on-disk registry, adapter constructors). Called
 * defensively at every entry point so a schema that slips past one layer
 * is still caught by the next. D-LED-02.
 *
 * Invariants:
 *  - `statusValues` is non-empty and every entry matches STATUS_VALUE_RE.
 *  - Every `terminalStatuses` entry is also in `statusValues`.
 *  - Every field name matches FIELD_NAME_RE and is not reserved.
 */
export function validateSchema(schema: {
  statusValues: string[];
  terminalStatuses: string[];
  fields: Record<string, { type: string; required: boolean }>;
  idPrefix?: string;
  transitions?: Record<string, string[]>;
}): void {
  if (schema.statusValues.length === 0) {
    throw new SchemaValidationError("statusValues must be non-empty");
  }
  if (schema.idPrefix !== undefined && !ID_PREFIX_RE.test(schema.idPrefix)) {
    throw new SchemaValidationError(
      `idPrefix "${schema.idPrefix}" must match /^[A-Za-z][A-Za-z0-9]*$/`,
    );
  }
  for (const sv of schema.statusValues) {
    if (!STATUS_VALUE_RE.test(sv)) {
      throw new SchemaValidationError(
        `status value "${sv}" contains disallowed characters; allowed: A-Za-z0-9, space, dash, underscore`,
      );
    }
  }
  const svSet = new Set(schema.statusValues);
  for (const t of schema.terminalStatuses) {
    if (!svSet.has(t)) {
      throw new SchemaValidationError(
        `terminalStatuses entry "${t}" is not in statusValues`,
      );
    }
  }
  for (const name of Object.keys(schema.fields)) {
    if (RESERVED_FIELD_NAMES.has(name)) {
      throw new SchemaValidationError(
        `field name "${name}" is reserved (collides with intrinsic Item field)`,
      );
    }
    if (!FIELD_NAME_RE.test(name)) {
      throw new SchemaValidationError(
        `field name "${name}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
  }
  // F1: every from-status and to-status referenced by the transition guard
  // must be a declared status value, else the guard is unreachable / dead.
  // A terminal status must additionally carry NO outgoing transitions —
  // a non-empty target array on a terminal key is a contradiction.
  if (schema.transitions !== undefined) {
    const terminalSet = new Set(schema.terminalStatuses);
    for (const [from, tos] of Object.entries(schema.transitions)) {
      if (!svSet.has(from)) {
        throw new SchemaValidationError(
          `transitions key "${from}" is not in statusValues`,
        );
      }
      for (const to of tos) {
        if (!svSet.has(to)) {
          throw new SchemaValidationError(
            `transitions["${from}"] target "${to}" is not in statusValues`,
          );
        }
      }
      if (terminalSet.has(from) && tos.length > 0) {
        throw new SchemaValidationError(
          `terminal status "${from}" must have no outgoing transitions`,
        );
      }
    }
  }
}

/**
 * Refuse a new ledger whose effective `idPrefix` collides with any
 * existing ledger's prefix (Q-CANL-8 — prefix uniqueness gives global
 * item-id uniqueness). `existing` is an iterable of `{name, schema}` for
 * every currently-registered ledger. Throws `DuplicatePrefixError` on
 * collision; returns the new ledger's effective prefix on success.
 */
export function assertPrefixUnique(
  newName: string,
  newSchema: LedgerSchema,
  existing: Iterable<{ name: string; schema: LedgerSchema }>,
): string {
  const prefix = effectiveIdPrefix(newName, newSchema);
  for (const { name, schema } of existing) {
    if (name === newName) continue;
    if (effectiveIdPrefix(name, schema) === prefix) {
      throw new DuplicatePrefixError(prefix, name);
    }
  }
  return prefix;
}

export function findItem(ledger: Ledger, itemId: string): { milestone: Milestone; item: Item } {
  for (const m of ledger.milestones) {
    for (const it of m.items) {
      if (it.id === itemId) return { milestone: m, item: it };
    }
  }
  throw new ItemNotFoundError(ledger.id, itemId);
}

export function searchItems(ledger: Ledger, query: string): Item[] {
  const q = query.toLowerCase();
  const out: Item[] = [];
  for (const m of ledger.milestones) {
    for (const it of m.items) {
      if (it.status.toLowerCase().includes(q)) {
        out.push(it);
        continue;
      }
      let matched = false;
      for (const v of Object.values(it.fields)) {
        if (matched) break;
        if (typeof v === "string" && v.toLowerCase().includes(q)) matched = true;
        else if (Array.isArray(v) && v.some((s) => s.toLowerCase().includes(q))) matched = true;
        else if (typeof v === "number" && String(v).includes(q)) matched = true;
      }
      if (matched) out.push(it);
    }
  }
  return out;
}

export function applyUpdateItem(
  ledger: Ledger,
  itemId: string,
  patch: UpdateItemPatch,
  now: string,
): Item {
  const { item } = findItem(ledger, itemId);
  if (patch.status !== undefined) {
    assertStatusAllowed(ledger, patch.status);
    // F1: enforce the declarative transition guard only when the status
    // actually changes and the schema declares a transitions map. A
    // field-only or no-op (status unchanged) patch never triggers it.
    if (patch.status !== item.status) {
      assertTransitionAllowed(ledger, itemId, item.status, patch.status);
    }
    item.status = patch.status;
  }
  if (patch.fields !== undefined) {
    validateFields(ledger, patch.fields, /*creating*/ false);
    for (const [k, v] of Object.entries(patch.fields)) {
      item.fields[k] = v;
    }
  }
  if (patch.author !== undefined) item.author = patch.author;
  if (patch.session !== undefined) item.session = patch.session;
  item.updatedAt = now;
  return item;
}

/**
 * Apply a `createItem` operation against `ledger`.
 *
 * - In the milestones ledger: the only allowed `milestoneId` is the
 *   bootstrap group `M0`. All milestone-items live there; the caller
 *   (FsLedgerStore.createMilestone) routes here.
 * - In every other ledger: if no depth-2 group with id === `milestoneId`
 *   exists yet, one is auto-created (empty title, empty description).
 *   This is the per-msunify-1 plan decision #1: the dropped
 *   per-ledger `createMilestone` is replaced by lazy group materialisation
 *   here. Strict existence of `milestoneId` against the milestones
 *   ledger is checked at the LedgerStore layer (which has the cross-
 *   ledger view); this pure helper trusts the caller.
 *
 * `now` is an ISO 8601 timestamp string supplied by the store.
 */
export function applyCreateItem(
  ledger: Ledger,
  milestoneId: string,
  init: CreateItemInit,
  now: string,
): Item {
  let milestone: Milestone;
  const existing = ledger.milestones.find((m) => m.id === milestoneId);
  if (existing !== undefined) {
    milestone = existing;
  } else if (ledger.id === MILESTONES_LEDGER) {
    // The milestones ledger only ever has the M0 group; anything else
    // is a logic error.
    throw new MilestoneNotFoundError(ledger.id, milestoneId);
  } else {
    // Non-milestones ledger: auto-create a bare group with the
    // referenced id (plan decision #1). The caller is responsible for
    // having verified existence in the milestones ledger first.
    assertSafeId("milestone", milestoneId);
    milestone = {
      id: milestoneId,
      title: "",
      description: "",
      items: [],
    };
    ledger.milestones.push(milestone);
  }
  assertStatusAllowed(ledger, init.status);
  validateFields(ledger, init.fields, /*creating*/ true);
  const prefix = effectiveIdPrefix(ledger.id, ledger.schema);
  let id: string;
  if (init.id !== undefined) {
    assertSafeId("item", init.id);
    assertItemIdMatchesPrefix(ledger, init.id, prefix);
    if (itemIdExists(ledger, init.id)) throw new DuplicateIdError("item", init.id);
    id = init.id;
    const n = numericPart(init.id, perPrefixIdRe(prefix));
    if (n !== null && n >= ledger.counters.item) {
      ledger.counters.item = n + 1;
    }
  } else {
    ledger.counters.item += 1;
    id = prefix + String(ledger.counters.item);
    // Avoid colliding with a caller-supplied id elsewhere.
    while (itemIdExists(ledger, id)) {
      ledger.counters.item += 1;
      id = prefix + String(ledger.counters.item);
    }
    // Defense-in-depth: the auto-generated id must also satisfy the safe regex.
    assertSafeId("item", id);
  }
  const item: Item = {
    id,
    milestoneId,
    status: init.status,
    fields: { ...init.fields },
    createdAt: now,
    updatedAt: now,
  };
  // Optional provenance — assign conditionally so exactOptionalPropertyTypes
  // never sees an explicit `undefined` on the optional keys.
  if (init.author !== undefined) item.author = init.author;
  if (init.session !== undefined) item.session = init.session;
  milestone.items.push(item);
  return item;
}

/**
 * Apply a `createMilestone` operation against the milestones ledger.
 *
 * Allocates an `M<n>` item id via the ledger's own item counter,
 * places the item under the bootstrap `M0` group, and seeds the four
 * milestone-item fields (`title`, `description?`, `blockedBy?`,
 * `dependsOn?`) via the standard `applyCreateItem` path.
 *
 * The caller must have validated that `ledger.id === MILESTONES_LEDGER`.
 */
export function applyCreateMilestoneItem(
  ledger: Ledger,
  init: CreateMilestoneItemInit,
  now: string,
): Item {
  if (ledger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `applyCreateMilestoneItem invoked on non-milestones ledger ${ledger.id}`,
    );
  }
  const fields: Record<string, FieldValue> = { title: init.title };
  if (init.description !== undefined) fields["description"] = init.description;
  if (init.blockedBy !== undefined) fields["blockedBy"] = init.blockedBy;
  if (init.dependsOn !== undefined) fields["dependsOn"] = init.dependsOn;
  const innerInit: CreateItemInit = { status: "open", fields };
  if (init.id !== undefined) innerInit.id = init.id;
  return applyCreateItem(ledger, MILESTONES_ACTIVE_GROUP_ID, innerInit, now);
}

/**
 * Ensure the immortal `M-AMBIENT` bootstrap milestone exists in the
 * milestones ledger's active group (§8b). Idempotent: a no-op once the
 * item is present. Called on init by both adapters. `now` seeds the
 * timestamps for a freshly-created item.
 */
export function applyEnsureAmbientMilestone(ledger: Ledger, now: string): void {
  if (ledger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `applyEnsureAmbientMilestone invoked on non-milestones ledger ${ledger.id}`,
    );
  }
  const group = ledger.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID);
  if (group === undefined) {
    throw new BootstrapViolationError(
      `milestones ledger is missing its bootstrap group ${MILESTONES_ACTIVE_GROUP_ID}`,
    );
  }
  if (group.items.some((it) => it.id === MILESTONES_AMBIENT_ID)) return;
  group.items.push({
    id: MILESTONES_AMBIENT_ID,
    milestoneId: MILESTONES_ACTIVE_GROUP_ID,
    status: "open",
    fields: { title: "ambient" },
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Apply an `updateMilestone` patch against a milestone-item in the
 * milestones ledger. Translates the four-key patch shape into the
 * generic item-patch shape and routes through `applyUpdateItem`.
 *
 * `M-AMBIENT` is immortal (§8b): moving it to any terminal status is
 * refused.
 */
export function applyUpdateMilestoneItem(
  ledger: Ledger,
  milestoneItemId: string,
  patch: UpdateMilestoneItemPatch,
  now: string,
): Item {
  if (ledger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `applyUpdateMilestoneItem invoked on non-milestones ledger ${ledger.id}`,
    );
  }
  if (
    milestoneItemId === MILESTONES_AMBIENT_ID &&
    patch.status !== undefined &&
    ledger.schema.terminalStatuses.includes(patch.status)
  ) {
    throw new BootstrapViolationError(
      `${MILESTONES_AMBIENT_ID} is immortal and cannot be moved to a terminal status`,
    );
  }
  const itemPatch: UpdateItemPatch = {};
  if (patch.status !== undefined) itemPatch.status = patch.status;
  const fields: Record<string, FieldValue> = {};
  if (patch.title !== undefined) fields["title"] = patch.title;
  if (patch.description !== undefined) fields["description"] = patch.description;
  if (patch.blockedBy !== undefined) fields["blockedBy"] = patch.blockedBy;
  if (patch.dependsOn !== undefined) fields["dependsOn"] = patch.dependsOn;
  if (Object.keys(fields).length > 0) itemPatch.fields = fields;
  return applyUpdateItem(ledger, milestoneItemId, itemPatch, now);
}

/**
 * Detach a depth-2 milestone-group from `ledger` after verifying every
 * item is in a terminal status. Returns the detached group for the
 * caller to persist into the archive directory; the caller is also
 * responsible for appending the `ArchivePointer` returned alongside.
 *
 * Used by `archiveMilestone` (the global, 2-level operation) to sweep
 * each non-milestones ledger that has items under `milestoneId`.
 */
export function applyDetachMilestoneGroup(
  ledger: Ledger,
  milestoneId: string,
  summary: string,
  archiveRelPath: string,
): { milestone: Milestone; pointer: ArchivePointer } {
  const idx = ledger.milestones.findIndex((m) => m.id === milestoneId);
  if (idx < 0) throw new MilestoneNotFoundError(ledger.id, milestoneId);
  const milestone = ledger.milestones[idx];
  if (milestone === undefined) throw new MilestoneNotFoundError(ledger.id, milestoneId);
  const terminal = new Set(ledger.schema.terminalStatuses);
  const offending = milestone.items.filter((it) => !terminal.has(it.status)).map((it) => it.id);
  if (offending.length > 0) {
    throw new NonTerminalItemsError(milestoneId, offending);
  }
  ledger.milestones.splice(idx, 1);
  const pointer: ArchivePointer = { id: milestoneId, path: archiveRelPath, summary };
  ledger.archivePointers.push(pointer);
  return { milestone, pointer };
}

/**
 * Detach a single milestone-item out of the milestones ledger's M0
 * group, after verifying it is in a terminal status. Returns the
 * detached item for the caller to persist as `./archive/milestones/<id>.md`,
 * plus the archive pointer the caller is responsible for appending.
 *
 * Bootstrap invariant: the M0 group itself is never detached, only
 * individual items under it.
 */
export function applyDetachMilestoneItem(
  ledger: Ledger,
  milestoneItemId: string,
  summary: string,
  archiveRelPath: string,
): { item: Item; pointer: ArchivePointer } {
  if (ledger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `applyDetachMilestoneItem invoked on non-milestones ledger ${ledger.id}`,
    );
  }
  if (milestoneItemId === MILESTONES_ACTIVE_GROUP_ID) {
    throw new BootstrapViolationError(
      `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
    );
  }
  if (milestoneItemId === MILESTONES_AMBIENT_ID) {
    throw new BootstrapViolationError(
      `${MILESTONES_AMBIENT_ID} is immortal and cannot be archived`,
    );
  }
  const group = ledger.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID);
  if (group === undefined) {
    throw new BootstrapViolationError(
      `milestones ledger is missing its bootstrap group ${MILESTONES_ACTIVE_GROUP_ID}`,
    );
  }
  const itemIdx = group.items.findIndex((it) => it.id === milestoneItemId);
  if (itemIdx < 0) {
    throw new MilestoneItemNotFoundError(milestoneItemId, "absent");
  }
  const item = group.items[itemIdx];
  if (item === undefined) {
    throw new MilestoneItemNotFoundError(milestoneItemId, "absent");
  }
  const terminal = new Set(ledger.schema.terminalStatuses);
  if (!terminal.has(item.status)) {
    throw new NonTerminalItemsError(milestoneItemId, [item.id]);
  }
  group.items.splice(itemIdx, 1);
  const pointer: ArchivePointer = {
    id: milestoneItemId,
    path: archiveRelPath,
    summary,
  };
  ledger.archivePointers.push(pointer);
  return { item, pointer };
}

/**
 * Resolve a milestone-item id against the milestones ledger and return
 * its `{ id, status, title, description }` view. Active items only —
 * archived items (lookup via `archivePointers`) return null.
 *
 * Used by `fetch(ledgerId)` to expand each milestone-group's metadata
 * in the FetchedLedger view (Q9).
 */
export function resolveMilestoneView(
  milestonesLedger: Ledger,
  milestoneId: string,
): ResolvedMilestone | null {
  if (milestonesLedger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `resolveMilestoneView expects the milestones ledger, got ${milestonesLedger.id}`,
    );
  }
  const group = milestonesLedger.milestones.find(
    (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
  );
  if (group === undefined) return null;
  const item = group.items.find((it) => it.id === milestoneId);
  if (item === undefined) return null;
  const titleField = item.fields["title"];
  const descriptionField = item.fields["description"];
  return {
    id: item.id,
    status: item.status,
    title: typeof titleField === "string" ? titleField : "",
    description: typeof descriptionField === "string" ? descriptionField : "",
  };
}

/**
 * Verify the strict-existence rule (Q5) for `milestoneId`. Throws
 * MilestoneItemNotFoundError if it is absent, archived, or terminal.
 * Returns the resolved view on success.
 */
export function assertMilestoneActive(
  milestonesLedger: Ledger,
  milestoneId: string,
): ResolvedMilestone {
  if (milestonesLedger.id !== MILESTONES_LEDGER) {
    throw new BootstrapViolationError(
      `assertMilestoneActive expects the milestones ledger, got ${milestonesLedger.id}`,
    );
  }
  // Archived?
  if (milestonesLedger.archivePointers.some((p) => p.id === milestoneId)) {
    throw new MilestoneItemNotFoundError(milestoneId, "archived");
  }
  const view = resolveMilestoneView(milestonesLedger, milestoneId);
  if (view === null) {
    throw new MilestoneItemNotFoundError(milestoneId, "absent");
  }
  if (milestonesLedger.schema.terminalStatuses.includes(view.status)) {
    throw new MilestoneItemNotFoundError(milestoneId, "terminal");
  }
  return view;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertStatusAllowed(ledger: Ledger, status: string): void {
  if (!ledger.schema.statusValues.includes(status)) {
    throw new InvalidStatusError(status, ledger.schema.statusValues);
  }
}

/**
 * F1: enforce the declarative transition guard for a `from → to` status
 * change. No-op when the schema declares no `transitions` map (back-compat).
 * A from-status with no entry in the map has no permitted outgoing
 * transitions. Callers must only invoke this when `from !== to`.
 */
function assertTransitionAllowed(
  ledger: Ledger,
  itemId: string,
  from: string,
  to: string,
): void {
  const transitions = ledger.schema.transitions;
  if (transitions === undefined) return;
  const allowed = transitions[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(ledger.id, itemId, from, to, allowed);
  }
}

function validateFields(
  ledger: Ledger,
  fields: Record<string, FieldValue>,
  creating: boolean,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const spec = ledger.schema.fields[name];
    if (spec === undefined) {
      throw new SchemaValidationError(`unknown field "${name}" for ledger ${ledger.id}`);
    }
    assertFieldType(name, spec, value);
  }
  if (creating) {
    for (const [name, spec] of Object.entries(ledger.schema.fields)) {
      if (spec.required && fields[name] === undefined) {
        throw new MissingRequiredFieldError(name);
      }
    }
  }
}

function assertFieldType(name: string, spec: FieldSpec, value: FieldValue): void {
  switch (spec.type) {
    case "string":
    case "id":
      if (typeof value !== "string") {
        throw new SchemaValidationError(`field "${name}" must be a string`);
      }
      return;
    case "string[]":
    case "id[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new SchemaValidationError(`field "${name}" must be a string[]`);
      }
      return;
    case "timestamp":
      if (typeof value !== "string" || !isIsoTimestamp(value)) {
        throw new SchemaValidationError(
          `field "${name}" must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`,
        );
      }
      return;
  }
}

/** Per-ledger caller-supplied-id regex: `^<prefix>\d+$`. */
function perPrefixIdRe(prefix: string): RegExp {
  // prefix is validated against ID_PREFIX_RE upstream, so it has no regex
  // metacharacters; concatenation is safe.
  return new RegExp(`^${prefix}(\\d+)$`);
}

/**
 * Enforce that a caller-supplied item id begins with the ledger's prefix
 * followed by digits. The milestones ledger's bootstrap id `M-AMBIENT` is
 * the single exception (§8a/§8b). Refuses cross-prefix supply such as
 * `create_item('tasks', …, id:'D5')`.
 */
function assertItemIdMatchesPrefix(ledger: Ledger, id: string, prefix: string): void {
  if (ledger.id === MILESTONES_LEDGER && id === MILESTONES_AMBIENT_ID) return;
  if (!perPrefixIdRe(prefix).test(id)) {
    throw new CrossPrefixIdError(id, ledger.id, prefix);
  }
}

function itemIdExists(ledger: Ledger, id: string): boolean {
  for (const m of ledger.milestones) for (const it of m.items) if (it.id === id) return true;
  // Don't check archived items — once a milestone is archived its ids are
  // out of the active namespace. The counter alone prevents reuse in
  // newly-issued ids.
  return false;
}

function numericPart(id: string, re: RegExp): number | null {
  const m = re.exec(id);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
