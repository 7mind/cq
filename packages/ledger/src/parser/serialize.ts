/**
 * Ledger → markdown serializer.
 *
 * Hand-builds the markdown text rather than going through remark-stringify so
 * the output shape is byte-stable and lossless for the structural subset we
 * use. The resulting file parses back via `parseLedger` (round-trip
 * property tested in `parser-roundtrip.test.ts`).
 *
 * Format:
 *   ---
 *   <YAML frontmatter>
 *   ---
 *
 *   # <ledger-id>
 *
 *   ## <milestone-id> — <title>
 *
 *   <optional description paragraph>
 *
 *   ### <item-id> — <status>
 *
 *   - field: value
 *   - field: |
 *     multi-line
 *     value
 *   - field: ["a", "b"]
 */

import YAML from "yaml";
import type { FieldValue, Item, Ledger, Milestone } from "../types.js";
import {
  serializeFrontmatter,
  type ParsedFrontmatter,
} from "./frontmatter.js";

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
  for (const m of ledger.milestones) {
    parts.push("\n");
    parts.push(serializeMilestone(m));
  }
  return parts.join("");
}

/**
 * Serialize a single milestone for an archive file (no frontmatter, no
 * ledger-level header).
 */
export function serializeArchive(milestone: Milestone): string {
  return serializeMilestone(milestone);
}

function serializeMilestone(m: Milestone): string {
  const parts: string[] = [];
  parts.push(`## ${m.id} ${EM_DASH} ${escapeHeadingText(m.title)}\n`);
  if (m.description.length > 0) {
    parts.push("\n");
    parts.push(`${m.description}\n`);
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
  // For numbers we emit the bare number.
  if (Array.isArray(value)) {
    // JSON-style flow array: ["a", "b"]
    const flow = JSON.stringify(value);
    return `- ${key}: ${flow}\n`;
  }
  if (typeof value === "number") {
    return `- ${key}: ${value}\n`;
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
