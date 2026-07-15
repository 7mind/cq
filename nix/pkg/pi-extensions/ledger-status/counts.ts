// ledger-status: parse `cq counts` (T533) stdout and format a compact status
// line (T534, G76, decision Q257).
//
// COPY-NOT-IMPORT discipline (hard rule for pi-extensions): this module is
// standalone (store-path file outside the cq-ledgers bun workspace) and
// imports NOTHING from the ledger workspace scope or the pi coding-agent
// extension scope — the `cq counts` payload shape below is a hand-copied
// description of the ledger's computeLedgerSummaries output, not an import
// of it.
//
// `cq counts` prints `{ ledgers, counts, ledgerSummaries }`, where
// `ledgerSummaries` is an array of `{ name, itemCount, statusCounts,
// completedCount, progressTotal }` — one entry per ledger. This module only
// extracts `{ done: completedCount, total: progressTotal }` for the
// questions/tasks/defects ledgers, matched by the entry's `name` field.

/** One ledger's done/total counters, extracted from its ledgerSummaries entry. */
export interface LedgerCounts {
  readonly done: number;
  readonly total: number;
}

/** The subset of `cq counts` we render a status line for; each ledger optional. */
export interface ParsedCounts {
  readonly questions?: LedgerCounts;
  readonly tasks?: LedgerCounts;
  readonly defects?: LedgerCounts;
}

/** The three ledgers this status line covers, in Q257 display order. */
const LEDGER_NAMES = ["questions", "tasks", "defects"] as const;
type LedgerName = (typeof LEDGER_NAMES)[number];

/** Narrow an arbitrary value to a non-null object (a string-keyed record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse ONE ledgerSummaries entry's `{ completedCount, progressTotal }` into a
 * `LedgerCounts`. `name` is used only for error messages. Mirrors the
 * defensive style of auto-driver/oracle.ts `parseVerdict` — throw on a
 * malformed field, never silently default it.
 */
function parseLedgerCounts(raw: unknown, name: string): LedgerCounts {
  if (!isRecord(raw)) {
    throw new Error(`ledgerSummaries entry "${name}" is not an object: ${JSON.stringify(raw)}`);
  }
  const { completedCount, progressTotal } = raw;
  if (typeof completedCount !== "number") {
    throw new Error(
      `ledgerSummaries entry "${name}".completedCount is not a number: ${JSON.stringify(completedCount)}`,
    );
  }
  if (typeof progressTotal !== "number") {
    throw new Error(
      `ledgerSummaries entry "${name}".progressTotal is not a number: ${JSON.stringify(progressTotal)}`,
    );
  }
  return { done: completedCount, total: progressTotal };
}

/**
 * Parse the `cq counts` stdout JSON into a `ParsedCounts` covering the
 * questions/tasks/defects ledgers. Throws on malformed JSON, a non-object
 * payload, or a missing/mistyped `ledgerSummaries` array, and on a malformed
 * entry (non-object, or a non-string `name`). A ledger that is simply ABSENT
 * from `ledgerSummaries` (e.g. not yet created in this ledger root) is
 * OMITTED from the result rather than throwing.
 */
export function parseCounts(stdout: string): ParsedCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`cq counts stdout is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`cq counts stdout is not a JSON object: ${stdout}`);
  }
  const ledgerSummaries = parsed["ledgerSummaries"];
  if (!Array.isArray(ledgerSummaries)) {
    throw new Error(`cq counts stdout has no "ledgerSummaries" array: ${stdout}`);
  }
  const byName = new Map<string, unknown>();
  for (const entry of ledgerSummaries) {
    if (!isRecord(entry)) {
      throw new Error(`ledgerSummaries entry is not an object: ${JSON.stringify(entry)}`);
    }
    const name = entry["name"];
    if (typeof name !== "string") {
      throw new Error(`ledgerSummaries entry.name is not a string: ${JSON.stringify(name)}`);
    }
    byName.set(name, entry);
  }
  const result: { -readonly [K in LedgerName]?: LedgerCounts } = {};
  for (const name of LEDGER_NAMES) {
    const entry = byName.get(name);
    if (entry === undefined) continue; // tolerate an absent ledger: omit it
    result[name] = parseLedgerCounts(entry, name);
  }
  return result;
}

/** Segment label per ledger, in Q257 display order. */
const SEGMENT_LABELS: Record<LedgerName, string> = {
  questions: "Q",
  tasks: "T",
  defects: "D",
};

/**
 * Format the compact single-line status per decision Q257, e.g.
 * `Q 3/12  T 5/20  D 1/4`: one `<label> <done>/<total>` segment per ledger
 * present in `counts` (questions/tasks/defects order), joined by two spaces.
 * A ledger absent from `counts` is OMITTED entirely (not rendered as `0/0`);
 * a ledger with a genuine zero total renders as `0/0`.
 */
export function formatStatus(counts: ParsedCounts): string {
  const segments: string[] = [];
  for (const name of LEDGER_NAMES) {
    const c = counts[name];
    if (c === undefined) continue;
    segments.push(`${SEGMENT_LABELS[name]} ${c.done}/${c.total}`);
  }
  return segments.join("  ");
}
