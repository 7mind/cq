/**
 * Status → semantic bucket, derived from the ledger schema. Mirror of the
 * TUI's status helper (packages/ledger-tui/src/status.ts) — kept as a small
 * duplicate rather than a shared module because the two frontends ship
 * independently and render colors differently (CSS class here, ink color name
 * there). The bucket maps to a `lw-status-<bucket>` CSS class.
 */

import type { LedgerSchema } from "./types.js";

export type StatusBucket = "start" | "progress" | "ready" | "blocked" | "done" | "dropped" | "warning";

/**
 * Canonical StatusBucket → hex color palette. THE single source of truth for
 * bucket colors in the web package: the stylesheet mirrors these as
 * `--lw-status-<bucket>` custom properties on :root (CSS badges read those),
 * and the SVG graph (T53) reads BUCKET_HEX directly because an SVG `fill` can't
 * resolve a CSS class. Keep both copies in sync — the values here are the
 * authority. Exhaustive over the StatusBucket union (asserted in tests).
 */
export const BUCKET_HEX: Record<StatusBucket, string> = {
  start: "#4ea1ff",
  progress: "#e0b341",
  // Purple: root-cause captured, fix deferred — distinct from in-progress yellow.
  ready: "#7c6af5",
  blocked: "#ef6a6a",
  done: "#57d18a",
  dropped: "#8b93a7",
  // Amber/orange for "needs changes" terminal statuses (Q34).
  warning: "#e0a341",
};

const PROGRESS = new Set(["wip", "building", "planning", "in-progress", "in_progress", "doing"]);
const BLOCKED = new Set(["blocked"]);
// Non-terminal "file-and-defer" status: root cause captured, awaiting fix (defects lifecycle).
const READY = new Set(["root-caused"]);
// Terminal statuses that mean "needs changes" (rendered as a warning, not green).
const WARNING = new Set(["revise"]);
// Non-terminal statuses that signal a parked/inconclusive state (rendered as warning/amber).
const WARNING_ACTIVE = new Set(["inconclusive"]);
const DROPPED = new Set([
  "abandoned",
  "withdrawn",
  "wrong",
  "superseded",
  "postponed",
  "cancelled",
  "canceled",
  "rejected",
  // defects lifecycle: decided not to fix (T118).
  "wontfix",
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
  if (READY.has(s)) return "ready";
  if (WARNING_ACTIVE.has(s)) return "warning";
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
/** Structured option list for a question; rendered as a bulleted list. */
export const SUGGESTIONS_FIELD = "suggestions";
/**
 * Fixed render order for a question's narrative fields (Q31 ANSWER, extended
 * T59): question, its context, the suggestions (bulleted option list), the
 * (highlighted) recommendation, then the answer last. The structural metadata
 * trio (milestone, status, by) renders BEFORE these. The recommendation is the
 * highlighted call-to-action; the view styles it distinctly. MIRRORED in
 * packages/ledger-tui/src/status.ts — keep the two arrays identical.
 */
export const QUESTION_FIELD_ORDER: readonly string[] = [
  QUESTION_FIELD,
  CONTEXT_FIELD,
  SUGGESTIONS_FIELD,
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
