/**
 * Status → semantic bucket → ink color, derived from the ledger schema.
 *
 * Statuses are per-ledger free-form strings, but the canonical ledgers use a
 * stable vocabulary and every schema declares which statuses are terminal. We
 * bucket each status into a small set of semantic categories and map those to
 * ink colors so the same status reads consistently across ledgers. A custom
 * ledger's unknown non-terminal status falls back to the neutral "start"
 * bucket; its terminal statuses still gray/green correctly via the schema.
 */

import type { LedgerSchema } from "./types.js";

export type StatusBucket = "start" | "progress" | "blocked" | "done" | "dropped" | "warning";

// Non-terminal "in progress" vocabulary across the canonical ledgers + common
// synonyms. Terminal statuses are classified via the schema, not this set.
const PROGRESS = new Set(["wip", "building", "planning", "in-progress", "in_progress", "doing"]);
const BLOCKED = new Set(["blocked"]);
// Terminal statuses that mean "needs changes" (rendered as a warning, not green).
const WARNING = new Set(["revise"]);
// Terminal statuses that mean "did not complete" (rendered muted, not green).
const DROPPED = new Set([
  "abandoned",
  "withdrawn",
  "wrong",
  "superseded",
  "postponed",
  "cancelled",
  "canceled",
  "rejected",
]);

export function isTerminal(status: string, schema: LedgerSchema): boolean {
  return schema.terminalStatuses.includes(status);
}

export function statusBucket(status: string, schema: LedgerSchema): StatusBucket {
  const s = status.toLowerCase();
  if (isTerminal(status, schema)) {
    if (WARNING.has(s)) return "warning";
    if (DROPPED.has(s)) return "dropped";
    return "done";
  }
  if (BLOCKED.has(s)) return "blocked";
  if (PROGRESS.has(s)) return "progress";
  return "start";
}

const BUCKET_COLOR: Record<StatusBucket, string> = {
  start: "cyan",
  progress: "yellow",
  blocked: "red",
  done: "green",
  dropped: "gray",
  warning: "magenta",
};

/** Ink color name for a status badge. */
export function statusColor(status: string, schema: LedgerSchema): string {
  return BUCKET_COLOR[statusBucket(status, schema)];
}

// The questions ledger's convention: a free-form `answer` field and an
// `answered` terminal status reachable from `open`. The "answer & resolve"
// affordance keys off this shape rather than the ledger name, so it lights up
// for any ledger sharing the convention.
export const ANSWER_FIELD = "answer";
export const ANSWERED_STATUS = "answered";
/** Question's recommended-answer field, and the canned "accept it" answer. */
export const RECOMMENDATION_FIELD = "recommendation";
export const AS_RECOMMENDED_ANSWER = "as recommended";
/** A question carries a free-form `question` field (data-driven, not by name). */
export const QUESTION_FIELD = "question";
export const CONTEXT_FIELD = "context";
/**
 * Fixed render order for a question's narrative fields (T23): question, its
 * context, the (highlighted) recommendation, then the answer last. Other fields
 * render as short/metadata before these.
 */
export const QUESTION_FIELD_ORDER: readonly string[] = [
  QUESTION_FIELD,
  CONTEXT_FIELD,
  RECOMMENDATION_FIELD,
  ANSWER_FIELD,
];
/** True when an item is a question (its schema declares a `question` field). */
export function isQuestion(schema: LedgerSchema): boolean {
  return QUESTION_FIELD in schema.fields;
}

/**
 * True when an item supports the one-step "answer & resolve" affordance: its
 * schema declares an `answer` field and `answered` is a legal transition from
 * the item's current status. Falls back to `statusValues` when the schema
 * declares no transition guard.
 */
export function canAnswer(schema: LedgerSchema, status: string): boolean {
  if (!(ANSWER_FIELD in schema.fields)) return false;
  const allowed = schema.transitions !== undefined ? schema.transitions[status] ?? [] : schema.statusValues;
  return allowed.includes(ANSWERED_STATUS);
}

/**
 * A view filter over item status. `active` = non-terminal, `terminal` =
 * terminal (done/closed), `status` = one exact status value.
 */
export type StatusFilter =
  | { kind: "all" }
  | { kind: "active" }
  | { kind: "terminal" }
  | { kind: "status"; value: string };

export function statusMatchesFilter(
  status: string,
  schema: LedgerSchema,
  filter: StatusFilter,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "active":
      return !isTerminal(status, schema);
    case "terminal":
      return isTerminal(status, schema);
    case "status":
      return status === filter.value;
  }
}

/** Short human label for a filter, for the header chip. Empty for "all". */
export function filterLabel(filter: StatusFilter): string {
  switch (filter.kind) {
    case "all":
      return "";
    case "active":
      return "active";
    case "terminal":
      return "terminal";
    case "status":
      return filter.value;
  }
}
