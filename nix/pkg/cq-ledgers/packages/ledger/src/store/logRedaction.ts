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
 */
const PATTERNS: ReadonlyArray<{ kind: RedactionKind; re: RegExp }> = [
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
];

/**
 * Replace occurrences of known credential patterns in `text` with
 * `[REDACTED:<kind>]` placeholders.
 *
 * The function is pure (no I/O), deterministic, and idempotent.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { kind, re } of PATTERNS) {
    // Reset lastIndex in case the regex object was previously used.
    re.lastIndex = 0;
    result = result.replace(re, `[REDACTED:${kind}]`);
  }
  return result;
}
