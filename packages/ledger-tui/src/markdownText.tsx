/**
 * Minimal markdown → Ink renderer for the terminal.
 *
 * Terminal markdown is necessarily approximate: this covers the common
 * constructs — ATX headings, bullet/ordered lists, blockquotes, fenced code
 * blocks, and inline **bold** / *italic* / `code` / [links](url) — mapping
 * them to styled Ink <Text>. It is intentionally dependency-free (no remark in
 * the TUI closure) and lenient; unknown syntax falls through as plain text.
 *
 * Two render surfaces:
 *   - {@link Markdown}: a block element tree; ink wraps long text internally.
 *     Used where the container height is unbounded (e.g. the answer box).
 *   - {@link markdownLines}: a FLAT array of one-row nodes, wrapped to an
 *     explicit width. Used by the detail pane so it can render only the visible
 *     line slice (windowing) — rendering the full text every cursor move is the
 *     dominant TUI nav cost (D13), since ink measures the whole text volume.
 */

import React from "react";
import { Box, Text } from "ink";

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(\[[^\]]+\]\([^)]+\))/;

// Global clone: advances `lastIndex` so a string is scanned ONCE, rather than
// the non-global RE re-`exec`'d against a progressively re-sliced remainder
// (O(n²) on a long paragraph with many tokens).
const INLINE_RE_G = new RegExp(INLINE_RE.source, "g");

type SegKind = "plain" | "code" | "bold" | "italic" | "link";
/** An inline run with a single style. */
interface Seg {
  text: string;
  kind: SegKind;
}

/** Classify a matched inline token into a styled segment (markers stripped). */
function classifyToken(tok: string): Seg {
  if (tok.startsWith("`")) return { text: tok.slice(1, -1), kind: "code" };
  if (tok.startsWith("**")) return { text: tok.slice(2, -2), kind: "bold" };
  if (tok.startsWith("*") || tok.startsWith("_")) return { text: tok.slice(1, -1), kind: "italic" };
  const lbl = /\[([^\]]+)\]/.exec(tok)?.[1] ?? tok;
  return { text: lbl, kind: "link" };
}

/**
 * Split a line into inline-styled segments in a single pass. Plain runs become
 * `kind: "plain"` segments; markers are stripped from the styled ones.
 */
function inlineSegments(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  INLINE_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE_G.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: "plain" });
    out.push(classifyToken(m[0]));
    last = m.index + m[0].length;
    if (INLINE_RE_G.lastIndex <= m.index) INLINE_RE_G.lastIndex = m.index + 1;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "plain" });
  return out;
}

/** Render one segment as a styled node (plain runs stay raw strings so ink
 * concatenates them reliably with adjacent styled spans). */
function styleSeg(s: Seg, key: string): React.ReactNode {
  switch (s.kind) {
    case "plain":
      return s.text;
    case "code":
      return (
        <Text key={key} color="cyan">
          {s.text}
        </Text>
      );
    case "bold":
      return (
        <Text key={key} bold>
          {s.text}
        </Text>
      );
    case "italic":
      return (
        <Text key={key} italic>
          {s.text}
        </Text>
      );
    case "link":
      return (
        <Text key={key} underline color="blue">
          {s.text}
        </Text>
      );
  }
}

/**
 * Render inline markdown spans within a line. Plain runs are emitted as raw
 * strings (not wrapped <Text>) so Ink concatenates them with adjacent styled
 * spans reliably — wrapping every run in its own <Text> caused a trailing span
 * to be dropped inside nested flex layout.
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  return inlineSegments(text).map((s, i) => styleSeg(s, `${keyBase}-${i}`));
}

/**
 * Word-wrap styled segments to `width`, preserving each run's style across the
 * wrap (so `**two words**` styled bold stays bold even if it breaks across two
 * rows). Returns one `Seg[]` per display row. Whitespace runs collapse to a
 * single space; a word longer than `width` is hard-split.
 */
function wrapSegments(segs: Seg[], width: number): Seg[][] {
  if (width <= 0) return [segs.length > 0 ? segs : [{ text: "", kind: "plain" }]];
  const rows: Seg[][] = [];
  let row: Seg[] = [];
  let w = 0;
  const flush = (): void => {
    rows.push(row.length > 0 ? row : [{ text: "", kind: "plain" }]);
    row = [];
    w = 0;
  };
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) {
        if (w === 0 || w + 1 > width) continue; // drop leading/overflowing space
        row.push({ text: " ", kind: "plain" });
        w += 1;
        continue;
      }
      let word = part;
      while (word.length > width) {
        if (w > 0) flush();
        rows.push([{ text: word.slice(0, width), kind: seg.kind }]);
        word = word.slice(width);
      }
      if (w > 0 && w + word.length > width) flush();
      row.push({ text: word, kind: seg.kind });
      w += word.length;
    }
  }
  if (row.length > 0 || rows.length === 0) flush();
  return rows;
}

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "ul"; text: string }
  | { t: "ol"; n: string; text: string }
  | { t: "quote"; text: string }
  | { t: "code"; lines: string[] }
  | { t: "blank" };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ t: "para", text: para.join(" ") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^```/.test(line);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ t: "code", lines: code });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ t: "heading", level: h[1]!.length, text: h[2]! });
      i += 1;
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      blocks.push({ t: "ul", text: ul[1]! });
      i += 1;
      continue;
    }
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      blocks.push({ t: "ol", n: ol[1]!, text: ol[2]! });
      i += 1;
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      blocks.push({ t: "quote", text: q[1]! });
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      blocks.push({ t: "blank" });
      i += 1;
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return blocks;
}

/**
 * Render markdown as a FLAT array of one-row nodes, wrapped to `width`. The
 * caller can slice the result to a visible window (the detail pane does this
 * for scrolling) so only on-screen rows are handed to ink. Inline styling is
 * preserved across wraps via {@link wrapSegments}. Fenced code renders as plain
 * cyan rows (no surrounding border — borders are not single-row units).
 */
export function markdownLines(text: string, width: number, keyBase = "md"): React.ReactElement[] {
  const blocks = parseBlocks(text);
  const out: React.ReactElement[] = [];
  let li = 0;
  const pushRow = (node: React.ReactNode, props: { bold?: boolean; color?: string; dimColor?: boolean } = {}): void => {
    // One terminal row per line (already wrapped to `width`); truncate guards
    // against any residual overflow so the caller's row-count stays exact.
    out.push(
      <Text key={`${keyBase}-${li++}`} wrap="truncate" {...props}>
        {node}
      </Text>,
    );
  };
  for (const b of blocks) {
    switch (b.t) {
      case "blank":
        pushRow(" ");
        break;
      case "heading": {
        const color = b.level <= 2 ? "green" : "white";
        for (const r of wrapSegments(inlineSegments(b.text), width))
          pushRow(r.map((s, i) => styleSeg(s, `${keyBase}-${li}-${i}`)), { bold: true, color });
        break;
      }
      case "para":
        for (const r of wrapSegments(inlineSegments(b.text), width))
          pushRow(r.map((s, i) => styleSeg(s, `${keyBase}-${li}-${i}`)));
        break;
      case "ul":
      case "ol": {
        const prefix = b.t === "ul" ? "  • " : `  ${b.n}. `;
        const indent = " ".repeat(prefix.length);
        const rows = wrapSegments(inlineSegments(b.text), Math.max(1, width - prefix.length));
        rows.forEach((r, ri) =>
          pushRow(
            <>
              {ri === 0 ? prefix : indent}
              {r.map((s, i) => styleSeg(s, `${keyBase}-${li}-${i}`))}
            </>,
          ),
        );
        break;
      }
      case "quote":
        for (const r of wrapSegments(inlineSegments(b.text), Math.max(1, width - 2)))
          pushRow(
            <>
              {"│ "}
              {r.map((s, i) => styleSeg(s, `${keyBase}-${li}-${i}`))}
            </>,
            { dimColor: true },
          );
        break;
      case "code":
        for (const cl of b.lines) pushRow(cl.length > 0 ? cl : " ", { color: "cyan" });
        break;
    }
  }
  return out;
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case "heading":
            return (
              <Text key={key} bold color={b.level <= 2 ? "green" : "white"}>
                {renderInline(b.text, key)}
              </Text>
            );
          case "para":
            return <Text key={key}>{renderInline(b.text, key)}</Text>;
          case "ul":
            return (
              <Text key={key}>
                {"  • "}
                {renderInline(b.text, key)}
              </Text>
            );
          case "ol":
            return (
              <Text key={key}>
                {`  ${b.n}. `}
                {renderInline(b.text, key)}
              </Text>
            );
          case "quote":
            return (
              <Text key={key} dimColor>
                {"│ "}
                {renderInline(b.text, key)}
              </Text>
            );
          case "code":
            return (
              <Box key={key} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
                {b.lines.map((cl, j) => (
                  <Text key={`${key}-${j}`} color="cyan">
                    {cl.length > 0 ? cl : " "}
                  </Text>
                ))}
              </Box>
            );
          case "blank":
            return <Text key={key}> </Text>;
        }
      })}
    </Box>
  );
}
