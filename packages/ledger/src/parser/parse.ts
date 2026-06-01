/**
 * Markdown → Ledger parser.
 *
 * Uses unified + remark-parse + remark-frontmatter to build an mdast Root,
 * then walks the children to extract milestones and items.
 *
 * Recognised structure (msunify cycle — all other nodes are ignored):
 *   - one `yaml` frontmatter node (required for active ledgers; absent for archives)
 *   - one `heading` depth=1 with the ledger id (optional; informational only)
 *   - zero or more `heading` depth=2 → milestone-groups
 *       - In the bootstrapped `milestones` ledger (isMilestonesLedger=true):
 *         exactly one depth-2 group with the literal header `## active`
 *         (§8d). Any other shape (id form, em-dash) is rejected.
 *       - In every other ledger (isMilestonesLedger=false): the depth-2
 *         heading is bare `## <id>` with NO title or description. Em-dash
 *         is REJECTED (catches leftover legacy `## M3 — title` fixtures
 *         with a clear error pointing at the msunify migration).
 *       - optional `paragraph` immediately after → description (milestones
 *         ledger only; ignored elsewhere).
 *       - zero or more `heading` depth=3 "### <id> — <status>" → items
 *           - one `list` (unordered) with `listItem` children of "key: value"
 *
 * Multi-line string values are decoded from YAML block-scalar form (|).
 * Array values are decoded from JSON flow form (["a","b"]).
 * The two intrinsic fields `createdAt` / `updatedAt` are extracted out of
 * the field map onto `Item.createdAt` / `Item.updatedAt`; both are ISO 8601
 * UTC strings (ms precision). The parser validates the ISO shape via
 * `ISO_TIMESTAMP_RE` + `Date.parse` round-trip and rejects everything else.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import type {
  Root,
  Heading,
  Paragraph,
  Yaml,
  List,
  RootContent,
  PhrasingContent,
  Text,
} from "mdast";

import type {
  FieldValue,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../types.js";
import { SchemaValidationError } from "../types.js";
import { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";
import {
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  isIsoTimestamp,
} from "../constants.js";

const EM_DASH = "—";

export interface ParseOpts {
  /** Schema for the ledger (sourced from ledgers.yaml). Required for active files. */
  schema: LedgerSchema;
  /**
   * True iff parsing the canonical `milestones` ledger. Switches the
   * depth-2 header grammar:
   *   - true  → exactly one group, literal header `## active` (§8d).
   *   - false → bare `## <id>`; em-dash REJECTED.
   * Defaults to false for back-compat with callers that pass only `schema`.
   */
  isMilestonesLedger?: boolean;
}

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

function parseMarkdown(source: string): Root {
  // remarkParse is typed to return a Root via the unified processor.
  return processor.parse(source) as Root;
}

/**
 * Parse a full ledger markdown file (with frontmatter).
 */
export function parseLedger(source: string, opts: ParseOpts): Ledger {
  const root = parseMarkdown(source);
  const fm = extractFrontmatter(root);
  if (fm === null) {
    throw new SchemaValidationError("ledger file is missing YAML frontmatter");
  }
  const isMilestonesLedger = opts.isMilestonesLedger === true;
  const milestones = extractMilestones(root, { isMilestonesLedger }, source);
  if (isMilestonesLedger) {
    // §8d shape assertion: exactly one depth-2 group, header `## active`.
    if (milestones.length !== 1) {
      throw new SchemaValidationError(
        `milestones ledger must contain exactly one depth-2 group, got ${milestones.length}`,
      );
    }
    const m = milestones[0];
    if (m === undefined || m.id !== MILESTONES_ACTIVE_GROUP_ID) {
      throw new SchemaValidationError(
        `milestones ledger's depth-2 group must be the literal "## ${MILESTONES_ACTIVE_GROUP_TITLE}"`,
      );
    }
  }
  return {
    id: fm.ledger,
    schema: opts.schema,
    counters: fm.counters,
    milestones,
    archivePointers: fm.archives,
  };
}

/**
 * Parse a per-milestone archive file (one depth-2 group, no frontmatter).
 * Used for archived milestone-groups in non-milestones ledgers: those
 * carry items but the depth-2 header is bare `## <id>`.
 */
export function parseArchive(source: string): Milestone {
  const root = parseMarkdown(source);
  // Archive files for non-milestones ledgers use the bare-id depth-2 shape.
  const milestones = extractMilestones(root, { isMilestonesLedger: false }, source);
  if (milestones.length === 0) {
    throw new SchemaValidationError("archive file contains no milestone");
  }
  if (milestones.length > 1) {
    throw new SchemaValidationError(
      `archive file must contain exactly one milestone, got ${milestones.length}`,
    );
  }
  // We just confirmed length === 1, so [0] is safe (noUncheckedIndexedAccess).
  const m = milestones[0];
  if (m === undefined) {
    // Defensive — unreachable.
    throw new SchemaValidationError("archive file contains no milestone");
  }
  return m;
}

/**
 * Parse a per-milestone-item archive file (single archived item from the
 * milestones ledger). Shape: a single depth-3 heading `### M<n> — <status>`
 * followed by the field list. No depth-2 wrapper, no frontmatter.
 *
 * Internally implemented by wrapping the body under a synthetic
 * `## active` group so the same extractor can be reused; the returned
 * single Item carries milestoneId="active".
 */
export function parseMilestoneItemArchive(source: string): Item {
  // Inject the synthetic depth-2 wrapper (the literal `## active` header
  // the §8d milestones-ledger grammar expects) so the extractor can
  // recognise the depth-3 item heading. The wrapper does not appear on
  // disk; archive files contain only the depth-3 item.
  const wrapped = `## ${MILESTONES_ACTIVE_GROUP_TITLE}\n\n${source}`;
  const root = parseMarkdown(wrapped);
  const milestones = extractMilestones(root, { isMilestonesLedger: true }, wrapped);
  const group = milestones[0];
  if (group === undefined) {
    throw new SchemaValidationError("milestone-item archive file is empty");
  }
  if (group.items.length !== 1) {
    throw new SchemaValidationError(
      `milestone-item archive must contain exactly one item, got ${group.items.length}`,
    );
  }
  const item = group.items[0];
  if (item === undefined) {
    throw new SchemaValidationError("milestone-item archive is empty");
  }
  return item;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function extractFrontmatter(root: Root): ParsedFrontmatter | null {
  for (const node of root.children) {
    if (node.type === "yaml") {
      return parseFrontmatter((node as Yaml).value);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Milestones + Items
// ---------------------------------------------------------------------------

function extractMilestones(
  root: Root,
  opts: { isMilestonesLedger: boolean },
  source: string,
): Milestone[] {
  const milestones: Milestone[] = [];
  let current: Milestone | null = null;
  let currentDescriptionParts: string[] = [];
  let descriptionLocked = false;
  let currentItem: Item | null = null;

  const finalizeItem = (): void => {
    if (currentItem !== null && current !== null) {
      current.items.push(currentItem);
      currentItem = null;
    }
  };
  const finalizeMilestone = (): void => {
    finalizeItem();
    if (current !== null) {
      // Description is only meaningful in the milestones ledger; for
      // non-milestones ledgers the depth-2 heading is bare so any
      // intervening paragraph is treated as inert prose (still ignored).
      if (opts.isMilestonesLedger) {
        current.description = currentDescriptionParts.join("\n\n").trim();
      } else {
        current.description = "";
      }
      milestones.push(current);
      current = null;
      currentDescriptionParts = [];
      descriptionLocked = false;
    }
  };

  for (const node of root.children) {
    if (node.type === "heading") {
      const h = node as Heading;
      if (h.depth === 1) {
        // ledger-level header, ignored
        continue;
      }
      if (h.depth === 2) {
        finalizeMilestone();
        const rawText = headingText(h);
        if (opts.isMilestonesLedger) {
          // §8d: the milestones ledger's single depth-2 header is the
          // literal `## active` (no id form, no em-dash). Reject any other
          // shape (e.g. legacy `## M0 — active` / `## M<id> — title`).
          if (rawText.trim() !== MILESTONES_ACTIVE_GROUP_TITLE) {
            throw new SchemaValidationError(
              `milestones ledger depth-2 heading must be the literal "## ${MILESTONES_ACTIVE_GROUP_TITLE}"; got: "${rawText.trim()}". The canon cycle (§8d) dropped the id-shaped "## M0 — active" group label.`,
            );
          }
          current = {
            id: MILESTONES_ACTIVE_GROUP_ID,
            title: MILESTONES_ACTIVE_GROUP_TITLE,
            description: "",
            items: [],
          };
        } else {
          // Non-milestones ledger: bare ID; em-dash REJECTED with a
          // clear migration-pointer error so leftover legacy fixtures
          // surface immediately.
          if (rawText.includes(EM_DASH)) {
            throw new SchemaValidationError(
              `non-milestones ledger depth-2 heading must be bare "## <id>" (no title); got: "${rawText.trim()}". The msunify cycle moved milestone titles + descriptions to the milestones ledger; rewrite the fixture.`,
            );
          }
          const id = rawText.trim();
          current = { id, title: "", description: "", items: [] };
        }
        currentDescriptionParts = [];
        descriptionLocked = false;
        continue;
      }
      if (h.depth === 3) {
        if (current === null) {
          throw new SchemaValidationError(
            `item heading "${headingText(h)}" found outside any milestone`,
          );
        }
        finalizeItem();
        descriptionLocked = true;
        const { id, rest } = splitHeading(headingText(h));
        currentItem = {
          id,
          milestoneId: current.id,
          status: rest,
          fields: {},
          createdAt: "",
          updatedAt: "",
        };
        continue;
      }
      // depth >= 4: ignored.
      continue;
    }
    if (node.type === "paragraph") {
      if (currentItem === null && current !== null && !descriptionLocked) {
        currentDescriptionParts.push(paragraphText(node as Paragraph));
      }
      // Paragraphs inside an item's body are ignored (fields live in the list).
      continue;
    }
    if (node.type === "list" && currentItem !== null) {
      descriptionLocked = true;
      applyItemFields(currentItem, node as List, source);
      continue;
    }
    // Other node types are ignored.
    void (node as RootContent);
  }
  finalizeMilestone();
  return milestones;
}

/**
 * Decode an item's fields from the RAW source span of its field list.
 *
 * We deliberately do NOT reconstruct values from the mdast tree: remark
 * flattens inline markdown (`*em*`, `` `code` ``, `[links](url)`) to plain
 * text and turns multi-line block-scalar bodies into headings/lists/code
 * nodes, which loses markup, structure, and blank lines. Instead we slice the
 * original source for the list (via its node position) and hand-parse the
 * serializer's strictly line-based format — making field values lossless,
 * including arbitrary markdown.
 */
function applyItemFields(item: Item, list: List, source: string): void {
  const pos = list.position;
  if (pos === undefined) {
    // Positions are always present with remark-parse; defensive guard only.
    throw new SchemaValidationError("internal: list node is missing source position");
  }
  const raw = source.slice(pos.start.offset, pos.end.offset);
  for (const { key, value } of parseFieldsFromRaw(raw)) {
    if (key === "createdAt" || key === "updatedAt") {
      if (typeof value !== "string" || !isIsoTimestamp(value)) {
        throw new SchemaValidationError(
          `field "${key}" must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ); got ${JSON.stringify(value)}`,
        );
      }
      if (key === "createdAt") item.createdAt = value;
      else item.updatedAt = value;
      continue;
    }
    if (key === "author" || key === "session") {
      // Intrinsic provenance — free-form string, lifted off the field map onto
      // the Item (mirrors createdAt/updatedAt; no timestamp validation).
      if (typeof value !== "string") {
        throw new SchemaValidationError(`field "${key}" must be a string; got ${JSON.stringify(value)}`);
      }
      item[key] = value;
      continue;
    }
    item.fields[key] = value;
  }
}

// A field line: `- key: <rest>` with the marker at column 0. Block-scalar
// continuation lines are indented (≥1 space) and therefore never match.
const FIELD_LINE_RE = /^- ([A-Za-z_][A-Za-z0-9_]*):[ \t]?(.*)$/;
const BLOCK_SCALAR_INDENT = "    "; // serializer indents block-scalar bodies 4 spaces

/**
 * Parse the serializer's line-based field list from raw source. Mirrors
 * `serializeFieldLine`:
 *   - `- key: value`            → bare inline string
 *   - `- key: "json string"`    → JSON-decoded string (quoting was applied)
 *   - `- key: ["a","b"]`        → JSON flow array (string[])
 *   - `- key: |` + indented     → multi-line string (4-space indent stripped)
 */
function parseFieldsFromRaw(raw: string): Array<{ key: string; value: FieldValue }> {
  const lines = raw.split("\n");
  const out: Array<{ key: string; value: FieldValue }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = FIELD_LINE_RE.exec(line);
    if (m === null) {
      i += 1;
      continue;
    }
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();

    if (rest === "|") {
      // Block scalar: take following lines (de-indented) until the next field
      // marker or end. Blank lines (emitted as the bare indent) are preserved.
      const body: string[] = [];
      i += 1;
      while (i < lines.length && FIELD_LINE_RE.exec(lines[i] ?? "") === null) {
        const bl = lines[i] ?? "";
        body.push(bl.startsWith(BLOCK_SCALAR_INDENT) ? bl.slice(BLOCK_SCALAR_INDENT.length) : bl);
        i += 1;
      }
      // Drop the single trailing newline the block-scalar form adds.
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      out.push({ key, value: body.join("\n") });
      continue;
    }

    i += 1;
    if (rest.startsWith("[")) {
      try {
        const arr: unknown = JSON.parse(rest);
        if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
          throw new Error("not a string[]");
        }
        out.push({ key, value: arr as string[] });
      } catch (e) {
        throw new SchemaValidationError(
          `field "${key}" has invalid array value: ${rest} (${(e as Error).message})`,
        );
      }
      continue;
    }
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
      try {
        const decoded = JSON.parse(rest) as unknown;
        if (typeof decoded === "string") {
          out.push({ key, value: decoded });
          continue;
        }
      } catch {
        // fall through to bare string
      }
    }
    out.push({ key, value: rest });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headingText(h: Heading): string {
  return h.children.map(phrasingText).join("");
}

function paragraphText(p: Paragraph): string {
  return p.children.map(phrasingText).join("");
}

function phrasingText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return (node as Text | { value: string }).value;
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
      return (node.children as PhrasingContent[]).map(phrasingText).join("");
    case "break":
      return "\n";
    case "html":
      return (node as { value: string }).value;
    case "image":
      return "";
    case "imageReference":
      return "";
    case "linkReference":
      return (node.children as PhrasingContent[]).map(phrasingText).join("");
    case "footnoteReference":
      return "";
    default:
      // Forward-compat: unknown phrasing nodes contribute nothing.
      return "";
  }
}

function splitHeading(text: string): { id: string; rest: string } {
  const trimmed = text.trim();
  // Expected form: "<id> — <rest>"
  const dashIdx = trimmed.indexOf(EM_DASH);
  if (dashIdx < 0) {
    // Tolerate "<id> - <rest>" or plain id.
    const m = /^(\S+)\s*-\s*(.+)$/.exec(trimmed);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      return { id: m[1], rest: m[2].trim() };
    }
    return { id: trimmed, rest: "" };
  }
  const id = trimmed.slice(0, dashIdx).trim();
  const rest = trimmed.slice(dashIdx + EM_DASH.length).trim();
  return { id, rest };
}
