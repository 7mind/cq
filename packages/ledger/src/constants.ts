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
 *   entry itself), and refuses to `archiveMilestone` the bootstrap
 *   group `M0`.
 * - `MILESTONES_ACTIVE_GROUP_ID` — fixed depth-2 group id inside the
 *   milestones ledger. There is exactly one such group; every milestone
 *   item (`M1`, `M2`, …) lives inside it.
 * - `MILESTONES_ACTIVE_GROUP_TITLE` — fixed group title; used by the
 *   parser/serializer when emitting / verifying the depth-2 header
 *   `## M0 — active`.
 * - `MILESTONES_SCHEMA` — canonical schema (Q2 in the msunify brief).
 *   Items use `status ∈ {open, done, postponed, blocked}` with `done` as
 *   the sole terminal status. Fields are `title`, `description`,
 *   `blocked`, `depends`. The latter two are free-form id arrays
 *   (advisory cross-references; no FK enforcement).
 */

import type { LedgerSchema } from "./types.js";

export const MILESTONES_LEDGER = "milestones" as const;

export const MILESTONES_ACTIVE_GROUP_ID = "M0" as const;

export const MILESTONES_ACTIVE_GROUP_TITLE = "active" as const;

export const MILESTONES_SCHEMA: LedgerSchema = {
  statusValues: ["open", "done", "postponed", "blocked"],
  terminalStatuses: ["done"],
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
    blocked: { type: "id[]", required: false },
    depends: { type: "id[]", required: false },
  },
};

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
