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
  // F1 transition guard. statuses: open, done(terminal), postponed, blocked.
  // open is the working state; postponed/blocked are reversible holds that
  // return to open and may also move directly between each other; any
  // non-terminal state may complete to done. `done` is terminal (no outgoing
  // transitions).
  transitions: {
    open: ["done", "postponed", "blocked"],
    postponed: ["open", "done", "blocked"],
    blocked: ["open", "done", "postponed"],
    done: [],
  },
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
/** The `questions` field whose content gates the `answered` transition (D29). */
export const QUESTIONS_ANSWER_FIELD = "answer" as const;
export const REVIEWS_LEDGER = "reviews" as const;
export const HANDOFFS_LEDGER = "handoffs" as const;
export const IDEAS_LEDGER = "ideas" as const;

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

/**
 * §2 — defects ledger.
 *
 * Locked defect lifecycle (Q66/Q67):
 *   open → wip → {root-caused | inconclusive} → resolved | wontfix
 *
 * - `open` is intake; it may move only to `wip` or straight to a terminal
 *   (resolved/wontfix). It does NOT reach `root-caused` or `inconclusive`
 *   directly — those investigation outcomes are reachable ONLY from `wip`.
 * - `root-caused` is the queryable file-and-defer gate: the root cause is
 *   captured (in the free-text `rootCause` field, no markers) and the fix
 *   deferred; it resolves, is abandoned (wontfix), or returns to `wip`.
 * - `inconclusive` is a re-openable hold: investigation did not converge, so
 *   it either goes back to `wip` or is abandoned (wontfix).
 * - `resolved` and `wontfix` are terminal (no outgoing transitions).
 */
export const DEFECTS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "wip", "root-caused", "inconclusive", "resolved", "wontfix"],
  terminalStatuses: ["resolved", "wontfix"],
  idPrefix: "D",
  // F1 transition guard. Q67 VERBATIM: open reaches only wip + the two
  // terminals (NO open→root-caused, NO open→inconclusive). root-caused and
  // inconclusive are reachable ONLY from wip; both may loop back to wip.
  transitions: {
    open: ["wip", "resolved", "wontfix"],
    wip: ["root-caused", "inconclusive", "resolved", "wontfix"],
    "root-caused": ["resolved", "wontfix", "wip"],
    inconclusive: ["wip", "wontfix"],
    resolved: [],
    wontfix: [],
  },
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    rootCause: { type: "string", required: false },
    suggestedFix: { type: "string", required: false },
    fix: { type: "string", required: false },
    severity: { type: "string", required: true },
    /** Repo-relative paths to session log files (docs/logs/<ts>-<agent-id>.md). */
    sessionLogs: { type: "string[]", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §3 — tasks ledger. */
export const TASKS_SCHEMA: LedgerSchema = {
  statusValues: ["planned", "wip", "done", "blocked", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  idPrefix: "T",
  // F1 transition guard. The proposed map omitted the `blocked` status the
  // schema declares; `blocked` is folded in as a reversible hold reachable
  // from planned/wip and returning to either, with terminal states
  // (done/abandoned) reachable from any non-terminal state.
  transitions: {
    planned: ["wip", "blocked", "done", "abandoned"],
    wip: ["blocked", "done", "abandoned"],
    blocked: ["planned", "wip", "done", "abandoned"],
    done: [],
    abandoned: [],
  },
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    acceptance: { type: "string", required: false },
    planDoc: { type: "string", required: false },
    resultCommit: { type: "string", required: false },
    completion: { type: "string", required: false },
    severity: { type: "string", required: false },
    /** Repo-relative paths to session log files (docs/logs/<ts>-<agent-id>.md). */
    sessionLogs: { type: "string[]", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §4 — hypothesis ledger. */
export const HYPOTHESIS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "uncertain", "confirmed", "wrong"],
  terminalStatuses: ["confirmed", "wrong"],
  idPrefix: "H",
  // F1 transition guard. open → uncertain/confirmed/wrong; uncertain →
  // confirmed/wrong; confirmed/wrong are terminal.
  transitions: {
    open: ["uncertain", "confirmed", "wrong"],
    uncertain: ["confirmed", "wrong"],
    confirmed: [],
    wrong: [],
  },
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    rationale: { type: "string", required: false },
    parentHypothesis: { type: "id", required: false },
    evidence: { type: "string[]", required: false },
    /** Repo-relative paths to session log files (docs/logs/<ts>-<agent-id>.md). */
    sessionLogs: { type: "string[]", required: false },
    ...COMMON_REF_FIELDS,
  },
};

/** §5 — questions ledger. */
export const QUESTIONS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "answered", "withdrawn"],
  terminalStatuses: ["answered", "withdrawn"],
  idPrefix: "Q",
  // F1 transition guard. open → answered/withdrawn; both are terminal.
  transitions: {
    open: ["answered", "withdrawn"],
    answered: [],
    withdrawn: [],
  },
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
  // F1 transition guard. proposed → locked/superseded. Both locked and
  // superseded are terminal, so locked carries no outgoing transitions.
  transitions: {
    proposed: ["locked", "superseded"],
    locked: [],
    superseded: [],
  },
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
  // F1 transition guard. clarifying → planning → planned → building → done,
  // with abandoned reachable from each non-terminal state; planning may loop
  // back to clarifying. `planned` and `building` may RE-OPEN to `planning` so
  // /cq:plan:follow-up can add scope to an already-planned/in-progress goal (the
  // command then steps planning → clarifying for the clarify-first round).
  // done/abandoned stay terminal (a terminal status must have no outgoing
  // transitions), so a fully-finished goal takes new scope via a fresh linked
  // goal, not by re-opening.
  transitions: {
    clarifying: ["planning", "abandoned"],
    planning: ["clarifying", "planned", "abandoned"],
    planned: ["building", "abandoned", "planning"],
    building: ["done", "abandoned", "planning"],
    done: [],
    abandoned: [],
  },
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: true },
    milestones: { type: "id[]", required: false },
    // Project-grounding summary the producer captures after exploring the repo
    // ONCE (PLAN-EXPLORE-01). Persisted here so it survives a restart and every
    // later phase re-reads it from the durable goal instead of re-exploring.
    grounding: { type: "string", required: false },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
    /** Repo-relative paths to session log files (docs/logs/<ts>-<agent-id>.md). */
    sessionLogs: { type: "string[]", required: false },
  },
};

/**
 * F3 — reviews ledger. The plan-flow's adversarial reviewer records its
 * verdict here as a schema-validated item whose `status` IS the verdict.
 * Both verdict statuses are terminal: a review is an immutable record of one
 * round's outcome, so neither carries an outgoing transition (the empty
 * transition maps satisfy the D02 "terminal statuses have no outgoing edges"
 * rule, consistent with how the other terminal-only states are declared). The
 * review is linked to its goal via the common `ledgerRefs` field as
 * `"goals:<G>"`. idPrefix R (M/D/T/H/Q/K/G are taken).
 */
export const REVIEWS_SCHEMA: LedgerSchema = {
  statusValues: ["go-ahead", "revise"],
  terminalStatuses: ["go-ahead", "revise"],
  idPrefix: "R",
  transitions: {
    "go-ahead": [],
    revise: [],
  },
  fields: {
    summary: { type: "string", required: false },
    new_questions: { type: "string[]", required: false },
    criticism: { type: "string[]", required: false },
    ledgerRefs: { type: "id[]", required: false },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
    /** Repo-relative paths to session log files (docs/logs/<ts>-<agent-id>.md). */
    sessionLogs: { type: "string[]", required: false },
  },
};

/**
 * Handoffs ledger — records implement-flow / plan-flow session handoffs.
 * The item `status` IS the handoff outcome; all four statuses are terminal
 * (a handoff is an immutable record of one session's exit state).
 * idPrefix HO — distinct from the existing single-char prefixes M/D/T/H/Q/K/G/R.
 *
 * statusValues:
 *   - drained: the session processed all available DAG-ready tasks to completion.
 *   - answers-required: the session stopped because one or more blocking questions
 *     need user answers before progress can resume.
 *   - mixed: the session stopped for multiple reasons (e.g. both drained and
 *     answers-required); see `handoffReasons` for the exact mix (per Q83).
 *   - illness-detected: a defect or invariant violation was detected that the
 *     session could not resolve autonomously.
 *   - user-action-required: the session stopped because a manual user action
 *     (outside question answering) is needed before work can resume.
 *
 * Fields are bespoke (NOT spread from COMMON_REF_FIELDS):
 *   - summary: human-readable handoff summary (required).
 *   - flow: which flow produced this handoff — advance | plan | implement |
 *     investigate. String-typed (not enum-enforced at schema level).
 *   - ledgerRefs: advisory cross-references to ledger items (e.g. tasks:T42).
 *   - blockingQuestions: ids of questions preventing progress.
 *   - handoffReasons: explains a `mixed` stop (e.g. ["drained","answers-required"]).
 *   - sessionLogs: paths or inline excerpts of session logs.
 *   - tags: free-form tags.
 *   - sourceRefs: source file / commit / URL references.
 */
export const HANDOFFS_SCHEMA: LedgerSchema = {
  statusValues: ["drained", "answers-required", "mixed", "illness-detected", "user-action-required"],
  terminalStatuses: ["drained", "answers-required", "mixed", "illness-detected", "user-action-required"],
  idPrefix: "HO",
  transitions: {
    drained: [],
    "answers-required": [],
    mixed: [],
    "illness-detected": [],
    "user-action-required": [],
  },
  fields: {
    summary: { type: "string", required: true },
    flow: { type: "string", required: false },
    ledgerRefs: { type: "id[]", required: false },
    blockingQuestions: { type: "id[]", required: false },
    handoffReasons: { type: "string[]", required: false },
    sessionLogs: { type: "string[]", required: false },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
  },
};

/**
 * ideas ledger (Q188). idPrefix `I` — verified FREE against every existing
 * single/double-char prefix in the canon (M/D/T/H/Q/K/G/R/HO).
 *
 * Lifecycle (DECIDED): an idea is captured `open`, then either parked
 * (`postponed`, a reversible hold that returns to `open`), consumed
 * (`planned`), or dropped (`discarded`).
 *
 * Terminal statuses are `planned` AND `discarded`:
 *   - `planned` IS terminal — the consume-an-idea flow moves a consumed idea
 *     to `planned` once its goal has been seeded, and it must STAY there (the
 *     idea is spent; its continuation lives in the seeded goal, not back in the
 *     ideas list). A terminal status carries no outgoing transitions.
 *   - `discarded` is terminal — the idea is abandoned.
 *   - `postponed` is NON-terminal — a reversible hold that returns to `open`
 *     (and may also still be consumed/discarded directly).
 *   - `open` is the non-terminal working state.
 *
 * transitions:
 *   open      → [planned, discarded, postponed]
 *   postponed → [open, planned, discarded]
 *   planned   → []   (terminal)
 *   discarded → []   (terminal)
 *
 * Milestone-attachment model (RECONCILE "no per-idea milestone" with the
 * unified-milestones design): ideas DO NOT get a milestone of their own and
 * carry no required milestone field beyond the ambient attachment. Like goals
 * (T83), every idea attaches to the immortal bootstrap milestone
 * `M-AMBIENT` (`MILESTONES_AMBIENT_ID`) and renders as a FLAT list — there is
 * no per-idea user milestone. The schema therefore declares only `title`
 * (required) and `description` (optional); the ambient attachment is supplied
 * by the store, not by a schema field.
 */
export const IDEAS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "planned", "discarded", "postponed"],
  terminalStatuses: ["planned", "discarded"],
  idPrefix: "I",
  transitions: {
    open: ["planned", "discarded", "postponed"],
    postponed: ["open", "planned", "discarded"],
    planned: [],
    discarded: [],
  },
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
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
  { name: REVIEWS_LEDGER, schema: REVIEWS_SCHEMA },
  { name: HANDOFFS_LEDGER, schema: HANDOFFS_SCHEMA },
  { name: IDEAS_LEDGER, schema: IDEAS_SCHEMA },
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
