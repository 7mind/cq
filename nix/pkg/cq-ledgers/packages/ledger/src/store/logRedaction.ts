/**
 * Deterministic secret-redaction for log text.
 *
 * `redactSecrets(text)` applies best-effort pattern matching to replace common
 * credential strings with `[REDACTED:<kind>]` placeholders, where `<kind>`
 * names the matched pattern (see `REDACTION_KINDS`).
 *
 * Caveats:
 *  - **Lossy**: genuine secrets that do not match any pattern are NOT redacted.
 *    Pattern-coverage is best-effort, not exhaustive.
 *  - **Per-line scope**: each regex matches within a single line only (no `.`
 *    crossing newlines). A false positive corrupts only the line it appears on,
 *    and multi-line credentials that would normally span lines are NOT matched.
 *  - **Idempotent**: `redactSecrets(redactSecrets(x)) === redactSecrets(x)`.
 *    Placeholder strings do not match any pattern, so repeated application is
 *    safe.
 */

/**
 * All recognised credential kinds, as a const tuple so tests (and callers) can
 * iterate the full taxonomy without duplicating the list.
 *
 * Order is significant: patterns are applied left-to-right, and a match for an
 * earlier kind shadows any later patterns that would match the same substring.
 */
export const REDACTION_KINDS = [
  "aws-key",
  "github-token",
  "api-key",
  "bearer",
  "slack-token",
  "plan-owner-fence-token",
] as const;

/** Union of all recognised credential kinds. */
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * Per-kind replacement pattern.
 *
 * Each entry holds the `RegExp` to match and the replacement string. The regex
 * MUST use the `g` flag so all occurrences per line are replaced. Per-line
 * scope is enforced by the absence of the `s` (dotAll) flag: `.` and character
 * classes do not cross newline boundaries. The `m` flag is present but not
 * load-bearing here — none of the patterns use `^`/`$` anchors.
 *
 * `replacement` defaults to the bare `[REDACTED:<kind>]` placeholder. An entry
 * that must keep surrounding syntax (a key name, its separator) supplies its
 * own replacement string with `$n` back-references into the pattern.
 */
const PATTERNS: ReadonlyArray<{
  kind: RedactionKind;
  re: RegExp;
  replacement?: string;
}> = [
  // AWS access key IDs: AKIA followed by exactly 16 uppercase letters/digits.
  {
    kind: "aws-key",
    re: /AKIA[0-9A-Z]{16}/gm,
  },
  // GitHub tokens: gh followed by one of p/o/u/s/r, underscore, then 36+
  // alphanumeric characters.
  {
    kind: "github-token",
    re: /gh[pousr]_[A-Za-z0-9]{36,}/gm,
  },
  // OpenAI / Anthropic-style API keys: sk- or sk-ant- prefix, then a non-empty
  // run of alphanumeric characters and hyphens/underscores up to a word
  // boundary (a realistic secret is at least 20 chars; match greedily to catch
  // the full value).
  {
    kind: "api-key",
    re: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/gm,
  },
  // HTTP Authorization header bearer tokens: "Bearer " followed by a non-empty
  // run of non-whitespace characters.
  {
    kind: "bearer",
    re: /Bearer\s+\S+/gm,
  },
  // Slack bot/user tokens: xoxb- or xoxp- followed by digits and hyphens.
  {
    kind: "slack-token",
    re: /xox[bp]-[0-9A-Za-z-]+/gm,
  },
  // Plan-lifecycle owner fence tokens (T852 / G99). The value is an opaque
  // caller-generated base64url secret with no distinguishing prefix, so the
  // KEY is the anchor: the JSON (`"ownerFenceToken":"…"`), YAML
  // (`ownerFenceToken: …` / `ownerFenceToken: '…'`), and shell
  // (`ownerFenceToken=…`) spellings a transcript can carry.
  //
  // The dominant on-disk shape is NOT bare JSON but JSON-in-JSON: a raw JSONL
  // transcript stores an MCP tool result as a STRINGIFIED payload inside the
  // message, so the bytes `redactSecrets` actually sees are escaped —
  // `\"ownerFenceToken\":\"<token>\"` — and a nested capture escapes again
  // (`\\\"…\\\"`). The `(?:\\+)?` groups therefore straddle any run of
  // backslashes on both sides of the separator; without them the pattern
  // cannot cross the backslash before the quote and every persisted claim
  // leaks its token verbatim.
  //
  // Only the value is replaced, so the surrounding structure — including the
  // (possibly escaped) closing quote, which the pattern never consumes —
  // survives and the line stays parseable JSON. `ownerFenceTokenVerifier` is
  // NOT matched: after the key the separator is mandatory, and `V` is neither
  // a backslash, a quote, nor `:`/`=`. Idempotent: the placeholder starts with
  // `[`, outside the base64url value class, so a second pass cannot match it.
  {
    kind: "plan-owner-fence-token",
    re: /(ownerFenceToken(?:\\+)?"?\s*[:=]\s*(?:\\+)?["']?)[A-Za-z0-9_-]{22,}/gm,
    replacement: "$1[REDACTED:plan-owner-fence-token]",
  },
];

/**
 * Replace occurrences of known credential patterns in `text` with
 * `[REDACTED:<kind>]` placeholders.
 *
 * The function is pure (no I/O), deterministic, and idempotent.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { kind, re, replacement } of PATTERNS) {
    // Reset lastIndex in case the regex object was previously used.
    re.lastIndex = 0;
    result = result.replace(re, replacement ?? `[REDACTED:${kind}]`);
  }
  return result;
}
