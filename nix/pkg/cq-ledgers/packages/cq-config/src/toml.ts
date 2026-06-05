/**
 * Minimal TOML parser scoped to the cq.toml schema (T170).
 *
 * Supports exactly what cq.toml needs and rejects everything else at the
 * boundary (fail fast):
 *  - line comments (`# ...`) and blank lines;
 *  - a single `[aliases]` table header;
 *  - `key = "value"` string assignments (basic double-quoted strings);
 *  - `reviewers = ["a", "b", ...]` single-line arrays of strings.
 *
 * This intentionally does NOT implement full TOML (no nested tables, no
 * numbers/bools/dates, no multi-line strings). cq.toml is a small,
 * fixed-shape document; a focused parser keeps the package dependency-free.
 */

/** The shape a cq.toml document parses into before schema validation. */
export interface RawToml {
  /** The `[aliases]` table: alias name -> raw token string. */
  readonly aliases: Record<string, string>;
  /** The top-level `reviewers` array of strings, or null if absent. */
  readonly reviewers: readonly string[] | null;
  /** The top-level `planners` array of strings, or null if absent. */
  readonly planners: readonly string[] | null;
}

class TomlSyntaxError extends Error {
  constructor(message: string, line: number) {
    super(`cq.toml: ${message} (line ${line})`);
    this.name = "TomlSyntaxError";
  }
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Strip an unescaped trailing comment (`# ...`) outside of a string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Only a `\"` escape inside a string is a literal quote.
      if (inString && line[i - 1] === "\\") continue;
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Parse a single double-quoted TOML basic string (with \" and \\ escapes). */
function parseString(token: string, line: number): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') {
    throw new TomlSyntaxError(`expected a double-quoted string, got ${token}`, line);
  }
  const body = token.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else throw new TomlSyntaxError(`unsupported escape \\${next ?? ""}`, line);
      i++;
    } else if (ch === '"') {
      throw new TomlSyntaxError("unescaped quote inside string", line);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parse a single-line `["a", "b"]` array of strings. */
function parseStringArray(token: string, line: number): string[] {
  if (token[0] !== "[" || token[token.length - 1] !== "]") {
    throw new TomlSyntaxError(`expected an array, got ${token}`, line);
  }
  const inner = token.slice(1, -1).trim();
  if (inner === "") return [];
  // Split on commas that are not inside a string.
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") inString = !inString;
    if (ch === "," && !inString) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts.map((p) => parseString(p, line));
}

/**
 * Parse a cq.toml document into its raw shape, or throw a precise
 * `TomlSyntaxError` on malformed input.
 */
export function parseToml(source: string): RawToml {
  const aliases: Record<string, string> = {};
  let reviewers: string[] | null = null;
  let planners: string[] | null = null;
  // null = top-level; "aliases" = inside [aliases]; other = unknown table.
  let currentTable: string | null = null;

  const lines = source.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = stripComment(lines[idx] ?? "").trim();
    if (raw === "") continue;

    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) {
        throw new TomlSyntaxError(`malformed table header ${raw}`, lineNo);
      }
      const name = raw.slice(1, -1).trim();
      if (!KEY_RE.test(name)) {
        throw new TomlSyntaxError(`invalid table name ${name}`, lineNo);
      }
      currentTable = name;
      continue;
    }

    const eq = raw.indexOf("=");
    if (eq < 0) {
      throw new TomlSyntaxError(`expected key = value, got ${raw}`, lineNo);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) {
      throw new TomlSyntaxError(`invalid key ${key}`, lineNo);
    }

    if (currentTable === "aliases") {
      aliases[key] = parseString(value, lineNo);
    } else if (currentTable === null) {
      if (key === "reviewers") {
        reviewers = parseStringArray(value, lineNo);
      } else if (key === "planners") {
        planners = parseStringArray(value, lineNo);
      } else {
        throw new TomlSyntaxError(`unexpected top-level key ${key}`, lineNo);
      }
    } else {
      throw new TomlSyntaxError(`unexpected table [${currentTable}]`, lineNo);
    }
  }

  return { aliases, reviewers, planners };
}
