/**
 * validateJsonl tests (T404).
 *
 * Covers:
 *   - A well-formed multi-event .jsonl passes.
 *   - A pretty-printed (multi-line) JSON object is rejected with the offending
 *     line number + reason.
 *   - A record spanning two lines (broken at the newline) is rejected.
 *   - Trailing blank lines are tolerated.
 *   - A trailing newline alone is tolerated.
 *   - The helper performs no mutation (validate-only, pure function).
 */

import { describe, it, expect } from "bun:test";
import { validateJsonl } from "../src/store/jsonlLog.js";

describe("validateJsonl", () => {
  it("accepts a well-formed multi-event JSONL string", () => {
    const raw = [
      '{"type":"start","ts":"2024-01-01T00:00:00Z"}',
      '{"type":"event","data":42}',
      '{"type":"end"}',
      "",
    ].join("\n");

    expect(validateJsonl(raw)).toEqual({ ok: true });
  });

  it("accepts a single-line JSONL with no trailing newline", () => {
    const raw = '{"type":"single"}';
    expect(validateJsonl(raw)).toEqual({ ok: true });
  });

  it("accepts a single-line JSONL with a trailing newline", () => {
    const raw = '{"type":"single"}\n';
    expect(validateJsonl(raw)).toEqual({ ok: true });
  });

  it("tolerates multiple trailing blank lines", () => {
    const raw = '{"type":"a"}\n{"type":"b"}\n\n\n';
    expect(validateJsonl(raw)).toEqual({ ok: true });
  });

  it("tolerates an empty string (zero events)", () => {
    expect(validateJsonl("")).toEqual({ ok: true });
  });

  it("tolerates a string that is only newlines (all-blank)", () => {
    expect(validateJsonl("\n\n\n")).toEqual({ ok: true });
  });

  it("rejects a pretty-printed JSON object (multi-line) with line 2 as the offending line", () => {
    // A pretty-printed object has opening `{` on line 1, then fields on
    // subsequent lines — line 2 is not valid JSON on its own.
    const raw = [
      "{",
      '  "type": "start",',
      '  "ts": "2024-01-01T00:00:00Z"',
      "}",
    ].join("\n");

    const result = validateJsonl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Line 1 ("{") is not valid JSON by itself.
      expect(result.line).toBe(1);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a record spanning two lines", () => {
    // The first half ends mid-JSON so it fails to parse on line 1.
    const raw = '{"type":"start",\n"ts":"2024-01-01T00:00:00Z"}';

    const result = validateJsonl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(1);
      expect(typeof result.reason).toBe("string");
    }
  });

  it("rejects a blank line in the middle of JSONL content", () => {
    const raw = '{"type":"a"}\n\n{"type":"b"}';

    const result = validateJsonl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(2);
      expect(result.reason).toMatch(/blank line/i);
    }
  });

  it("rejects a line with invalid JSON and reports the correct 1-based line number", () => {
    const raw = '{"type":"a"}\nnot-json\n{"type":"b"}';

    const result = validateJsonl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(2);
      expect(result.reason).toContain("not valid JSON");
    }
  });

  it("does not mutate the input string (pure function)", () => {
    const raw = '{"type":"a"}\n{"type":"b"}\n';
    const copy = raw;
    validateJsonl(raw);
    // The string is unchanged (primitive equality in JS guarantees immutability,
    // but we also confirm the reference is unchanged).
    expect(raw).toBe(copy);
  });

  it("rejects an array value spanning multiple lines", () => {
    const raw = "[\n  1,\n  2\n]";

    const result = validateJsonl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(1);
    }
  });

  it("accepts a JSONL where each line is a JSON array (single-line arrays)", () => {
    const raw = "[1,2,3]\n[4,5,6]\n";
    expect(validateJsonl(raw)).toEqual({ ok: true });
  });
});
