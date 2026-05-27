/**
 * Frontmatter helpers — YAML (de)serialization of the per-ledger header.
 *
 * Schema (v1):
 *   ledger: <string>          # ledger id (matches docs/ledgers.yaml entry)
 *   counters:
 *     milestone: <int>
 *     item: <int>
 *   archives:
 *     - id: <string>
 *       path: <string>
 *       summary: <string>
 */

import YAML from "yaml";
import type { ArchivePointer, LedgerCounters } from "../types.js";
import { SchemaValidationError } from "../types.js";

export interface ParsedFrontmatter {
  ledger: string;
  counters: LedgerCounters;
  archives: ArchivePointer[];
}

export function parseFrontmatter(yamlText: string): ParsedFrontmatter {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (e) {
    throw new SchemaValidationError(`frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new SchemaValidationError("frontmatter is not a YAML map");
  }
  const obj = raw as Record<string, unknown>;
  const ledger = obj["ledger"];
  if (typeof ledger !== "string" || ledger.length === 0) {
    throw new SchemaValidationError("frontmatter.ledger must be a non-empty string");
  }
  const countersRaw = obj["counters"];
  const counters: LedgerCounters = { milestone: 0, item: 0 };
  if (countersRaw !== undefined && countersRaw !== null) {
    if (typeof countersRaw !== "object") {
      throw new SchemaValidationError("frontmatter.counters must be a map");
    }
    const c = countersRaw as Record<string, unknown>;
    if (typeof c["milestone"] === "number") counters.milestone = c["milestone"];
    if (typeof c["item"] === "number") counters.item = c["item"];
  }
  const archivesRaw = obj["archives"];
  const archives: ArchivePointer[] = [];
  if (archivesRaw !== undefined && archivesRaw !== null) {
    if (!Array.isArray(archivesRaw)) {
      throw new SchemaValidationError("frontmatter.archives must be an array");
    }
    for (const entry of archivesRaw) {
      if (entry === null || typeof entry !== "object") {
        throw new SchemaValidationError("frontmatter.archives entry must be a map");
      }
      const e = entry as Record<string, unknown>;
      const id = e["id"];
      const path = e["path"];
      const summary = e["summary"] ?? "";
      if (typeof id !== "string" || typeof path !== "string" || typeof summary !== "string") {
        throw new SchemaValidationError(
          "frontmatter.archives entry must have string {id, path, summary}",
        );
      }
      archives.push({ id, path, summary });
    }
  }
  return { ledger, counters, archives };
}

export function serializeFrontmatter(fm: ParsedFrontmatter): string {
  // Use YAML.stringify with deterministic ordering for round-trip stability.
  const obj: Record<string, unknown> = {
    ledger: fm.ledger,
    counters: { milestone: fm.counters.milestone, item: fm.counters.item },
  };
  if (fm.archives.length > 0) {
    obj["archives"] = fm.archives.map((a) => ({
      id: a.id,
      path: a.path,
      summary: a.summary,
    }));
  } else {
    obj["archives"] = [];
  }
  return YAML.stringify(obj, { lineWidth: 0 });
}
