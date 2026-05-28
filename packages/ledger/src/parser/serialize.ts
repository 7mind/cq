/**
 * Ledger → markdown serializer.
 *
 * Hand-builds the markdown text rather than going through remark-stringify so
 * the output shape is byte-stable and lossless for the structural subset we
 * use. The resulting file parses back via `parseLedger` (round-trip
 * property tested in `parser-roundtrip.test.ts`).
 *
 * Format (msunify cycle):
 *   ---
 *   <YAML frontmatter>
 *   ---
 *
 *   # <ledger-id>
 *
 *   ## <milestone-id>                         (non-milestones ledgers)
 *   ## M0 — active                            (milestones ledger only)
 *
 *   <optional description paragraph — milestones ledger only>
 *
 *   ### <item-id> — <status>
 *
 *   - field: value
 *   - field: |
 *     multi-line
 *     value
 *   - field: ["a", "b"]
 *   - createdAt: 2026-05-28T20:30:00.000Z
 *   - updatedAt: 2026-05-28T20:31:00.000Z
 *
 * The `isMilestonesLedger` flag is derived from `ledger.id === MILESTONES_LEDGER`;
 * callers do not pass it explicitly.
 */

import YAML from "yaml";
import type { FieldValue, Item, Ledger, Milestone } from "../types.js";
import {
  serializeFrontmatter,
  type ParsedFrontmatter,
} from "./frontmatter.js";
import {
  ISO_TIMESTAMP_RE,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_LEDGER,
} from "../constants.js";

const EM_DASH = "—";

export function serializeLedger(ledger: Ledger): string {
  const fm: ParsedFrontmatter = {
    ledger: ledger.id,
    counters: ledger.counters,
    archives: ledger.archivePointers,
  };
  const parts: string[] = [];
  parts.push("---\n");
  parts.push(serializeFrontmatter(fm));
  parts.push("---\n\n");
  parts.push(`# ${ledger.id}\n`);
  const isMilestonesLedger = ledger.id === MILESTONES_LEDGER;
  for (const m of ledger.milestones) {
    parts.push("\n");
    parts.push(serializeMilestone(m, isMilestonesLedger));
  }
  return parts.join("");
}

/**
 * Serialize a single milestone-group for a per-milestone archive file
 * (no frontmatter, no ledger-level header). Used for non-milestones
 * ledgers' archived groups.
 */
export function serializeArchive(milestone: Milestone): string {
  return serializeMilestone(milestone, /*isMilestonesLedger*/ false);
}

/**
 * Serialize a single archived milestone-item from the milestones ledger.
 * Emits just the depth-3 `### M<n> — <status>` heading and its field
 * list — no depth-2 wrapper, no frontmatter. Parses back via
 * `parseMilestoneItemArchive`.
 */
export function serializeMilestoneItemArchive(item: Item): string {
  return serializeItem(item);
}

function serializeMilestone(m: Milestone, isMilestonesLedger: boolean): string {
  const parts: string[] = [];
  if (isMilestonesLedger) {
    // Bootstrap group: always `## M0 — active`. Defensive: assert the id
    // matches; the store should never construct anything else.
    const titleForHeading =
      m.id === MILESTONES_ACTIVE_GROUP_ID
        ? MILESTONES_ACTIVE_GROUP_TITLE
        : escapeHeadingText(m.title);
    parts.push(`## ${m.id} ${EM_DASH} ${titleForHeading}\n`);
    if (m.description.length > 0) {
      parts.push("\n");
      parts.push(`${m.description}\n`);
    }
  } else {
    // Non-milestones ledger: bare ID, no title, no description.
    parts.push(`## ${m.id}\n`);
  }
  for (const item of m.items) {
    parts.push("\n");
    parts.push(serializeItem(item));
  }
  return parts.join("");
}

function serializeItem(item: Item): string {
  const parts: string[] = [];
  parts.push(`### ${item.id} ${EM_DASH} ${escapeHeadingText(item.status)}\n`);
  parts.push("\n");
  // Always emit createdAt / updatedAt so round-trip preserves them.
  parts.push(serializeFieldLine("createdAt", item.createdAt));
  parts.push(serializeFieldLine("updatedAt", item.updatedAt));
  for (const [key, value] of Object.entries(item.fields)) {
    parts.push(serializeFieldLine(key, value));
  }
  return parts.join("");
}

function serializeFieldLine(key: string, value: FieldValue): string {
  // We render as a YAML key:value pair inside a `- ` list item.
  // For strings with newlines we use the YAML block-scalar form.
  // For arrays we emit JSON flow form (YAML.stringify with flow=true).
  if (Array.isArray(value)) {
    // JSON-style flow array: ["a", "b"]
    const flow = JSON.stringify(value);
    return `- ${key}: ${flow}\n`;
  }
  // string
  if (value.includes("\n")) {
    // Multi-line: use a YAML block scalar (|) indented under the list item.
    const indented = value
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `- ${key}: |\n${indented}\n`;
  }
  // ISO 8601 timestamps contain a `:` which would normally force JSON
  // quoting via `needsQuoting`; emit them bare so the on-disk form stays
  // human-readable and round-trips cleanly (the parser strips the bare
  // value as a string).
  if (ISO_TIMESTAMP_RE.test(value)) {
    return `- ${key}: ${value}\n`;
  }
  // Inline string. Quote it if it contains characters that confuse YAML.
  if (needsQuoting(value)) {
    return `- ${key}: ${JSON.stringify(value)}\n`;
  }
  return `- ${key}: ${value}\n`;
}

function escapeHeadingText(text: string): string {
  // Replace newlines with spaces; collapse runs of whitespace; trim.
  return text.replace(/\s+/g, " ").trim();
}

function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  // Disambiguate from bool / null / number literals or YAML special starts.
  const reserved = /^(true|false|null|yes|no|on|off|~)$/i;
  if (reserved.test(s)) return true;
  if (/^[\s'"`#&*!|>%@,]/.test(s)) return true;
  if (/[:{}[\]]/.test(s)) return true;
  if (s.trim() !== s) return true;
  // Looks like a number? Quote it so it stays a string.
  if (!Number.isNaN(Number(s))) return true;
  return false;
}

// Re-export YAML usage so consumers can build their own field values.
export const _internal = { YAML };
