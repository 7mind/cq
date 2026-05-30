/**
 * Stable constants for the unified-milestones design (msunify cycle).
 *
 * The "milestones" ledger is a bootstrapped, library-managed ledger that
 * holds the canonical list of cross-cutting milestones. Other ledgers
 * reference milestone IDs from it; they do not carry milestone titles
 * or descriptions themselves.
 *
 * - `MILESTONES_LEDGER` — fixed ledger name. The library refuses to
 *   `createLedger` a fresh entry under this name (it bootstraps the
 *   entry itself), and refuses to `archiveMilestone` the active group.
 * - `MILESTONES_ACTIVE_GROUP_ID` — fixed depth-2 group id inside the
 *   milestones ledger. There is exactly one such group; every milestone
 *   item (`M-AMBIENT`, `M1`, `M2`, …) lives inside it.
 * - `MILESTONES_ACTIVE_GROUP_TITLE` — fixed group title; the milestones
 *   ledger's depth-2 header is serialized/parsed as the literal
 *   `## active` (§8d — no id-shaped `## M0 — active`).
 * - `MILESTONES_SCHEMA` — canonical schema. Items use
 *   `status ∈ {open, done, postponed, blocked}` with `done` as the sole
 *   terminal status. Fields are `title`, `description`, `blockedBy`,
 *   `dependsOn` (§8c rename). The latter two are free-form id arrays
 *   (advisory cross-references; no FK enforcement).
 */

import type { LedgerSchema } from "./types.js";

export const MILESTONES_LEDGER = "milestones" as const;

/**
 * Depth-2 group id for the single active-milestones container. As of the
 * canon cycle (§8d) the on-disk header is the literal `## active` (no
 * id-shaped `## M0 — active`). This value is the in-memory group id and is
 * NOT a milestone (no `enumerate_*` ever returns it).
 */
export const MILESTONES_ACTIVE_GROUP_ID = "active" as const;

export const MILESTONES_ACTIVE_GROUP_TITLE = "active" as const;

/**
 * Bootstrap milestone id (§8b, Q-CANL-6). Created on init if missing with
 * `title: "ambient"`, status `open`. Immortal: cannot be archived or moved
 * to a terminal status. It is the single exception to the `^M\d+$` rule for
 * caller-supplied milestone ids.
 */
export const MILESTONES_AMBIENT_ID = "M-AMBIENT" as const;

export const MILESTONES_SCHEMA: LedgerSchema = {
  statusValues: ["open", "done", "postponed", "blocked"],
  terminalStatuses: ["done"],
  idPrefix: "M",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
    blockedBy: { type: "id[]", required: false },
    dependsOn: { type: "id[]", required: false },
  },
};

// ---------------------------------------------------------------------------
// Canonical ledger names (canon cycle, §8). All bootstrapped alongside
// `milestones` on init(): provisioned from their canonical schema if the
// on-disk file is missing; init refuses to start if an on-disk schema has
// diverged (same guard as milestones).
// ---------------------------------------------------------------------------

export const DEFECTS_LEDGER = "defects" as const;
export const TASKS_LEDGER = "tasks" as const;
export const HYPOTHESIS_LEDGER = "hypothesis" as const;
export const QUESTIONS_LEDGER = "questions" as const;
export const DECISIONS_LEDGER = "decisions" as const;
export const GOALS_LEDGER = "goals" as const;

/**
 * Common cross-cutting fields shared by the canonical ledgers (§1). Spread
 * into each schema's `fields`. `tags` (§1c), `suggestedModel` (§1d) are
 * soft string conventions; the id[] fields carry advisory cross-references
 * (`<ledger>:<id>` for cross-ledger) with NO referential-integrity
 * enforcement — same rule as milestones' blockedBy/dependsOn.
 */
const COMMON_REF_FIELDS = {
  sourceRefs: { type: "string[]", required: false },
  blockedBy: { type: "id[]", required: false },
  dependsOn: { type: "id[]", required: false },
  ledgerRefs: { type: "id[]", required: false },
  tags: { type: "string[]", required: false },
  suggestedModel: { type: "string", required: false },
} as const satisfies LedgerSchema["fields"];

/** §2 — defects ledger. */
export const DEFECTS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "wip", "blocked", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  idPrefix: "D",
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    rootCause: { type: "string", required: false },
    suggestedFix: { type: "string", required: false },
    fix: { type: "string", required: false },
    severity: { type: "string", required: true },
    ...COMMON_REF_FIELDS,
  },
};

/** §3 — tasks ledger. */
export const TASKS_SCHEMA: LedgerSchema = {
  statusValues: ["planned", "wip", "done", "blocked", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  idPrefix: "T",
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    acceptance: { type: "string", required: false },
    planDoc: { type: "string", required: false },
    resultCommit: { type: "string", required: false },
    completion: { type: "string", required: false },
    severity: { type: "string", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §4 — hypothesis ledger. */
export const HYPOTHESIS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "uncertain", "confirmed", "wrong"],
  terminalStatuses: ["confirmed", "wrong"],
  idPrefix: "H",
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    rationale: { type: "string", required: false },
    parentHypothesis: { type: "id", required: false },
    evidence: { type: "string[]", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §5 — questions ledger. */
export const QUESTIONS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "answered", "withdrawn"],
  terminalStatuses: ["answered", "withdrawn"],
  idPrefix: "Q",
  fields: {
    question: { type: "string", required: true },
    context: { type: "string", required: false },
    suggestions: { type: "string[]", required: false },
    recommendation: { type: "string", required: false },
    answer: { type: "string", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §5b — decisions ledger (idPrefix K, "kontract"). */
export const DECISIONS_SCHEMA: LedgerSchema = {
  statusValues: ["proposed", "locked", "superseded"],
  terminalStatuses: ["locked", "superseded"],
  idPrefix: "K",
  fields: {
    headline: { type: "string", required: true },
    rationale: { type: "string", required: false },
    alternatives: { type: "string", required: false },
    supersedes: { type: "id[]", required: false },
    landsIn: { type: "id[]", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/**
 * goals ledger (canon cycle scope item B — NOT in the design doc; schema +
 * bootstrap only this cycle, nothing consumes it yet). idPrefix G.
 */
export const GOALS_SCHEMA: LedgerSchema = {
  statusValues: ["clarifying", "planning", "planned", "building", "done", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  idPrefix: "G",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: true },
    milestones: { type: "id[]", required: false },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
  },
};

/**
 * Bootstrap manifest. `milestones` MUST be first (the others reference it
 * for milestone-group resolution). On init() every entry is provisioned if
 * its file is absent and guarded against on-disk schema divergence.
 */
export const CANONICAL_LEDGERS: ReadonlyArray<{ name: string; schema: LedgerSchema }> = [
  { name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA },
  { name: DEFECTS_LEDGER, schema: DEFECTS_SCHEMA },
  { name: TASKS_LEDGER, schema: TASKS_SCHEMA },
  { name: HYPOTHESIS_LEDGER, schema: HYPOTHESIS_SCHEMA },
  { name: QUESTIONS_LEDGER, schema: QUESTIONS_SCHEMA },
  { name: DECISIONS_LEDGER, schema: DECISIONS_SCHEMA },
  { name: GOALS_LEDGER, schema: GOALS_SCHEMA },
];

/**
 * Regex matching the ISO-8601 form that `Date.prototype.toISOString()`
 * emits — always UTC ("Z"), always millisecond precision. The store's
 * `now()` injection point returns a string of this shape; the parser /
 * serializer round-trips it; the field-validation pipeline rejects
 * everything else for `timestamp`-typed fields and for the intrinsic
 * `createdAt` / `updatedAt`.
 */
export const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validate that `value` is a string matching `ISO_TIMESTAMP_RE` AND
 * survives a `Date.parse` round-trip. Throws nothing; returns boolean.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ISO_TIMESTAMP_RE.test(value)) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // Round-trip check: parse + toISOString must yield the same string.
  // This rejects e.g. "2026-13-01T..." (which Date.parse coerces).
  return new Date(t).toISOString() === value;
}
