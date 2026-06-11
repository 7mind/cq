/**
 * jsonlLog — strict JSONL validation for raw-log capture.
 *
 * Enforces: one JSON value per line, every non-empty line parseable as JSON,
 * no record spanning multiple lines.  Trailing blank lines are tolerated.
 *
 * Per the verbatim principle, `cq log put` (a later task) rejects a
 * non-conforming .jsonl input with this error rather than silently
 * reformatting.  This function is a pure validator — it performs NO mutation.
 */

export type JsonlValidationOk = { ok: true };
export type JsonlValidationError = { ok: false; line: number; reason: string };
export type JsonlValidationResult = JsonlValidationOk | JsonlValidationError;

/**
 * Validate `raw` as strict JSONL:
 *   - Every non-empty line must be parseable as a single JSON value.
 *   - A JSON value must not span multiple lines (each line is self-contained).
 *   - A trailing newline and/or trailing blank lines are tolerated.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, line, reason }` on the
 * first violation (1-based line number).
 */
export function validateJsonl(raw: string): JsonlValidationResult {
  const lines = raw.split("\n");

  // A trailing newline produces an empty string at the end; tolerate it.
  // Also tolerate additional trailing blank lines.
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty]!.trim() === "") {
    lastNonEmpty--;
  }

  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = lines[i]!;

    if (line.trim() === "") {
      // A blank line in the middle of content is not valid JSONL.
      return {
        ok: false,
        line: i + 1,
        reason: "blank line in the middle of JSONL content",
      };
    }

    try {
      JSON.parse(line);
    } catch {
      return {
        ok: false,
        line: i + 1,
        reason: "line is not valid JSON",
      };
    }
  }

  return { ok: true };
}
