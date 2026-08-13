import { CANONICAL_LEDGERS } from "@cq/ledger/constants";
import { buildPrefixRegistry, canonicalizeRef } from "@cq/ledger/refs";

export interface ItemReference {
  ledger: string;
  id: string;
}

export type ItemReferenceSpan =
  | { kind: "text"; text: string }
  | { kind: "reference"; text: string; reference: ItemReference };

const PREFIX_REGISTRY = buildPrefixRegistry(CANONICAL_LEDGERS);
const CANDIDATE_RE = /[a-z][a-z0-9_-]*:[A-Za-z][A-Za-z0-9_-]*|[A-Z]+\d+/g;
const TOKEN_CHAR_RE = /[A-Za-z0-9_/-]/;

function isTokenBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 ? undefined : text[start - 1];
  const after = end === text.length ? undefined : text[end];
  return (before === undefined || !TOKEN_CHAR_RE.test(before))
    && (after === undefined || !TOKEN_CHAR_RE.test(after));
}

export function parseItemReference(raw: string): ItemReference | null {
  try {
    const canonical = canonicalizeRef(raw, PREFIX_REGISTRY);
    const separator = canonical.indexOf(":");
    return {
      ledger: canonical.slice(0, separator),
      id: canonical.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function scanItemReferences(text: string): ItemReferenceSpan[] {
  const spans: ItemReferenceSpan[] = [];
  let plainStart = 0;
  CANDIDATE_RE.lastIndex = 0;
  for (let match = CANDIDATE_RE.exec(text); match !== null; match = CANDIDATE_RE.exec(text)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (!isTokenBoundary(text, start, end)) continue;
    const reference = parseItemReference(raw);
    if (reference === null) continue;
    if (plainStart < start) spans.push({ kind: "text", text: text.slice(plainStart, start) });
    spans.push({ kind: "reference", text: raw, reference });
    plainStart = end;
  }
  if (plainStart < text.length || spans.length === 0) {
    spans.push({ kind: "text", text: text.slice(plainStart) });
  }
  return spans;
}
