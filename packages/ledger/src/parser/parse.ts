/**
 * Markdown → Ledger parser.
 *
 * Uses unified + remark-parse + remark-frontmatter to build an mdast Root,
 * then walks the children to extract milestones and items.
 *
 * Recognised structure (all other nodes are ignored / preserved as no-op):
 *   - one `yaml` frontmatter node (required for active ledgers; absent for archives)
 *   - one `heading` depth=1 with the ledger id (optional; informational only)
 *   - zero or more `heading` depth=2 "## <id> — <title>" → milestones
 *       - optional one or more `paragraph` immediately after → description (joined by blank lines)
 *       - zero or more `heading` depth=3 "### <id> — <status>" → items
 *           - one `list` (unordered) with `listItem` children of "key: value"
 *
 * Multi-line string values are decoded from YAML block-scalar form (|).
 * Array values are decoded from JSON flow form (["a","b"]).
 * The two synthetic fields `createdAt` / `updatedAt` are extracted out of the
 * field map onto `Item.createdAt` / `Item.updatedAt`.
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
  ListItem,
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

const EM_DASH = "—";

interface ParseOpts {
  /** Schema for the ledger (sourced from ledgers.yaml). Required for active files. */
  schema: LedgerSchema;
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
  const milestones = extractMilestones(root);
  return {
    id: fm.ledger,
    schema: opts.schema,
    counters: fm.counters,
    milestones,
    archivePointers: fm.archives,
  };
}

/**
 * Parse a single archived milestone file (no frontmatter).
 */
export function parseArchive(source: string): Milestone {
  const root = parseMarkdown(source);
  const milestones = extractMilestones(root);
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

function extractMilestones(root: Root): Milestone[] {
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
      current.description = currentDescriptionParts.join("\n\n").trim();
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
        const { id, rest } = splitHeading(headingText(h));
        current = {
          id,
          title: rest,
          description: "",
          items: [],
        };
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
          createdAt: 0,
          updatedAt: 0,
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
      applyItemFields(currentItem, node as List);
      continue;
    }
    // Other node types are ignored.
    void (node as RootContent);
  }
  finalizeMilestone();
  return milestones;
}

function applyItemFields(item: Item, list: List): void {
  for (const li of list.children) {
    if (li.type !== "listItem") continue;
    const { key, value } = parseFieldListItem(li as ListItem);
    if (key === "createdAt" && typeof value === "number") {
      item.createdAt = value;
      continue;
    }
    if (key === "updatedAt" && typeof value === "number") {
      item.updatedAt = value;
      continue;
    }
    item.fields[key] = value;
  }
}

/**
 * A list item of the form:
 *   - key: inline value
 *   - key: |
 *     multi-line
 *   - key: ["a","b"]
 *   - key: 1234567890
 *
 * remark-parse parses the inline form as a paragraph child with text
 * "key: value". The block-scalar form is parsed as paragraph + code-or-text.
 * We extract the raw textual content of the list item, then split on the
 * first ":" and decode by leading char.
 */
function parseFieldListItem(li: ListItem): { key: string; value: FieldValue } {
  // The list item's text — collapse all phrasing content from each child node.
  const raw = collectListItemText(li);
  const idx = raw.indexOf(":");
  if (idx < 0) {
    throw new SchemaValidationError(`field list item has no ":" separator: ${raw}`);
  }
  const key = raw.slice(0, idx).trim();
  const valueText = raw.slice(idx + 1).trim();
  if (valueText.startsWith("[")) {
    // JSON array
    try {
      const arr: unknown = JSON.parse(valueText);
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
        throw new Error("not a string[]");
      }
      return { key, value: arr as string[] };
    } catch (e) {
      throw new SchemaValidationError(
        `field "${key}" has invalid array value: ${valueText} (${(e as Error).message})`,
      );
    }
  }
  if (valueText.startsWith("|")) {
    // Block scalar — the actual text lives in subsequent paragraphs of the list item.
    return { key, value: decodeBlockScalar(li) };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(valueText)) {
    return { key, value: Number(valueText) };
  }
  if (valueText.startsWith('"') && valueText.endsWith('"')) {
    try {
      const decoded = JSON.parse(valueText) as unknown;
      if (typeof decoded === "string") return { key, value: decoded };
    } catch {
      // fall through
    }
  }
  return { key, value: valueText };
}

/**
 * Collect text content from a list item's first paragraph (the "key: value"
 * line). Block-scalar values are handled separately.
 */
function collectListItemText(li: ListItem): string {
  for (const child of li.children) {
    if (child.type === "paragraph") {
      return paragraphText(child as Paragraph);
    }
  }
  return "";
}

/**
 * Decode a YAML block scalar from the list item's children. The first
 * paragraph contains "key: |"; subsequent text content is the value.
 *
 * remark-parse renders the indented continuation lines as additional
 * paragraphs or text nodes. We strategy: concatenate all text children of
 * the list item after the first paragraph, separated by newlines, then strip
 * the "key: |" prefix from the first line.
 */
function decodeBlockScalar(li: ListItem): string {
  const lines: string[] = [];
  let firstParaSeen = false;
  for (const child of li.children) {
    if (child.type === "paragraph") {
      const text = paragraphText(child as Paragraph);
      if (!firstParaSeen) {
        firstParaSeen = true;
        // Drop the "key: |" header line — anything after the first newline
        // in this paragraph is real content.
        const nl = text.indexOf("\n");
        if (nl >= 0) {
          lines.push(text.slice(nl + 1));
        }
        continue;
      }
      lines.push(text);
    }
    // Other node types are ignored.
  }
  return lines.join("\n").trim();
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
