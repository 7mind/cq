/**
 * Status → semantic bucket, derived from the ledger schema. Mirror of the
 * TUI's status helper (packages/ledger-tui/src/status.ts) — kept as a small
 * duplicate rather than a shared module because the two frontends ship
 * independently and render colors differently (CSS class here, ink color name
 * there). The bucket maps to a `lw-status-<bucket>` CSS class.
 */

import type { LedgerSchema } from "./types.js";

export type StatusBucket = "start" | "progress" | "blocked" | "done" | "dropped";

const PROGRESS = new Set(["wip", "building", "planning", "in-progress", "in_progress", "doing"]);
const BLOCKED = new Set(["blocked"]);
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
  if (isTerminal(status, schema)) return DROPPED.has(s) ? "dropped" : "done";
  if (BLOCKED.has(s)) return "blocked";
  if (PROGRESS.has(s)) return "progress";
  return "start";
}

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
 * context, the (highlighted) recommendation, then the answer last. Any other
 * fields render as short/metadata BEFORE these. The recommendation is the
 * highlighted call-to-action; the view styles it distinctly.
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

/** Encode a filter as a stable string for a <select> value, and back. */
export function filterToValue(f: StatusFilter): string {
  return f.kind === "status" ? `status:${f.value}` : f.kind;
}

export function valueToFilter(v: string): StatusFilter {
  if (v === "all" || v === "active" || v === "terminal") return { kind: v };
  if (v.startsWith("status:")) return { kind: "status", value: v.slice("status:".length) };
  return { kind: "all" };
}
