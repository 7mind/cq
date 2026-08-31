/**
 * Search query language — a small GitHub-style filter grammar.
 *
 * Grammar (recursive descent over a tokenizer):
 *
 *   query   := orExpr?                       (empty query → { t: "empty" })
 *   orExpr  := andExpr ("OR" andExpr)*
 *   andExpr := unary ("AND"? unary)*         (juxtaposition = AND)
 *   unary   := ("NOT" | "-") unary | primary
 *   primary := "(" orExpr ")" | qualifier | term
 *   qualifier := KEY ":" VALUE               (KEY a bareword; VALUE bareword or "quoted")
 *   term    := bareword | "quoted phrase"
 *
 * Operators `OR` / `AND` / `NOT` are recognized only in UPPERCASE (matching
 * GitHub); lowercase `or`/`and`/`not` are ordinary terms. A leading `-` on a
 * primary negates it (`-status:done`).
 *
 * Qualifier semantics are decided by the evaluator, not the parser: the parser
 * only records `key`/`value`. Whether `key` is a metadata field (status,
 * ledger, milestone, author, session) or an item field name is resolved at
 * evaluation time against a concrete item.
 *
 * This module is PURE (no store/index dependency) so it is unit-testable and
 * usable from any layer. The search index supplies free-text matching and the
 * per-item metadata via the {@link EvalContext}.
 */

/**
 * One-paragraph description of the query language, surfaced in the fts_search
 * tool description and the server `instructions` so agents discover the
 * filters. Kept here next to the grammar so the docs can't drift from it.
 */
export const QUERY_LANGUAGE_HELP =
  "Query syntax: free-text terms (ranked; fuzzy/prefix) plus GitHub-style filters. " +
  "Qualifiers: status:<v>, ledger:<v>, milestone:<v>, author:<v>, session:<v>, or any " +
  "<field>:<v> matching an item field (e.g. severity:major); values are case-insensitive, " +
  'quote values with spaces (status:"in progress"). Booleans: UPPERCASE OR, implicit AND ' +
  "(juxtaposition), NOT or a leading - to negate, and parentheses to group. " +
  "Two paths for status filtering: (a) the dedicated `status` param (a single exact value " +
  "applied as a server-side pre-filter before text ranking) and (b) inline status: qualifiers " +
  "inside the query string — these two can combine freely, e.g. status param='wip' with query " +
  "'ledger:tasks auth' to find wip tasks about auth. " +
  "OR-of-qualifiers: qualifier-only OR queries work and match per-item via the structured " +
  "evaluator (not the MiniSearch fast path) — e.g. '(status:open OR status:wip)' returns " +
  "all open+wip items; the result is empty only when no item carries those statuses. " +
  "Active vs archived: by default fts_search covers only active (non-archived) items; " +
  "pass include_archived:true to also search items swept into milestone-group archives. " +
  "Terminal vs active statuses: each ledger's schema lists terminalStatuses (e.g. done, " +
  "resolved, abandoned) — items in those statuses remain active until archive_terminal_items " +
  "or archive_milestone is called; use -status:done style negation to exclude them from results. " +
  "Examples: status:done | (status:done OR status:wip) | ledger:goals platform | " +
  "author:user -status:abandoned.";

export type QueryNode =
  | { t: "empty" }
  | { t: "and"; nodes: QueryNode[] }
  | { t: "or"; nodes: QueryNode[] }
  | { t: "not"; node: QueryNode }
  | { t: "term"; text: string }
  | { t: "qualifier"; key: string; value: string };

/** Metadata qualifier keys resolved against the item itself, not its fields. */
export const META_QUALIFIER_KEYS = ["status", "ledger", "milestone", "author", "session"] as const;
export type MetaQualifierKey = (typeof META_QUALIFIER_KEYS)[number];

export function isMetaQualifierKey(key: string): key is MetaQualifierKey {
  return (META_QUALIFIER_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "op"; op: "OR" | "AND" | "NOT" }
  | { type: "neg" } // leading '-'
  | { type: "chunk"; text: string }; // bareword / key:value / phrase

/**
 * Split into tokens. A "chunk" runs to the next unquoted whitespace or paren,
 * but a `"…"` span inside a chunk is consumed whole (so `status:"in progress"`
 * stays one chunk). A standalone leading `-` on a chunk becomes a `neg` token.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    // A leading '-' that abuts a non-space, non-paren char negates the next
    // primary (e.g. `-status:done`, `-leak`). A bare '-' (followed by space)
    // is treated as an ordinary chunk.
    if (c === "-" && i + 1 < n && !" \t\n\r()".includes(input[i + 1]!)) {
      tokens.push({ type: "neg" });
      i += 1;
      continue;
    }
    // Read a chunk, honoring quoted spans.
    let buf = "";
    while (i < n) {
      const ch = input[i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") break;
      if (ch === '"') {
        // consume the quoted span (drop the quotes, keep inner text verbatim)
        i += 1;
        while (i < n && input[i] !== '"') {
          buf += input[i];
          i += 1;
        }
        if (i < n) i += 1; // closing quote
        continue;
      }
      buf += ch;
      i += 1;
    }
    if (buf === "OR" || buf === "AND" || buf === "NOT") {
      tokens.push({ type: "op", op: buf });
    } else {
      tokens.push({ type: "chunk", text: buf });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): QueryNode {
    if (this.peek() === undefined) return { t: "empty" };
    const node = this.parseOr();
    return node ?? { t: "empty" };
  }

  private parseOr(): QueryNode | null {
    const first = this.parseAnd();
    if (first === null) return null;
    const nodes = [first];
    while (this.peek()?.type === "op" && (this.peek() as { op: string }).op === "OR") {
      this.next();
      const rhs = this.parseAnd();
      if (rhs !== null) nodes.push(rhs);
    }
    return nodes.length === 1 ? nodes[0]! : { t: "or", nodes };
  }

  private parseAnd(): QueryNode | null {
    const nodes: QueryNode[] = [];
    for (;;) {
      const tk = this.peek();
      if (tk === undefined) break;
      if (tk.type === "rparen") break;
      if (tk.type === "op" && tk.op === "OR") break;
      if (tk.type === "op" && tk.op === "AND") {
        this.next(); // explicit AND is optional glue
        continue;
      }
      const u = this.parseUnary();
      if (u === null) break;
      nodes.push(u);
    }
    if (nodes.length === 0) return null;
    return nodes.length === 1 ? nodes[0]! : { t: "and", nodes };
  }

  private parseUnary(): QueryNode | null {
    const tk = this.peek();
    if (tk === undefined) return null;
    if (tk.type === "neg" || (tk.type === "op" && tk.op === "NOT")) {
      this.next();
      const inner = this.parseUnary();
      if (inner === null) return null;
      return { t: "not", node: inner };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode | null {
    const tk = this.next();
    if (tk === undefined) return null;
    if (tk.type === "lparen") {
      const inner = this.parseOr();
      if (this.peek()?.type === "rparen") this.next(); // consume ')'
      return inner;
    }
    if (tk.type === "rparen") return null;
    if (tk.type === "op") {
      // A dangling operator keyword with no operand → treat as a literal term.
      return { t: "term", text: tk.op };
    }
    if (tk.type === "neg") {
      // shouldn't happen (handled in parseUnary); treat as term '-'
      return { t: "term", text: "-" };
    }
    // chunk: qualifier `key:value` (key is a non-empty bareword that is not the
    // whole chunk) or a free-text term.
    const colon = tk.text.indexOf(":");
    if (colon > 0 && colon < tk.text.length - 1) {
      const key = tk.text.slice(0, colon);
      const value = tk.text.slice(colon + 1);
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
        return { t: "qualifier", key, value };
      }
    }
    if (tk.text.length === 0) return null;
    return { t: "term", text: tk.text };
  }
}

export function parseQuery(input: string): QueryNode {
  return new Parser(tokenize(input)).parse();
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

/** Distinct free-text term strings appearing anywhere in the tree. */
export function collectTerms(node: QueryNode): string[] {
  const out = new Set<string>();
  const walk = (n: QueryNode): void => {
    switch (n.t) {
      case "term":
        out.add(n.text);
        break;
      case "qualifier":
      case "empty":
        break;
      case "not":
        walk(n.node);
        break;
      case "and":
      case "or":
        n.nodes.forEach(walk);
        break;
    }
  };
  walk(node);
  return Array.from(out);
}

/**
 * True when the query is only free text — bare terms combined by implicit AND,
 * with no qualifiers, OR, NOT, or parentheses. Such queries are handed to the
 * underlying ranked full-text engine unchanged (preserving its OR/fuzzy/prefix
 * semantics); anything richer is evaluated by {@link evaluate}.
 */
export function isPlainTextQuery(node: QueryNode): boolean {
  if (node.t === "term") return true;
  if (node.t === "and") return node.nodes.every((n) => n.t === "term");
  return false;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface EvalContext {
  /** Does this item match the given free-text term? (index-backed.) */
  matchesTerm: (text: string) => boolean;
  /** Resolve a qualifier `key:value` against this item. */
  matchesQualifier: (key: string, value: string) => boolean;
}

/** Evaluate the query as a boolean predicate over one item via `ctx`. */
export function evaluate(node: QueryNode, ctx: EvalContext): boolean {
  switch (node.t) {
    case "empty":
      return false;
    case "term":
      return ctx.matchesTerm(node.text);
    case "qualifier":
      return ctx.matchesQualifier(node.key, node.value);
    case "not":
      return !evaluate(node.node, ctx);
    case "and":
      return node.nodes.every((n) => evaluate(n, ctx));
    case "or":
      return node.nodes.some((n) => evaluate(n, ctx));
  }
}
